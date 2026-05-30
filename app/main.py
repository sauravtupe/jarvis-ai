
import sys
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, File, UploadFile, Form, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from contextlib import asynccontextmanager
import uvicorn
import logging
import json
import time
import re
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import edge_tts


from app.models import (
    ChatRequest, ChatResponse, TTSRequest, UploadResponse,
    QuizGenerateRequest, QuizGenerateResponse, MCQQuestion,
    SummaryRequest, SummaryResponse,
    ClassroomAnalyseRequest,
    PracticeFile, PracticeListResponse,
    AdminLoginRequest, LectureCreate, LectureUpdate, LectureRecord, LectureListResponse,
    PracticalCreate, PracticalRecord, PracticalBundle,
    AIPracticalRequest, AIPracticalResponse, AIPracticalTask,
    PracticeGenerateResult, PracticeSaveRequest,
)

RATE_LIMIT_MESSAGE = (
    "You've reached your daily API limit for this assistant. "
    "Your credits will reset in a few hours, or you can upgrade "
    "your plan for more credits. Please try again later."
)

def _is_rate_limit_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "429" in str(exc) or "rate limit" in msg or "tokens per day" in msg

from app.services.groq_service import GroqService, AllGroqApisFailedError
from app.services.vector_store import VectorStoreService
from app.services.realtime_service import RealtimeGroqService
from app.services.chat_service import ChatService
from app.services.brain_service import BrainService
from app.services.task_executor import TaskExecutor
from app.services.vision_service import VisionService
from app.services.task_manager import TaskManager
from app.services.upload_service import UploadService
from app.services import quiz_service
from app.services import lecture_service
from app.services import practical_service
from app.middleware.auth import get_optional_user
from app.services.storage_service import (
    upload_bytes_to_s3, startup_restore_from_s3,
    list_s3_objects_older_than, delete_s3_object,
)
from apscheduler.schedulers.background import BackgroundScheduler

from config import (
    VECTOR_STORE_DIR, GROQ_API_KEYS, GROQ_MODEL, TAVILY_API_KEY,
    EMBEDDING_MODEL, CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHAT_HISTORY_TURNS,
    ASSISTANT_NAME, TTS_VOICE, TTS_RATE, MAX_UPLOAD_SIZE_MB,
    CHATS_DATA_DIR, OPENAI_API_KEY, GROQ_VISION_MODEL,
    SUPABASE_URL, SUPABASE_ANON_KEY,
    VECTOR_STORE_ENABLED,
)



logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

logger = logging.getLogger("J.A.R.V.I.S")

vector_store_service: VectorStoreService = None
groq_service: GroqService = None
realtime_service: RealtimeGroqService = None
brain_service: BrainService = None
task_executor: TaskExecutor = None
task_manager: TaskManager = None
vision_service: VisionService = None
chat_service: ChatService = None
upload_service: UploadService = None




def print_title():
    """Print the J.A.R.V.I.S ASCII art title."""
    title = """
   ╔══════════════════════════════════════════════════════════╗
   ║                                                          ║
   ║         ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗          ║
   ║         ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝          ║
   ║         ██║███████║██████╔╝██║   ██║██║███████╗          ║
   ║    ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║          ║
   ║    ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║          ║
   ║     ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝          ║
   ║                                                          ║
   ║          Just A Rather Very Intelligent System           ║
   ║                                                          ║
   ╚══════════════════════════════════════════════════════════╝
    """

    try:
        sys.stdout.reconfigure(encoding='utf-8')
        print(title)
    except Exception:
        print("J.A.R.V.I.S - Starting Up...")



def _clean_old_s3_captures():
    """APScheduler job: delete S3 camera captures older than 8 hours. Runs every hour."""
    keys = list_s3_objects_older_than(prefix="camera/", hours=8)
    if not keys:
        logger.info("[SCHEDULER] S3 cleanup: nothing to delete")
        return
    deleted = sum(1 for k in keys if delete_s3_object(k))
    logger.info("[SCHEDULER] S3 cleanup: deleted %d / %d camera objects", deleted, len(keys))


def _keep_alive_ping():
    """Ping /health to prevent HF Space from sleeping. Runs every 4 minutes."""
    import os, requests as _req
    host = os.getenv("SPACE_HOST", "").strip()
    if not host:
        return
    url = f"https://{host}/health"
    try:
        r = _req.get(url, timeout=10)
        logger.info("[KEEP-ALIVE] Pinged %s → %s", url, r.status_code)
    except Exception as e:
        logger.warning("[KEEP-ALIVE] Ping failed: %s", e)


@asynccontextmanager

