from pydantic import BaseModel, Field
from typing import List, Optional

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=32_000)
    session_id: Optional[str] = None
    tts: bool = False
    imgbase64: Optional[str] = None
    # AI Teacher Phase 1 — the active classroom (School->Class->Division). When set,
    # the teacher persona speaks the division's preferred language automatically.
    division_id: Optional[str] = Field(default=None, max_length=64)

class ChatResponse(BaseModel):
    response: str
    session_id: str

class ChatHistory(BaseModel):
    session_id: str
    messages: List[ChatMessage]

class JarvisActions(BaseModel):
    wopens: List[str] = []
    plays: List[str] = []
    images: List[str] = []
    contents: List[str] = []
    googlesearches: List[str] = []
    youtubesearches: List[str] = []
    cam: Optional[dict] = None

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)

class UploadResponse(BaseModel):
    upload_id: str
    filename: str
    content_type: str   # "pdf" or "image"
    extracted_text: str

class MCQQuestion(BaseModel):
    question: str
    options: List[str]   # exactly 4
    correct: int         # 0–3 index

class QuizGenerateRequest(BaseModel):
    session_id: str
    video_id: str

class QuizGenerateResponse(BaseModel):
    quiz_id: str
    video_id: str
    questions: List[MCQQuestion]

class SummaryRequest(BaseModel):
    session_id: str
    video_id: str

class SummaryResponse(BaseModel):
    summary: str
    video_id: str

class ClassroomAnalyseRequest(BaseModel):
    frame_base64: str = Field(..., min_length=1)

class PracticeFile(BaseModel):
    filename: str
    class_name: str
    size_bytes: int
    size_label: str
    download_url: str

class PracticeListResponse(BaseModel):
    class_name: str
    files: List[PracticeFile]
    count: int


# Feature 8 — Lecture Catalog + Admin Panel
class AdminLoginRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=512)


class LectureCreate(BaseModel):
    class_name: str = Field(..., pattern=r'^(class_(1[0-2]|[1-9])|UKG)$')
    chapter: int = Field(..., ge=1, le=80)
    title: str = Field(..., min_length=1, max_length=120)
    youtube_url: str = Field(..., min_length=1)


class LectureUpdate(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    youtube_url: str = Field(..., min_length=1)


class LectureRecord(BaseModel):
    class_name: str
    chapter: int
    title: str
    youtube_url: str
    video_id: str
    notes_url: str = ""
    notes_type: str = ""
    created_at: str
    updated_at: str


class LectureListResponse(BaseModel):
    lectures: List[LectureRecord]
    count: int


# Feature 9 — Practical Exercises
class PracticalCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    url: str = Field(..., min_length=1)
    platform: str = Field(..., min_length=1)
    type: str = Field(..., min_length=1)
    difficulty: str = Field(..., min_length=1)
    estimated_minutes: int = Field(..., ge=1, le=600)
    description: str = Field(..., min_length=1, max_length=500)
    tags: Optional[List[str]] = None


class PracticalRecord(BaseModel):
    id: str
    title: str
    url: str
    platform: str
    type: str
    difficulty: str
    estimated_minutes: int
    description: str
    tags: List[str] = []
    created_at: str
    updated_at: str


class PracticalBundle(BaseModel):
    class_name: str
    chapter: int
    lecture: dict
    curated: List[PracticalRecord]
    class_pdfs: List[PracticeFile]
    # Teacher-saved, grade-aware AI practice activities (Feature 9 redesign).
    practice_tasks: List["AIPracticalTask"] = []


class AIPracticalRequest(BaseModel):
    session_id: str
    video_id: str
    use_cache: bool = True


class ResourceLink(BaseModel):
    label: str
    url: str


class AIPracticalTask(BaseModel):
    title: str
    description: str
    # activity_type generalizes beyond coding: matching, coloring, observation,
    # quiz, discussion, project, game, worksheet, coding, etc.
    activity_type: str = "project"
    steps: List[str] = []
    materials: List[str] = []
    resources: List[ResourceLink] = []
    # Coding-only fields — empty for younger / non-coding activities.
    platform_suggestion: str = ""
    starter_code: str = ""
    estimated_minutes: int = 30
    difficulty: str = "beginner"
    learning_outcomes: List[str] = []


class AIPracticalResponse(BaseModel):
    video_id: str
    tasks: List[AIPracticalTask]
    cached: bool


# Feature 9 redesign — teacher-driven, grade-aware practice
class PracticeGenerateResult(BaseModel):
    """Result of an admin 'Generate Practice' call (preview — not yet saved)."""
    class_name: str
    chapter: int
    grade_band: str
    coding_allowed: bool
    tasks: List[AIPracticalTask]


class PracticeSaveRequest(BaseModel):
    """Teacher saves the reviewed practice tasks onto a lecture."""
    tasks: List[AIPracticalTask]


# Feature: Notes / PPT integration — one URL per lecture (PPT/PDF/Slides/Doc)
class NotesSaveRequest(BaseModel):
    """Teacher saves a Notes / PPT / PDF URL onto a lecture."""
    notes_url: str = Field(..., min_length=1, max_length=2000)


class NotesRecord(BaseModel):
    class_name: str
    chapter: int
    notes_url: str
    notes_type: str = "link"   # slides | pdf | ppt | doc | link
    notes_added_at: str = ""
    title: str = ""


# AI Teacher Phase 1 — School -> Class -> Division identity
class SchoolCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    board: str = Field(default="", max_length=120)
    city: str = Field(default="", max_length=120)


class ClassCreate(BaseModel):
    # Accepts "UKG" or "1".."12" (the service also tolerates "class_5" / "5th").
    grade: str = Field(..., min_length=1, max_length=10)


class DivisionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=20)
    preferred_language: str = Field(default="en", max_length=2)