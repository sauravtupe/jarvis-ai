# Design: Higher-quality voice via in-browser cleanup + Groq Whisper (VAD-gated, Web-Speech fallback)

**Date:** 2026-06-01
**Status:** Approved — implementing.
**Feature area:** Voice input / speech recognition (extends the existing, working voice feature)

---

## 1. Problem & goals

The teacher (UKG–Grade 12) wants Jarvis to **hear better in real-world conditions**:
detect the wake word reliably, hear soft/distant speech, filter background noise,
and transcribe accurately — for **many concurrent users**, with **no self-hosting,
nothing installed on the user's computer, and minimal cost**.

### Decision (confirmed with user, after iterating)
Use **Groq Whisper for everything Jarvis listens to — both the "Jarvis" wake word
and the spoken command — always**, because it gives the best listening quality.
**When Groq hits its rate limit (or errors), automatically fall back to the
browser's Web Speech engine** so voice never breaks.

### Why this shape
- Web Speech can't be fed a cleaned mic stream, so it can't be improved for
  soft/distant/noisy audio. Cleaning the audio before recognition requires a
  hosted speech API (user rejected self-hosting and client-side model compute).
- Groq Whisper is cheap (turbo **$0.04/hr of audio**, ~$0.0001/command), the model
  is open-source (MIT), and the compute is on Groq's infra → **zero transcription
  load on the HF Space**, so it scales for many users.
- The real cap is the Groq **free-tier rate limit** under heavy concurrency —
  handled by key rotation + the Web Speech fallback.

### Success criteria
1. "Jarvis" + commands transcribe accurately, including soft/distant/noisy speech.
2. Whisper is called **only when the user is actually speaking** (local VAD gating),
   never on silence — keeps cost/rate-limit usage low.
3. Many concurrent users — no per-user server transcription load.
4. Voice never hard-breaks: rate-limit/error → automatic Web Speech fallback.
5. Bilingual (Hindi + English) preserved (Whisper auto-detects language).
6. All existing voice behaviors keep working (wake word, stop commands, TTS,
   camera, lectures).

### Non-goals
- Self-hosting; bundling a model in the browser.
- Beating the physical mic ceiling (a near-silent voice across a large room).
- Changing the chat/brain/TTS pipeline.

---

## 2. Architecture — VAD-gated Whisper with Web Speech fallback

```
Mic ─▶ getUserMedia(noiseSuppression + echoCancellation + autoGainControl, mono)
        │
        ▼
   Web Audio: MediaStreamSource ─▶ GainNode(boost) ─▶ ScriptProcessor
        │                                               │ (per-frame PCM + RMS)
        │                                               ▼
        │                                    Local VAD (adaptive noise floor)
        │                                    detects a speech segment (+pre-roll)
        │                                               ▼
        │                                    encode WAV ─▶ POST /stt ─▶ Groq Whisper turbo
        │                                                                    │
        │                                                              {text, language}
        │                                                                    ▼
        │                                                _onFinalVoiceText(text)
        │                                       (wake match / stop / sendMessage — shared)
        │
        └─ on 429 / error ─▶ switch to Web Speech engine (existing code) for a cooldown,
                              then retry Whisper.
```

**Two logical states reused from today's machine:** `PASSIVE` (require the wake
word) and `ACTIVE` (wake heard → next utterance is the command). The VAD engine
runs continuously; `_onFinalVoiceText` applies the wake gate based on state.

---

## 3. Components

### 3.1 Backend — `config.py`
- `GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")`.
- Reuse existing `GROQ_API_KEYS` (multi-key) — no new key required.

### 3.2 Backend — `app/services/stt_service.py` (new)
- `transcribe(audio_bytes, filename, language=None) -> {text, language}` using
  `groq.Groq(...).audio.transcriptions.create(model=GROQ_STT_MODEL, file=..., response_format="verbose_json")`.
- **Key rotation**: iterate `GROQ_API_KEYS`; on a 429/rate-limit error rotate to the
  next; if all exhausted raise `STTQuotaError`. No key configured / other failure →
  `STTUnavailableError`. Mirrors the established `_try_whisper` pattern in
  `quiz_service.py`.

### 3.3 Backend — `app/main.py`
- **`POST /stt`** — `UploadFile` + optional `language: Form(None)`; reject empty /
  > 20 MB; call `stt_service.transcribe`. Returns `{text, language}`.
  - `STTQuotaError` → **429** (frontend falls back to Web Speech).
  - `STTUnavailableError` → 503; other errors → 502.
  - Public (like the chat endpoints); `user_id = Depends(get_optional_user)`. Audio
    is **transient** — never written to disk.

### 3.4 Frontend — `frontend/script.js` (vanilla; no new deps)
A new, mostly self-contained Whisper voice engine plus a small shared dispatcher.
The existing Web Speech path is left **fully intact** as the fallback.
- **`_voiceMode`** = `'whisper' | 'webspeech'`. Starts `'whisper'` when
  `settings.highAccuracyVoice` is on and the browser supports it; flips to
  `'webspeech'` on rate-limit/error for a cooldown, then retries.
