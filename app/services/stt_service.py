"""Live speech-to-text via Groq Whisper.

The browser captures + cleans the mic audio and gates it with a local VAD, then
POSTs short spoken-command clips to `/stt`, which calls this service. Whisper the
model is open-source; Groq just hosts it cheaply (turbo ≈ $0.04 / hour of audio),
and the compute runs on Groq's infra, so this adds no transcription load to the
Space and scales for many users.

Multi-key rotation mirrors the Groq chat pattern: on a 429 / rate-limit, rotate to
the next `GROQ_API_KEY*`; if every key is exhausted, raise `STTQuotaError` so the
frontend falls back to the browser's Web Speech engine.
"""

import io
import logging

from config import GROQ_API_KEYS, GROQ_STT_MODEL

logger = logging.getLogger(__name__)


class STTQuotaError(Exception):
    """All Groq keys are rate-limited (HTTP 429) for speech-to-text.
    Signals the caller to fall back to Web Speech."""


class STTUnavailableError(Exception):
    """No Groq key configured, or transcription failed for a non-quota reason."""


def _is_rate_limit(exc: Exception) -> bool:
    s = str(exc).lower()
    return (
        "429" in s
        or "rate limit" in s
        or "rate_limit" in s
        or "too many requests" in s
        or "quota" in s
    )


def transcribe(audio_bytes: bytes, filename: str = "audio.wav", language: str | None = None) -> dict:
    """Transcribe a short audio clip. Returns {"text": str, "language": str|None}.

    Raises STTQuotaError if all keys are rate-limited, STTUnavailableError otherwise.
    """
    if not GROQ_API_KEYS:
        raise STTUnavailableError("GROQ_API_KEY not set")
    if not audio_bytes:
        raise STTUnavailableError("empty audio")

    from groq import Groq

    last_err = None
    quota_hit = False
    for idx, key in enumerate(GROQ_API_KEYS):
        try:
            client = Groq(api_key=key)
            kwargs = {
                "model": GROQ_STT_MODEL,
                # (filename, fileobj) tuple so the SDK sends a proper multipart upload.
                "file": (filename, io.BytesIO(audio_bytes)),
                "response_format": "verbose_json",  # gives detected language
            }
            if language:
                kwargs["language"] = language
            result = client.audio.transcriptions.create(**kwargs)
            text = (getattr(result, "text", None) or "").strip()
            lang = getattr(result, "language", None)
            return {"text": text, "language": lang}
        except Exception as e:  # noqa: BLE001 — classify then re-raise as typed errors
            last_err = e
            if _is_rate_limit(e):
                quota_hit = True
                logger.warning("[STT] Groq key #%d rate-limited — rotating", idx + 1)
                continue
            logger.warning("[STT] Groq key #%d failed: %s", idx + 1, e)
            continue

    if quota_hit:
        raise STTQuotaError("All Groq keys are rate-limited for speech-to-text")
    raise STTUnavailableError(f"Speech-to-text failed: {last_err}")
