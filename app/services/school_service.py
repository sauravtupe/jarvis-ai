"""School identity store — Phase 1 of the AI Teacher platform.

Holds the ``School -> Class -> Division`` hierarchy that tells the teacher *who*
it is teaching. The **Division** is the unit of identity (and, from Phase 2, the
unit of memory/progress). Each division carries a ``preferred_language`` which is
fed straight into the Phase-0 teacher persona so the class is greeted and taught
in its own Marathi / Hindi / English.

Storage mirrors ``lecture_service``: a single JSON file (``database/schools.json``)
written atomically and synced to the durable backend (S3 / HF Dataset) so it
survives HF Space rebuilds. No Postgres yet — the JSON shape maps 1:1 onto the
relational tables planned for the auth/scale sub-phase, so nothing here is wasted.

Tree shape::

    {
      "schools": [
        {
          "id": "sch_xxxxxxxx", "name", "board", "city", "created_at", "updated_at",
          "classes": [
            {
              "id": "cls_xxxxxxxx", "grade": "5",
              "divisions": [
                {"id": "div_xxxxxxxx", "name": "A", "preferred_language": "mr", ...}
              ]
            }
          ]
        }
      ]
    }
"""

import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from config import SCHOOLS_JSON_PATH

logger = logging.getLogger("J.A.R.V.I.S")

_lock = threading.Lock()

# Valid grades: UKG + classes 1..12. Stored as the canonical token ("UKG" | "1" … "12").
_VALID_GRADES = ["UKG"] + [str(i) for i in range(1, 13)]
_VALID_LANGUAGES = ("en", "hi", "mr")
_STORAGE_KEY = "schools/schools.json"


