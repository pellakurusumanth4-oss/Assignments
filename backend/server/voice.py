"""Voice I/O pipeline (ElevenLabs) — a push-to-talk layer over the SAME agent.

Pipeline (voice is pure I/O; policy enforcement is unchanged on the voice channel):

    🎙 mic (MediaRecorder)
      → POST /api/voice/stt   (ElevenLabs Scribe → transcript)
      → POST /api/chat        (the normal agent loop: guardrail + reasoning log intact)
      → POST /api/voice/tts   (ElevenLabs Flash, **streamed**)
      → 🔊 progressive playback in the browser (MediaSource)

Models (chosen for a real-time agent):
- TTS: eleven_flash_v2_5  — ~75ms latency, 32 languages. Served via the *streaming* endpoint so
  audio is proxied to the browser as it's generated (low time-to-first-audio).
- STT: scribe_v2          — ElevenLabs' most accurate transcription model.

Note on numbers: Flash v2.5 has number/currency normalization off by default, so spoken replies read
amounts naturally ("129 dollars and 99 cents"). The reply text is cleaned for speech (markdown and the
<decision> tag stripped) before TTS.

HTTP client: a single module-level ``httpx.AsyncClient`` is opened in the FastAPI lifespan
(``server.main``) and reused for every STT/TTS call. This avoids per-request connection setup and —
critically — guarantees the client is always closed exactly once (no leak on client disconnect,
cancellation, or mid-stream exceptions, which the old manual ``__aenter__``/``__aexit__`` dance could
drop).
"""

from __future__ import annotations

import asyncio
import os
import re
from contextlib import AbstractAsyncContextManager

import httpx
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

ELEVEN_BASE = "https://api.elevenlabs.io/v1"
TTS_MODEL = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")
STT_MODEL = os.getenv("ELEVENLABS_STT_MODEL", "scribe_v2")
# Default voice "Sarah" (mature, reassuring, confident) — fitting for a support agent.
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

# Resilience knobs.
# Split timeouts: a short connect, a generous read (streaming TTS trickles bytes for the length of the
# clip, so a flat read timeout would abort long replies), and no overall cap (`timeout=None` on the
# whole pool) so a slow-but-progressing stream isn't killed.
_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
_MAX_RETRIES = 2  # total attempts = 1 + _MAX_RETRIES, only for transient 429/5xx
_RETRY_BACKOFF = 0.5  # seconds, doubled each attempt

# Upload guardrails for STT.
_MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB — ElevenLabs' own per-request ceiling
_ALLOWED_AUDIO_PREFIXES = ("audio/", "video/")  # browsers tag webm/ogg/mp4 captures variously
_ALLOWED_AUDIO_TYPES = {"application/octet-stream"}  # some browsers omit a precise type

# Cap the text handed to TTS. Refund replies are short; an unbounded body would be a slow, costly
# synth (and a trivially abusable endpoint). 5k chars is far above any real reply.
_MAX_TTS_CHARS = 5000

router = APIRouter(prefix="/api/voice", tags=["voice"])

# Shared client, set by the FastAPI lifespan in server.main. Kept module-level so handlers reuse one
# connection pool instead of opening/closing a client per request.
_client: httpx.AsyncClient | None = None


def set_client(client: httpx.AsyncClient | None) -> None:
    """Install (or clear) the shared AsyncClient. Called from the app lifespan."""
    global _client
    _client = client


def _http() -> httpx.AsyncClient:
    """Return the shared client, lazily creating one if the lifespan hasn't run.

    The lifespan path is the norm; this fallback keeps direct/imported use (and tests) working without
    leaking — a lazily-created client lives for the process, same as the lifespan one.
    """
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT)
    return _client


def _api_key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="Voice disabled: ELEVENLABS_API_KEY not set.")
    return key


def _is_transient(status_code: int) -> bool:
    """429 (rate limit) and 5xx are worth a retry; 4xx auth/validation are not."""
    return status_code == 429 or status_code >= 500


