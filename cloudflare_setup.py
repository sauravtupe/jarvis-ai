"""One-time Cloudflare Stream setup helper.

You provide the two values you can only get from the dashboard (Account ID + API
token); this fetches everything else and prints ready-to-paste .env lines:

  • verifies the API token actually has Stream access
  • creates the signing key pair  → CLOUDFLARE_STREAM_KEY_ID + ..._SIGNING_KEY
  • detects your customer subdomain → CLOUDFLARE_CUSTOMER_SUBDOMAIN

Usage
-----
    # after putting ACCOUNT_ID + API_TOKEN in .env:
    python cloudflare_setup.py

    # or pass them directly:
    python cloudflare_setup.py --account-id <ID> --api-token <TOKEN>

Nothing is written to .env automatically — it prints the lines for you to paste,
so a mistake here can never clobber your existing secrets.
"""

import argparse
import re
import sys

import requests

API = "https://api.cloudflare.com/client/v4"


def _fail(msg: str) -> None:
    print(f"\n  [X] {msg}")
    sys.exit(1)


def _call(method: str, url: str, token: str, **kw):
    try:
        r = requests.request(method, url, headers={"Authorization": f"Bearer {token}"},
                             timeout=25, **kw)
    except requests.RequestException as e:
        _fail(f"Could not reach Cloudflare: {e}")
    try:
        data = r.json()
    except ValueError:
        _fail(f"Cloudflare returned a non-JSON response (HTTP {r.status_code}).")
    return r.status_code, data


def main() -> int:
    ap = argparse.ArgumentParser(description="Cloudflare Stream setup helper")
    ap.add_argument("--account-id", default="")
    ap.add_argument("--api-token", default="")
    args = ap.parse_args()

    account_id, api_token = args.account_id.strip(), args.api_token.strip()
    if not account_id or not api_token:
        try:
            from config import CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_API_TOKEN
            account_id = account_id or CLOUDFLARE_ACCOUNT_ID
            api_token = api_token or CLOUDFLARE_STREAM_API_TOKEN
        except Exception:
            pass

    print("\nCloudflare Stream setup\n" + "=" * 46)
    if not account_id or not api_token:
        _fail("Missing credentials.\n"
              "      Put CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN in .env,\n"
              "      or pass --account-id / --api-token.")
    print(f"  Account ID : {account_id[:6]}…{account_id[-4:]}")

    # 1. Does the token work, and does it have Stream permission?
    print("\n[1/3] Checking API token…")
    status, data = _call("GET", f"{API}/accounts/{account_id}/stream?per_page=5", api_token)
    if status in (401, 403):
        _fail("Token rejected. It needs the **Account → Stream → Edit** permission,\n"
              "      and must belong to this account.")
    if not data.get("success"):
        errs = "; ".join(e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict))
        _fail(f"Cloudflare error: {errs or status}")
    videos = data.get("result") or []
    print(f"  [OK] Token works. Stream currently has {len(videos)} video(s).")

    # 2. Customer subdomain — read it off any existing video's playback URL.
    print("\n[2/3] Detecting customer subdomain…")
    subdomain = ""
    for v in videos:
        hls = ((v.get("playback") or {}).get("hls") or "")
        m = re.search(r"https://([^/]*cloudflarestream\.com)/", hls)
        if m:
            subdomain = m.group(1)
            break
    if subdomain:
        print(f"  [OK] {subdomain}")
    else:
        print("  [!] No videos yet, so the subdomain can't be detected.")
        print("      Upload your first lecture, then re-run this script — or copy it")
        print("      from Stream -> (any video) -> Embed, inside the iframe src.")

    # 3. Signing key — the only way to get this is the API (no dashboard UI).
    print("\n[3/3] Creating a signing key…")
    status, data = _call("POST", f"{API}/accounts/{account_id}/stream/keys", api_token, json={})
    if not data.get("success"):
        errs = "; ".join(e.get("message", "") for e in data.get("errors", []) if isinstance(e, dict))
        _fail(f"Could not create signing key: {errs or status}")
    result = data.get("result") or {}
    key_id, pem = result.get("id", ""), result.get("pem", "")
    if not key_id or not pem:
        _fail("Cloudflare did not return a key id + pem.")
    print(f"  [OK] Signing key created (id {key_id[:8]}…)")

    print("\n" + "=" * 46)
    print("Paste these into your .env:\n")
    print(f"CLOUDFLARE_ACCOUNT_ID={account_id}")
    print("CLOUDFLARE_STREAM_API_TOKEN=<the token you already have>")
    print(f"CLOUDFLARE_STREAM_KEY_ID={key_id}")
    print(f"CLOUDFLARE_STREAM_SIGNING_KEY={pem}")
    print(f"CLOUDFLARE_CUSTOMER_SUBDOMAIN={subdomain or '<upload one video, then re-run this script>'}")
    print("\nThen restart the server. Keep the signing key secret — it mints playback tokens.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
