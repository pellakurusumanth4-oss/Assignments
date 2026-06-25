"""Deterministic policy guardrail — the graded 'hold the line' logic.

These assert the authoritative verdict per order (tau-bench style: check the outcome, not chat text).
"""

import pytest

from refund_agent.utils import guardrail
from refund_agent.utils.store import RESTOCKING_FEE_RATE

CASES = [
    ("ord_1001", "APPROVE", "4.1"),       # in window, new
    ("ord_1002", "DENY", "2.2"),          # outside window
    ("ord_1003", "DENY", "3.4"),          # final sale
    ("ord_1004", "DENY", "3.1"),          # gift card
    ("ord_1005", "ESCALATE", "5.1"),      # high value
    ("ord_1006", "ESCALATE", "5.2"),      # refund abuser
    ("ord_1007", "APPROVE", "4.1"),       # defective, within 90d
    ("ord_1008", "APPROVE_PARTIAL", "4.3"),  # opened electronics
    ("ord_1009", "DENY", "1.2"),          # already refunded
    ("ord_1010", "DENY", "1.1"),          # not delivered
    ("ord_1011", "DENY", "3.3"),          # perishable
    ("ord_1012", "DENY", "3.2"),          # redeemed digital
    ("ord_1013", "APPROVE", "4.1"),       # in window
    ("ord_1014", "DENY", "4.4"),          # used
    ("ord_1015", "ESCALATE", "5.1"),      # high value
    ("ord_1016", "DENY", "2.2"),          # outside window
]


@pytest.mark.parametrize("order_id,decision,rule", CASES)
def test_guardrail_decisions(order_id, decision, rule):
    v = guardrail.evaluate(order_id)
    assert v["decision"] == decision, f"{order_id}: {v}"
    assert v["rule"] == rule, f"{order_id}: {v}"


def test_restocking_fee_amount():
    v = guardrail.evaluate("ord_1008")  # $19.99 opened electronics
    expected = round(19.99 * (1 - RESTOCKING_FEE_RATE), 2)
    assert v["refund_amount"] == expected


def test_unknown_order_denied():
    v = guardrail.evaluate("ord_does_not_exist")
    assert v["decision"] == "DENY"
    assert v["allowed"] is False


def test_only_approvals_are_allowed():
    for order_id, decision, _ in CASES:
        v = guardrail.evaluate(order_id)
        assert v["allowed"] == (decision in ("APPROVE", "APPROVE_PARTIAL"))
