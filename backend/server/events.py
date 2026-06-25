"""In-process event bus that powers the real-time admin reasoning log.

Every step of the agent loop publishes an Event here. The SSE endpoints subscribe and stream events
to the admin dashboard. New subscribers get the existing history first, then live events.

Resource bounds (this bus lives for the process lifetime, so everything here is capped):
- Per-subscriber queues are bounded; a slow/stalled browser drops its *oldest* buffered events
  instead of growing memory without limit or blocking the (synchronous, non-async) publisher.
- Per-session and global history are ring-buffered, so a long-running demo can't grow heap forever.
- Subscriber queues are removed on disconnect (the `finally` in `subscribe`), so dead browsers don't
  accumulate.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from typing import Any, AsyncGenerator, Callable

from .models import Event

# A slow SSE consumer buffers at most this many events; beyond it, the oldest are dropped (the live
# log is best-effort — full history is always available via /api/admin/session/{id}).
_QUEUE_MAXSIZE = 1000
# Cap retained history so an unbounded run can't leak memory. Generous: a demo session is dozens of
# events, and the global ring spans many sessions.
_SESSION_HISTORY_MAX = 2000
_GLOBAL_HISTORY_MAX = 5000


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._global_subs: set[asyncio.Queue] = set()
        self._history: dict[str, deque[Event]] = defaultdict(lambda: deque(maxlen=_SESSION_HISTORY_MAX))
        self._order: deque[Event] = deque(maxlen=_GLOBAL_HISTORY_MAX)  # global chronological history
        self._sessions: dict[str, dict[str, Any]] = {}

    # ----------------------------------------------------------------- publish
    @staticmethod
    def _offer(q: asyncio.Queue, ev: Event) -> None:
        """Non-blocking enqueue with drop-oldest backpressure.

        The publisher is a plain sync call from the agent loop, so it must never block or raise on a
        full queue. If a subscriber has fallen behind past the bound, evict its oldest event to make
        room — the dashboard stays live and bounded rather than stalling the agent.
        """
        try:
            q.put_nowait(ev)
        except asyncio.QueueFull:
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass

    def publish(self, session_id: str, etype: str, summary: str, data: dict) -> Event:
        ev = Event(session_id=session_id, type=etype, summary=summary, data=data)
        self._history[session_id].append(ev)
        self._order.append(ev)
        self._update_session(ev)
        for q in list(self._subs[session_id]):
            self._offer(q, ev)
        for q in list(self._global_subs):
            self._offer(q, ev)
        return ev

    def emitter(self, session_id: str) -> Callable[[str, str, dict], None]:
        """Return an emit(type, summary, data) callable bound to a session."""
        return lambda etype, summary, data: self.publish(session_id, etype, summary, data)

    # --------------------------------------------------------------- subscribe
    async def subscribe(self, session_id: str | None) -> AsyncGenerator[Event, None]:
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        if session_id:
            self._subs[session_id].add(q)
            backlog = list(self._history.get(session_id, []))
        else:
            self._global_subs.add(q)
            backlog = list(self._order)
        try:
            for ev in backlog:
                yield ev
            while True:
                yield await q.get()
        finally:
            # Always runs — normal completion, browser disconnect (GeneratorExit), or cancellation —
            # so a subscriber's queue is never left dangling in the bus.
            if session_id:
                self._subs[session_id].discard(q)
                # Drop the now-empty session bucket so per-session sets don't accumulate forever.
                if not self._subs[session_id]:
                    self._subs.pop(session_id, None)
            else:
                self._global_subs.discard(q)

    # ------------------------------------------------------------------ admin
    def _update_session(self, ev: Event) -> None:
        s = self._sessions.setdefault(
            ev.session_id,
            {"session_id": ev.session_id, "created_at": ev.ts, "messages": 0,
             "last_decision": None, "last_summary": "", "updated_at": ev.ts},
        )
        s["updated_at"] = ev.ts
        s["last_summary"] = ev.summary
        if ev.type == "user_message":
            s["messages"] += 1
        elif ev.type == "decision":
            s["last_decision"] = ev.data.get("decision")

    def sessions(self) -> list[dict[str, Any]]:
        return sorted(self._sessions.values(), key=lambda s: s["updated_at"], reverse=True)

    def history(self, session_id: str) -> list[Event]:
        return list(self._history.get(session_id, []))


bus = EventBus()
