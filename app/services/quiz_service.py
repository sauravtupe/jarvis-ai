import json
import logging
import re
import threading
from pathlib import Path
from typing import Optional, List

logger = logging.getLogger(__name__)

_QUIZ_DIR = Path("database/quizzes")
_quiz_lock = threading.Lock()

_YT_REGEX = re.compile(
    r'(?:https?://)?(?:www\.)?(?:'
    r'youtube\.com/(?:watch\?(?:[^&]*&)*v=|embed/|shorts/)|'
    r'youtu\.be/'
    r')([a-zA-Z0-9_-]{11})',
    re.IGNORECASE,
)

_DONE_PATTERN = re.compile(
    r'\b(done|ready|finished|watched|completed|ok|okay|back|i watched|all done)\b',
    re.IGNORECASE,
)


def extract_video_id(text: str) -> Optional[str]:
    match = _YT_REGEX.search(text or "")
    return match.group(1) if match else None


def is_youtube_url(text: str) -> bool:
    return extract_video_id(text) is not None


def get_full_url(text: str) -> Optional[str]:
    video_id = extract_video_id(text)
    return f"https://www.youtube.com/watch?v={video_id}" if video_id else None


def is_return_signal(text: str) -> bool:
    """True if the message looks like 'I'm done watching'."""
    t = (text or "").strip()
    return len(t) <= 40 or bool(_DONE_PATTERN.search(t))


def _join_fetched(fetched) -> str:
    parts = []
    for s in fetched:
        if hasattr(s, "text"):
            parts.append(str(s.text))
        elif isinstance(s, dict):
            parts.append(str(s.get("text", "")))
    return " ".join(parts)


def _try_transcript_api(video_id: str) -> Optional[str]:
    """Try manual then auto-generated captions via youtube-transcript-api v1.x."""
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()

    try:
        tlist = api.list(video_id)
    except Exception as e:
        logger.debug("[YT] transcript-api list failed for %s: %s", video_id, type(e).__name__)
        return None

    preferred = ["en", "en-US", "en-GB", "en-IN", "en-AU"]

    # Manual transcript in preferred language
    try:
        text = _join_fetched(tlist.find_manually_created_transcript(preferred).fetch())
        logger.info("[YT] Manual transcript for %s: %d chars", video_id, len(text))
        return text[:20000]
    except Exception:
        pass

    # Any manual transcript
    try:
        for t in tlist:
            if not t.is_generated:
                text = _join_fetched(t.fetch())
                logger.info("[YT] Manual transcript (non-EN) for %s: %d chars", video_id, len(text))
                return text[:20000]
    except Exception:
        pass

    # Auto-generated in preferred language
    try:
        text = _join_fetched(tlist.find_generated_transcript(preferred).fetch())
        logger.info("[YT] Auto-generated transcript for %s: %d chars", video_id, len(text))
        return text[:20000]
    except Exception:
        pass

    # Any auto-generated transcript (any language — better than nothing)
    try:
        for t in tlist:
            if t.is_generated:
                text = _join_fetched(t.fetch())
                logger.info("[YT] Auto-generated (any lang) for %s: %d chars", video_id, len(text))
                return text[:20000]
    except Exception:
        pass

    return None


