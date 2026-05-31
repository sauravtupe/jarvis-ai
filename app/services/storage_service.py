import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

from config import (
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_S3_BUCKET,
    AWS_REGION,
    HF_TOKEN,
    HF_DATA_REPO,
    VECTOR_STORE_DIR,
    CHATS_DATA_DIR,
    UPLOAD_DIR,
    BASE_DIR,
)

logger = logging.getLogger(__name__)

_QUIZ_DIR = BASE_DIR / "database" / "quizzes"


def _get_s3_client():
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        return None
    return boto3.client(
        "s3",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION,
    )


# ─── HuggingFace Dataset backend (free, no AWS) ──────────────────────────────
# Used automatically when AWS is not configured. Keys map 1:1 to file paths
# inside a private HuggingFace Dataset repo, so the existing S3 keys
# ("lectures/lectures.json", "chats/<id>.json", …) work unchanged.

_hf_repo_ready = False


def _hf_enabled() -> bool:
    return bool(HF_TOKEN and HF_DATA_REPO)


def _get_hf_api():
    if not _hf_enabled():
        return None
    try:
        from huggingface_hub import HfApi
    except Exception as e:
        logger.warning("[STORAGE] huggingface_hub not available: %s", e)
        return None
    return HfApi(token=HF_TOKEN)


def _ensure_hf_repo(api) -> bool:
    """Create the private dataset repo on first use (idempotent)."""
    global _hf_repo_ready
    if _hf_repo_ready:
        return True
    try:
        api.create_repo(repo_id=HF_DATA_REPO, repo_type="dataset", private=True, exist_ok=True)
        _hf_repo_ready = True
        return True
    except Exception as e:
        logger.error("[STORAGE] Could not create/access HF dataset %s: %s", HF_DATA_REPO, e)
        return False


def _hf_upload_bytes(data: bytes, key: str) -> Optional[str]:
    api = _get_hf_api()
    if not api or not _ensure_hf_repo(api):
        return None
    try:
        import io
        api.upload_file(
            path_or_fileobj=io.BytesIO(data),
            path_in_repo=key,
            repo_id=HF_DATA_REPO,
            repo_type="dataset",
            commit_message=f"Update {key}",
        )
        logger.info("[STORAGE] HF dataset upload OK: %s", key)
        return f"https://huggingface.co/datasets/{HF_DATA_REPO}/blob/main/{key}"
    except Exception as e:
        logger.error("[STORAGE] HF dataset upload failed for %s: %s", key, e)
        return None


def _hf_download(key: str) -> Optional[bytes]:
    api = _get_hf_api()
    if not api:
        return None
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=HF_DATA_REPO,
            filename=key,
            repo_type="dataset",
            token=HF_TOKEN,
        )
        return Path(path).read_bytes()
    except Exception as e:
        # EntryNotFound / RepositoryNotFound are expected on a fresh repo.
        name = type(e).__name__
        if "NotFound" in name or "EntryNotFound" in name:
            return None
        logger.warning("[STORAGE] HF dataset download failed for %s: %s", key, e)
        return None


def _hf_list(prefix: str) -> list:
    api = _get_hf_api()
    if not api:
        return []
    try:
        files = api.list_repo_files(repo_id=HF_DATA_REPO, repo_type="dataset")
        return [f for f in files if f.startswith(prefix)]
    except Exception as e:
        name = type(e).__name__
        if "NotFound" in name:
            return []
        logger.warning("[STORAGE] HF dataset list failed for prefix %s: %s", prefix, e)
        return []


def _hf_list_older_than(prefix: str, hours: int) -> list:
    """Return HF dataset file keys under prefix older than `hours` (by last commit date)."""
    api = _get_hf_api()
    if not api:
        return []
    cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600
    path_in_repo = prefix.rstrip("/") or None
    keys = []
    try:
        # expand=True populates each RepoFile.last_commit.date so we can age files.
        for item in api.list_repo_tree(
            repo_id=HF_DATA_REPO,
            repo_type="dataset",
            path_in_repo=path_in_repo,
            recursive=True,
            expand=True,
        ):
            # Both RepoFile and RepoFolder carry last_commit; only delete files.
            if type(item).__name__ != "RepoFile":
                continue
            last_commit = getattr(item, "last_commit", None)
            date = getattr(last_commit, "date", None)
            if date is not None and date.timestamp() < cutoff:
                keys.append(item.path)
    except Exception as e:
        name = type(e).__name__
        if "NotFound" in name:
            return []
        logger.warning("[STORAGE] HF dataset age-list failed for prefix %s: %s", prefix, e)
        return []
    return keys


