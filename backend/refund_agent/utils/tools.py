"""The agent's tools — idiomatic LangChain `@tool` functions.

Each tool is a small, single-purpose capability (the τ-bench / Anthropic ACI pattern). The agent
calls them to gather facts and to act. `issue_refund` is the one tool with side effects; the
deterministic policy guard runs in `PolicyGuardrailMiddleware` (see middleware.py) *before* this
tool executes, so the agent cannot push an out-of-policy refund through — that's "holding the line".
"""

from __future__ import annotations

from langchain_core.tools import tool
from langgraph.config import get_stream_writer

from . import guardrail
from .store import ABUSE_REFUND_LIMIT, RETURN_WINDOW_DAYS, store


@tool
def lookup_customer(query: str) -> dict:
    """Look up a customer by their customer id, email address, or full name.

    Returns the profile including tier and how many refunds they've had in the last 90 days.
    """
    c = store.get_customer(query)
    return c or {"error": "No customer found matching that id, email, or name."}


@tool
def list_orders_for_customer(customer_id: str) -> dict:
    """List all orders belonging to a customer id. Use when the customer doesn't know their order id."""
    orders = store.get_orders_for_customer(customer_id)
    return {
        "orders": [
            {"order_id": o["order_id"], "product_name": o["product_name"],
             "amount": o["amount"], "status": o["status"]}
            for o in orders
        ]
    }


@tool
def get_order(order_id: str) -> dict:
    """Get the full details of a single order: product, category, amount, status, condition, flags,
    order date, delivery date."""
    o = store.get_order(order_id)
    return o or {"error": "No order found with that id."}


@tool
def check_return_window(order_id: str) -> dict:
    """Check whether an order is within the return window. Returns days since delivery, the window
    length, and whether the item is defective (which extends the window)."""
    o = store.get_order(order_id)
    if not o:
        return {"error": "No order found with that id."}
    days = o["days_since_delivered"]
    return {
        "days_since_delivered": days,
        "window_days": RETURN_WINDOW_DAYS,
        "within_window": days is not None and days <= RETURN_WINDOW_DAYS,
        "defective": o["condition"] == "damaged_on_arrival",
        "delivered": days is not None,
    }


@tool
def check_category_eligibility(order_id: str) -> dict:
    """Check whether an order's category/flags make it refundable at all (gift cards, redeemed
    digital goods, perishables, and final-sale items are never refundable)."""
    o = store.get_order(order_id)
    if not o:
        return {"error": "No order found with that id."}
    flags = o["flags"]
    non_refundable = [k for k in ("gift_card", "digital_redeemed", "perishable", "final_sale")
                      if flags.get(k)]
    return {
        "category": o["category"],
        "flags": flags,
        "refundable_category": not non_refundable,
        "non_refundable_reasons": non_refundable,
    }


@tool
def check_refund_history(customer_id: str) -> dict:
    """Check a customer's recent refund count against the abuse limit."""
    n = store.refunds_last_90_days(customer_id)
    return {"refunds_last_90_days": n, "abuse_limit": ABUSE_REFUND_LIMIT, "is_abuser": n > ABUSE_REFUND_LIMIT}


@tool
def issue_refund(order_id: str, reason: str) -> dict:
    """Issue a refund for an order. A deterministic policy guard runs BEFORE this executes; if the
    refund violates policy it is blocked and you must explain the denial instead. Only call this
    once you believe the refund should be approved."""
    # If execution reaches here, PolicyGuardrailMiddleware already allowed it. Re-evaluate (a pure,
    # idempotent read) only to get the authoritative refund amount, then record the refund.
    # Fetch raw order once to get customer_id; guardrail.evaluate also calls raw_order internally,
    # but we need customer_id here for record_refund — one targeted PK lookup is cheap.
    verdict = guardrail.evaluate(order_id)
    raw = store.raw_order(order_id)
    if raw is None:
        # Unreachable in practice: the guardrail denies a missing order before this tool runs. Guard
        # anyway so a malformed order_id returns a clean error instead of crashing on a None lookup.
        return {"status": "error", "decision": "DENY", "reason": "No order found with that id.",
                "order_id": order_id}
    record = store.record_refund(
        order_id=order_id,
        customer_id=raw["customer_id"],
        amount=verdict["refund_amount"],
        reason=reason or verdict["reason"],
    )
    return {
        "status": "refunded",
        "decision": verdict["decision"],
        "refund_id": record["refund_id"],
        "amount": record["amount"],
        "rule": verdict["rule"],
        "reason": verdict["reason"],
        "order_id": order_id,
        "customer_id": raw["customer_id"],
    }


@tool
def escalate_to_human(order_id: str, reason: str) -> dict:
    """Hand the case off to a human agent for approval. Use when the policy requires escalation
    (high-value refund or refund-abuse review). This creates a pending approval that a human operator
    must approve or deny — the refund is NOT issued until a human approves it."""
    # The escalation path holds the line too: never open a human-approval ticket for an order the
    # policy hard-denies (final-sale, gift card, already-refunded, unknown order, …). Otherwise a
    # non-refundable item could slip into the approval queue. evaluate() also returns DENY for a
    # missing order id, so this doubly guards against a corrupt approval being created.
    verdict = guardrail.evaluate(order_id)
    if verdict["decision"] == "DENY":
        return {
            "status": "blocked",
            "decision": "DENY",
            "reason": verdict["reason"],
            "rule": verdict["rule"],
            "note": "This order is not refundable, so it cannot be escalated. Explain the denial to "
                    "the customer instead.",
        }
    raw = store.raw_order(order_id)
    amount = raw["amount"] if raw else 0.0
    customer_id = raw["customer_id"] if raw else "unknown"
    approval = store.create_approval(order_id, customer_id, amount, reason)
    writer = get_stream_writer()
    if writer:
        writer({
            "event": "awaiting_approval",
            "summary": f"Escalated {order_id} (${amount:.2f}) — awaiting human approval.",
            "data": approval,
        })
    return {
        "status": "escalated",
        "order_id": order_id,
        "reason": reason,
        "approval_id": approval["id"],
        "ticket_id": f"esc_{order_id or 'unknown'}",
        "note": "A pending approval was created. A human must approve before any refund is issued.",
    }


# The toolset handed to the agent.
TOOLS = [
    lookup_customer,
    list_orders_for_customer,
    get_order,
    check_return_window,
    check_category_eligibility,
    check_refund_history,
    issue_refund,
    escalate_to_human,
]
