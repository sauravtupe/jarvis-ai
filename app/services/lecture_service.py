"""Lecture catalog (Feature 8).

Stores YouTube lecture URLs organised by Class -> Chapter. The catalog is
managed entirely by the admin API (no manual JSON editing). The parser
recognises English + Hindi (Devanagari + Roman transliteration) voice/text
commands such as "open class 5 chapter 3" or "क्लास 5 चैप्टर 3 खोलो" and
returns the matching catalog entry for the chat pre-brain shortcut.
"""

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Tuple

from config import LECTURES_JSON_PATH, PRACTICE_CLASSES
from app.services.quiz_service import extract_video_id, get_full_url
from app.services.practice_service import (
    extract_class_from_message,
    _normalize_number_words,
)

logger = logging.getLogger("J.A.R.V.I.S")

_lock = threading.Lock()
_CHAPTER_MIN = 1
_CHAPTER_MAX = 80

# ─── Catalog persistence ────────────────────────────────────────────────────

def _load_catalog() -> dict:
    """Read the catalog from disk. Returns {} if missing or malformed."""
    try:
        if not LECTURES_JSON_PATH.exists():
            return {}
        with open(LECTURES_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            logger.warning("[LECTURE] lectures.json root is not an object — resetting in-memory view")
            return {}
        return data
    except Exception as e:
        logger.warning("[LECTURE] Failed to load lectures.json: %s — using empty catalog", e)
        return {}


def _atomic_write(data: dict) -> None:
    """Write the catalog atomically (write to tmp, then rename) and sync to S3.

    The S3 sync is best-effort — failure is logged but does not block the
    local write. Containers on HF Spaces are ephemeral, so the S3 copy is
    what makes the catalog survive deploys / restarts.
    """
    LECTURES_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LECTURES_JSON_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, LECTURES_JSON_PATH)
    try:
        from app.services.storage_service import upload_bytes_to_s3
        payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        upload_bytes_to_s3(payload, "lectures/lectures.json", content_type="application/json")
    except Exception as e:
        logger.warning("[LECTURE] S3 sync of lectures.json failed: %s", e)


def _save_catalog(data: dict) -> None:
    with _lock:
        _atomic_write(data)


# ─── Public CRUD API ────────────────────────────────────────────────────────

def list_lectures() -> List[Dict]:
    """Flat list of all lectures, sorted by class number then chapter number."""
    catalog = _load_catalog()
    out: List[Dict] = []
    for class_name, chapters in catalog.items():
        if not isinstance(chapters, dict):
            continue
        for chapter_key, rec in chapters.items():
            if not isinstance(rec, dict):
                continue
            try:
                chapter_num = int(chapter_key.replace("chapter_", ""))
            except (ValueError, AttributeError):
                continue
            out.append({
                "class_name": class_name,
                "chapter": chapter_num,
                "title": rec.get("title", ""),
                "youtube_url": rec.get("youtube_url", ""),
                "video_id": rec.get("video_id", ""),
                "created_at": rec.get("created_at", ""),
                "updated_at": rec.get("updated_at", ""),
            })
    out.sort(key=lambda r: (_class_sort_key(r["class_name"]), r["chapter"]))
    return out


def _class_sort_key(class_name: str) -> Tuple[int, int]:
    """UKG sorts before class_1; numeric classes sort ascending."""
    if class_name == "UKG":
        return (0, 0)
    try:
        return (1, int(class_name.replace("class_", "")))
    except (ValueError, AttributeError):
        return (2, 0)


