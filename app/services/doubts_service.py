"""Division doubts log — Phase 3 of the AI Teacher platform.

Remembers the questions a classroom raised during lessons and whether they've been
resolved, so the teacher can open the next session with *"last time you asked about
X — is that clear now?"*. Keyed by ``division_id`` (never by student), persisted to
the durable backend like the rest of the AI-Teacher stores. Maps 1:1 onto the
planned ``division_doubts`` Postgres table.

Shape::

    {"divisions": {"div_xxx": [
        {"id": "dbt_xxxx", "chapter": 2, "text": "…", "asked_at": "…",
         "resolved": false, "resolved_at": ""}
    ]}}
"""

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from config import DOUBTS_JSON_PATH

logger = logging.getLogger("J.A.R.V.I.S")

_lock = threading.Lock()
_STORAGE_KEY = "doubts/division_doubts.json"
_MAX_TEXT = 500
_MAX_PER_DIVISION = 500


def _empty() -> dict:
    return {"divisions": {}}


def _load() -> dict:
    try:
        if not DOUBTS_JSON_PATH.exists():
            return _empty()
        with open(DOUBTS_JSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("divisions"), dict):
            logger.warning("[DOUBTS] division_doubts.json malformed — using empty store")
            return _empty()
        return data
    except Exception as e:
        logger.warning("[DOUBTS] Failed to load division_doubts.json: %s — using empty store", e)
        return _empty()


def _atomic_write(data: dict) -> None:
    DOUBTS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = DOUBTS_JSON_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DOUBTS_JSON_PATH)
    # Durable sync off the request path — a logged doubt must not delay the teacher's
    # reply. The local write above is the source of truth; S3/HF is the backup copy.
    payload = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")

    def _upload():
        try:
            from app.services.storage_service import upload_bytes_to_s3
            upload_bytes_to_s3(payload, _STORAGE_KEY, content_type="application/json")
        except Exception as e:
            logger.warning("[DOUBTS] Durable sync of division_doubts.json failed: %s", e)
    threading.Thread(target=_upload, daemon=True).start()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Read API ────────────────────────────────────────────────────────────────

def list_doubts(division_id: str, only_open: bool = False) -> List[Dict]:
    """All doubts for a division (newest last). ``only_open`` filters resolved out."""
    if not division_id:
        return []
    items = _load().get("divisions", {}).get(division_id, [])
    items = [d for d in items if isinstance(d, dict)]
    if only_open:
        items = [d for d in items if not d.get("resolved")]
    return items


def open_count(division_id: str) -> int:
    return len(list_doubts(division_id, only_open=True))


def recap_lines(division_id: str, limit: int = 3) -> str:
    """Open-doubt lines for the teacher's recap context. "" when none are open."""
    open_ds = list_doubts(division_id, only_open=True)
    if not open_ds:
        return ""
    recent = open_ds[-limit:]
    bullets = "; ".join(f"\"{d.get('text', '').strip()}\"" for d in recent if d.get("text"))
    if not bullets:
        return ""
    return (f"- Unresolved doubts this class has raised (address them warmly when relevant): {bullets}.")


# ─── Write API ───────────────────────────────────────────────────────────────

def record_doubt(division_id: str, chapter: Optional[int], text: str) -> Optional[Dict]:
    """Log a new doubt. Returns the stored record, or None if invalid."""
    if not division_id:
        return None
    text = (text or "").strip()[:_MAX_TEXT]
    if not text:
        return None
    rec = {
        "id": f"dbt_{uuid.uuid4().hex[:8]}",
        "chapter": chapter,
        "text": text,
        "asked_at": _now(),
        "resolved": False,
        "resolved_at": "",
    }
    with _lock:
        data = _load()
        lst = data["divisions"].setdefault(division_id, [])
        lst.append(rec)
        del lst[:-_MAX_PER_DIVISION]  # cap
        _atomic_write(data)
    logger.info("[DOUBTS] div %s logged doubt on chapter %s", division_id, chapter)
    return rec


def resolve_doubt(division_id: str, doubt_id: str) -> bool:
    """Mark a specific doubt resolved."""
    with _lock:
        data = _load()
        for d in data.get("divisions", {}).get(division_id, []):
            if isinstance(d, dict) and d.get("id") == doubt_id:
                d["resolved"] = True
                d["resolved_at"] = _now()
                _atomic_write(data)
                return True
    return False


def clear_doubts(division_id: str) -> bool:
    """Remove all doubts for a division (admin reset)."""
    with _lock:
        data = _load()
        if division_id in data.get("divisions", {}):
            del data["divisions"][division_id]
            _atomic_write(data)
            return True
    return False