async def lifespan(app: FastAPI):

    global vector_store_service, groq_service, realtime_service, brain_service
    global task_executor, task_manager, vision_service, chat_service, upload_service
    print_title()
    logger.info("=" * 60)
    logger.info("J.A.R.V.I.S - Starting Up...")
    logger.info("=" * 60)
    logger.info("[CONFIG] Assistant name: %s", ASSISTANT_NAME)
    logger.info("[CONFIG] Groq model: %s", GROQ_MODEL)
    logger.info("[CONFIG] Groq API keys loaded: %d", len(GROQ_API_KEYS))
    logger.info("[CONFIG] Tavily API key: %s", "configured" if TAVILY_API_KEY else "NOT SET")
    logger.info("[CONFIG] Image generation: Pollinations.ai (free, no API key)")
    logger.info("[CONFIG] Embedding model: %s", EMBEDDING_MODEL)
    logger.info("[CONFIG] Chunk size: %d | Overlap: %d | Max history turns: %d",
        CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHAT_HISTORY_TURNS)


    try:
        # Generate starter audio clips if missing — runs as background task so it never blocks startup
        _audio_dir = Path("frontend/audio")
        _missing = not (_audio_dir / "starter_1.mp3").exists()
        if _missing:
            logger.info("[AUDIO] Starter audio missing — generating in background...")
            async def _bg_gen_audio():
                try:
                    from app.generate_thinking_audio import main as _gen_audio
                    await _gen_audio()
                    logger.info("[AUDIO] Starter audio generated successfully")
                except Exception as _e:
                    logger.warning("[AUDIO] Could not generate starter audio: %s", _e)
            asyncio.create_task(_bg_gen_audio())
        else:
            logger.info("[AUDIO] Starter audio files present — skipping generation")

        logger.info("[STORAGE] Restoring data from S3 (if any)...")
        startup_restore_from_s3()

        if VECTOR_STORE_ENABLED:
            logger.info("Initializing vector store service...")
            t0 = time.perf_counter()
            vector_store_service = VectorStoreService()
            vector_store_service.create_vector_store()
            logger.info("[TIMING] startup_vector_store: %.3fs", time.perf_counter() - t0)
        else:
            # Vector store is currently a single global FAISS index shared across
            # all users — it leaks personal memory between accounts. Keep it off
            # until per-user isolation lands. Skipping init entirely saves the
            # ~5-10s HuggingFace embeddings load too.
            vector_store_service = None
            logger.info("[CONFIG] Vector store DISABLED — personal-memory retrieval is OFF "
                        "(set VECTOR_STORE_ENABLED=1 to re-enable once per-user isolation is built)")
        logger.info("Initializing Groq service (general queries)...")
        groq_service = GroqService(vector_store_service)
        logger.info("Groq service initialized successfully")
        logger.info("Initializing Realtime Groq service (with Tavily search)...")
        realtime_service = RealtimeGroqService(vector_store_service)
        logger.info("Realtime Groq service initialized successfully")
        logger.info("Initializing Brain service (Groq query classification)...")
        brain_service = BrainService(groq_service=groq_service)
        logger.info("Brain service initialized successfully")
        logger.info("Initializing Task executor...")
        task_executor = TaskExecutor(groq_service=groq_service)
        logger.info("Task executor initialized successfully")
        logger.info("Initializing Background task manager...")
        task_manager = TaskManager(task_executor=task_executor)
        logger.info("Background task manager initialized successfully")
        logger.info("Initializing Vision service (Groq)...")
        vision_service = VisionService()
        logger.info("Vision service initialized successfully")
        logger.info("Initializing upload service...")
        upload_service = UploadService(vision_service)
        logger.info("Upload service initialized successfully")
        logger.info("Initializing chat service...")

        chat_service = ChatService(
            groq_service, realtime_service, brain_service,
            task_executor=task_executor,
            vision_service=vision_service,
            task_manager=task_manager,
        )


        logger.info("Chat service initialized successfully")
        logger.info("=" * 60)
        logger.info("Service Status:")
        logger.info("  - Vector Store: %s", "Ready" if vector_store_service else "Disabled (per VECTOR_STORE_ENABLED)")
        logger.info("  - Groq AI (General): Ready")
        logger.info("  - Groq AI (Realtime): Ready")
        logger.info("  - Brain (Unified Decision): Ready")
        logger.info("  - Task Executor: Ready")
        logger.info("  - Background Task Manager: Ready")
        logger.info("  - Vision (Groq): Ready")
        logger.info("  - Chat Service: Ready")

        # TTS connectivity test — verifies OpenAI key works at startup
        import os as _os_startup
        if not _os_startup.environ.get("OPENAI_API_KEY", "").strip():
            logger.error("  - TTS: FAILED — OPENAI_API_KEY not set in environment / HF Secrets")
        else:
            try:
                import os as _os_az
                _azure_ready = bool(_os_az.environ.get("AZURE_SPEECH_KEY") and _os_az.environ.get("AZURE_SPEECH_REGION"))
                _tts_test_fut = _tts_pool.submit(_generate_tts_sync, "Hello Sir, I am ready.", "en-IN-PrabhatNeural", TTS_RATE)
                _tts_test_audio = _tts_test_fut.result(timeout=30)
                if _tts_test_audio:
                    _engine = "Azure en-IN-PrabhatNeural (Indian male)" if _azure_ready else "OpenAI ash fallback"
                    _vol_label = f"+{_TTS_VOLUME_GAIN:.1f}x volume" if _TTS_VOLUME_GAIN != 1.0 else "native volume"
                    logger.info("  - TTS: Ready — %s, %s, %d bytes", _engine, _vol_label, len(_tts_test_audio))
                else:
                    logger.error("  - TTS: FAILED — both Azure and OpenAI returned empty audio")
            except Exception as _tts_e:
                logger.error("  - TTS: FAILED — %s", _tts_e)

        logger.info("=" * 60)
        logger.info("J.A.R.V.I.S is online and ready!")
        logger.info("API: http://localhost:8000")
        logger.info("Frontend: http://localhost:8000/app/ (open in browser)")
        logger.info("=" * 60)

        def _cleanup_tasks():
            if task_manager:
                task_manager.cleanup_old()

        scheduler = BackgroundScheduler()
        scheduler.add_job(_clean_old_s3_captures, "interval", hours=1,
                          id="s3_cleanup", replace_existing=True)
        scheduler.add_job(_keep_alive_ping, "interval", minutes=4,
                          id="keep_alive", replace_existing=True)
        scheduler.add_job(_cleanup_tasks, "interval", minutes=30,
                          id="task_cleanup", replace_existing=True)
        scheduler.start()
        logger.info("[SCHEDULER] APScheduler started — S3 cleanup every 1h, task cleanup every 30min, keep-alive ping every 4min")

        yield

        logger.info("\nShutting down J.A.R.V.I.S...")
        _tts_pool.shutdown(wait=True)

        try:
            scheduler.shutdown(wait=False)
            logger.info("[SCHEDULER] APScheduler stopped")
        except Exception:
            pass

        if task_manager:
            task_manager.shutdown()

        if chat_service:
            for session_id in list(chat_service.sessions.keys()):
                chat_service.save_chat_session(session_id, sync_cloud=True)

        # Only sync FAISS index back to S3 if the vector store was actually
        # enabled this session — otherwise we'd be re-uploading stale files
        # from a previous run.
        if VECTOR_STORE_ENABLED and vector_store_service is not None:
            for _fname in ["index.faiss", "index.pkl"]:
                _local = VECTOR_STORE_DIR / _fname
                if _local.exists():
                    upload_bytes_to_s3(_local.read_bytes(), f"vector_store/{_fname}")
                    logger.info("[SHUTDOWN] FAISS %s → S3", _fname)

        logger.info("All sessions saved. Goodbye!")

    except Exception as e:
        logger.error(f"Fatal error during startup: {e}", exc_info=True)
        raise


