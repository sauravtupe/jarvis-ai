import base64
import json
import logging
import re
import time
from pathlib import Path
from typing import List, Optional, Dict, Iterator, Any, Union
import uuid
import threading

from config import CHATS_DATA_DIR, CAMERA_CAPTURES_DIR, MAX_CHAT_HISTORY_TURNS, GROQ_API_KEYS, CLASSROOM_MODE
from app.models import ChatMessage
from app.services.teacher_persona import build_teacher_prompt, format_division_context
from app.services.groq_service import GroqService
from app.services.realtime_service import RealtimeGroqService
from app.services.brain_service import BrainService
from app.services.decision_types import (CATEGORY_GENERAL, CATEGORY_REALTIME, CATEGORY_CAMERA, CATEGORY_TASK, CATEGORY_MIXED, HEAVY_INTENTS, INSTANT_INTENTS)
from app.services.task_executor import TaskExecutor, TaskResponse
from app.services.task_manager import TaskManager
from app.services.vision_service import VisionService
from app.utils.key_rotation import get_next_key_pair

CAMERA_BYPASS_TOKEN = "TTCAMTOKENTT"

# ----------------------------------------------------------------------------
# Manual conversation-language mode (English / Hindi / Marathi)
# ----------------------------------------------------------------------------
# A spoken or typed command like "speak in Marathi" / "Marathi mein baat karo" /
# "मराठीत बोल" switches the whole conversation's language. The choice persists in
# session metadata and drives BOTH the LLM reply language (a system-prompt
# directive) and the Azure TTS voice. There is NO auto-detection — it is purely
# manual, so existing behaviour is unchanged until the user issues a command.

# Language-name cues — English words + Devanagari + common romanizations.
_LANG_NAME_PATTERNS = {
    "en": re.compile(r"english|इंग्लिश|इंग्रजी|अंग्रेज़ी|अंग्रेजी", re.IGNORECASE),
    "hi": re.compile(r"hindi|हिंदी|हिन्दी", re.IGNORECASE),
    "mr": re.compile(r"marathi|मराठी", re.IGNORECASE),
}
# Switch-intent cues — must co-occur with a language name, so an incidental
# mention ("how do you say hi in Marathi") does NOT flip the conversation.
_LANG_SWITCH_INTENT = re.compile(
    r"speak|talk|switch|reply|respond|answer|converse|change|"
    r"baat\s*kar|बात\s*कर|बोल|मध्ये|में\s*बात",
    re.IGNORECASE,
)

_LANG_DISPLAY = {"en": "English", "hi": "Hindi", "mr": "Marathi"}

# Confirmation spoken/shown in the NEWLY selected language.
_LANG_CONFIRMATIONS = {
    "en": "Sure, Sir. I'll speak with you in English from now on.",
    "hi": "ठीक है सर, अब मैं आपसे हिंदी में बात करूँगा।",
    "mr": "ठीक आहे सर. आता मी तुमच्याशी मराठीत बोलेन.",
}
# Directive appended to the LLM system prompt while a language is active.
_LANG_DIRECTIVES = {
    "en": "IMPORTANT: The user has chosen English as the conversation language. "
          "Reply ONLY in English, no matter what language the user writes in.",
    "hi": "IMPORTANT: The user has chosen Hindi as the conversation language. "
          "Reply ONLY in Hindi (हिंदी, Devanagari script), no matter what language the user writes in.",
    "mr": "IMPORTANT: The user has chosen Marathi as the conversation language. "
          "Reply ONLY in Marathi (मराठी, Devanagari script) — never Hindi — "
          "no matter what language the user writes in.",
}


# Localized lines for the AI-Teacher "start / next class" flow (spoken to the class
# in its own language). {ch} = localized chapter label, {title} = lecture title,
# {cls} = class label.
_CH_LABEL = {"en": "Chapter {n}", "hi": "अध्याय {n}", "mr": "धडा {n}"}
_START_CLASS_FRIENDLY = {
    "en": "Alright students, let's begin {ch}: {title}! Watch the lecture carefully, and come back when you're done — we'll discuss it together.",
    "hi": "ठीक है बच्चों, चलिए {ch}: {title} शुरू करते हैं! ध्यान से लेक्चर देखिए और देखने के बाद वापस आइए — हम मिलकर इस पर चर्चा करेंगे।",
    "mr": "चला विद्यार्थ्यांनो, आपण {ch}: {title} सुरू करूया! लेक्चर लक्षपूर्वक पाहा आणि झाल्यावर परत या — आपण त्यावर एकत्र चर्चा करूया.",
}
_START_NO_LECTURES = {
    "en": "Students, no AI lectures have been uploaded for {cls} yet. Please ask your teacher to add them from the Lectures panel.",
    "hi": "बच्चों, {cls} के लिए अभी तक कोई AI लेक्चर अपलोड नहीं हुआ है। कृपया अपने शिक्षक से Lectures पैनल से जोड़ने को कहें।",
    "mr": "विद्यार्थ्यांनो, {cls} साठी अजून कोणतेही AI लेक्चर अपलोड केलेले नाही. कृपया तुमच्या शिक्षकांना Lectures पॅनलमधून जोडण्यास सांगा.",
}
_START_ALL_DONE = {
    "en": "Wonderful work, students — we've completed all the AI lectures uploaded for {cls}! 🎉 We can revise any chapter you'd like.",
    "hi": "शाबाश बच्चों — हमने {cls} के सभी AI लेक्चर पूरे कर लिए हैं! 🎉 आप जो भी अध्याय चाहें, हम दोहरा सकते हैं।",
    "mr": "शाब्बास विद्यार्थ्यांनो — आपण {cls} चे सर्व AI लेक्चर पूर्ण केले आहेत! 🎉 तुम्हाला हवा असलेला कोणताही धडा आपण उजळणी करू शकतो.",
}
_VIDEO_WAIT = {
    "en": "One moment, students — I'm still preparing the lesson material. Please try again in a few seconds.",
    "hi": "एक मिनट बच्चों — मैं अभी पाठ की सामग्री तैयार कर रहा हूँ। कृपया कुछ सेकंड बाद फिर कोशिश कीजिए।",
    "mr": "एक मिनिट विद्यार्थ्यांनो — मी अजून धड्याची सामग्री तयार करत आहे. कृपया काही सेकंदांनी पुन्हा प्रयत्न करा.",
}
_VIDEO_READY = {
    "en": "Well done, students! Now, what would you like to do next?",
    "hi": "शाबाश बच्चों! अब आप आगे क्या करना चाहेंगे?",
    "mr": "शाब्बास विद्यार्थ्यांनो! आता तुम्हाला पुढे काय करायचे आहे?",
}
_REVISE_FRIENDLY = {
    "en": "Of course, students — let's revise {ch}: {title}. Watch it once more and tell me if anything is still unclear.",
    "hi": "बिलकुल बच्चों — चलिए {ch}: {title} दोहराते हैं। एक बार फिर देखिए और बताइए अगर कुछ समझ न आया हो।",
    "mr": "नक्कीच विद्यार्थ्यांनो — आपण {ch}: {title} ची उजळणी करूया. पुन्हा एकदा पाहा आणि काही अडचण असल्यास सांगा.",
}
_REVISE_NOTHING = {
    "en": "We haven't completed any AI lesson yet, students — let's start our first one instead. Just say 'start the class'.",
    "hi": "बच्चों, हमने अभी तक कोई AI पाठ पूरा नहीं किया है — चलिए पहला पाठ शुरू करते हैं। कहिए 'क्लास शुरू करो'।",
    "mr": "विद्यार्थ्यांनो, आपण अजून कोणताही AI धडा पूर्ण केलेला नाही — चला पहिला धडा सुरू करूया. फक्त म्हणा 'क्लास सुरू कर'.",
}
_REVISE_NOT_FOUND = {
    "en": "I don't have Chapter {n} saved for {cls}, students. Please ask your teacher to add it from the Lectures panel.",
    "hi": "बच्चों, {cls} के लिए अध्याय {n} सेव नहीं है। कृपया अपने शिक्षक से Lectures पैनल से जोड़ने को कहें।",
    "mr": "विद्यार्थ्यांनो, {cls} साठी धडा {n} सेव्ह केलेला नाही. कृपया तुमच्या शिक्षकांना Lectures पॅनलमधून जोडण्यास सांगा.",
}
_START_NEEDS_DIVISION = {
    "en": "Before we begin, please select your School, Class and Division using the classroom button at the top — then say 'start the class'.",
    "hi": "शुरू करने से पहले, कृपया ऊपर दिए classroom बटन से अपना स्कूल, कक्षा और डिवीज़न चुनें — फिर कहिए 'क्लास शुरू करो'।",
    "mr": "सुरू करण्यापूर्वी, कृपया वरील classroom बटणाने तुमची शाळा, वर्ग आणि तुकडी निवडा — मग म्हणा 'क्लास सुरू कर'.",
}