def _hf_delete(key: str) -> bool:
    api = _get_hf_api()
    if not api:
        return False
    try:
        api.delete_file(path_in_repo=key, repo_id=HF_DATA_REPO, repo_type="dataset")
        logger.info("[STORAGE] HF dataset deleted: %s", key)
        return True
    except Exception as e:
        logger.error("[STORAGE] HF dataset delete failed for %s: %s", key, e)
        return False


def _aws_enabled() -> bool:
    return bool(AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)


# ─── Backend routing ─────────────────────────────────────────────────────────
# Two durable stores can be active at once. We route by key prefix so each kind
# of data lands where it belongs:
#
#   • camera/    → ephemeral image scratch (auto-deleted after 2h). Prefer AWS S3,
#                  a plain object store, so captures never bloat the HF Dataset's
#                  git commit history.
#   • everything → long-lived app data (lectures, practice, notes, chats, quizzes,
#     else         uploads, vector index). Prefer the FREE HuggingFace Dataset.
#
# If only one backend is configured it handles everything. If neither is set,
# storage is local-only and is wiped on every HF Space rebuild.

def _backend_for_key(key: str) -> Optional[str]:
    """Pick the durable backend ('s3' | 'hf' | None) that owns a key/prefix."""
    aws, hf = _aws_enabled(), _hf_enabled()
    if key.startswith("camera/"):
        # Ephemeral images: AWS first (no git bloat), then HF, then local.
        if aws:
            return "s3"
        if hf:
            return "hf"
        return None
    # Durable app data: free HF first, then AWS, then local.
    if hf:
        return "hf"
    if aws:
        return "s3"
    return None


def storage_backend() -> Optional[str]:
    """Active backend for long-lived app data ('s3' | 'hf' | None)."""
    return _backend_for_key("lectures/lectures.json")


def storage_status() -> dict:
    """Snapshot of where each data class is persisted (surfaced by /health)."""
    app_data = _backend_for_key("lectures/lectures.json")
    return {
        "durable": app_data is not None,
        "app_data": app_data,            # lectures / practice / notes / chats / quizzes
        "camera": _backend_for_key("camera/"),  # ephemeral captures (auto-deleted after 2h)
        "aws_s3": _aws_enabled(),
        "hf_dataset": _hf_enabled(),
    }


# ─── S3 primitives ───────────────────────────────────────────────────────────

def _s3_upload_bytes(data: bytes, key: str, content_type: str) -> Optional[str]:
    client = _get_s3_client()
    if not client:
        return None
    try:
        client.put_object(Bucket=AWS_S3_BUCKET, Key=key, Body=data, ContentType=content_type)
        url = f"https://{AWS_S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"
        logger.info("[STORAGE] S3 upload OK: %s", key)
        return url
    except (BotoCoreError, ClientError, NoCredentialsError) as e:
        logger.error("[STORAGE] S3 upload failed for %s: %s", key, e)
        return None


def _s3_download(key: str) -> Optional[bytes]:
    client = _get_s3_client()
    if not client:
        return None
    try:
        response = client.get_object(Bucket=AWS_S3_BUCKET, Key=key)
        return response["Body"].read()
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("NoSuchKey", "404"):
            return None
        logger.error("[STORAGE] S3 download failed for %s: %s", key, e)
        return None
    except BotoCoreError as e:
        logger.error("[STORAGE] S3 download connection error for %s: %s", key, e)
        return None


def _s3_delete(key: str) -> bool:
    client = _get_s3_client()
    if not client:
        return False
    try:
        client.delete_object(Bucket=AWS_S3_BUCKET, Key=key)
        logger.info("[STORAGE] S3 deleted: %s", key)
        return True
    except (BotoCoreError, ClientError) as e:
        logger.error("[STORAGE] S3 delete failed for %s: %s", key, e)
        return False


def _s3_list(prefix: str) -> list:
    client = _get_s3_client()
    if not client:
        return []
    keys = []
    try:
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=AWS_S3_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"])
    except (BotoCoreError, ClientError) as e:
        logger.error("[STORAGE] S3 list failed for prefix %s: %s", prefix, e)
    return keys


def _s3_list_older_than(prefix: str, hours: int) -> list:
    client = _get_s3_client()
    if not client:
        return []
    cutoff = datetime.now(timezone.utc).timestamp() - hours * 3600
    keys = []
    try:
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=AWS_S3_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                if obj["LastModified"].timestamp() < cutoff:
                    keys.append(obj["Key"])
    except (BotoCoreError, ClientError) as e:
        logger.error("[STORAGE] S3 list failed for prefix %s: %s", prefix, e)
    return keys


# ─── Public API (each call routes to the backend that owns the key) ──────────
# Names keep the historical "s3" wording so existing call sites are untouched;
# the actual target is chosen by _backend_for_key().

