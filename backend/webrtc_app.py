"""
WebRTC media server mounted at /webrtc (same process as TwynBook).
Browser: /webrtc/signaling. Backend pushes segments to /webrtc/push.
"""
import asyncio
import io
import json
import logging
import uuid
from fractions import Fraction

import av
from av import VideoFrame
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamError, MediaStreamTrack
except ImportError:
    try:
        from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
        MediaStreamError = Exception
    except ImportError:
        from aiortc import RTCPeerConnection, RTCSessionDescription
        from aiortc.mediastreams import MediaStreamTrack
        MediaStreamError = Exception
from aiortc.rtcconfiguration import RTCConfiguration, RTCIceServer

log = logging.getLogger("webrtc")
sessions: dict = {}


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
            frame = VideoFrame(width=640, height=480, format="yuv420p")
            frame.pts = 0
            frame.time_base = Fraction(1, 25)
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


app = FastAPI(title="TwynBook WebRTC")


@app.websocket("/signaling")
async def signaling(websocket: WebSocket):
    await websocket.accept()
    log.info("WebRTC signaling: connection accepted")
    session_id = None
    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")
            log.info("WebRTC signaling: action=%s session_id=%s", action, msg.get("session_id") or session_id)

            if action == "create_session":
                session_id = str(uuid.uuid4())
                config = RTCConfiguration(iceServers=[RTCIceServer(urls="stun:stun.l.google.com:19302")])
                pc = RTCPeerConnection(configuration=config)
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
                log.info("WebRTC signaling: session created session_id=%s sending offer", session_id)
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
                    log.info("WebRTC signaling: set remote description (answer) sid=%s", sid)
                continue

            if action == "ice" and session_id:
                sid = msg.get("session_id") or session_id
                candidate = msg.get("candidate")
                if sid not in sessions:
                    log.warning("WebRTC signaling: ICE for unknown session %s", sid)
                    continue
                pc = sessions[sid]["pc"]
                if not candidate:
                    log.info("WebRTC signaling: null candidate (end-of-candidates) sid=%s", sid)
                    await pc.addIceCandidate(None)
                    continue

                cand_str = candidate.get("candidate")
                if not cand_str or cand_str.strip() == "":
                    log.info("WebRTC signaling: empty candidate (end-of-candidates) sid=%s", sid)
                    await pc.addIceCandidate(None)
                else:
                    log.info("WebRTC signaling: adding candidate sid=%s: %s", sid, cand_str[:50])
                    from aiortc import RTCIceCandidate
                    # Browser candidate looks like "candidate:..." or just the part after.
                    # rtc_cand = RTCIceCandidate(
                    #     sdpMid=candidate.get("sdpMid"),
                    #     sdpMLineIndex=candidate.get("sdpMLineIndex"),
                    #     sdp=cand_str
                    # )
                    # Using more robust parsing if available
                    try:
                        from aiortc.sdp import candidate_from_sdp
                        # Strip "candidate:" if present
                        if cand_str.startswith("candidate:"):
                            cand_part = cand_str[10:].strip()
                        else:
                            cand_part = cand_str.strip()
                        rtc_cand = candidate_from_sdp(cand_part)
                        rtc_cand.sdpMid = candidate.get("sdpMid")
                        rtc_cand.sdpMLineIndex = candidate.get("sdpMLineIndex")
                        await pc.addIceCandidate(rtc_cand)
                    except Exception as ce:
                        log.warning("ICE candidate parse failure: %s", ce)
                continue
    except WebSocketDisconnect:
        log.info("WebRTC signaling: client disconnected session_id=%s", session_id)
    except Exception as e:
        log.exception("WebRTC signaling error: %s", e)
    finally:
        if session_id and session_id in sessions:
            log.info("WebRTC signaling: cleaning up session_id=%s", session_id)
            try:
                await sessions[session_id]["pc"].close()
            except Exception:
                pass
            sessions.pop(session_id, None)


@app.websocket("/push")
async def push(websocket: WebSocket, session_id: str = ""):
    await websocket.accept()
    session_id = session_id or (websocket.query_params.get("session_id") or "")
    log.info("WebRTC push: accepted session_id=%s in_sessions=%s", session_id, session_id in sessions)
    if not session_id or session_id not in sessions:
        log.warning("WebRTC push: invalid or unknown session_id=%s closing", session_id)
        await websocket.close(code=4000)
        return
    entry = sessions[session_id]
    segment_count = 0
    try:
        while True:
            try:
                message = await websocket.receive()
            except RuntimeError as e:
                if "disconnect" in str(e).lower():
                    log.info("WebRTC push: receive disconnect RuntimeError, breaking session_id=%s", session_id)
                    break
                raise
            if message.get("type") == "websocket.disconnect":
                log.info("WebRTC push: websocket.disconnect session_id=%s", session_id)
                break
            if "bytes" in message:
                segment = message["bytes"]
                segment_count += 1
                if segment_count <= 2 or segment_count % 20 == 0:
                    log.info("WebRTC push: received segment #%s len=%s session_id=%s", segment_count, len(segment), session_id)
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
        log.info("WebRTC push: WebSocketDisconnect session_id=%s segment_count=%s", session_id, segment_count)
    except Exception as e:
        log.exception("WebRTC push error session_id=%s segment_count=%s: %s", session_id, segment_count, e)
    finally:
        log.info("WebRTC push: finally session_id=%s segment_count=%s putting EOS", session_id, segment_count)
        entry["track"].put_frame(None)


@app.get("/health")
def health():
    return {"status": "ok", "sessions": len(sessions)}
