# Research Digest — AI Customer Support Agent (Refund Decisioning)

Assembled for the WORPODD assessment. Sources read in full unless marked *(listed, not deep-read)*.
Goal of the build: an LLM agent that **approves or denies e-commerce refunds** by validating a **policy
document** via **tool calls**, exposes **real-time reasoning logs**, handles **failures/retries**, and
optionally supports **voice**.

---

## 1. The closest analog that exists anywhere: τ-bench (Sierra)

- **Sierra blog** — https://sierra.ai/blog/benchmarking-ai-agents
- **Paper** — τ-bench, Yao/Shinn/Razavi/Narasimhan, arXiv:2406.12045
- **Repo** — https://github.com/sierra-research/tau-bench (now → τ³-bench: https://github.com/sierra-research/tau2-bench)

What it is: a benchmark of **customer-service agents** in **τ-retail** and **τ-airline** domains. The agent
is given (1) a realistic **database + tool APIs**, (2) a **domain policy document** dictating required
behavior, and (3) an **LLM-simulated user**. Retail tasks are literally returns/refunds/exchanges. This is
the academic mirror of the assessment.

Key takeaways for our build:
- **Three requirements for a real agent:** interact with user + APIs over a long horizon; **follow policy
  rules accurately**; stay **consistent/reliable** across many runs.
- **Stateful evaluation:** they grade by comparing **database state** after the task to the expected state —
  not by grading the chat text. → *We should test the same way: after a refund convo, assert the DB/refund
  record matches expectation.*
- **`pass^k` reliability metric:** can the agent solve the **same** task k times? Even the best model
  (claude-3-5-sonnet) scores ~0.69 `pass^1` on retail and **drops to ~0.46 by `pass^4`**. GPT-4o on retail
  drops ~60% from pass^1 to pass^8.
- **Headline insight:** *"function calling agents are not great at following rules provided in the policy
  documents."* Plain function-calling is unreliable at policy adherence → **this is why we add a
  deterministic guardrail layer** (see §4). This is the single most important design implication.
- τ³-bench now adds a **banking domain** and a **voice modality**; Sierra also published **τ-voice** (278
  grounded customer-service voice tasks). Good citations for the voice bonus.

---

## 2. The production blueprint: Gradient Labs (AI support agents for fintech)

Three-post series; reads like a spec for this exact challenge.

- **Policy-as-document** — https://blog.gradient-labs.ai/p/making-customer-support-automation
  Don't model rules as a box-and-arrow decision tree (60–80 nodes for a trivial flow). Write the procedure
  (SOP) in **plain English** and let the agent follow it. → *`refund_policy.md` IS the SOP; the agent reasons
  against it, rules are not hardcoded as `if/else`.*
- **Agentic workflows** — https://blog.gradient-labs.ai/p/building-agentic-workflows
  - "**What would a human do?**" → decompose into discrete **skills** (is it clear? relevant? eligible?
    in-window?). Each becomes an explicit LLM/tool step (easier to evaluate than one giant prompt).
  - **Tasks as state machines**; single agent (they **avoided multi-agent**).
  - **Planner → chain → steps**, each emitting **events** ("I decided X", "I classified as Y") and
    **operations** ("call tool Y", "hand off to Z"). → *These events ARE the admin reasoning log.*
  - **Guardrails/consistency checks before operations are acted on.** → "holding the line."
  - Let the durable-execution layer handle retries so skill code stays clean.
- **Resilient agentic systems** — https://blog.gradient-labs.ai/p/building-resilient-agentic-systems
  - Don't retry the **whole** chain on one failed LLM call — **checkpoint per step** (they use Temporal).
  - **Provider/model failover** with an ordered preference list; fail over on 5xx, rate limits, p99 latency.
  - Failure taxonomy incl. **"successful but invalid response"** (model didn't return its verdict inside
    `<decision>...</decision>` tags) vs error vs rate-limit vs latency. → *Demoable retry case in 10s.*
  - They **rolled their own** orchestration (no LangGraph) for control → validates **raw function calling**.

---

## 3. Canonical agent design: Anthropic

- **Building Effective Agents** — https://www.anthropic.com/research/building-effective-agents
  - **Workflow vs Agent:** workflows = LLM/tools on predefined code paths (predictable); agents = LLM
    dynamically directs its own tool use (flexible). *Our refund flow is a hybrid: agentic loop with
    workflow-style gates.*
  - **Agent = an LLM using tools in a loop on environmental feedback.** Add **stopping conditions**
    (max iterations) for control.
  - Uses **refund requests** as the canonical customer-support example: "Actions such as **issuing refunds**
    or updating tickets can be handled programmatically"; routing "general questions, **refund requests**,
    technical support."
  - **Guardrails via sectioning:** one model responds while another screens — better than one model doing
    both.
  - **3 core principles:** (1) **simplicity**, (2) **transparency** (show the agent's planning steps =
    reasoning logs), (3) careful **agent-computer interface (ACI)** — tool docs + testing.
  - "Start with LLM APIs directly; many patterns are a few lines of code." Frameworks add debugging-hostile
    abstraction.
