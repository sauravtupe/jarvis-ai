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