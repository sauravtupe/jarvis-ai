"""Division progress store — Phase 2 of the AI Teacher platform.

Remembers where each classroom is in the AI curriculum: which chapter is currently
open, which chapters are completed, when the class was last active, and how many
times a chapter has been revised. This is what lets the teacher say *"Last class we
learned X — any doubts before we continue?"* and open the **next uncompleted**
lesson instead of blindly walking chapter numbers.

Keyed by ``division_id`` — never by an individual student (an explicit product
decision). Mirrors lecture_service / school_service: one JSON file, atomic write,
best-effort sync to the durable backend so it survives HF Space rebuilds. The shape
maps 1:1 onto the planned Postgres tables (``division_progress`` +
``chapter_completions``) for the auth/scale phase.

Shape::

    {"divisions": {
        "div_xxx": {
            "current_chapter": 2,
            "last_active_at": "…",
            "completed": [{"chapter": 1, "title": "…", "completed_at": "…", "revision_count": 0}]
        }
    }}
"""

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

from config import PROGRESS_JSON_PATH

logger = logging.getLogger("J.A.R.V.I.S")

_lock = threading.Lock()
_STORAGE_KEY = "progress/division_progress.json"


def _empty() -> dict:
    return {"divisions": {}}


def _load() -> dict:
    try:
        if not PROGRESS_JSON_PATH.exists():
            return _empty()
        with open(PROGRESS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("divisions"), dict):
            logger.warning("[PROGRESS] division_progress.json malformed — using empty store")
            return _empty()
        return data
    except Exception as e:
        logger.warning("[PROGRESS] Failed to load division_progress.json: %s — using empty store", e)
        return _empty()


def _atomic_write(data: dict) -> None:
    PROGRESS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROGRESS_JSON_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, PROGRESS_JSON_PATH)
    # Durable sync runs OFF the request path: progress is written locally above (that's
    # the source of truth for this container), and the S3/HF copy is only the
    # rebuild-survival backup. Uploading inline added ~1s to every "start the lecture".
    payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    _sync_durable_async(payload)


def _sync_durable_async(payload: bytes) -> None:
    def _upload():
        try:
            from app.services.storage_service import upload_bytes_to_s3
            upload_bytes_to_s3(payload, _STORAGE_KEY, content_type="application/json")
        except Exception as e:
            logger.warning("[PROGRESS] Durable sync of division_progress.json failed: %s", e)
    threading.Thread(target=_upload, daemon=True).start()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _blank_record() -> dict:
    return {"current_chapter": None, "last_active_at": "", "completed": []}


# ─── Read API ────────────────────────────────────────────────────────────────

def get_progress(division_id: str) -> Dict:
    """Progress record for a division (a blank record if it has never met)."""
    if not division_id:
        return _blank_record()
    rec = _load().get("divisions", {}).get(division_id)
    if not isinstance(rec, dict):
        return _blank_record()
    out = _blank_record()
    out.update(rec)
    if not isinstance(out.get("completed"), list):
        out["completed"] = []
    return out


def completed_chapters(division_id: str) -> List[int]:
    """Sorted chapter numbers this division has completed."""
    return sorted(
        c["chapter"] for c in get_progress(division_id)["completed"]
        if isinstance(c, dict) and isinstance(c.get("chapter"), int)
    )


def is_completed(division_id: str, chapter: int) -> bool:
    return chapter in completed_chapters(division_id)


# ─── Write API ───────────────────────────────────────────────────────────────

def _mutate(division_id: str, fn) -> bool:
    """Apply fn(record) under the lock and persist. Returns True if written."""
    if not division_id:
        return False
    with _lock:
        data = _load()
        rec = data["divisions"].get(division_id)
        if not isinstance(rec, dict):
            rec = _blank_record()
        rec.setdefault("completed", [])
        fn(rec)
        rec["last_active_at"] = _now()
        data["divisions"][division_id] = rec
        _atomic_write(data)
    return True


def record_opened(division_id: str, chapter: int, title: str = "") -> bool:
    """Mark a chapter as the one currently being taught."""
    def _fn(rec):
        rec["current_chapter"] = int(chapter)
        rec["current_title"] = title or ""
    ok = _mutate(division_id, _fn)
    if ok:
        logger.info("[PROGRESS] div %s → now on chapter %s", division_id, chapter)
    return ok


def mark_complete(division_id: str, chapter: int, title: str = "") -> bool:
    """Record a chapter as completed (idempotent — re-marking never duplicates)."""
    def _fn(rec):
        for c in rec["completed"]:
            if isinstance(c, dict) and c.get("chapter") == chapter:
                return  # already completed
        rec["completed"].append({
            "chapter": int(chapter),
            "title": title or "",
            "completed_at": _now(),
            "revision_count": 0,
        })
        rec["completed"].sort(key=lambda c: c.get("chapter", 0))
    ok = _mutate(division_id, _fn)
    if ok:
        logger.info("[PROGRESS] div %s completed chapter %s", division_id, chapter)
    return ok


