"""TTS audio cache — Workstream B2.

Synthesizing one sentence through Azure costs ~400-450 ms of round-trip. A large
share of what the teacher says is *constant*: the canned lecture/revision/practice
replies in ``chat_service`` are fixed strings, so re-synthesizing them on every
lesson pays that round-trip for audio we already have, byte for byte.

Two tiers:

* **Memory (LRU, byte-capped)** — covers every synthesis, including LLM sentences
  that happen to repeat inside a running process. Cheap, bounded, no I/O.
* **Disk (pinned only)** — canned strings prebaked at startup, under
  ``database/tts_cache/``. Only *pinned* entries are written, because dynamic LLM
  sentences virtually never recur across a restart; persisting them would churn
  the disk for a ~0 % hit rate.

A **single-flight** guard means N concurrent requests for the same uncached
sentence trigger one synthesis, not N — the realistic classroom case where a whole
division sends "start the class" at once.

The cache is keyed on *everything that changes the bytes*: text, voice, rate and
volume gain. A voice or rate change therefore misses cleanly rather than serving
audio in the wrong voice.
"""

import hashlib
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Memory tier. ~48 MB holds roughly 1500 short sentences at Azure's
# 48 kbit/s mono mp3 (~8 KB/s of speech), which is far more than one lesson needs.
_MEM_MAX_BYTES = int(os.getenv("TTS_CACHE_MEM_MB", "48")) * 1024 * 1024

_CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "database" / "tts_cache"

# key -> mp3 bytes, in LRU order (oldest first).
_mem: "OrderedDict[str, bytes]" = OrderedDict()
_mem_bytes = 0
_lock = threading.Lock()

# key -> Event, for single-flight. Guarded by _lock.
_inflight: Dict[str, threading.Event] = {}

_stats = {"hits": 0, "misses": 0, "pinned": 0, "coalesced": 0}


def cache_key(text: str, voice: str, rate: str, gain: float = 1.0) -> str:
    """Stable key over every input that can change the synthesized bytes."""
    h = hashlib.sha256()
    h.update((text or "").strip().encode("utf-8"))
    h.update(b"\x00")
    h.update((voice or "").encode("utf-8"))
    h.update(b"\x00")
    h.update((rate or "").encode("utf-8"))
    h.update(b"\x00")
    h.update(f"{gain:.3f}".encode("ascii"))
    return h.hexdigest()


# ─── Memory tier ─────────────────────────────────────────────────────────────

def _mem_get(key: str) -> Optional[bytes]:
    with _lock:
        audio = _mem.get(key)
        if audio is not None:
            _mem.move_to_end(key)  # mark as most-recently-used
        return audio


def _mem_put(key: str, audio: bytes) -> None:
    global _mem_bytes
    if not audio:
        return
    with _lock:
        if key in _mem:
            _mem_bytes -= len(_mem[key])
            del _mem[key]
        _mem[key] = audio
        _mem_bytes += len(audio)
        # Evict least-recently-used until back under the cap.
        while _mem_bytes > _MEM_MAX_BYTES and _mem:
            _, evicted = _mem.popitem(last=False)
            _mem_bytes -= len(evicted)


# ─── Disk tier (pinned canned lines only) ────────────────────────────────────

def _disk_path(key: str) -> Path:
    return _CACHE_DIR / f"{key}.mp3"


def _disk_get(key: str) -> Optional[bytes]:
    path = _disk_path(key)
    try:
        if path.is_file() and path.stat().st_size > 0:
            return path.read_bytes()
    except OSError as e:
        logger.warning("[TTS-CACHE] Disk read failed for %s: %s", key[:8], e)
    return None


def _disk_put(key: str, audio: bytes) -> None:
    """Write atomically so a crash mid-write can never leave a truncated mp3."""
    if not audio:
        return
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _disk_path(key).with_suffix(".tmp")
        tmp.write_bytes(audio)
        os.replace(tmp, _disk_path(key))
    except OSError as e:
        logger.warning("[TTS-CACHE] Disk write failed for %s: %s", key[:8], e)


