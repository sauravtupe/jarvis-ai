import json
import logging
import re
import threading
from pathlib import Path
from typing import Optional, List

logger = logging.getLogger(__name__)

# Version marker — bump when MCQ generation logic changes; helps verify HF deployments
_QUIZ_GEN_VERSION = "2026-05-26c-match-transcript-language"
logger.info("[QUIZ] quiz_service loaded — generator version: %s", _QUIZ_GEN_VERSION)

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
    r'\b(done|ready|finished|watched|completed|ok|okay|back|'
    r'i watched|all done|i\'m done|i am done|jarvis done|done jarvis|'
    r'seen it|watched it|i finished|video done|video finished|'
    r'yes done|yeah done|complete|i\'m ready|i am ready|'
    r'lets go|let\'s go|yes jarvis|ok jarvis|okay jarvis|'
    r'i\'ve watched|i have watched|i\'ve seen|i have seen)\b',
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
    return bool(_DONE_PATTERN.search((text or "").strip()))


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
            raise ValueError(
                "This video's transcript could not be fetched. "
                "To fix: get a free API key from supadata.ai and add it as "
                "SUPADATA_API_KEY in your .env file (locally) or HuggingFace Secrets (on HF Space). "
                "Note: SUPADATA is a YouTube transcript service — it is NOT related to Supabase."
            )
        raise ValueError(f"All transcript methods failed. Last error: {assemblyai_err or err}")


def _looks_like_letter_option(s: str) -> bool:
    """Detects placeholder options like 'A', 'B.', 'Option C', '(D)' — anything that isn't a real answer phrase."""
    t = (s or "").strip().strip('.').strip(')').strip('(').strip()
    if len(t) <= 2:
        return True
    if re.fullmatch(r'(?:option\s*)?[A-Da-d][\.\):]?', t):
        return True
    return False


def _call_groq_for_mcqs(prompt: str, groq_api_keys: list, model: str) -> str:
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage

    last_err = None
    for key in groq_api_keys:
        try:
            llm = ChatGroq(
                groq_api_key=key,
                model_name=model,
                temperature=0.3,
                max_tokens=4000,
                request_timeout=60,
            )
            response = llm.invoke([
                SystemMessage(content=(
                    "You are an expert quiz generator. Output ONLY valid JSON — no markdown fences, no explanation. "
                    "Write questions and answer options in the SAME language as the video transcript "
                    "(Hindi transcript → Hindi MCQs; English transcript → English MCQs). "
                    "Each answer option MUST be a full descriptive phrase (5+ words), NEVER a single letter or label like 'A', 'B', 'Option C'."
                )),
                HumanMessage(content=prompt),
            ])
            return (response.content or "").strip()
        except Exception as e:
            last_err = e
            logger.warning("[QUIZ] Key failed for MCQ generation (%s): %s", model, e)
            continue
    raise ValueError(f"All Groq keys exhausted: {last_err}")


def _parse_mcq_json(raw: str) -> list:
    raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'\s*```$', '', raw, flags=re.MULTILINE).strip()
    try:
        questions = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        if not m:
            raise ValueError("Could not parse MCQ JSON from LLM response")
        questions = json.loads(m.group(0))
    if not isinstance(questions, list):
        raise ValueError("LLM did not return a JSON array")
    return questions


def _validate_mcqs(questions: list) -> List[dict]:
    validated = []
    for q in questions[:10]:
        if not isinstance(q, dict):
            continue
        question = str(q.get("question", "")).strip()
        options = q.get("options", [])
        correct = q.get("correct", 0)
        if not question or not isinstance(options, list) or len(options) < 4:
            continue
        opts = [str(o).strip() for o in options[:4]]
        # Reject single-letter / placeholder options (language-agnostic — works for any script)
        if any(_looks_like_letter_option(o) for o in opts):
            logger.warning("[QUIZ] Rejected question with placeholder options: %r", opts)
            continue
        try:
            correct_idx = int(correct)
        except (TypeError, ValueError):
            correct_idx = 0
        validated.append({
            "question": question,
            "options": opts,
            "correct": max(0, min(3, correct_idx)),
        })
    return validated