def record_assessment(division_id: str, chapter: Optional[int], kind: str) -> bool:
    """Log a classroom assessment activity (quiz/worksheet/homework/…).

    Participation only — no individual student scores are ever stored (a product
    decision). Just a lightweight audit that the activity happened.
    """
    def _fn(rec):
        rec.setdefault("sessions", [])
        rec["sessions"].append({"kind": kind, "chapter": chapter, "at": _now()})
        rec["sessions"] = rec["sessions"][-100:]  # cap history
    ok = _mutate(division_id, _fn)
    if ok:
        logger.info("[PROGRESS] div %s ran %s on chapter %s", division_id, kind, chapter)
    return ok


def record_revision(division_id: str, chapter: int) -> bool:
    """Bump the revision counter for an already-completed chapter."""
    def _fn(rec):
        for c in rec["completed"]:
            if isinstance(c, dict) and c.get("chapter") == chapter:
                c["revision_count"] = int(c.get("revision_count", 0)) + 1
                return
    return _mutate(division_id, _fn)


def reset_progress(division_id: str) -> bool:
    """Wipe a division's progress (admin action — used to restart a syllabus)."""
    with _lock:
        data = _load()
        if division_id in data.get("divisions", {}):
            del data["divisions"][division_id]
            _atomic_write(data)
            logger.info("[PROGRESS] Reset progress for div %s", division_id)
            return True
    return False


# ─── Curriculum-aware helpers ────────────────────────────────────────────────
# `chapters` is the list from lecture_service.list_lectures_for_class() — passed in
# by the caller so this module stays decoupled from the lecture catalog.

def next_uncompleted(division_id: str, chapters: List[Dict], after: Optional[int] = None) -> Optional[Dict]:
    """First chapter not yet completed (optionally strictly after a chapter number)."""
    done = set(completed_chapters(division_id))
    for ch in chapters:
        n = ch.get("chapter")
        if n in done:
            continue
        if after is not None and n <= after:
            continue
        return ch
    return None


def resolve_target(division_id: str, chapters: List[Dict], action: str) -> Optional[Dict]:
    """Pick the chapter to open for a 'start' (resume) or 'next' (advance) command.

    start → resume the chapter in progress if it isn't finished, else the first
            uncompleted one.
    next  → the first uncompleted chapter *after* the current one.
    Returns None when every uploaded chapter is complete.
    """
    if not chapters:
        return None
    prog = get_progress(division_id)
    current = prog.get("current_chapter")
    if action == "next":
        return next_uncompleted(division_id, chapters, after=current or 0)
    if isinstance(current, int) and not is_completed(division_id, current):
        for ch in chapters:
            if ch.get("chapter") == current:
                return ch
    return next_uncompleted(division_id, chapters)


def build_context_lines(division_id: str, chapters: List[Dict]) -> str:
    """Progress facts for the teacher prompt — enables the Day-2 recap.

    Produces lines the persona can speak naturally ("Last class we learned X…"),
    never raw data. Returns "" when there is nothing meaningful to say.
    """
    if not division_id:
        return ""
    prog = get_progress(division_id)
    done = [c for c in prog["completed"] if isinstance(c, dict)]
    lines = []
    if done:
        last = done[-1]
        lines.append(
            f"- Lessons completed so far: {len(done)} "
            f"(most recently Chapter {last.get('chapter')} — \"{last.get('title', '')}\")."
        )
    else:
        lines.append("- This class has not completed any AI lesson yet — treat it as their first lesson.")
    nxt = next_uncompleted(division_id, chapters)
    if nxt:
        lines.append(f"- Next lesson to teach: Chapter {nxt.get('chapter')} — \"{nxt.get('title', '')}\".")
    elif chapters:
        lines.append("- The class has completed every uploaded AI lesson. Congratulate them and offer revision.")
    else:
        lines.append("- No AI lectures have been uploaded for this class yet.")
    return "\n".join(lines)


def summary(division_id: str, chapters: List[Dict]) -> Dict:
    """Compact progress snapshot for the API / classroom pill."""
    prog = get_progress(division_id)
    done = [c for c in prog["completed"] if isinstance(c, dict)]
    nxt = next_uncompleted(division_id, chapters)
    return {
        "division_id": division_id,
        "total_chapters": len(chapters),
        "completed_count": len(done),
        "completed_chapters": [c.get("chapter") for c in done],
        "current_chapter": prog.get("current_chapter"),
        "next_chapter": nxt.get("chapter") if nxt else None,
        "next_title": nxt.get("title", "") if nxt else "",
        "last_active_at": prog.get("last_active_at", ""),
        "assessments_count": len(prog.get("sessions", []) if isinstance(prog.get("sessions"), list) else []),
    }
