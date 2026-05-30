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


def upload_bytes_to_s3(data: bytes, key: str, content_type: str = "application/octet-stream") -> Optional[str]:
    """Upload bytes to S3. Returns public URL or None on failure/missing credentials."""
    client = _get_s3_client()
    if not client:
        logger.warning("[STORAGE] AWS credentials not configured — skipping S3 upload for %s", key)
        return None
    try:
        client.put_object(
            Bucket=AWS_S3_BUCKET,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        url = f"https://{AWS_S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"
        logger.info("[STORAGE] S3 upload OK: %s", key)
        return url
    except (BotoCoreError, ClientError, NoCredentialsError) as e:
        logger.error("[STORAGE] S3 upload failed for %s: %s", key, e)
        return None


def download_from_s3(key: str) -> Optional[bytes]:
    """Download object bytes from S3. Returns None if not found or S3 not configured."""
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


def delete_s3_object(key: str) -> bool:
    """Delete a single S3 object. Returns True on success."""
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


def list_s3_objects_older_than(prefix: str, hours: int) -> list:
    """Return S3 object keys under prefix that are older than `hours`."""
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


def list_s3_prefix(prefix: str) -> list:
    """Return all S3 object keys under a given prefix."""
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


def startup_restore_from_s3() -> None:
    """Download missing local files from S3. Called at startup before any service initializes."""
    try:
        _startup_restore_from_s3_inner()
    except Exception as e:
        logger.warning("[STORAGE] S3 startup restore skipped due to error: %s", e)


def _startup_restore_from_s3_inner() -> None:
    client = _get_s3_client()
    if not client:
        logger.info("[STORAGE] AWS not configured — skipping startup restore from S3")
        return

    logger.info("[STORAGE] Checking S3 for data to restore...")
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