app = FastAPI(
    title="J.A.R.V.I.S API",
    description="Just A Rather Very Intelligent System",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - t0
        logger.info("[REQUEST] %s %s -> %s (%.3fs)", request.method, request.url.path, response.status_code, elapsed)
        return response

class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.endswith(('.html', '.js', '.css')):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(TimingMiddleware)
app.add_middleware(NoCacheStaticMiddleware)

@app.get("/api")

async def api_info():
    return {
        "message": "J.A.R.V.I.S API",
        "endpoints": {
            "/chat": "General chat (non-streaming)",
            "/chat/stream": "General chat (streaming chunks)",
            "/chat/realtime": "Realtime chat (non-streaming)",
            "/chat/realtime/stream": "Realtime chat (streaming chunks)",
            "/chat/jarvis/stream": "Jarvis unified route (two-stage brain: classify -> route -> execute/stream)",
            "/chat/history/{session_id}": "Get chat history",
            "/tasks/{task_id}": "Get background task status and result",
            "/health": "System health check",
            "/tts": "Text-to-speech (POST text, returns streamed MP3)"
        }
    }


@app.get("/health")
async def health():
    
    try:
        return {
            "status": "healthy",
            "vector_store": vector_store_service is not None,
            "groq_service": groq_service is not None,
            "realtime_service": realtime_service is not None,
            "brain_service": brain_service is not None,
            "task_executor": task_executor is not None,
            "task_manager": task_manager is not None,
            "vision_service": vision_service is not None,
            "chat_service": chat_service is not None
        }
        
    except Exception as e:
        logger.warning("[API /health] Error: %s", e)
        return {"status": "degraded", "error": str(e)}


@app.get("/auth/config")
async def auth_config():
    """Return public Supabase config needed by the frontend."""
    return {"supabase_url": SUPABASE_URL, "supabase_anon_key": SUPABASE_ANON_KEY}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):

    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    logger.info("[API /chat] Incoming | session_id=%s | message_len=%d | message=%.100s",
                request.session_id or "new", len(request.message), request.message)

    try:
        session_id = chat_service.get_or_create_session(request.session_id)
        response_text = chat_service.process_message(session_id, request.message)
        chat_service.save_chat_session(session_id)
        logger.info("[API /chat] Done | session_id=%s | response_len=%d", session_id[:12], len(response_text))
        return ChatResponse(response=response_text, session_id=session_id)

    except ValueError as e:
        logger.warning("[API /chat] Invalid session_id: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    except AllGroqApisFailedError as e:
        logger.error("[API /chat] All Groq APIs failed: %s", e)
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:

        if _is_rate_limit_error(e):
            logger.warning("[API /chat] Rate limit hit: %s", e)
            raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE)
        
        logger.error("[API /chat] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error processing chat: {str(e)}")

_SPLIT_RE = re.compile(r"(?<=[.!?,;:])\s+")
_MIN_WORDS_FIRST = 1
_MIN_WORDS = 1
_MERGE_IF_WORDS = 2
_TTS_BUFFER_TIMEOUT = 2.0
_TTS_BUFFER_MIN_WORDS = 4
_ABBREV_HOLD_RE = re.compile(r"^(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Vs|Etc)\.$", re.IGNORECASE)

def _should_hold_sentence_for_continuation(sent: str) -> bool:

    t = sent.strip()

    if not t.endswith("."):
        return False

    words = t.split()

    if len(words) != 1:
        return False

    return bool(_ABBREV_HOLD_RE.match(words[0]))

def _split_sentences(buf: str):
    parts = _SPLIT_RE.split(buf)

    if len(parts) <= 1:
        return [], buf

    raw = [p.strip() for p in parts[:-1] if p.strip()]
    sentences, pending = [], ""

    for s in raw:

        if pending:
            s = (pending + " " + s).strip()
            pending = ""

        min_req = _MIN_WORDS_FIRST if not sentences else _MIN_WORDS

        if len(s.split()) < min_req:
            pending = s
            continue
        sentences.append(s)

    remaining = (pending + " " + parts[-1].strip()).strip() if pending else parts[-1].strip()
    return sentences, remaining


def _merge_short(sentences):

    if not sentences:
        return []

    merged, i = [], 0

    while i < len(sentences):
        cur = sentences[i]
        j = i + 1

        while j < len(sentences) and len(sentences[j].split()) <= _MERGE_IF_WORDS:
            cur = (cur + " " + sentences[j]).strip()
            j += 1

        merged.append(cur)
        i = j

    return merged

# Volume boost gain applied to all TTS output via ffmpeg post-processing.
# 1.0 = no boost (current default — user reported the native Azure voice is loud enough).
# Raise (e.g. 1.5–1.8) only if a deployment has audibly quiet audio.
_TTS_VOLUME_GAIN = 1.0


