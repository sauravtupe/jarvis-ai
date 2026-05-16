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


def _try_supadata(video_id: str, api_key: str) -> Optional[str]:
    """Fetch transcript via Supadata API — works from any IP including HuggingFace cloud.
    Handles async jobs (HTTP 202) for videos longer than 20 minutes."""
    import time
    import requests as _req

    headers = {"x-api-key": api_key}
    yt_url = f"https://www.youtube.com/watch?v={video_id}"

    def _extract_text(data: dict) -> str:
        content = data.get("content") or data.get("text") or ""
        if isinstance(content, list):
            return " ".join(str(c.get("text", c) if isinstance(c, dict) else c) for c in content)
        return str(content)

    try:
        resp = _req.get(
            "https://api.supadata.ai/v1/transcript",
            params={"url": yt_url, "text": "true"},
            headers=headers,
            timeout=30,
        )

        if resp.status_code == 200:
            text = _extract_text(resp.json()).strip()
            if len(text) > 80:
                logger.info("[SUPADATA] Transcript for %s: %d chars", video_id, len(text))
                return text[:20000]
            logger.debug("[SUPADATA] Transcript too short for %s", video_id)
            return None

        # Videos >20 min → async job
        if resp.status_code == 202:
            job_id = resp.json().get("job_id") or resp.json().get("id")
            if not job_id:
                logger.warning("[SUPADATA] 202 but no job_id for %s", video_id)
                return None
            logger.info("[SUPADATA] Async job %s for %s — polling...", job_id, video_id)
            for attempt in range(60):  # max 5 minutes (60 × 5s)
                time.sleep(5)
                poll = _req.get(
                    f"https://api.supadata.ai/v1/transcript/{job_id}",
                    headers=headers,
                    timeout=30,
                )
                if poll.status_code == 200:
                    text = _extract_text(poll.json()).strip()
                    if len(text) > 80:
                        logger.info("[SUPADATA] Async transcript for %s: %d chars (attempt %d)", video_id, len(text), attempt + 1)
                        return text[:20000]
                    return None
                if poll.status_code not in (202, 204):
                    logger.warning("[SUPADATA] Poll error %d for job %s", poll.status_code, job_id)
                    return None
            logger.warning("[SUPADATA] Async job timed out for %s", video_id)
            return None

        logger.warning("[SUPADATA] API error %d for %s: %s", resp.status_code, video_id, resp.text[:200])
    except Exception as e:
        logger.debug("[SUPADATA] Failed for %s: %s", video_id, e)
    return None


