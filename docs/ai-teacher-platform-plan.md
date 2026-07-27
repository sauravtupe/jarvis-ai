# Jarvis AI Teacher — Complete Implementation Plan

> **Status:** Design / plan only. No code changed yet.
> **Scope (locked with the user):** Single subject = **AI education**. **Classroom-first** —
> one smart-board/device per classroom. **Multi-school** from day one. Memory & progress are
> tracked at the **Division** level (not per student). Individual-student tracking is an
> explicit *future* option, not built now.

---

## 1. Core architectural principle

**Identity spine: `School → Class → Division → Session`.**

The **Division** (e.g. *Greenfield School → Class 4 → Div A*) is the single unit of identity,
memory, and progress. A teacher/admin logs in **once** on the classroom device and selects
School → Class → Division; that opens a **classroom session** bound to a `division_id`.
Everything — chapter completion, doubts, revision history, MCQ sessions, learning memory — is
keyed to the division. **No per-student accounts, logins, or scores.**

This is an **additive layer on top of the existing engine**, not a rewrite. The content
machinery (lectures, MCQ, notes, practice, multilingual matching, Azure TTS) is reused as-is.

---

## 2. Teacher Persona Engine  *(Phase 0 — the highest-value, fastest win; no DB needed)*

This is the component that makes Jarvis *feel like a real teacher*. It is a **dynamically
assembled system prompt** injected through the existing `extra_system_parts` mechanism (the
same hook already used for the language directive and video context in `chat_service`).

### 2.1 Persona (fixed core)
`Jarvis Teacher` — an experienced, warm, energetic **male school teacher** who genuinely cares
about his students. **Not** a chatbot/assistant/AI system — a classroom teacher.

- Personality: warm, friendly, patient, encouraging, positive, interactive; speaks naturally to
  a *classroom* (plural "students").
- Encouragement phrases: "Very good!", "Excellent answer!", "Good thinking!", "That's a great
  question.", "Let's understand this together.", "Don't worry if it seems difficult — I'll
  explain it step by step."
- Teaching style: simple age-appropriate language; real-life examples; frequent interaction
  ("Can anyone guess?", "What do you think happens next?", "Raise your hand if you understood");
  after a topic: "Did everyone understand, or should I explain it another way?"
- **NEVER:** mention being an AI/model; mention prompts, APIs, databases, tokens, or systems;
  sound robotic or overly formal.

### 2.2 State-aware classroom lines (persona × state machine)
The orchestration layer (§6) selects the opening based on the division's state, and the persona
renders it naturally in the division's language:

| Classroom state | Persona behavior |
|---|---|
| **GREET** (session start, no prior progress) | "Hello students! Welcome back. I hope everyone is doing great today. Before we begin, does anyone have any doubts from our previous lesson?" |
| **REVIEW** (session start, prior chapter completed) | "Last time we completed Chapter *{chapter}*. Let's quickly remember what we learned. Can anyone tell me one thing they remember?" → then ask for doubts |
| **DOUBT** | Answer patiently, simple examples, encourage, never embarrass |
| **TEACH** | Open the chapter lecture; interactive questions during/after |
| **POST-LECTURE** | "Great job, students! We've completed today's lesson. Would you like a quick quiz now, or shall I prepare a worksheet?" → MCQ / Practice / Worksheet / Notes / Homework |
| **END** | "Excellent work today, students. I am proud of your participation. Any remaining doubts? Quick revision? Ready for the next chapter?" → if none: "Wonderful! We'll continue next class. Keep learning, keep asking questions, have a fantastic day." |

### 2.3 Language rendering (no barrier)
The persona text above is a **tone template**, not a literal script. The division's
`preferred_language` directive (reusing the multilingual layer already built) instructs the LLM
to deliver everything in **natural Marathi / Hindi / simple English** — encouragement phrases
included (e.g. "Excellent!" → "शाब्बास!" / "बहुत बढ़िया!"). A small set of **anchor phrases per
language** is provided in-prompt so tone stays consistent and warm, not literally translated.

### 2.4 Guardrails (honest reliability note)
LLMs occasionally slip ("As an AI…"). Mitigation: (a) explicit NEVER rules in the prompt, and
(b) a light **output filter** that catches/rewrites "as an AI / language model / I'm a chatbot"
slips before they reach TTS. This keeps the human-teacher illusion intact.

### 2.5 Where it lives in code
- A new `teacher_persona.py` (or a section in `config.py`) holds the persona core + per-language
  anchor phrases.
- The teaching routes assemble: **persona core + language directive + division context** (last
  chapter, open doubts, current chapter — empty in Phase 0, populated from Phase 2) and pass it
  via `extra_system_parts` — the exact injection point already proven for language/video context.
- **Phase 0 ships with `division_context` stubbed/empty**, so the persona + language are live and
  demoable *before* the database exists.

---

## 3. Data model (Supabase Postgres — multi-school needs a real relational DB)

```
schools         (id, name, board, city, created_at)
classes         (id, school_id, grade)                         -- Class 4, Class 8 …
divisions       (id, class_id, name, preferred_language)       -- A / B / C
staff           (id, school_id, role[admin|teacher], name, login)
ai_chapters     (id, grade, chapter_no, title, lecture_url,    -- the AI curriculum spine
                 transcript_ref, notes_url, order_index)
division_progress     (division_id, current_chapter_id, last_active_at)
chapter_completions   (division_id, chapter_id, completed_at, revision_count)
mcq_sessions          (division_id, chapter_id, conducted_at, participation_flag)  -- NO individual scores
division_doubts       (division_id, chapter_id, text, asked_at, resolved_at)
division_memory       (division_id → FAISS namespace)          -- semantic recall of discussion/doubts
```

