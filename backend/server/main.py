"""FastAPI app: customer chat, real-time event stream (SSE), and admin/data endpoints."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv

load_dotenv()

import httpx  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from sse_starlette.sse import EventSourceResponse  # noqa: E402

from refund_agent import agent as agent_mod  # noqa: E402
from refund_agent.agent import run_agent  # noqa: E402
from refund_agent.utils import guardrail  # noqa: E402
from refund_agent.utils.policy import load_policy  # noqa: E402
from refund_agent.utils.store import store  # noqa: E402

from . import voice  # noqa: E402
from .events import bus  # noqa: E402
from .models import ChatRequest, ChatResponse  # noqa: E402
from .voice import router as voice_router  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Own the shared ElevenLabs HTTP client for the app's lifetime.

    Created once on startup and closed on shutdown, so the voice handlers reuse one connection pool
    and the client is always cleanly closed (no per-request leak path).
    """
    client = httpx.AsyncClient(timeout=voice._TIMEOUT)
    voice.set_client(client)
    try:
        yield
    finally:
        voice.set_client(None)
        await client.aclose()


app = FastAPI(title="ACME Refund Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo app; tighten for production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(voice_router)  # /api/voice/{status,stt,tts} — voice bonus (ElevenLabs)

# Per-session conversation history (in memory; fine for a demo).
_histories: dict[str, list[Any]] = {}
# One lock per session so two rapid messages in the SAME session run as ordered turns instead of
# racing on a stale `history` read (which would silently drop a turn). Different sessions still run
# concurrently. The UI already disables Send while busy; this is the server-side guarantee.
_session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


@app.get("/api/health")
def health() -> dict[str, Any]:
    import os

    langsmith_on = bool(os.getenv("LANGSMITH_API_KEY")) and os.getenv(
        "LANGSMITH_TRACING", ""
    ).lower() in ("true", "1")
    return {
        "ok": True,
        "agent_model": agent_mod.AGENT_MODEL,
        "fallback_model": agent_mod.FALLBACK_MODEL,
        "langsmith_enabled": langsmith_on,
        "langsmith_url": "https://smith.langchain.com",
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    session_id = (req.session_id or "").strip()
    user_message = (req.message or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id must not be empty.")
    if not user_message:
        raise HTTPException(status_code=422, detail="message must not be empty.")

    # Serialize turns within a session: read history, run, write back atomically under the lock.
    async with _session_locks[session_id]:
        history = _histories.get(session_id, [])
        emit = bus.emitter(session_id)
        try:
            result = await run_agent(session_id, user_message, history, emit)
        except Exception as exc:  # noqa: BLE001 - surface a clean error after failover is exhausted
            # The agent could not produce a reply (e.g. every model failed). Do NOT corrupt the stored
            # history with a half-finished turn — leave it as it was so the next request starts clean.
            raise HTTPException(
                status_code=502,
                detail=f"The agent is temporarily unavailable: {type(exc).__name__}.",
            ) from exc

        _histories[session_id] = result["messages"]
    return ChatResponse(
        session_id=session_id,
        reply=result["reply"],
        decision=result["decision"],
        refund=result["refund"],
    )


@app.get("/api/events")
async def events(request: Request, session_id: str | None = None) -> EventSourceResponse:
    """SSE stream of reasoning events. Pass ?session_id=... for one session, omit for all sessions."""

    async def gen():
        async for ev in bus.subscribe(session_id):
            if await request.is_disconnected():
                break
            # default "message" event so the browser's EventSource.onmessage receives every type
            yield {"data": ev.model_dump_json()}

    return EventSourceResponse(gen())


@app.get("/api/admin/sessions")
def sessions() -> dict[str, Any]:
    return {"sessions": bus.sessions()}


@app.get("/api/admin/session/{session_id}")
def session_history(session_id: str) -> dict[str, Any]:
    return {"events": [e.model_dump() for e in bus.history(session_id)]}


@app.post("/api/admin/chaos")
async def chaos(request: Request) -> dict[str, Any]:
    """Arm a one-shot failure for the next turn: {"kind": "model_error" | "invalid_decision"}."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed / missing JSON body
        raise HTTPException(status_code=422, detail="Request body must be valid JSON.") from None
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="Request body must be a JSON object.")
    kind = body.get("kind", "")
    ok = agent_mod.arm_chaos(kind)
    return {"armed": ok, "kind": kind}


@app.get("/api/admin/approvals")
def approvals(status: str | None = "pending") -> dict[str, Any]:
    """Pending (or all) human-in-the-loop approval requests for escalated refunds."""
    return {"approvals": store.list_approvals(status)}


@app.post("/api/admin/approve")
async def approve(request: Request) -> dict[str, Any]:
    """Operator resolves an escalation: {"approval_id": "...", "decision": "approve" | "deny"}.

    Approving issues the refund (a human is the authority above the escalation threshold), but only if
    the deterministic guardrail doesn't hard-deny the order — so a final-sale item still can't be
    forced through even by an operator click.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=422, detail="Request body must be valid JSON.") from None
    approval_id = (body or {}).get("approval_id", "")
    decision = (body or {}).get("decision", "")
    # store.* and guardrail.evaluate are synchronous (blocking psycopg/SQLModel); run them off the
    # event loop so a slow DB doesn't stall SSE streaming or the chat path on this single worker.
    ap = await run_in_threadpool(store.get_approval, approval_id)
    if not ap:
        raise HTTPException(status_code=404, detail="Approval not found.")
    if ap["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Approval already {ap['status']}.")

    if decision == "deny":
        await run_in_threadpool(store.resolve_approval, approval_id, "denied")
        bus.publish("system", "approval_resolved",
                    f"Operator DENIED the escalated refund for {ap['order_id']}.",
                    {**ap, "status": "denied"})
        return {"status": "denied", "approval_id": approval_id}

    if decision == "approve":
        verdict = await run_in_threadpool(guardrail.evaluate, ap["order_id"])
        if verdict["decision"] == "DENY":
            raise HTTPException(
                status_code=409,
                detail=f"Policy forbids this refund (rule {verdict['rule']}): {verdict['reason']}",
            )
        amount = verdict["refund_amount"] if verdict["refund_amount"] is not None else ap["amount"]
        record = await run_in_threadpool(
            store.record_refund,
            ap["order_id"], ap["customer_id"], amount,
            f"Human-approved escalation: {ap['reason']}",
        )
        await run_in_threadpool(store.resolve_approval, approval_id, "approved", record["refund_id"])
        bus.publish("system", "approval_resolved",
                    f"Operator APPROVED a ${amount:.2f} refund for {ap['order_id']}.",
                    {**ap, "status": "approved", "refund_id": record["refund_id"], "amount": amount})
        return {"status": "approved", "approval_id": approval_id, "refund": record}

    raise HTTPException(status_code=422, detail="decision must be 'approve' or 'deny'.")


@app.get("/api/policy")
def policy() -> dict[str, str]:
    return {"policy": load_policy()}


@app.get("/api/crm")
def crm() -> dict[str, Any]:
    """Expose the mock CRM so the admin UI can show profiles and orders (and demo data)."""
    return {
        "customers": store.all_customers(),
        "orders": store.all_orders(),
        "refunds": store.issued_refunds(),
    }
