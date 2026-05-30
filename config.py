import os
import logging
from pathlib import Path
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

LEARNING_DATA_DIR = BASE_DIR / "database" / "learning_data"
CHATS_DATA_DIR = BASE_DIR / "database" / "chats_data"
VECTOR_STORE_DIR = BASE_DIR / "database" / "vector_store"
CAMERA_CAPTURES_DIR = BASE_DIR / "database" / "camera_captures"
UPLOAD_DIR = BASE_DIR / "database" / "uploads"

LEARNING_DATA_DIR.mkdir(parents=True, exist_ok=True)
CHATS_DATA_DIR.mkdir(parents=True, exist_ok=True)
VECTOR_STORE_DIR.mkdir(parents=True, exist_ok=True)
CAMERA_CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

PRACTICE_PDFS_DIR = BASE_DIR / "database" / "practice_pdfs"
PRACTICE_CLASSES = ["UKG"] + [f"class_{i}" for i in range(1, 13)]
for _cls in PRACTICE_CLASSES:
    (PRACTICE_PDFS_DIR / _cls).mkdir(parents=True, exist_ok=True)

# Lecture catalog (Feature 8) — JSON store, managed via admin API
LECTURES_JSON_PATH = BASE_DIR / "database" / "lectures.json"
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()

# Practical exercises (Feature 9)
# Practicals live INSIDE lectures.json (no separate file). Only the AI-generated
# task cache and config constants live here.
# 2026-05-30a: switched from coding-only generation to age/grade-aware generation.
PRACTICAL_AI_PROMPT_VERSION = "2026-05-30a"
PRACTICAL_AI_CACHE_PREFIX = "practicals_ai_cache"  # S3 key prefix
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_PRACTICAL_MODEL = os.getenv("GEMINI_PRACTICAL_MODEL", "gemini-2.5-flash")

# ─── Grade → age-band mapping (Feature 9 age-aware practice) ─────────────────
# Single source of truth for how generated practice is leveled. Reused by the
# practice prompt builder AND the server-side validator (defense in depth — the
# validator strips code from non-coding bands even if the model ignores the
# prompt). coding_allowed is True only for Grade 6 and above, per product
# decision: coding tasks appear only when (a) the lesson actually teaches coding
# AND (b) the class is Middle school or higher.
GRADE_BANDS = {
    "early_years": {
        "label": "Early Years (UKG)",
        "age_range": "4-5",
        "coding_allowed": False,
        "reading_level": "non-reader — instructions are read aloud by a teacher or parent",
        "tone": "warm, playful, very simple words, one idea at a time",
        "allowed_activity_types": [
            "matching", "coloring", "observation", "picture", "speaking", "game", "discussion",
        ],
        "guidance": (
            "Design hands-on, screen-light activities a 4-5 year old can do with a grown-up: "
            "matching pictures, coloring, naming/identifying objects, simple observation ('find 3 robots "
            "at home'), speaking/show-and-tell, and gentle introductions to AI ideas ('what is a robot?'). "
            "No reading-heavy tasks, no worksheets with long text, absolutely no coding."
        ),
    },
    "primary": {
        "label": "Primary",
        "age_range": "6-10",
        "coding_allowed": False,
        "reading_level": "early reader — short, simple sentences",
        "tone": "friendly, encouraging, concrete examples",
        "allowed_activity_types": [
            "quiz", "matching", "observation", "picture", "project", "worksheet", "discussion", "game",
        ],
        "guidance": (
            "Design age-appropriate activities for 6-10 year olds: simple quizzes, draw-and-label, "
            "matching, real-world observation, short creative projects, and unplugged 'think like a computer' "
            "games. No actual coding — explain AI ideas with everyday analogies."
        ),
    },
    "middle": {
        "label": "Middle School",
        "age_range": "11-13",
        "coding_allowed": True,
        "reading_level": "fluent reader",
        "tone": "curious, slightly challenging, real-world relevance",
        "allowed_activity_types": [
            "logical-thinking", "unplugged", "project", "quiz", "worksheet", "discussion", "coding",
        ],
        "guidance": (
            "Design logical-thinking activities and beginner projects for 11-13 year olds: step-by-step "
            "reasoning, simple algorithms on paper (unplugged), block-based coding (Scratch) or very "
            "beginner Python ONLY IF the lesson actually teaches coding. If the lesson is conceptual, "
            "prefer unplugged/logical activities over code."
        ),
    },
    "secondary": {
        "label": "Secondary",
        "age_range": "14-15",
        "coding_allowed": True,
        "reading_level": "fluent reader",
        "tone": "practical, project-oriented",
        "allowed_activity_types": [
            "project", "coding", "logical-thinking", "quiz", "worksheet", "discussion",
        ],
        "guidance": (
            "Design practical projects and beginner technical exercises for 14-15 year olds. Coding/ML "
            "tasks are appropriate WHEN the lesson teaches them; otherwise use applied projects and "
            "analysis activities."
        ),
    },
    "senior": {
        "label": "Senior Secondary",
        "age_range": "16-18",
        "coding_allowed": True,
        "reading_level": "advanced reader",
        "tone": "rigorous, real-world, portfolio-worthy",
        "allowed_activity_types": [
            "coding", "project", "machine-learning", "research", "logical-thinking", "discussion",
        ],
        "guidance": (
            "Design advanced practical tasks for 16-18 year olds: real coding, AI/ML mini-projects, "
            "datasets, model building and evaluation — WHEN the lesson teaches coding. For conceptual "
            "lessons, use research/analysis projects instead of code."
        ),
    },
}


