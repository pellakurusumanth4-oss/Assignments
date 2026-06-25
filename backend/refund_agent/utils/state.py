"""State / shared types for the refund agent.

The agent's runtime message state is managed by LangChain's `create_agent` (the prebuilt
`AgentState`), so this module holds the project's shared type definitions: the decision enum and
the shape `run_agent` returns to the web layer.
"""

from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict

Decision = Literal["APPROVE", "DENY", "ESCALATE", "APPROVE_PARTIAL"]


class AgentRunResult(TypedDict):
    """What one turn of `run_agent` returns to the API layer."""

    reply: str
    decision: Optional[str]
    refund: Optional[dict[str, Any]]
    messages: list[Any]
