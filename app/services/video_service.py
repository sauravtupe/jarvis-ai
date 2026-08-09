"""Private video hosting — Cloudflare Stream (Workstream A).

Replaces YouTube for syllabus lectures. Three jobs:

1. **Upload** — mint a one-time *direct creator upload* URL so the admin's browser
   sends the file straight to Cloudflare (never through this server, so large
   lectures don't tie up a worker or hit request-size limits).
2. **Private playback** — mint short-lived **signed tokens**. Without a token the
   video is 403, so a leaked URL is useless; lectures play only on our /watch page.
3. **Transcripts** — fetch Cloudflare's auto-generated captions (VTT → plain text)
   for the MCQ / summary / worksheet pipeline, with AssemblyAI as the fallback.

Everything degrades gracefully: when the Cloudflare env vars are unset,
``is_configured()`` is False, endpoints return 503, and existing YouTube lectures
keep working untouched.
"""

import base64
import logging
import re
import time
from typing import Dict, Optional

import requests

from config import (
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_STREAM_API_TOKEN,
    CLOUDFLARE_STREAM_KEY_ID,
    CLOUDFLARE_STREAM_SIGNING_KEY,
    CLOUDFLARE_CUSTOMER_SUBDOMAIN,
    VIDEO_TOKEN_TTL,
)

logger = logging.getLogger("J.A.R.V.I.S")

_API_BASE = "https://api.cloudflare.com/client/v4"
_TIMEOUT = 20


