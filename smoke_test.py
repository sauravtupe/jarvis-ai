"""JARVIS pre-deploy smoke test.

Run this before EVERY deploy. It verifies syntax + every core feature
end-to-end against a running server.

    python smoke_test.py                 # against http://localhost:8000
    python smoke_test.py --prod          # against the live HF Space
    python smoke_test.py --base-url URL  # against any deployment
    python smoke_test.py --full          # adds slow checks: MCQ generation
                                         # (consumes 1 Supadata call) and
                                         # image-generation completion polling

Exit code 0 = all checks passed (SKIPs allowed), 1 = at least one FAIL.
"""

import argparse
import ast
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

PROD_URL = "https://saurav9404-jarvis-ai.hf.space"
ROOT = Path(__file__).resolve().parent

# Streamed chat answers can legitimately take a while on a cold cloud start.
CHAT_TIMEOUT = 120
RESULTS = []  # (name, status, detail, elapsed_ms)


def record(name, status, detail="", elapsed_ms=0):
    RESULTS.append((name, status, detail, int(elapsed_ms)))
    icon = {"PASS": "[PASS]", "FAIL": "[FAIL]", "SKIP": "[SKIP]"}[status]
    extra = f" - {detail}" if detail else ""
    print(f"  {icon} {name} ({int(elapsed_ms)} ms){extra}")


