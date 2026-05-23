import re
import logging
from pathlib import Path
from typing import Optional, List, Dict
from urllib.parse import quote

from config import PRACTICE_PDFS_DIR, PRACTICE_CLASSES

logger = logging.getLogger("J.A.R.V.I.S")

_CLASS_RE = re.compile(
    r'\b(UKG|kindergarten)\b|'
    r'\bclass\s*(\d{1,2})\b|'
    r'\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:class|grade|std|standard)\b',
    re.IGNORECASE,
)

_NUMBER_WORDS = {
    'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
    'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
    'eleven': '11', 'twelve': '12',
}

def _normalize_number_words(text: str) -> str:
    """Replace English number words with digits so "class two" → "class 2"."""
    for word, digit in _NUMBER_WORDS.items():
        text = re.sub(rf'\b{word}\b', digit, text, flags=re.IGNORECASE)
    return text

def extract_class_from_message(text: str) -> Optional[str]:
    normalized = _normalize_number_words(text or "")
    m = _CLASS_RE.search(normalized)
    if not m:
        return None
    if m.group(1):
        return "UKG"
    num = m.group(2) or m.group(3)
    name = f"class_{int(num)}"
    return name if name in PRACTICE_CLASSES else None

def list_pdfs_for_class(class_name: str) -> List[Dict]:
    folder = PRACTICE_PDFS_DIR / class_name
    if not folder.exists():
        return []
    files = []
    for p in sorted(folder.glob("*.pdf")):
        sz = p.stat().st_size
        lbl = f"{sz/1024:.0f} KB" if sz < 1_048_576 else f"{sz/1_048_576:.1f} MB"
        files.append({
            "filename": p.name,
            "class_name": class_name,
            "size_bytes": sz,
            "size_label": lbl,
            "download_url": f"/practice/download/{class_name}/{quote(p.name)}",
        })
    return files

def get_pdf_path(class_name: str, filename: str) -> Optional[Path]:
    base = PRACTICE_PDFS_DIR.resolve()
    target = (base / class_name / filename).resolve()
    if not str(target).startswith(str(base)):
        return None
    return target if target.exists() else None
