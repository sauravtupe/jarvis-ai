# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Read fully before touching any code. This is the single source of truth for core rules.
> For feature-specific details, read the relevant file in `.claude/features/` before starting work.

---

## Build Strategy

Auth and login are intentionally skipped for now. Build all features first. Add auth last as a final layer.

Use `user_id = 'test-user-001'` as placeholder everywhere user data is saved. When auth is added at the end (Feature 7), only replace this placeholder with the real JWT user ID.

---

## Current Working State (Do NOT re-build these)

| Feature | Status |
|---|---|
| Chat (general + realtime) | Working |
| Voice input (mic) | Working |
| TTS audio output | Working |
| Camera / Vision analysis | Working |
| WebGL orb animation | Working |
| FAISS memory | Working |
| Google Auth | Skipped — build last |
| Cloud storage | Not built |
| PDF/Image upload | Not built |
| YouTube MCQ | Not built |
| Classroom AI | Not built |
| 3D UI + Avatar | Not built |

---

## Features To Build (Strict Order)

| # | Feature | Detail File |
|---|---|---|
| 1 | PDF & Image Upload (Sidebar) | [.claude/features/feature1_pdf_image_upload.md](.claude/features/feature1_pdf_image_upload.md) |
| 2 | YouTube → MCQ Quiz | [.claude/features/feature2_youtube_mcq.md](.claude/features/feature2_youtube_mcq.md) |
| 3 | Cloud Storage + Auto-Delete | [.claude/features/feature3_cloud_storage.md](.claude/features/feature3_cloud_storage.md) |
| 4 | Classroom Attention AI | [.claude/features/feature4_classroom_ai.md](.claude/features/feature4_classroom_ai.md) |
| 5 | 3D UI Redesign (Frontend Only) | [.claude/features/feature5_3d_ui.md](.claude/features/feature5_3d_ui.md) |
| 6 | Animated AI Avatar (Frontend Only) | [.claude/features/feature6_avatar.md](.claude/features/feature6_avatar.md) |
| 7 | Google Auth + Supabase (LAST) | [.claude/features/feature7_auth.md](.claude/features/feature7_auth.md) |

**Before starting any feature: open its detail file and read it fully.**

---

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI (Python 3.12) + Uvicorn |
| AI Chat | Groq `llama-3.3-70b-versatile` |
| AI Brain | Groq `llama-3.1-8b-instant` |
| AI Vision | Groq `meta-llama/llama-4-scout-17b-16e-instruct` |
| AI Classroom | OpenAI GPT-4o Vision *(TO ADD — Feature 4)* |
| Search | Tavily API |
| Memory | FAISS + sentence-transformers (`all-MiniLM-L6-v2`, local) |
| TTS | edge-tts (en-GB-RyanNeural, +22%) |
| Frontend | Vanilla HTML + CSS + JS — NO frameworks ever |
| Auth | Supabase Google OAuth *(LAST — Feature 7)* |
| DB | Supabase PostgreSQL *(LAST — Feature 7)* |
| Storage | Supabase Storage + AWS S3 *(Feature 3)* |

---

## Project Structure

```
jarvis/
├── app/
│   ├── main.py                  → FastAPI app + all endpoints + TTS streaming
│   ├── models.py                → Pydantic models
│   ├── services/
│   │   ├── chat_service.py      → Core chat logic + session management
│   │   ├── groq_service.py      → Groq API wrapper + repetition detection + retry
│   │   ├── brain_service.py     → Intent classifier — routes to correct handler
│   │   ├── vision_service.py    → Image analysis via Groq (base64 input)
│   │   ├── task_executor.py     → Tasks: open URL, YouTube, image gen, camera
│   │   ├── task_manager.py      → Background task queue + status polling
│   │   ├── realtime_service.py  → Groq + Tavily web search
│   │   ├── vector_store.py      → FAISS semantic memory
│   │   └── decision_types.py    → Enums for brain routing
│   └── utils/
│       ├── retry.py             → Retry decorator
│       ├── key_rotation.py      → Groq multi-key rotation
│       └── time_info.py         → Injects current date/time into system prompt
├── frontend/
│   ├── index.html               → Single-page app
│   ├── script.js                → All frontend logic (chat, voice, camera)
│   ├── style.css                → All styling
│   └── orb.js                   → WebGL GLSL shader — DO NOT TOUCH THIS FILE
├── database/
│   ├── chats_data/              → JSON chat sessions
│   ├── learning_data/           → Context .txt files (drop files here to add memory)
│   ├── vector_store/            → FAISS index files
│   └── camera_captures/         → Local screenshots (migrate to S3 in Feature 3)
├── .claude/
│   └── features/                → Per-feature detail files (read before building)
├── config.py                    → All settings + env vars + system prompts
├── requirements.txt
├── run.py                       → Entry point
└── .env                         → API keys (never commit)
```

