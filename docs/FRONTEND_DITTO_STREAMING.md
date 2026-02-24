# Frontend & Backend: Using Ditto Streaming API

This document describes what the **TwynBook backend** and **frontend** should do now that Ditto exposes a **streaming WebSocket API** (port 8081) in addition to the existing **POST /generate** API (port 8080).

---

## 1. Overview

| Component | Change |
|-----------|--------|
| **Ditto (ditto-talkinghead)** | Already done: streaming on port 8081, same container as REST API. |
| **TwynBook backend** | Should call Ditto’s **WebSocket `/stream`** instead of **POST `/generate`** when producing reply video clips (and optionally idle video). |
| **TwynBook frontend (React)** | **No change required** if the backend keeps the same chat SSE contract (events `started`, `clip`, `done`, `error`) and the same clip URLs. Optional: surface new backend events (e.g. “generating”) if added. |

The frontend today only talks to the TwynBook backend (`/api/personas/.../chat`). It never calls Ditto directly. So the integration work is in the **backend**: replace `_ditto_generate` / `_ditto_generate_from_wav_bytes` with a WebSocket client that uses Ditto’s streaming endpoint.

---

## 2. Backend: What to Do

### 2.1 Configuration

- **REST (unchanged):** `DITTO_API_URL` — base URL for Ditto REST API (e.g. `http://localhost:8080`). Used for:
  - `POST /personas` (create persona)
  - `GET /personas/{image_id}/preview` (preview image)
- **Streaming:** Use the **same host and port** as the REST API; path is `/stream`.
  - **Option A:** `DITTO_STREAMING_URL=ws://localhost:8080` (then connect to `{DITTO_STREAMING_URL}/stream`).
  - **Option B:** Derive from `DITTO_API_URL`: replace `http` with `ws` (port stays 8080). Example: `http://ditto:8080` → `ws://ditto:8080`; WebSocket URL is `ws://ditto:8080/stream`.

If you use Docker and the TwynBook backend talks to Ditto by service name, the streaming URL might be `ws://<ditto-service-name>:8081` (same host as `DITTO_API_URL`, different port and scheme).

### 2.2 Replace POST /generate with WebSocket /stream

Current flow for each reply clip:

1. TTS produces WAV bytes (e.g. via Chatterbox).
2. `_ditto_generate_from_wav_bytes(image_id, wav_bytes, output_path)` writes WAV to a temp file and calls `POST {DITTO_API_URL}/generate` with `image_id` and the audio file.
3. Response body is the MP4; backend writes it to `output_path` (e.g. `reply_{persona_id}_{reply_id}_{i}.mp4`).

**New flow (streaming):**

1. TTS still produces WAV bytes (unchanged).
2. Convert WAV to the format the streaming API expects: **16 kHz, mono, float32** (see § 2.3).
3. Open a WebSocket to `{DITTO_STREAMING_URL}/stream?image_id={image_id}` (or send `image_id` in the first JSON message; see Ditto’s `STREAMING_API.md`).
4. Send the float32 audio as **binary** WebSocket frames (any chunk size). Then send an **empty binary message** (or close the connection) to signal end of input.
5. Read server messages:
   - **JSON:** status updates (`initializing`, `ready`, `processing`, `finalizing`, `sending_video`, `done`) or `{"error": "..."}`. On `error`, abort and optionally retry or fall back.
   - After a **`sending_video`** JSON message, read all **binary** frames and concatenate them to get the full MP4 bytes.
6. Write the MP4 bytes to `output_path` (same path as today so existing clip URLs still work).

The **chat SSE contract** stays the same: same events (`started`, `clip` with `url`, `done`, `error`), same clip URLs. So the React app does not need changes.

### 2.3 Audio format for streaming

Ditto’s streaming API expects:

- **Format:** 16 kHz, mono, float32, range [-1, 1].
- **Transport:** Raw bytes (no WAV header); send as WebSocket binary frames.

TTS (e.g. Chatterbox) may return WAV with a different sample rate (e.g. 22050 Hz) or int16. You must:

1. **Decode** the WAV to samples (e.g. with `soundfile`, `scipy.io.wavfile`, or `wave` + `struct`).
2. **Convert to float32** in [-1, 1] if the WAV is int16 (divide by 32768.0).
3. **Resample to 16 kHz** if the WAV is not 16 kHz (e.g. `scipy.signal.resample`, `librosa.resample`, or ffmpeg).
4. **Send** the float32 array as `samples.tobytes()` (or in chunks) over the WebSocket as binary.

Example (conceptual):

```python
import soundfile as sf
import io
import numpy as np

def wav_to_16k_float32_mono(wav_bytes: bytes) -> bytes:
    data, sr = sf.read(io.BytesIO(wav_bytes))
    if data.ndim > 1:
        data = data.mean(axis=1)
    if data.dtype != np.float32:
        data = data.astype(np.float32) / 32768.0
    if sr != 16000:
        # resample to 16000 (e.g. with librosa.resample or scipy.signal.resample)
        from librosa import resample
        data = resample(data, orig_sr=sr, target_sr=16000)
    return data.astype(np.float32).tobytes()
```

Then send this byte string in one or more WebSocket binary messages, then send an empty binary message (or close) to signal end.

### 2.4 WebSocket client (Python)