def _boost_volume(mp3_bytes: bytes, gain: float = _TTS_VOLUME_GAIN) -> bytes:
    """Boost MP3 loudness using ffmpeg. Returns original bytes if ffmpeg fails."""
    if not mp3_bytes or gain == 1.0:
        return mp3_bytes
    try:
        import subprocess as _sp
        result = _sp.run(
            ['ffmpeg', '-i', 'pipe:0', '-filter:a', f'volume={gain}',
             '-f', 'mp3', '-loglevel', 'quiet', 'pipe:1'],
            input=mp3_bytes, capture_output=True, timeout=15,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
        logger.warning("[TTS] volume boost ffmpeg exit %d — returning original", result.returncode)
    except Exception as e:
        logger.warning("[TTS] volume boost failed: %s — returning original", e)
    return mp3_bytes


def _azure_tts(text: str, voice: str = "en-IN-PrabhatNeural", rate: Optional[str] = None) -> bytes:
    """Azure AI Speech REST API — native Indian voices (PrabhatNeural / MadhurNeural).

    Requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in environment.
    Returns empty bytes if Azure not configured or fails — caller falls back to OpenAI.
    """
    import os as _os, html as _html
    key = _os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = _os.environ.get("AZURE_SPEECH_REGION", "").strip()
    if not key or not region:
        return b""

    lang = "hi-IN" if voice.startswith("hi-IN") else "en-IN"
    # Honour the configured TTS_RATE (e.g. "+12%"). Fall back to +15% when caller
    # passes None or empty so existing behaviour is preserved.
    rate_pct = (rate or "").strip() or "+15%"
    escaped = _html.escape(text)
    ssml = (
        f'<speak version="1.0" xml:lang="{lang}" '
        f'xmlns="http://www.w3.org/2001/10/synthesis">'
        f'<voice name="{voice}">'
        f'<prosody rate="{rate_pct}">{escaped}</prosody>'
        f'</voice></speak>'
    )

    endpoint = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
    headers = {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "Jarvis-AI",
    }

    try:
        import requests as _rq
        resp = _rq.post(endpoint, headers=headers, data=ssml.encode("utf-8"), timeout=30)
        if resp.status_code == 200 and resp.content:
            logger.info("[TTS] Azure %s OK len=%d", voice, len(resp.content))
            return resp.content
        logger.warning("[TTS] Azure HTTP %d: %s", resp.status_code, resp.text[:300] if resp.text else "")
    except Exception as e:
        logger.warning("[TTS] Azure TTS failed: %s", e)
    return b""


_OPENAI_TTS_INSTRUCTIONS = (
    "Voice: Confident, warm, refined Indian English male — like an educated, intelligent "
    "Indian gentleman from Mumbai or Bengaluru. Think of a polished Indian executive or "
    "professor: calm, clear, respectful, and articulate.\n"
    "Accent: Natural Indian English — soft retroflex consonants, clear vowels, no fake British "
    "or American twang. Slight melodic rise-and-fall typical of educated Indian speech.\n"
    "Tone: Composed, gentlemanly, intelligent. Treat the listener as 'Sir' with quiet respect.\n"
    "Pace: Brisk and energetic — speak noticeably faster than typical conversational speed, "
    "like a confident professional who values the listener's time. Do NOT drag out vowels or "
    "pause between words. Keep momentum and crisp articulation throughout.\n"
    "If the text contains Hindi (Devanagari) words or mixed Hinglish, pronounce them naturally "
    "as a native Hindi speaker — do not Anglicize them."
)


def _generate_tts_sync(text: str, voice: str, rate: str) -> bytes:
    """Two-tier TTS:
       1. Azure AI Speech with en-IN-PrabhatNeural (user's preferred Indian voice)
       2. OpenAI gpt-4o-mini-tts with 'ash' as fallback if Azure not configured/fails
    Volume boost is applied only when `_TTS_VOLUME_GAIN != 1.0`; defaults to no-op.
    """
    # Tier 1: Azure (native Indian voice — preferred when configured)
    azure_voice = voice if voice and voice.endswith("Neural") else "en-IN-PrabhatNeural"
    audio = _azure_tts(text, azure_voice, rate=rate)
    if audio:
        return _boost_volume(audio)

    # Tier 2: OpenAI fallback
    import os as _os
    api_key = _os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        logger.error("[TTS] Both Azure and OpenAI unavailable — cannot synthesize audio")
        return b""

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, timeout=30.0)

        # gpt-4o-mini-tts supports `instructions` to steer accent and tone
        response = client.audio.speech.create(
            model="gpt-4o-mini-tts",
            voice="ash",
            input=text,
            instructions=_OPENAI_TTS_INSTRUCTIONS,
            response_format="mp3",
            speed=1.15,
        )
        audio = response.content
        if audio:
            audio = _boost_volume(audio)
            logger.info("[TTS] OpenAI gpt-4o-mini-tts OK voice=ash len=%d (gain=%.1fx)", len(audio), _TTS_VOLUME_GAIN)
            return audio
        logger.warning("[TTS] OpenAI gpt-4o-mini-tts returned empty audio — trying tts-1")
    except Exception as e:
        logger.warning("[TTS] OpenAI gpt-4o-mini-tts failed: %s — trying tts-1", e)

    # Fallback: standard tts-1 (no instructions, but still male onyx voice)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, timeout=30.0)
        response = client.audio.speech.create(
            model="tts-1",
            voice="ash",
            input=text,
            response_format="mp3",
            speed=1.15,
        )
        audio = response.content
        if audio:
            audio = _boost_volume(audio)
            logger.info("[TTS] OpenAI tts-1 fallback OK voice=ash len=%d (gain=%.1fx)", len(audio), _TTS_VOLUME_GAIN)
            return audio
        logger.error("[TTS] OpenAI tts-1 fallback also returned empty audio")
    except Exception as e:
        logger.error("[TTS] OpenAI tts-1 fallback failed: %s", e)

    return b""


def _pick_tts_voice(text: str) -> str:
    """Pick Azure voice based on script — Hindi (Devanagari) → MadhurNeural, else PrabhatNeural.
    Used by Tier 1 (Azure). Tier 2 (OpenAI) ignores this and hardcodes 'ash'."""
    if any('ऀ' <= c <= 'ॿ' for c in text):
        return 'hi-IN-MadhurNeural'
    return 'en-IN-PrabhatNeural'

_tts_pool = ThreadPoolExecutor(max_workers=4)


def _stream_generator(session_id: str, chunk_iter, is_realtime: bool, tts_enabled: bool = False):
    yield f"data: {json.dumps({'session_id': session_id, 'chunk': '', 'done': False})}\n\n"
    buffer = ""
    held = None
    is_first = True
    audio_queue = []
    last_submit_time = time.perf_counter()

    def _submit(text):
        nonlocal last_submit_time

        if not text or not text.strip():
            return

        audio_queue.append((_tts_pool.submit(_generate_tts_sync, text, _pick_tts_voice(text), TTS_RATE), text))
        last_submit_time = time.perf_counter()

    def _drain_ready():
        events = []

        while audio_queue and audio_queue[0][0].done():
            fut, sent = audio_queue.pop(0)

            try:
                audio = fut.result()
                b64 = base64.b64encode(audio).decode("ascii")
                events.append(f"data: {json.dumps({'audio': b64, 'sentence': sent})}\n\n")
            except Exception as exc:
                logger.error("[TTS-INLINE] Failed for '%s': %s", sent[:40], exc)
                events.append(f"data: {json.dumps({'audio': '', 'sentence': sent})}\n\n")
        return events
    
    def _yield_completed_audio():

        if not tts_enabled:
            return

        for ev in _drain_ready():
            yield ev

    try:

        for chunk in chunk_iter:

            if isinstance(chunk, dict) and "_activity" in chunk:
                yield f"data: {json.dumps({'activity': chunk['_activity']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_search_results" in chunk:
                yield f"data: {json.dumps({'search_results': chunk['_search_results']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_actions" in chunk:
                yield f"data: {json.dumps({'actions': chunk['_actions']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_background_tasks" in chunk:
                yield f"data: {json.dumps({'background_tasks': chunk['_background_tasks']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_youtube_detected" in chunk:
                yield f"data: {json.dumps({'youtube_detected': chunk['_youtube_detected']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_interactive_choice" in chunk:
                yield f"data: {json.dumps({'interactive_choice': chunk['_interactive_choice']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_practice_files" in chunk:
                yield f"data: {json.dumps({'practice_files': chunk['_practice_files']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if isinstance(chunk, dict) and "_practicals" in chunk:
                yield f"data: {json.dumps({'practicals': chunk['_practicals']})}\n\n"
                yield from _yield_completed_audio()
                continue

            if not chunk:
                yield from _yield_completed_audio()
                continue

            yield f"data: {json.dumps({'chunk': chunk, 'done': False})}\n\n"

            if not tts_enabled:
                continue

            yield from _yield_completed_audio()

            buffer += chunk
            sentences, buffer = _split_sentences(buffer)
            sentences = _merge_short(sentences)

            if held and sentences and len(sentences[0].split()) <= _MERGE_IF_WORDS:
                held = (held + " " + sentences[0]).strip()
                sentences = sentences[1:]

            for i, sent in enumerate(sentences):
                min_w = _MIN_WORDS_FIRST if is_first else _MIN_WORDS
                if len(sent.split()) < min_w:
                    continue

                is_last = (i == len(sentences) - 1)

                if held:
                    _submit(held)
                    held = None
                    is_first = False

                if is_last and _should_hold_sentence_for_continuation(sent):
                    held = sent

                else:
                    _submit(sent)
                    is_first = False
                
            if buffer and len(buffer.split()) >= _TTS_BUFFER_MIN_WORDS:
                if time.perf_counter() - last_submit_time > _TTS_BUFFER_TIMEOUT:

                    if held:
                        _submit(held)
                        held = None
                        is_first = False

                    _submit(buffer.strip())
                    buffer = ""
                    is_first = False

            yield from _yield_completed_audio()

    except Exception as e:

        for fut, _ in audio_queue:
            fut.cancel()

        yield f"data: {json.dumps({'chunk': '', 'done': True, 'error': str(e)})}\n\n"
        return
    
    if tts_enabled:
        remaining = buffer.strip()

        if held:

            if remaining and len(remaining.split()) <= _MERGE_IF_WORDS:
                _submit((held + " " + remaining).strip())

            else:
                _submit(held)
                if remaining:
                    _submit(remaining)

        elif remaining:
            _submit(remaining)

        for fut, sent in audio_queue:

            try:
                audio = fut.result(timeout=15)
                b64 = base64.b64encode(audio).decode("ascii")
                yield f"data: {json.dumps({'audio': b64, 'sentence': sent})}\n\n"

            except FuturesTimeoutError:
                logger.error("[TTS-INLINE] Timeout for '%s' (15s) — edge-tts may be slow or blocked", (sent or "")[:40])
                yield f"data: {json.dumps({'audio': '', 'sentence': sent or ''})}\n\n"

            except Exception as exc:
                logger.error("[TTS-INLINE] Failed for '%s': %s", (sent or "")[:40], exc)
                yield f"data: {json.dumps({'audio': '', 'sentence': sent or ''})}\n\n"

    yield f"data: {json.dumps({'chunk': '', 'done': True, 'session_id': session_id})}\n\n"



