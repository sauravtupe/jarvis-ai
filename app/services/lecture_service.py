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
                "notes_url": rec.get("notes_url", ""),
                "notes_type": rec.get("notes_type", ""),
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
        # On overwrite, keep any extra fields (practicals, practice_tasks, notes_url, …)
        # the slot already carried — only the core lecture fields are replaced.
        record = dict(existing) if isinstance(existing, dict) else {}
        record.update({
            "title": title.strip(),
            "youtube_url": normalised_url,
            "video_id": video_id,
            "created_at": created_at,
            "updated_at": now,
        })
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
        # Preserve all extra fields (practicals, practice_tasks, notes_url, …) — only
        # the core lecture fields change on edit. Without this, editing a title/URL
        # would silently wipe the teacher's saved practice and notes.
        record = dict(existing) if isinstance(existing, dict) else {}
        record.update({
            "title": title.strip(),
            "youtube_url": normalised_url,
            "video_id": video_id,
            "created_at": existing.get("created_at", datetime.now(timezone.utc).isoformat()),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
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


# ─── Notes / PPT per lecture ────────────────────────────────────────────────
# Each lecture can carry ONE notes URL (PPT / PDF / Google Slides / Doc). The
# teacher sets it from the Lecture Panel; students retrieve it with a voice/text
# command ("give me Class 1 Chapter 2 notes"). Stored on the chapter record so it
# rides the same S3-synced lectures.json as everything else.

from urllib.parse import urlparse as _urlparse

# Hosts allowed for notes URLs (host must equal an entry or be a sub-domain of one).
_NOTES_ALLOWED_HOSTS = (
    "docs.google.com",
    "drive.google.com",
    "dropbox.com",
)
# Any https URL ending in one of these is allowed regardless of host (direct file).
_NOTES_DIRECT_FILE_EXT = (".pdf", ".ppt", ".pptx")


def _infer_notes_type(url: str) -> str:
    u = (url or "").lower()
    path = ""
    try:
        path = _urlparse(u).path or ""
    except Exception:
        path = u
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".ppt") or path.endswith(".pptx"):
        return "ppt"
    if "docs.google.com/presentation" in u or "/slides" in u:
        return "slides"
    if "docs.google.com/document" in u:
        return "doc"
    if "docs.google.com" in u or "drive.google.com" in u:
        return "slides"
    return "link"


def _validate_notes_url(url: str) -> Tuple[str, str]:
    """Validate a notes URL against the allowlist. Returns (url, notes_type)."""
    if not url or not isinstance(url, str):
        raise LectureError("Notes URL is required", 422)
    url = url.strip()
    try:
        p = _urlparse(url)
    except Exception:
        raise LectureError("Invalid notes URL", 422)
    if p.scheme not in ("http", "https"):
        raise LectureError("Notes URL must start with http:// or https://", 422)
    host = (p.netloc or "").lower().split(":")[0]
    if not host:
        raise LectureError("Notes URL is missing a host", 422)
    path_lower = (p.path or "").lower()
    # Allow direct PPT/PDF files on any https host.
    if p.scheme == "https" and path_lower.endswith(_NOTES_DIRECT_FILE_EXT):
        return url, _infer_notes_type(url)
    for allowed in _NOTES_ALLOWED_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return url, _infer_notes_type(url)
    raise LectureError(
        f"Notes URL host '{host}' is not allowed. Use Google Slides/Docs/Drive, "
        f"Dropbox, or a direct https link to a .pdf/.ppt/.pptx file.",
        422,
    )


def set_notes(class_name: str, chapter: int, notes_url: str) -> Dict:
    """Attach (or replace) the notes URL on a lecture. Raises 404 if no lecture."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    clean_url, notes_type = _validate_notes_url(notes_url)
    with _lock:
        catalog = _load_catalog()
        if class_name not in catalog or chapter_key not in catalog.get(class_name, {}):
            raise LectureError(
                f"No lecture found at {class_name} / {chapter_key} — add the lecture first.",
                404,
            )
        rec = catalog[class_name][chapter_key]
        if not isinstance(rec, dict):
            raise LectureError("Lecture record is malformed", 500)
        rec["notes_url"] = clean_url
        rec["notes_type"] = notes_type
        rec["notes_added_at"] = datetime.now(timezone.utc).isoformat()
        _atomic_write(catalog)
    logger.info("[LECTURE] Set notes for %s / %s (%s)", class_name, chapter_key, notes_type)
    return {
        "class_name": class_name,
        "chapter": chapter,
        "notes_url": clean_url,
        "notes_type": notes_type,
        "notes_added_at": rec["notes_added_at"],
        "title": rec.get("title", ""),
    }


def clear_notes(class_name: str, chapter: int) -> None:
    """Remove the notes URL from a lecture. Raises 404 if no lecture."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    with _lock:
        catalog = _load_catalog()
        if class_name not in catalog or chapter_key not in catalog.get(class_name, {}):
            raise LectureError(f"No lecture found at {class_name} / {chapter_key}", 404)
        rec = catalog[class_name][chapter_key]
        if isinstance(rec, dict):
            for k in ("notes_url", "notes_type", "notes_added_at"):
                rec.pop(k, None)
        _atomic_write(catalog)
    logger.info("[LECTURE] Cleared notes for %s / %s", class_name, chapter_key)


def get_notes(class_name: str, chapter: int) -> Optional[Dict]:
    """Return the saved notes for a lecture, or None if no lecture / no notes."""
    _validate_class(class_name)
    chapter_key = _validate_chapter(chapter)
    catalog = _load_catalog()
    rec = catalog.get(class_name, {}).get(chapter_key)
    if not isinstance(rec, dict):
        return None
    url = (rec.get("notes_url") or "").strip()
    if not url:
        return None
    return {
        "class_name": class_name,
        "chapter": chapter,
        "notes_url": url,
        "notes_type": rec.get("notes_type") or _infer_notes_type(url),
        "notes_added_at": rec.get("notes_added_at", ""),
        "title": rec.get("title", ""),
    }


def _find_slot_by_video_id(video_id: str) -> Optional[Tuple[str, int]]:
    """Return (class_name, chapter) for a saved lecture matching video_id, or None."""
    if not video_id:
        return None
    catalog = _load_catalog()
    for cls, chapters in catalog.items():
        if not isinstance(chapters, dict):
            continue
        for chapter_key, rec in chapters.items():
            if isinstance(rec, dict) and rec.get("video_id") == video_id:
                try:
                    return cls, int(chapter_key.replace("chapter_", ""))
                except (ValueError, AttributeError):
                    continue
    return None


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


# Ordinal + number-word normalisation (scoped "first chapter" → "1 chapter" and
# "5th" → "5") lives in practice_service._normalize_number_words, imported above and
# shared by both the class and chapter extractors. Kept single-source so the
# ordinal-scoping rule can't drift between the two files.


def _strip_class_portion(text: str) -> str:
    """Remove the class word + its number from text.

    Needed so the chapter extractor doesn't mistake the class number for the
    chapter number — e.g. in "class 5 chapter 3", without removing "class 5"
    the pattern "N chapter" would match "5 chapter" → chapter=5 (wrong).
    """
    out = re.sub(r"\b(UKG|kindergarten)\b", "", text or "", flags=re.IGNORECASE)
    # Strip the NUMBER-BEFORE-WORD form ("3 standard", "5 class") FIRST. If the
    # "<word> <num>" form is stripped first, the "standard" in "3 standard 1 chapter"
    # greedily eats the CHAPTER's number ("standard 1"), leaving "3 chapter" → chapter
    # mis-parsed as the class number 3. The number-before-word form must claim its own
    # preceding number before the other pattern can run.
    out = re.sub(r"\b\d{1,2}\s*(class|grade|std|standard)\b", "", out, flags=re.IGNORECASE)
    out = re.sub(r"\b(class|std|standard|grade)\s*\d{1,2}\b", "", out, flags=re.IGNORECASE)
    return out


# Accepts BOTH word orders:
#   "chapter 3" / "lesson 3" / "lecture 3"     (keyword before number)
#   "3 chapter" / "3 lesson" / "3 lecture"     (number before keyword — for "first lecture" style)
# The "N keyword" form is only safe AFTER class portion has been stripped from the text.
_CHAPTER_AFTER_RE = re.compile(r"\b(?:chapter|lesson|lecture)\s*(\d{1,2})\b", re.IGNORECASE)
_CHAPTER_BEFORE_RE = re.compile(r"\b(\d{1,2})\s*(?:chapter|lesson|lecture)\b", re.IGNORECASE)


def extract_chapter_from_message(text: str, strip_class: bool = True) -> Optional[int]:
    """Returns the chapter number found in text, or None.

    By default the class portion (e.g. "class 5", "UKG") is stripped first so
    the "N chapter" pattern doesn't mistakenly grab the class number.
    """
    normalised = _normalize_number_words(_normalize_hindi_keywords(text or ""))
    search_text = _strip_class_portion(normalised) if strip_class else normalised

    for pattern in (_CHAPTER_AFTER_RE, _CHAPTER_BEFORE_RE):
        m = pattern.search(search_text)
        if m:
            try:
                n = int(m.group(1))
                if _CHAPTER_MIN <= n <= _CHAPTER_MAX:
                    return n
            except (ValueError, TypeError):
                continue
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


# Open/play/watch verbs (English; Hindi verbs are normalised to these by
# _normalize_hindi_keywords). Used to recognise an under-specified command as a
# genuine "open a lecture" request, so we ask for the missing piece instead of
# letting it fall through to the brain (which would open a random URL).
_LECTURE_OPEN_VERB_RE = re.compile(
    r"\b(open|play|start|show|watch|launch|begin|put\s+on)\b", re.IGNORECASE
)


def _class_num_str(class_name: str) -> str:
    return "UKG" if class_name == "UKG" else class_name.replace("class_", "").upper()


def match_lecture_command(text: str) -> Optional[Dict]:
    """Parse a lecture-open command and resolve it against the catalog.

    Returns None when the text isn't a lecture-open request at all. When it
    clearly is one but is under-specified, returns a hint so the caller can ask
    the student — instead of letting the message reach the brain, which opens a
    random URL:
      {"_missing": "class",   "chapter": int}                  — chapter given, class missing
      {"_missing": "chapter", "class_name", "class_num"}       — class given, chapter missing
      {"_not_found": True, "class_name", "class_num", "chapter"} — both given, no saved video
      {full record}                                            — success
    """
    if not text:
        return None

    # Practice commands ("practice for class 6 chapter 1") also carry class+chapter
    # keywords but must be served by the practical handler — never opened as a video.
    # (The practical handler runs AFTER this one, so without this guard the lecture
    # shortcut would shadow it.)
    try:
        from app.services.practical_service import is_practical_command
        if is_practical_command(text):
            return None
    except Exception:
        pass

    normalised = _normalize_hindi_keywords(text)
    has_open_verb = bool(_LECTURE_OPEN_VERB_RE.search(normalised))

    class_name = extract_class_from_message(normalised)
    # chapter is only ever non-None when a chapter/lesson/lecture keyword + number
    # is present, so its presence already implies a chapter keyword.
    chapter = extract_chapter_from_message(normalised)

    full = bool(class_name and chapter)
    # Under-specified, but a verb makes the open-intent unambiguous. The verb gate
    # stops statements like "what is 5th grade math" or "chapter 5 was great" from
    # being treated as commands.
    missing_class = bool(chapter and not class_name and has_open_verb)
    missing_chapter = bool(class_name and not chapter and has_open_verb)

    if not (full or missing_class or missing_chapter):
        return None

    if missing_class:
        return {"_missing": "class", "chapter": chapter}
    if missing_chapter:
        return {"_missing": "chapter", "class_name": class_name,
                "class_num": _class_num_str(class_name)}

    chapter_key = f"chapter_{chapter}"
    catalog = _load_catalog()
    record = catalog.get(class_name, {}).get(chapter_key)
    class_num_str = _class_num_str(class_name)

    if not record:
        # Command parsed fully but no video is saved for that slot.
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


# ─── Notes command parser ───────────────────────────────────────────────────
# Recognises "give me notes for this session" / "Class 1 Chapter 2 notes" /
# "UKG chapter 1 notes" / Hindi "नोट्स". Runs as a pre-brain shortcut BEFORE the
# lecture-open shortcut so "class 1 chapter 2 notes" returns notes rather than
# opening the video.

_HINDI_NOTES_REPLACEMENTS = [
    (r"नोट्स", "notes"),
    (r"नोट", "notes"),
    (r"पीपीटी", "ppt"),
    (r"\bnotes\b", "notes"),
]

_NOTES_KEYWORD_RE = re.compile(
    r"\b(notes?|ppt|powerpoint|presentation|slides?)\b",
    re.IGNORECASE,
)

# A "lesson reference" — words that mean the student wants THIS lecture's notes
# rather than a general explainer. Used to avoid hijacking "give me notes on
# photosynthesis" (no lesson context) → that should fall through to the brain.
_SESSION_REF_RE = re.compile(
    r"\b(this|current|session|lesson|lecture|chapter|video|class|grade|std|standard|ukg)\b",
    re.IGNORECASE,
)


def _normalize_notes_keywords(text: str) -> str:
    out = text or ""
    for pattern, replacement in _HINDI_NOTES_REPLACEMENTS:
        out = re.sub(pattern, replacement, out, flags=re.IGNORECASE)
    return out


def is_notes_command(text: str) -> bool:
    """Fast gate — true only if the text mentions a notes/ppt/slides keyword."""
    if not text:
        return False
    normalised = _normalize_notes_keywords(_normalize_hindi_keywords(text))
    return bool(_NOTES_KEYWORD_RE.search(normalised))


def match_notes_command(text: str, pending_youtube: Optional[Dict] = None) -> Optional[Dict]:
    """Parse a notes command and resolve to a (class_name, chapter).

    Returns:
      None                          — not a notes command
      {"_missing": "class_chapter"} — notes keyword found but no class/chapter and
                                      no pending_youtube context
      {"class_name", "chapter", "class_num", "from_context": bool}  — success
    """
    if not is_notes_command(text):
        return None

    normalised = _normalize_notes_keywords(_normalize_hindi_keywords(text))
    class_name = extract_class_from_message(normalised)
    chapter = extract_chapter_from_message(normalised)

    if class_name and chapter:
        class_num = class_name.replace("class_", "").upper() if class_name != "UKG" else "UKG"
        return {
            "class_name": class_name,
            "chapter": chapter,
            "class_num": class_num,
            "from_context": False,
        }

    # Fall back to the lecture the student just watched.
    if pending_youtube and pending_youtube.get("video_id"):
        slot = _find_slot_by_video_id(pending_youtube["video_id"])
        if slot:
            cls, ch = slot
            class_num = cls.replace("class_", "").upper() if cls != "UKG" else "UKG"
            return {
                "class_name": cls,
                "chapter": ch,
                "class_num": class_num,
                "from_context": True,
            }

    # No class/chapter and no watched-lecture context. Only ask the student to
    # specify when they clearly want LESSON notes ("notes for this session/lesson");
    # a bare "give me notes on X" should fall through to the brain for a real answer.
    if _SESSION_REF_RE.search(normalised):
        return {"_missing": "class_chapter"}
    return None


# Log catalog size at import time so HF logs confirm the new code is live.
try:
    _initial = _load_catalog()
    _initial_count = sum(len(v) for v in _initial.values() if isinstance(v, dict))
    logger.info("[LECTURE] lecture_service loaded — %d lectures across %d classes", _initial_count, len(_initial))
except Exception as _e:
    logger.warning("[LECTURE] Initial catalog load failed: %s", _e)
