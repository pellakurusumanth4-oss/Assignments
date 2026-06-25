"""The refund agent — built with LangChain's `create_agent` (the prebuilt ReAct agent).

Architecture (idiomatic LangChain 1.x — almost no bespoke orchestration):
- **Model**: `init_chat_model("anthropic:…")`, honoring ANTHROPIC_BASE_URL (works through a gateway
  like TokenRouter).
- **Agent**: `create_agent(model, tools, system_prompt, middleware=[…])`.
- **Middleware** carries the two things that matter:
    · `PolicyGuardrailMiddleware` — deterministic "hold the line" veto before `issue_refund`.
    · `ResilienceMiddleware`     — model failover + malformed-verdict retry (shown in the log).
    · `ModelCallLimitMiddleware` — the stopping condition (max model calls per turn).
- **Reasoning log**: we `astream(stream_mode=["values","updates","custom"])` and translate the
  stream into the SSE event bus — tool calls/results/messages from `updates`, guard/failover/retry
  from `custom`. (LangSmith tracing also works out of the box via env vars — see README.)
- **Verdict**: derived from what actually happened (refund recorded / guard block / escalation),
  i.e. τ-bench "grade the state", with the model's <decision> tag as a fallback.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Optional


def _install_usage_shim() -> None:
    """Make langchain-anthropic's usage parsing tolerant of gateway responses.

    Gateways like TokenRouter return a `usage.cache_creation` whose token fields are null, which
    makes langchain-anthropic's `_create_usage_metadata` do `0 += None` and raise. Usage metadata is
    telemetry only, so we wrap the parser and fall back to a basic count when it chokes. Native
    Anthropic responses are unaffected.
    """
    import langchain_anthropic.chat_models as cm

    if getattr(cm, "_usage_shim_installed", False):
        return
    _orig = cm._create_usage_metadata

    def _safe(usage):
        try:
            return _orig(usage)
        except Exception:  # noqa: BLE001 - never let telemetry parsing break a real reply
            from langchain_core.messages.ai import UsageMetadata

            it = getattr(usage, "input_tokens", 0) or 0
            ot = getattr(usage, "output_tokens", 0) or 0
            return UsageMetadata(input_tokens=it, output_tokens=ot, total_tokens=it + ot)

    cm._create_usage_metadata = _safe
    cm._usage_shim_installed = True


_install_usage_shim()

from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import ModelCallLimitMiddleware  # noqa: E402
from langchain.chat_models import init_chat_model  # noqa: E402
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage  # noqa: E402

from .utils.chaos import _chaos, arm_chaos  # noqa: E402,F401  (re-exported for the admin chaos route)
from .utils.middleware import (  # noqa: E402
    InjectionDetectionMiddleware,
    PolicyGuardrailMiddleware,
    ResilienceMiddleware,
)
from .utils.policy import build_system_prompt  # noqa: E402
from .utils.state import AgentRunResult  # noqa: E402
from .utils.store import store  # noqa: E402
from .utils.tools import TOOLS  # noqa: E402

AGENT_MODEL = os.getenv("AGENT_MODEL", "claude-sonnet-4-6")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "claude-haiku-4-5")
MAX_ITERATIONS = 8

DECISION_RE = re.compile(r"<decision>\s*(APPROVE|DENY|ESCALATE)\s*</decision>", re.IGNORECASE)


def _model(name: str):
    """Build a chat model by name, honoring ANTHROPIC_BASE_URL for gateway routing."""
    return init_chat_model(
        name,
        model_provider="anthropic",
        base_url=os.getenv("ANTHROPIC_BASE_URL") or None,
        max_tokens=2048,
        timeout=60,
        max_retries=1,
    )


def build_graph():
    """Construct the compiled refund agent (LangChain `create_agent`)."""
    return create_agent(
        model=_model(AGENT_MODEL),
        tools=TOOLS,
        system_prompt=build_system_prompt(),
        middleware=[
            InjectionDetectionMiddleware(),
            PolicyGuardrailMiddleware(),
            ResilienceMiddleware(_model(FALLBACK_MODEL)),
            ModelCallLimitMiddleware(run_limit=MAX_ITERATIONS, exit_behavior="end"),
        ],
    )


# The compiled graph, exported for `langgraph.json` (so it runs in LangGraph Studio / `langgraph dev`)
# and reused by `run_agent` below.
graph = build_graph()


# --- helpers -----------------------------------------------------------------------------------
def _short(obj: Any, limit: int = 160) -> str:
    s = json.dumps(obj, default=str) if not isinstance(obj, str) else obj
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _safe_json(content: Any) -> dict:
    if isinstance(content, dict):
        return content
    try:
        v = json.loads(content)
        return v if isinstance(v, dict) else {"value": v}
    except Exception:  # noqa: BLE001
        return {"raw": str(content)}


def _text_of(msg: BaseMessage) -> str:
    c = msg.content
    if isinstance(c, str):
        return c.strip()
    parts = [b if isinstance(b, str) else b.get("text", "") for b in c
             if isinstance(b, str) or (isinstance(b, dict) and b.get("type") == "text")]
    return "\n".join(p for p in parts if p).strip()


def _last_ai_text(messages: list[BaseMessage]) -> str:
    for m in reversed(messages):
        if isinstance(m, AIMessage):
            t = _text_of(m)
            if t:
                return t
    return ""


def _parse_decision(text: str) -> Optional[str]:
    m = DECISION_RE.search(text or "")
    return m.group(1).upper() if m else None


def _history_to_messages(history: list[Any]) -> list[BaseMessage]:
    return [m for m in (history or []) if isinstance(m, BaseMessage)]


# --- public entry point (stable signature) -----------------------------------------------------
async def run_agent(
    session_id: str,
    user_message: str,
    history: list[dict[str, Any]],
    emit: Callable[[str, str, dict], None],
) -> AgentRunResult:
    """Run one turn. Streams the agent and forwards every step to `emit`; returns
    {reply, decision, refund, messages}.

    Refund lookup is zero-query for DENY/ESCALATE turns and one indexed query
    (`store.refund_for_order`) for APPROVE turns — the old approach did two full
    table scans (`store.issued_refunds()`) on every turn regardless of outcome.
    """
    emit("user_message", user_message, {})

    inputs = {"messages": _history_to_messages(history) + [HumanMessage(content=user_message)]}

    final_messages: list[BaseMessage] = []
    action_decision: Optional[str] = None  # authoritative verdict from what actually happened
    # order_id of the refund issued this turn (set only when issue_refund succeeds)
    refunded_order_id: Optional[str] = None

    # Track pending issue_refund tool-call args (tool_call id → args) so we can correlate the
    # ToolMessage result back to the order_id without a second store scan.
    _pending_refund_calls: dict[str, dict] = {}

    # LangSmith tracing (if LANGSMITH_TRACING / LANGSMITH_API_KEY are set) is automatic — LangChain
    # instruments every run with no code here. The in-app SSE log below is our own real-time view.
    async for mode, chunk in graph.astream(inputs, stream_mode=["values", "updates", "custom"]):
        if mode == "values":
            final_messages = chunk.get("messages", final_messages)

        elif mode == "custom":
            ev = chunk if isinstance(chunk, dict) else {}
            etype = ev.get("event")
            if etype:
                emit(etype, ev.get("summary", ""), ev.get("data", {}))
                if etype == "guardrail_block":
                    action_decision = ev.get("data", {}).get("decision")

        elif mode == "updates":
            for _node, upd in chunk.items():
                if not isinstance(upd, dict):
                    continue
                for m in upd.get("messages", []):
                    if isinstance(m, AIMessage):
                        text = _text_of(m)
                        if text:
                            emit("agent_message", text, {})
                        for tc in (m.tool_calls or []):
                            emit("tool_call", f"{tc['name']}({_short(tc['args'])})",
                                 {"tool": tc["name"], "input": tc["args"]})
                            # Stash args for issue_refund calls so we can resolve the
                            # order_id when the ToolMessage result arrives.
                            if tc["name"] == "issue_refund":
                                _pending_refund_calls[tc["id"]] = tc["args"]
                    elif isinstance(m, ToolMessage):
                        result = _safe_json(m.content)
                        emit("tool_result", f"{m.name} → {_short(result)}",
                             {"tool": m.name, "result": result})
                        if m.name == "issue_refund" and result.get("status") == "refunded":
                            action_decision = result.get("decision", "APPROVE")
                            # Retrieve the order_id from the matching tool-call args (no DB scan
                            # needed — it was captured above when the AIMessage was processed).
                            tc_args = _pending_refund_calls.get(m.tool_call_id, {})
                            refunded_order_id = tc_args.get("order_id")
                        elif m.name == "escalate_to_human" and result.get("status") == "escalated":
                            # Only when the escalation actually went through (the path is now blocked
                            # for non-refundable orders) and never over an existing guardrail DENY.
                            if action_decision != "DENY":
                                action_decision = "ESCALATE"

    final_text = _last_ai_text(final_messages)
    decision = action_decision or _parse_decision(final_text)
    emit("decision", f"Final decision: {decision or 'UNKNOWN'}", {"decision": decision})

    # The <decision> tag is an internal control signal — strip it from the customer-facing reply
    # (the UI shows the verdict as a badge). The parsed `decision` above is unaffected.
    reply = DECISION_RE.sub("", final_text).strip()

    # One indexed lookup only when a refund was actually issued this turn; zero queries otherwise.
    new_refund = store.refund_for_order(refunded_order_id) if refunded_order_id else None
    convo = [m for m in final_messages if not isinstance(m, SystemMessage)]
    return {"reply": reply, "decision": decision, "refund": new_refund, "messages": convo}