- **Writing tools for agents / ACI** — https://www.anthropic.com/engineering/writing-tools-for-agents
  - Invest in tools as much as prompts. **Poka-yoke** tool signatures (make misuse impossible), great
    docstrings ("for a junior dev"), example usage + edge cases, simple agentic `while`-loops.

---

## 4. "Holding the line": guardrails / policy enforcement

- **AI Agent Guardrails: Rules LLMs Cannot Bypass** —
  https://dev.to/aws/ai-agent-guardrails-rules-that-llms-cannot-bypass-596d
  (code: https://github.com/aws-samples/sample-why-agents-fail)
  - **Core thesis: prompts are suggestions, not constraints.** Agents *hallucinate operation success* even
    when violating business rules (confirm booking without payment; 15 guests when max is 10; skip required
    validation). The model "read the docstring and ignored it."
  - **3 hallucination patterns:** parameter errors, completeness errors, tool-bypass behavior.
  - **Fix = neurosymbolic guardrail:** deterministic **rules enforced in code BEFORE the tool executes**
    (a `BeforeToolCall` hook that can `cancel_tool`). Rules are plain, testable Python functions; violations
    are **explicit, loggable events**. → *For us: a `policy_check()` gate in front of `issue_refund()`. The
    LLM cannot override it. This is the architecture that actually "holds the line."*
  - Layered defense: symbolic guardrails (tool level) + multi-agent validation (Executor→Validator→Critic)
    for reasoning-level hallucinations (likely overkill for a 7-day slice; mention as future work).
  - Academic backing: **ATA: Autonomous Trustworthy Agents (2024)**, arXiv:2510.16381.
- **OpenAI — A Practical Guide to Building Agents** *(listed, not deep-read)* —
  https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
  Covers model selection, tool design, **layered guardrails** (input/output, relevance, safety), and when to
  go multi-agent. Worth a skim before finalizing architecture.

---

## 5. Voice pipeline (the bonus)

- **LiveKit — Why not to build voice directly on model APIs** —
  https://livekit.com/blog/real-time-voice-agents-vs-model-apis
  - The model API gives you **the brain only**. You still own: **WebRTC transport** (UDP > WebSocket/TCP for
    live audio), **echo cancellation (AEC)**, **turn detection / interruption** (hardest problem; VAD isn't
    enough), **client SDKs**, **session scaling**.
  - **Going direct is fine for a single-user/single-session demo** — which is exactly the assessment. For a
    natural-feeling demo fast, a framework (LiveKit/Pipecat) gives turn-taking + echo cancellation out of the
    box and is **model-agnostic** (swap STT/LLM/TTS by config).
- Stack options (from search synthesis):
  - **OpenAI Realtime API** — speech-to-speech, lowest-effort, ~500ms; simplest single-session demo.
  - **LiveKit Agents** — STT→LLM→TTS pipeline, best UX/turn-taking, provider-swappable; quickstart in ~1hr.
  - **ElevenLabs** — best TTS voices / conversational AI.
  - **Vapi** — most plug-and-play managed.
  - Recommendation for this assessment: **OpenAI Realtime for the fastest credible voice demo**, or LiveKit
    if we want noticeably better turn-taking. Keep the *same agent/tools* behind whichever we pick.

---

## 6. Reasoning logs / observability

- Options: **Langfuse** (open-source, self-hostable, OTel) · **LangSmith** (LangChain-native) · **MLflow** ·
  **Laminar**. (https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse)
- For the **admin dashboard** requirement: **roll our own event stream** (matches Gradient Labs' events
  pattern, gives full UI control, nothing to explain away) and *optionally* also pipe traces to Langfuse to
  show "real" observability tooling. Stream events to the UI via **SSE or WebSocket**.

---

## 7. Synthesis → design implications for our build

| Requirement (from brief) | Source | Design decision |
|---|---|---|
| Agent loop + dynamic tool calls | Anthropic, Gradient Labs | Raw function-calling `while` loop with stopping condition |
| Strict policy document | Gradient Labs, τ-bench | `refund_policy.md` as SOP; agent reasons against it |
| Validate policy rules via tools | τ-bench, Anthropic ACI | Discrete tools = skills (lookup, get_order, check_window, check_category, issue_refund, escalate) |
| **"Holding the line"** (deny violations) | **Guardrails/AWS, τ-bench** | **Deterministic `policy_check()` gate before `issue_refund()`** — not just a prompt instruction |
| Real-time reasoning logs (admin) | Gradient Labs, observability | Emit structured **events/operations**, stream via SSE/WebSocket to admin UI |
| Failures / retries in logs | Gradient Labs (resilience) | `<decision>` tag parse-fail → retry; model fallback; show in log |
| Reliability (do it right every time) | τ-bench `pass^k` | Guardrail + tight tools + tests asserting **DB state** |
| Voice (bonus) | LiveKit, τ-voice | OpenAI Realtime (fast) or LiveKit (better UX), same agent behind it |

**One-line architecture:** a single agent in a raw function-calling loop, reasoning against a plain-English
refund policy, calling discrete CRM/policy tools, with a **deterministic guardrail that vetoes any
out-of-policy refund**, every step emitted as an event to a live admin reasoning panel, with parse-fail
retries + model fallback for resilience — optionally fronted by a voice pipeline.
