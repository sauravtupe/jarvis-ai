"""Practical Exercises (Feature 9).

Practicals are hands-on tasks attached per Class -> Chapter inside the existing
lectures.json catalog. The service provides:

- URL-allowlisted CRUD (admin-gated at the API layer)
- A bilingual command parser ("practical for class 6 chapter 1" / Hindi)
- A 3-layer bundle composer (curated + AI-generated tasks + class PDFs)

Catalog mutations reuse lecture_service's lock + atomic write + S3 sync.
The practicals field is an OPTIONAL array on each chapter record, so existing
lectures without practicals continue to work unchanged.
"""

import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse

from app.services import lecture_service as _lec
from app.services.practice_service import (
    extract_class_from_message,
    list_pdfs_for_class,
)

logger = logging.getLogger("J.A.R.V.I.S")

_PRACTICAL_SERVICE_VERSION = "2026-05-26a"
logger.info("[PRACTICAL] practical_service loaded — version: %s", _PRACTICAL_SERVICE_VERSION)


# ─── Allowed platforms (security) ───────────────────────────────────────────

# Whitelist of educational platforms. URLs must be http(s) and the hostname must
# either equal an entry or be a sub-domain of one.
_ALLOWED_URL_DOMAINS = (
    "colab.research.google.com",
    "kaggle.com",
    "huggingface.co",
    "github.com",
    "gitlab.com",
    "codepen.io",
    "replit.com",
    "jupyter.org",
    "jovian.com",
    "deepnote.com",
    "paperspace.com",
    "mlcourse.ai",
    "fast.ai",
    "coursera.org",
    "edx.org",
    "udacity.com",
    "openai.com",
    "anthropic.com",
    "tensorflow.org",
    "pytorch.org",
    "keras.io",
    "scikit-learn.org",
    "youtube.com",
    "youtu.be",
)

_PLATFORM_ENUM = (
    "Google Colab", "Kaggle", "HuggingFace", "GitHub", "GitLab",
    "Codepen", "Replit", "Jupyter", "Deepnote", "Paperspace",
    "Coursera", "edX", "Udacity", "fast.ai", "YouTube", "Other",
)

_TYPE_ENUM = ("notebook", "dataset", "tutorial", "challenge", "project", "video-followup")
_DIFFICULTY_ENUM = ("beginner", "intermediate", "advanced")