def _try_subtitle_download(video_id: str) -> Optional[str]:
    """Download auto-subtitles via yt-dlp (no audio needed — much lighter)."""
    import os
    import shutil
    import tempfile

    import yt_dlp

    tmpdir = tempfile.mkdtemp(prefix="jarvis_sub_")
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en", "en-US", "en-GB", "en-IN", "en-AU"],
            "subtitlesformat": "vtt",
            "outtmpl": os.path.join(tmpdir, "sub.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        for fname in os.listdir(tmpdir):
            fpath = os.path.join(tmpdir, fname)
            if not os.path.isfile(fpath):
                continue
            if not fname.endswith((".vtt", ".srt", ".ttml")):
                continue
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            # Strip VTT/SRT timing lines and markup
            text = re.sub(r'\d{2}:\d{2}[\d:.,]+ --> \d{2}:\d{2}[\d:.,]+[^\n]*\n?', '', content)
            text = re.sub(r'^WEBVTT.*\n?', '', text, flags=re.MULTILINE)
            text = re.sub(r'^\d+\s*\n', '', text, flags=re.MULTILINE)
            text = re.sub(r'<[^>]+>', '', text)
            text = ' '.join(text.split())
            if len(text) > 80:
                logger.info("[YT-SUB] yt-dlp subtitle for %s: %d chars", video_id, len(text))
                return text[:20000]
        return None
    except Exception as e:
        logger.debug("[YT-SUB] Subtitle download failed for %s: %s", video_id, e)
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _try_assemblyai(video_id: str, api_key: str) -> str:
    """Transcribe via AssemblyAI — works from any IP including HuggingFace cloud."""
    import assemblyai as aai

    aai.settings.api_key = api_key
    url = f"https://www.youtube.com/watch?v={video_id}"

    config = aai.TranscriptionConfig(speech_model="universal-2")
    transcriber = aai.Transcriber(config=config)

    logger.info("[ASSEMBLYAI] Submitting %s for transcription...", video_id)
    transcript = transcriber.transcribe(url)

    if transcript.status == aai.TranscriptStatus.error:
        raise ValueError(f"AssemblyAI transcription failed: {transcript.error}")

    text = (transcript.text or "").strip()
    if not text:
        raise ValueError("AssemblyAI returned empty transcript")

    logger.info("[ASSEMBLYAI] Done: %d chars", len(text))
    return text[:20000]


def _try_whisper(video_id: str) -> str:
    """Download audio with yt-dlp and transcribe via Groq Whisper (whisper-large-v3)."""
    import os
    import shutil
    import tempfile

    import yt_dlp
    from groq import Groq

    from config import GROQ_API_KEY

    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set")

    tmpdir = tempfile.mkdtemp(prefix="jarvis_yt_")
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            # m4a/webm audio-only — no ffmpeg needed
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": os.path.join(tmpdir, "audio.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
        }

        logger.info("[WHISPER] Downloading audio for %s...", video_id)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        audio_path = next(
            (os.path.join(tmpdir, f) for f in os.listdir(tmpdir) if os.path.isfile(os.path.join(tmpdir, f))),
            None,
        )
        if not audio_path:
            raise ValueError("yt-dlp produced no audio file")

        size_mb = os.path.getsize(audio_path) / (1024 * 1024)
        logger.info("[WHISPER] Downloaded %s (%.1f MB)", os.path.basename(audio_path), size_mb)

        if size_mb > 24:
            raise ValueError(f"Audio too large ({size_mb:.1f} MB) — Groq Whisper limit is 25 MB")

        client = Groq(api_key=GROQ_API_KEY)
        logger.info("[WHISPER] Transcribing with whisper-large-v3...")
        with open(audio_path, "rb") as f:
            result = client.audio.transcriptions.create(
                model="whisper-large-v3",
                file=(os.path.basename(audio_path), f),
                response_format="text",
            )

        transcript = str(result).strip()
        if not transcript:
            raise ValueError("Whisper returned empty transcript")

        logger.info("[WHISPER] Done: %d chars", len(transcript))
        return transcript[:20000]

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def get_transcript(video_id: str) -> str:
    """Fetch transcript: captions API → yt-dlp subtitles → AssemblyAI → Groq Whisper."""
    from config import ASSEMBLYAI_API_KEY

    # Tier 1: YouTube Transcript API (fast, free, works for captioned videos)
    transcript = _try_transcript_api(video_id)
    if transcript:
        return transcript

    # Tier 2: yt-dlp subtitle download (free, no audio — works when API is blocked)
    logger.info("[YT] No captions via API — trying yt-dlp subtitles for %s", video_id)
    transcript = _try_subtitle_download(video_id)
    if transcript:
        return transcript

    # Tier 3: AssemblyAI — works from any IP including cloud/HuggingFace
    assemblyai_err = ""
    if ASSEMBLYAI_API_KEY:
        logger.info("[YT] No subtitles — trying AssemblyAI for %s", video_id)
        try:
            return _try_assemblyai(video_id, ASSEMBLYAI_API_KEY)
        except Exception as e:
            assemblyai_err = str(e)
            logger.warning("[ASSEMBLYAI] Failed for %s: %s", video_id, assemblyai_err)
    else:
        assemblyai_err = "ASSEMBLYAI_API_KEY not configured"
        logger.warning("[YT] ASSEMBLYAI_API_KEY not set — skipping AssemblyAI for %s", video_id)

    # Tier 4: yt-dlp audio + Groq Whisper (works locally, may fail on cloud IPs)
    logger.info("[YT] Falling back to Whisper for %s", video_id)
    try:
        return _try_whisper(video_id)
    except Exception as e:
        err = str(e)
        if "25 MB" in err or "too large" in err.lower():
            raise ValueError("This video is too long to transcribe (audio exceeds 25 MB limit).")
        if "not configured" in assemblyai_err:
            raise ValueError("ASSEMBLYAI_KEY_MISSING: AssemblyAI API key is not set. Please add ASSEMBLYAI_API_KEY to HuggingFace Secrets.")
        raise ValueError(f"ASSEMBLYAI_FAILED: {assemblyai_err}")