Use a library that supports WebSockets (e.g. `websockets`, or `httpx` with WebSocket support). Example structure (pseudocode):

```python
async def ditto_stream_generate(image_id: str, audio_float32_16k: bytes, output_path: str) -> None:
    ws_url = f"{DITTO_STREAMING_URL}/stream?image_id={image_id}"
    async with websockets.connect(ws_url) as ws:
        # Send audio in chunks (e.g. 64 KB)
        chunk_size = 65536
        for i in range(0, len(audio_float32_16k), chunk_size):
            await ws.send(audio_float32_16k[i:i + chunk_size])
        await ws.send(b"")  # end of input

        video_chunks = []
        async for message in ws:
            if isinstance(message, str):
                data = json.loads(message)
                if data.get("error"):
                    raise RuntimeError(data["error"])
                if data.get("status") == "sending_video":
                    # next messages will be binary (video)
                    break
            # if binary before sending_video, could be legacy; typically expect JSON first

        async for message in ws:
            if isinstance(message, bytes):
                video_chunks.append(message)
            else:
                data = json.loads(message)
                if data.get("status") == "done":
                    break
                if data.get("error"):
                    raise RuntimeError(data["error"])

        full_mp4 = b"".join(video_chunks)
        with open(output_path, "wb") as f:
            f.write(full_mp4)
```

Since your current chat flow uses `run_in_executor` with **sync** functions, you have two options:

- **Option A:** Implement a **sync** WebSocket helper that runs an async loop (e.g. `asyncio.run(ditto_stream_generate(...))`) so you can keep calling it from `run_in_executor` the same way you do `_ditto_generate_from_wav_bytes`.
- **Option B:** Refactor the chat handler to be async and call an async `ditto_stream_generate` directly (no executor for Ditto), which is cleaner if you’re comfortable with that.

### 2.5 Idle video (optional)

Idle video is currently generated with `_ditto_generate(image_id, silent_wav_path, idle_path)` (30 s of silence, 16 kHz WAV). You can:

- **Keep using POST /generate** for idle only (no change), or  
- **Switch idle to streaming:** build 30 s of silence as float32 16 kHz (`np.zeros(30 * 16000, dtype=np.float32)`), send over WebSocket, same as above. Then you can remove `_ditto_generate` entirely once all call sites use streaming.

### 2.6 Error handling and fallback

- On WebSocket connect failure or streaming error, you can **fall back to POST /generate** if you still have that endpoint (e.g. during transition), or return a 503 and surface an error in SSE (`event: error`).
- Timeouts: Ditto may send progress JSON; you can use a generous timeout (e.g. 600 s) for the full flow, or implement a heartbeat if needed.

---

## 3. Frontend (React): What to Do

### 3.1 No change required

If the backend keeps the same contract:

- **POST** `/api/personas/{personaId}/chat` with `FormData({ message })`.
- **SSE:** `started` → `clip` (with `url`, `index`, `text`) → `done` (with `reply_id`, `total`) or `error`.

then the existing frontend code that parses SSE and sets `replyState.current` / `queue` from `data.url` and plays video from `${API}${url}` continues to work. No changes are required.

### 3.2 Optional enhancements

- **Loading per clip:** If the backend adds an event like `event: generating\ndata: {"index": 0}\n\n`, the frontend can show a spinner or “Generating…” for that clip until the corresponding `clip` event arrives.
- **Progress:** If the backend forwards Ditto’s `processing` or `sending_video` in SSE (e.g. `event: progress\ndata: {...}\n\n`), the frontend could show a progress indicator.

### 3.3 If you ever call Ditto from the browser

If in the future you need the **browser** to talk to Ditto’s streaming API directly (e.g. for a custom real-time flow):

- **URL:** `ws://<ditto-host>:8081/stream` (or same host as your app if proxied). Pass `image_id` in the query or in the first message: `{"image_id": "..."}`.
- **Audio:** Capture or create audio as 16 kHz, mono, float32 (e.g. from `AudioWorklet` or decoded WAV), send as binary WebSocket frames; send empty message or close to signal end.
- **Response:** Same as in § 2.2 — JSON status/error messages, then binary MP4. Concatenate binary frames and create a blob URL for `<video src={blobUrl}>`.

The full contract is in the Ditto repo: **ditto-talkinghead/STREAMING_API.md**.

---

## 4. Summary checklist

**Backend**

- [ ] Add `DITTO_STREAMING_URL` (or derive from `DITTO_API_URL`: `ws`, port 8081).
- [ ] Implement WAV → 16 kHz mono float32 conversion.
- [ ] Implement WebSocket client: connect to `/stream?image_id=...`, send float32 audio (binary), read JSON then binary MP4; write MP4 to same `output_path` as today.
- [ ] Replace `_ditto_generate_from_wav_bytes` usage (reply clips) with the new streaming client; keep same chat SSE and clip URLs.
- [ ] (Optional) Switch idle video to streaming or keep POST /generate for idle only.
- [ ] (Optional) Fallback to POST /generate on streaming failure if that endpoint is still available.

**Frontend**

- [ ] No change required if backend contract unchanged.
- [ ] (Optional) Handle new SSE events such as `generating` or `progress` if the backend adds them.

**Reference**

- **Ditto streaming contract:** `ditto-talkinghead/STREAMING_API.md` (WebSocket URL, query params, first message, audio format, end signal, server messages).
