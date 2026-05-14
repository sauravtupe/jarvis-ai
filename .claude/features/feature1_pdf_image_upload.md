# Feature 1 — PDF & Image Upload (Sidebar)

## Status
Not built yet.

## What It Does
Allows users to upload PDF or image files from the sidebar. The content is extracted and attached to the next chat message sent to Jarvis.

## Backend

- **Endpoint:** `POST /upload`
- **PDF flow:** pdfplumber extracts text → sent to Groq LLM
- **Image flow:** reuse existing `vision_service.py` (base64 → Llama 4 Scout)
- Save upload record with `user_id = 'test-user-001'` placeholder

## Frontend

- Upload button in the **left sidebar**
- Show file preview after selection
- Attach extracted content to the next message automatically

## New Packages to Add to requirements.txt

```
pdfplumber
python-multipart
Pillow
```

## Files to Create / Modify

- `app/services/upload_service.py` — new file for PDF/image extraction logic
- `app/main.py` — add `POST /upload` endpoint
- `frontend/index.html` — add upload button + preview area in sidebar
- `frontend/script.js` — handle file selection, preview, attach to message
- `requirements.txt` — add new packages

## Notes

- Do NOT create a new vision pipeline — reuse `vision_service.py` for images
- PDF text extraction only (no OCR needed for now)
- File is not stored in cloud yet — that's Feature 3
