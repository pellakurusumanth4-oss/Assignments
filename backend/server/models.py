"""Shared schemas: API request/response models, the event schema, and the decision type."""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field

from refund_agent.utils.state import Decision  # single source of truth for the verdict type

# Event types streamed to the admin reasoning dashboard.
EVENT_TYPES = {
    "user_message",      # customer said something
    "agent_message",     # agent's natural-language reply / narration
    "tool_call",         # agent decided to call a tool
    "tool_result",       # tool returned
    "guardrail_block",   # deterministic policy guard vetoed an action ("holding the line")
    "decision",          # final verdict parsed from <decision> tags
    "retry",             # a step failed (e.g. unparseable verdict) and was retried
    "failover",          # primary model failed; fell back to backup model
    "injection_flagged", # a prompt-injection / jailbreak attempt was detected in the customer message
    "awaiting_approval", # escalated; a human-in-the-loop approval is pending
    "approval_resolved", # an operator approved/denied a pending escalation
    "error",             # unrecoverable error
}


class Event(BaseModel):
    id: str = Field(default_factory=lambda: f"ev_{uuid.uuid4().hex[:10]}")
    session_id: str
    type: str
    summary: str
    data: dict[str, Any] = Field(default_factory=dict)
    ts: float = Field(default_factory=time.time)


class ChatRequest(BaseModel):
    session_id: str
    message: str


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    decision: Optional[Decision] = None
    refund: Optional[dict[str, Any]] = None
