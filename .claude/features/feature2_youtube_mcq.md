# Feature 2 — YouTube → MCQ Quiz

## Status
Not built yet.

## What It Does
Detects a YouTube URL in the user's message, fetches the video transcript, sends it to Groq, and generates 10 multiple-choice questions. Frontend shows one question at a time with 4 options, tracks score, and shows a final result screen.

## Backend

- **Trigger:** YouTube URL detected in message
- **Flow:** youtube-transcript-api fetches transcript → Groq generates 10 MCQs as JSON
- **Endpoint:** `POST /quiz/generate`
- **Response format:**
  ```json
  {
    "questions": [
      {
        "question": "...",
        "options": ["A", "B", "C", "D"],
        "correct": "A"
      }
    ]
  }
  ```
- Save quiz record with `user_id = 'test-user-001'` placeholder

## Frontend

- One question displayed at a time
- 4 clickable option buttons
- Score tracker (e.g. "3 / 10")
- Final result screen after all questions answered
- Triggered automatically when YouTube URL is detected in chat input

## New Packages to Add to requirements.txt

```
youtube-transcript-api
```

## Files to Create / Modify

- `app/services/quiz_service.py` — new file for transcript fetch + MCQ generation
- `app/main.py` — add `POST /quiz/generate` endpoint
- `frontend/index.html` — add quiz UI panel (hidden by default)
- `frontend/script.js` — YouTube URL detection, quiz flow, scoring logic
- `requirements.txt` — add new package

## Notes

- Use Groq `llama-3.3-70b-versatile` for MCQ generation (same model as chat)
- If transcript is unavailable (disabled captions), return a clear error message to user
- Quiz panel should overlay or replace the chat area temporarily, then return to chat on completion
