"""
WebRTC media server with CONTINUOUS session support and LAST-FRAME filler logic.
This ensures the stream NEVER breaks, even between clips.
"""
import asyncio
import io
import json
import logging
import uuid
import time
from fractions import Fraction

import av
from av import VideoFrame, AudioFrame
from av.audio.resampler import AudioResampler
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamError, MediaStreamTrack
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
        self._queue: asyncio.Queue[VideoFrame | None] = asyncio.Queue(maxsize=1000)
        self._closed = False
        self._pts = 0
        self._start_time = None
        self._last_frame = None

    def put_frame(self, frame: VideoFrame | None):
        if self._closed: return
        # In continuous mode, we DON'T put None for EOS into the queue unless the WHOLE session is ending.
        # We handle individual clips by just letting the queue run empty (and using filler).
        if frame is None:
            log.info("QueueVideoTrack: Clip ended (using filler until next clip)")
            return
            
        try:
            if self._queue.full(): self._queue.get_nowait()
            self._queue.put_nowait(frame)
        except: pass

    async def recv(self):
        if self._closed: raise MediaStreamError
        
        frame = None
        try:
            # We use a VERY short timeout for the queue so we can switch to filler instantly
            frame = await asyncio.wait_for(self._queue.get(), timeout=0.01)
        except asyncio.TimeoutError:
            # Underflow! Use filler (last frame)
            if self._last_frame:
                frame = self._last_frame
            else:
                # If we've NEVER had a frame, we must wait for the FIRST one
                try:
                    frame = await asyncio.wait_for(self._queue.get(), timeout=60.0)
                except asyncio.TimeoutError:
                    raise MediaStreamError

        if frame is None: 
            # This only happens if we explicitly put None (signaling total session end)
            self._closed = True
            raise MediaStreamError

        self._last_frame = frame

        # --- REAL-TIME PACING ---
        if self._start_time is None:
            self._start_time = time.monotonic()
        
        expected_time = self._start_time + (self._pts / 90000.0)
        now = time.monotonic()
        if expected_time > now:
            await asyncio.sleep(expected_time - now)
        
        # We MUST copy the frame or at least reset its PTS/time_base for EVERY delivery
        new_frame = VideoFrame.from_ndarray(frame.to_ndarray(), format=frame.format.name)
        new_frame.pts = self._pts
        new_frame.time_base = Fraction(1, 90000)
        self._pts += 3600 
        return new_frame

class QueueAudioTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue[AudioFrame | None] = asyncio.Queue(maxsize=1000)
        self._closed = False
        self._pts = 0
        self._resampler = AudioResampler(format="s16", layout="stereo", rate=48000)
        self._resampled_buffer = []
        self._start_time = None

    def put_frame(self, frame: AudioFrame | None):
        if self._closed: return
        if frame is None: return
        try:
            if self._queue.full(): self._queue.get_nowait()
            self._queue.put_nowait(frame)
        except: pass

    async def recv(self):
        if self._closed: raise MediaStreamError
        
        if not self._resampled_buffer:
            try:
                # Short timeout for audio too
                frame = await asyncio.wait_for(self._queue.get(), timeout=0.01)
                resampled = self._resampler.resample(frame)
                for f in resampled:
                    self._resampled_buffer.append(f)
            except asyncio.TimeoutError:
                # Underflow! Send 20ms of silence (960 samples @ 48kHz)
                silence_frame = AudioFrame(format="s16", layout="stereo", samples=960)
                for plane in silence_frame.planes:
                    plane.update(b"\x00" * plane.buffer_size)
                silence_frame.sample_rate = 48000
                self._resampled_buffer.append(silence_frame)

        f = self._resampled_buffer.pop(0)

        # --- REAL-TIME PACING ---
        if self._start_time is None:
            self._start_time = time.monotonic()
        
        expected_time = self._start_time + (self._pts / 48000.0)
        now = time.monotonic()
        if expected_time > now:
            await asyncio.sleep(expected_time - now)

        f.pts = self._pts
        f.time_base = Fraction(1, 48000)
        self._pts += f.samples
        return f

def decode_fmp4_to_frames(init_segment: bytes, media_segment: bytes):
    v_frames, a_frames = [], []
    try:
        with av.open(io.BytesIO(init_segment + media_segment), format="mp4") as container:
            for packet in container.demux():
                if packet.stream.type == "video":
                    v_frames.extend(packet.decode())
                elif packet.stream.type == "audio":
                    a_frames.extend(packet.decode())
    except Exception as e:
        log.warning("Decode failed: %s", e)
    return v_frames, a_frames

app = FastAPI()

