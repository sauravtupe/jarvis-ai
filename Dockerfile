FROM python:3.12-slim

# Cache bust — forces full rebuild: 2026-05-25
ARG CACHEBUST=20260525

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    git \
    ffmpeg \
    espeak-ng \
    espeak-ng-data \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only torch (pinned to match transformers==4.44.2)
RUN pip install --no-cache-dir torch==2.3.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .

# Install remaining dependencies (torch already installed above)
RUN pip install --no-cache-dir -r requirements.txt

# Download Piper voice models (Indian English male preferred, US Ryan as guaranteed fallback)
RUN python -c "\
import urllib.request, os; \
os.makedirs('/app/models', exist_ok=True); \
base='https://huggingface.co/rhasspy/piper-voices/resolve/main'; \
urllib.request.urlretrieve(base+'/en/en_IN/male/medium/en_IN-male-medium.onnx', '/app/models/en_IN-male-medium.onnx'); \
urllib.request.urlretrieve(base+'/en/en_IN/male/medium/en_IN-male-medium.onnx.json', '/app/models/en_IN-male-medium.onnx.json'); \
print('[OK] Piper en_IN-male-medium downloaded') \
" || echo "[INFO] en_IN voice unavailable, ryan will be used"
RUN python -c "\
import urllib.request, os; \
os.makedirs('/app/models', exist_ok=True); \
base='https://huggingface.co/rhasspy/piper-voices/resolve/main'; \
urllib.request.urlretrieve(base+'/en/en_US/ryan/high/en_US-ryan-high.onnx', '/app/models/en_US-ryan-high.onnx'); \
urllib.request.urlretrieve(base+'/en/en_US/ryan/high/en_US-ryan-high.onnx.json', '/app/models/en_US-ryan-high.onnx.json'); \
print('[OK] Piper en_US-ryan-high downloaded') \
" || echo "[WARN] Piper fallback model also failed"

COPY . .

# Create required directories
RUN mkdir -p database/chats_data database/learning_data database/vector_store database/camera_captures database/uploads database/quizzes

# Generate starter/thinking audio clips (en-IN-PrabhatNeural voice)
RUN python app/generate_thinking_audio.py || echo "[WARN] Starter audio generation failed — will retry at runtime"

EXPOSE 7860

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