@app.post("/chat/stream")
async def chat_stream(request: ChatRequest, user_id: str = Depends(get_optional_user)):

    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    logger.info("[API /chat/stream] Incoming | session_id=%s | message_len=%d | message=%.100s",
                request.session_id or "new", len(request.message), request.message)

    try:
        session_id = chat_service.get_or_create_session(request.session_id)

        chunk_iter = chat_service.process_message_stream(session_id, request.message)
        return StreamingResponse(
            _stream_generator(session_id, chunk_iter, is_realtime=False, tts_enabled=request.tts),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except AllGroqApisFailedError as e:
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:
        if _is_rate_limit_error(e):
            raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE)

        logger.error("[API /chat/stream] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/chat/realtime", response_model=ChatResponse)
async def chat_realtime(request: ChatRequest):

    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    if not realtime_service:
        raise HTTPException(status_code=503, detail="Realtime service not initialized")

    logger.info("[API /chat/realtime] Incoming | session_id=%s | message_len=%d | message=%.100s",
                request.session_id or "new", len(request.message), request.message)

    try:
        session_id = chat_service.get_or_create_session(request.session_id)
        response_text = chat_service.process_realtime_message(session_id, request.message)
        chat_service.save_chat_session(session_id)
        logger.info("[API /chat/realtime] Done | session_id=%s | response_len=%d", session_id[:12], len(response_text))
        return ChatResponse(response=response_text, session_id=session_id)

    except ValueError as e:
        logger.warning("[API /chat/realtime] Invalid session_id: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    except AllGroqApisFailedError as e:
        logger.error("[API /chat/realtime] All Groq APIs failed: %s", e)
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:

        if _is_rate_limit_error(e):
            logger.warning("[API /chat/realtime] Rate limit hit: %s", e)
            raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE)

        logger.error("[API /chat/realtime] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error processing chat: {str(e)}")


@app.post("/chat/realtime/stream")
async def chat_realtime_stream(request: ChatRequest, user_id: str = Depends(get_optional_user)):

    if not chat_service or not realtime_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    logger.info("[API /chat/realtime/stream] Incoming | session_id=%s | message_len=%d | message=%.100s",
                request.session_id or "new", len(request.message), request.message)

    try:
        session_id = chat_service.get_or_create_session(request.session_id)
        chunk_iter = chat_service.process_realtime_message_stream(session_id, request.message)
        return StreamingResponse(
            _stream_generator(session_id, chunk_iter, is_realtime=True, tts_enabled=request.tts),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except AllGroqApisFailedError as e:
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:
        if _is_rate_limit_error(e):
            raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE)

        logger.error("[API /chat/realtime/stream] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/jarvis/stream")