# One-shot LLM directives for assessment / doubts (Phase 3). These are meta-instructions
# to the teacher LLM (kept in English); the persona + language directive already force
# the reply into the division's language, so the produced content is in-character and in
# the right language. {topic} = current chapter title. {doubt} = the student's question.
_ASSESS_DIRECTIVE = {
    "quiz": "The class has asked for a QUICK QUIZ on the current AI lesson \"{topic}\". As their teacher, "
            "ask 5 age-appropriate multiple-choice questions (options a–d) about THIS AI lesson only, then "
            "give the correct answers at the end and encourage the class.",
    "worksheet": "The class has asked for a WORKSHEET on the current AI lesson \"{topic}\". As their teacher, "
                 "give 6–8 short numbered practice questions (mix of fill-in-the-blank, true/false and one-line "
                 "answers) about THIS AI lesson only. Do not include the answers unless asked.",
    "homework": "The class has asked for HOMEWORK on the current AI lesson \"{topic}\". As their teacher, assign "
                "2–3 short at-home tasks or questions about THIS AI lesson only, and say you'll review it next class.",
    "important": "The class has asked for the IMPORTANT QUESTIONS from the current AI lesson \"{topic}\". As their "
                 "teacher, list the 5 most important exam-style questions about THIS AI lesson only, each with a "
                 "short model answer.",
    "summary": "The class has asked for a SUMMARY of the current AI lesson \"{topic}\". As their teacher, give a "
               "clear, short recap of THIS AI lesson only (4–6 key points), then ask if there are any doubts.",
}
_DOUBT_DIRECTIVE = (
    "A student has raised this doubt during the AI lesson: \"{doubt}\". As their caring teacher, acknowledge it "
    "warmly, answer it clearly and simply (strictly about Artificial Intelligence), then check whether it is now "
    "clear. If the doubt is unrelated to AI, gently steer back to AI."
)


def match_language_command(text: str) -> Optional[str]:
    """Return 'en' | 'hi' | 'mr' if `text` is a language-switch command, else None.

    Requires BOTH a switch-intent cue and a language name so casual mentions of a
    language don't change the conversation language. Switch commands are short, so
    long messages are skipped cheaply."""
    if not text:
        return None
    t = text.strip()
    if len(t) > 120:
        return None
    if not _LANG_SWITCH_INTENT.search(t):
        return None
    # Check Marathi/Hindi before English so "switch from Hindi to Marathi" → mr.
    for lang in ("mr", "hi", "en"):
        if _LANG_NAME_PATTERNS[lang].search(t):
            return lang
    return None


def _save_camera_image(img_base64: str, session_id: str) -> Optional[str]:

    if not img_base64:
        return None

    raw = img_base64.split(",", 1)[-1] if "," in img_base64 else img_base64

    try:

        data = base64.b64decode(raw)
        if len(data) < 1000:
            logger.warning("[VISION] Captured image very small (%d bytes), may be invalid", len(data))

        ts = time.strftime("%Y%m%d_%H%M%S", time.localtime())
        safe_id = (session_id or "").replace("/", "_")[:16] or "unknown"
        filename = f"cam_{safe_id}_{ts}.jpg"

        from app.services.storage_service import upload_bytes_to_s3
        url = upload_bytes_to_s3(data, f"camera/{filename}", content_type="image/jpeg")
        if url:
            logger.info("[VISION] Camera capture → S3: camera/%s (%d bytes)", filename, len(data))
            return url

        # S3 not configured — fall back to local disk
        if CAMERA_CAPTURES_DIR:
            path = CAMERA_CAPTURES_DIR / filename
            path.write_bytes(data)
            logger.info("[VISION] Camera capture saved locally: %s (%d bytes)", path.name, len(data))
        return None

    except Exception as e:
        logger.warning("[VISION] Failed to save camera image: %s", e)
        return None


logger = logging.getLogger("J.A.R.V.I.S")
JARVIS_BRAIN_SEARCH_TIMEOUT = 15
SAVE_EVERY_N_CHUNKS = 5

