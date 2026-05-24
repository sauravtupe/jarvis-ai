import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = PROJECT_ROOT / "frontend" / "audio"

STARATER_PHRASES = [
    ("starter_1", "One moment please."),
    ("starter_2", "Sure, one moment."),
    ("starter_3", "Got it, hold on."),
    ('starter_4', "On it right now."),
    ('starter_5', "Alright, give me a sec."),
    ("starter_6", "Right, one moment."),
    ("starter_7", "Okay, hold on."),
    ("starter_8", "One second please."),
    ("starter_9", "Give me a moment."),
    ("starter_10", "Just a moment please.")
]

PHRASES = STARATER_PHRASES
VOICE = "en-IN-PrabhatNeural"
RATE = "+12%"

async def generate_one(name: str, text: str) -> bool:
    path = AUDIO_DIR / f"{name}.mp3"

    # Try edge-tts with a 10s timeout
    try:
        import edge_tts
        communicate = edge_tts.Communicate(text, VOICE, rate=RATE)
        await asyncio.wait_for(communicate.save(str(path)), timeout=10)
        print(f"  [ok] {name}.mp3 (edge-tts)")
        return True
    except Exception as e:
        print(f"  [edge-tts FAIL] {name}.mp3: {e} — trying gTTS...")

    # Fallback: gTTS uses plain Google HTTP — works from any server including HuggingFace
    try:
        from gtts import gTTS
        tts = gTTS(text=text, lang="en", tld="co.in")
        tts.save(str(path))
        print(f"  [ok] {name}.mp3 (gTTS)")
        return True
    except Exception as e2:
        print(f"  [FAIL] {name}.mp3: {e2}")
        return False

async def main():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    for f in AUDIO_DIR.glob("followup_*.mp3"):
        try:
            f.unlink()
            print(f" [REMOVED] {f.name}")
        except OSError:
            pass

    print(f"Generating thinking audio in {AUDIO_DIR}...")
    success = 0

    for name, text in PHRASES:
        if await generate_one(name, text):
            success += 1

    print(f"Done: {success}/{len(PHRASES)} files.")
    return 0 if success == len(PHRASES) else 1

if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
    except KeyboardInterrupt:
        exit_code = 130

    sys.exit(exit_code)
