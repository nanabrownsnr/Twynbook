# TwynBook WebRTC Media Server

Phase 2: Receives fMP4 segments from the TwynBook backend and sends video to the browser via WebRTC.

## Endpoints

- **WebSocket `/signaling`** – Browser: create session (get offer), send answer and ICE.
- **WebSocket `/push?session_id=xxx`** – TwynBook backend: send binary fMP4 segments; close to signal end.
- **GET `/health`** – Health check.

## Run

```bash
cd media_server
pip install -r requirements.txt
python app.py
# or: PORT=8765 uvicorn app:app --host 0.0.0.0 --port 8765
```

Default port: **8765**.

## Backend (TwynBook)

Set `MEDIA_SERVER_WS_URL=ws://localhost:8765` (or `ws://media-server:8765` in Docker) so the chat WebSocket pushes segments when the frontend sends `webrtc_session_id`.

## Frontend

The Conversation page tries the media server first (3s timeout). If it gets a session and offer, it uses WebRTC (`video.srcObject`). Otherwise it falls back to WebSocket + MSE (Phase 1). Media server URL is derived from `location.hostname:8765`.