def generate_mcqs(transcript: str, groq_api_key: str) -> List[dict]:
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage

    llm = ChatGroq(
        groq_api_key=groq_api_key,
        model_name="llama-3.3-70b-versatile",
        temperature=0.3,
        max_tokens=4000,
        request_timeout=60,
    )

    prompt = (
        "Generate exactly 10 multiple choice questions based on this video transcript.\n"
        "Return ONLY a valid JSON array. Format:\n"
        '[{"question": "...", "options": ["A", "B", "C", "D"], "correct": 0}, ...]\n'
        "- options must have exactly 4 strings\n"
        "- correct is the 0-based index of the correct answer\n"
        "- Base questions ONLY on the transcript content\n\n"
        f"Transcript:\n{transcript[:8000]}"
    )

    response = llm.invoke([
        SystemMessage(content="You are an expert quiz generator. Output ONLY valid JSON, no markdown fences, no explanation."),
        HumanMessage(content=prompt),
    ])

    raw = (response.content or "").strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'\s*```$', '', raw, flags=re.MULTILINE).strip()

    try:
        questions = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if m:
            questions = json.loads(m.group(0))
        else:
            raise ValueError("Could not parse MCQ JSON from LLM response")

    if not isinstance(questions, list):
        raise ValueError("LLM did not return a JSON array")

    validated = []
    for q in questions[:10]:
        if not isinstance(q, dict):
            continue
        question = str(q.get("question", "")).strip()
        options = q.get("options", [])
        correct = q.get("correct", 0)
        if not question or not isinstance(options, list) or len(options) < 4:
            continue
        try:
            correct_idx = int(correct)
        except (TypeError, ValueError):
            correct_idx = 0
        validated.append({
            "question": question,
            "options": [str(o) for o in options[:4]],
            "correct": max(0, min(3, correct_idx)),
        })

    if len(validated) < 3:
        raise ValueError("Not enough valid questions generated")

    return validated


def generate_summary(transcript: str, groq_api_key: str) -> str:
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage

    llm = ChatGroq(
        groq_api_key=groq_api_key,
        model_name="llama-3.3-70b-versatile",
        temperature=0.3,
        max_tokens=2000,
        request_timeout=60,
    )

    prompt = (
        "Summarise this video transcript in a clear, well-structured format with:\n"
        "**Overview** — 2-3 sentences describing what the video covers\n"
        "**Key Points** — bullet list of the main topics covered\n"
        "**Conclusion** — 1-2 sentences wrapping up the main takeaway\n\n"
        f"Transcript:\n{transcript[:8000]}"
    )

    response = llm.invoke([
        SystemMessage(content="You are an expert content summarizer. Be concise and clear."),
        HumanMessage(content=prompt),
    ])

    return (response.content or "").strip()


def save_quiz_record(record: dict) -> None:
    _QUIZ_DIR.mkdir(parents=True, exist_ok=True)
    filepath = _QUIZ_DIR / "records.json"
    records = []
    with _quiz_lock:
        if filepath.exists():
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    records = json.load(f)
            except Exception:
                records = []
        records.append(record)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2, ensure_ascii=False)
    try:
        from app.services.storage_service import upload_bytes_to_s3
        data = json.dumps(records, indent=2, ensure_ascii=False).encode("utf-8")
        upload_bytes_to_s3(data, "quizzes/records.json", content_type="application/json")
    except Exception as e:
        logger.warning("[QUIZ] S3 sync of quiz records failed: %s", e)
