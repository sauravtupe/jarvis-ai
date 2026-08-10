"""Tests for the TTS audio cache (Workstream B2).

Runs standalone (`python tests/test_tts_cache.py`) or under pytest.

The dangerous failure mode for an audio cache is not a miss — it is a *wrong hit*:
serving Marathi audio for a Hindi reply, or stale audio after a voice change. Most of
these tests exist to pin that down.
"""

import atexit
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import tts_cache  # noqa: E402

# Redirect the disk tier at import time, BEFORE any test runs. These tests call
# clear(disk=True), which would otherwise delete the real prebaked canned lines under
# database/tts_cache/ and silently cost the next server start ~24s of resynthesis.
_TMP_CACHE_DIR = Path(tempfile.mkdtemp(prefix="jarvis-tts-cache-test-"))
tts_cache._CACHE_DIR = _TMP_CACHE_DIR
atexit.register(shutil.rmtree, _TMP_CACHE_DIR, True)

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  [PASS] {name}")
    else:
        print(f"  [FAIL] {name} {detail}")
        _failures.append(name)


def _fresh():
    tts_cache.clear(disk=True)


# ─── Key correctness — the wrong-hit failure mode ────────────────────────────

def test_key_separates_voice():
    _fresh()
    k_hi = tts_cache.cache_key("नमस्ते", "hi-IN-MadhurNeural", "+12%")
    k_mr = tts_cache.cache_key("नमस्ते", "mr-IN-ManoharNeural", "+12%")
    check("same Devanagari text, different voice -> different key", k_hi != k_mr)


def test_key_separates_rate_and_gain():
    k1 = tts_cache.cache_key("hello", "en-IN-PrabhatNeural", "+12%")
    k2 = tts_cache.cache_key("hello", "en-IN-PrabhatNeural", "+22%")
    k3 = tts_cache.cache_key("hello", "en-IN-PrabhatNeural", "+12%", gain=1.5)
    check("different rate -> different key", k1 != k2)
    check("different gain -> different key", k1 != k3)


def test_key_is_stable_and_whitespace_tolerant():
    k1 = tts_cache.cache_key("  hello  ", "v", "+12%")
    k2 = tts_cache.cache_key("hello", "v", "+12%")
    check("surrounding whitespace does not change the key", k1 == k2)


def test_no_cross_voice_contamination():
    """A cached Hindi clip must never be served for the Marathi request."""
    _fresh()
    hi, _ = tts_cache.synthesize_cached(
        "नमस्ते", "hi-IN-MadhurNeural", "+12%", 1.0, lambda: b"HINDI_AUDIO")
    mr, cached = tts_cache.synthesize_cached(
        "नमस्ते", "mr-IN-ManoharNeural", "+12%", 1.0, lambda: b"MARATHI_AUDIO")
    check("Marathi request is a MISS despite identical text", not cached)
    check("Marathi request gets Marathi audio", mr == b"MARATHI_AUDIO",
          f"got {mr!r}")
    check("Hindi entry is untouched", hi == b"HINDI_AUDIO")


# ─── Hit / miss behaviour ────────────────────────────────────────────────────

def test_hit_returns_identical_bytes():
    _fresh()
    calls = []

    def gen():
        calls.append(1)
        return b"AUDIO-BYTES"

    a, cached_a = tts_cache.synthesize_cached("hi there", "v", "+12%", 1.0, gen)
    b, cached_b = tts_cache.synthesize_cached("hi there", "v", "+12%", 1.0, gen)
    check("first call is a miss", not cached_a)
    check("second call is a hit", cached_b)
    check("hit returns identical bytes", a == b == b"AUDIO-BYTES")
    check("generator ran exactly once", len(calls) == 1, f"ran {len(calls)}x")


def test_failed_synthesis_is_not_cached():
    """An empty result means TTS failed. Caching it would make the failure permanent."""
    _fresh()
    out, _ = tts_cache.synthesize_cached("boom", "v", "+12%", 1.0, lambda: b"")
    check("failed synthesis returns empty", out == b"")
    check("failure is NOT cached", tts_cache.get("boom", "v", "+12%") is None)

    good, cached = tts_cache.synthesize_cached("boom", "v", "+12%", 1.0, lambda: b"OK")
    check("a later success still works after a failure", good == b"OK" and not cached)


