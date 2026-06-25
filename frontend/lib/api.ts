// Tiny API client for the refund-agent backend.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export type Decision = "APPROVE" | "DENY" | "ESCALATE" | "APPROVE_PARTIAL" | null;

export interface AgentEvent {
  id: string;
  session_id: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  ts: number;
}

export interface ChatResponse {
  session_id: string;
  reply: string;
  decision: Decision;
  refund: Record<string, unknown> | null;
}

export async function sendChat(
  sessionId: string,
  message: string,
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, message }),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  return res.json();
}

export interface Approval {
  id: string;
  order_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  status: string;
  created_at: string;
}

export async function getApprovals(status = "pending"): Promise<Approval[]> {
  const res = await fetch(`${API_BASE}/api/admin/approvals?status=${status}`);
  if (!res.ok) return [];
  return (await res.json()).approvals as Approval[];
}

export async function resolveApproval(
  approvalId: string,
  decision: "approve" | "deny",
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_id: approvalId, decision }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `approve failed: ${res.status}`);
  }
}

export async function armChaos(kind: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/chaos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  // Throw on a failed arm so the admin UI doesn't show a false "chaos armed" banner.
  if (!res.ok) throw new Error(`chaos arm failed: ${res.status}`);
}

export async function getHealth(): Promise<{
  agent_model: string;
  fallback_model: string;
  langsmith_enabled?: boolean;
  langsmith_url?: string;
}> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`health failed: ${res.status}`);
  return res.json();
}

export async function getVoiceStatus(): Promise<{
  enabled: boolean;
  tts_model: string;
  stt_model: string;
}> {
  const res = await fetch(`${API_BASE}/api/voice/status`);
  if (!res.ok) throw new Error(`voice status failed: ${res.status}`);
  return res.json();
}

// Send recorded mic audio → transcript (push-to-talk speech-to-text).
export async function transcribe(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "speech.webm");
  const res = await fetch(`${API_BASE}/api/voice/stt`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`stt failed: ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return typeof data.text === "string" ? data.text : "";
}

// Text → spoken audio, played progressively as it streams from the backend.
// Uses MediaSource (plays while still downloading → lower latency); falls back to a full blob
// when MSE / mp3-in-MSE isn't supported. Returns a ready <audio> element, a cleanup fn, and an
// abort fn that cancels the in-flight network request + stream reader + revokes the object URL.
const TTS_MIME = "audio/mpeg";

export async function streamTts(
  text: string,
): Promise<{ audio: HTMLAudioElement; cleanup: () => void; abort: () => void }> {
  // One AbortController governs both the fetch and the MSE read loop. Aborting it stops
  // the network download immediately rather than letting it drain in the background.
  const controller = new AbortController();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch (err) {
    // If we aborted before the response headers arrived, surface as a clean throw.
    if (controller.signal.aborted) throw new DOMException("TTS aborted", "AbortError");
    throw err;
  }
  if (!res.ok) throw new Error(`tts failed: ${res.status}`);

  const audio = new Audio();
  const canStream =
    !!res.body &&
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(TTS_MIME);

  if (canStream) {
    const mediaSource = new MediaSource();
    const objUrl = URL.createObjectURL(mediaSource);
    // Track whether the URL has already been revoked so cleanup is idempotent.
    let urlRevoked = false;
    const revokeOnce = () => {
      if (!urlRevoked) {
        urlRevoked = true;
        URL.revokeObjectURL(objUrl);
      }
    };

    audio.src = objUrl;

    mediaSource.addEventListener("sourceopen", () => {
      let sb: SourceBuffer;
      try {
        sb = mediaSource.addSourceBuffer(TTS_MIME);
      } catch {
        // MSE setup failed (codec rejection etc.) — nothing to read.
        return;
      }

      const reader = res.body!.getReader();

      const endStream = () => {
        try {
          if (mediaSource.readyState === "open") mediaSource.endOfStream();
        } catch {
          /* already ended or closed */
        }
      };

      // Cancel the reader and close the MediaSource cleanly (no uncaught rejection).
      const abortReader = () => {
        reader.cancel().catch(() => {});
        // endOfStream closes the source; if already closed this is a no-op via try/catch.
        endStream();
      };

      // If abort fires while the sourceopen handler is running, stop immediately.
      if (controller.signal.aborted) {
        abortReader();
        return;
      }
      controller.signal.addEventListener("abort", abortReader, { once: true });

      // Read one chunk, append, and wait for `updateend` before the next — SourceBuffer
      // appends must serialize (attempting a second append while `updating` throws InvalidStateError).
      const readNext = () => {
        // Don't attempt further reads after an abort.
        if (controller.signal.aborted) return;
        reader
          .read()
          .then(({ value, done }) => {
            if (controller.signal.aborted) return; // abort raced with a completed read
            if (done) {
              // If a previous append is still in progress, endOfStream will be called from
              // the updateend listener below once it finishes.
              if (!sb.updating) endStream();
              return;
            }
            try {
              sb.appendBuffer(value);
            } catch {
              // QuotaExceededError or InvalidStateError (buffer closed): stop cleanly.
              endStream();
            }
          })
          .catch((err: unknown) => {
            // AbortError from reader.cancel() is expected — swallow it silently.
            if (err instanceof DOMException && err.name === "AbortError") return;
            // Any other read error: end the stream so the browser doesn't stall.
            endStream();
          });
      };

      sb.addEventListener("updateend", () => {
        // After each append completes, either kick off the next read or — if the stream
        // was already done but we were updating — close the MediaSource now.
        if (controller.signal.aborted) return;
        readNext();
      });

      readNext();
    });

    // cleanup() and abort() are kept separate so page.tsx can store `cleanup` and call it
    // from stopAudio without needing to know about the AbortController. Calling either one
    // is safe to call multiple times (idempotent via revokeOnce + AbortController semantics).
    const abort = () => {
      controller.abort();
      revokeOnce();
    };
    return { audio, cleanup: revokeOnce, abort };
  }

  // Fallback: download the whole clip, then play.
  // The AbortController is wired to the fetch above, so aborting mid-download cancels it.
  let fallbackUrlRevoked = false;
  let fallbackUrl = "";
  try {
    fallbackUrl = URL.createObjectURL(await res.blob());
  } catch (err) {
    if (controller.signal.aborted) throw new DOMException("TTS aborted", "AbortError");
    throw err;
  }
  audio.src = fallbackUrl;
  const revokeOnce = () => {
    if (!fallbackUrlRevoked) {
      fallbackUrlRevoked = true;
      URL.revokeObjectURL(fallbackUrl);
    }
  };
  const abort = () => {
    controller.abort();
    revokeOnce();
  };
  return { audio, cleanup: revokeOnce, abort };
}

export async function getCRM(): Promise<{
  customers: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  refunds: Record<string, unknown>[];
}> {
  const res = await fetch(`${API_BASE}/api/crm`);
  if (!res.ok) throw new Error(`crm failed: ${res.status}`);
  return res.json();
}
