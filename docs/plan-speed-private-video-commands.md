# Implementation Plan — Speed, Private Video, Smarter Commands

**Status:** proposed · **Author:** owner + Claude · **Date:** 2026‑07‑28

## Locked decisions

| Area | Decision |
|---|---|
| Private video host | **Cloudflare Stream** — signed-token privacy, cheap, fast India edge, built‑in AI captions |
| Playback surface | A **branded `/watch/{class}/{chapter}` page on our own domain** (not cloudflarestream.com) |
| Deployment | **Always-on host near India** (Mumbai region: Render / Railway / Fly.io / VPS) — kills HF cold‑start |
| Transcripts | **Both** — Cloudflare captions first, **AssemblyAI fallback** on the signed URL |
| Streaming TTS | Prefer **Azure streaming synthesis** (already in use; has mr‑IN/hi‑IN voices) over adding a new vendor |

## Guiding principles

1. **Additive & reversible.** Keep YouTube working during migration via a `provider` field on each lecture; nothing breaks until we flip a lecture to Cloudflare.
2. **Measure, don't guess.** Use the existing `[TIMING]` / first‑chunk `elapsed_ms` instrumentation to record before/after for every speed change.
3. **No frameworks.** Vanilla JS only; `smoke_test.py` stays green (9/0); load‑order sim stays clean.
4. **Division-keyed.** All lecture/progress behaviour continues to key off the active Division (Phases 1–3).

---

## Workstream A — Private video hosting (Cloudflare Stream)

**Goal:** syllabus videos are private (inaccessible without a signed token), open in a new tab on *our* branded page, look premium, and still yield transcripts.

### A1. New `app/services/video_service.py`
- `create_direct_upload()` → returns a one‑time **tus/direct‑creator‑upload** URL so large files upload **browser → Cloudflare directly** (never through our server).
- `signed_token(uid, ttl)` → mints a short‑lived signed playback JWT (Cloudflare Stream signing key).
- `hls_url(uid, token)` / `iframe_url(uid, token)` → playback URLs.
- `get_captions(uid, lang)` → fetches Cloudflare auto‑generated VTT; returns plain text or `None` if not ready.
- `video_status(uid)` → ready / processing.

### A2. Lecture catalog schema (extend `lecture_service`)
- Add `provider` (`"youtube" | "cloudflare"`, default keeps existing rows as `youtube`), `video_uid` (Cloudflare), keep `youtube_url`/`video_id` for legacy.
- Generalize `_validate_url` → accept either a YouTube URL **or** a Cloudflare UID.
- `list_lectures*` / `find_lecture_by_video_id` return `provider` so callers branch correctly.