# ─── Public API ──────────────────────────────────────────────────────────────

def get(text: str, voice: str, rate: str, gain: float = 1.0) -> Optional[bytes]:
    """Return cached audio, checking memory then the pinned disk tier."""
    key = cache_key(text, voice, rate, gain)
    audio = _mem_get(key)
    if audio is not None:
        return audio
    audio = _disk_get(key)
    if audio is not None:
        _mem_put(key, audio)  # promote so the next hit skips the disk entirely
        return audio
    return None


def synthesize_cached(
    text: str,
    voice: str,
    rate: str,
    gain: float,
    generator: Callable[[], bytes],
    pin: bool = False,
) -> Tuple[bytes, bool]:
    """Return ``(audio, was_cached)``, synthesizing via ``generator`` only on a miss.

    Concurrent callers asking for the same key wait for the first one's result
    instead of firing duplicate Azure requests.
    """
    key = cache_key(text, voice, rate, gain)

    cached = _mem_get(key)
    if cached is None:
        cached = _disk_get(key)
        if cached is not None:
            _mem_put(key, cached)
    if cached is not None:
        with _lock:
            _stats["hits"] += 1
        return cached, True

    # Single-flight: either we own this key's synthesis, or we wait on the owner.
    with _lock:
        event = _inflight.get(key)
        owner = event is None
        if owner:
            event = threading.Event()
            _inflight[key] = event
        else:
            _stats["coalesced"] += 1

    if not owner:
        # Bounded wait — never block a request forever on a wedged synthesis.
        event.wait(timeout=30)
        waited = _mem_get(key)
        if waited is not None:
            with _lock:
                _stats["hits"] += 1
            return waited, True
        # Owner failed or timed out; fall through and synthesize ourselves.

    try:
        audio = generator() or b""
        if audio:
            _mem_put(key, audio)
            if pin:
                _disk_put(key, audio)
        with _lock:
            _stats["misses"] += 1
        return audio, False
    finally:
        if owner:
            with _lock:
                _inflight.pop(key, None)
            event.set()


def prewarm(entries, generator: Callable[[str, str, str], bytes], gain: float = 1.0) -> int:
    """Prebake ``(text, voice, rate)`` triples into the pinned disk tier.

    Already-cached entries are skipped, so restarts are effectively free. Returns
    the number of entries newly synthesized. Intended to run in a background
    thread at startup — it must never delay serving.
    """
    made = 0
    for text, voice, rate in entries:
        if not text or not text.strip():
            continue
        key = cache_key(text, voice, rate, gain)
        if _mem_get(key) is not None:
            continue
        disk = _disk_get(key)
        if disk is not None:
            _mem_put(key, disk)
            with _lock:
                _stats["pinned"] += 1
            continue
        try:
            audio = generator(text, voice, rate)
        except Exception as e:
            logger.warning("[TTS-CACHE] Prewarm failed for %r: %s", text[:40], e)
            continue
        if audio:
            _mem_put(key, audio)
            _disk_put(key, audio)
            made += 1
            with _lock:
                _stats["pinned"] += 1
    return made


def stats() -> Dict:
    with _lock:
        total = _stats["hits"] + _stats["misses"]
        return {
            **_stats,
            "entries": len(_mem),
            "bytes": _mem_bytes,
            "hit_rate": round(_stats["hits"] / total, 3) if total else 0.0,
        }


def clear(disk: bool = False) -> None:
    """Drop the memory tier; optionally the pinned disk tier too (tests/admin)."""
    global _mem_bytes
    with _lock:
        _mem.clear()
        _mem_bytes = 0
    if disk and _CACHE_DIR.is_dir():
        for f in _CACHE_DIR.glob("*.mp3"):
            try:
                f.unlink()
            except OSError:
                pass