class PracticalError(Exception):
    """Validation / lookup failures with HTTP-friendly status codes."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _validate_url(url: str) -> str:
    if not url or not isinstance(url, str):
        raise PracticalError("URL is required", 422)
    try:
        p = urlparse(url.strip())
    except Exception:
        raise PracticalError("Invalid URL", 422)
    if p.scheme not in ("http", "https"):
        raise PracticalError("URL must start with http:// or https://", 422)
    host = (p.netloc or "").lower().split(":")[0]  # strip port
    if not host:
        raise PracticalError("URL is missing a host", 422)
    for allowed in _ALLOWED_URL_DOMAINS:
        if host == allowed or host.endswith("." + allowed):
            return url.strip()
    sample = ", ".join(_ALLOWED_URL_DOMAINS[:6])
    raise PracticalError(
        f"URL host '{host}' is not in the allowed platforms list. "
        f"Allowed: {sample}, plus other educational platforms.",
        422,
    )


def _validate_enum(value: str, allowed: tuple, field: str) -> str:
    if value not in allowed:
        raise PracticalError(
            f"{field} must be one of: {', '.join(allowed)}",
            422,
        )
    return value


# ─── Catalog mutations (per-chapter practicals array) ───────────────────────

def _generate_practical_id() -> str:
    return "p_" + secrets.token_hex(4)


def _normalize_practical_record(p: Dict[str, Any]) -> Dict[str, Any]:
    """Sanity-cast a raw catalog record into a clean dict for API responses."""
    if not isinstance(p, dict):
        return {}
    return {
        "id": str(p.get("id", "")),
        "title": str(p.get("title", "")),
        "url": str(p.get("url", "")),
        "platform": str(p.get("platform", "Other")),
        "type": str(p.get("type", "notebook")),
        "difficulty": str(p.get("difficulty", "beginner")),
        "estimated_minutes": int(p.get("estimated_minutes") or 30),
        "description": str(p.get("description", "")),
        "tags": list(p.get("tags") or []),
        "created_at": str(p.get("created_at", "")),
        "updated_at": str(p.get("updated_at", "")),
    }


def _validate_practical_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    title = str(data.get("title", "")).strip()
    if not title:
        raise PracticalError("title is required", 422)
    if len(title) > 120:
        raise PracticalError("title must be 120 characters or fewer", 422)
    url = _validate_url(data.get("url", ""))
    platform = _validate_enum(data.get("platform", ""), _PLATFORM_ENUM, "platform")
    type_ = _validate_enum(data.get("type", ""), _TYPE_ENUM, "type")
    difficulty = _validate_enum(data.get("difficulty", ""), _DIFFICULTY_ENUM, "difficulty")
    minutes = data.get("estimated_minutes")
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        raise PracticalError("estimated_minutes must be an integer", 422)
    if not (1 <= minutes <= 600):
        raise PracticalError("estimated_minutes must be between 1 and 600", 422)
    description = str(data.get("description", "")).strip()
    if not description:
        raise PracticalError("description is required", 422)
    if len(description) > 500:
        raise PracticalError("description must be 500 characters or fewer", 422)
    tags = data.get("tags") or []
    if not isinstance(tags, list):
        raise PracticalError("tags must be a list of strings", 422)
    tags = [str(t).strip() for t in tags if str(t).strip()][:10]
    return {
        "title": title,
        "url": url,
        "platform": platform,
        "type": type_,
        "difficulty": difficulty,
        "estimated_minutes": minutes,
        "description": description,
        "tags": tags,
    }


def _ensure_chapter_exists(catalog: dict, class_name: str, chapter_key: str) -> dict:
    """Returns the chapter record. Raises 404 if missing.

    Practicals can only be attached to chapters that have a saved lecture.
    """
    chapters = catalog.get(class_name)
    if not isinstance(chapters, dict) or chapter_key not in chapters:
        raise PracticalError(
            f"No lecture found at {class_name} / {chapter_key} — add the lecture first.",
            404,
        )
    rec = chapters[chapter_key]
    if not isinstance(rec, dict):
        raise PracticalError("Lecture record is malformed", 500)
    return rec


def list_practicals(class_name: str, chapter: int) -> List[Dict]:
    """Return all practicals for a chapter (empty list if none)."""
    _lec._validate_class(class_name)
    chapter_key = _lec._validate_chapter(chapter)
    catalog = _lec._load_catalog()
    rec = catalog.get(class_name, {}).get(chapter_key)
    if not isinstance(rec, dict):
        return []
    practicals = rec.get("practicals") or []
    return [_normalize_practical_record(p) for p in practicals if isinstance(p, dict)]


def add_practical(class_name: str, chapter: int, payload: Dict[str, Any]) -> Dict:
    _lec._validate_class(class_name)
    chapter_key = _lec._validate_chapter(chapter)
    clean = _validate_practical_payload(payload)

    with _lec._lock:
        catalog = _lec._load_catalog()
        rec = _ensure_chapter_exists(catalog, class_name, chapter_key)
        now = datetime.now(timezone.utc).isoformat()
        new_practical = {
            "id": _generate_practical_id(),
            **clean,
            "created_at": now,
            "updated_at": now,
        }
        rec.setdefault("practicals", []).append(new_practical)
        _lec._atomic_write(catalog)

    logger.info("[PRACTICAL] Added %s / %s practical %s — %s",
                class_name, chapter_key, new_practical["id"], new_practical["title"])
    return _normalize_practical_record(new_practical)


def update_practical(class_name: str, chapter: int, practical_id: str, payload: Dict[str, Any]) -> Dict:
    _lec._validate_class(class_name)
    chapter_key = _lec._validate_chapter(chapter)
    clean = _validate_practical_payload(payload)

    with _lec._lock:
        catalog = _lec._load_catalog()
        rec = _ensure_chapter_exists(catalog, class_name, chapter_key)
        practicals = rec.get("practicals") or []
        for i, p in enumerate(practicals):
            if isinstance(p, dict) and p.get("id") == practical_id:
                now = datetime.now(timezone.utc).isoformat()
                updated = {
                    "id": practical_id,
                    **clean,
                    "created_at": p.get("created_at", now),
                    "updated_at": now,
                }
                practicals[i] = updated
                rec["practicals"] = practicals
                _lec._atomic_write(catalog)
                logger.info("[PRACTICAL] Updated %s / %s practical %s",
                            class_name, chapter_key, practical_id)
                return _normalize_practical_record(updated)

    raise PracticalError(f"No practical with id={practical_id} at {class_name} / {chapter_key}", 404)


def delete_practical(class_name: str, chapter: int, practical_id: str) -> None:
    _lec._validate_class(class_name)
    chapter_key = _lec._validate_chapter(chapter)

    with _lec._lock:
        catalog = _lec._load_catalog()
        rec = _ensure_chapter_exists(catalog, class_name, chapter_key)
        practicals = rec.get("practicals") or []
        new_list = [p for p in practicals if not (isinstance(p, dict) and p.get("id") == practical_id)]
        if len(new_list) == len(practicals):
            raise PracticalError(
                f"No practical with id={practical_id} at {class_name} / {chapter_key}",
                404,
            )
        rec["practicals"] = new_list
        _lec._atomic_write(catalog)
    logger.info("[PRACTICAL] Deleted %s / %s practical %s", class_name, chapter_key, practical_id)


# ─── Bundle composer ────────────────────────────────────────────────────────

def build_practical_bundle(class_name: str, chapter: int) -> Dict[str, Any]:
    """Return the public 'practical view' for a chapter.

    Combines:
      - curated   : admin-added practical records from lectures.json
      - class_pdfs: existing class-wise PDFs (general material)
      - lecture   : title + video_id of the parent lecture (for header context)

    AI-generated tasks are NOT included here — they're fetched from a separate
    endpoint that takes the session's transcript and returns generated tasks
    with caching. Keeping them separate lets the frontend show curated
    practicals immediately while AI tasks load in the background.
    """
    _lec._validate_class(class_name)
    chapter_key = _lec._validate_chapter(chapter)
    catalog = _lec._load_catalog()
    rec = catalog.get(class_name, {}).get(chapter_key) or {}

    return {
        "class_name": class_name,
        "chapter": chapter,
        "lecture": {
            "title": rec.get("title", ""),
            "video_id": rec.get("video_id", ""),
            "youtube_url": rec.get("youtube_url", ""),
        },
        "curated": [_normalize_practical_record(p) for p in (rec.get("practicals") or []) if isinstance(p, dict)],
        "class_pdfs": list_pdfs_for_class(class_name),
    }


# ─── Bilingual command parser ───────────────────────────────────────────────

# Practical keywords. Hindi (Devanagari + Roman) gets normalised to English
# tokens first; then the regex matches.
_HINDI_PRACTICAL_REPLACEMENTS = [
    (r"प्रैक्टिकल", "practical"),
    (r"प्रैक्टीकल", "practical"),
    (r"अभ्यास", "practice"),
    (r"प्रयोग", "practical"),
    (r"\bpractical\b", "practical"),  # no-op but ensures word boundary
    (r"\babhyaas\b", "practice"),
    (r"\babhyas\b", "practice"),
    (r"\bprayog\b", "practical"),
    (r"\bkarna hai\b", "do"),
    (r"\bkarna\b", "do"),
    (r"\bbanao\b", "build"),
    (r"\bka\b", ""),  # "class 6 chapter 1 ka practical" -> drop "ka"
    (r"\bdo\b", ""),  # "practical do" -> "practical"
]


def _normalize_practical_keywords(text: str) -> str:
    out = text or ""
    for pattern, replacement in _HINDI_PRACTICAL_REPLACEMENTS:
        out = re.sub(pattern, replacement, out, flags=re.IGNORECASE)
    # Collapse extra whitespace introduced by drops
    out = re.sub(r"\s+", " ", out).strip()
    return out


_PRACTICAL_KEYWORD_RE = re.compile(
    r"\b("
    r"practical|practicals|hands[-\s]?on|exercise|exercises|"
    r"project|projects|assignment|practice|practise"
    r")\b",
    re.IGNORECASE,
)


def is_practical_command(text: str) -> bool:
    """Fast gate — true only if the text mentions a practical keyword.

    Class/chapter resolution happens in match_practical_command.
    """
    if not text:
        return False
    normalised = _normalize_practical_keywords(_lec._normalize_hindi_keywords(text))
    return bool(_PRACTICAL_KEYWORD_RE.search(normalised))


def _extract_class_num_str(class_name: str) -> str:
    if class_name == "UKG":
        return "UKG"
    try:
        return class_name.replace("class_", "")
    except Exception:
        return class_name


def match_practical_command(text: str, pending_youtube: Optional[Dict] = None) -> Optional[Dict]:
    """Parse a practical command and resolve to a (class_name, chapter).

    Returns:
      None                     — text is not a practical command at all
      {"_missing": "class_chapter"} — practical keyword found but no class/chapter
                                      AND no pending_youtube context. Caller
                                      should prompt the user for class/chapter.
      {"class_name": ..., "chapter": int, "class_num": ..., "from_context": bool}
                                — success

    If pending_youtube has a video_id that matches a lecture in the catalog,
    we use that lecture's class/chapter even when text alone is ambiguous.
    """
    if not is_practical_command(text):
        return None

    # Try to extract class + chapter from the text itself first.
    normalised = _normalize_practical_keywords(_lec._normalize_hindi_keywords(text))
    class_name = extract_class_from_message(normalised)
    chapter = _lec.extract_chapter_from_message(normalised)

    if class_name and chapter:
        return {
            "class_name": class_name,
            "chapter": chapter,
            "class_num": _extract_class_num_str(class_name),
            "from_context": False,
        }

    # Fall back to pending_youtube context — student just watched a video.
    if pending_youtube and pending_youtube.get("video_id"):
        video_id = pending_youtube["video_id"]
        catalog = _lec._load_catalog()
        for cls, chapters in catalog.items():
            if not isinstance(chapters, dict):
                continue
            for chapter_key, rec in chapters.items():
                if isinstance(rec, dict) and rec.get("video_id") == video_id:
                    try:
                        ch_num = int(chapter_key.replace("chapter_", ""))
                    except ValueError:
                        continue
                    return {
                        "class_name": cls,
                        "chapter": ch_num,
                        "class_num": _extract_class_num_str(cls),
                        "from_context": True,
                    }

    # Practical keyword fired but we couldn't resolve class/chapter.
    return {"_missing": "class_chapter"}