class SchoolError(Exception):
    """Validation / lookup failure carrying an HTTP-friendly status code."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ─── Persistence (mirrors lecture_service) ──────────────────────────────────

def _empty() -> dict:
    return {"schools": []}


def _load() -> dict:
    """Read the store from disk. Returns an empty store if missing/malformed."""
    try:
        if not SCHOOLS_JSON_PATH.exists():
            return _empty()
        with open(SCHOOLS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("schools"), list):
            logger.warning("[SCHOOL] schools.json malformed — using empty store in memory")
            return _empty()
        return data
    except Exception as e:
        logger.warning("[SCHOOL] Failed to load schools.json: %s — using empty store", e)
        return _empty()


def _atomic_write(data: dict) -> None:
    """Write atomically (tmp + rename), then best-effort sync to the durable store.

    The durable sync is what makes the catalog survive HF Space rebuilds; its
    failure is logged but never blocks the local write.
    """
    SCHOOLS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SCHOOLS_JSON_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SCHOOLS_JSON_PATH)
    try:
        from app.services.storage_service import upload_bytes_to_s3
        payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        upload_bytes_to_s3(payload, _STORAGE_KEY, content_type="application/json")
    except Exception as e:
        logger.warning("[SCHOOL] Durable sync of schools.json failed: %s", e)


# ─── Helpers ────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _clean_text(value: Optional[str], field: str, required: bool, max_len: int) -> str:
    value = (value or "").strip()
    if required and not value:
        raise SchoolError(f"{field} is required", 422)
    if len(value) > max_len:
        raise SchoolError(f"{field} must be {max_len} characters or fewer", 422)
    return value


def _validate_grade(grade: str) -> str:
    grade = (grade or "").strip().upper()
    # Accept "class_5" / "5th" / "5" / "UKG" → canonical token.
    grade = re.sub(r"^CLASS[_\s]*", "", grade)
    grade = re.sub(r"(ST|ND|RD|TH)$", "", grade)
    if grade not in _VALID_GRADES:
        raise SchoolError("Grade must be UKG or a number from 1 to 12", 422)
    return grade


def _validate_language(language: str) -> str:
    language = (language or "en").strip().lower()
    if language not in _VALID_LANGUAGES:
        raise SchoolError("preferred_language must be one of: en, hi, mr", 422)
    return language


def grade_to_class_name(grade: str) -> str:
    """Map a division's grade token onto the lecture-catalog class name.

    "UKG" -> "UKG", "5" -> "class_5". Lets Phase 2 link a division to its
    lectures without duplicating the curriculum.
    """
    grade = (grade or "").strip().upper()
    return "UKG" if grade == "UKG" else f"class_{grade}"


def _find_school(data: dict, school_id: str) -> Optional[dict]:
    for s in data.get("schools", []):
        if isinstance(s, dict) and s.get("id") == school_id:
            return s
    return None


def _find_class(school: dict, class_id: str) -> Optional[dict]:
    for c in school.get("classes", []):
        if isinstance(c, dict) and c.get("id") == class_id:
            return c
    return None


def _find_division(klass: dict, division_id: str) -> Optional[dict]:
    for d in klass.get("divisions", []):
        if isinstance(d, dict) and d.get("id") == division_id:
            return d
    return None


def _grade_sort_key(grade: str) -> int:
    if grade == "UKG":
        return 0
    try:
        return int(grade)
    except (ValueError, TypeError):
        return 99


# ─── Public read API ────────────────────────────────────────────────────────

def list_schools() -> List[Dict]:
    """The full School -> Class -> Division tree (used by the picker + admin)."""
    data = _load()
    schools = [s for s in data.get("schools", []) if isinstance(s, dict)]
    for s in schools:
        classes = [c for c in s.get("classes", []) if isinstance(c, dict)]
        classes.sort(key=lambda c: _grade_sort_key(c.get("grade", "")))
        for c in classes:
            c.setdefault("divisions", [])
            c["divisions"] = [d for d in c["divisions"] if isinstance(d, dict)]
            c["divisions"].sort(key=lambda d: str(d.get("name", "")))
        s["classes"] = classes
    schools.sort(key=lambda s: str(s.get("name", "")).lower())
    return schools


def get_division(division_id: str) -> Optional[Dict]:
    """Resolve a division id to its full context, or None if not found.

    Returns a flat dict the teacher engine can consume directly::

        {school_id, school_name, class_id, grade, grade_label, class_name,
         division_id, division_name, preferred_language}
    """
    if not division_id:
        return None
    data = _load()
    for school in data.get("schools", []):
        if not isinstance(school, dict):
            continue
        for klass in school.get("classes", []):
            if not isinstance(klass, dict):
                continue
            div = _find_division(klass, division_id)
            if div:
                grade = klass.get("grade", "")
                grade_label = "UKG" if grade == "UKG" else f"Class {grade}"
                return {
                    "school_id": school.get("id", ""),
                    "school_name": school.get("name", ""),
                    "class_id": klass.get("id", ""),
                    "grade": grade,
                    "grade_label": grade_label,
                    "class_name": grade_to_class_name(grade),
                    "division_id": div.get("id", ""),
                    "division_name": div.get("name", ""),
                    "preferred_language": div.get("preferred_language", "en"),
                }
    return None


# ─── Admin CRUD ──────────────────────────────────────────────────────────────

def add_school(name: str, board: str = "", city: str = "") -> Dict:
    name = _clean_text(name, "School name", required=True, max_len=120)
    board = _clean_text(board, "Board", required=False, max_len=120)
    city = _clean_text(city, "City", required=False, max_len=120)
    with _lock:
        data = _load()
        now = _now()
        school = {
            "id": _new_id("sch"),
            "name": name,
            "board": board,
            "city": city,
            "created_at": now,
            "updated_at": now,
            "classes": [],
        }
        data["schools"].append(school)
        _atomic_write(data)
    logger.info("[SCHOOL] Added school '%s' (%s)", name, school["id"])
    return school


def delete_school(school_id: str) -> None:
    with _lock:
        data = _load()
        before = len(data["schools"])
        data["schools"] = [s for s in data["schools"] if s.get("id") != school_id]
        if len(data["schools"]) == before:
            raise SchoolError("School not found", 404)
        _atomic_write(data)
    logger.info("[SCHOOL] Deleted school %s", school_id)


def add_class(school_id: str, grade: str) -> Dict:
    grade = _validate_grade(grade)
    with _lock:
        data = _load()
        school = _find_school(data, school_id)
        if not school:
            raise SchoolError("School not found", 404)
        school.setdefault("classes", [])
        if any(c.get("grade") == grade for c in school["classes"]):
            raise SchoolError(f"This school already has a {grade if grade == 'UKG' else 'Class ' + grade}", 409)
        klass = {"id": _new_id("cls"), "grade": grade, "divisions": []}
        school["classes"].append(klass)
        school["updated_at"] = _now()
        _atomic_write(data)
    logger.info("[SCHOOL] Added class %s to school %s", grade, school_id)
    return klass


def delete_class(school_id: str, class_id: str) -> None:
    with _lock:
        data = _load()
        school = _find_school(data, school_id)
        if not school:
            raise SchoolError("School not found", 404)
        before = len(school.get("classes", []))
        school["classes"] = [c for c in school.get("classes", []) if c.get("id") != class_id]
        if len(school["classes"]) == before:
            raise SchoolError("Class not found", 404)
        school["updated_at"] = _now()
        _atomic_write(data)
    logger.info("[SCHOOL] Deleted class %s from school %s", class_id, school_id)


def add_division(school_id: str, class_id: str, name: str, preferred_language: str = "en") -> Dict:
    name = _clean_text(name, "Division name", required=True, max_len=20)
    language = _validate_language(preferred_language)
    with _lock:
        data = _load()
        school = _find_school(data, school_id)
        if not school:
            raise SchoolError("School not found", 404)
        klass = _find_class(school, class_id)
        if not klass:
            raise SchoolError("Class not found", 404)
        klass.setdefault("divisions", [])
        if any(str(d.get("name", "")).lower() == name.lower() for d in klass["divisions"]):
            raise SchoolError(f"Division '{name}' already exists in this class", 409)
        now = _now()
        div = {
            "id": _new_id("div"),
            "name": name,
            "preferred_language": language,
            "created_at": now,
            "updated_at": now,
        }
        klass["divisions"].append(div)
        school["updated_at"] = now
        _atomic_write(data)
    logger.info("[SCHOOL] Added division '%s' (%s) to class %s", name, language, class_id)
    return div


def delete_division(school_id: str, class_id: str, division_id: str) -> None:
    with _lock:
        data = _load()
        school = _find_school(data, school_id)
        if not school:
            raise SchoolError("School not found", 404)
        klass = _find_class(school, class_id)
        if not klass:
            raise SchoolError("Class not found", 404)
        before = len(klass.get("divisions", []))
        klass["divisions"] = [d for d in klass.get("divisions", []) if d.get("id") != division_id]
        if len(klass["divisions"]) == before:
            raise SchoolError("Division not found", 404)
        school["updated_at"] = _now()
        _atomic_write(data)
    logger.info("[SCHOOL] Deleted division %s from class %s", division_id, class_id)


# NOTE: per-division curriculum progress (current chapter, completions, revisions)
# lives in app/services/progress_service.py — this module stays pure identity.

# Log store size at import so HF logs confirm the new code is live.
try:
    _initial = _load()
    _sc = len(_initial.get("schools", []))
    _dc = sum(
        len(c.get("divisions", []))
        for s in _initial.get("schools", []) if isinstance(s, dict)
        for c in s.get("classes", []) if isinstance(c, dict)
    )
    logger.info("[SCHOOL] school_service loaded — %d schools, %d divisions", _sc, _dc)
except Exception as _e:
    logger.warning("[SCHOOL] Initial store load failed: %s", _e)
