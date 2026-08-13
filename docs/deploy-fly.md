# Deploying to Fly.io (Mumbai) — Workstream B1

Moves Jarvis off HuggingFace Spaces to an always-on machine in Mumbai (`bom`).

**Why:** HF Spaces sleep when idle, so the first request after a quiet period paid a
30–60 s cold start — the single worst latency the platform had. A Fly machine with
`auto_stop_machines = "off"` never sleeps, and `bom` is the closest region to the
students.

**Cost:** roughly **$5–10/month** for one always-on `shared-cpu-2x` / 2 GB machine.

---

## Before you start

You need the [`flyctl` CLI](https://fly.io/docs/flyctl/install/) and a Fly account
with a card on file (required even on the cheapest plan, because always-on machines
are not covered by the free allowance).

```powershell
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
fly auth signup    # or: fly auth login
```

---

## Step 1 — Pick an app name

`app = "jarvis-teacher"` in `fly.toml` must be **globally unique across all of Fly**.
If it is taken, edit that line first (e.g. `jarvis-teacher-sunrise`).

```powershell
fly apps create jarvis-teacher      # tells you immediately if the name is free
```

## Step 2 — (nothing to do)

Deliberately skipped. The obvious command here is `fly launch`, but **do not run it** in
this repo: `fly launch` regenerates `fly.toml` from its own template and has been known
to rewrite `auto_stop_machines` back to `"stop"` — silently undoing the always-on
setting that is the entire reason for this migration.

`fly apps create` in Step 1 plus the committed `fly.toml` is all that is needed;
`fly deploy` reads the region and machine settings straight from that file.

## Step 3 — Push your secrets

**Never** commit `.env` or bake it into the image — `.dockerignore` excludes it. Fly
injects secrets as environment variables at runtime instead.

This one command imports every key from your existing `.env`:

```powershell
# Git Bash / WSL
cat .env | fly secrets import

# PowerShell
Get-Content .env | fly secrets import
```

Your `.env` currently holds **28** variables. The ones that must be present for a
working deploy:

| Group | Keys |
|---|---|
| **Core AI** | `GROQ_API_KEY`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3`, `GROQ_MODEL`, `OPENAI_API_KEY` |
| **Voice** | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` (keep `centralindia`), `TTS_VOICE`, `TTS_RATE` |
| **Private video** | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_STREAM_API_TOKEN`, `CLOUDFLARE_STREAM_KEY_ID`, `CLOUDFLARE_STREAM_SIGNING_KEY`, `CLOUDFLARE_CUSTOMER_SUBDOMAIN` |
| **Storage** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_REGION` |
| **Admin / misc** | `ADMIN_TOKEN`, `TAVILY_API_KEY`, `SUPADATA_API_KEY`, `ASSISTANT_NAME` |

Verify (names only are shown — Fly never echoes values):

```powershell
fly secrets list
```

## Step 4 — Fix CORS for the new origin

`ALLOWED_ORIGINS` defaults to the HF Space + localhost. The browser will block every
request from the new domain until you add it:

```powershell
fly secrets set ALLOWED_ORIGINS="https://jarvis-teacher.fly.dev,http://localhost:8000,http://127.0.0.1:8000"
```

Use your real app name. Keep the localhost entries so local development still works.

## Step 5 — Deploy

```powershell
fly deploy
```

The first build takes **10–15 minutes** — it installs CPU torch and
sentence-transformers, which are large. Later deploys reuse cached layers.

## Step 6 — Verify

```powershell
fly status                       # machine should be "started" in bom
fly logs                         # watch startup
fly open /health                 # or: curl https://<app>.fly.dev/health
```

A healthy start prints these lines, in this order:

```
J.A.R.V.I.S is online and ready!
  - TTS cache: 47 canned lines ready (47 newly synthesized) in ~18s
  - TTS: Ready — Azure en-IN-PrabhatNeural (Indian male)
```

`/health` should report `"durable": true` and `"app_data": "s3"` — that confirms it
picked up your existing lectures, schools and progress from S3 rather than starting
empty.

Then check the things that actually matter to a lesson:

- [ ] Open `https://<app>.fly.dev/app/` — the orb renders
- [ ] Say **"start the class"** — speaks near-instantly (prebaked cache)
- [ ] Class 5 Chapter 3 opens `/watch/class_5/chapter_3`, and the video plays
- [ ] The raw Cloudflare URL still returns **401** without a signed token
- [ ] Admin panel loads with your `ADMIN_TOKEN`

```powershell
python smoke_test.py --prod       # point it at the new host
```

---

## Keeping it always-on

The single most important line in `fly.toml`:

```toml
auto_stop_machines = "off"
min_machines_running = 1
```

If you ever see cold starts return, check this first — `fly launch` has been known to
rewrite it to `"stop"` when regenerating the config.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Machine restarts in a loop | Usually OOM. `fly logs` shows `Out of memory`. Raise `memory` in `fly.toml` to `"4gb"`, then `fly deploy`. |
| `500` on every request | A missing secret. `fly logs` names it; re-run `fly secrets import`. |
| Frontend loads, API calls fail with CORS | Step 4 was skipped or the app name is wrong in `ALLOWED_ORIGINS`. |
| Health check fails during deploy | torch import exceeds the grace period. Raise `grace_period` in `fly.toml`. |
| Video plays locally but 401 in prod | Cloudflare signing key didn't transfer. It is multi-line — confirm with `fly secrets list`. |

## Rolling back

The HF Space is untouched by this — the Dockerfile still defaults to port 7860 — so it
remains a working standby. To revert, point your users back at the Space URL. To roll
back a bad Fly deploy:

```powershell
fly releases            # list
fly deploy --image <previous-image-ref>
```

## After it's live

Update the frontend `API` base if you ever host the UI separately (today it is served
from the same origin, so nothing to change), and re-run:

```powershell
python smoke_test.py --prod
```