def generate_mcqs(transcript: str, groq_api_keys: list) -> List[dict]:
    logger.info("[QUIZ] generate_mcqs called (version=%s, transcript=%d chars)", _QUIZ_GEN_VERSION, len(transcript))
    prompt = (
        "Generate exactly 10 multiple choice questions based on the video transcript below.\n\n"
        "===== CRITICAL RULES (read carefully) =====\n"
        "1. MATCH THE TRANSCRIPT LANGUAGE. If the transcript is in Hindi (Devanagari script), write the questions "
        "and all four options in Hindi. If the transcript is in English, write everything in English. "
        "If the transcript mixes languages (e.g. Hinglish), use the dominant language. Never translate — preserve the original language.\n"
        "2. Each 'options' array MUST contain four FULL ANSWER PHRASES (typically 5–15 words each in the transcript's language). "
        "NEVER output single letters like \"A\", \"B\", \"C\", \"D\". NEVER output labels like \"Option A\" / \"विकल्प A\". "
        "The letter labels (A/B/C/D) will be added by the UI — you only provide the answer text.\n"
        "3. Return ONLY a valid JSON array. No markdown fences, no commentary.\n\n"
        "===== EXAMPLE for an ENGLISH transcript =====\n"
        '[\n'
        '  {\n'
        '    "question": "According to the video, what does observation mean?",\n'
        '    "options": [\n'
        '      "Using your eyes to look carefully at things around you",\n'
        '      "Listening quietly to other people talking",\n'
        '      "Writing detailed notes in a personal journal",\n'
        '      "Memorising facts by reading them many times"\n'
        '    ],\n'
        '    "correct": 0\n'
        '  }\n'
        ']\n\n'
        "===== EXAMPLE for a HINDI transcript =====\n"
        '[\n'
        '  {\n'
        '    "question": "वीडियो के अनुसार observation का क्या मतलब है?",\n'
        '    "options": [\n'
        '      "अपनी आँखों से चीज़ों को ध्यान से देखना",\n'
        '      "दूसरे लोगों की बातें चुपचाप सुनना",\n'
        '      "एक डायरी में विस्तार से नोट्स लिखना",\n'
        '      "बार-बार पढ़कर तथ्य याद करना"\n'
        '    ],\n'
        '    "correct": 0\n'
        '  }\n'
        ']\n\n'
        "- 'correct' is the 0-based index of the correct answer (0, 1, 2, or 3).\n"
        "- Base every question strictly on transcript content.\n\n"
        f"===== TRANSCRIPT =====\n{transcript[:8000]}"
    )

    # Try the strong model first; fall back to the fast model if rate-limited
    raw = ""
    try:
        raw = _call_groq_for_mcqs(prompt, groq_api_keys, "llama-3.3-70b-versatile")
    except Exception as e:
        logger.warning("[QUIZ] 70B model failed, falling back to 8B: %s", e)
        raw = _call_groq_for_mcqs(prompt, groq_api_keys, "llama-3.1-8b-instant")

    questions = _parse_mcq_json(raw)
    validated = _validate_mcqs(questions)

    # Retry once with a stricter prompt if the model produced too many bad questions
    if len(validated) < 5:
        logger.warning("[QUIZ] Only %d valid questions — retrying with stricter prompt", len(validated))
        retry_prompt = (
            "Your previous output was rejected because answer options were single letters (A/B/C/D) "
            "or short placeholders instead of full descriptive phrases. Try again. "
            "Remember: match the transcript's language and write each option as a complete answer.\n\n"
            + prompt
        )
        try:
            raw2 = _call_groq_for_mcqs(retry_prompt, groq_api_keys, "llama-3.3-70b-versatile")
            validated = _validate_mcqs(_parse_mcq_json(raw2))
        except Exception as e:
            logger.warning("[QUIZ] Retry also failed: %s", e)

    if len(validated) < 3:
        raise ValueError("Not enough valid questions generated")

    return validated