class LectureError(Exception):
    """Raised for validation / lookup failures. Carries an HTTP-friendly status."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _validate_class(class_name: str) -> str:
    if class_name not in PRACTICE_CLASSES:
        raise LectureError(f"Invalid class '{class_name}' — must be one of UKG, class_1 … class_12", 422)
    return class_name


def _validate_chapter(chapter: int) -> str:
    if not isinstance(chapter, int) or not (_CHAPTER_MIN <= chapter <= _CHAPTER_MAX):
        raise LectureError(f"Chapter must be an integer between {_CHAPTER_MIN} and {_CHAPTER_MAX}", 422)
    return f"chapter_{chapter}"


def _validate_url(url: str) -> Tuple[str, str]:
    """Returns (normalised_url, video_id). Raises LectureError on bad URL."""
    if not url or not isinstance(url, str):
        raise LectureError("YouTube URL is required", 422)
    video_id = extract_video_id(url)
    if not video_id:
        raise LectureError("Not a valid YouTube URL", 422)
    return get_full_url(url) or f"https://www.youtube.com/watch?v={video_id}", video_id


def add_lecture(class_name: str, chapter: int, title: str, youtube_url: str, overwrite: bool = False) -> Dict:
    """Add a new lecture. Raises LectureError(409) if slot exists and overwrite=False."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    if not title or not title.strip():
        raise LectureError("Title is required", 422)
    if len(title) > 120:
        raise LectureError("Title must be 120 characters or fewer", 422)
    normalised_url, video_id = _validate_url(youtube_url)

    with _lock:
        catalog = _load_catalog()
        existing = catalog.get(class_name, {}).get(chapter_key)
        if existing and not overwrite:
            raise LectureError(
                f"A lecture already exists at {class_name} / {chapter_key}. Pass overwrite=true to replace.",
                409,
            )
        now = datetime.now(timezone.utc).isoformat()
        created_at = (existing or {}).get("created_at", now)
        record = {
            "title": title.strip(),
            "youtube_url": normalised_url,
            "video_id": video_id,
            "created_at": created_at,
            "updated_at": now,
        }
        catalog.setdefault(class_name, {})[chapter_key] = record
        _atomic_write(catalog)

    logger.info("[LECTURE] Saved %s / %s — %s", class_name, chapter_key, title)
    return {
        "class_name": class_name,
        "chapter": chapter,
        **record,
    }


def update_lecture(class_name: str, chapter: int, title: str, youtube_url: str) -> Dict:
    """Update an existing slot. Raises LectureError(404) if missing."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    if not title or not title.strip():
        raise LectureError("Title is required", 422)
    if len(title) > 120:
        raise LectureError("Title must be 120 characters or fewer", 422)
    normalised_url, video_id = _validate_url(youtube_url)

    with _lock:
        catalog = _load_catalog()
        if class_name not in catalog or chapter_key not in catalog.get(class_name, {}):
            raise LectureError(f"No lecture found at {class_name} / {chapter_key}", 404)
        existing = catalog[class_name][chapter_key]
        record = {
            "title": title.strip(),
            "youtube_url": normalised_url,
            "video_id": video_id,
            "created_at": existing.get("created_at", datetime.now(timezone.utc).isoformat()),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        catalog[class_name][chapter_key] = record
        _atomic_write(catalog)

    logger.info("[LECTURE] Updated %s / %s — %s", class_name, chapter_key, title)
    return {
        "class_name": class_name,
        "chapter": chapter,
        **record,
    }


def delete_lecture(class_name: str, chapter: int) -> None:
    """Delete a slot. Raises LectureError(404) if missing."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    with _lock:
        catalog = _load_catalog()
        if class_name not in catalog or chapter_key not in catalog.get(class_name, {}):
            raise LectureError(f"No lecture found at {class_name} / {chapter_key}", 404)
        del catalog[class_name][chapter_key]
        if not catalog[class_name]:
            del catalog[class_name]
        _atomic_write(catalog)
    logger.info("[LECTURE] Deleted %s / %s", class_name, chapter_key)


# ─── Bilingual command parser ───────────────────────────────────────────────

# Devanagari + Roman Hindi keywords -> English replacements.
# Applied BEFORE the existing class/chapter extractors run so we can reuse them unchanged.
# NOTE: Devanagari patterns don't use \b — Python's word-boundary doesn't reliably
# recognise Devanagari conjuncts (e.g. कक्षा, अध्याय). The keywords are distinctive
# enough that substring match is safe.
_HINDI_KEYWORDS = [
    # class words
    (r"क्लास", "class"),
    (r"कक्षा", "class"),
    (r"काक्षा", "class"),
    (r"\bkakshya\b", "class"),
    (r"\bkaksha\b", "class"),
    # chapter words
    (r"चैप्टर", "chapter"),
    (r"अध्याय", "chapter"),
    (r"पाठ", "chapter"),
    (r"\badhyay\b", "chapter"),
    (r"\bpaath\b", "chapter"),
    # verbs (we strip them — the gate doesn't require a verb)
    (r"खोलो", "open"),
    (r"चलाओ", "play"),
    (r"शुरू", "start"),
    (r"दिखाओ", "show"),
    (r"\bkholo\b", "open"),
    (r"\bchalao\b", "play"),
    (r"\bshuru\b", "start"),
    (r"\bdikhao\b", "show"),
    (r"\bkaro\b", ""),  # "open karo" -> "open"
]

