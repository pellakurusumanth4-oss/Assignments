# Architecture Diagrams

Three views of the system, from narrow to wide:

1. **[Agent pipeline](#1-agent-pipeline)** — how one refund decision is made (the reasoning loop + the deterministic guard).
2. **[Voice pipeline](#2-voice-pipeline)** — the push-to-talk speech layer wrapped around the *same* agent.
3. **[Combined system](#3-combined-system)** — frontend, backend, agent, data, external services, and observability together.

> Diagrams are [Mermaid](https://mermaid.js.org/) and render automatically on GitHub. Source is inline so they stay in sync with the code.

---

## 1. Agent pipeline

One customer turn through `create_agent` (LangChain ReAct loop). The thing that makes refunds *trustworthy* is that the **deterministic policy guard runs in `wrap_tool_call` middleware before `issue_refund` can write** — the LLM cannot talk past it ("holding the line").

```mermaid
flowchart TB
    USER(["Customer message"]) --> RUN["run_agent() — agent.py<br/>astream the compiled graph"]
    RUN --> GRAPH["create_agent — LangChain ReAct loop"]

    GRAPH --> INJ["InjectionDetectionMiddleware<br/>before_model: flag jailbreak attempts"]
    INJ --> MODEL["Claude model<br/>init_chat_model via TokenRouter"]
    MODEL -. "wrap_model_call: failover + malformed-verdict retry" .-> RES["ResilienceMiddleware"]

    MODEL -->|"reasons, then calls tools"| TOOLS

    subgraph TOOLS["Tools — tools.py"]
        direction TB
        READ["Read-only facts:<br/>lookup_customer, get_order, check_return_window,<br/>check_category_eligibility, check_refund_history"]
        REFUND["issue_refund — the only side effect"]
        ESC["escalate_to_human — human-in-the-loop"]
    end

    REFUND --> GUARD{"PolicyGuardrailMiddleware<br/>wrap_tool_call"}
    GUARD -->|"guardrail.evaluate()"| VLOGIC["Deterministic verdict<br/>guardrail.py mirrors refund_policy.md"]
    VLOGIC -->|allowed| WRITE[("record_refund<br/>PostgreSQL · refunds")]
    VLOGIC -->|"out of policy"| HOLD["Blocked ToolMessage<br/>★ HOLD THE LINE"]
    ESC -->|"guard: refuse if hard-DENY"| APPROVAL[("create_approval<br/>PostgreSQL · approvals")]

    TOOLS --> MODEL
    MODEL --> FINAL["Final reply + decision tag"]
    FINAL --> STATEV["Verdict derived from STATE<br/>refund recorded / blocked / escalated"]
    STATEV --> OUT(["reply + decision → /api/chat"])

    GRAPH -. "astream events" .-> SSE[["SSE event bus → admin reasoning log"]]
    GUARD -. "guardrail_block" .-> SSE
    RES -. "failover / retry" .-> SSE
    GRAPH -. "auto-instrumented" .-> LS[["LangSmith traces"]]
```

**Key points**
- **Hold the line:** `guardrail.evaluate()` (plain, testable Python) is the authority. An out-of-policy `issue_refund` is vetoed *before* it writes; the escalation path is guarded the same way so a non-refundable item can't sneak into the approval queue.
- **Resilience is visible:** `ResilienceMiddleware` fails over to a backup model and retries a malformed verdict, emitting events to the reasoning log — the failure the agent recovers from on camera.
- **Verdict from state, not chat text:** the decision comes from what actually happened (a refund row written / a guard block / an escalation), τ-bench style.

---

## 2. Voice pipeline

A push-to-talk speech layer (ElevenLabs) over the **same** `/api/chat` agent — voice is pure I/O, so policy enforcement and the reasoning log are unchanged on the voice channel.

```mermaid
flowchart LR
    MIC["🎙️ Mic<br/>MediaRecorder"] -->|"webm clip"| STT["POST /api/voice/stt"]
    STT -->|"ElevenLabs scribe_v2 · retry on transient 429/5xx"| TXT["Transcript"]
    TXT --> CHAT["POST /api/chat<br/>(the agent loop — §1)"]
    CHAT -->|"reply text"| SPK["speakable()<br/>strip markdown + decision tag"]
    SPK --> TTS["POST /api/voice/tts — streamed"]
    TTS -->|"ElevenLabs eleven_flash_v2_5 · streamed chunk-by-chunk"| MSE["🔊 MediaSource<br/>progressive playback"]
    MSE -. "stopAudio() → AbortController" .-> TTS
```

**Key points**
- **Low latency:** TTS uses the ElevenLabs *streaming* endpoint behind a FastAPI `StreamingResponse`; the browser plays audio via `MediaSource` while it's still downloading.
- **Abortable:** stopping playback aborts the in-flight fetch + stream reader (no orphaned background download).
- **Same guarantees:** the transcript goes through the normal agent, so the guardrail and the live reasoning log apply to spoken requests too.

---

## 3. Combined system

```mermaid
flowchart TB
    subgraph CLIENT["Frontend — Next.js"]
        CHATUI["Customer chat<br/>page.tsx (+ voice mic)"]
        ADMINUI["Admin dashboard<br/>live reasoning log + approvals"]
    end

    subgraph BACK["Backend — FastAPI (server/)"]
        CHATEP["/api/chat"]
        VOICEEP["/api/voice/stt · /tts · /status"]
        EVENTSEP["/api/events — SSE"]
        ADMINEP["/api/admin/* — chaos, approvals, approve"]
        BUS["events.py<br/>in-process pub/sub bus"]
    end

    subgraph CORE["Agent — refund_agent/"]
        GRAPH["create_agent + middleware"]
        TOOLSB["tools.py"]
        GUARDB["guardrail.py + refund_policy.md"]
    end

    DB[("PostgreSQL<br/>customers · orders · refunds · approvals")]
    ANTH["Claude via TokenRouter"]
    ELEVEN["ElevenLabs<br/>scribe_v2 · eleven_flash_v2_5"]
    LS["LangSmith<br/>traces &amp; evals"]

    CHATUI -->|"POST message"| CHATEP
    CHATUI <-->|"mic / playback"| VOICEEP
    ADMINUI -->|"subscribe (EventSource)"| EVENTSEP
    ADMINUI -->|"arm chaos / approve refund"| ADMINEP

    CHATEP --> GRAPH
    VOICEEP --> ELEVEN
    VOICEEP -. "transcript → reply" .-> CHATEP
    GRAPH --> TOOLSB --> GUARDB --> DB
    GRAPH -->|"model calls"| ANTH
    ADMINEP -->|"HITL approve re-checks guard"| DB

    GRAPH -. "astream" .-> BUS
    GUARDB -. "guardrail_block" .-> BUS
    BUS --> EVENTSEP
    GRAPH -. "auto-instrumented" .-> LS
    ADMINUI -. "deep link ↗" .-> LS
```

**Key points**
- **Two surfaces, one agent:** the customer chat and the admin dashboard both talk to the same FastAPI backend; the dashboard subscribes to the SSE bus for the live reasoning log.
- **Observability is built-in, not bolted on:** every step streams to the in-app bus *and* (zero extra code) to LangSmith via env vars.
- **Defense in depth:** the deterministic guard runs in the agent loop **and** is re-checked when a human approves an escalation — an operator click still can't force through a hard-denied refund.

---

*Components referenced: `refund_agent/{agent,utils/{tools,middleware,guardrail,policy,store,db}}.py`, `server/{main,events,voice,models}.py`, `frontend/{app,lib}`. The policy SOP lives in `policy/refund_policy.md`.*