# ─── AI-generated practical tasks (Feature 9) ───────────────────────────────


def _practical_cache_key(video_id: str, prompt_version: str) -> str:
    """S3 key for cached AI-generated tasks. Versioned so prompt changes invalidate."""
    safe_vid = re.sub(r"[^a-zA-Z0-9_-]", "_", video_id or "unknown")
    return f"practicals_ai_cache/{prompt_version}/{safe_vid}.json"


def _load_practicals_from_cache(video_id: str, prompt_version: str) -> Optional[List[dict]]:
    try:
        from app.services.storage_service import download_from_s3
    except Exception:
        return None
    try:
        data = download_from_s3(_practical_cache_key(video_id, prompt_version))
        if not data:
            return None
        tasks = json.loads(data.decode("utf-8"))
        if isinstance(tasks, list) and tasks:
            logger.info("[PRACTICAL] AI cache HIT for video_id=%s (%d tasks)", video_id, len(tasks))
            return tasks
    except Exception as e:
        logger.debug("[PRACTICAL] AI cache miss / read error for %s: %s", video_id, e)
    return None


def _save_practicals_to_cache(video_id: str, prompt_version: str, tasks: List[dict]) -> None:
    try:
        from app.services.storage_service import upload_bytes_to_s3
        payload = json.dumps(tasks, ensure_ascii=False, indent=2).encode("utf-8")
        upload_bytes_to_s3(payload, _practical_cache_key(video_id, prompt_version), content_type="application/json")
        logger.info("[PRACTICAL] Cached %d AI tasks for video_id=%s", len(tasks), video_id)
    except Exception as e:
        logger.warning("[PRACTICAL] S3 cache write failed for %s: %s", video_id, e)


_PRACTICAL_SYSTEM_PROMPT = (
    "You are an expert AI/ML instructor designing hands-on coding exercises for students. "
    "Output ONLY valid JSON — no markdown fences, no commentary. "
    "Every task must be a concrete, runnable AI/ML practical that ties directly to the lecture content. "
    "Each task must include real platform suggestions (Google Colab, Kaggle, HuggingFace), specific steps, "
    "and learning outcomes. Match the lecture language in the description; keep code snippets in English."
)


def _build_practical_prompt(transcript: str, lecture_title: str = "") -> str:
    title_line = f"Lecture title: {lecture_title}\n\n" if lecture_title else ""
    return (
        "Generate exactly 3 hands-on practical exercises based on the AI/ML lecture below.\n\n"
        "===== CRITICAL RULES =====\n"
        "1. Each task must be a SPECIFIC, ACTIONABLE coding exercise — not a theory question.\n"
        "2. Reference what was actually taught in the lecture (concepts, libraries, datasets).\n"
        "3. Suggest a real platform where the student can do it (Google Colab, Kaggle, HuggingFace Spaces).\n"
        "4. Include 3-6 concrete steps in the 'steps' array.\n"
        "5. Include optional starter_code (5-15 lines) when it helps the student get unstuck.\n"
        "6. List 2-3 concrete learning_outcomes per task.\n"
        "7. Return ONLY a valid JSON array of 3 objects.\n\n"
        "===== EXAMPLE FORMAT =====\n"
        '[\n'
        '  {\n'
        '    "title": "Build your first sentiment classifier with HuggingFace Transformers",\n'
        '    "description": "Use a pretrained DistilBERT model to classify movie reviews from the IMDB dataset.",\n'
        '    "steps": [\n'
        '      "Open a new Google Colab notebook",\n'
        '      "Install transformers and datasets via pip",\n'
        '      "Load the IMDB dataset using datasets.load_dataset",\n'
        '      "Initialise a sentiment-analysis pipeline",\n'
        '      "Run it on 20 reviews and compare with the gold labels",\n'
        '      "Print the accuracy"\n'
        '    ],\n'
        '    "platform_suggestion": "Google Colab",\n'
        '    "starter_code": "from transformers import pipeline\\nfrom datasets import load_dataset\\nclf = pipeline(\\"sentiment-analysis\\")\\n# TODO: load IMDB and run clf on samples",\n'
        '    "estimated_minutes": 45,\n'
        '    "difficulty": "beginner",\n'
        '    "learning_outcomes": [\n'
        '      "Use a pretrained model with one line of code",\n'
        '      "Understand the HuggingFace pipeline API",\n'
        '      "Evaluate model accuracy on real data"\n'
        '    ]\n'
        '  }\n'
        ']\n\n'
        f"===== LECTURE TRANSCRIPT =====\n{title_line}{transcript[:8000]}"
    )


