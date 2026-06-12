"""Local testing launcher — same as run.py but with Google login BYPASSED.

    python run_local.py

Use this whenever you want to test on http://localhost:8000 without being
redirected to the deployed site by the Supabase Google sign-in.

How it works: it sets whitespace SUPABASE_* environment variables BEFORE the
app loads config.py; load_dotenv() never overrides real env vars, and config
strips whitespace, so Supabase is cleanly disabled for THIS process only.
Your .env file is untouched and the deployed site is unaffected.

It also sets a known ADMIN_TOKEN so the admin panel (Manage Lectures /
Recent Errors) works locally — sign in with: local-admin
"""

import os
import runpy

os.environ["SUPABASE_URL"] = " "
os.environ["SUPABASE_ANON_KEY"] = " "
# Only for local testing; the real Space uses the ADMIN_TOKEN secret on HF.
os.environ.setdefault("ADMIN_TOKEN", "local-admin")

print("=" * 60)
print("LOCAL MODE: Google login bypassed (test-user). Admin token: local-admin")
print("=" * 60)

if __name__ == "__main__":
    runpy.run_path(os.path.join(os.path.dirname(__file__), "run.py"), run_name="__main__")