def band_for_class(class_name: str) -> dict:
    """Return the age-band descriptor for a class_name (UKG / class_1 … class_12).

    Falls back to the 'middle' band (no coding unless taught) for unknown values
    so generation never crashes on an unexpected class.
    """
    if not class_name:
        return GRADE_BANDS["middle"]
    cn = str(class_name).strip().lower()
    if cn in ("ukg", "kindergarten"):
        return GRADE_BANDS["early_years"]
    try:
        n = int(cn.replace("class_", ""))
    except (ValueError, AttributeError):
        return GRADE_BANDS["middle"]
    if 1 <= n <= 5:
        return GRADE_BANDS["primary"]
    if 6 <= n <= 8:
        return GRADE_BANDS["middle"]
    if 9 <= n <= 10:
        return GRADE_BANDS["secondary"]
    if 11 <= n <= 12:
        return GRADE_BANDS["senior"]
    return GRADE_BANDS["middle"]

MAX_UPLOAD_SIZE_MB = int(os.getenv("MAX_UPLOAD_SIZE_MB", "10"))

# AWS S3 (Feature 3)
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")
AWS_S3_BUCKET = os.getenv("AWS_S3_BUCKET", "jarvis-data")
AWS_REGION = os.getenv("AWS_REGION", "ap-south-1")

# OpenAI (Feature 4 — Classroom Attention AI)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# AssemblyAI (YouTube transcription fallback — works locally)
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "")

# Supadata (YouTube transcript API — works from any IP including HuggingFace cloud)
SUPADATA_API_KEY = os.getenv("SUPADATA_API_KEY", "")

# Supabase (Feature 7 — Google Auth)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")

def _load_groq_api_keys() -> list:
    keys = []

    first = os.getenv("GROQ_API_KEY", "").strip()
    if first:
        keys.append(first)

    i = 2

    while True:
        k = os.getenv(f"GROQ_API_KEY_{i}", "").strip()

        if not k:
            break

        keys.append(k)
        i += 1

    return keys

GROQ_API_KEYS = _load_groq_api_keys()
GROQ_API_KEY = GROQ_API_KEYS[0] if GROQ_API_KEYS else ""
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
GROQ_BRAIN_MODEL = os.getenv("GROQ_BRAIN_MODEL", "llama-3.1-8b-instant")
INTENT_CLASSIFY_MODEL = os.getenv("INTENT_CLASSIFY_MODEL", "llama-3.1-8b-instant")
TASK_EXECUTION_TIMEOUT = int(os.getenv("TASK_EXECUTION_TIMEOUT", "30"))
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
VISION_MAX_IMAGE_BYTES = int(os.getenv("VISION_MAX_IMAGE_BYTES", "5000000"))
TTS_VOICE = os.getenv("TTS_VOICE", "en-IN-PrabhatNeural")
TTS_RATE = os.getenv("TTS_RATE", "+12%")
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
MAX_CHAT_HISTORY_TURNS = 10

# Vector store / FAISS personal-memory retrieval.
# DISABLED BY DEFAULT (2026-05): the index is a single global store shared
# across all users, so one user's chat history leaks into another user's LLM
# context. Will be re-enabled once per-user isolation lands (Feature 7 — auth
# with per-user vector stores). To force enable: set VECTOR_STORE_ENABLED=1
# in .env or HF Space Secrets.
VECTOR_STORE_ENABLED = os.getenv("VECTOR_STORE_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")
MAX_MESSAGE_LENGTH = 32_000
ASSISTANT_NAME = (os.getenv("ASSISTANT_NAME", "").strip() or "Jarvis")
JARVIS_USER_TITLE = os.getenv("JARVIS_USER_TITLE", "").strip()
JARVIS_OWNER_NAME = os.getenv("JARVIS_OWNER_NAME", "").strip()