def _call_gemini_for_practicals(prompt: str, model: str, api_key: str) -> str:
    """Call Google Gemini for practical generation. Returns raw text."""
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    gen_model = genai.GenerativeModel(
        model_name=model,
        system_instruction=_PRACTICAL_SYSTEM_PROMPT,
        generation_config={
            "temperature": 0.4,
            "max_output_tokens": 4000,
            "response_mime_type": "application/json",
        },
    )
    resp = gen_model.generate_content(prompt)
    return (getattr(resp, "text", "") or "").strip()


def _call_groq_for_practicals(prompt: str, groq_api_keys: list, model: str = "llama-3.3-70b-versatile") -> str:
    """Fallback path: same Groq pattern as MCQ generation."""
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage

    last_err = None
    for key in groq_api_keys:
        try:
            llm = ChatGroq(
                groq_api_key=key,
                model_name=model,
                temperature=0.4,
                max_tokens=4000,
                request_timeout=60,
            )
            resp = llm.invoke([
                SystemMessage(content=_PRACTICAL_SYSTEM_PROMPT),
                HumanMessage(content=prompt),
            ])
            return (resp.content or "").strip()
        except Exception as e:
            last_err = e
            logger.warning("[PRACTICAL] Groq key failed (%s): %s", model, e)
            continue
    raise ValueError(f"All Groq keys exhausted: {last_err}")


def _parse_practicals_json(raw: str) -> list:
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        tasks = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if not m:
            raise ValueError("Could not parse practical-tasks JSON from LLM response")
        tasks = json.loads(m.group(0))
    if not isinstance(tasks, list):
        raise ValueError("LLM did not return a JSON array")
    return tasks


def _validate_practicals(tasks: list) -> List[dict]:
    validated = []
    for t in tasks[:3]:
        if not isinstance(t, dict):
            continue
        title = str(t.get("title", "")).strip()
        description = str(t.get("description", "")).strip()
        steps = t.get("steps") or []
        if not title or not description:
            logger.warning("[PRACTICAL] Rejected task with empty title/description")
            continue
        if not isinstance(steps, list) or len(steps) < 2:
            logger.warning("[PRACTICAL] Rejected task '%s' — too few steps", title[:40])
            continue
        learning_outcomes = t.get("learning_outcomes") or []
        if not isinstance(learning_outcomes, list):
            learning_outcomes = []
        try:
            minutes = int(t.get("estimated_minutes") or 30)
        except (TypeError, ValueError):
            minutes = 30
        validated.append({
            "title": title[:200],
            "description": description[:800],
            "steps": [str(s).strip() for s in steps if str(s).strip()][:8],
            "platform_suggestion": str(t.get("platform_suggestion", "Google Colab")).strip(),
            "starter_code": str(t.get("starter_code", "")).strip()[:2000],
            "estimated_minutes": max(5, min(240, minutes)),
            "difficulty": str(t.get("difficulty", "beginner")).strip().lower(),
            "learning_outcomes": [str(o).strip() for o in learning_outcomes if str(o).strip()][:5],
        })
    return validated


