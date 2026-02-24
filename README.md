# TwynBook by 4th-ir

Create talking-head personas (face + voice + prompt) and chat with them. Uses Ditto for video, Chatterbox for TTS, OpenAI for chat.

## Setup

1. Copy env and set keys:
   ```bash
   cp env.example .env
   # Edit .env: OPENAI_API_KEY, CHATTERBOX_BASE_URL, DITTO_API_URL
   ```

2. Backend (from repo root):
   ```bash
   cd twynbook/backend && pip install -r requirements.txt && uvicorn main:app --reload --port 5000
   ```

3. Frontend:
   ```bash
   cd twynbook/frontend && npm install && npm run dev
   ```

4. Open the frontend URL (e.g. http://localhost:5173). Ensure Ditto API and Chatterbox are running.

## Docker (frontend + backend in one container)

From repo root:

```bash
docker compose build && docker compose up -d
```

Open **http://localhost:5000**. See [DOCKER.md](DOCKER.md) for env vars and options.

## Data

- Personas and conversation history: `data/personas.json` (or `DATA_DIR/personas.json`).
- Idle videos: `data/idle_<persona_id>.mp4`.