---

## Architecture

### Brain Routing Flow

Every message goes through `brain_service.py` (fast 8B model, ~200ms) which classifies intent and routes:

```
User message → brain_service (classify intent)
    ├── GENERAL   → groq_service.py (LLM + vector store context)
    ├── REALTIME  → realtime_service.py (query extraction + Tavily + LLM)
    ├── CAMERA    → vision_service.py (base64 image → Llama 4 Scout)
    └── TASK      → task_executor.py (open URL, play YouTube, generate image, etc.)
```

Always use `/chat/jarvis/stream` as the single main endpoint — never call mode-specific endpoints directly from the frontend.

### Personal Memory

On startup, `vector_store.py` loads all `.txt` files from `database/learning_data/`, chunks them (1000 chars, 200 overlap), and builds a FAISS index using local HuggingFace embeddings. Top-5 relevant chunks are injected into LLM context per message. Past conversation history is also indexed. The index persists in `database/vector_store/`.

### Multi-Key Rotation

`app/utils/key_rotation.py` reads `GROQ_API_KEY`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3`, etc. and automatically rotates on rate limit errors (detects `429` or `rate_limit` in exception). Always keep this intact.

### TTS Streaming

TTS is generated via `edge-tts` and returned as base64 audio chunks over SSE alongside the chat stream. Never change this format — `script.js` depends on it for synchronized playback.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | System health check |
| POST | `/chat/jarvis/stream` | **MAIN ENDPOINT** — brain routes all requests, supports image |
| POST | `/chat/stream` | Basic streaming chat |
| POST | `/chat/realtime/stream` | Streaming + Tavily web search |
| GET | `/chat/history/{session_id}` | Session chat history |
| GET | `/tasks/{task_id}` | Background task status |
| POST | `/tts` | Text-to-speech MP3 stream |

**Main request body:** `{ message, session_id, imgbase64 (optional), tts (bool) }`

---

## Environment Variables (.env)

```env
# EXISTING
GROQ_API_KEY=
GROQ_API_KEY_2=
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_BRAIN_MODEL=llama-3.1-8b-instant
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
TAVILY_API_KEY=
TTS_VOICE=en-GB-RyanNeural
TTS_RATE=+22%
ASSISTANT_NAME=Jarvis
JARVIS_USER_TITLE=Sir
JARVIS_OWNER_NAME=YourName

# TO ADD (Feature 3)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=jarvis-screenshots
AWS_REGION=ap-south-1

# TO ADD (Feature 4)
OPENAI_API_KEY=           # GPT-4o classroom vision only

# ADD LAST (Feature 7 — auth)
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
JWT_SECRET_KEY=
```

---

## Critical Rules — Never Break These

1. **Never touch** `orb.js` — WebGL shader core is the visual identity of the app
2. **Never rebuild** working features — chat, voice, TTS, camera are done, only extend them
3. **Always use** `/chat/jarvis/stream` as the single main endpoint — never bypass it
4. **Never hardcode** API keys — always read from `.env` via `config.py`
5. **Keep** Groq key rotation in `key_rotation.py` — it prevents rate limits
6. **Frontend stays** Vanilla JS only — no React, Vue, Angular, or any JS framework
7. **TTS** streams as base64 audio chunks over SSE — never change this format
8. **All new packages** must be added to `requirements.txt` immediately
9. **Session IDs** are UUID hex strings — always use `chat_service.validate_session_id()`
10. **user_id placeholder** — use `user_id = 'test-user-001'` everywhere until Feature 7
11. **Tighten CORS** — change `allow_origins=["*"]` to actual domain only after Feature 7

---

## Run Locally

```bash
pip install -r requirements.txt
python run.py
# Open: http://localhost:8000
```

---

## Test Checklist After Every Feature

- [ ] `GET /health` — all services healthy
- [ ] `POST /chat/jarvis/stream` — basic message works
- [ ] TTS audio plays correctly in browser
- [ ] Camera/vision still returns image description
- [ ] No Python import errors on startup
- [ ] No errors in browser console (F12)
- [ ] All previously built features still work
