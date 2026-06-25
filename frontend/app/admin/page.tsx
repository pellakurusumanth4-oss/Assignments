"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  armChaos,
  getHealth,
  getApprovals,
  resolveApproval,
  type Approval,
} from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { EVENT_META } from "@/lib/ui";

// Event types whose structured payload is worth expanding inline.
const EXPANDABLE = new Set([
  "guardrail_block",
  "tool_result",
  "tool_call",
  "error",
  "injection_flagged",
  "awaiting_approval",
  "approval_resolved",
]);

export default function AdminPage() {
  const { events, connected } = useEventStream(); // global: all sessions
  const [models, setModels] = useState<{
    agent_model: string;
    fallback_model: string;
    langsmith_enabled?: boolean;
    langsmith_url?: string;
  }>({ agent_model: "…", fallback_model: "…" });
  const [armed, setArmed] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshApprovals = useCallback(() => {
    getApprovals("pending").then(setApprovals).catch(() => {});
  }, []);

  useEffect(() => {
    getHealth().then(setModels).catch(() => {});
  }, []);
  // Poll pending approvals, and refresh whenever a new escalation/resolution event arrives.
  useEffect(() => {
    refreshApprovals();
    const t = setInterval(refreshApprovals, 4000);
    return () => clearInterval(t);
  }, [refreshApprovals]);
  useEffect(() => {
    refreshApprovals();
  }, [events.length, refreshApprovals]);

  async function resolve(id: string, decision: "approve" | "deny") {
    if (resolving) return;
    setResolving(id);
    setApprovalError(null);
    try {
      await resolveApproval(id, decision);
      refreshApprovals();
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : "Failed to resolve.");
    } finally {
      setResolving(null);
    }
  }
  useEffect(
    () => endRef.current?.scrollIntoView({ behavior: "smooth" }),
    [events],
  );
  // Clear the pending "armed" timer on unmount to avoid a stray state update.
  useEffect(() => {
    return () => {
      if (armedTimer.current) clearTimeout(armedTimer.current);
    };
  }, []);

  async function inject(kind: string, label: string) {
    if (injecting) return;
    setInjecting(true);
    try {
      await armChaos(kind);
      setArmed(label);
      if (armedTimer.current) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setArmed(null), 4000);
    } catch {
      setArmed("Couldn't reach the backend to arm chaos.");
      if (armedTimer.current) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setArmed(null), 4000);
    } finally {
      setInjecting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6">
      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Agent reasoning — live
            </h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Every step the agent takes, streamed in real time.
            </p>
            {models.langsmith_enabled && models.langsmith_url && (
              <a
                href={models.langsmith_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700 transition hover:bg-violet-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              >
                🔭 Open full traces &amp; evals in LangSmith ↗
              </a>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Resilience demo
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => inject("model_error", "Model failure armed")}
                disabled={injecting}
                className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 transition hover:bg-orange-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                🔀 Inject model failure
              </button>
              <button
                type="button"
                onClick={() => inject("invalid_decision", "Invalid verdict armed")}
                disabled={injecting}
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                🔁 Inject invalid verdict
              </button>
            </div>
          </div>
        </div>

        {/* Stat chips */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
            <span className="text-slate-400">model</span>
            <code className="font-medium text-slate-700">{models.agent_model}</code>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
            <span className="text-slate-400">fallback</span>
            <code className="font-medium text-slate-700">{models.fallback_model}</code>
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${
              connected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-600"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`} />
            {connected ? "connected" : "disconnected"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-500">
            {events.length} events
          </span>
        </div>
      </div>

      {armed && (
        <div
          role="status"
          className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          {armed} — it will fire on the next customer message.
        </div>
      )}

      {approvals.length > 0 && (
        <div className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-amber-200 text-xs">⏳</span>
            Pending approvals — human-in-the-loop
            <span className="rounded-full bg-amber-600 px-2 py-0.5 text-[11px] font-bold text-white">
              {approvals.length}
            </span>
          </h2>
          {approvalError && (
            <p className="mb-2 text-xs text-red-600">{approvalError}</p>
          )}
          <ul className="space-y-2">
            {approvals.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2"
              >
                <div className="min-w-0 text-xs text-slate-700">
                  <span className="font-semibold">{a.order_id}</span> ·{" "}
                  <span className="font-medium">${a.amount.toFixed(2)}</span> ·{" "}
                  cust {a.customer_id}
                  <p className="truncate text-[11px] text-slate-500">{a.reason}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => resolve(a.id, "approve")}
                    disabled={resolving === a.id}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Approve refund
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(a.id, "deny")}
                    disabled={resolving === a.id}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <span className="flex items-center gap-2.5 text-xs font-medium text-slate-300">
            <span className="flex gap-1.5" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
            </span>
            Reasoning log
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            live · SSE
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
        {!connected && events.length === 0 ? (
          <p className="py-8 text-center text-slate-500">
            Not connected to the event stream. Is the backend running on{" "}
            <code>/api/events</code>?
          </p>
        ) : events.length === 0 ? (
          <p className="py-8 text-center text-slate-500">
            Waiting for activity… send a message from the customer chat.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((ev) => {
              const meta = EVENT_META[ev.type] ?? {
                label: ev.type,
                icon: "•",
                color: "border-slate-600 text-slate-300",
              };
              const hasData = ev.data && Object.keys(ev.data).length > 0;
              return (
                <li key={ev.id} className={`animate-rise rounded-r border-l-2 py-0.5 pl-3 transition-colors hover:bg-slate-900/60 ${meta.color}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-slate-500">
                      {new Date(ev.ts * 1000).toLocaleTimeString()}
                    </span>
                    <span className="shrink-0" aria-hidden="true">
                      {meta.icon}
                    </span>
                    <span className="shrink-0 font-semibold uppercase tracking-wide">
                      {meta.label}
                    </span>
                    <span className="break-words text-slate-300">
                      {ev.summary}
                    </span>
                  </div>
                  {hasData && EXPANDABLE.has(ev.type) && (
                    <details className="ml-6 mt-1">
                      <summary className="cursor-pointer text-[10px] text-slate-500 hover:text-slate-300">
                        payload
                      </summary>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-slate-500">
                        {JSON.stringify(ev.data, null, 2)}
                      </pre>
                    </details>
                  )}
                  <span className="ml-6 text-[10px] text-slate-600">
                    session {ev.session_id.slice(0, 8)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={endRef} />
        </div>
      </div>
    </main>
  );
}