def upload_bytes_to_s3(data: bytes, key: str, content_type: str = "application/octet-stream") -> Optional[str]:
    """Persist bytes to the durable store chosen for `key`. Returns URL or None."""
    backend = _backend_for_key(key)
    if backend == "s3":
        return _s3_upload_bytes(data, key, content_type)
    if backend == "hf":
        return _hf_upload_bytes(data, key)
    logger.warning("[STORAGE] No durable backend for %s (set AWS_* or HF_TOKEN+HF_DATA_REPO) — not persisted", key)
    return None


def download_from_s3(key: str) -> Optional[bytes]:
    """Fetch bytes for `key` from its durable store. None if missing/unconfigured."""
    backend = _backend_for_key(key)
    if backend == "s3":
        return _s3_download(key)
    if backend == "hf":
        return _hf_download(key)
    return None


def delete_s3_object(key: str) -> bool:
    """Delete `key` from its durable store. True on success."""
    backend = _backend_for_key(key)
    if backend == "s3":
        return _s3_delete(key)
    if backend == "hf":
        return _hf_delete(key)
    return False


def list_s3_objects_older_than(prefix: str, hours: int) -> list:
    """Keys under `prefix` older than `hours`, from the backend that owns the prefix."""
    backend = _backend_for_key(prefix)
    if backend == "s3":
        return _s3_list_older_than(prefix, hours)
    if backend == "hf":
        return _hf_list_older_than(prefix, hours)
    return []


def list_s3_prefix(prefix: str) -> list:
    """All keys under `prefix`, from the backend that owns the prefix."""
    backend = _backend_for_key(prefix)
    if backend == "s3":
        return _s3_list(prefix)
    if backend == "hf":
        return _hf_list(prefix)
    return []


def startup_restore_from_s3() -> None:
    """Download missing local files from S3. Called at startup before any service initializes."""
    try:
        _startup_restore_from_s3_inner()
    except Exception as e:
        logger.warning("[STORAGE] S3 startup restore skipped due to error: %s", e)


def _startup_restore_from_s3_inner() -> None:
    backend = storage_backend()
    if backend is None:
        logger.info("[STORAGE] No durable backend configured (AWS_* or HF_TOKEN+HF_DATA_REPO) — skipping startup restore")
        return

    logger.info("[STORAGE] Checking %s for data to restore...", backend.upper())
    restored = 0

    # 1. FAISS vector index — only pulled when the vector store feature is enabled.
    # When disabled, downloading it would waste bandwidth on a file we won't load.
    try:
        from config import VECTOR_STORE_ENABLED as _VSE
    except Exception:
        _VSE = False
    if _VSE:
        for fname in ["index.faiss", "index.pkl"]:
            local = VECTOR_STORE_DIR / fname
            if not local.exists():
                data = download_from_s3(f"vector_store/{fname}")
                if data:
                    local.write_bytes(data)
                    logger.info("[STORAGE] Restored vector_store/%s from S3 (%d bytes)", fname, len(data))
                    restored += 1
    else:
        logger.info("[STORAGE] Vector store disabled — skipping FAISS restore from S3")

    # 2. Upload records
    local = UPLOAD_DIR / "records.json"
    if not local.exists():
        data = download_from_s3("uploads/records.json")
        if data:
            local.write_bytes(data)
            logger.info("[STORAGE] Restored uploads/records.json from S3")
            restored += 1

    # 3. Quiz records
    _QUIZ_DIR.mkdir(parents=True, exist_ok=True)
    local = _QUIZ_DIR / "records.json"
    if not local.exists():
        data = download_from_s3("quizzes/records.json")
        if data:
            local.write_bytes(data)
            logger.info("[STORAGE] Restored quizzes/records.json from S3")
            restored += 1

    # 3b. Lecture catalog (Feature 8)
    from config import LECTURES_JSON_PATH
    LECTURES_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not LECTURES_JSON_PATH.exists():
        data = download_from_s3("lectures/lectures.json")
        if data:
            LECTURES_JSON_PATH.write_bytes(data)
            logger.info("[STORAGE] Restored lectures/lectures.json from S3 (%d bytes)", len(data))
            restored += 1

    # 4. Chat sessions
    s3_keys = list_s3_prefix("chats/")
    for key in s3_keys:
        fname = key.split("/")[-1]
        if not fname.endswith(".json"):
            continue
        local = CHATS_DATA_DIR / fname
        if not local.exists():
            data = download_from_s3(key)
            if data:
                local.write_bytes(data)
                logger.info("[STORAGE] Restored chat session from S3: %s", fname)
                restored += 1

    if restored:
        logger.info("[STORAGE] Startup restore complete: %d file(s) restored from S3", restored)
    else:
        logger.info("[STORAGE] Startup restore: all local files already present")
