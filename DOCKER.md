# Running TwynBook in Docker

One container serves both the **frontend** (Vite/React) and **backend** (FastAPI). The image uses **backend/requirements.txt** (same deps as your local venv).

## Build and run

```bash
cd twynbook
docker compose build
docker compose up -d
```

- App: **http://localhost:8087** (frontend and API at `/api`)

## Environment variables

Set in `.env` or pass to `docker compose`:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for chat |
| `CHATTERBOX_BASE_URL` | TTS service (default: `http://localhost:8000`) |
| `DITTO_API_URL` | Talking-head API (default: `http://host.docker.internal:8080`) |
| `DATA_DIR` | Persisted personas/videos (default: `/app/data`, use volume) |

For **Linux**, if `host.docker.internal` is not available, set `DITTO_API_URL` and `CHATTERBOX_BASE_URL` to your host IP (e.g. `http://192.168.1.x:8080`) or add to `docker-compose.yml`:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

## Run without Compose

```bash
docker build -t twynbook .
docker run -p 8087:8087 \
  -e OPENAI_API_KEY=sk-... \
  -e DITTO_API_URL=http://host.docker.internal:8080 \
  -e CHATTERBOX_BASE_URL=http://host.docker.internal:8000 \
  -v twynbook-data:/app/data \
  twynbook
```

## Venv / requirements

- **Local dev**: `python -m venv venv && source venv/bin/activate` (or use existing venv), then `pip install -r backend/requirements.txt`.
- **Docker**: the image runs `pip install -r backend/requirements.txt` during build; no venv inside the container.