def _try_assemblyai(video_id: str, api_key: str) -> str:
    """Download audio via yt-dlp, upload to AssemblyAI, then transcribe.
    Passing the YouTube URL directly fails because AssemblyAI gets HTML instead of audio.
    File upload bypasses YouTube's bot detection."""
    import os
    import shutil
    import tempfile
    import time
    import requests as _req
    import yt_dlp

    headers_auth = {"authorization": api_key}
    tmpdir = tempfile.mkdtemp(prefix="jarvis_aai_")

    try:
        # Step 1: Download audio with yt-dlp
        url = f"https://www.youtube.com/watch?v={video_id}"
        ydl_opts = {
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": os.path.join(tmpdir, "audio.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
        }

        logger.info("[ASSEMBLYAI] Downloading audio for %s via yt-dlp...", video_id)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        audio_path = next(
            (os.path.join(tmpdir, f) for f in os.listdir(tmpdir)
             if os.path.isfile(os.path.join(tmpdir, f))),
            None,
        )
        if not audio_path:
            raise ValueError("yt-dlp produced no audio file")

        size_mb = os.path.getsize(audio_path) / (1024 * 1024)
        logger.info("[ASSEMBLYAI] Audio downloaded: %s (%.1f MB)", os.path.basename(audio_path), size_mb)

        # Step 2: Upload audio bytes to AssemblyAI
        logger.info("[ASSEMBLYAI] Uploading audio to AssemblyAI...")
        with open(audio_path, "rb") as f:
            upload_resp = _req.post(
                "https://api.assemblyai.com/v2/upload",
                headers={**headers_auth, "content-type": "application/octet-stream"},
                data=f,
                timeout=300,
            )
        if upload_resp.status_code != 200:
            raise ValueError(f"AssemblyAI upload failed ({upload_resp.status_code}): {upload_resp.text[:200]}")

        upload_url = upload_resp.json().get("upload_url")
        if not upload_url:
            raise ValueError("AssemblyAI did not return an upload URL")
        logger.info("[ASSEMBLYAI] Upload done. Submitting transcription job...")

        # Step 3: Submit transcription using the uploaded file URL
        submit_resp = _req.post(
            "https://api.assemblyai.com/v2/transcript",
            json={"audio_url": upload_url, "language_detection": True},
            headers={**headers_auth, "content-type": "application/json"},
            timeout=30,
        )
        if submit_resp.status_code != 200:
            raise ValueError(f"AssemblyAI submit failed ({submit_resp.status_code}): {submit_resp.text[:300]}")

        transcript_id = submit_resp.json().get("id")
        if not transcript_id:
            raise ValueError("AssemblyAI did not return a transcript ID")
        logger.info("[ASSEMBLYAI] Job submitted, id=%s. Polling...", transcript_id)

        # Step 4: Poll until complete (max 10 minutes = 200 × 3s)
        poll_url = f"https://api.assemblyai.com/v2/transcript/{transcript_id}"
        for attempt in range(200):
            time.sleep(3)
            poll = _req.get(poll_url, headers=headers_auth, timeout=30)
            poll.raise_for_status()
            result = poll.json()
            status = result.get("status")
            if status == "completed":
                text = (result.get("text") or "").strip()
                if not text:
                    raise ValueError("AssemblyAI returned empty transcript")
                logger.info("[ASSEMBLYAI] Done: %d chars (attempt %d)", len(text), attempt + 1)
                return text[:20000]
            if status == "error":
                raise ValueError(f"AssemblyAI error: {result.get('error', 'unknown')}")
            logger.debug("[ASSEMBLYAI] Status=%s (attempt %d)", status, attempt + 1)

        raise ValueError("AssemblyAI transcription timed out after 10 minutes")

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


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
    """Fetch transcript via 5-tier fallback chain.
    Tiers 1-2 work locally; Tier 3 (Supadata) works from any IP including HuggingFace cloud."""
    from config import ASSEMBLYAI_API_KEY, SUPADATA_API_KEY

    # Tier 1: YouTube Transcript API (fast, free — blocked on HuggingFace IPs)
    transcript = _try_transcript_api(video_id)
    if transcript:
        return transcript

    # Tier 2: yt-dlp subtitle-only (free, no audio — blocked on HuggingFace IPs)
    logger.info("[YT] No captions via API — trying yt-dlp subtitles for %s", video_id)
    transcript = _try_subtitle_download(video_id)
    if transcript:
        return transcript

    # Tier 3: Supadata — cloud transcript API, works from any IP including HuggingFace
    if SUPADATA_API_KEY:
        logger.info("[YT] Trying Supadata for %s", video_id)
        transcript = _try_supadata(video_id, SUPADATA_API_KEY)
        if transcript:
            return transcript
        logger.warning("[YT] Supadata returned no transcript for %s", video_id)
    else:
        logger.warning("[YT] SUPADATA_API_KEY not set — skipping Supadata for %s", video_id)

    # Tier 4: AssemblyAI — yt-dlp download + upload (works locally, blocked on HuggingFace)
    assemblyai_err = ""
    if ASSEMBLYAI_API_KEY:
        logger.info("[YT] Trying AssemblyAI for %s", video_id)
        try:
            return _try_assemblyai(video_id, ASSEMBLYAI_API_KEY)
        except Exception as e:
            assemblyai_err = str(e)
            logger.warning("[ASSEMBLYAI] Failed for %s: %s", video_id, assemblyai_err)
    else:
        assemblyai_err = "ASSEMBLYAI_API_KEY not configured"

    # Tier 5: yt-dlp audio + Groq Whisper (works locally, blocked on HuggingFace)
    logger.info("[YT] Falling back to Whisper for %s", video_id)
    try:
        return _try_whisper(video_id)
    except Exception as e:
        err = str(e)
        if "25 MB" in err or "too large" in err.lower():
            raise ValueError("This video is too long to transcribe (audio exceeds 25 MB limit).")
        if not SUPADATA_API_KEY:
            raise ValueError("SUPADATA_KEY_MISSING: Please add SUPADATA_API_KEY to HuggingFace Secrets. Get a free key at supadata.ai")
        raise ValueError(f"All transcript methods failed. Last error: {assemblyai_err or err}")


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
