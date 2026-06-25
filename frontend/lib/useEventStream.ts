"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, type AgentEvent } from "./api";

// Cap the in-memory event log so a long-running dashboard can't grow without bound.
const MAX_EVENTS = 500;

// Subscribe to the backend SSE stream. Pass a sessionId for one session, or omit for all sessions.
export function useEventStream(sessionId?: string) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Reset state when the subscription target changes so events from a
    // previous session don't linger.
    setEvents([]);
    setConnected(false);
    seen.current = new Set();

    const url = sessionId
      ? `${API_BASE}/api/events?session_id=${encodeURIComponent(sessionId)}`
      : `${API_BASE}/api/events`;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    // EventSource auto-reconnects; reflect the dropped connection in the UI.
    // onopen fires again once the browser reconnects.
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev: AgentEvent = JSON.parse(e.data);
        if (!ev?.id || seen.current.has(ev.id)) return;
        seen.current.add(ev.id);
        // Keep the updater pure (React may call it twice in StrictMode) — just append + trim. The
        // dedupe set is re-bounded to the rendered window in the effect below.
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [sessionId]);

  // Re-bound the dedupe set to exactly what we still render. Done here (not in the setEvents updater)
  // so the updater stays pure; line 34's `seen.current.add` still dedupes new frames immediately.
  useEffect(() => {
    seen.current = new Set(events.map((e) => e.id));
  }, [events]);

  return { events, connected };
}