def check(name):
    """Decorator: time the check, catch exceptions as FAIL."""
    def wrap(fn):
        def run(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                status, detail = fn(*args, **kwargs)
            except Exception as e:
                status, detail = "FAIL", f"{type(e).__name__}: {e}"
            record(name, status, detail, (time.perf_counter() - t0) * 1000)
            return status
        return run
    return wrap


# ─── Static checks (no server needed) ───────────────────────────────────────

@check("Python syntax (app/ + config.py)")
def check_python_syntax():
    bad = []
    for py in [ROOT / "config.py", ROOT / "run.py", *sorted((ROOT / "app").rglob("*.py"))]:
        try:
            ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except SyntaxError as e:
            bad.append(f"{py.name}:{e.lineno}")
    if bad:
        return "FAIL", ", ".join(bad)
    return "PASS", ""


# Frontend JS files in their index.html load order. orb.js first (never touched),
# then the extracted feature modules, then script.js last (the foundation + init).
# Keep this list in sync with the <script> tags in frontend/index.html.
_FRONTEND_JS_LOAD_ORDER = ["orb.js", "tts.js", "script.js"]


@check("JS syntax + cross-file redeclaration")
def check_js_syntax():
    node = shutil.which("node")
    if not node:
        return "SKIP", "node not installed"
    fe = ROOT / "frontend"
    files = [fe / f for f in _FRONTEND_JS_LOAD_ORDER if (fe / f).exists()]
    # 1. Per-file syntax.
    for f in files:
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return "FAIL", f"{f.name}: " + (r.stderr or r.stdout).strip().splitlines()[-1][:100]
    # 2. Concatenated load-order check — catches a top-level let/const declared in
    #    two files (`Identifier already declared`) or a load-time TDZ reference, which
    #    per-file checks miss but the browser would hit. This is the safety net for
    #    the ordered-classic-<script> split (Phase 4).
    import tempfile, os as _os
    blob = "\n".join(f.read_text(encoding="utf-8") for f in files)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
    try:
        tmp.write(blob); tmp.close()
        r = subprocess.run([node, "--check", tmp.name], capture_output=True, text=True, timeout=30)
    finally:
        _os.unlink(tmp.name)
    if r.returncode != 0:
        return "FAIL", "concat: " + (r.stderr or r.stdout).strip().splitlines()[-1][:100]
    return "PASS", f"{len(files)} files + concat"


# ─── Server checks ───────────────────────────────────────────────────────────

def stream_chat(base, message, tts=False, session_id=None):
    """POST to the main endpoint, return the list of parsed SSE data events."""
    res = requests.post(
        f"{base}/chat/jarvis/stream",
        json={"message": message, "session_id": session_id, "tts": tts},
        timeout=CHAT_TIMEOUT,
    )
    res.raise_for_status()
    events = []
    for line in res.text.split("\n\n"):
        line = line.strip()
        if line.startswith("data: "):
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return events


@check("Health endpoint")
def check_health(base):
    r = requests.get(f"{base}/health", timeout=90)
    if r.status_code != 200:
        return "FAIL", f"HTTP {r.status_code}"
    body = r.json()
    if body.get("status") != "healthy":
        return "FAIL", f"status={body.get('status')}"
    return "PASS", ""


@check("Chat (text)")
def check_chat(base):
    events = stream_chat(base, "what is two plus two")
    text = "".join(e.get("chunk", "") for e in events)
    if not any(e.get("done") for e in events):
        return "FAIL", "no done event"
    if not text.strip():
        return "FAIL", "empty response text"
    return "PASS", f"{len(text)} chars"


@check("Chat (voice/TTS)")
def check_chat_tts(base):
    events = stream_chat(base, "say hello briefly", tts=True)
    audio = [e for e in events if e.get("audio")]
    if not audio:
        empty = [e for e in events if "audio" in e and not e.get("audio")]
        return "FAIL", f"no audio events ({len(empty)} empty audio events — backend TTS failing)"
    return "PASS", f"{len(audio)} audio chunk(s)"


@check("TTS direct endpoint")
def check_tts(base):
    r = requests.post(f"{base}/tts", json={"text": "Smoke test, Sir."}, timeout=60)
    if r.status_code != 200:
        return "FAIL", f"HTTP {r.status_code}"
    if len(r.content) < 1024:
        return "FAIL", f"audio too small ({len(r.content)} bytes)"
    return "PASS", f"{len(r.content)} bytes"


def check_lecture(base):
    """Returns (status, video_id, session_id) — video_id feeds the --full MCQ check."""
    t0 = time.perf_counter()
    video_id = session_id = None
    try:
        events = stream_chat(base, "open class 1 chapter 1")
        session_id = next((e["session_id"] for e in events if e.get("session_id")), None)
        yt = next((e["youtube_detected"] for e in events if e.get("youtube_detected")), None)
        if yt and yt.get("video_id"):
            video_id = yt["video_id"]
            status, detail = "PASS", f"video {video_id}"
        else:
            # No catalogued lecture (normal on a fresh local DB) — not a failure.
            status, detail = "SKIP", "no lecture catalogued for class 1 chapter 1"
    except Exception as e:
        status, detail = "FAIL", f"{type(e).__name__}: {e}"
    record("Lecture command", status, detail, (time.perf_counter() - t0) * 1000)
    return status, video_id, session_id


def check_image(base, poll=False):
    """Default: verify the task dispatches. --full: poll until completed."""
    t0 = time.perf_counter()
    try:
        events = stream_chat(base, "generate an image of a simple blue circle")
        tasks = next((e["background_tasks"] for e in events if e.get("background_tasks")), None)
        if not tasks:
            record("Image generation", "FAIL", "no background task dispatched",
                   (time.perf_counter() - t0) * 1000)
            return
        if not poll:
            record("Image generation (dispatch)", "PASS", f"task {tasks[0]['task_id']}",
                   (time.perf_counter() - t0) * 1000)
            return
        task_id = tasks[0]["task_id"]
        deadline = time.time() + 120
        status = "pending"
        while time.time() < deadline and status in ("pending", "running"):
            time.sleep(5)
            status = requests.get(f"{base}/tasks/{task_id}", timeout=30).json().get("status")
        if status == "completed":
            record("Image generation (full)", "PASS", "", (time.perf_counter() - t0) * 1000)
        else:
            record("Image generation (full)", "FAIL", f"status={status}",
                   (time.perf_counter() - t0) * 1000)
    except Exception as e:
        record("Image generation", "FAIL", f"{type(e).__name__}: {e}",
               (time.perf_counter() - t0) * 1000)


def check_quiz(base, video_id, session_id):
    t0 = time.perf_counter()
    try:
        if not video_id:
            record("MCQ generation (--full)", "SKIP", "no lecture video available", 0)
            return
        # The lecture-open prefetches the transcript in the background; give it a
        # moment, then retry through transient 202 "still fetching" responses.
        deadline = time.time() + 180
        while True:
            r = requests.post(f"{base}/quiz/generate",
                              json={"session_id": session_id, "video_id": video_id},
                              timeout=300)
            if r.status_code == 200:
                n = len(r.json().get("questions", []))
                status, detail = ("PASS", f"{n} questions") if n >= 5 else ("FAIL", f"only {n} questions")
                break
            if r.status_code == 202 and time.time() < deadline:
                time.sleep(10)
                continue
            status, detail = "FAIL", f"HTTP {r.status_code}: {r.text[:120]}"
            break
    except Exception as e:
        status, detail = "FAIL", f"{type(e).__name__}: {e}"
    record("MCQ generation (--full)", status, detail, (time.perf_counter() - t0) * 1000)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="JARVIS pre-deploy smoke test")
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--prod", action="store_true", help=f"test {PROD_URL}")
    ap.add_argument("--full", action="store_true",
                    help="include slow checks (MCQ via Supadata, image completion)")
    args = ap.parse_args()
    base = PROD_URL if args.prod else args.base_url.rstrip("/")

    print(f"JARVIS smoke test -> {base}\n")
    print("Static checks:")
    check_python_syntax()
    check_js_syntax()

    print("\nServer checks:")
    if check_health(base) == "FAIL":
        print("\nServer unreachable or unhealthy - aborting feature checks.")
        print("(Local: start it with `python run.py`. Prod: the Space may be cold; retry in 60s.)")
        sys.exit(1)
    check_chat(base)
    check_chat_tts(base)
    check_tts(base)
    _, video_id, session_id = check_lecture(base)
    check_image(base, poll=args.full)
    if args.full:
        check_quiz(base, video_id, session_id)

    fails = [r for r in RESULTS if r[1] == "FAIL"]
    skips = [r for r in RESULTS if r[1] == "SKIP"]
    print(f"\n{'=' * 50}")
    print(f"Result: {len(RESULTS) - len(fails) - len(skips)} passed, "
          f"{len(fails)} failed, {len(skips)} skipped")
    if fails:
        print("DO NOT DEPLOY - fix the failures above first.")
        sys.exit(1)
    print("All good - safe to deploy.")
    sys.exit(0)


if __name__ == "__main__":
    main()
