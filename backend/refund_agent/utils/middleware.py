"""Agent middleware: the two cross-cutting concerns that make this agent trustworthy.

- `PolicyGuardrailMiddleware` — the deterministic "hold the line" guard. It wraps every tool call
  and vetoes an out-of-policy `issue_refund` BEFORE it runs (the AWS neurosymbolic "BeforeToolCall
  hook that can cancel the tool" pattern, expressed as a LangChain `wrap_tool_call`). The LLM cannot
  talk its way past it.
- `ResilienceMiddleware` — wraps every model call to provide model **failover** and a one-shot
  malformed-verdict **retry**, and (unlike the built-in fallback middleware) emits these as custom
  stream events so they show up in the in-app reasoning dashboard, not just in LangSmith.

Both surface their actions via `get_stream_writer()` custom events, which `run_agent` forwards to
the SSE event bus.
"""

from __future__ import annotations

import json
import re

import unicodedata

from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.config import get_stream_writer
from langgraph.errors import GraphBubbleUp

from . import guardrail
from .chaos import consume


def _emit(event: str, summary: str, data: dict) -> None:
    """Publish a custom stream event (best-effort; no-op if not streaming)."""
    writer = get_stream_writer()
    if writer:
        writer({"event": event, "summary": summary, "data": data})


_INJECTION_RE = re.compile(
    r"ignore (all |the |your )?(previous|prior|earlier|above) (instructions|rules)"
    r"|disregard (the |your )?(policy|rules|instructions)"
    r"|forget (your|all|the) (instructions|rules|policy)"
    r"|you are now|developer mode|jailbreak|\bDAN\b|do anything now"
    r"|pretend (you|to be)|act as (if|though)\b"
    r"|override (the )?(policy|guard|rules)|bypass (the )?(policy|guard|rules)"
    r"|(reveal|show|print|repeat|dump|leak|expose|ignore|bypass|override|change|modify|forget)"
    r" (your |the |all )?system prompt"
    r"|new instructions\s*:",
    re.IGNORECASE,
)


def _normalize(text: str) -> str:
    """Fold away cheap evasions before injection matching: compatibility-normalize unicode (so
    fullwidth / styled letters become ASCII) and collapse runs of any whitespace (incl. NBSP) to a
    single space, so `ignore  previous  instructions` and `ＩＧＮＯＲＥ …` still match."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text))


class InjectionDetectionMiddleware(AgentMiddleware):
    """Flags likely prompt-injection / jailbreak attempts in the customer's message.

    Detection only — it does NOT decide the outcome (the deterministic guardrail already makes the
    refund safe). It surfaces an `injection_flagged` event so the reasoning log shows the attempt was
    seen and the policy still held (OWASP LLM01 defense-in-depth: detect + log + deterministic enforce).
    """

    async def abefore_model(self, state, runtime):
        messages = state.get("messages", []) if isinstance(state, dict) else getattr(state, "messages", [])
        # Only inspect at the start of a turn (last message is the customer's), so we flag once.
        if messages and isinstance(messages[-1], HumanMessage):
            text = messages[-1].content if isinstance(messages[-1].content, str) else ""
            if _INJECTION_RE.search(_normalize(text)):
                _emit(
                    "injection_flagged",
                    "Possible prompt-injection / jailbreak attempt detected — policy is still enforced "
                    "deterministically, so it cannot change the outcome.",
                    {"snippet": text[:200]},
                )
        return None


class PolicyGuardrailMiddleware(AgentMiddleware):
    """Deterministic policy enforcement: blocks an out-of-policy refund before the tool runs."""

    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        if call["name"] == "issue_refund":
            verdict = guardrail.evaluate(call["args"].get("order_id", ""))
            if not verdict["allowed"]:
                # The guard vetoes the refund — this is the "hold the line" moment.
                _emit(
                    "guardrail_block",
                    f"Refund blocked by policy guard (rule {verdict['rule']}): {verdict['decision']}",
                    verdict,
                )
                return ToolMessage(
                    content=json.dumps({
                        "status": "blocked",
                        "decision": verdict["decision"],
                        "reason": verdict["reason"],
                        "rule": verdict["rule"],
                        "note": "The deterministic policy guard prevented this refund. Do not retry; "
                                "explain the outcome to the customer.",
                    }),
                    tool_call_id=call["id"],
                    name="issue_refund",
                )
        return await handler(request)


class ResilienceMiddleware(AgentMiddleware):
    """Model failover + malformed-verdict retry, surfaced as reasoning-log events."""

    def __init__(self, fallback_model: BaseChatModel) -> None:
        super().__init__()
        self.fallback_model = fallback_model

    async def awrap_model_call(self, request, handler):
        # --- Failover (and the injectable model-error chaos) ---
        try:
            if consume("model_error"):
                raise RuntimeError("Injected primary-model failure (chaos)")
            response = await handler(request)
        except GraphBubbleUp:
            # LangGraph control-flow signals (interrupts, ParentCommand, …) are NOT model errors —
            # never swallow them as a "failover", or a human-in-the-loop interrupt would be eaten and
            # the model would be re-invoked spuriously.
            raise
        except Exception as e:  # noqa: BLE001 - fail over on any model/transport error
            _emit(
                "failover",
                f"Primary model failed ({type(e).__name__}); failing over to the backup model.",
                {"error": str(e)},
            )
            response = await handler(request.override(model=self.fallback_model))

        # --- One-shot malformed-verdict retry (injectable chaos) ---
        if consume("invalid_decision"):
            _emit(
                "retry",
                "Final reply had a malformed verdict — re-asking the model.",
                {"cause": "invalid_decision (injected)"},
            )
            response = await handler(request)

        return response