def generate_practical_tasks(
    transcript: str,
    video_id: str,
    groq_api_keys: list,
    gemini_api_key: str = "",
    gemini_model: str = "gemini-2.5-flash",
    lecture_title: str = "",
    prompt_version: str = "2026-05-26a",
    use_cache: bool = True,
) -> List[dict]:
    """Generate hands-on practical tasks from a lecture transcript.

    Tries:
      1. S3 cache (if use_cache=True and video_id given)
      2. Gemini Flash (if gemini_api_key provided)
      3. Groq Llama 3.3 70B (fallback)
      4. Retry with stricter prompt if validation rejects most tasks

    Returns a list of validated task dicts. Raises ValueError if all paths
    fail or fewer than 1 task survives validation.
    """
    if not transcript or len(transcript) < 80:
        raise ValueError("Transcript too short to generate practical tasks")

    # Tier 1: cache
    if use_cache and video_id:
        cached = _load_practicals_from_cache(video_id, prompt_version)
        if cached:
            validated = _validate_practicals(cached)
            if validated:
                return validated

    prompt = _build_practical_prompt(transcript, lecture_title)
    raw = ""
    last_err = None

    # Tier 2: Gemini
    if gemini_api_key:
        try:
            logger.info("[PRACTICAL] Generating via Gemini %s for video_id=%s", gemini_model, video_id)
            raw = _call_gemini_for_practicals(prompt, gemini_model, gemini_api_key)
        except Exception as e:
            last_err = e
            logger.warning("[PRACTICAL] Gemini failed, falling back to Groq: %s", e)
            raw = ""

    # Tier 3: Groq fallback
    if not raw:
        try:
            raw = _call_groq_for_practicals(prompt, groq_api_keys)
        except Exception as e:
            raise ValueError(f"Both Gemini and Groq failed for practical generation: {last_err or e}")

    try:
        tasks = _parse_practicals_json(raw)
        validated = _validate_practicals(tasks)
    except Exception as e:
        logger.warning("[PRACTICAL] Initial parse/validate failed: %s — retrying", e)
        validated = []

    # Retry once with stricter prompt if needed
    if len(validated) < 2:
        retry_prompt = (
            "Your previous output was rejected because tasks were missing required fields "
            "(title, description, or fewer than 2 steps). Try again — produce exactly 3 valid tasks.\n\n"
            + prompt
        )
        try:
            if gemini_api_key:
                raw2 = _call_gemini_for_practicals(retry_prompt, gemini_model, gemini_api_key)
            else:
                raw2 = _call_groq_for_practicals(retry_prompt, groq_api_keys)
            validated = _validate_practicals(_parse_practicals_json(raw2))
        except Exception as e:
            logger.warning("[PRACTICAL] Retry also failed: %s", e)

    if not validated:
        raise ValueError("Could not generate any valid practical tasks from this lecture")

    # Save to cache for next time
    if use_cache and video_id and validated:
        _save_practicals_to_cache(video_id, prompt_version, validated)

    return validated


# ─── End AI practical generation ────────────────────────────────────────────


def generate_summary(transcript: str, groq_api_keys: list) -> str:
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage

    prompt = (
        "Summarise this video transcript in a clear, well-structured format with:\n"
        "**Overview** — 2-3 sentences describing what the video covers\n"
        "**Key Points** — bullet list of the main topics covered\n"
        "**Conclusion** — 1-2 sentences wrapping up the main takeaway\n\n"
        f"Transcript:\n{transcript[:8000]}"
    )

    last_err = None
    for key in groq_api_keys:
        try:
            llm = ChatGroq(
                groq_api_key=key,
                model_name="llama-3.1-8b-instant",
                temperature=0.3,
                max_tokens=2000,
                request_timeout=60,
            )
            response = llm.invoke([
                SystemMessage(content="You are an expert content summarizer. Be concise and clear."),
                HumanMessage(content=prompt),
            ])
            return (response.content or "").strip()
        except Exception as e:
            last_err = e
            logger.warning("[QUIZ] Key failed for summary generation: %s", e)
            continue

    raise ValueError(f"All Groq keys exhausted: {last_err}")


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
