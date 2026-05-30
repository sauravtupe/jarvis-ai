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