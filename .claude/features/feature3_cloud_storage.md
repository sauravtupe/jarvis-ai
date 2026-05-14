# Feature 3 — Cloud Storage + Auto-Delete

## Status
Not built yet.

## What It Does
Moves uploaded PDFs/images to Supabase Storage and camera screenshots to AWS S3. An APScheduler job automatically deletes S3 objects older than 8 hours.

## Storage Routing

| File Type | Destination |
|---|---|
| PDFs / Images (Feature 1 uploads) | Supabase Storage bucket `uploads` |
| Camera screenshots | AWS S3 bucket `jarvis-screenshots` |

## Auto-Delete Job

- APScheduler job added to `main.py`
- Runs every **1 hour**
- Deletes all S3 objects in `jarvis-screenshots` older than **8 hours**
- Save all records with `user_id = 'test-user-001'` placeholder

## Required Environment Variables (add to .env)

```env
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=jarvis-screenshots
AWS_REGION=ap-south-1
```

Supabase vars are added in Feature 7. For now just store S3 URL in local JSON.

## New Packages to Add to requirements.txt

```
boto3
apscheduler
```

## Files to Create / Modify

- `app/services/storage_service.py` — new file: S3 upload, Supabase upload, delete logic
- `app/main.py` — add APScheduler startup + shutdown lifecycle, wire up storage on upload
- `requirements.txt` — add new packages

## Notes

- `database/camera_captures/` currently stores screenshots locally — migrate those to S3 in this feature
- Do NOT add Supabase DB integration yet — that's Feature 7. For now, just upload files and log URLs locally
- APScheduler must be started with `startup_event` / `lifespan` in FastAPI — not as a background thread
