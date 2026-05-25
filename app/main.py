
import sys
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, File, UploadFile, Form, Depends
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

        logger.info("Initializing vector store service...")
        t0 = time.perf_counter()
        vector_store_service = VectorStoreService()
        vector_store_service.create_vector_store()
        logger.info("[TIMING] startup_vector_store: %.3fs", time.perf_counter() - t0)
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
        logger.info("  - Vector Store: Ready")
        logger.info("  - Groq AI (General): Ready")
        logger.info("  - Groq AI (Realtime): Ready")
        logger.info("  - Brain (Unified Decision): Ready")
        logger.info("  - Task Executor: Ready")
        logger.info("  - Background Task Manager: Ready")
        logger.info("  - Vision (Groq): Ready")
        logger.info("  - Chat Service: Ready")

        # TTS connectivity test — shows in HuggingFace logs which engine is active
        try:
            _tts_test_fut = _tts_pool.submit(_generate_tts_sync, "Hello Sir", TTS_VOICE, TTS_RATE)
            _tts_test_audio = _tts_test_fut.result(timeout=15)
            if _tts_test_audio:
                logger.info("  - TTS: Ready — %d bytes (engine=edge-tts or gTTS fallback, voice=%s)", len(_tts_test_audio), TTS_VOICE)
            else:
                logger.error("  - TTS: FAILED — both edge-tts and gTTS returned empty audio")
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

import threading as _threading
_piper_voice_obj = None
_piper_voice_failed = False
_piper_voice_lock = _threading.Lock()

_PIPER_MODELS = [
    '/app/models/en_IN-male-medium.onnx',  # Indian English male (preferred)
    '/app/models/en_US-ryan-high.onnx',    # American English male (fallback)
]

def _get_piper_voice():
    global _piper_voice_obj, _piper_voice_failed
    if _piper_voice_failed:
        return None
    if _piper_voice_obj is not None:
        return _piper_voice_obj
    with _piper_voice_lock:
        if _piper_voice_obj is None and not _piper_voice_failed:
            try:
                import os
                from piper.voice import PiperVoice
                for model in _PIPER_MODELS:
                    if os.path.exists(model):
                        _piper_voice_obj = PiperVoice.load(model)
                        logger.info("[TTS] Piper voice loaded: %s", model)
                        break
                if _piper_voice_obj is None:
                    logger.warning("[TTS] No piper model found in %s", _PIPER_MODELS)
                    _piper_voice_failed = True
            except Exception as e:
                logger.warning("[TTS] Piper init failed: %s", e)
                _piper_voice_failed = True
    return _piper_voice_obj

def _piper_male(text: str) -> bytes:
    """Piper VITS neural TTS — Indian English male, runs 100% locally, no network."""
    try:
        import io, wave, subprocess as _sp
        voice = _get_piper_voice()
        if voice is None:
            return b""
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            voice.synthesize(text, wf)
        wav_bytes = buf.getvalue()
        if not wav_bytes:
            return b""
        result = _sp.run(
            ['ffmpeg', '-i', 'pipe:0', '-f', 'mp3', '-ar', '22050', '-ab', '64k',
             'pipe:1', '-loglevel', 'quiet'],
            input=wav_bytes, capture_output=True, timeout=20,
        )
        return result.stdout or b""
    except Exception as e:
        logger.warning("[TTS] piper failed: %s", e)
        return b""


def _generate_tts_sync(text: str, voice: str, rate: str) -> bytes:
    import sys as _sys, os as _os, subprocess as _sp, tempfile as _tf

    # Tier 1: edge-tts in a fresh Python subprocess (clean event loop, no uvicorn asyncio conflict)
    # Use sys.executable — always the correct interpreter regardless of PATH
    tmp = _tf.NamedTemporaryFile(suffix='.mp3', delete=False)
    tmpfile = tmp.name
    tmp.close()
    try:
        script = (
            "import asyncio, edge_tts\n"
            "async def _r():\n"
            f"    c = edge_tts.Communicate(text={repr(text)}, voice={repr(voice)}, rate={repr(rate)})\n"
            f"    await c.save({repr(tmpfile)})\n"
            "asyncio.run(_r())\n"
        )
        result = _sp.run([_sys.executable, '-c', script], capture_output=True, timeout=30)
        if result.returncode == 0 and _os.path.getsize(tmpfile) > 0:
            with open(tmpfile, 'rb') as f:
                audio = f.read()
            if audio:
                logger.info("[TTS] edge-tts OK voice=%s len=%d", voice, len(audio))
                return audio
        logger.warning("[TTS] edge-tts subprocess exit %d: %s", result.returncode, result.stderr[-300:])
    except Exception as e:
        logger.warning("[TTS] edge-tts subprocess failed: %s", e)
    finally:
        try:
            _os.unlink(tmpfile)
        except OSError:
            pass

    # Tier 2: Piper neural TTS — Indian English male, local, no network needed
    audio = _piper_male(text)
    if audio:
        return audio

    # Tier 3: gTTS — last resort (natural female Indian English)
    try:
        from gtts import gTTS
        import io
        tts = gTTS(text=text, lang="en", tld="co.in")
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        audio = buf.getvalue()
        if audio:
            return audio
        raise RuntimeError("gTTS returned empty bytes")
    except Exception as e:
        logger.error("[TTS] gTTS also failed: %s", e)
        return b""

def _pick_tts_voice(text: str) -> str:
    if any('ऀ' <= c <= 'ॿ' for c in text):
        return 'hi-IN-MadhurNeural'
    return TTS_VOICE

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

    loop = asyncio.get_event_loop()
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







                
            
            
        
            