Curriculum is AI-only: `ai_chapters` is one ordered sequence per grade — import the existing AI
lecture library into it (extends today's `lectures.json`). Lecture videos and generated
notes/worksheets stay in S3/HF Dataset; only relational/progress data goes to Postgres.

---

## 4. Identity & auth (reuse what exists)

- **Teacher/admin login** reuses the JWT scaffolding in `app/middleware/auth.py` + Supabase
  (`auth.js`).
- **Session flow:** staff logs in → picks School/Class/Division → backend issues a **classroom
  session token carrying `division_id`** → every request is division-scoped.
- The existing **admin panel** is extended to manage schools/classes/divisions/staff and import
  the AI curriculum.
- No student OAuth (explicit future option).

---

## 5. The "Teacher Brain" — orchestration layer

A new service wrapping the existing `brain_service`. Per message it loads the division's
`preferred_language` + progress + open doubts, injects the Teacher Persona Engine (§2), and runs
a **classroom state machine**:

```
GREET / REVIEW → DOUBT handling → TEACH (open next chapter) → POST-LECTURE (offer assessments)
              → MARK COMPLETE → END → (next session continues)
```

New intents (reuse the multilingual matcher + lecture-open flow):
- **"start my class" / "क्लास सुरू कर"** → resolve the division's next incomplete chapter, open it.
- **doubt handling** → answer + log to `division_doubts`.
- **"revise chapter N"** → reopen a completed chapter (revision intelligence).

Each step calls services that already exist (`lecture_service`, `quiz_service`, notes, practice).

---

## 6. Division learning memory (the "remembers us" feeling)

- **Structured (source of truth):** `division_progress` + `chapter_completions` +
  `division_doubts` → powers *"Yesterday Class 4A completed Chapter 1 — any doubts before
  Chapter 2?"*
- **Semantic:** a per-division **FAISS namespace** (extends the existing `vector_store`) for
  free-form recall of what was discussed/asked.

---

## 7. Language layer (no barrier) — elevate to a Division setting

`preferred_language` becomes a **Division attribute** (set on first session, persisted) instead
of per-chat metadata. Greetings, teaching, MCQs, and notes all flow in that language using the
multilingual matchers + Azure Indian voices + manual-switch already built.
**Honest caveat:** Marathi LLM output quality < English/Hindi — plan a review/tuning pass.

---

## 8. Assessment as a classroom activity (no individual scores — by design)

Reuse `quiz_service` / notes / practice. Conduct MCQ on the board; store only `mcq_sessions`
**participation/completion** at division level. Add prompt-variant generators: **tiered MCQ**
(basic/medium/advanced), **worksheets** (fill-blank / match / short / long), **homework**,
**important questions** — all extensions of existing generators. The post-lecture choice card
(already built, auto-offered on tab-return) becomes the POST-LECTURE state's UI.

---

## 9. Dashboards (scale phase)

Division-level reporting: chapters completed, revision frequency, MCQ sessions conducted, doubts
logged, active days. Teacher/admin dashboard reads these. No per-student analytics (by design).

---

## 10. Reuse vs new (honest)

| Reused as-is | Newly built |
|---|---|
| Lecture open flow, MCQ, notes, practice | schools/classes/divisions/progress data model (Postgres) |
| Post-lecture choice card (just built) | Teacher Persona Engine + output guardrail |
| Multilingual matchers, Azure TTS, manual switch | Teacher-Brain orchestration + classroom state machine |
| JWT/Supabase auth scaffolding, admin panel | Division memory (structured + FAISS namespace) |
| FAISS vector store, S3/HF storage | "start class" / continue / revise intents; staff login + School/Class/Division selection; dashboards |

---

## 11. Phased roadmap

| Phase | Deliverable | New |
|---|---|---|
| **0 — Teacher Persona** *(days, no DB)* | Persona Engine + division preferred-language; warm classroom greetings/encouragement live in Marathi/Hindi/English; output guardrail | `teacher_persona.py`, persona injection via `extra_system_parts` (division context stubbed) |
| **1 — Foundation** | Postgres data model + staff login + School/Class/Division selection + AI curriculum import | schools/classes/divisions/curriculum tables, selection UI |
| **2 — The teacher loop** | "Start my class" → next chapter + mark-complete + Day-2 REVIEW continuity + revision intelligence; persona now reads real division context | progress store, classroom state machine |
| **3 — Assessment + memory** | Post-lecture auto-offer wired to progress; tiered MCQ / worksheet / notes / homework; division doubts + FAISS memory + MCQ-session tracking | generator variants, division memory |
| **4 — Scale** | Teacher/admin dashboard; revision scheduling (apscheduler); class-level adaptive pacing & gamification (class streaks) | dashboard app, scheduler logic |

---

## 12. Honest risks & constraints

- **Smart-board voice in a noisy classroom** is the biggest practical risk — far-field mic + many
  students hits the hard Web Speech limit (the stream can't be denoised). **Recommendation: make
  the smart-board UI touch-first / teacher-facilitated**, with voice as an assist, not the sole
  input.
- **Assessment accuracy** — LLM hallucination; keep the existing teacher-review step before
  content reaches the class.
- **Content is AI-only and limited to what's loaded** — Jarvis teaches only chapters in the
  curriculum table.
- **Persona slips** ("As an AI…") — mitigated by prompt rules + output filter, not 100% eliminable.
- **Marathi fluency** — usable but below English/Hindi.
- **No individual analytics** — intentional; revisit only if a student layer is added later.

---

## 13. Storage decision

Postgres (Supabase) for relational/progress data; S3/HF Dataset (existing) for lecture / notes /
worksheet artifacts; FAISS per-division for semantic memory.
