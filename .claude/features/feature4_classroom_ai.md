# Feature 4 — Classroom Attention AI

## Status
Not built yet.

## What It Does
Analyses a classroom webcam frame using OpenAI GPT-4o Vision and returns a live attention dashboard showing how many students are attentive vs distracted.

## ⚠️ COST WARNING
- Each frame sent to GPT-4o Vision costs ~₹0.16
- **Maximum 10 frames during development/testing — strictly enforce this**
- Never run continuous capture while testing
- The 30-second interval is intentional — do NOT change it to 5 seconds

## Backend

- **Endpoint:** `POST /classroom/analyse`
- **Input:** base64 encoded webcam frame
- **Model:** OpenAI GPT-4o Vision (`gpt-4o`)
- **Prompt to GPT-4o (use exactly):**
  ```
  Analyse this classroom. Return ONLY valid JSON: {overall_attention_percent, attentive_count, distracted_count, total_visible, students:[{position, attention 1-10, status}]}
  ```
- **Response:** parsed JSON passed directly to frontend

## Frontend

- "Classroom Mode" button to enter the mode
- Consent banner shown before webcam access is requested
- After consent: webcam activates, captures 1 frame every **30 seconds**
- Live dashboard shows:
  - Overall attention percentage
  - Attentive count / Distracted count / Total visible
  - Per-student breakdown (position, attention score, status)

## Required Environment Variables (add to .env)

```env
OPENAI_API_KEY=   # GPT-4o classroom vision only
```

## New Packages to Add to requirements.txt

```
openai
```

## Files to Create / Modify

- `app/services/classroom_service.py` — new file: GPT-4o Vision call + response parsing
- `app/main.py` — add `POST /classroom/analyse` endpoint
- `frontend/index.html` — add Classroom Mode button, consent banner, dashboard panel
- `frontend/script.js` — webcam capture, 30s interval, dashboard rendering
- `requirements.txt` — add new package

## Notes

- This is completely separate from `vision_service.py` (which uses Groq Llama 4 Scout for regular camera)
- Do NOT reuse `vision_service.py` here — GPT-4o is required for structured classroom JSON
- Classroom mode should be clearly separated in the UI from the regular chat/camera mode
