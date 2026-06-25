"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  sendChat,
  getVoiceStatus,
  transcribe,
  streamTts,
  type Decision,
} from "@/lib/api";
import ReactMarkdown from "react-markdown";
import { decisionBadge } from "@/lib/ui";

interface Msg {
  role: "user" | "agent";
  text: string;
  decision?: Decision;
  error?: boolean;
}

const SAMPLES = [
  "Hi, I'd like a refund for order ord_1001 — my email is alice.nguyen@example.com",
  "I want to return order ord_1002, it's been in my closet a while.",
  "Please refund my final-sale jacket, order ord_1003.",
  "I need a refund for my gaming laptop, order ord_1005.",
];

// Persist the chat per browser tab so navigating to /admin and back doesn't wipe it. sessionStorage
// (not localStorage) is intentional: it's scoped to the tab and clears when the tab closes — right
// for a demo, and it keeps the same session_id so the admin reasoning stream stays correlated.
const SID_KEY = "acme-refund:session-id";
const MSGS_KEY = "acme-refund:messages";

export default function ChatPage() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Holds streamTts's `abort` — cancels the in-flight TTS fetch + stream reader and revokes the
  // object URL (subsumes `cleanup`), so stopping playback also stops the background download.
  const audioAbortRef = useRef<(() => void) | null>(null);
  // Bumped on every speak()/stopAudio() so a TTS request that resolves AFTER the user moved on
  // (navigated, recorded again, etc.) can detect it's stale and abort instead of playing.
  const speakGenRef = useRef(0);

  // Restore (or create) this tab's session id + chat history on mount. Effects don't run during
  // SSR, so reading sessionStorage here causes no hydration mismatch.
  useEffect(() => {
    let sid = sessionStorage.getItem(SID_KEY);
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem(SID_KEY, sid);
    }
    setSessionId(sid);
    const saved = sessionStorage.getItem(MSGS_KEY);
    if (saved) {
      try {
        setMessages(JSON.parse(saved) as Msg[]);
      } catch {
        /* corrupt cache — start fresh */
      }
    }
  }, []);

  // Persist chat history whenever it changes. The length guard skips the empty initial render so a
  // restore-in-progress is never clobbered (this effect can fire before the mount effect above has
  // applied its setMessages).
  useEffect(() => {
    if (messages.length > 0) sessionStorage.setItem(MSGS_KEY, JSON.stringify(messages));
  }, [messages]);
  useEffect(() => {
    getVoiceStatus()
      .then((s) => setVoiceEnabled(s.enabled))
      .catch(() => setVoiceEnabled(false));
  }, []);
  useEffect(
    () => endRef.current?.scrollIntoView({ behavior: "smooth" }),
    [messages, busy],
  );

  // Release the previous spoken-reply audio + its MediaSource/object URL before reusing.
  const stopAudio = useCallback(() => {
    speakGenRef.current++; // invalidate any speak() currently awaiting streamTts
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (audioAbortRef.current) {
      audioAbortRef.current();
      audioAbortRef.current = null;
    }
    setSpeaking(false);
  }, []);

  // Clean up any in-flight recording / playback when the page unmounts.
  useEffect(() => {
    return () => {
      stopAudio();
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      rec?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, [stopAudio]);

  const speak = useCallback(
    async (text: string) => {
      stopAudio();
      const gen = ++speakGenRef.current; // claim this generation
      try {
        setSpeaking(true);
        const { audio, abort } = await streamTts(text);
        // If stopAudio()/another speak() ran while we awaited, this audio is stale — drop it and
        // cancel its (already-streaming) request instead of playing over the user.
        if (gen !== speakGenRef.current) {
          abort();
          return;
        }
        audioRef.current = audio;
        audioAbortRef.current = abort;
        audio.onended = stopAudio;
        audio.onerror = stopAudio;
        await audio.play();
      } catch {
        if (gen === speakGenRef.current) stopAudio();
      }
    },
    [stopAudio],
  );

  const submit = useCallback(
    async (text: string, withVoice = false) => {
      if (!text.trim() || busy || recording || !sessionId) return;
      setInput("");
      setMessages((m) => [...m, { role: "user", text }]);
      setBusy(true);
      try {
        const res = await sendChat(sessionId, text);
        setMessages((m) => [
          ...m,
          { role: "agent", text: res.reply, decision: res.decision },
        ]);
        if (withVoice && res.reply.trim()) speak(res.reply);
      } catch {
        setMessages((m) => [
          ...m,
          {
            role: "agent",
            text: "Sorry — I couldn't reach the agent. Is the backend running?",
            error: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, recording, sessionId, speak],
  );

  const toggleRecording = useCallback(async () => {
    // Stop an in-progress recording; onstop handles the rest.
    if (recording) {
      const rec = recorderRef.current;
      if (rec && rec.state === "recording") rec.stop();
      return;
    }
    if (busy) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceError("Voice recording isn't supported in this browser.");
      return;
    }
    // Cut off any reply currently being spoken before listening.
    stopAudio();
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setBusy(true);
        let transcript = "";
        try {
          transcript = await transcribe(blob);
        } catch {
          setMessages((m) => [
            ...m,
            {
              role: "agent",
              text: "Sorry — I couldn't transcribe that. Please try again or type your message.",
              error: true,
            },
          ]);
        } finally {
          setBusy(false);
        }
        if (transcript.trim()) submit(transcript, true);
        else setVoiceError("I didn't catch that — please try again.");
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // Permission denied or no device available.
      setVoiceError(
        "Microphone access was denied or no microphone is available.",
      );
    }
  }, [recording, busy, stopAudio, submit]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6">
      <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/60">
        {/* Chat header */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
          <span className="relative grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-lg text-white shadow-sm">
            🤖
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-slate-900">ACME Support</p>
            {speaking ? (
              <p className="flex items-center gap-1 text-xs font-medium text-sky-600">
                <span aria-hidden="true">🔊</span> Speaking…
              </p>
            ) : recording ? (
              <p className="flex items-center gap-1 text-xs font-medium text-red-500">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />{" "}
                Listening…
              </p>
            ) : (
              <p className="text-xs text-emerald-600">● Online · usually replies instantly</p>
            )}
          </div>
          <a
            href="/admin"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto rounded-md px-2 py-1 text-xs font-medium text-sky-600 hover:bg-sky-50 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          >
            View reasoning ↗
          </a>
        </div>

        {/* Messages */}
        <div
          className="flex-1 space-y-4 overflow-y-auto bg-slate-50/60 p-4"
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-slate-600">
                Hi! I can help with refunds. 👋
              </p>
              <p className="mb-4 text-xs text-slate-400">Try one of these:</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SAMPLES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    disabled={busy}
                    className="group rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-xs text-slate-600 shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:text-slate-900 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex animate-rise items-end gap-2 ${
                m.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {m.role === "agent" && (
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm ${
                    m.error ? "bg-red-100" : "bg-gradient-to-br from-sky-500 to-indigo-600 text-white"
                  }`}
                  aria-hidden="true"
                >
                  {m.error ? "⚠️" : "🤖"}
                </span>
              )}
              <div
                className={
                  m.role === "user"
                    ? "max-w-[78%] rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-sm text-white shadow-sm"
                    : m.error
                      ? "max-w-[78%] rounded-2xl rounded-bl-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"
                      : "max-w-[78%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 shadow-sm"
                }
              >
                {m.role === "agent" && !m.error ? (
                  <div className="space-y-1 text-sm leading-relaxed [&_a]:text-sky-600 [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:text-[13px] [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
                    <ReactMarkdown>{m.text}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                )}
                {m.role === "agent" && m.decision && (
                  <span
                    className={`mt-2 inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                      decisionBadge(m.decision).cls
                    }`}
                  >
                    {decisionBadge(m.decision).text}
                  </span>
                )}
              </div>
              {m.role === "user" && (
                <span
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-200 text-sm"
                  aria-hidden="true"
                >
                  🧑
                </span>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex animate-rise items-end gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-sm text-white" aria-hidden="true">
                🤖
              </span>
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <span className="typing-dot h-2 w-2 rounded-full bg-slate-400" />
                <span className="typing-dot h-2 w-2 rounded-full bg-slate-400" style={{ animationDelay: "0.2s" }} />
                <span className="typing-dot h-2 w-2 rounded-full bg-slate-400" style={{ animationDelay: "0.4s" }} />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-slate-100 bg-white p-3">
          {voiceError && (
            <p
              role="status"
              className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700"
            >
              {voiceError}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex items-center gap-2 rounded-full border border-slate-300 bg-white px-2 py-1 shadow-sm focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100"
          >
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <input
              id="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={recording}
              placeholder={
                recording ? "Listening… tap the mic to stop" : "Type your message…"
              }
              className="flex-1 bg-transparent px-3 py-2 text-sm outline-none disabled:text-slate-400"
            />
            {voiceEnabled && (
              <button
                type="button"
                onClick={toggleRecording}
                disabled={busy && !recording}
                aria-pressed={recording}
                aria-label={
                  recording
                    ? "Stop recording"
                    : speaking
                      ? "Speaking reply"
                      : "Start voice recording"
                }
                title={recording ? "Stop recording" : "Push to talk: speak your request"}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm text-white transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                  recording
                    ? "animate-pulse bg-red-600 hover:bg-red-700"
                    : "bg-slate-700 hover:bg-slate-800"
                }`}
              >
                <span aria-hidden="true">{recording ? "■" : speaking ? "🔊" : "🎤"}</span>
              </button>
            )}
            <button
              type="submit"
              disabled={busy || recording || !input.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sky-600 text-white transition hover:bg-sky-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send message"
            >
              <span aria-hidden="true">➤</span>
            </button>
          </form>
          {voiceEnabled && (
            <p className="mt-2 text-center text-[11px] text-slate-400">
              🎤 Voice enabled — tap the mic to speak; the agent replies out loud.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