@app.websocket("/signaling")
async def signaling(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    try:
        while True:
            msg = json.loads(await websocket.receive_text())
            action = msg.get("action")
            if action == "create_session":
                session_id = str(uuid.uuid4())
                pc = RTCPeerConnection(RTCConfiguration([RTCIceServer("stun:stun.l.google.com:19302")]))
                v_track, a_track = QueueVideoTrack(), QueueAudioTrack()
                pc.addTrack(v_track); pc.addTrack(a_track)
                sessions[session_id] = {"pc":pc, "v_track":v_track, "a_track":a_track, "init":None, "lock":asyncio.Lock()}
                
                @pc.on("connectionstatechange")
                async def _on_state(_sid=session_id, _pc=pc):
                    if _pc.connectionState in ("failed", "closed", "disconnected"):
                        sessions.pop(_sid, None)
                        await _pc.close()

                offer = await pc.createOffer()
                await pc.setLocalDescription(offer)
                await websocket.send_json({"session_id": session_id, "offer": {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp}})
            elif action == "answer" and session_id in sessions:
                await sessions[session_id]["pc"].setRemoteDescription(RTCSessionDescription(sdp=msg["answer"]["sdp"], type=msg["answer"]["type"]))
            elif action == "ice" and session_id in sessions:
                cand = msg.get("candidate")
                if cand and cand.get("candidate"):
                    try:
                        from aiortc.sdp import candidate_from_sdp
                        clean = cand["candidate"][10:] if cand["candidate"].startswith("candidate:") else cand["candidate"]
                        rtc_cand = candidate_from_sdp(clean.strip())
                        rtc_cand.sdpMid, rtc_cand.sdpMLineIndex = cand.get("sdpMid"), cand.get("sdpMLineIndex")
                        await sessions[session_id]["pc"].addIceCandidate(rtc_cand)
                    except: pass
    except: pass
    finally:
        if session_id in sessions:
            await sessions[session_id]["pc"].close()
            sessions.pop(session_id, None)

@app.websocket("/push")
async def push(websocket: WebSocket, session_id: str = ""):
    await websocket.accept()
    session_id = session_id or websocket.query_params.get("session_id")
    if not session_id or session_id not in sessions:
        await websocket.close(code=4000); return
    entry = sessions[session_id]
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect": break
            if "bytes" in msg:
                segment = msg["bytes"]
                # Detect init segment (ftyp/moov) vs media segment
                if len(segment) > 8 and segment[4:8] in (b"ftyp", b"moov"):
                    entry["init"] = segment; continue
                if entry["init"]:
                    async with entry["lock"]:
                        v, a = decode_fmp4_to_frames(entry["init"], segment)
                        for f in v: entry["v_track"].put_frame(f)
                        for f in a: entry["a_track"].put_frame(f)
            if "text" in msg:
                pass
    except: pass

@app.websocket("/mse")
async def mse(websocket: WebSocket, session_id: str = ""):
    """Consumes the continuous track frames and outputs a single fMP4 stream over WebSocket."""
    await websocket.accept()
    session_id = session_id or websocket.query_params.get("session_id")
    if not session_id or session_id not in sessions:
        await websocket.close(code=4000); return
    
    entry = sessions[session_id]
    v_track = entry["v_track"]
    a_track = entry["a_track"]

    output_buffer = io.BytesIO()
    # fMP4 flags: frag_keyframe (clip-based), empty_moov (for starting instantly), default_base_moof
    container = av.open(output_buffer, mode="w", format="mp4")
    
    # We use stable codecs for MSE compatibility
    v_stream = container.add_stream("libx264", rate=25)
    v_stream.width = 720
    v_stream.height = 1280
    v_stream.pix_fmt = "yuv420p"
    v_stream.options = {
        "preset": "ultrafast",
        "tune": "zerolatency",
        "profile": "baseline",
        "level": "3.1",
        "x264-params": "keyint=25:min-keyint=25:scenecut=0"
    }

    a_stream = container.add_stream("aac", rate=48000)
    a_stream.channels = 2
    a_stream.format = "fltp"

    container.mux_ex(movflags="frag_keyframe+empty_moov+default_base_moof")
    
    # Send the initial header (ftyp + moov)
    initial_header = output_buffer.getvalue()
    if initial_header:
        await websocket.send_bytes(initial_header)
        output_buffer.seek(0)
        output_buffer.truncate()

    async def get_video():
        while True: yield await v_track.recv()
    async def get_audio():
        while True: yield await a_track.recv()

    v_gen = get_video()
    a_gen = get_audio()
    
    # We mux in a loop, alternating between video and audio to keep interleaving tight
    try:
        v_task = asyncio.create_task(v_gen.__anext__())
        a_task = asyncio.create_task(a_gen.__anext__())
        
        while True:
            done, pending = await asyncio.wait([v_task, a_task], return_when=asyncio.FIRST_COMPLETED)
            
            if v_task in done:
                frame = v_task.result()
                for packet in v_stream.encode(frame):
                    container.mux(packet)
                v_task = asyncio.create_task(v_gen.__anext__())
            
            if a_task in done:
                frame = a_task.result()
                for packet in a_stream.encode(frame):
                    container.mux(packet)
                a_task = asyncio.create_task(a_gen.__anext__())

            # Check if any fragments were written to the buffer
            chunk = output_buffer.getvalue()
            if chunk:
                await websocket.send_bytes(chunk)
                output_buffer.seek(0)
                output_buffer.truncate()
                
    except Exception as e:
        log.warning("MSE stream session %s ended: %s", session_id, e)
    finally:
        try:
            # Final flush
            for packet in v_stream.encode(): container.mux(packet)
            for packet in a_stream.encode(): container.mux(packet)
            container.close()
            chunk = output_buffer.getvalue()
            if chunk: await websocket.send_bytes(chunk)
        except: pass
        if v_task: v_task.cancel()
        if a_task: a_task.cancel()

@app.get("/health")
def health(): return {"status": "ok", "sessions": len(sessions)}