def _proxy_status(upstream: int) -> int:
    """Map an ElevenLabs status onto one to return to the browser.

    Pass auth/permission/rate-limit through verbatim (a 401 must not look like a 502, or the operator
    chases the wrong problem); collapse the rest to 502 Bad Gateway since they're upstream faults.
    """
    if upstream in (401, 403, 404, 422, 429):
        return upstream
    return 502


@router.get("/status")
def voice_status() -> dict:
    """Lets the frontend hide the mic button when voice isn't configured."""
    return {"enabled": bool(os.getenv("ELEVENLABS_API_KEY")), "tts_model": TTS_MODEL, "stt_model": STT_MODEL}


class TTSRequest(BaseModel):
    text: str


def speakable(text: str) -> str:
    """Strip markdown/decoration so the spoken reply sounds natural.

    Defensive against junk that makes for bad (or empty) speech: code fences, inline code, URLs and
    runaway punctuation are removed/normalised, and the result is length-capped. Callers must still
    treat an empty return as "nothing to say" (the /tts handler 422s on it).
    """
    text = text or ""
    text = re.sub(r"<decision>.*?</decision>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)        # fenced code blocks
    text = re.sub(r"`[^`]*`", " ", text)                          # inline code spans
    # Markdown links [label](url) → just the label; bare URLs → dropped (unspeakable).
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[*_`#>]", "", text)                           # markdown emphasis / headings
    text = re.sub(r"^\s*[-•]\s*", "", text, flags=re.MULTILINE)   # bullet markers
    text = re.sub(r"\n{2,}", ". ", text)                          # paragraph breaks → pauses
    text = re.sub(r"([.!?]){2,}", r"\1", text)                    # "!!!" → "!" (no shouted repeats)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > _MAX_TTS_CHARS:
        # Cut at the last sentence/word boundary inside the cap so we don't slice a word mid-sound.
        head = text[:_MAX_TTS_CHARS]
        cut = max(head.rfind(". "), head.rfind("! "), head.rfind("? "), head.rfind(" "))
        text = (head[: cut + 1] if cut > 0 else head).strip()
    return text


@router.post("/stt")
async def speech_to_text(file: UploadFile) -> dict:
    """Transcribe an uploaded audio clip (push-to-talk) to text."""
    key = _api_key()  # fail fast (503) before reading the upload if voice is disabled

    # Validate content-type before reading the body (cheap rejection of obviously-wrong uploads).
    ctype = (file.content_type or "").split(";", 1)[0].strip().lower()
    if ctype and not (ctype.startswith(_ALLOWED_AUDIO_PREFIXES) or ctype in _ALLOWED_AUDIO_TYPES):
        raise HTTPException(status_code=415, detail=f"Unsupported audio content-type: {ctype!r}.")

    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=422, detail="No audio data was uploaded.")
    if len(audio) > _MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too large ({len(audio)} bytes); max is {_MAX_AUDIO_BYTES} bytes.",
        )

    client = _http()
    last_status = 502
    last_body = ""
    for attempt in range(_MAX_RETRIES + 1):
        try:
            resp = await client.post(
                f"{ELEVEN_BASE}/speech-to-text",
                headers={"xi-api-key": key},
                data={"model_id": STT_MODEL},
                files={"file": (file.filename or "audio.webm", audio, file.content_type or "audio/webm")},
                timeout=_TIMEOUT,
            )
        except httpx.TimeoutException as exc:
            last_status, last_body = 504, str(exc)
        except httpx.HTTPError as exc:
            last_status, last_body = 502, str(exc)
        else:
            if resp.status_code == 200:
                return {"text": resp.json().get("text", "")}
            last_status, last_body = resp.status_code, resp.text[:200]
            if not _is_transient(resp.status_code):
                raise HTTPException(status_code=_proxy_status(resp.status_code),
                                    detail=f"STT failed ({resp.status_code}): {last_body}")
        if attempt < _MAX_RETRIES:
            await asyncio.sleep(_RETRY_BACKOFF * (2**attempt))

    raise HTTPException(status_code=_proxy_status(last_status),
                        detail=f"STT failed after retries ({last_status}): {last_body[:200]}")


@router.post("/tts")
async def text_to_speech(req: TTSRequest) -> StreamingResponse:
    """Synthesize speech from text and **stream** the mp3 back as it's generated.

    Uses ElevenLabs' streaming endpoint so audio chunks are proxied to the browser as they arrive
    (lower time-to-first-byte and no full-clip buffering on the server). The frontend plays it
    progressively via MediaSource. `optimize_streaming_latency` trades a little quality for speed.

    Client lifecycle: the shared lifespan client is reused, and the per-request ``stream`` context is
    entered/exited entirely inside ``async with`` blocks — so a client disconnect or mid-stream error
    releases the connection without ever leaking it (the old manual ``__aenter__`` path could leak if
    cancelled between enter and the generator's ``finally``).
    """
    key = _api_key()  # fail fast (503) when voice is disabled
    spoken = speakable(req.text)
    if not spoken:
        raise HTTPException(status_code=422, detail="No speakable text was provided.")

    client = _http()
    url = (
        f"{ELEVEN_BASE}/text-to-speech/{VOICE_ID}/stream"
        "?output_format=mp3_44100_128&optimize_streaming_latency=2"
    )
    headers = {"xi-api-key": key, "Content-Type": "application/json"}
    payload = {"text": spoken, "model_id": TTS_MODEL}

    # Open the upstream stream with a bounded retry on transient failures. We must read the status
    # (and, on error, the body) *before* returning the StreamingResponse, so do the retry loop here
    # and hand the live `aiter_bytes` iterator to the response generator only once we have a 200.
    last_status = 502
    last_body = b""
    for attempt in range(_MAX_RETRIES + 1):
        cm = client.stream("POST", url, headers=headers, json=payload, timeout=_TIMEOUT)
        try:
            resp = await cm.__aenter__()
        except httpx.TimeoutException as exc:
            last_status, last_body = 504, str(exc).encode()
        except httpx.HTTPError as exc:
            last_status, last_body = 502, str(exc).encode()
        else:
            if resp.status_code == 200:
                return StreamingResponse(_audio_chunks(cm, resp), media_type="audio/mpeg")
            # Non-200: drain the error body, close this stream, then decide retry vs. fail.
            try:
                last_body = await resp.aread()
            finally:
                await cm.__aexit__(None, None, None)
            last_status = resp.status_code
            if not _is_transient(resp.status_code):
                raise HTTPException(status_code=_proxy_status(resp.status_code),
                                    detail=f"TTS failed ({resp.status_code}): {last_body[:200]!r}")
        if attempt < _MAX_RETRIES:
            await asyncio.sleep(_RETRY_BACKOFF * (2**attempt))

    raise HTTPException(status_code=_proxy_status(last_status),
                        detail=f"TTS failed after retries ({last_status}): {last_body[:200]!r}")


async def _audio_chunks(
    cm: AbstractAsyncContextManager[httpx.Response],
    resp: httpx.Response,
):
    """Proxy upstream audio bytes to the browser, always releasing the stream.

    The ``finally`` runs on normal completion, on a browser disconnect (the generator is closed →
    ``GeneratorExit``), and on any upstream error — guaranteeing the connection is returned to the
    pool. The shared client itself stays open for reuse and is closed by the app lifespan.

    ``cm.__aexit__`` is always called with no-exception args: the stream connection should be
    returned to the pool unconditionally (a browser disconnect is not an upstream error).
    """
    try:
        async for chunk in resp.aiter_bytes():
            yield chunk
    finally:
        await cm.__aexit__(None, None, None)