# Devanagari digit -> ASCII digit
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


def _normalize_devanagari_digits(text: str) -> str:
    return (text or "").translate(_DEVANAGARI_DIGITS)


def _normalize_hindi_keywords(text: str) -> str:
    out = _normalize_devanagari_digits(text or "")
    for pattern, replacement in _HINDI_KEYWORDS:
        out = re.sub(pattern, replacement, out, flags=re.IGNORECASE)
    return out


# Only matches "chapter N" / "lesson N" / "lecture N" (keyword BEFORE the number).
# The reverse pattern ("5 chapter") is intentionally NOT supported — it would
# clash with "class 5 chapter 3" where "5" belongs to the class.
_CHAPTER_RE = re.compile(
    r"\b(?:chapter|lesson|lecture)\s*(\d{1,2})\b",
    re.IGNORECASE,
)


def extract_chapter_from_message(text: str) -> Optional[int]:
    """Returns the chapter number found in text (e.g. "chapter 3" -> 3), or None.

    Hindi/Devanagari input is normalised first so the same regex works for
    "चैप्टर 3" / "अध्याय 3" / "chapter 3" / "lecture 3".
    """
    normalised = _normalize_number_words(_normalize_hindi_keywords(text or ""))
    m = _CHAPTER_RE.search(normalised)
    if not m:
        return None
    try:
        n = int(m.group(1))
        if _CHAPTER_MIN <= n <= _CHAPTER_MAX:
            return n
    except (ValueError, TypeError):
        pass
    return None


# Gate regex — fast check that the text mentions both a class keyword AND a chapter keyword.
# Runs BEFORE the heavier extractors. Avoids false positives on unrelated messages.
# NOTE: "UKG" and "kindergarten" are themselves class identifiers — they don't need a
# preceding "class" word ("UKG chapter 1" is valid and means class=UKG, chapter=1).
_CLASS_WORD_RE = re.compile(r"\b(class|std|standard|grade|UKG|kindergarten)\b", re.IGNORECASE)
_CHAPTER_WORD_RE = re.compile(r"\b(chapter|lesson|lecture)\b", re.IGNORECASE)


def is_lecture_command(text: str) -> bool:
    """Fast gate — true only if the text has BOTH a class keyword and a chapter keyword."""
    if not text:
        return False
    normalised = _normalize_hindi_keywords(text)
    return bool(_CLASS_WORD_RE.search(normalised) and _CHAPTER_WORD_RE.search(normalised))


def match_lecture_command(text: str) -> Optional[Dict]:
    """Parse a lecture command and return the matched catalog entry.

    Returns None if:
    - text doesn't look like a lecture command (no class+chapter keywords)
    - class or chapter cannot be parsed
    - the catalog has no entry for that slot (also returns a "_not_found" hint)
    """
    if not is_lecture_command(text):
        return None

    normalised = _normalize_hindi_keywords(text)
    class_name = extract_class_from_message(normalised)
    # extract_chapter_from_message already normalises Hindi keywords internally,
    # but pass the pre-normalised string anyway for consistency.
    chapter = extract_chapter_from_message(normalised)
    if not class_name or not chapter:
        return None

    chapter_key = f"chapter_{chapter}"
    catalog = _load_catalog()
    record = catalog.get(class_name, {}).get(chapter_key)

    class_num_str = class_name.replace("class_", "").upper() if class_name != "UKG" else "UKG"

    if not record:
        # Signal to caller that the command parsed but the slot is empty.
        return {
            "_not_found": True,
            "class_name": class_name,
            "class_num": class_num_str,
            "chapter": chapter,
        }

    return {
        "class_name": class_name,
        "class_num": class_num_str,
        "chapter": chapter,
        "chapter_key": chapter_key,
        "title": record.get("title", ""),
        "youtube_url": record.get("youtube_url", ""),
        "video_id": record.get("video_id", ""),
    }


# Log catalog size at import time so HF logs confirm the new code is live.
try:
    _initial = _load_catalog()
    _initial_count = sum(len(v) for v in _initial.values() if isinstance(v, dict))
    logger.info("[LECTURE] lecture_service loaded — %d lectures across %d classes", _initial_count, len(_initial))
except Exception as _e:
    logger.warning("[LECTURE] Initial catalog load failed: %s", _e)