class VideoError(Exception):
    """Validation / API failure carrying an HTTP-friendly status code."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def is_configured() -> bool:
    """True when uploads + playback can work (account + API token present)."""
    return bool(CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN)


def can_sign() -> bool:
    """True when we can mint signed (private) playback tokens locally."""
    return bool(CLOUDFLARE_STREAM_KEY_ID and CLOUDFLARE_STREAM_SIGNING_KEY)


def _require_config() -> None:
    if not is_configured():
        raise VideoError(
            "Private video hosting is not configured on this server. "
            "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN.",
            503,
        )


def _headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {CLOUDFLARE_STREAM_API_TOKEN}"}


def _api(method: str, path: str, **kwargs) -> dict:
    """Call the Cloudflare Stream API and unwrap its {success, result, errors} envelope."""
    _require_config()
    url = f"{_API_BASE}/accounts/{CLOUDFLARE_ACCOUNT_ID}/stream{path}"
    try:
        resp = requests.request(method, url, headers=_headers(), timeout=_TIMEOUT, **kwargs)
    except requests.RequestException as e:
        raise VideoError(f"Could not reach Cloudflare Stream: {e}", 502)
    if resp.status_code in (401, 403):
        raise VideoError("Cloudflare rejected the API token (check its Stream permissions).", 502)
    try:
        data = resp.json()
    except ValueError:
        raise VideoError(f"Cloudflare returned a non-JSON response ({resp.status_code}).", 502)
    if not data.get("success"):
        errs = "; ".join(e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict))
        raise VideoError(f"Cloudflare Stream error: {errs or resp.status_code}", 502)
    return data.get("result") or {}


# ─── Upload ──────────────────────────────────────────────────────────────────

_UID_RE = re.compile(r"^[a-f0-9]{32}$", re.IGNORECASE)


def validate_uid(uid: str) -> str:
    """Cloudflare video UIDs are 32 hex chars. Raises VideoError if malformed."""
    uid = (uid or "").strip()
    if not _UID_RE.match(uid):
        raise VideoError("Not a valid Cloudflare Stream video ID (expected 32 hex characters).", 422)
    return uid.lower()


def create_direct_upload(name: str = "", max_duration_seconds: int = 7200) -> Dict:
    """One-time URL for a browser→Cloudflare upload. Returns {uid, upload_url}.

    `requireSignedURLs` is set so the video is private the moment it exists — there
    is never a window where the raw URL plays without a token.
    """
    body = {
        "maxDurationSeconds": max_duration_seconds,
        "requireSignedURLs": True,
        "creator": "jarvis-ai-teacher",
    }
    if name:
        body["meta"] = {"name": name[:120]}
    result = _api("POST", "/direct_upload", json=body)
    uid, upload_url = result.get("uid"), result.get("uploadURL")
    if not uid or not upload_url:
        raise VideoError("Cloudflare did not return an upload URL.", 502)
    logger.info("[VIDEO] Direct upload created: %s (%s)", uid, name or "untitled")
    return {"uid": uid, "upload_url": upload_url}


def get_video(uid: str) -> Dict:
    """Video metadata: readiness, duration, thumbnail."""
    uid = validate_uid(uid)
    result = _api("GET", f"/{uid}")
    status = (result.get("status") or {})
    return {
        "uid": uid,
        "ready": status.get("state") == "ready",
        "state": status.get("state", "unknown"),
        "pct_complete": status.get("pctComplete"),
        "duration": result.get("duration"),
        "thumbnail": result.get("thumbnail", ""),
        "name": (result.get("meta") or {}).get("name", ""),
        "require_signed_urls": result.get("requireSignedURLs", False),
    }


def delete_video(uid: str) -> None:
    _api("DELETE", f"/{validate_uid(uid)}")
    logger.info("[VIDEO] Deleted %s", uid)


def ensure_private(uid: str) -> None:
    """Force requireSignedURLs on a video (used when adopting an existing UID)."""
    _api("POST", f"/{validate_uid(uid)}", json={"requireSignedURLs": True})


# ─── Signed playback tokens ──────────────────────────────────────────────────

def signed_token(uid: str, ttl: Optional[int] = None) -> str:
    """Mint a short-lived playback token for a private video.

    Signs locally with the RSA key when configured (no network hop — keeps the
    /watch page fast); otherwise asks Cloudflare to mint one.
    """
    uid = validate_uid(uid)
    ttl = ttl or VIDEO_TOKEN_TTL
    exp = int(time.time()) + ttl

    if can_sign():
        try:
            from jose import jwt as _jose_jwt
            # Cloudflare returns the signing key PEM base64-encoded.
            pem = CLOUDFLARE_STREAM_SIGNING_KEY
            try:
                decoded = base64.b64decode(pem, validate=True).decode("utf-8")
                if "PRIVATE KEY" in decoded:
                    pem = decoded
            except Exception:
                pass  # already a raw PEM
            return _jose_jwt.encode(
                {"sub": uid, "kid": CLOUDFLARE_STREAM_KEY_ID, "exp": exp,
                 "nbf": int(time.time()) - 60},
                pem,
                algorithm="RS256",
                headers={"kid": CLOUDFLARE_STREAM_KEY_ID, "alg": "RS256"},
            )
        except VideoError:
            raise
        except Exception as e:
            logger.warning("[VIDEO] Local token signing failed (%s) — falling back to API", e)

    result = _api("POST", f"/{uid}/token", json={"exp": exp})
    token = result.get("token")
    if not token:
        raise VideoError("Cloudflare did not return a playback token.", 502)
    return token


def _subdomain() -> str:
    sub = CLOUDFLARE_CUSTOMER_SUBDOMAIN or ""
    sub = sub.replace("https://", "").replace("http://", "").strip("/")
    return sub or "customer-placeholder.cloudflarestream.com"


def playback(uid: str, ttl: Optional[int] = None) -> Dict:
    """Everything the watch page needs: signed iframe + HLS/DASH URLs, poster."""
    uid = validate_uid(uid)
    token = signed_token(uid, ttl)
    base = f"https://{_subdomain()}/{token}"
    return {
        "uid": uid,
        "token": token,
        "iframe_url": f"https://{_subdomain()}/{token}/iframe",
        "hls_url": f"{base}/manifest/video.m3u8",
        "dash_url": f"{base}/manifest/video.mpd",
        "poster_url": f"{base}/thumbnails/thumbnail.jpg",
    }


# ─── Captions / transcripts ──────────────────────────────────────────────────

def _vtt_to_text(vtt: str) -> str:
    """Strip WebVTT cues/timestamps down to readable prose."""
    lines = []
    for raw in (vtt or "").splitlines():
        line = raw.strip()
        if (not line or line.startswith("WEBVTT") or line.startswith("NOTE")
                or "-->" in line or line.isdigit()):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # inline cue tags
        if line and (not lines or lines[-1] != line):  # drop consecutive dupes
            lines.append(line)
    return " ".join(lines).strip()


def request_captions(uid: str, language: str = "en") -> bool:
    """Ask Cloudflare to auto-generate captions. True if accepted/already running."""
    try:
        _api("POST", f"/{validate_uid(uid)}/captions/{language}/generate", json={})
        logger.info("[VIDEO] Caption generation requested for %s (%s)", uid, language)
        return True
    except VideoError as e:
        logger.info("[VIDEO] Caption generation not started for %s: %s", uid, e)
        return False


def get_captions(uid: str, language: str = "en") -> Optional[str]:
    """Auto-generated captions as plain text, or None when not ready.

    Fetched directly (not via _api) because the VTT endpoint returns raw text
    rather than Cloudflare's JSON envelope.
    """
    if not is_configured():
        return None
    uid = validate_uid(uid)
    try:
        resp = requests.get(
            f"{_API_BASE}/accounts/{CLOUDFLARE_ACCOUNT_ID}/stream/{uid}/captions/{language}/vtt",
            headers=_headers(), timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        logger.debug("[VIDEO] Caption fetch failed for %s: %s", uid, e)
        return None
    if resp.status_code != 200:
        return None
    text = _vtt_to_text(resp.text)
    if len(text) > 50:
        logger.info("[VIDEO] Captions for %s (%s): %d chars", uid, language, len(text))
        return text
    return None


def download_url(uid: str, ttl: Optional[int] = None) -> str:
    """Signed HLS manifest URL — what AssemblyAI is pointed at when captions aren't ready."""
    return playback(uid, ttl)["hls_url"]