async def chat_jarvis_stream(request: ChatRequest, user_id: str = Depends(get_optional_user)):

    if not chat_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    logger.info("[API /chat/jarvis/stream] Incoming | session_id=%s | message_len=%d | img=%s | message=%.100s",
                request.session_id or "new", len(request.message), "yes" if request.imgbase64 else "no", request.message)

    try:
        session_id = chat_service.get_or_create_session(request.session_id)
        chunk_iter = chat_service.process_jarvis_message_stream(
            session_id, request.message, imgbase64=request.imgbase64
        )

        return StreamingResponse(
            _stream_generator(session_id, chunk_iter, is_realtime=True, tts_enabled=request.tts),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except AllGroqApisFailedError as e:
        raise HTTPException(status_code=503, detail=str(e))

    except Exception as e:
        if _is_rate_limit_error(e):
            raise HTTPException(status_code=429, detail=RATE_LIMIT_MESSAGE)

        logger.error("[API /chat/jarvis/stream] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tasks/{task_id}")
async def get_task_status(task_id: str):
    if not task_manager:
        raise HTTPException(status_code=503, detail="Task manager not initialized")

    if not task_id or len(task_id) > 32:
        raise HTTPException(status_code=400, detail="Invalid task_id")
    
    data = task_manager.get_serializable(task_id)

    if not data:
        raise HTTPException(status_code=404, detail="Task not found")

    return data

@app.get("/tasks/{task_id}/image")
async def get_task_image(task_id: str):
    if not task_manager:
        raise HTTPException(status_code=503, detail="Task manager not initialized")

    if not task_id or len(task_id) > 32:
        raise HTTPException(status_code=400, detail="Invalid task_id")

    entry = task_manager.get(task_id)

    if not entry:
        raise HTTPException(status_code=404, detail="Task not found")

    if entry.status != "completed" or not entry.image_bytes:
        raise HTTPException(status_code=404, detail="Image not ready")

    return Response(content=entry.image_bytes, media_type="image/png")


@app.get("/chat/history/{session_id}")
async def get_chat_history(session_id: str, user_id: str = Depends(get_optional_user)):
    if not chat_service:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    if not chat_service.validate_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format")

    try:
        messages = chat_service.get_chat_history(session_id)
        return {
            "session_id": session_id,
            "messages": [{"role": msg.role, "content": msg.content} for msg in messages]
        }

    except Exception as e:
        logger.error(f"Error retrieving history: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error retrieving history: {str(e)}")



@app.post("/upload", response_model=UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    user_id: str = Depends(get_optional_user),
):
    if not upload_service:
        raise HTTPException(status_code=503, detail="Upload service not initialized")

    file_bytes = await file.read()
    filename = file.filename or "upload"

    if not UploadService.check_size(file_bytes):
        raise HTTPException(status_code=413, detail=f"File too large. Max size is {MAX_UPLOAD_SIZE_MB} MB.")

    content_type = UploadService.detect_content_type(filename)
    if content_type == "unknown":
        raise HTTPException(status_code=400, detail="Unsupported file type. Supported: PDF, JPG, JPEG, PNG, GIF, WEBP.")

    if session_id:
        try:
            chat_service.validate_session_id(session_id)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid session_id format.")

    try:
        if content_type == "pdf":
            extracted_text = upload_service.extract_text_from_pdf(file_bytes)
        else:
            extracted_text = upload_service.extract_text_from_image(file_bytes)
    except Exception as e:
        logger.error("[API /upload] Extraction failed for %s: %s", filename, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Could not extract content from file: {str(e)}")

    import uuid as _uuid
    import mimetypes as _mimetypes
    from datetime import datetime as _dt
    upload_id = _uuid.uuid4().hex

    _mime, _ = _mimetypes.guess_type(filename)
    _s3_key = f"uploads/{upload_id}_{filename}"
    storage_url = upload_bytes_to_s3(file_bytes, _s3_key, content_type=_mime or "application/octet-stream")
    if storage_url:
        logger.info("[API /upload] File → S3: %s", _s3_key)

    upload_service.save_upload_record({
        "upload_id": upload_id,
        "user_id": user_id,
        "filename": filename,
        "content_type": content_type,
        "session_id": session_id,
        "timestamp": _dt.utcnow().isoformat(),
        "storage_url": storage_url,
    })

    logger.info("[API /upload] Done | id=%s | file=%s | type=%s | chars=%d",
                upload_id[:8], filename, content_type, len(extracted_text))
    return UploadResponse(
        upload_id=upload_id,
        filename=filename,
        content_type=content_type,
        extracted_text=extracted_text,
    )


@app.post("/quiz/generate", response_model=QuizGenerateResponse)
async def generate_quiz(request: QuizGenerateRequest, user_id: str = Depends(get_optional_user)):
    if not chat_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    if not chat_service.validate_session_id(request.session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id")

    pending = chat_service.get_session_metadata(request.session_id, "pending_youtube")

    if pending and pending.get("video_id") == request.video_id:
        if pending.get("status") == "fetching":
            raise HTTPException(status_code=202, detail="Transcript is still being processed. Please wait a moment.")
        transcript = pending.get("transcript")
    else:
        transcript = None

    if not transcript:
        try:
            transcript = quiz_service.get_transcript(request.video_id)
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e))

    if not GROQ_API_KEYS:
        raise HTTPException(status_code=503, detail="Groq API key not configured")

    try:
        questions_raw = quiz_service.generate_mcqs(transcript, GROQ_API_KEYS)
    except Exception as e:
        logger.error("[QUIZ] MCQ generation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Quiz generation failed: {e}")

    import uuid as _uuid
    from datetime import datetime as _dt
    quiz_id = _uuid.uuid4().hex
    quiz_service.save_quiz_record({
        "quiz_id": quiz_id,
        "user_id": user_id,
        "video_id": request.video_id,
        "session_id": request.session_id,
        "timestamp": _dt.utcnow().isoformat(),
    })

    questions = [MCQQuestion(**q) for q in questions_raw]
    logger.info("[QUIZ] Generated %d questions for video %s", len(questions), request.video_id)
    return QuizGenerateResponse(quiz_id=quiz_id, video_id=request.video_id, questions=questions)


@app.post("/quiz/summary", response_model=SummaryResponse)
async def generate_summary(request: SummaryRequest):
    if not chat_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    if not chat_service.validate_session_id(request.session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id")

    pending = chat_service.get_session_metadata(request.session_id, "pending_youtube")

    if pending and pending.get("video_id") == request.video_id:
        if pending.get("status") == "fetching":
            raise HTTPException(status_code=202, detail="Transcript is still being processed. Please wait a moment.")
        transcript = pending.get("transcript")
    else:
        transcript = None

    if not transcript:
        try:
            transcript = quiz_service.get_transcript(request.video_id)
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e))

    if not GROQ_API_KEYS:
        raise HTTPException(status_code=503, detail="Groq API key not configured")

    try:
        summary_text = quiz_service.generate_summary(transcript, GROQ_API_KEYS)
    except Exception as e:
        logger.error("[QUIZ] Summary generation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Summary generation failed: {e}")

    logger.info("[QUIZ] Generated summary for video %s (%d chars)", request.video_id, len(summary_text))
    return SummaryResponse(summary=summary_text, video_id=request.video_id)


@app.get("/practice/list/{class_name}", response_model=PracticeListResponse)
async def list_practice_pdfs(class_name: str):
    from app.services.practice_service import list_pdfs_for_class
    from config import PRACTICE_CLASSES
    if class_name not in PRACTICE_CLASSES:
        raise HTTPException(status_code=404, detail=f"Unknown class: {class_name}")
    files = list_pdfs_for_class(class_name)
    return PracticeListResponse(class_name=class_name, files=files, count=len(files))


