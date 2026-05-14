# Feature 7 — Google Auth + Supabase (ADD LAST)

## Status
Not built yet. Build only after Features 1–6 are fully working and tested.

## What It Does
Adds Google OAuth login via Supabase, protects all chat routes with JWT middleware, migrates chat history from JSON files to Supabase DB, and replaces all `user_id = 'test-user-001'` placeholders with the real JWT user ID.

## Pre-Condition
**Do NOT start this feature until Features 1–6 are complete and tested.**

## Auth Flow

1. User visits login page
2. Clicks "Sign in with Google"
3. Supabase handles Google OAuth redirect
4. JWT returned and stored in `localStorage`
5. All subsequent requests include `Authorization: Bearer <jwt>` header
6. FastAPI JWT middleware validates token on all `/chat/*` routes

## What to Replace

- Search entire codebase for `user_id = 'test-user-001'`
- Replace ALL instances with the real JWT user ID extracted from the token

## CORS
- Change `allow_origins=["*"]` to the actual production domain
- Only do this in this feature — do not tighten CORS earlier

## Database Migration

- Migrate chat history from `database/chats_data/*.json` → Supabase `chat_sessions` table
- Write a one-time migration script

## New Packages to Add to requirements.txt

```
supabase
python-jose[cryptography]
passlib[bcrypt]
authlib
httpx
```

## Required Environment Variables (add to .env)

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
JWT_SECRET_KEY=
```

## Files to Create / Modify

- `app/middleware/auth.py` — new file: JWT validation middleware
- `app/main.py` — register auth middleware on `/chat/*` routes, tighten CORS
- `app/services/auth_service.py` — new file: Supabase OAuth helpers
- `frontend/index.html` — add login page + Google Sign-In button
- `frontend/script.js` — store JWT in localStorage, attach to all fetch requests
- All service files that use `user_id = 'test-user-001'` — replace with real user ID

## Supabase Schema

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  google_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL,
  s3_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '8 hours'
);

CREATE TABLE quiz_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  youtube_url TEXT,
  questions JSONB,
  score INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