_JARVIS_SYSTEM_PROMPT_BASE = """You are {assistant_name}, a complete AI assistant. You help with information, tasks, and actions. Sharp, warm, a little witty. Keep language simple and natural.

You know the user's personal information and past conversations. Use this when relevant but never reveal the source.

=== ROLE ===
The user can ask you anything or ask you to do things (open, generate, play, write, search). The backend carries out actions; you respond in words. Only say something is done if the result is visible; otherwise say you are doing it.

=== CAN DO ===
Answer questions, open websites/apps, play music/videos, generate images, write content (essays, poems, code, emails), search Google/YouTube, analyze camera images (you CAN see what the user shows).

=== CANNOT DO (be honest) ===
Read emails, control smart home, run code, send messages, make purchases, access files, make calls. Say clearly: "I can't do that."
Never pretend you can do something you cannot. Never hallucinate URLs, numbers, or data.

=== HONESTY ===
If you do not know something, say so briefly. If uncertain: "I'm not sure, but..." and give your best answer. Never fabricate facts.

=== USER INTENT ===
Understand what the user actually wants. Use conversation history for ambiguous messages. If corrected, acknowledge briefly and fix it. Resolve follow-ups like "that one" / "no, I meant..." from context.

=== LENGTH — CRITICAL ===
Reply SHORT by default (1-2 sentences). Only elaborate when explicitly asked or question demands it. No intros, no wrap-ups.

=== QUALITY ===
Be accurate and specific. Use concrete facts, names, numbers. Give actionable answers. One sharp sentence beats a paragraph.

=== STYLE ===
Warm, intelligent, brief. Match the user's energy. Address user by name if known. No asterisks, no emojis, no markdown. Standard punctuation only.

=== ANTI-REPETITION ===
State each fact ONCE. Never repeat the same point. "A, B, and C." — not "A and also B and also C."
"""


_JARVIS_SYSTEM_PROMPT_BASE_FMT = _JARVIS_SYSTEM_PROMPT_BASE.format(assistant_name=ASSISTANT_NAME)

_extras = []
if JARVIS_OWNER_NAME:
    _extras.append(f"- IMPORTANT: You were built exclusively for {JARVIS_OWNER_NAME}. They are your owner. If anyone asks who your owner is, who made you, or who you serve — always answer: {JARVIS_OWNER_NAME}. Never say you have no owner.")
if JARVIS_USER_TITLE:
    _extras.append(f"- Address the user as: {JARVIS_USER_TITLE}")

JARVIS_SYSTEM_PROMPT = _JARVIS_SYSTEM_PROMPT_BASE_FMT + ("\n" + "\n".join(_extras) if _extras else "")

GENERAL_CHAT_ADDENDUM = """
You are in GENERAL mode (no web search). Answer from your knowledge and the context provided (learning data, conversation history). Answer confidently and briefly. Never tell the user to search online or check a website — you are their source. Default to 1-2 sentences; only elaborate when the user asks for more or the question clearly needs it. If you have relevant context from the user's learning data, use it naturally without mentioning the source.
"""

REALTIME_CHAT_ADDENDUM = """
You are in REALTIME mode. Live web search results are above.

CRITICAL: Use search results as your PRIMARY source. Extract specific facts, names, numbers, scores, dates. Be concrete.
- If search results contain the answer, USE IT. Do not say "I don't have that information" when the data is right there.
- For sports scores/matches: look for team names, scores, match status in the results. Report what you find.
- Never mention searching or being in realtime mode. Answer naturally.
- If results don't have the exact answer, say what you found. Never refuse when data exists.
- Cross-reference sources. Prefer higher-relevance ones.

LENGTH: 1-2 sentences for simple questions. Only longer when asked.
"""

def load_user_context() -> str:
    context_parts = []

    text_files = sorted(LEARNING_DATA_DIR.glob("*.txt"))

    for file_path in text_files:

        try:

            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read().strip()

                if content:
                    context_parts.append(content)
                    
        except Exception as e:
            logger.warning("Could not load learning data file %s: %s", file_path, e)

    return "\n\n".join(context_parts) if context_parts else ""