# TwynBook: frontend (Vite/React) + backend (FastAPI) in one container
# Uses backend/requirements.txt (same as venv pip install -r requirements.txt)

# ---- Stage 1: build frontend ----
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ .
RUN npm run build

# ---- Stage 2: runtime (backend + static) ----
FROM python:3.13-slim
WORKDIR /app

# ffmpeg for pydub (browser-recorded webm → wav); libsndfile for soundfile (WAV → float32 for Ditto streaming)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*

# Backend Python deps (from backend/requirements.txt, same as venv)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend code
COPY backend/ ./backend/

# Built frontend (from stage 1)
COPY --from=frontend-build /app/frontend/dist ./static

# Data dir for personas.json and videos (mount at runtime or use default)
ENV DATA_DIR=/app/data
ENV STATIC_DIR=/app/static
RUN mkdir -p /app/data

EXPOSE 8087

# Run backend; it serves API on /api and frontend from STATIC_DIR (single port for app)
WORKDIR /app/backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8087"]
