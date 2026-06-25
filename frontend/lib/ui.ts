import type { Decision } from "./api";

// Visual metadata for each event type shown in the reasoning log.
export const EVENT_META: Record<
  string,
  { label: string; icon: string; color: string }
> = {
  user_message: { label: "Customer", icon: "🧑", color: "border-slate-500 text-slate-300" },
  agent_message: { label: "Agent", icon: "🤖", color: "border-sky-500 text-sky-300" },
  tool_call: { label: "Tool call", icon: "🔧", color: "border-violet-500 text-violet-300" },
  tool_result: { label: "Tool result", icon: "📦", color: "border-cyan-600 text-cyan-300" },
  guardrail_block: { label: "Guardrail block", icon: "🛑", color: "border-red-500 text-red-300" },
  decision: { label: "Decision", icon: "⚖️", color: "border-emerald-500 text-emerald-300" },
  retry: { label: "Retry", icon: "🔁", color: "border-amber-500 text-amber-300" },
  failover: { label: "Failover", icon: "🔀", color: "border-orange-500 text-orange-300" },
  injection_flagged: { label: "Injection flagged", icon: "🚨", color: "border-rose-500 text-rose-300" },
  awaiting_approval: { label: "Awaiting approval", icon: "⏳", color: "border-amber-500 text-amber-300" },
  approval_resolved: { label: "Approval resolved", icon: "✅", color: "border-emerald-500 text-emerald-300" },
  error: { label: "Error", icon: "❌", color: "border-red-600 text-red-300" },
};

export function decisionBadge(decision: Decision): {
  text: string;
  cls: string;
} {
  switch (decision) {
    case "APPROVE":
      return { text: "Approved", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" };
    case "APPROVE_PARTIAL":
      return { text: "Partial refund", cls: "bg-teal-100 text-teal-800 border-teal-300" };
    case "DENY":
      return { text: "Denied", cls: "bg-red-100 text-red-800 border-red-300" };
    case "ESCALATE":
      return { text: "Escalated", cls: "bg-amber-100 text-amber-800 border-amber-300" };
    default:
      return { text: "Pending", cls: "bg-slate-100 text-slate-600 border-slate-300" };
  }
}