@app.get("/practice/download/{class_name}/{filename}")
async def download_practice_pdf(class_name: str, filename: str, inline: bool = False):
    from app.services.practice_service import get_pdf_path
    from fastapi.responses import FileResponse
    path = get_pdf_path(class_name, filename)
    if not path:
        raise HTTPException(status_code=404, detail="File not found")
    if inline:
        return FileResponse(str(path), media_type="application/pdf")
    return FileResponse(
        str(path),
        media_type="application/pdf",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── Feature 8 — Lecture Catalog + Admin Panel ────────────────────────────

def require_admin(x_admin_token: Optional[str] = Header(default=None, alias="X-Admin-Token")):
    """FastAPI dependency — gates admin-only endpoints.

    - Returns 503 if ADMIN_TOKEN is not configured (admin features disabled, NOT wide-open).
    - Returns 401 if header is missing or doesn't match (constant-time comparison).
    """
    import secrets as _secrets
    from config import ADMIN_TOKEN as _ADMIN_TOKEN
    if not _ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Admin features are not configured on this server.")
    if not x_admin_token or not _secrets.compare_digest(x_admin_token, _ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Admin authentication required.")
    return True


@app.post("/admin/login")
async def admin_login(request: AdminLoginRequest):
    """Verify the admin token. Frontend stores it on success and replays via X-Admin-Token."""
    import secrets as _secrets
    from config import ADMIN_TOKEN as _ADMIN_TOKEN
    if not _ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Admin features are not configured on this server.")
    if not _secrets.compare_digest(request.token, _ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid admin token.")
    return {"ok": True}


def _lecture_error_to_http(exc: lecture_service.LectureError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@app.get("/lectures", response_model=LectureListResponse)
async def list_lectures_endpoint(_: bool = Depends(require_admin)):
    lectures = lecture_service.list_lectures()
    return LectureListResponse(lectures=[LectureRecord(**l) for l in lectures], count=len(lectures))


@app.post("/lectures", response_model=LectureRecord, status_code=201)
async def create_lecture(
    request: LectureCreate,
    overwrite: bool = False,
    _: bool = Depends(require_admin),
):
    try:
        rec = lecture_service.add_lecture(
            class_name=request.class_name,
            chapter=request.chapter,
            title=request.title,
            youtube_url=request.youtube_url,
            overwrite=overwrite,
        )
        return LectureRecord(**rec)
    except lecture_service.LectureError as e:
        raise _lecture_error_to_http(e)


@app.put("/lectures/{class_name}/{chapter}", response_model=LectureRecord)
async def update_lecture_endpoint(
    class_name: str,
    chapter: int,
    request: LectureUpdate,
    _: bool = Depends(require_admin),
):
    try:
        rec = lecture_service.update_lecture(
            class_name=class_name,
            chapter=chapter,
            title=request.title,
            youtube_url=request.youtube_url,
        )
        return LectureRecord(**rec)
    except lecture_service.LectureError as e:
        raise _lecture_error_to_http(e)


@app.delete("/lectures/{class_name}/{chapter}", status_code=204)
async def delete_lecture_endpoint(
    class_name: str,
    chapter: int,
    _: bool = Depends(require_admin),
):
    try:
        lecture_service.delete_lecture(class_name=class_name, chapter=chapter)
        return Response(status_code=204)
    except lecture_service.LectureError as e:
        raise _lecture_error_to_http(e)


# ─── Feature 9 — Practical Exercises ────────────────────────────────────────


def _practical_error_to_http(exc) -> HTTPException:
    """Translate PracticalError or LectureError -> HTTPException."""
    return HTTPException(status_code=getattr(exc, "status_code", 400), detail=str(exc))


@app.get("/lectures/{class_name}/{chapter}/practicals", response_model=PracticalBundle)
async def get_chapter_practicals(class_name: str, chapter: int):
    """Public — returns teacher-saved practice tasks + legacy curated links + class PDFs.

    practice_tasks is the primary student-facing content (generated and saved by
    the teacher in the Lecture Panel). curated is the legacy manual-link set.
    """
    try:
        bundle = practical_service.build_practical_bundle(class_name, chapter)
        return PracticalBundle(
            class_name=bundle["class_name"],
            chapter=bundle["chapter"],
            lecture=bundle["lecture"],
            curated=[PracticalRecord(**p) for p in bundle["curated"]],
            class_pdfs=[PracticeFile(**f) for f in bundle["class_pdfs"]],
            practice_tasks=[AIPracticalTask(**t) for t in bundle.get("practice_tasks", [])],
        )
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)


@app.post(
    "/lectures/{class_name}/{chapter}/practicals",
    response_model=PracticalRecord,
    status_code=201,
)
async def create_practical(
    class_name: str,
    chapter: int,
    request: PracticalCreate,
    _: bool = Depends(require_admin),
):
    try:
        rec = practical_service.add_practical(
            class_name=class_name,
            chapter=chapter,
            payload=request.model_dump(),
        )
        return PracticalRecord(**rec)
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)


@app.put(
    "/lectures/{class_name}/{chapter}/practicals/{practical_id}",
    response_model=PracticalRecord,
)
async def update_practical_endpoint(
    class_name: str,
    chapter: int,
    practical_id: str,
    request: PracticalCreate,
    _: bool = Depends(require_admin),
):
    try:
        rec = practical_service.update_practical(
            class_name=class_name,
            chapter=chapter,
            practical_id=practical_id,
            payload=request.model_dump(),
        )
        return PracticalRecord(**rec)
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)


@app.delete(
    "/lectures/{class_name}/{chapter}/practicals/{practical_id}",
    status_code=204,
)
async def delete_practical_endpoint(
    class_name: str,
    chapter: int,
    practical_id: str,
    _: bool = Depends(require_admin),
):
    try:
        practical_service.delete_practical(
            class_name=class_name,
            chapter=chapter,
            practical_id=practical_id,
        )
        return Response(status_code=204)
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)


# ─── Teacher-driven grade-aware practice generation (Feature 9 redesign) ─────

@app.post(
    "/lectures/{class_name}/{chapter}/practice/generate",
    response_model=PracticeGenerateResult,
)
async def admin_generate_practice(
    class_name: str,
    chapter: int,
    _: bool = Depends(require_admin),
):
    """Admin: generate grade/age/lesson-aware practice for a saved lecture.

    Returns a PREVIEW (not saved). The teacher reviews, regenerates if needed,
    then saves via PUT. Fetches the transcript for the lecture's video_id.
    """
    from config import (
        GEMINI_API_KEY, GEMINI_PRACTICAL_MODEL, PRACTICAL_AI_PROMPT_VERSION, band_for_class,
    )
    try:
        lecture_service._validate_class(class_name)
        chapter_key = lecture_service._validate_chapter(chapter)
    except lecture_service.LectureError as e:
        raise _practical_error_to_http(e)

    catalog = lecture_service._load_catalog()
    rec = catalog.get(class_name, {}).get(chapter_key)
    if not rec or not rec.get("video_id"):
        raise HTTPException(
            status_code=404,
            detail=f"No lecture (with a video) saved at {class_name} / {chapter_key}. Add the lecture first.",
        )

    video_id = rec["video_id"]
    try:
        transcript = quiz_service.get_transcript(video_id)
    except Exception as e:
        logger.warning("[PRACTICAL] Transcript fetch failed for %s: %s", video_id, e)
        raise HTTPException(
            status_code=422,
            detail="Couldn't fetch this lecture's transcript — make sure the video has captions, then retry.",
        )

    band = band_for_class(class_name)
    try:
        tasks = quiz_service.generate_practical_tasks(
            transcript=transcript,
            video_id=video_id,
            groq_api_keys=GROQ_API_KEYS,
            gemini_api_key=GEMINI_API_KEY,
            gemini_model=GEMINI_PRACTICAL_MODEL,
            lecture_title=rec.get("title", ""),
            class_name=class_name,
            prompt_version=PRACTICAL_AI_PROMPT_VERSION,
            use_cache=False,  # teacher wants a fresh draft to review
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error("[PRACTICAL] Admin generation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Practice generation failed: {e}")

    return PracticeGenerateResult(
        class_name=class_name,
        chapter=chapter,
        grade_band=band["label"],
        coding_allowed=band["coding_allowed"],
        tasks=[AIPracticalTask(**t) for t in tasks],
    )


@app.put(
    "/lectures/{class_name}/{chapter}/practice",
    response_model=PracticeGenerateResult,
)
async def admin_save_practice(
    class_name: str,
    chapter: int,
    request: PracticeSaveRequest,
    _: bool = Depends(require_admin),
):
    """Admin: save the teacher-reviewed practice tasks onto the lecture."""
    from config import band_for_class
    try:
        saved = practical_service.save_practice_tasks(
            class_name=class_name,
            chapter=chapter,
            tasks=[t.model_dump() for t in request.tasks],
        )
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)

    band = band_for_class(class_name)
    return PracticeGenerateResult(
        class_name=class_name,
        chapter=chapter,
        grade_band=band["label"],
        coding_allowed=band["coding_allowed"],
        tasks=[AIPracticalTask(**t) for t in saved],
    )


