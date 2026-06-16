# PHASE 4 — Restore Procedure

A full rollback-safe backup was taken **before any Phase 4 refactoring**. This
document is the exact recipe to restore the project if Phase 4 introduces a
regression.

## Backup facts

| | |
|---|---|
| **Backup location** | `C:\Users\SAINATH\Desktop\backup_before_phase4_20260616_154733` |
| **Taken (local time)** | 2026-06-16 15:47:33 |
| **Files backed up** | 320 |
| **Folders backed up** | 87 |
| **Backup size** | 2.76 MB |
| **Git tag** | `before-phase4-full-backup` (commit `0a809f1`) |
| **Excluded (regenerable only)** | `.venv` (Python virtual env) and `__pycache__` / `*.pyc` |

The backup is a **complete standalone copy** of the project — all source, config,
`.env`, assets, scripts, and the full `.git` history. Only the regenerable Python
virtual environment was left out (see "Rebuild .venv" below).

> ⚠️ **Do not modify the backup folder.** It is the frozen pre-Phase-4 state.

---

## Option A — Fastest rollback (git, recommended)

Phase 4 is frontend-only and every step is its own commit on top of the tag.
To throw away ALL Phase 4 changes and return to the exact pre-Phase-4 commit:

```powershell
cd "C:\Users\SAINATH\Desktop\JARVIS_AI"
git reset --hard before-phase4-full-backup
```

Then redeploy the restored state:

```powershell
git push origin master --force
git push space master:main --force
```

To roll back just ONE bad step instead of all of Phase 4, reset to that step's tag
(e.g. `git reset --hard before-phase4-tts`) — those per-step tags are created as
Phase 4 progresses.

---

## Option B — Restore from the file backup (if git history is unusable)

Replace the working tree with the backup copy (mirrors the backup exactly,
excluding the live `.venv` so your installed packages stay put):

```powershell
robocopy "C:\Users\SAINATH\Desktop\backup_before_phase4_20260616_154733" `
         "C:\Users\SAINATH\Desktop\JARVIS_AI" `
         /MIR /XD ".venv" "__pycache__" /XF "*.pyc"
```

`/MIR` makes the project match the backup (it will delete files added after the
backup). If you prefer a non-destructive copy, drop `/MIR` and use `/E` instead.

---

## Rebuild .venv (only if the virtual environment is lost)

The `.venv` was intentionally excluded from the backup (regenerable). To recreate:

```powershell
cd "C:\Users\SAINATH\Desktop\JARVIS_AI"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

---

## Verify after restoring

```powershell
python smoke_test.py            # all checks should pass ("All good")
python run_local.py             # open http://localhost:8000, F12 console clean
```