- **`_startWhisperEngine()` / `_stopWhisperEngine()`** — acquire one cleaned
  `getUserMedia` stream; Web Audio graph `source → gain(boost) → ScriptProcessor`
  (+ a muted gain → destination so `onaudioprocess` fires without echo).
- **Adaptive energy VAD** in `onaudioprocess` — tracks a running noise floor and
  triggers relative to it (robust across rooms); keeps a ~300 ms pre-roll so the
  start of "Jarvis" isn't clipped; ends a segment after ~700 ms of trailing
  silence (or ~10 s max). Skips capture while `_jarvisSpeaking`, `_videoWatchMode`,
  or `isStreaming` (no TTS/video feedback loop).
- **`_encodeWav()`** — 16-bit PCM mono WAV at the AudioContext sample rate.
- **`_sttTranscribe(blob)`** — `POST /stt` (FormData). 429 → `_enterWebSpeechFallback()`.
- **`_onFinalVoiceText(text)`** — shared dispatcher used by the Whisper engine (and
  conceptually mirroring the Web Speech final path): in `PASSIVE`, match the wake
  word (send command if present, else open the active window); in `ACTIVE`, handle
  stop-commands, strip a leading "Jarvis", then `sendMessage`.
- **State-machine integration** — `_enterPassiveListening`, `_enterActiveListening`,
  `_disableMic`, `maybeRestartListening`, and the mic-button handler branch on
  `_voiceMode`: in `whisper` mode they manage the VAD engine and set `_micState`
  **without** touching the Web Speech `recognition` object.
- **Settings toggle** `highAccuracyVoice` (default **on**) in the existing
  `jarvis_settings`; off ⇒ pure current Web Speech behavior.
- **Capability/fallback** — if no `getUserMedia`/AudioContext, or `/stt` keeps
  failing, run Web Speech. Safari works too (we send WAV, not webm).

### 3.5 `frontend/index.html` / `style.css`
- New settings toggle row `toggle-high-accuracy-voice`.
- Small "recording/transcribing" indicator state on the mic/speech widget.

### 3.6 Docs — `CLAUDE.md`
- Add `POST /stt` to the endpoints table; document `GROQ_STT_MODEL`.

---

## 4. Error handling
| Case | Behavior |
|---|---|
| `/stt` 429 (all keys rate-limited) | Toast; switch to Web Speech for a cooldown, then retry Whisper |
| `/stt` 503/502/network | Same fallback (silent unless repeated) |
| Empty transcript | Ignore; stay in current state |
| Mic permission denied | Existing handling |
| No getUserMedia/AudioContext | Use Web Speech |
| TTS playing / video / streaming | VAD capture paused (guards) |

## 5. Scalability & cost
- Wake + command both via Groq, but **VAD-gated** ⇒ calls only on real speech.
- Compute on Groq ⇒ HF Space only forwards small WAV clips (async) — scales.
- Cost ~$0.0001/command; real cap is free-tier rate limit ⇒ key rotation +
  Web Speech fallback; add `GROQ_API_KEY_2/3` for more headroom.

## 6. Privacy
- Speech segments leave the device → HF Space → Groq (Web Speech already sent audio
  to Google, so not net-new). Audio is transient, never stored.

## 7. Testing / verification
**Backend:** `python -m py_compile`; unit/`curl -F file=@sample.wav /stt` → `{text}`;
simulate 429 → rotation → 429 surfaced; missing key → 503.
**Frontend:** `node --check frontend/script.js`; **manual in-browser** (mic required):
say "Jarvis" + a command softly / ~3–4 m away / with noise / in Hindi → accurate;
block `/stt` → Web Speech fallback still works; verify TTS never recorded; toggle off
→ pure Web Speech. *VAD thresholds will likely need one tuning pass after first test.*
**Regression:** `/health`; existing wake word, stop commands, camera, lectures, TTS.

## 8. Files to touch
| File | Change |
|---|---|
| `config.py` | `GROQ_STT_MODEL` |
| `app/services/stt_service.py` (new) | `transcribe()` + key rotation + `STTQuotaError`/`STTUnavailableError` |
| `app/main.py` | `POST /stt` |
| `frontend/script.js` | VAD-gated Whisper engine, `_onFinalVoiceText`, `_voiceMode` branching, toggle, fallback |
| `frontend/index.html` | `highAccuracyVoice` toggle |
| `frontend/style.css` | mic recording/transcribing indicator |
| `CLAUDE.md` | document `/stt` + `GROQ_STT_MODEL` |

## 9. Rollout
- Behind `highAccuracyVoice` (default on); instant revert via the toggle.
- No new dependency (groq SDK + native browser APIs only).
- Honest limit: in-browser VAD thresholds need a real-device tuning pass; the
  Web Speech fallback guarantees voice always works meanwhile.

## 10. Future (out of scope)
Silero VAD (vad-web) for noisier rooms; RNNoise-WASM denoise; streaming/partial
transcription for lower latency; AudioWorklet instead of ScriptProcessor.