# ─── Bounded memory ──────────────────────────────────────────────────────────

def test_lru_eviction_respects_byte_cap():
    _fresh()
    original = tts_cache._MEM_MAX_BYTES
    tts_cache._MEM_MAX_BYTES = 1000
    try:
        for i in range(5):
            tts_cache.synthesize_cached(f"line-{i}", "v", "+12%", 1.0, lambda: b"x" * 400)
        stats = tts_cache.stats()
        check("memory stays under the cap", stats["bytes"] <= 1000,
              f"bytes={stats['bytes']}")
        check("oldest entry was evicted", tts_cache.get("line-0", "v", "+12%") is None)
        check("newest entry survives", tts_cache.get("line-4", "v", "+12%") is not None)
    finally:
        tts_cache._MEM_MAX_BYTES = original


# ─── Single-flight ───────────────────────────────────────────────────────────

def test_concurrent_identical_requests_synthesize_once():
    """A whole division saying 'start the class' at once must not fire N Azure calls."""
    _fresh()
    calls = []
    start = threading.Barrier(8)

    def gen():
        calls.append(1)
        time.sleep(0.25)          # simulate the Azure round-trip
        return b"SHARED-AUDIO"

    results = []

    def worker():
        start.wait()
        audio, _ = tts_cache.synthesize_cached("start the class", "v", "+12%", 1.0, gen)
        results.append(audio)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    check("all 8 callers got audio", len(results) == 8, f"got {len(results)}")
    check("all 8 got the same bytes", all(r == b"SHARED-AUDIO" for r in results))
    check("synthesized once, not 8 times", len(calls) == 1, f"ran {len(calls)}x")


# ─── Disk tier ───────────────────────────────────────────────────────────────

def test_pinned_entries_survive_memory_clear():
    _fresh()
    tts_cache.synthesize_cached("canned line", "v", "+12%", 1.0, lambda: b"PINNED", pin=True)
    tts_cache.clear(disk=False)          # simulate a process restart
    check("memory tier is empty after clear", tts_cache.stats()["entries"] == 0)
    restored = tts_cache.get("canned line", "v", "+12%")
    check("pinned entry is restored from disk", restored == b"PINNED", f"got {restored!r}")
    check("restored entry is promoted back into memory",
          tts_cache.stats()["entries"] == 1)


def test_unpinned_entries_do_not_touch_disk():
    _fresh()
    tts_cache.synthesize_cached("ephemeral", "v", "+12%", 1.0, lambda: b"TEMP")
    tts_cache.clear(disk=False)
    check("unpinned entry is gone after restart",
          tts_cache.get("ephemeral", "v", "+12%") is None)


def test_prewarm_skips_already_cached():
    _fresh()
    calls = []

    def gen(text, voice, rate):
        calls.append(text)
        return b"PREBAKED"

    entries = [("line one", "v", "+12%"), ("line two", "v", "+12%")]
    made_first = tts_cache.prewarm(entries, gen)
    made_second = tts_cache.prewarm(entries, gen)
    check("first prewarm synthesizes both", made_first == 2, f"made {made_first}")
    check("second prewarm synthesizes nothing", made_second == 0, f"made {made_second}")
    check("generator ran twice total", len(calls) == 2, f"ran {len(calls)}x")


def test_prewarm_survives_a_failing_entry():
    _fresh()

    def gen(text, voice, rate):
        if "bad" in text:
            raise RuntimeError("azure exploded")
        return b"OK"

    made = tts_cache.prewarm(
        [("bad line", "v", "+12%"), ("good line", "v", "+12%")], gen)
    check("a failing entry does not abort the prewarm", made == 1, f"made {made}")
    check("the good entry is cached", tts_cache.get("good line", "v", "+12%") == b"OK")


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]


def main():
    print("TTS cache tests")
    print("=" * 52)
    for fn in TESTS:
        print(f"\n{fn.__name__}:")
        try:
            fn()
        except Exception as e:
            print(f"  [ERROR] {fn.__name__}: {e}")
            _failures.append(fn.__name__)
    tts_cache.clear(disk=True)
    print("\n" + "=" * 52)
    if _failures:
        print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("All TTS cache checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
