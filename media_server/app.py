"""
WebRTC media server for TwynBook reply video.
- Browser connects to /signaling (WebSocket): create_session -> get offer; send answer + ICE.
- TwynBook connects to /push (WebSocket): send session_id + binary fMP4 segments.
- Decodes fMP4 to frames and sends via WebRTC to the browser.
"""
import asyncio
import io
import json
import logging
import os
import uuid

from av import VideoFrame
from av.container import InputContainer
from av.packet import Packet
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamError
except ImportError:
    from aiortc import RTCPeerConnection, RTCSessionDescription
    MediaStreamError = Exception
from aiortc.media import MediaStreamTrack

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("media_server")

app = FastAPI(title="TwynBook WebRTC Media Server")

# session_id -> { "pc": RTCPeerConnection, "track": QueueVideoTrack, "init": bytes | None, "lock": asyncio.Lock }
sessions: dict = {}
FPS = 25


class QueueVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue[VideoFrame | None] = asyncio.Queue()
        self._closed = False

    def put_frame(self, frame: VideoFrame | None):
        if self._closed:
            return
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass

    async def recv(self):
        if self._closed:
            raise MediaStreamError
        try:
            frame = await asyncio.wait_for(self._queue.get(), timeout=30.0)
        except asyncio.TimeoutError:
            # Yield a black frame to keep connection alive
            frame = VideoFrame(width=640, height=480, format="yuv420p")
            frame.pts = 0
            frame.time_base = "1/25"
        if frame is None:
            self._closed = True
            raise MediaStreamError
        pts, time_base = await self.next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        return frame

    def close(self):
        self._closed = True
        self.put_frame(None)


def decode_fmp4_to_frames(init_segment: bytes, media_segment: bytes) -> list:
    """Decode init + media segment to list of VideoFrame (rgb24)."""
    import av
    frames = []
    try:
        data = init_segment + media_segment
        with av.open(io.BytesIO(data), format="mp4") as container:
            for packet in container.demux():
                if packet.stream.type == "video":
                    for frame in packet.decode():
                        img = frame.reformat(format="rgb24")
                        vf = VideoFrame.from_ndarray(img.to_ndarray(), format="rgb24")
                        vf.pts = frame.pts
                        vf.time_base = frame.time_base
                        frames.append(vf)
    except Exception as e:
        log.warning("decode_fmp4_to_frames failed: %s", e)
    return frames


@app.websocket("/signaling")
async def signaling(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")

            if action == "create_session":
                session_id = str(uuid.uuid4())
                pc = RTCPeerConnection()
                track = QueueVideoTrack()
                pc.addTrack(track)
                sessions[session_id] = {
                    "pc": pc,
                    "track": track,
                    "init": None,
                    "lock": asyncio.Lock(),
                }

                @pc.on("connectionstatechange")
                async def _on_state(_sid=session_id, _pc=pc):
                    if _pc.connectionState in ("failed", "closed", "disconnected"):
                        sessions.pop(_sid, None)
                        try:
                            await _pc.close()
                        except Exception:
                            pass

                offer = await pc.createOffer()
                await pc.setLocalDescription(offer)
                await websocket.send_json({
                    "session_id": session_id,
                    "offer": {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp},
                })
                continue

            if action == "answer" and session_id:
                sid = msg.get("session_id") or session_id
                answer = msg.get("answer")
                if sid in sessions and answer:
                    pc = sessions[sid]["pc"]
                    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
                continue

            if action == "ice" and session_id:
                sid = msg.get("session_id") or session_id
                candidate = msg.get("candidate")
                if sid in sessions and candidate:
                    pc = sessions[sid]["pc"]
                    from aiortc import RTCIceCandidate
                    await pc.addIceCandidate(RTCIceCandidate(
                        sdpMid=candidate.get("sdpMid"),
                        sdpMLineIndex=candidate.get("sdpMLineIndex"),
                        sdp=candidate.get("candidate"),
                    ))
                continue
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("signaling error: %s", e)
    finally:
        if session_id and session_id in sessions:
            try:
                await sessions[session_id]["pc"].close()
            except Exception:
                pass
            sessions.pop(session_id, None)


@app.websocket("/push")
async def push(websocket: WebSocket, session_id: str = ""):
    """TwynBook pushes fMP4 segments here. Connect with ?session_id=xxx; send binary segments; close to signal end."""
    await websocket.accept()
    session_id = session_id or (websocket.query_params.get("session_id") or "")
    if not session_id or session_id not in sessions:
        await websocket.close(code=4000)
        return
    entry = sessions[session_id]
    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message:
                segment = message["bytes"]
                if len(segment) == 0:
                    entry["track"].put_frame(None)
                    continue
                async with entry["lock"]:
                    if entry["init"] is None:
                        entry["init"] = segment
                        continue
                    frames = decode_fmp4_to_frames(entry["init"], segment)
                    for f in frames:
                        entry["track"].put_frame(f)
            if "text" in message:
                data = json.loads(message["text"])
                if data.get("end"):
                    entry["track"].put_frame(None)
    except WebSocketDisconnect:
        entry["track"].put_frame(None)
    except Exception as e:
        log.exception("push error: %s", e)
        entry["track"].put_frame(None)


@app.get("/health")
def health():
    return {"status": "ok", "sessions": len(sessions)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host="0.0.0.0", port=port)