class ChatService:

    def __init__(
        self,
        groq_service: GroqService,
        realtime_service: RealtimeGroqService = None,
        brain_service=None,
        task_executor: TaskExecutor = None,
        vision_service: VisionService = None,
        task_manager: TaskManager = None,
    ):

        self.groq_service = groq_service
        self.realtime_service = realtime_service
        self.brain_service = brain_service
        self.task_executor = task_executor
        self.vision_service = vision_service
        self.task_manager = task_manager
        self.sessions: Dict[str, List[ChatMessage]] = {}
        self._save_lock = threading.Lock()
        self._session_metadata: Dict[str, dict] = {}
        self._metadata_lock = threading.Lock()

    def load_session_from_disk(self, session_id: str) -> bool:

        safe_session_id = session_id.replace("-", "").replace(" ", "_")
        filename = f"chat_{safe_session_id}.json"
        filepath = CHATS_DATA_DIR / filename

        if not filepath.exists():
            return False
        
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                chat_dict = json.load(f)

            messages = []

            for msg in chat_dict.get("messages", []):
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                role = role if role in ("user", "assistant") else "user"
                content = msg.get("content")
                content = content if isinstance(content, str) else str(content or "")
                messages.append(ChatMessage(role=role, content=content))

            self.sessions[session_id] = messages
            return True

        except Exception as e:
            logger.warning("Failed to load session %s from disk: %s", session_id, e)
            return False

    def validate_session_id(self, session_id: str) -> bool:

        if not session_id or not session_id.strip():
            return False

        if "\0" in session_id:
            return False

        if ".." in session_id or "/" in session_id or "\\" in session_id:
            return False

        if len(session_id) > 255:
            return False

        return True
    
    def get_or_create_session(self, session_id: Optional[str] = None) -> str:
        
        t0 = time.perf_counter()
        
        if not session_id:
            new_session_id = str(uuid.uuid4())
            self.sessions[new_session_id] = []
            logger.info("[TIMING] session_get_or_create: %.3fs (new)", time.perf_counter() - t0)
            return new_session_id
        
        if not self.validate_session_id(session_id):
            raise ValueError(
                f"Invalid session_id format: {session_id}. Session ID must be non-empty, "
                "not contain path traversal characters, and be under 255 characters."
            )
            
        if session_id in self.sessions:
            logger.info("[TIMING] session_get_or_create: %.3fs (memory)", time.perf_counter() - t0)
            return session_id
        
        if self.load_session_from_disk(session_id):
            logger.info("[TIMING] session_get_or_create: %.3fs (disk)", time.perf_counter() - t0)
            return session_id
            
        self.sessions[session_id] = []
        logger.info("[TIMING] session_get_or_create: %.3fs (new_id)", time.perf_counter() - t0)
        return session_id

    def add_message(self, session_id: str, role: str, content: str):
        
        if session_id not in self.sessions:
            self.sessions[session_id] = []
        self.sessions[session_id].append(ChatMessage(role=role, content=content))

    def get_chat_history(self, session_id: str) -> List[ChatMessage]:
        return self.sessions.get(session_id, [])
    
    def format_history_for_llm(self, session_id: str, exclude_last: bool = False) -> List[tuple]:
        messages = self.get_chat_history(session_id)
        history = []
        messages_to_process = messages[:-1] if exclude_last and messages else messages

        i = 0
        while i < len(messages_to_process):
            if messages_to_process[i].role != "user":
                i += 1
                continue
            if i + 1 >= len(messages_to_process) or messages_to_process[i + 1].role != "assistant":
                i += 1
                continue
            user_msg = messages_to_process[i]
            ai_msg = messages_to_process[i + 1]
            u_content = user_msg.content if isinstance(user_msg.content, str) else str(user_msg.content or "")
            a_content = ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content or "")
            history.append((u_content, a_content))
            i += 2

        if len(history) > MAX_CHAT_HISTORY_TURNS:
            history = history[-MAX_CHAT_HISTORY_TURNS:]
        return history

    def set_session_metadata(self, session_id: str, key: str, value) -> None:
        with self._metadata_lock:
            if session_id not in self._session_metadata:
                self._session_metadata[session_id] = {}
            self._session_metadata[session_id][key] = value

    def get_session_metadata(self, session_id: str, key: str, default=None):
        with self._metadata_lock:
            return self._session_metadata.get(session_id, {}).get(key, default)

    def clear_session_metadata(self, session_id: str, key: str) -> None:
        with self._metadata_lock:
            if session_id in self._session_metadata:
                self._session_metadata[session_id].pop(key, None)

    def process_message(self, session_id: str, user_message: str) -> str:
        logger.info("[GENERAL] Session: %s | User: %.200s", session_id[:12], user_message)
        self.add_message(session_id, "user", user_message)
        chat_history = self.format_history_for_llm(session_id, exclude_last=True)
        logger.info("[GENERAL] History pairs sent to LLM: %d", len(chat_history))
        _, chat_idx = get_next_key_pair(len(GROQ_API_KEYS), need_brain=False)
        response = self.groq_service.get_response(question=user_message, chat_history=chat_history, key_start_index=chat_idx)
        self.add_message(session_id, "assistant", response)
        logger.info("[GENERAL] Response length: %d chars | Preview: %.120s", len(response), response)
        return response
    
    def process_realtime_message(self, session_id: str, user_message: str) -> str:
        
        if not self.realtime_service:
            raise ValueError("Realtime service is not initialized. Cannot process realtime queries.")

        logger.info("[REALTIME] Session: %s | User: %.200s", session_id[:12], user_message)
        self.add_message(session_id, "user", user_message)
        chat_history = self.format_history_for_llm(session_id, exclude_last=True)
        logger.info("[REALTIME] History pairs sent to LLM: %d", len(chat_history))
        _, chat_idx = get_next_key_pair(len(GROQ_API_KEYS), need_brain=False)
        response = self.realtime_service.get_response(question=user_message, chat_history=chat_history, key_start_index=chat_idx)
        self.add_message(session_id, "assistant", response)
        logger.info("[REALTIME] Response length: %d chars | Preview: %.120s", len(response), response)
        return response

    def _handle_youtube_video(
        self, session_id: str, video_id: str, full_url: Optional[str], friendly_text: Optional[str] = None,
        lecture_title: str = "",
    ) -> Iterator[Union[str, Dict[str, Any]]]:
        """Shared YouTube-detection flow.

        Sets pending_youtube, kicks off a background transcript fetch, yields
        the _youtube_detected event, then yields the friendly response and
        saves the chat session. Used by both the YouTube URL detection branch
        and the Feature 8 lecture command branch.
        """
        from app.services import quiz_service as _qs

        self.set_session_metadata(session_id, "pending_youtube", {
            "video_id": video_id,
            "transcript": None,
            "status": "fetching",
            "lecture_title": lecture_title,
        })

        def _fetch_bg(_vid=video_id, _sid=session_id, _title=lecture_title):
            try:
                _t = _qs.get_transcript(_vid)
                self.set_session_metadata(_sid, "pending_youtube", {
                    "video_id": _vid,
                    "transcript": _t,
                    "status": "ready",
                    "lecture_title": _title,
                })
                logger.info("[YOUTUBE] Background transcript ready for %s: %d chars", _vid, len(_t))
            except Exception as _e:
                self.set_session_metadata(_sid, "pending_youtube", {
                    "video_id": _vid,
                    "transcript": None,
                    "status": "failed",
                    "error": str(_e),
                    "lecture_title": _title,
                })
                logger.warning("[YOUTUBE] Background transcript failed for %s: %s", _vid, _e)

        threading.Thread(target=_fetch_bg, daemon=True).start()

        yield {"_youtube_detected": {"video_id": video_id, "url": full_url}}
        resp = friendly_text or (
            "I've opened the video for you, Sir. Watch the full video and come back when you're done "
            "— I'll generate MCQs, a summary, or answer any questions you have about it."
        )
        self.sessions[session_id][-1].content = resp
        yield resp
        self.save_chat_session(session_id)

    def process_message_stream(
        self, session_id: str, user_message: str
    ) -> Iterator[Union[str, Dict[str, Any]]]:
        logger.info("[GENERAL-STREAM] Session: %s | User: %.200s", session_id[:12], user_message)
        self.add_message(session_id, "user", user_message)
        self.add_message(session_id, "assistant", "")
        chat_history = self.format_history_for_llm(session_id, exclude_last=True)
        logger.info("[GENERAL-STREAM] History pairs sent to LLM: %d", len(chat_history))

        yield {"_activity": {"event": "query_detected", "message": user_message}}
        yield {"_activity": {"event": "routing", "route": "general"}}
        yield {"_activity": {"event": "streaming_started", "route": "general"}}

        _, chat_idx = get_next_key_pair(len(GROQ_API_KEYS), need_brain=False)
        chunk_count = 0
        t0 = time.perf_counter()

        try:
            for chunk in self.groq_service.stream_response(
                question=user_message, chat_history=chat_history, key_start_index=chat_idx
            ):
                if isinstance(chunk, dict):
                    yield chunk
                    continue

                if chunk_count == 0:
                    elapsed_ms = int((time.perf_counter() - t0) * 1000)
                    yield {"_activity": {"event": "first_chunk", "route": "general", "elapsed_ms": elapsed_ms}}

                self.sessions[session_id][-1].content += chunk
                chunk_count += 1

                if chunk_count % SAVE_EVERY_N_CHUNKS == 0:
                    self.save_chat_session(session_id, log_timing=False)
                yield chunk

        finally:
            final_response = self.sessions[session_id][-1].content
            logger.info("[GENERAL-STREAM] Completed | Chunks: %d | Response length: %d chars", chunk_count, len(final_response))
            self.save_chat_session(session_id)

    
    def process_realtime_message_stream(
        self, session_id: str, user_message: str
    ) -> Iterator[Union[str, Dict[str, Any]]]:

        if not self.realtime_service:
            raise ValueError("Realtime service is not initialized.")

        logger.info("[REALTIME-STREAM] Session: %s | User: %.200s", session_id[:12], user_message)
        self.add_message(session_id, "user", user_message)
        self.add_message(session_id, "assistant", "")
        chat_history = self.format_history_for_llm(session_id, exclude_last=True)
        logger.info("[REALTIME-STREAM] History pairs sent to LLM: %d", len(chat_history))
        yield {"_activity": {"event": "query_detected", "message": user_message}}
        yield {"_activity": {"event": "routing", "route": "realtime"}}
        yield {"_activity": {"event": "streaming_started", "route": "realtime"}}
        _, chat_idx = get_next_key_pair(len(GROQ_API_KEYS), need_brain=False)
        chunk_count = 0
        t0 = time.perf_counter()

        try:
            for chunk in self.realtime_service.stream_response(
                question=user_message, chat_history=chat_history, key_start_index=chat_idx
            ):

                if isinstance(chunk, dict):
                    yield chunk
                    continue

                if chunk_count == 0:
                    elapsed_ms = int((time.perf_counter() - t0) * 1000)
                    yield {"_activity": {"event": "first_chunk", "route": "realtime", "elapsed_ms": elapsed_ms}}

                self.sessions[session_id][-1].content += chunk
                chunk_count += 1

                if chunk_count % SAVE_EVERY_N_CHUNKS == 0:
                    self.save_chat_session(session_id, log_timing=False)
                yield chunk

        finally:
            final_response = self.sessions[session_id][-1].content
            logger.info("[REALTIME-STREAM] Completed | Chunks: %d | Response length: %d chars", chunk_count, len(final_response))
            self.save_chat_session(session_id)


    def _apply_active_division(self, session_id: str, division_id: str) -> None:
        """Bind a classroom (School->Class->Division) to this session.

        Runs only when the division actually changes (so a manual mid-class
        language switch isn't reset on every message). On change it stores the
        division context (for the Phase-2 teacher loop) and sets the session's
        conversation language from the division's preferred_language — that single
        line is what makes the Phase-0 persona greet/teach in the class's own
        language with no manual switch.
        """
        if not division_id:
            return
        if self.get_session_metadata(session_id, "active_division_id") == division_id:
            return
        try:
            from app.services import school_service
            info = school_service.get_division(division_id)
        except Exception as e:
            logger.warning("[JARVIS-STREAM] Division lookup failed for %s: %s", division_id, e)
            return
        if not info:
            return
        self.set_session_metadata(session_id, "active_division_id", division_id)
        self.set_session_metadata(session_id, "division_context", info)
        lang = (info.get("preferred_language") or "en").lower()
        if lang in _LANG_DIRECTIVES or lang == "en":
            self.set_session_metadata(session_id, "conversation_lang", lang)
        logger.info("[JARVIS-STREAM] Session %s → division %s (%s / %s, lang=%s)",
                    session_id[:12], division_id, info.get("school_name", ""),
                    info.get("grade_label", ""), lang)

    def _teacher_lang(self, session_id: str) -> str:
        """Active classroom language ('en'|'hi'|'mr') for canned teacher lines."""
        lang = self.get_session_metadata(session_id, "conversation_lang") or "en"
        return lang if lang in ("en", "hi", "mr") else "en"

    def _current_topic(self, division_id: str, div_ctx: dict):
        """Best-guess (title, chapter_number) the class is working on right now.

        Prefers the chapter in progress, then the most recently completed, then the
        next uncompleted. Used to focus assessment/doubt content on the right lesson.
        """
        try:
            from app.services import lecture_service as _ls2
            from app.services import progress_service as _prog
            chapters = _ls2.list_lectures_for_class(div_ctx.get("class_name", ""))
            if not chapters:
                return "", None
            prog = _prog.get_progress(division_id)
            cur = prog.get("current_chapter")
            if isinstance(cur, int):
                for c in chapters:
                    if c["chapter"] == cur:
                        return c.get("title", ""), cur
            done = prog.get("completed", [])
            if done:
                last = done[-1]
                return last.get("title", ""), last.get("chapter")
            nxt = _prog.next_uncompleted(division_id, chapters)
            if nxt:
                return nxt.get("title", ""), nxt.get("chapter")
        except Exception as e:
            logger.warning("[AI-TEACHER] current-topic lookup failed: %s", e)
        return "", None

    def _mark_watched_chapter_complete(self, session_id: str, video_id: Optional[str]) -> None:
        """Credit a just-watched lecture to the active division's progress.

        Only credits when the video belongs to THIS division's class, so a stray
        YouTube link the class watched can't mark a chapter done.
        """
        if not video_id:
            return
        div_id = self.get_session_metadata(session_id, "active_division_id")
        div_ctx = self.get_session_metadata(session_id, "division_context") or {}
        if not div_id or not div_ctx.get("class_name"):
            return
        try:
            from app.services import lecture_service as _ls2
            from app.services import progress_service as _prog
            slot = _ls2.find_lecture_by_video_id(video_id)
            if not slot or slot["class_name"] != div_ctx["class_name"]:
                return
            _prog.mark_complete(div_id, slot["chapter"], slot.get("title", ""))
        except Exception as e:
            logger.warning("[AI-TEACHER] mark-complete failed for %s: %s", video_id, e)

    def process_jarvis_message_stream(
        self, session_id: str, user_message: str, imgbase64: Optional[str] = None,
        division_id: Optional[str] = None,
    ) -> Iterator[Union[str, Dict[str, Any]]]:

        t0_jarvis = time.perf_counter()
        logger.info("[JARVIS-STREAM] Session: %s | User: %.200s | img: %s | div: %s",
                    session_id[:12], user_message[:80], "yes" if imgbase64 else "no",
                    division_id or "-")
        self.add_message(session_id, "user", user_message)
        self.add_message(session_id, "assistant", "")
        chat_history = self.format_history_for_llm(session_id, exclude_last=True)

        # Bind the active classroom (sets conversation_lang from the division's
        # language) BEFORE any language matching, so an explicit "speak in X" in
        # this same message still wins.
        self._apply_active_division(session_id, division_id)

        yield {"_activity": {"event": "query_detected", "message": user_message}}

        # --- Conversation language switch (manual mode) — runs FIRST ---
        # "speak in Marathi" / "Marathi mein baat karo" / "मराठीत बोल" etc. Sets the
        # session language (persists for the whole conversation), confirms in the
        # target language, and skips brain routing. Setting the metadata BEFORE
        # yielding means the confirmation is itself spoken in the new voice.
        _lang_switch = match_language_command(user_message)
        if _lang_switch:
            self.set_session_metadata(session_id, "conversation_lang", _lang_switch)
            _resp = _LANG_CONFIRMATIONS[_lang_switch]
            self.sessions[session_id][-1].content = _resp
            logger.info("[LANG] Session %s → %s", session_id[:12], _lang_switch)
            yield _resp
            self.save_chat_session(session_id)
            return

        from app.services import quiz_service as _qs
        from app.services import lecture_service as _ls

        # --- Notes / PPT command (pre-brain shortcut) ---
        # MUST run before the lecture-open shortcut: "class 1 chapter 2 notes" also
        # satisfies the lecture gate, but the student wants the notes, not the video.
        _pending_yt_for_notes = self.get_session_metadata(session_id, "pending_youtube")
        _notes_cmd = _ls.match_notes_command(user_message, pending_youtube=_pending_yt_for_notes)
        if _notes_cmd is not None:
            if _notes_cmd.get("_missing") == "class_chapter":
                _resp = (
                    "Sure, Sir! Which class and chapter notes would you like? "
                    "For example, say 'give me Class 1 Chapter 2 notes'."
                )
                self.sessions[session_id][-1].content = _resp
                yield _resp
                self.save_chat_session(session_id)
                return

            _class_display = "UKG" if _notes_cmd["class_name"] == "UKG" else f"Class {_notes_cmd['class_num']}"
            try:
                _notes = _ls.get_notes(_notes_cmd["class_name"], _notes_cmd["chapter"])
            except Exception as _e:
                logger.warning("[NOTES] lookup failed for %s / %d: %s",
                               _notes_cmd["class_name"], _notes_cmd["chapter"], _e)
                _notes = None

            if _notes:
                yield {"_notes": _notes}
                _resp = (
                    f"Here are the notes for {_class_display} Chapter {_notes_cmd['chapter']}, Sir — "
                    f"opening them in a new tab."
                )
            else:
                _resp = (
                    f"Sir, your teacher hasn't added notes for {_class_display} "
                    f"Chapter {_notes_cmd['chapter']} yet."
                )
            self.sessions[session_id][-1].content = _resp
            yield _resp
            self.save_chat_session(session_id)
            return

        # --- Revision command (pre-brain shortcut, AI Teacher Phase 2) ---
        # Runs BEFORE the lecture command so "revise class 5 chapter 1" re-opens the
        # chapter as revision (counted) rather than as a fresh lecture. Falls through
        # untouched when no classroom is selected, so nothing regresses outside teacher mode.
        if CLASSROOM_MODE:
            _rev_cmd = _ls.match_revision_command(user_message)
            _rev_div = self.get_session_metadata(session_id, "active_division_id")
            _rev_ctx = self.get_session_metadata(session_id, "division_context") or {}
            if _rev_cmd and _rev_div and _rev_ctx.get("class_name"):
                from app.services import progress_service as _prog
                _lang = self.get_session_metadata(session_id, "conversation_lang") or "en"
                _lang = _lang if _lang in ("en", "hi", "mr") else "en"
                _cls_label = _rev_ctx.get("grade_label") or _rev_ctx["class_name"]
                _chapters = _ls.list_lectures_for_class(_rev_ctx["class_name"])
                _want = _rev_cmd.get("chapter")
                if _want is None:
                    # No chapter named — revise the most recently completed one.
                    _done = _prog.get_progress(_rev_div)["completed"]
                    _want = _done[-1].get("chapter") if _done else None
                _target = next((c for c in _chapters if c["chapter"] == _want), None) if _want else None

                if _want is None:
                    _resp = _REVISE_NOTHING[_lang]
                elif _target is None:
                    _resp = _REVISE_NOT_FOUND[_lang].format(n=_want, cls=_cls_label)
                else:
                    _resp = None

                if _resp is not None:
                    self.sessions[session_id][-1].content = _resp
                    yield _resp
                    self.save_chat_session(session_id)
                    return

                _prog.record_revision(_rev_div, _target["chapter"])
                _prog.record_opened(_rev_div, _target["chapter"], _target.get("title", ""))
                _friendly = _REVISE_FRIENDLY[_lang].format(
                    ch=_CH_LABEL[_lang].format(n=_target["chapter"]), title=_target.get("title", ""),
                )
                logger.info("[AI-TEACHER] Revision → %s ch %d for div %s",
                            _rev_ctx["class_name"], _target["chapter"], _rev_div)
                yield from self._handle_youtube_video(
                    session_id, _target["video_id"], _target["youtube_url"],
                    friendly_text=_friendly, lecture_title=_target.get("title", ""),
                )
                return

        # --- Lecture catalog command (pre-brain shortcut, Feature 8) ---
        _lec = _ls.match_lecture_command(user_message)
        if _lec:
            if _lec.get("_missing") == "class":
                # Open-intent + chapter, but no class → ask rather than open a random video.
                _resp = (
                    "Sir, which class? For example, say 'open Class 3 Chapter 1' "
                    "or 'open 3rd standard chapter 1'. I have classes from UKG to Class 12."
                )
                self.sessions[session_id][-1].content = _resp
                yield _resp
                self.save_chat_session(session_id)
                return
            if _lec.get("_missing") == "chapter":
                _cd = "UKG" if _lec["class_name"] == "UKG" else f"Class {_lec['class_num']}"
                _resp = (
                    f"Sir, which chapter of {_cd} would you like me to open? "
                    f"For example, 'open {_cd} Chapter 1'."
                )
                self.sessions[session_id][-1].content = _resp
                yield _resp
                self.save_chat_session(session_id)
                return
            if _lec.get("_not_found"):
                # Command parsed but no video is saved for that slot.
                _miss_resp = (
                    f"Sir, I don't have a video saved for Class {_lec['class_num']} Chapter {_lec['chapter']}. "
                    f"You can add it from the Lectures panel."
                )
                self.sessions[session_id][-1].content = _miss_resp
                yield _miss_resp
                self.save_chat_session(session_id)
                return
            _friendly = (
                f"Opening Class {_lec['class_num']} Chapter {_lec['chapter']} — {_lec['title']}, Sir. "
                f"Watch the full video and come back when you're done."
            )
            yield from self._handle_youtube_video(
                session_id, _lec["video_id"], _lec["youtube_url"],
                friendly_text=_friendly, lecture_title=_lec.get("title", ""),
            )
            return

        # --- Start / continue the AI class (pre-brain shortcut, AI Teacher) ---
        # "start the class" / "open the lecture" / "next chapter" / "क्लास सुरू कर"
        # opens the right lecture for the SELECTED division's class automatically,
        # walking the chapter sequence. (Full progress intelligence — mark-complete,
        # revision, day-2 continuity — arrives in Phase 2.)
        if CLASSROOM_MODE:
            _start_cmd = _ls.match_start_class_command(user_message)
            if _start_cmd:
                _lang = self.get_session_metadata(session_id, "conversation_lang") or "en"
                _lang = _lang if _lang in ("en", "hi", "mr") else "en"
                _active_div = self.get_session_metadata(session_id, "active_division_id")
                _div_ctx = self.get_session_metadata(session_id, "division_context") or {}
                if not _active_div or not _div_ctx.get("class_name"):
                    _resp = _START_NEEDS_DIVISION[_lang]
                    self.sessions[session_id][-1].content = _resp
                    yield _resp
                    self.save_chat_session(session_id)
                    return

                _cls_label = _div_ctx.get("grade_label") or _div_ctx["class_name"]
                _chapters = _ls.list_lectures_for_class(_div_ctx["class_name"])
                if not _chapters:
                    _resp = _START_NO_LECTURES[_lang].format(cls=_cls_label)
                    self.sessions[session_id][-1].content = _resp
                    yield _resp
                    self.save_chat_session(session_id)
                    return

                from app.services import progress_service as _prog
                # "start" resumes the lesson in progress; "next" advances to the first
                # chapter the class hasn't completed yet.
                _target = _prog.resolve_target(_active_div, _chapters, _start_cmd["action"])

                if _target is None:
                    _resp = _START_ALL_DONE[_lang].format(cls=_cls_label)
                    self.sessions[session_id][-1].content = _resp
                    yield _resp
                    self.save_chat_session(session_id)
                    return

                _prog.record_opened(_active_div, _target["chapter"], _target.get("title", ""))
                _ch_label = _CH_LABEL[_lang].format(n=_target["chapter"])
                _friendly = _START_CLASS_FRIENDLY[_lang].format(
                    ch=_ch_label, title=_target.get("title", "")
                )
                logger.info("[AI-TEACHER] Start-class (%s) → %s ch %d for div %s",
                            _start_cmd["action"], _div_ctx["class_name"], _target["chapter"], _active_div)
                yield from self._handle_youtube_video(
                    session_id, _target["video_id"], _target["youtube_url"],
                    friendly_text=_friendly, lecture_title=_target.get("title", ""),
                )
                return

        # --- YouTube URL detection (pre-brain shortcut) ---
        _video_id = _qs.extract_video_id(user_message)
        if _video_id:
            _full_url = _qs.get_full_url(user_message)
            yield from self._handle_youtube_video(session_id, _video_id, _full_url)
            return

        # --- User returning after watching a video ---
        _pending_yt = self.get_session_metadata(session_id, "pending_youtube")
        if _pending_yt and _qs.is_return_signal(user_message):
            # AI Teacher (Phase 2): the class has watched this lecture — credit it to the
            # division now, BEFORE the transcript branches, so progress advances even if
            # the transcript fetch failed.
            if CLASSROOM_MODE:
                self._mark_watched_chapter_complete(session_id, _pending_yt.get("video_id"))
            _status = _pending_yt.get("status", "ready")

            if _status == "fetching":
                # Still downloading/transcribing — user came back very quickly
                _wait_resp = (_VIDEO_WAIT[self._teacher_lang(session_id)] if CLASSROOM_MODE
                              else "Sir, I'm still processing the video in the background. Give me a moment and try again.")
                self.sessions[session_id][-1].content = _wait_resp
                yield _wait_resp
                self.save_chat_session(session_id)
                return

            if _status == "failed" or not _pending_yt.get("transcript"):
                _err_detail = _pending_yt.get("error", "")
                self.clear_session_metadata(session_id, "pending_youtube")
                if "too long" in _err_detail.lower() or "25 mb" in _err_detail.lower():
                    _fail_resp = "Sir, this video is too long to transcribe — the audio exceeds the 25 MB processing limit. Try a shorter video."
                elif "supadata_key_missing" in _err_detail.lower():
                    _fail_resp = "Sir, the Supadata API key is not configured. Please add SUPADATA_API_KEY to your HuggingFace Secrets (get a free key at supadata.ai) and restart the space."
                elif "assemblyai_key_missing" in _err_detail.lower():
                    _fail_resp = "Sir, the AssemblyAI API key is not configured. Please add ASSEMBLYAI_API_KEY to your HuggingFace Secrets and restart the space."
                elif "assemblyai_failed" in _err_detail.lower():
                    _fail_resp = f"Sir, AssemblyAI transcription failed. Details: {_err_detail.replace('ASSEMBLYAI_FAILED: ', '')}"
                elif "no captions" in _err_detail.lower() or "audio download failed" in _err_detail.lower():
                    _fail_resp = "Sir, this video has no captions and I couldn't download the audio to transcribe it. Try a video that has auto-generated subtitles enabled."
                else:
                    _fail_resp = "Sir, I couldn't get the transcript for this video. Please make sure the video is public and has captions or auto-generated subtitles, then try again."
                self.sessions[session_id][-1].content = _fail_resp
                yield _fail_resp
                self.save_chat_session(session_id)
                return

            # Transcript is ready — keep metadata so quiz/summary endpoints can use it
            _pending_yt["status"] = "acknowledged"
            self.set_session_metadata(session_id, "pending_youtube", _pending_yt)
            yield {"_interactive_choice": {"type": "youtube_analysis", "video_id": _pending_yt["video_id"]}}
            _choice_resp = (_VIDEO_READY[self._teacher_lang(session_id)] if CLASSROOM_MODE
                            else "Sir, I've analysed the video. What would you like?")
            self.sessions[session_id][-1].content = _choice_resp
            yield _choice_resp
            self.save_chat_session(session_id)
            return

        # --- Assessment & doubt (pre-brain shortcut, AI Teacher Phase 3) ---
        # Sets a ONE-SHOT teacher directive so the LLM produces a quiz/worksheet/homework/
        # important-questions/summary — or answers a logged doubt — in character and in the
        # division's language, then falls through to the normal teacher LLM stream below.
        # (No early return: the directive is consumed where _extra_parts is assembled.)
        # `force_general` pins it to the teacher LLM route so the brain can't misfile a
        # "quiz"/"worksheet" as a TASK (image/content) intent.
        force_general = False
        if CLASSROOM_MODE:
            _a_div = self.get_session_metadata(session_id, "active_division_id")
            _a_ctx = self.get_session_metadata(session_id, "division_context") or {}
            if _a_div and _a_ctx.get("class_name"):
                _doubt_text = _ls.match_doubt_command(user_message)
                _assess = None if _doubt_text else _ls.match_assessment_command(user_message)
                if _doubt_text:
                    try:
                        from app.services import doubts_service as _ds
                        _, _dchap = self._current_topic(_a_div, _a_ctx)
                        _ds.record_doubt(_a_div, _dchap, _doubt_text)
                    except Exception as _de:
                        logger.warning("[AI-TEACHER] doubt log failed: %s", _de)
                    self.set_session_metadata(
                        session_id, "teacher_directive",
                        _DOUBT_DIRECTIVE.format(doubt=_doubt_text[:400]),
                    )
                    force_general = True
                elif _assess:
                    _topic, _achap = self._current_topic(_a_div, _a_ctx)
                    self.set_session_metadata(
                        session_id, "teacher_directive",
                        _ASSESS_DIRECTIVE[_assess["kind"]].format(topic=_topic or "the current AI topic"),
                    )
                    force_general = True
                    if _achap is not None:
                        try:
                            from app.services import progress_service as _prog
                            _prog.record_assessment(_a_div, _achap, _assess["kind"])
                        except Exception as _ae:
                            logger.warning("[AI-TEACHER] assessment log failed: %s", _ae)

        # --- Practical command detection (pre-brain shortcut, Feature 9) ---
        # Runs BEFORE the practice-PDF block because it's more specific (needs class + chapter).
        # If it doesn't match, the practice-PDF block (class-only) still handles class-wise queries.
        from app.services import practical_service as _ps
        _prac = _ps.match_practical_command(user_message, pending_youtube=_pending_yt)
        if _prac is not None:
            if _prac.get("_missing") == "class_chapter":
                _resp = "Sure, Sir! Which class and chapter would you like practical exercises for? For example, say 'practical for class 6 chapter 1'."
                self.sessions[session_id][-1].content = _resp
                yield _resp
                self.save_chat_session(session_id)
                return

            # Resolved class + chapter — build the practical bundle
            try:
                _bundle = _ps.build_practical_bundle(_prac["class_name"], _prac["chapter"])
            except Exception as _e:
                logger.warning("[PRACTICAL] bundle build failed for %s / %d: %s",
                               _prac["class_name"], _prac["chapter"], _e)
                _bundle = {
                    "class_name": _prac["class_name"],
                    "chapter": _prac["chapter"],
                    "lecture": {},
                    "curated": [],
                    "class_pdfs": [],
                }

            yield {"_practicals": _bundle}

            _class_display = "UKG" if _prac["class_name"] == "UKG" else f"Class {_prac['class_num']}"
            _has_curated = bool(_bundle.get("curated"))
            _has_pdfs = bool(_bundle.get("class_pdfs"))
            _lecture_known = bool(_bundle.get("lecture", {}).get("video_id"))

            if _has_curated or _lecture_known:
                _resp = (
                    f"Here are practical exercises for {_class_display} Chapter {_prac['chapter']}, Sir. "
                    f"I've included AI-generated tasks for this lecture too."
                ) if _lecture_known else (
                    f"Here are practical exercises for {_class_display} Chapter {_prac['chapter']}, Sir."
                )
            elif _has_pdfs:
                _resp = (
                    f"Sir, no specific practicals are saved for {_class_display} Chapter {_prac['chapter']} yet, "
                    f"but here are the general practice materials for {_class_display}."
                )
            else:
                _resp = (
                    f"Sir, no practical exercises are saved for {_class_display} Chapter {_prac['chapter']} yet. "
                    f"They can be added from the Lectures admin panel."
                )

            self.sessions[session_id][-1].content = _resp
            yield _resp
            self.save_chat_session(session_id)
            return

        # --- Practice PDF detection (pre-brain shortcut) ---
        import re as _re
        from app.services.practice_service import extract_class_from_message, list_pdfs_for_class
        _awaiting_class = self.get_session_metadata(session_id, "_practice_awaiting_class")
        _is_practice_msg = bool(_re.search(r'\b(practice|worksheet|exercises|study material|study sheet)\b', user_message or "", _re.IGNORECASE))
        # If the AI-Teacher assessment handler already claimed this message (e.g. "give us a
        # worksheet on this chapter"), don't also dump the class-wide practice PDFs.
        if self.get_session_metadata(session_id, "teacher_directive"):
            _is_practice_msg = False
            _awaiting_class = False
        if _is_practice_msg or _awaiting_class:
            _cls = extract_class_from_message(user_message)
            if _cls is None:
                # Still couldn't extract class — keep waiting and ask again
                self.set_session_metadata(session_id, "_practice_awaiting_class", True)
                if _awaiting_class:
                    _resp = "Sorry Sir, I didn't catch the class name. Please say something like 'class 5' or 'class two'."
                else:
                    _resp = "Sure, Sir! Which class would you like practice materials for? I have materials for UKG through Class 12."
            else:
                # Class found — clear waiting flag and show PDFs
                self.clear_session_metadata(session_id, "_practice_awaiting_class")
                _pdfs = list_pdfs_for_class(_cls)
                if not _pdfs:
                    _resp = f"Sir, no practice materials are uploaded for {_cls.replace('_', ' ').title()} yet."
                else:
                    yield {"_practice_files": {"class_name": _cls, "files": _pdfs}}
                    _resp = f"Here are the practice materials for {_cls.replace('_', ' ').title()}, Sir."
            self.sessions[session_id][-1].content = _resp
            yield _resp
            self.save_chat_session(session_id)
            return

        if imgbase64 and CAMERA_BYPASS_TOKEN in (user_message or ""):
            yield {"_activity": {"event": "decision", "query_type": "camera", "reasoning": "Image attached", "elapsed_ms": 0}}
            yield {"_activity": {"event": "routing", "route": "vision"}}
            yield {"_activity": {"event": "vision_analyzing", "message": "Analyzing image..."}}
            yield {"_activity": {"event": "streaming_started", "route": "vision"}}
            prompt = (user_message or "").replace(CAMERA_BYPASS_TOKEN, "").strip() or "What do you see in this image?"
            clean_msg = prompt or "What do you see in this image?"

            if self.sessions[session_id]:
                self.sessions[session_id][-2].content = clean_msg
            _save_camera_image(imgbase64, session_id)

            if self.vision_service:
                text = self.vision_service.describe_image(imgbase64, prompt)
            
            else:
                text = "Vision is not available. Please set GROQ_API_KEY."

            self.sessions[session_id][-1].content = text
            yield text
            self.save_chat_session(session_id)
            return

        brain_idx, chat_idx = get_next_key_pair(len(GROQ_API_KEYS), need_brain=bool(self.brain_service))
        category = CATEGORY_GENERAL
        primary_elapsed_ms = 0
        primary_method = "default"

        # Upload messages already have extracted content in the text — skip camera routing entirely
        is_upload_message = (user_message or "").lstrip().startswith("[Uploaded:")

        if force_general:
            # Assessment / doubt directive is pending — keep it on the teacher LLM route.
            category, primary_method = CATEGORY_GENERAL, "teacher"
        elif not is_upload_message and self.brain_service:
            category, primary_method, primary_elapsed_ms = self.brain_service.classify_primary(
                user_message, chat_history, key_index=brain_idx if brain_idx is not None else 0
            )

        yield {"_activity": {"event": "decision", "query_type": category, "reasoning": primary_method.capitalize(), "elapsed_ms": primary_elapsed_ms}}

        # Pre-compute video transcript context — available to all routing paths below
        _video_ctx_parts = None
        _ack_yt = self.get_session_metadata(session_id, "pending_youtube")
        if _ack_yt and _ack_yt.get("status") == "acknowledged" and _ack_yt.get("transcript"):
            _video_ctx_parts = [
                "=== VIDEO TRANSCRIPT ===\n"
                "The user watched a YouTube video this session. Use the transcript below to answer "
                "their questions accurately. Prioritise transcript content over general knowledge.\n\n"
                + _ack_yt["transcript"][:12000]
            ]
            yield {"_activity": {"event": "context_retrieved", "message": "Video transcript loaded into context"}}

        # Merge the active conversation-language directive (manual mode) into the
        # extra system parts so the general/realtime/mixed LLM routes always reply
        # in the selected language. Stays None when no language has been chosen.
        _conv_lang = self.get_session_metadata(session_id, "conversation_lang")
        _extra_parts = []
        # Teacher persona FIRST so it dominates the base "AI assistant" prompt (it is
        # appended after the base, and explicitly overrides it). The selected division's
        # facts (School/Class/Division/Language) are injected so the teacher answers
        # "which class am I in?" correctly instead of hallucinating.
        if CLASSROOM_MODE:
            _div_info = self.get_session_metadata(session_id, "division_context")
            _div_ctx_str = format_division_context(_div_info) if _div_info else ""
            # Phase 2 — append where this class actually is in the curriculum, so the
            # teacher can recap the last lesson and name the next one instead of guessing.
            if _div_info and _div_info.get("class_name"):
                try:
                    from app.services import progress_service as _prog2
                    _prog_lines = _prog2.build_context_lines(
                        self.get_session_metadata(session_id, "active_division_id"),
                        _ls.list_lectures_for_class(_div_info["class_name"]),
                    )
                    if _prog_lines:
                        _div_ctx_str = f"{_div_ctx_str}\n{_prog_lines}" if _div_ctx_str else _prog_lines
                    # Phase 3 — surface unresolved doubts so the recap can address them.
                    from app.services import doubts_service as _ds2
                    _doubt_lines = _ds2.recap_lines(
                        self.get_session_metadata(session_id, "active_division_id")
                    )
                    if _doubt_lines:
                        _div_ctx_str = f"{_div_ctx_str}\n{_doubt_lines}" if _div_ctx_str else _doubt_lines
                except Exception as _pe:
                    logger.warning("[AI-TEACHER] progress context unavailable: %s", _pe)
            _extra_parts.append(build_teacher_prompt(
                language=_conv_lang or "en", division_context=_div_ctx_str
            ))
            # Phase 3 — one-shot assessment/doubt directive (consumed then cleared),
            # appended AFTER the persona so it shapes just this reply.
            _directive = self.get_session_metadata(session_id, "teacher_directive")
            if _directive:
                _extra_parts.append(_directive)
                self.clear_session_metadata(session_id, "teacher_directive")
        if _video_ctx_parts:
            _extra_parts.extend(_video_ctx_parts)
        if _conv_lang in _LANG_DIRECTIVES:
            _extra_parts.append(_LANG_DIRECTIVES[_conv_lang])
        _extra_parts = _extra_parts or None

        if category == CATEGORY_CAMERA:
            yield {"_activity": {"event": "routing", "route": "camera"}}

            if imgbase64:
                yield {"_activity": {"event": "vision_analyzing", "message": "Analyzing image..."}}
                yield {"_activity": {"event": "streaming_started", "route": "vision"}}
                _save_camera_image(imgbase64, session_id)

                if self.vision_service:
                    text = self.vision_service.describe_image(imgbase64, user_message)
                
                else:
                    text = "Vision is not available. Please set GROQ_API_KEY."
            
            else:
                text = "Let me take a look..."
                yield {"_actions": {"wopens": [], "plays": [], "images": [], "contents": [],
                                   "googlesearches": [], "youtubesearches": [],
                                   "cam": {"action": "open_and_capture", "resend_message": user_message}}}
                yield {"_activity": {"event": "actions_emitted", "message": "camera (auto-capture)"}}

            self.sessions[session_id][-1].content = text
            yield text
            self.save_chat_session(session_id)
            elapsed_jarvis = time.perf_counter() - t0_jarvis
            logger.info("[JARVIS-STREAM] Camera flow complete in %.2fs", elapsed_jarvis)
            return
        


        if category in (CATEGORY_TASK, CATEGORY_MIXED):
            yield {"_activity": {"event": "routing", "route": "task" if category == CATEGORY_TASK else "mixed"}}

            task_types = []
            task_elapsed_ms = 0
            task_method = "default"
            if self.brain_service:
                task_types, task_method, task_elapsed_ms = self.brain_service.classify_task(
                    user_message, chat_history, key_index=brain_idx if brain_idx is not None else 0
                )

            task_name = ", ".join(task_types[:3]) if task_types else "task"
            yield {"_activity": {"event": "intent_classified", "intent": task_name}}

            intents = self.brain_service.extract_task_payloads(user_message, task_types, chat_history) if self.brain_service else []

            instant_intents = [(t, p) for t, p in intents if t not in HEAVY_INTENTS]
            heavy_intents = [(t, p) for t, p in intents if t in HEAVY_INTENTS]

            instant_response = TaskResponse()

            if self.task_executor and instant_intents:
                yield {"_activity": {"event": "tasks_executing", "message": f"Running instant tasks..."}}
                instant_response = self.task_executor.execute(instant_intents, chat_history)
                yield {"_activity": {"event": "tasks_completed", "message": "Instant tasks done"}}

                has_instant_actions = (
                instant_response.wopens or instant_response.plays or
                instant_response.googlesearches or instant_response.youtubesearches or
                instant_response.cam
                )

                if has_instant_actions:
                    actions = {
                        "wopens": instant_response.wopens,
                        "plays": instant_response.plays,
                        "images": [],
                        "contents": [],
                        "googlesearches": instant_response.googlesearches,
                        "youtubesearches": instant_response.youtubesearches,
                        "cam": instant_response.cam,
                    }


                    action_summary = []
                    if instant_response.wopens: action_summary.append("open")
                    if instant_response.plays: action_summary.append("play")
                    if instant_response.googlesearches or instant_response.youtubesearches: action_summary.append("search")
                    if instant_response.cam: action_summary.append("camera")
                    yield {"_activity": {"event": "actions_emitted", "message": ", ".join(action_summary) or "actions"}}
                    yield {"_actions": actions}

            bg_task_ids = []

            if self.task_manager and heavy_intents:
                yield {"_activity": {"event": "tasks_executing", "message": "Dispatching background tasks..."}}

                for intent_type, payload in heavy_intents:
                    task_id = self.task_manager.submit(intent_type, payload, chat_history)
                    bg_task_ids.append({"task_id": task_id, "type": intent_type, "label": payload.get("prompt", payload.get("message", ""))[:100]})

                yield {"_activity": {"event": "background_dispatched", "message": f"{len(bg_task_ids)} task(s) in background"}}

            elif not self.task_manager and heavy_intents:
                yield {"_activity": {"event": "tasks_executing", "message": f"Running {task_name}..."}}
                sync_response = self.task_executor.execute(heavy_intents, chat_history) if self.task_executor else TaskResponse()
                yield {"_activity": {"event": "tasks_completed", "message": "Tasks completed"}}

                if sync_response.images or sync_response.contents:
                    actions = {
                        "wopens": [], "plays": [],
                        "images": sync_response.images,
                        "contents": sync_response.contents,
                        "googlesearches": [], "youtubesearches": [],
                        "cam": None,
                    }
                    yield {"_actions": actions}
                instant_response.text = instant_response.text or sync_response.text

            if category == CATEGORY_MIXED:
                yield {"_activity": {"event": "streaming_started", "route": "mixed"}}
                stream_svc = self.realtime_service if self.realtime_service else self.groq_service
                chunk_count = 0
                t0 = time.perf_counter()

                try:
                    for chunk in stream_svc.stream_response(
                        question=user_message, chat_history=chat_history, key_start_index=chat_idx,
                        extra_system_parts=_extra_parts,
                    ):
                    
                        if isinstance(chunk, dict):
                            yield chunk
                            continue

                        if chunk_count == 0:
                            elapsed_ms = int((time.perf_counter() - t0) * 1000)
                            yield {"_activity": {"event": "first_chunk", "route": "mixed", "elapsed_ms": elapsed_ms}}

                        self.sessions[session_id][-1].content += chunk
                        chunk_count += 1

                        if chunk_count % SAVE_EVERY_N_CHUNKS == 0:
                            self.save_chat_session(session_id, log_timing=False)
                        yield chunk

                finally:
                    self.save_chat_session(session_id)

                if bg_task_ids:
                    yield {"_background_tasks": bg_task_ids}
                elapsed_jarvis = time.perf_counter() - t0_jarvis
                logger.info("[JARVIS-STREAM] Mixed flow complete in %.2fs | tasks: %s", elapsed_jarvis, task_types)
                return

            text_parts = []

            if instant_response.text:
                text_parts.append(instant_response.text)

            if bg_task_ids:
                bg_labels = []

                for bt in bg_task_ids:
                    if bt["type"] == "generate image":
                        bg_labels.append("image generation")
                    elif bt["type"] == "content":
                        bg_labels.append("content writing")
                    else:
                        bg_labels.append(bt["type"])

                text_parts.append(f"I'm working on the {', '.join(bg_labels)} in the background. I'll open it for you when it's ready.")

            text = " ".join(text_parts) if text_parts else "Done."
            self.sessions[session_id][-1].content = text
            yield text

            if bg_task_ids:
                yield {"_background_tasks": bg_task_ids}

            self.save_chat_session(session_id)
            elapsed_jarvis = time.perf_counter() - t0_jarvis
            logger.info("[JARVIS-STREAM] Task flow complete in %.2fs | tasks: %s | bg: %d", elapsed_jarvis, task_types, len(bg_task_ids))
            return

        use_realtime = category == CATEGORY_REALTIME and self.realtime_service
        route_name = "realtime" if use_realtime else "general"
        yield {"_activity": {"event": "routing", "route": route_name}}
        yield {"_activity": {"event": "streaming_started", "route": route_name}}

        stream_svc = self.realtime_service if use_realtime else self.groq_service
        chunk_count = 0
        t0 = time.perf_counter()

        try:
            for chunk in stream_svc.stream_response(
                question=user_message, chat_history=chat_history, key_start_index=chat_idx,
                extra_system_parts=_extra_parts,
            ):

                if isinstance(chunk, dict):
                    yield chunk
                    continue

                if chunk_count == 0:
                    elapsed_ms = int((time.perf_counter() - t0) * 1000)
                    yield {"_activity": {"event": "first_chunk", "route": route_name, "elapsed_ms": elapsed_ms}}

                self.sessions[session_id][-1].content += chunk
                chunk_count += 1

                if chunk_count % SAVE_EVERY_N_CHUNKS == 0:
                    self.save_chat_session(session_id, log_timing=False)
                yield chunk

        finally:
            self.save_chat_session(session_id)

        elapsed_jarvis = time.perf_counter() - t0_jarvis
        logger.info("[JARVIS-STREAM] %s flow complete in %.2fs | chunks: %d", route_name, elapsed_jarvis, chunk_count)

    
    def save_chat_session(self, session_id: str, log_timing: bool = True, sync_cloud: bool = False):

        if session_id not in self.sessions or not self.sessions[session_id]:
            return

        messages = self.sessions[session_id]

        safe_session_id = session_id.replace("-", "").replace(" ", "_")
        filename = f"chat_{safe_session_id}.json"
        filepath = CHATS_DATA_DIR / filename

        chat_dict = {
            "session_id": session_id,
            "messages": [{"role": msg.role, "content": msg.content} for msg in messages]
        }

        max_retries = 3
        last_exc = None
        saved = False

        for attempt in range(max_retries):
            try:
                with self._save_lock:
                    t0 = time.perf_counter() if log_timing else 0
                    with open(filepath, "w", encoding="utf-8") as f:
                        json.dump(chat_dict, f, indent=2, ensure_ascii=False)

                    if log_timing:
                        logger.info("[TIMING] save_session_json: %.3fs", time.perf_counter() - t0)
                saved = True
                break

            except OSError as e:
                last_exc = e
                if attempt < max_retries - 1:
                    time.sleep(0.1 * (attempt + 1))

            except Exception as e:
                logger.error("Failed to save chat session %s to disk: %s", session_id, e)
                return

        if not saved:
            logger.error("Failed to save chat session %s after %d retries: %s", session_id, max_retries, last_exc)
            return

        if sync_cloud and filepath.exists():
            try:
                from app.services.storage_service import upload_bytes_to_s3
                upload_bytes_to_s3(filepath.read_bytes(), f"chats/{filename}", content_type="application/json")
                logger.info("[CHAT] Session %s synced to S3", session_id[:8])
            except Exception as e:
                logger.warning("[CHAT] S3 sync failed for session %s: %s", session_id[:8], e)

        