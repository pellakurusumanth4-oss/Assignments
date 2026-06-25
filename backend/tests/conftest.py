"""Shared test fixtures. The kept tests cover the pure, deterministic core (guardrail + store) —
the part that makes 'holding the line' provable — and need no LLM or API key."""

from __future__ import annotations

import pytest

from refund_agent.utils.store import store


@pytest.fixture(autouse=True)
def reset_state():
    """Reset the in-memory store before and after every test."""
    store.reset()
    yield
    store.reset()