### A3. Admin upload UI (Lectures panel)
- New "Upload video" control: pick a file → direct‑creator‑upload to Cloudflare (progress bar) → store returned `uid` + `provider="cloudflare"` on the lecture. (Also allow pasting an existing UID.)
- Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_STREAM_API_TOKEN`, `CLOUDFLARE_STREAM_SIGNING_KEY`, `CLOUDFLARE_CUSTOMER_SUBDOMAIN`.

### A4. Branded watch page — `GET /watch/{class_name}/{chapter}`
- Serves a premium, dark, orb‑accent HTML page that embeds the **Cloudflare Stream player** with a freshly minted **signed token** (short TTL).
- Optional gate: require a valid session/division so the URL isn't shareable outside class.
- Raw stream is 403 without a token → private by construction.

### A5. Generalize the lecture‑open flow
- `chat_service._handle_youtube_video` → `_handle_lecture_video(provider, …)`.
  - `provider == "cloudflare"` → emit `_lecture_opened { url: "/watch/…", provider }` → frontend opens **our watch page** in a new tab.
  - `provider == "youtube"` → existing behaviour (unchanged).
- Frontend: generalize the `_youtube_detected` handler → `_lecture_opened` (open the given URL). Keep YouTube path intact.

### A6. Transcript pipeline (both sources)
- `quiz_service.get_transcript(lecture)`:
  - `cloudflare` → try `video_service.get_captions(uid)`; if empty/not‑ready → **AssemblyAI on the signed MP4/audio URL** (no yt‑dlp needed — AssemblyAI fetches the URL).
  - `youtube` → existing Supadata → AssemblyAI chain.
- Cache the transcript (existing background‑fetch + session metadata flow is reused unchanged) so MCQ/summary/worksheet keep working.

### A7. Migration (gradual, optional)
- Both providers coexist. Admin re‑uploads syllabus videos to Cloudflare over time; each lecture flips to `cloudflare` when done. No big‑bang cutover.

**Verify A:** upload a file → lecture opens `/watch/…` and plays; the raw Cloudflare URL returns 403 without a token; transcript generates (captions or AssemblyAI); MCQ/summary still work.

---

## Workstream B — Ultra‑fast response (<1s, target ~700–800 ms)

**Goal:** command → first spoken word in ~700–800 ms when warm.

### B1. Move off HF Spaces → always‑on host near India *(biggest single win)*
- Containerize (Space already runs a container) and deploy to a **Mumbai/ap‑south** region on Render/Railway/Fly/VPS. Always‑on ⇒ **no cold‑start** (the 30–60 s worst case disappears) and lower RTT from India.
- Env parity (all secrets), storage backend stays S3/HF, tighten CORS to the new origin, point the frontend `API` base at the new host.

### B2. Cached canned TTS *(quick, high‑impact for the teacher flow)*
- The fixed localized lines (start/next class, "watch and come back", wait/ready, recap & revision templates) are **constant strings** → pre‑synthesize once per (text, language, voice) and replay in ~0 ms. Skip the TTS round‑trip entirely for the exact commands used most.
- Small on‑disk/S3 `tts_cache` keyed by a hash of (text, voice, rate).

### B3. Streaming TTS for dynamic replies
- Switch the primary TTS tier to **Azure streaming synthesis** (already in use, supports mr‑IN/hi‑IN, low TTFB) so the first audio chunk starts before the whole sentence is synthesized.
- Keep the existing 3‑tier fallback. (ElevenLabs Flash considered but risky for Marathi coverage; Azure is the safe, no‑new‑vendor choice.)

### B4. Fast‑path latency polish
- Audit that deterministic commands (lecture/teacher/start/next/revision) **never** invoke brain+LLM (they mostly don't) → those become network+TTS‑only.
- Start synthesizing the first (canned) sentence **in parallel** with any lookup.
- Defer/async the per‑message session save so it isn't on the critical path.

### B5. Budget & measurement
- Target budget: network < 150 ms · first LLM token < 400 ms · first audio < 800 ms (warm).
- Add a `/health/latency` self‑probe; capture `[TIMING]` before/after each change.

**Verify B:** `[TIMING]` shows first audio < 800 ms warm; canned teacher lines are effectively instant; smoke green.

---

## Workstream C — Smarter lecture commands (hardening; largely built in Phase 2)

**Goal:** "open the video lecture" opens the current lesson instantly; "open the next lecture" advances — **no questions**.

### C1. Remove the "select your class first" nag
- If the device has exactly **one** division, auto‑bind it. Otherwise remember the **last** selected division server‑side per session so repeat commands never re‑ask.

### C2. Widen phrasing coverage
- Add variants: "video lecture", "play the lecture", "resume the lecture", plus Marathi/Hindi ("व्हिडिओ लेक्चर", "पुढचं लेक्चर", "चालू करा", "लेक्चर लावा"). Ensure "open the video lecture" → resume current, "next lecture" → advance.

### C3. Tests
- Unit tests for `match_start_class_command` across phrasings × EN/HI/MR, asserting `start` vs `next` and no false positives on ordinary prose.

**Verify C:** with a division active, none of the target phrasings ask a question; matcher tests pass.

---

## Recommended rollout order

1. **Phase C — command hardening** (small, immediate; removes the friction you hit today).
2. **Phase A — private video (Cloudflare)** (the core feature; independent of B/C).
3. **Phase B — speed** (B2 cached TTS + B4 polish first for instant wins; then B1 deployment move + B3 streaming TTS for the final latency).

A, B, C are largely independent and can be reordered; only B3 (streaming TTS) pairs naturally with the B1 deployment move.

## New environment variables

```env
# Cloudflare Stream (Workstream A) — all four are needed for private playback.
CLOUDFLARE_ACCOUNT_ID=            # Cloudflare dash → right sidebar "Account ID"
CLOUDFLARE_STREAM_API_TOKEN=      # My Profile → API Tokens → token with Stream:Edit
CLOUDFLARE_STREAM_KEY_ID=         # from POST /accounts/{id}/stream/keys  → "id"
CLOUDFLARE_STREAM_SIGNING_KEY=    # from the same call → "pem" (base64 PEM)
CLOUDFLARE_CUSTOMER_SUBDOMAIN=    # e.g. customer-xxxx.cloudflarestream.com
VIDEO_TOKEN_TTL=14400             # optional, seconds a playback token lives (default 4h)

# Transcript fallback for private lectures (optional but recommended)
ASSEMBLYAI_API_KEY=               # used when Cloudflare captions aren't ready yet

# Deployment (Workstream B1) — set on the new host
API_BASE_URL=                       # new always-on origin, for the frontend
# (Azure TTS keys already present; no new TTS vendor required)
```

**Generating the signing key** (one-time, needed for private playback):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/keys" \
     -H "Authorization: Bearer <STREAM_API_TOKEN>"
# → result.id  → CLOUDFLARE_STREAM_KEY_ID
# → result.pem → CLOUDFLARE_STREAM_SIGNING_KEY
```

## Risks & mitigations

- **Signed‑token TTL vs long lectures** → mint tokens with generous TTL and refresh on the watch page; playback keeps its own session.
- **Cloudflare captions lag (async)** → AssemblyAI fallback on the signed URL guarantees a transcript.
- **Marathi streaming‑voice coverage** → stay on Azure (known mr‑IN/hi‑IN voices) rather than a new vendor.
- **Deployment move** → env/secret parity checklist; keep the HF Space as a warm standby until the new host is verified in prod.
- **Cost** → Cloudflare Stream is usage‑based; estimate = (total syllabus minutes × $5/1k stored) + (views × minutes × $1/1k delivered). AssemblyAI is one‑time per video.

## Definition of done

- [ ] A private Cloudflare‑hosted lecture opens on our `/watch` page; raw URL is 403 without a token; MCQ/summary work from its transcript.
- [ ] `[TIMING]` shows first audio < 800 ms warm on the new host; canned teacher lines instant.
- [ ] All target "open/next lecture" phrasings (EN/HI/MR) open the right lesson with zero questions.
- [ ] `python smoke_test.py` → 9/0 "All good"; load‑order clean.
- [ ] YouTube lectures still work (mixed `provider`) throughout the migration.
