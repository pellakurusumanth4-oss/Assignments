"""Deterministic policy guardrail — the "hold the line" enforcement layer.

Key principle (from the research digest): *prompts are suggestions, not constraints.* The LLM can be
talked into approving an out-of-policy refund. So the authoritative decision is computed here, in plain
testable Python, and enforced **before** `issue_refund` actually writes a refund record. The LLM cannot
override it.

`evaluate()` returns the authoritative verdict for an order, mirroring the precedence in
`policy/refund_policy.md` §6 exactly.
"""

from __future__ import annotations

from typing import Any, Optional

from .store import (
    ABUSE_REFUND_LIMIT,
    DEFECTIVE_WINDOW_DAYS,
    HIGH_VALUE_THRESHOLD,
    RESTOCKING_FEE_RATE,
    RETURN_WINDOW_DAYS,
    store,
)


def evaluate(order_id: str) -> dict[str, Any]:
    """Return the authoritative policy verdict for an order.

    Result keys:
      decision: APPROVE | APPROVE_PARTIAL | DENY | ESCALATE
      allowed:  True only for APPROVE / APPROVE_PARTIAL (i.e. a refund may be issued now)
      reason:   human-readable explanation
      rule:     the policy rule number that determined the outcome
      refund_amount: the amount to refund when allowed (else None)

    Round-trips (reduced from ~5 to 3 per call):
      1. store.raw_order   — fetches order columns (includes already_refunded flag and
                             delivered_days_ago); replaces the separate get_order call.
      2. store.refund_for_order — checks whether a live Refund row exists for this order
                             (needed because already_refunded on the Order row is a static
                             seed flag and is not updated when record_refund writes a new row).
      3. store.refunds_last_90_days — customer abuse check (only reached when the order passes
                             the earlier denial rules).

    Previously the code called raw_order (1) + get_order (1 order + 1 refund sub-query = 2) +
    refunds_last_90_days (1 customer + 1 refund = 2), totalling ~5 queries. Now it uses
    raw_order (1) + refund_for_order (1) + refunds_last_90_days (2) = 4 queries in the worst
    case (abuse / high-value path) and 2–3 queries for early-exit paths. Verdict logic is
    identical to the original.
    """
    raw = store.raw_order(order_id)
    if raw is None:
        return _verdict("DENY", False, "No order found with that ID.", "1.3")

    amount: float = raw["amount"]
    flags: dict[str, bool] = raw["flags"]
    condition: str = raw["condition"]
    category: str = raw["category"]
    delivered_days_ago: Optional[int] = raw["delivered_days_ago"]

    # Derive `already_refunded` from the raw order flag OR a live Refund row.
    # raw["already_refunded"] covers orders seeded as already-refunded in fixtures; the
    # live Refund lookup covers orders refunded at runtime (record_refund does not update
    # the Order row, so we must check the Refund table directly).
    already_refunded: bool = raw["already_refunded"] or (
        store.refund_for_order(order_id) is not None
    )

    # 1. Already refunded
    if already_refunded:
        return _verdict("DENY", False, "This order has already been refunded.", "1.2")

    # 2. Not delivered yet
    if delivered_days_ago is None or raw["status"] != "delivered":
        return _verdict(
            "DENY", False,
            "The order has not been delivered yet, so it is not eligible for a refund.", "1.1",
        )

    # 3. Non-refundable item categories
    if flags.get("gift_card"):
        return _verdict("DENY", False, "Gift cards are non-refundable.", "3.1")
    if flags.get("digital_redeemed"):
        return _verdict("DENY", False, "Redeemed digital goods are non-refundable.", "3.2")
    if flags.get("perishable"):
        return _verdict("DENY", False, "Perishable goods are non-refundable.", "3.3")
    if flags.get("final_sale"):
        return _verdict("DENY", False, "Final-sale items are non-refundable.", "3.4")

    # 4. Used / customer-damaged
    if condition == "used":
        return _verdict(
            "DENY", False,
            "The item shows use or customer damage that was not present on arrival.", "4.4",
        )

    defective = condition == "damaged_on_arrival"

    # 5. Return window (defective items get the extended 90-day window)
    if delivered_days_ago > RETURN_WINDOW_DAYS:
        if defective and delivered_days_ago <= DEFECTIVE_WINDOW_DAYS:
            pass  # eligible under the defective-item exception (rule 4.2)
        else:
            return _verdict(
                "DENY", False,
                f"The request is outside the {RETURN_WINDOW_DAYS}-day return window "
                f"({delivered_days_ago} days since delivery).", "2.2",
            )

    # The amount actually owed: opened electronics get the 15% restocking fee (rule 4.3). Rule 5.1 is
    # about the *refund* amount, not the raw order total, so compute it before the escalation checks —
    # e.g. a $550 opened-electronics order refunds $467.50, which is under the $500 threshold and must
    # NOT escalate. Carrying refund_amount on the ESCALATE verdict also lets a human approval issue the
    # correct (possibly reduced) amount rather than the full order total.
    opened_electronics = condition == "opened" and category == "electronics"
    refund_amount = round(amount * (1 - RESTOCKING_FEE_RATE), 2) if opened_electronics else amount

    # 6. Escalation triggers
    refunds_90 = store.refunds_last_90_days(raw["customer_id"])
    if refunds_90 > ABUSE_REFUND_LIMIT:
        return _verdict(
            "ESCALATE", False,
            f"Customer has {refunds_90} refunds in the last 90 days (limit {ABUSE_REFUND_LIMIT}); "
            "needs human review.", "5.2", refund_amount,
        )
    if refund_amount > HIGH_VALUE_THRESHOLD:
        return _verdict(
            "ESCALATE", False,
            f"Refund amount ${refund_amount:.2f} exceeds the ${HIGH_VALUE_THRESHOLD:.0f} threshold; "
            "needs human approval.", "5.1", refund_amount,
        )

    # 7. Approve — opened electronics incur a restocking fee
    if opened_electronics:
        return _verdict(
            "APPROVE_PARTIAL", True,
            f"Opened electronics: approved with a {int(RESTOCKING_FEE_RATE * 100)}% restocking fee "
            f"(${refund_amount:.2f} of ${amount:.2f}).", "4.3", refund_amount,
        )

    label = "Defective item within the extended window." if defective else "Eligible within the return window."
    return _verdict("APPROVE", True, f"{label} Full refund approved.", "4.1", amount)


def _verdict(
    decision: str, allowed: bool, reason: str, rule: str, refund_amount: Optional[float] = None
) -> dict[str, Any]:
    return {
        "decision": decision,
        "allowed": allowed,
        "reason": reason,
        "rule": rule,
        "refund_amount": refund_amount,
    }