@app.delete(
    "/lectures/{class_name}/{chapter}/practice",
    status_code=204,
)
async def admin_clear_practice(
    class_name: str,
    chapter: int,
    _: bool = Depends(require_admin),
):
    """Admin: clear saved practice tasks from a lecture."""
    try:
        practical_service.clear_practice_tasks(class_name=class_name, chapter=chapter)
        return Response(status_code=204)
    except (practical_service.PracticalError, lecture_service.LectureError) as e:
        raise _practical_error_to_http(e)


@app.post("/practicals/generate", response_model=AIPracticalResponse)
async def generate_ai_practicals(request: AIPracticalRequest):
    """Generate hands-on practical tasks from the current pending_youtube transcript.

    Public endpoint — anyone with a valid session can use it. Caching makes
    repeated calls for the same video_id cheap.
    """
    if not chat_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    if not chat_service.validate_session_id(request.session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id")

    pending = chat_service.get_session_metadata(request.session_id, "pending_youtube")
    if not pending or pending.get("video_id") != request.video_id:
        raise HTTPException(
            status_code=400,
            detail="No transcript available for this video in your session. Open the video first.",
        )
    if pending.get("status") == "fetching":
        raise HTTPException(status_code=202, detail="Transcript is still being processed. Please try again in a moment.")
    transcript = pending.get("transcript")
    if not transcript:
        raise HTTPException(
            status_code=422,
            detail="Transcript not available — cannot generate practical tasks for this video.",
        )

    from config import GEMINI_API_KEY, GEMINI_PRACTICAL_MODEL, PRACTICAL_AI_PROMPT_VERSION

    try:
        # Try cache first (manual check so we know whether it was a hit)
        cached_tasks = quiz_service._load_practicals_from_cache(
            request.video_id, PRACTICAL_AI_PROMPT_VERSION
        ) if request.use_cache else None
        was_cached = bool(cached_tasks)

        tasks = quiz_service.generate_practical_tasks(
            transcript=transcript,
            video_id=request.video_id,
            groq_api_keys=GROQ_API_KEYS,
            gemini_api_key=GEMINI_API_KEY,
            gemini_model=GEMINI_PRACTICAL_MODEL,
            lecture_title=pending.get("lecture_title", ""),
            prompt_version=PRACTICAL_AI_PROMPT_VERSION,
            use_cache=request.use_cache,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error("[PRACTICAL] AI generation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"AI practical generation failed: {e}")

    return AIPracticalResponse(
        video_id=request.video_id,
        tasks=[AIPracticalTask(**t) for t in tasks],
        cached=was_cached,
    )


@app.post("/classroom/analyse")
async def classroom_analyse(request: ClassroomAnalyseRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not configured.")

    from app.services import classroom_service
    try:
        result = classroom_service.analyse_frame(request.frame_base64, OPENAI_API_KEY)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error("[CLASSROOM] Error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Classroom analysis failed: {str(e)}")


@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    text = request.text.strip()

    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    # get_running_loop() is the supported replacement for get_event_loop() in
    # Python 3.12+ inside async handlers — and we're guaranteed to be inside one here.
    loop = asyncio.get_running_loop()
    audio = await loop.run_in_executor(
        _tts_pool,
        _generate_tts_sync,
        text[:4000],
        _pick_tts_voice(text),
        TTS_RATE,
    )

    if not audio:
        raise HTTPException(status_code=500, detail="TTS generation failed")

    from fastapi.responses import Response as _BinaryResponse
    return _BinaryResponse(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-cache"})

_frontend_dir = Path(__file__).resolve().parent.parent / "frontend"

_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

@app.get("/", include_in_schema=False)
@app.get("/app", include_in_schema=False)
async def serve_root():
    return RedirectResponse(url="/app/", status_code=302)

@app.get("/app/", include_in_schema=False)
async def serve_index():
    """Serve index.html dynamically — injects live timestamp into CSS/JS URLs so no CDN or browser can ever serve stale assets."""
    from fastapi.responses import Response as _HTMLResponse
    html = (_frontend_dir / "index.html").read_text(encoding="utf-8")
    ts = int(time.time())
    html = re.sub(r'\?v=[^"\'&\s]+', f'?v={ts}', html)
    return _HTMLResponse(content=html, media_type="text/html", headers=_NO_CACHE_HEADERS)

_MEDIA_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".css": "text/css", ".js": "application/javascript",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
}

@app.get("/app/{file_path:path}", include_in_schema=False)
async def serve_static(file_path: str):
    """Serve any static file under frontend/ — handles audio, CSS, JS, images."""
    full_path = _frontend_dir / file_path
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    suffix = full_path.suffix.lower()
    media_type = _MEDIA_TYPES.get(suffix, "application/octet-stream")
    cache = "public, max-age=3600" if suffix in (".mp3", ".wav", ".ogg", ".png", ".jpg", ".ico", ".woff2", ".woff") else "no-cache"
    return Response(
        content=full_path.read_bytes(),
        media_type=media_type,
        headers={"Cache-Control": cache},
    )

if _frontend_dir.exists():
    app.mount("/app", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")

def run():
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )

if __name__ == "__main__":
    run()







                
            
            
        
            




