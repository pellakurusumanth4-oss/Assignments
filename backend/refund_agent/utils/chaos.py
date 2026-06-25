"""Chaos injection for the resilience demo.

Lets a demo deterministically trigger a model failover or a malformed-verdict retry on the next
turn (armed live from the admin dashboard, or via CHAOS_* env vars). Kept in its own module so both
the agent and the middleware can share it without a circular import.
"""

from __future__ import annotations

import os

_chaos: dict[str, bool] = {
    "model_error": os.getenv("CHAOS_MODEL_ERROR") == "1",
    "invalid_decision": os.getenv("CHAOS_INVALID_DECISION") == "1",
}


def arm_chaos(kind: str) -> bool:
    """Arm a one-shot chaos event ('model_error' or 'invalid_decision'). Returns True if known."""
    if kind in _chaos:
        _chaos[kind] = True
        return True
    return False


def consume(kind: str) -> bool:
    """Consume (and clear) a one-shot chaos flag."""
    if _chaos.get(kind):
        _chaos[kind] = False
        return True
    return False
