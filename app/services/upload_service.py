import base64
import io
import json
import logging
import threading
import uuid
from datetime import datetime
from pathlib import Path

from config import UPLOAD_DIR, MAX_UPLOAD_SIZE_MB

logger = logging.getLogger(__name__)
_records_lock = threading.Lock()

SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


class UploadService:

    def __init__(self, vision_service):
        self._vision_service = vision_service
        self._upload_dir = Path(str(UPLOAD_DIR))
        self._upload_dir.mkdir(parents=True, exist_ok=True)
        self._records_file = self._upload_dir / "records.json"
        logger.info("[UPLOAD] Service initialized (dir: %s)", self._upload_dir)

    def extract_text_from_pdf(self, file_bytes: bytes) -> str:
        import pdfplumber
        parts = []
        page_count = 0
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            page_count = len(pdf.pages)
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    parts.append(text.strip())
        result = "\n\n".join(parts).strip()
        if not result:
            return "[No text could be extracted — this PDF may be image-based or scanned.]"
        logger.info("[UPLOAD] PDF extracted: %d chars across %d pages", len(result), page_count)
        return result

    def extract_text_from_image(self, file_bytes: bytes) -> str:
        b64 = base64.b64encode(file_bytes).decode("utf-8")
        result = self._vision_service.describe_image(
            b64,
            "Describe this image in detail and extract all visible text, labels, captions, or written content."
        )
        logger.info("[UPLOAD] Image described: %d chars", len(result))
        return result

    def save_upload_record(self, record: dict) -> None:
        records = []
        with _records_lock:
            if self._records_file.exists():
                try:
                    with open(self._records_file, "r", encoding="utf-8") as f:
                        records = json.load(f)
                except Exception:
                    records = []
            records.append(record)
            with open(self._records_file, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False, indent=2)
        try:
            from app.services.storage_service import upload_bytes_to_s3
            data = json.dumps(records, ensure_ascii=False, indent=2).encode("utf-8")
            upload_bytes_to_s3(data, "uploads/records.json", content_type="application/json")
        except Exception as e:
            logger.warning("[UPLOAD] S3 sync of upload records failed: %s", e)

    @staticmethod
    def detect_content_type(filename: str) -> str:
        suffix = Path(filename).suffix.lower()
        if suffix == ".pdf":
            return "pdf"
        if suffix in SUPPORTED_IMAGE_EXTENSIONS:
            return "image"
        return "unknown"

    @staticmethod
    def check_size(file_bytes: bytes) -> bool:
        return len(file_bytes) <= MAX_UPLOAD_SIZE_MB * 1024 * 1024
