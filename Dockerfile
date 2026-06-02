FROM python:3.12-slim

# Cache bust — forces full rebuild: 2026-05-26-mcq-fix (MCQ English/options fix)
ARG CACHEBUST=20260526b

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only torch (pinned to match transformers==4.44.2)
RUN pip install --no-cache-dir torch==2.3.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .

# Install remaining dependencies (torch already installed above)
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create required directories
RUN mkdir -p database/chats_data database/learning_data database/vector_store database/camera_captures database/uploads database/quizzes

# Generate starter/thinking audio clips (en-IN-PrabhatNeural voice)
RUN python app/generate_thinking_audio.py || echo "[WARN] Starter audio generation failed — will retry at runtime"

EXPOSE 7860

# Self-healing supervisor: if uvicorn ever exits (OOM kill, crash, HF recycle),
# relaunch it within ~2s instead of leaving the Space stuck on a permanent 500.
CMD ["sh", "-c", "while true; do uvicorn app.main:app --host 0.0.0.0 --port 7860; echo '[supervisor] uvicorn exited - restarting in 2s'; sleep 2; done"]
