"""
TwynBook backend: personas (JSON store), Ditto + Chatterbox + OpenAI.
Endpoints: personas CRUD, create persona (face→Ditto, voice→Chatterbox, idle video), chat (OpenAI→TTS→Ditto).
"""
import asyncio
import base64
import io
import itertools
import json
import logging
import os
import re
import subprocess
import threading
import tempfile
import time
import struct
import uuid
import secrets
import shutil
import wave
from fractions import Fraction
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx
import numpy as np
import jwt
import websockets
import bcrypt
from websockets.exceptions import ConnectionClosed
from dotenv import load_dotenv
from pydantic import BaseModel

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
    from aiortc.mediastreams import MediaStreamTrack
    from aiortc.rtcconfiguration import RTCConfiguration, RTCIceServer
    from aiortc.sdp import candidate_from_sdp
except Exception:
    RTCPeerConnection = None
    RTCSessionDescription = None
    RTCIceCandidate = None
    MediaStreamTrack = None
    RTCConfiguration = None
    RTCIceServer = None
    candidate_from_sdp = None
try:
    from av.audio.resampler import AudioResampler
    from av import AudioFrame
except Exception:
    AudioResampler = None
    AudioFrame = None
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from openai import OpenAI

# Chatterbox TTS has a 1000-character limit per request
TTS_MAX_CHARS = 240
# Voice sample requirements for persona creation (seconds)
MIN_VOICE_SECONDS = int(os.environ.get("MIN_VOICE_SECONDS", "15"))
MAX_VOICE_SECONDS = int(os.environ.get("MAX_VOICE_SECONDS", "20"))
MIN_SPEECH_RATIO = float(os.environ.get("MIN_SPEECH_RATIO", "0.6"))
# FIRST_CLIP_SENTENCES provides a solid buffer to prevent early stalling.
FIRST_CLIP_SENTENCES = 2
SENTENCES_PER_CLIP = 2
# Audio-mode sentence grouping (reduce TTS gaps between clips).
AUDIO_FIRST_CLIP_SENTENCES = int(os.environ.get("AUDIO_FIRST_CLIP_SENTENCES", "1"))
AUDIO_SENTENCES_PER_CLIP = int(os.environ.get("AUDIO_SENTENCES_PER_CLIP", "1"))
# Video mode: first clip uses more sentences so the longer audio gives Ditto time to
# pre-render clip 1 before clip 0 finishes playing (avoids the clip-0→1 stall gap).
VIDEO_FIRST_CLIP_SENTENCES = int(os.environ.get("VIDEO_FIRST_CLIP_SENTENCES", str(AUDIO_FIRST_CLIP_SENTENCES)))
# Audio-mode continuous chunking (no sentence boundaries)
AUDIO_CONTINUOUS = os.environ.get("AUDIO_CONTINUOUS", "0").lower() in ("1", "true", "yes", "on")
AUDIO_CHUNK_CHARS = int(os.environ.get("AUDIO_CHUNK_CHARS", "60"))
# Audio-mode prompt truncation (keep last N messages, excluding system)
AUDIO_HISTORY_MAX = int(os.environ.get("AUDIO_HISTORY_MAX", "6"))
# Video / typed WebSocket chat: max messages to send to the LLM (0 = no trim — full persona conversation).
CHAT_HISTORY_MAX = int(os.environ.get("CHAT_HISTORY_MAX", "0"))
# Audio-mode max chars per clip (optional; when unset, keep full sentence).
AUDIO_CLIP_MAX_CHARS = int(os.environ.get("AUDIO_CLIP_MAX_CHARS", "240"))
# TTS provider selection for audio mode
TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "chatterbox").strip().lower()
COSYVOICE_BASE_URL = os.environ.get("COSYVOICE_BASE_URL", "").strip()
COSYVOICE_SPEED = float(os.environ.get("COSYVOICE_SPEED", "1.15"))
COSYVOICE_PROMPT_MAX_CHARS = int(os.environ.get("COSYVOICE_PROMPT_MAX_CHARS", "200"))
COSYVOICE_USE_SFT = os.environ.get("COSYVOICE_USE_SFT", "0").strip() == "1"
COSYVOICE_USE_REGISTERED_SPK = os.environ.get("COSYVOICE_USE_REGISTERED_SPK", "1").strip().lower() in ("1", "true", "yes", "on")
COSYVOICE_USE_TRITON = os.environ.get("COSYVOICE_USE_TRITON", "0").strip().lower() in ("1", "true", "yes", "on")
COSYVOICE_TRITON_URL = os.environ.get("COSYVOICE_TRITON_URL", "").strip()
COSYVOICE_TRITON_MODEL = (os.environ.get("COSYVOICE_TRITON_MODEL", "cosyvoice2") or "cosyvoice2").strip()
COSYVOICE_TRITON_OFFLINE = os.environ.get("COSYVOICE_TRITON_OFFLINE", "0").strip().lower() in ("1", "true", "yes", "on")
COSYVOICE_REF_TEXT_MODE = os.environ.get("COSYVOICE_REF_TEXT_MODE", "short").strip().lower()
COSYVOICE_USE_CACHE = os.environ.get("COSYVOICE_USE_CACHE", "0").strip().lower() in ("1", "true", "yes", "on")
COSYVOICE_CACHE_ALL_ON_STARTUP = os.environ.get("COSYVOICE_CACHE_ALL_ON_STARTUP", "0").strip().lower() in ("1", "true", "yes", "on")
COSYVOICE_CACHE_WARMUP_TEXT = os.environ.get("COSYVOICE_CACHE_WARMUP_TEXT", "Hello.").strip()
XTTS_BASE_URL = os.environ.get("XTTS_BASE_URL", "").strip().rstrip("/")
F5_TTS_BASE_URL = os.environ.get("F5_TTS_BASE_URL", "").strip().rstrip("/")
QWEN3_TTS_BASE_URL = os.environ.get("QWEN3_TTS_BASE_URL", "").strip().rstrip("/")
QWEN3_TTS_LANGUAGE = (os.environ.get("QWEN3_TTS_LANGUAGE", "English") or "English").strip()
XTTS_LANGUAGE = os.environ.get("XTTS_LANGUAGE", "en").strip()
# Add a small silence pad to smooth starts/ends of video clips (video mode only).
DITTO_SILENCE_PRE_MS = int(os.environ.get("DITTO_SILENCE_PRE_MS", "120"))
DITTO_SILENCE_POST_MS = int(os.environ.get("DITTO_SILENCE_POST_MS", "180"))
# Chatterbox TTS streaming (TwynBook-only; does not affect other providers)
CB_FFMPEG_LOW_LATENCY = os.environ.get("CB_FFMPEG_LOW_LATENCY", "1").strip().lower() in ("1", "true", "yes", "on")
CB_HTTP_CHUNK_SIZE = max(4096, int(os.environ.get("CB_HTTP_CHUNK_SIZE", "32768")))
CB_TTS_RAW_PCM = os.environ.get("CB_TTS_RAW_PCM", "1").strip().lower() in ("1", "true", "yes", "on")
# Optional clip length caps (set env to enable). When unset, no hard max is enforced.
FIRST_CLIP_MAX_CHARS = int(os.environ["FIRST_CLIP_MAX_CHARS"]) if os.environ.get("FIRST_CLIP_MAX_CHARS") else None
CLIP_MAX_CHARS = int(os.environ["CLIP_MAX_CHARS"]) if os.environ.get("CLIP_MAX_CHARS") else None
# Dynamic sentence grouping: if under min chars, append another sentence (up to max sentences).
CLIP_MIN_CHARS = int(os.environ.get("CLIP_MIN_CHARS", "120"))
AUDIO_CLIP_MIN_CHARS = int(os.environ.get("AUDIO_CLIP_MIN_CHARS", "120"))

# TURN / ICE
TURN_URL = os.environ.get("TURN_URL", "").strip()
TURN_USERNAME = os.environ.get("TURN_USERNAME", "").strip()
TURN_PASSWORD = os.environ.get("TURN_PASSWORD", "").strip()

# Sentence boundary regexes
SENTENCE_BOUNDARY_PERIOD_RE = re.compile(r"(?<!\d)\.(?:\s+|$)")
# Audio: split on period/question mark only (not between digits).
SENTENCE_BOUNDARY_AUDIO_RE = re.compile(r"(?<!\d)[.?](?:\s*|$)")
SENTENCE_SPLIT_PERIOD_RE = re.compile(r"(?<!\d)\.\s+")
SENTENCE_SPLIT_AUDIO_RE = re.compile(r"(?<!\d)[.?]\s*")

# In-process CosyVoice Triton speaker cache tracking (voice_id -> cached)
COSYVOICE_SPK_CACHE: set[str] = set()


def _chunk_by_sentences(text: str, max_chars: int = TTS_MAX_CHARS, split_re: re.Pattern | None = None) -> list[str]:
    """Split text into chunks by sentence boundaries (ignore numbered lists)."""
    if not (text or "").strip():
        return []
    normalized = text.strip().replace("\r\n", "\n")
    split_re = split_re or SENTENCE_SPLIT_PERIOD_RE
    raw = re.split(split_re, normalized)
    chunks = []
    current = []
    current_len = 0
    for part in raw:
        part = part.strip()
        if not part:
            continue
        if current_len + len(part) + 1 <= max_chars:
            current.append(part)
            current_len += len(part) + 1
        else:
            if current:
                chunks.append(" ".join(current))
            if len(part) <= max_chars:
                current = [part]
                current_len = len(part)
            else:
                for i in range(0, len(part), max_chars):
                    chunks.append(part[i : i + max_chars])
                current = []
                current_len = 0
    if current:
        chunks.append(" ".join(current))
    # Hard cap: no chunk over TTS limit (defensive)
    out = []
    for c in chunks:
        if len(c) <= max_chars:
            out.append(c)
        else:
            for i in range(0, len(c), max_chars):
                out.append(c[i : i + max_chars])
    return out


def _trim_messages_for_audio(messages: list[dict], max_messages: int) -> list[dict]:
    """Keep system + last N messages to reduce prompt size in audio mode."""
    if max_messages <= 0:
        return messages
    if len(messages) <= 1 + max_messages:
        return messages
    system = messages[0]
    tail = messages[-max_messages:]
    return [system] + tail


def _get_ice_servers() -> list:
    servers = [RTCIceServer("stun:stun.l.google.com:19302")]
    if TURN_URL and TURN_USERNAME and TURN_PASSWORD:
        urls = [u.strip() for u in TURN_URL.split(",") if u.strip()]
        if urls:
            servers.append(RTCIceServer(urls=urls, username=TURN_USERNAME, credential=TURN_PASSWORD))
    return servers


def _pcm16_to_wav_bytes(samples: np.ndarray, sample_rate: int = 16000) -> bytes:
    """Convert int16 mono PCM samples to WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())
    return buf.getvalue()


class _AudioVADBuffer:
    """Simple energy-based VAD and chunker for low-latency audio capture.

    Two-tier emission:
      - Normal: silence >= silence_ms AND speech >= min_ms  (full sentences)
      - Fallback: silence >= long_silence_ms AND speech >= noise_min_ms  (short words like "hey")
    """
    def __init__(self, sample_rate: int = 16000, rms_threshold: float = 0.006,
                 silence_ms: int = 700, min_ms: int = 800,
                 long_silence_ms: int = 1500, noise_min_ms: int = 400,
                 max_ms: int = 8000):
        self.sample_rate = sample_rate
        self.rms_threshold = rms_threshold
        self.silence_ms = silence_ms
        self.min_ms = min_ms
        self.long_silence_ms = long_silence_ms
        self.noise_min_ms = noise_min_ms
        self.max_ms = max_ms
        self._buf = []
        self._speech_ms = 0
        self._silence_ms = 0

    def _ms_from_samples(self, n: int) -> int:
        return int((n / float(self.sample_rate)) * 1000)

    def push(self, samples: np.ndarray) -> list[np.ndarray]:
        """Push int16 mono samples. Returns list of completed utterances."""
        if samples.size == 0:
            return []
        rms = float(np.sqrt(np.mean((samples.astype(np.float32) / 32768.0) ** 2)))
        is_speech = rms >= self.rms_threshold
        segs = []
        ms = self._ms_from_samples(samples.size)

        if is_speech:
            self._speech_ms += ms
            self._silence_ms = 0
            self._buf.append(samples)
            if self._speech_ms >= self.max_ms:
                seg = np.concatenate(self._buf, axis=0)
                self._reset()
                segs.append(seg)
        else:
            if self._buf:
                self._silence_ms += ms
                normal = self._silence_ms >= self.silence_ms and self._speech_ms >= self.min_ms
                fallback = self._silence_ms >= self.long_silence_ms and self._speech_ms >= self.noise_min_ms
                if normal or fallback:
                    seg = np.concatenate(self._buf, axis=0)
                    self._reset()
                    segs.append(seg)
        return segs

    def _reset(self):
        self._buf = []
        self._speech_ms = 0
        self._silence_ms = 0


class _OutgoingAudioTrack(MediaStreamTrack):
    """Outgoing WebRTC audio track fed by float32 16k mono chunks."""
    kind = "audio"

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue[AudioFrame] = asyncio.Queue(maxsize=6000)
        self._closed = False
        self._pts = 0
        self._resampler = AudioResampler(format="s16", layout="mono", rate=48000)
        self._resampled_buffer: list[AudioFrame] = []
        self._start_time = None
        self._sample_buf = np.zeros(0, dtype=np.float32)
        self._drop_count = 0
        self._silence_count = 0
        self._speaking = False
        self._last_audio_ts = None
        self._speaking_ended_at = 0.0

    def put_f32_16k(self, data: bytes) -> None:
        if self._closed or not data:
            return
        arr = np.frombuffer(data, dtype=np.float32)
        if arr.size == 0:
            return
        self._last_audio_ts = time.monotonic()
        if self._sample_buf.size:
            arr = np.concatenate([self._sample_buf, arr])
        frame_len = 320  # 20ms @ 16k
        offset = 0
        while offset + frame_len <= arr.size:
            chunk = arr[offset : offset + frame_len]
            offset += frame_len
            frame = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
            frame.sample_rate = 16000
            try:
                if self._queue.full():
                    self._drop_count += 1
                    if self._drop_count % 50 == 0:
                        log.warning("RTC audio: outbound queue full, dropped=%s", self._drop_count)
                    self._queue.get_nowait()
                self._queue.put_nowait(frame)
            except Exception:
                break
        self._sample_buf = arr[offset:]

    def flush(self) -> None:
        """Pad and enqueue any leftover samples so tails don't get truncated."""
        if self._closed:
            return
        if self._sample_buf.size == 0:
            return
        frame_len = 320  # 20ms @ 16k
        pad = frame_len - self._sample_buf.size
        if pad <= 0:
            return
        chunk = np.concatenate([self._sample_buf, np.zeros(pad, dtype=np.float32)])
        self._sample_buf = np.zeros(0, dtype=np.float32)
        frame = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
        frame.sample_rate = 16000
        try:
            if self._queue.full():
                self._queue.get_nowait()
            self._queue.put_nowait(frame)
        except Exception:
            pass

    def set_speaking(self, is_speaking: bool) -> None:
        self._speaking = is_speaking
        if not is_speaking:
            self._last_audio_ts = None
            self._speaking_ended_at = time.monotonic()

    async def recv(self) -> AudioFrame:
        if self._closed:
            raise Exception("Track closed")

        if not self._resampled_buffer:
            try:
                # Allow longer waits while speaking to avoid "choppy" audio when TTS
                # yields in bursts.
                timeout = 2.0 if self._speaking else 0.02
                frame = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                resampled = self._resampler.resample(frame)
                if not isinstance(resampled, list):
                    resampled = [resampled]
                for f in resampled:
                    self._resampled_buffer.append(f)
            except asyncio.TimeoutError:
                if self._speaking and self._last_audio_ts:
                    gap = time.monotonic() - self._last_audio_ts
                    if gap < 2.5:
                        # Wait a bit longer instead of injecting silence during short TTS stalls
                        return await self.recv()
                # 20ms silence @ 48k
                self._silence_count += 1
                if self._silence_count % 100 == 0:
                    log.info("RTC audio: inserted silence frames=%s", self._silence_count)
                silence = AudioFrame(format="s16", layout="mono", samples=960)
                for plane in silence.planes:
                    plane.update(b"\x00" * plane.buffer_size)
                silence.sample_rate = 48000
                self._resampled_buffer.append(silence)

        f = self._resampled_buffer.pop(0)

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

async def _stt_transcribe_wav(wav_bytes: bytes) -> str:
    if not STT_BASE_URL:
        return ""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{STT_BASE_URL}/transcribe",
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            )
            resp.raise_for_status()
            data = resp.json()
            return (data.get("text") or "").strip()
    except Exception as e:
        log.warning("STT error: %s", e)
        return ""


def _stt_transcribe_wav_sync(wav_bytes: bytes) -> str:
    if not STT_BASE_URL:
        return ""
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f"{STT_BASE_URL}/transcribe",
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            )
            resp.raise_for_status()
            data = resp.json()
            return (data.get("text") or "").strip()
    except Exception as e:
        log.warning("STT error (sync): %s", e)
        return ""

def _video_response(request: Request, path: Path, media_type: str = "video/mp4") -> Response:
    """Serve a video file with Range request support so browsers can stream/seek."""
    size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header or not range_header.strip().lower().startswith("bytes="):
        with open(path, "rb") as f:
            body = f.read()
        return Response(
            content=body,
            status_code=200,
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Content-Length": str(len(body))},
        )
    try:
        parts = range_header.strip().split("=")[1].strip().split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else size - 1
        end = min(end, size - 1)
        if start > end or start < 0:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        length = end - start + 1
        with open(path, "rb") as f:
            f.seek(start)
            body = f.read(length)
        return Response(
            content=body,
            status_code=206,
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
                "Content-Range": f"bytes {start}-{end}/{size}",
            },
        )
    except (ValueError, IndexError):
        with open(path, "rb") as f:
            body = f.read()
        return Response(content=body, status_code=200, media_type=media_type, headers={"Accept-Ranges": "bytes"})


class PersonaUpdate(BaseModel):
    name: str | None = None
    system_prompt: str | None = None
    assigned_listing_ids: list[str] | None = None
    assigned_role_pack_id: str | None = None  # one role pack per twyn


class KnowledgePacksAttach(BaseModel):
    listing_ids: list[str] = []


class PersonaPublish(BaseModel):
    price: float = 0.0


class UserSignup(BaseModel):
    email: str
    password: str
    name: str | None = None


class UserLogin(BaseModel):
    email: str
    password: str


class ListingCreate(BaseModel):
    name: str
    description: str = ""
    logo_url: str = ""
    price: float = 0.0
    mcp_server_url: str = ""
    listing_type: str = "integration"  # integration | role_pack | avatar
    role_prompt: str = ""  # for role_pack
    image_id: str = ""  # for avatar (set by admin avatar upload)
    voice_id: str = ""   # for avatar


class ListingUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    logo_url: str | None = None
    price: float | None = None
    mcp_server_url: str | None = None
    listing_type: str | None = None
    role_prompt: str | None = None
    image_id: str | None = None
    voice_id: str | None = None

load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="TwynBook API", version="0.1.0")


@app.get("/api/webrtc/ice")
def get_webrtc_ice():
    """Expose ICE config for the frontend."""
    servers = [{"urls": "stun:stun.l.google.com:19302"}]
    if TURN_URL and TURN_USERNAME and TURN_PASSWORD:
        urls = [u.strip() for u in TURN_URL.split(",") if u.strip()]
        if urls:
            servers.append({"urls": urls, "username": TURN_USERNAME, "credential": TURN_PASSWORD})
    return {"iceServers": servers}
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Config (needed before optional webrtc mount)
DATA_DIR = Path(os.environ.get("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
PERSONAS_FILE = DATA_DIR / "personas.json"
USERS_FILE = DATA_DIR / "users.json"
LISTINGS_FILE = DATA_DIR / "listings.json"
PURCHASES_FILE = DATA_DIR / "purchases.json"
JWT_SECRET = os.environ.get("JWT_SECRET", "twynbook-dev-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 7
# Only this email is ever set as admin (in DB at startup). Signup cannot grant admin.
ADMIN_EMAIL = "n.brown@4th-ir.com"
http_bearer = HTTPBearer(auto_error=False)
STATIC_DIR = Path(os.environ.get("STATIC_DIR", ""))  # When set (e.g. in Docker), serve frontend from here
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OLLAMA_URL = (os.environ.get("OLLAMA_URL", "") or "").strip().rstrip("/")  # e.g. http://ollama:11434
OLLAMA_MODEL = (os.environ.get("OLLAMA_MODEL", "") or "llama3.2:3b").strip() or "llama3.2:3b"
CHATTERBOX_BASE_URL = (os.environ.get("CHATTERBOX_BASE_URL", "http://85.4.52.192:8000")).rstrip("/")
STT_BASE_URL = (os.environ.get("STT_BASE_URL", "") or "").strip().rstrip("/")
DITTO_API_URL = (os.environ.get("DITTO_API_URL", "http://localhost:8080")).rstrip("/")
DITTO_API_URLS = [
    u.strip().rstrip("/")
    for u in (os.environ.get("DITTO_API_URLS", "") or "").split(",")
    if u.strip()
]

# WebRTC media server (signaling + push) on same process at /webrtc; optional so app starts if aiortc/av fail
MEDIA_SERVER_WS_URL = (os.environ.get("MEDIA_SERVER_WS_URL", "ws://localhost:8087/webrtc")).rstrip("/")
try:
    from webrtc_app import app as webrtc_app
    app.mount("/webrtc", webrtc_app)
    log.info("WebRTC media server mounted at /webrtc")
except Exception as e:
    log.warning("WebRTC app not mounted (aiortc/av may be missing): %s", e)
    webrtc_app = None
    MEDIA_SERVER_WS_URL = ""
webrtc_managers = {}

# Knowledge base: per-persona documents and embeddings (scoped by persona ownership)
KB_DIR = DATA_DIR / "kb"
KB_DIR.mkdir(parents=True, exist_ok=True)
KB_PACKS_DIR = DATA_DIR / "kb_packs"
KB_PACKS_DIR.mkdir(parents=True, exist_ok=True)


def _ollama_warmup():
    if not OLLAMA_URL:
        return
    url = f"{OLLAMA_URL}/v1/chat/completions"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Say hi."},
        ],
        "stream": False,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
        log.info("Ollama warmup completed for model=%s", OLLAMA_MODEL)
    except Exception as e:
        log.warning("Ollama warmup failed for model=%s: %s", OLLAMA_MODEL, e)


@app.on_event("startup")
async def _startup_warmup():
    if not OLLAMA_URL:
        return
    # Warm up in background so startup isn't blocked.
    threading.Thread(target=_ollama_warmup, daemon=True).start()

    # Cache CosyVoice speakers on startup (best effort, non-blocking)
    if TTS_PROVIDER == "cosyvoice":
        if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE and COSYVOICE_CACHE_ALL_ON_STARTUP:
            threading.Thread(target=lambda: _cosyvoice_cache_all_personas(), daemon=True).start()
        elif not COSYVOICE_USE_TRITON:
            def _cosyvoice_cache_all():
                try:
                    personas = load_personas()
                    for p in personas:
                        voice_wav_path = (p.get("voice_wav_path") or "").strip()
                        voice_ref_text = (p.get("voice_ref_text") or "").strip()
                        if not voice_wav_path or not Path(voice_wav_path).is_file():
                            continue
                        if not voice_ref_text:
                            log.warning("CosyVoice cache skipped (missing voice_ref_text) persona_id=%s", p.get("id"))
                            continue
                        _cosyvoice_register_speaker(p.get("voice_id") or p["id"], str(voice_wav_path), voice_ref_text)
                except Exception as e:
                    log.warning("CosyVoice startup cache failed: %s", e)
            threading.Thread(target=_cosyvoice_cache_all, daemon=True).start()
RAG_EMBED_MODEL = "text-embedding-3-small"
RAG_CHUNK_TOKENS = 500
RAG_OVERLAP_TOKENS = 50
RAG_TOP_K = 5
RAG_RELEVANCE_THRESHOLD = 0.25  # min cosine similarity to inject context; below = use general knowledge only
KNOWLEDGE_PACK_MAX_DOCS = 5


def _kb_persona_dir(persona_id: str) -> Path:
    d = KB_DIR / persona_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _kb_pack_dir(listing_id: str) -> Path:
    return KB_PACKS_DIR / listing_id


def _load_pack_manifest(listing_id: str) -> list[dict]:
    meta = _kb_pack_dir(listing_id) / "_manifest.json"
    if not meta.is_file():
        return []
    try:
        with open(meta, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_pack_manifest(listing_id: str, manifest: list[dict]) -> None:
    d = _kb_pack_dir(listing_id)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / "_manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)


def _extract_text_from_file(path: Path, filename: str) -> str:
    ext = (path.suffix or "").lower()
    if ext == ".txt":
        return path.read_text(encoding="utf-8", errors="replace")
    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        return "\n".join((p.extract_text() or "").strip() for p in reader.pages)
    return ""


def _chunk_text_by_tokens(text: str, max_tokens: int = RAG_CHUNK_TOKENS, overlap_tokens: int = RAG_OVERLAP_TOKENS) -> list[str]:
    import tiktoken
    enc = tiktoken.get_encoding("cl100k_base")
    tokens = enc.encode(text)
    if not tokens:
        return []
    chunks = []
    start = 0
    while start < len(tokens):
        end = min(start + max_tokens, len(tokens))
        chunk_tokens = tokens[start:end]
        chunks.append(enc.decode(chunk_tokens))
        if end >= len(tokens):
            break
        start = end - overlap_tokens
    return chunks


def _embed_texts(client: OpenAI, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    resp = client.embeddings.create(model=RAG_EMBED_MODEL, input=texts)
    by_index = {e.index: e.embedding for e in resp.data}
    return [by_index.get(i, []) for i in range(len(texts))]


def _load_persona_chunks(persona_id: str) -> list[dict]:
    chunks_file = _kb_persona_dir(persona_id) / "chunks.json"
    if not chunks_file.is_file():
        return []
    with open(chunks_file, "r") as f:
        data = json.load(f)
    return data.get("chunks", [])


def _save_persona_chunks(persona_id: str, chunks: list[dict]) -> None:
    chunks_file = _kb_persona_dir(persona_id) / "chunks.json"
    with open(chunks_file, "w") as f:
        json.dump({"chunks": chunks}, f, indent=2)


def _load_persona_docs(persona_id: str) -> list[dict]:
    meta_file = _kb_persona_dir(persona_id) / "_docs.json"
    if not meta_file.is_file():
        return []
    with open(meta_file, "r") as f:
        return json.load(f)


def _save_persona_docs(persona_id: str, docs: list[dict]) -> None:
    meta_file = _kb_persona_dir(persona_id) / "_docs.json"
    with open(meta_file, "w") as f:
        json.dump(docs, f, indent=2)


def _process_document_sync(persona_id: str, doc_id: str, file_path: Path, filename: str) -> None:
    """Extract text, chunk, embed, append to persona chunks. Run in thread if needed."""
    text = _extract_text_from_file(file_path, filename)
    if not (text or "").strip():
        return
    chunks_text = _chunk_text_by_tokens(text.strip())
    if not chunks_text:
        return
    client = OpenAI(api_key=OPENAI_API_KEY)
    embeddings = _embed_texts(client, chunks_text)
    existing = _load_persona_chunks(persona_id)
    for i, (ct, emb) in enumerate(zip(chunks_text, embeddings)):
        if not emb:
            continue
        existing.append({
            "id": uuid.uuid4().hex,
            "doc_id": doc_id,
            "text": ct,
            "embedding": emb,
        })
    _save_persona_chunks(persona_id, existing)


def get_rag_context(persona_id: str, user_id: str, query: str) -> str:
    """Return top-k relevant chunk texts for this persona's KB, above threshold; else '' (use general knowledge)."""
    p = get_persona(persona_id, user_id)
    if not p:
        return ""
    chunks = _load_persona_chunks(persona_id)
    if not chunks or not (query or "").strip():
        return ""
    if not OPENAI_API_KEY:
        return ""
    client = OpenAI(api_key=OPENAI_API_KEY)
    q_emb = _embed_texts(client, [query.strip()])
    if not q_emb or not q_emb[0]:
        return ""
    q_vec = q_emb[0]
    import numpy as np
    q_norm = np.array(q_vec, dtype=float)
    q_norm = q_norm / (np.linalg.norm(q_norm) + 1e-9)
    scores = []
    for c in chunks:
        emb = c.get("embedding") or []
        if not emb:
            continue
        v = np.array(emb, dtype=float)
        v = v / (np.linalg.norm(v) + 1e-9)
        cos = float(np.dot(q_norm, v))
        if cos >= RAG_RELEVANCE_THRESHOLD:
            scores.append((cos, c.get("text") or ""))
    scores.sort(key=lambda x: -x[0])
    top = scores[:RAG_TOP_K]
    if not top:
        return ""
    return "\n\n".join(t for _, t in top)


def _to_ws_base(url: str) -> str:
    if url.startswith("wss://") or url.startswith("ws://"):
        return url.rstrip("/")
    if url.startswith("https://"):
        return "wss://" + url[8:].rstrip("/")
    if url.startswith("http://"):
        return "ws://" + url[7:].rstrip("/")
    return url.rstrip("/")


def _to_http_base(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url.rstrip("/")
    if url.startswith("ws://"):
        return "http://" + url[5:].rstrip("/")
    if url.startswith("wss://"):
        return "https://" + url[6:].rstrip("/")
    return url.rstrip("/")


def _ditto_streaming_bases() -> list[str]:
    """WebSocket base URLs for Ditto streaming. Honors DITTO_STREAMING_URL or DITTO_API_URLS."""
    stream_override = os.environ.get("DITTO_STREAMING_URL", "").strip()
    if stream_override:
        return [_to_ws_base(stream_override)]
    bases = DITTO_API_URLS[:] if DITTO_API_URLS else [DITTO_API_URL]
    return [_to_ws_base(b) for b in bases]


def _ditto_http_bases() -> list[str]:
    """HTTP base URLs for Ditto /generate. Uses DITTO_API_URLS or DITTO_API_URL."""
    bases = DITTO_API_URLS[:] if DITTO_API_URLS else [DITTO_API_URL]
    return [_to_http_base(b) for b in bases]


_DITTO_WS_BASES = _ditto_streaming_bases()
_DITTO_WS_LOCKS = [asyncio.Lock() for _ in _DITTO_WS_BASES]
_DITTO_RR = itertools.count()
_DITTO_HTTP_BASES = _ditto_http_bases()


def _pick_ditto_worker() -> tuple[int, str]:
    """Round-robin across Ditto WS bases."""
    if not _DITTO_WS_BASES:
        return 0, _to_ws_base(DITTO_API_URL)
    idx = next(_DITTO_RR) % len(_DITTO_WS_BASES)
    return idx, _DITTO_WS_BASES[idx]

# In-memory creation status so frontend can show "creating" vs "failed" (persona_id -> "creating" or {"status": "failed", "error": "..."})
creation_status: dict = {}


def load_personas() -> list[dict]:
    if not PERSONAS_FILE.exists():
        return []
    with open(PERSONAS_FILE, "r") as f:
        return json.load(f)


def save_personas(personas: list[dict]) -> None:
    with open(PERSONAS_FILE, "w") as f:
        json.dump(personas, f, indent=2)


def get_persona(persona_id: str, user_id: str | None = None) -> dict | None:
    for p in load_personas():
        if p.get("id") == persona_id:
            if user_id is not None and p.get("user_id") != user_id:
                return None
            return p
    return None


def get_persona_by_share_id(share_id: str) -> dict | None:
    if not share_id:
        return None
    for p in load_personas():
        if p.get("share_id") == share_id:
            return p
    return None


# ---- User storage ----

def load_users() -> list[dict]:
    if not USERS_FILE.exists():
        return []
    with open(USERS_FILE, "r") as f:
        return json.load(f)


def save_users(users: list[dict]) -> None:
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def get_user_by_email(email: str) -> dict | None:
    for u in load_users():
        if u.get("email", "").lower() == email.lower():
            return u
    return None


def get_user_by_id(user_id: str) -> dict | None:
    for u in load_users():
        if u.get("id") == user_id:
            return u
    return None


def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(http_bearer)) -> dict:
    if not credentials:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    user = get_user_by_id(payload.get("sub", ""))
    if not user:
        raise HTTPException(401, "User not found")
    return user


def get_current_user_from_token(token: str | None) -> dict:
    """Validate JWT from query string (e.g. WebSocket). Returns user dict or raises HTTPException."""
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    user = get_user_by_id(payload.get("sub", ""))
    if not user:
        raise HTTPException(401, "User not found")
    return user


def get_current_admin(current_user: dict = Depends(get_current_user)) -> dict:
    if not current_user.get("is_admin"):
        raise HTTPException(403, "Admin access required")
    return current_user


# ---- Marketplace / listing storage ----

DEFAULT_LISTINGS = [
    {
        "id": "default-ppt",
        "name": "PowerPoint",
        "description": "Create and manipulate PowerPoint presentations. Your twyn can build slides, add content, and format decks automatically.",
        "logo_url": "https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/microsoftpowerpoint.svg",
        "price": 9.99,
        "mcp_server_url": "http://74.161.41.130:8010/mcp",
        "listing_type": "integration",
        "created_by": "system",
        "created_at": datetime.now(timezone.utc).isoformat(),
    },
    {
        "id": "default-excel",
        "name": "Excel",
        "description": "Work with Excel spreadsheets. Your twyn can read, write, and analyse spreadsheet data on your behalf.",
        "logo_url": "https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/microsoftexcel.svg",
        "price": 9.99,
        "mcp_server_url": "http://74.161.41.130:8017/mcp",
        "listing_type": "integration",
        "created_by": "system",
        "created_at": datetime.now(timezone.utc).isoformat(),
    },
]


def load_listings() -> list[dict]:
    if not LISTINGS_FILE.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        save_listings(DEFAULT_LISTINGS)
        return DEFAULT_LISTINGS
    with open(LISTINGS_FILE, "r") as f:
        items = json.load(f)
    if not items:
        save_listings(DEFAULT_LISTINGS)
        return DEFAULT_LISTINGS
    return items


def save_listings(items: list[dict]) -> None:
    with open(LISTINGS_FILE, "w") as f:
        json.dump(items, f, indent=2)


def get_listing(listing_id: str) -> dict | None:
    for l in load_listings():
        if l.get("id") == listing_id:
            return l
    return None


def load_purchases() -> list[dict]:
    if not PURCHASES_FILE.exists():
        return []
    with open(PURCHASES_FILE, "r") as f:
        return json.load(f)


def save_purchases(purchases: list[dict]) -> None:
    with open(PURCHASES_FILE, "w") as f:
        json.dump(purchases, f, indent=2)


def get_user_purchases(user_id: str) -> list[dict]:
    owned_ids = {p["listing_id"] for p in load_purchases() if p.get("user_id") == user_id}
    return [l for l in load_listings() if l.get("id") in owned_ids]


# ---- MCP client ----

def _mcp_normalize_url(url: str) -> str:
    """Ensure MCP URL has trailing slash to avoid 307 redirects from servers that require it."""
    if not url or url.endswith("/"):
        return url
    return url.rstrip("/") + "/"


def _mcp_list_tools(url: str, timeout: float = 10.0) -> list[dict]:
    """Call remote MCP server to list tools (JSON-RPC 2.0)."""
    url = _mcp_normalize_url(url)
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        r = client.post(url, json=payload, headers=headers)
        if r.status_code == 406:
            r = client.post(url, json=payload, headers={**headers, "Accept": "*/*"})
        r.raise_for_status()
        data = r.json()
        return data.get("result", {}).get("tools", [])


def _mcp_execute_tool(url: str, tool_name: str, arguments: dict, timeout: float = 60.0) -> dict:
    """Call remote MCP server to execute a tool (JSON-RPC 2.0). Returns result dict."""
    url = _mcp_normalize_url(url)
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        r = client.post(url, json=payload, headers=headers)
        if r.status_code == 406:
            r = client.post(url, json=payload, headers={**headers, "Accept": "*/*"})
        r.raise_for_status()
        data = r.json()
        return data.get("result", {})


def _run_with_tools_sync(client, messages: list, tools: list, tool_name_to_url: dict) -> str:
    """Non-streaming: call OpenAI with tools, handle tool_calls loop, return final text."""
    from openai import NOT_GIVEN
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        tools=tools if tools else NOT_GIVEN,
        tool_choice="auto" if tools else NOT_GIVEN,
    )
    msg = resp.choices[0].message
    if not msg.tool_calls:
        return msg.content or ""

    # Append assistant message with tool_calls
    updated = list(messages) + [{
        "role": "assistant",
        "content": msg.content,
        "tool_calls": [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in msg.tool_calls
        ],
    }]

    # Execute each tool via MCP
    for tc in msg.tool_calls:
        mcp_url = tool_name_to_url.get(tc.function.name)
        try:
            args = json.loads(tc.function.arguments)
        except Exception:
            args = {}
        try:
            if mcp_url:
                result = _mcp_execute_tool(mcp_url, tc.function.name, args)
                parts = result.get("content", [])
                if parts:
                    content_str = "\n".join(
                        p.get("text", str(p)) if isinstance(p, dict) and p.get("type") == "text" else str(p)
                        for p in parts
                    )
                else:
                    content_str = json.dumps(result)
            else:
                content_str = f"Tool '{tc.function.name}' is not available."
        except Exception as e:
            content_str = f"Tool execution error: {e}"
        updated.append({"role": "tool", "tool_call_id": tc.id, "content": content_str})

    # Final LLM call to generate a natural reply
    resp2 = client.chat.completions.create(model="gpt-4o-mini", messages=updated)
    return resp2.choices[0].message.content or ""


def _silent_wav_path(seconds: float = 10.0, sample_rate: int = 16000) -> str:
    """Create a temporary silent WAV file; returns path. Caller should unlink when done."""
    path = tempfile.mktemp(suffix=".wav")
    n_frames = int(seconds * sample_rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(b"\x00\x00" * n_frames)
    return path


@app.get("/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def _ensure_admin_in_db():
    """Ensure the single admin email (n.brown@4th-ir.com) has is_admin=True in DB. No one else can become admin via signup."""
    if not USERS_FILE.exists():
        return
    users = load_users()
    changed = False
    for u in users:
        if (u.get("email") or "").lower() == ADMIN_EMAIL.lower() and not u.get("is_admin"):
            u["is_admin"] = True
            changed = True
            log.info("Set is_admin=True for %s", ADMIN_EMAIL)
    if changed:
        save_users(users)


# ---- Auth endpoints ----

@app.post("/api/auth/signup")
def signup(body: UserSignup):
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Valid email required")
    if not body.password or len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if get_user_by_email(email):
        raise HTTPException(409, "Email already registered")
    user_id = uuid.uuid4().hex
    user = {
        "id": user_id,
        "email": email,
        "name": (body.name or "").strip() or email.split("@")[0],
        "password_hash": bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
        "is_admin": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    users = load_users()
    users.append(user)
    save_users(users)
    token = create_access_token(user_id)
    # New signups are never admin; admin is only set in DB (e.g. at startup for ADMIN_EMAIL).
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "name": user["name"], "is_admin": False}}


@app.post("/api/auth/login")
def login(body: UserLogin):
    email = (body.email or "").strip().lower()
    user = get_user_by_email(email)
    if not user:
        raise HTTPException(401, "Invalid email or password")
    stored = user.get("password_hash") or ""
    if not stored or not bcrypt.checkpw(body.password.encode("utf-8"), stored.encode("utf-8")):
        raise HTTPException(401, "Invalid email or password")
    token = create_access_token(user["id"])
    return {"token": token, "user": {"id": user["id"], "email": user["email"], "name": user["name"], "is_admin": user.get("is_admin", False)}}


@app.get("/api/auth/me")
def me(current_user: dict = Depends(get_current_user)):
    return {"id": current_user["id"], "email": current_user["email"], "name": current_user["name"], "is_admin": current_user.get("is_admin", False)}


@app.put("/api/auth/me")
def update_me(body: dict, current_user: dict = Depends(get_current_user)):
    users = load_users()
    for i, u in enumerate(users):
        if u["id"] == current_user["id"]:
            if "name" in body:
                users[i]["name"] = (body["name"] or "").strip() or u["name"]
            save_users(users)
            u = users[i]
            return {"id": u["id"], "email": u["email"], "name": u["name"], "is_admin": u.get("is_admin", False)}
    raise HTTPException(404, "User not found")


# ---- Admin dashboard ----

@app.get("/api/admin/dashboard")
def admin_dashboard(current_user: dict = Depends(get_current_admin)):
    """Return user list with persona counts, purchase counts, and totals. Admin only."""
    users = load_users()
    personas = load_personas()
    purchases = load_purchases()
    listings = {l["id"]: l for l in load_listings()}

    def persona_count(uid: str) -> int:
        return sum(1 for p in personas if p.get("user_id") == uid)

    def user_purchases(uid: str) -> list[dict]:
        return [p for p in purchases if p.get("user_id") == uid]

    rows = []
    for u in users:
        uid = u.get("id") or ""
        up = user_purchases(uid)
        listing_names = [listings.get(p.get("listing_id"), {}).get("name", p.get("listing_id", "?")) for p in up]
        rows.append({
            "id": uid,
            "email": u.get("email") or "",
            "name": u.get("name") or "",
            "created_at": u.get("created_at") or "",
            "is_admin": u.get("is_admin", False),
            "persona_count": persona_count(uid),
            "purchase_count": len(up),
            "purchases": listing_names,
        })
    totals = {
        "users": len(users),
        "personas": len(personas),
        "purchases": len(purchases),
    }
    return {"users": rows, "totals": totals}


# ---- Marketplace endpoints ----

@app.get("/api/marketplace")
def list_marketplace():
    """List all marketplace listings (public)."""
    return {"listings": load_listings()}


def _listing_type(l: dict) -> str:
    return (l.get("listing_type") or "integration").strip() or "integration"


@app.post("/api/admin/marketplace")
def create_listing(body: ListingCreate, current_user: dict = Depends(get_current_admin)):
    listing_type = (body.listing_type or "integration").strip() or "integration"
    if listing_type not in ("integration", "role_pack", "avatar"):
        raise HTTPException(400, "listing_type must be integration, role_pack, or avatar")
    if listing_type == "integration" and not (body.mcp_server_url or "").strip():
        raise HTTPException(400, "mcp_server_url is required for integration listings")
    if listing_type == "role_pack" and not (body.role_prompt or "").strip():
        raise HTTPException(400, "role_prompt is required for role pack listings")
    if listing_type == "avatar" and (not (body.image_id or "").strip() or not (body.voice_id or "").strip()):
        raise HTTPException(400, "Avatar must be created via POST /api/admin/marketplace/avatar (upload image + voice)")

    listing = {
        "id": uuid.uuid4().hex,
        "name": body.name.strip(),
        "description": (body.description or "").strip(),
        "logo_url": (body.logo_url or "").strip(),
        "price": body.price,
        "mcp_server_url": (body.mcp_server_url or "").strip(),
        "listing_type": listing_type,
        "role_prompt": (body.role_prompt or "").strip(),
        "image_id": (body.image_id or "").strip(),
        "voice_id": (body.voice_id or "").strip(),
        "created_by": current_user["id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    listings = load_listings()
    listings.append(listing)
    save_listings(listings)
    return listing


@app.post("/api/admin/marketplace/avatar")
async def create_avatar_listing(
    name: str = Form(...),
    description: str = Form(""),
    price: float = Form(0.0),
    face: UploadFile = File(...),
    voice: UploadFile = File(...),
    current_user: dict = Depends(get_current_admin),
):
    """Create an avatar listing: upload image + voice; we create Ditto persona and clone voice, then save listing with image_id and voice_id."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    face_bytes = await face.read()
    voice_bytes = await voice.read()
    content_type = (voice.content_type or "").lower()
    if "wav" not in content_type:
        voice_bytes = _audio_to_wav(voice_bytes, content_type)
    try:
        voice_bytes = _trim_voice_wav(voice_bytes, max_seconds=MAX_VOICE_SECONDS, min_seconds=MIN_VOICE_SECONDS)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    # Use a temp name for Ditto/Chatterbox (avatar name is for marketplace only)
    ditto_name = name or "Avatar"
    try:
        ditto_persona = _ditto_create_persona(face_bytes, ditto_name)
        image_id = ditto_persona["image_id"]
    except Exception as e:
        log.exception("Avatar listing: Ditto failed: %s", e)
        raise HTTPException(502, f"Ditto failed: {e}") from e
    try:
        if TTS_PROVIDER == "cosyvoice":
            voice_id = image_id
            log.info("Avatar listing: cosyvoice voice OK image_id=%s", image_id)
        elif TTS_PROVIDER == "qwen3":
            if not QWEN3_TTS_BASE_URL:
                raise ValueError("Qwen3-TTS not configured (missing QWEN3_TTS_BASE_URL)")
            voice_id = ""  # set after WAV + optional STT below
            log.info("Avatar listing: qwen3 will register after voice saved image_id=%s", image_id)
        else:
            voice_id = _chatterbox_clone_voice(voice_bytes, ditto_name)
    except Exception as e:
        log.exception("Avatar listing: Voice clone failed: %s", e)
        raise HTTPException(502, f"Voice clone failed: {e}") from e
    voice_wav_path = DATA_DIR / f"listing_voice_{image_id}.wav"
    voice_ref_text = None
    try:
        voice_wav_path.write_bytes(voice_bytes)
        voice_ref_text = _stt_transcribe_wav_sync(voice_bytes) or None
    except Exception:
        voice_wav_path = None
    if TTS_PROVIDER == "qwen3" and voice_wav_path and voice_bytes:
        try:
            voice_id = _qwen3_register_voice(voice_bytes, ditto_name, voice_ref_text)
            log.info("Avatar listing: qwen3 registered image_id=%s voice_id=%s", image_id, voice_id)
        except Exception as e:
            log.exception("Avatar listing: Qwen3 register failed: %s", e)
            raise HTTPException(502, f"Qwen3 voice register failed: {e}") from e
    elif TTS_PROVIDER == "qwen3":
        raise HTTPException(502, "Qwen3 voice register failed: could not save reference WAV")
    if TTS_PROVIDER == "cosyvoice" and voice_wav_path:
        if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE:
            _cosyvoice_cache_speaker_triton(str(voice_id), str(voice_wav_path), voice_ref_text)
        else:
            if voice_ref_text:
                _cosyvoice_register_speaker(voice_id, str(voice_wav_path), voice_ref_text)
    listing = {
        "id": uuid.uuid4().hex,
        "name": name,
        "description": (description or "").strip(),
        "logo_url": ditto_persona.get("preview_url") or "",
        "price": float(price),
        "mcp_server_url": "",
        "listing_type": "avatar",
        "role_prompt": "",
        "image_id": image_id,
        "voice_id": voice_id,
        "voice_wav_path": str(voice_wav_path) if voice_wav_path else None,
        "voice_ref_text": voice_ref_text,
        "created_by": current_user["id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    listings = load_listings()
    listings.append(listing)
    save_listings(listings)
    return listing


@app.post("/api/admin/marketplace/knowledge-pack")
async def create_knowledge_pack_listing(
    name: str = Form(...),
    description: str = Form(""),
    price: float = Form(0.0),
    logo_url: str = Form(""),
    files: list[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_admin),
):
    """Admin: marketplace listing bundling PDF/TXT files; buyers attach copies to new personas' KB."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    if not files:
        raise HTTPException(400, "At least one PDF or TXT file is required")
    if len(files) > KNOWLEDGE_PACK_MAX_DOCS:
        raise HTTPException(
            400,
            f"A knowledge pack can include at most {KNOWLEDGE_PACK_MAX_DOCS} documents",
        )
    listing_id = uuid.uuid4().hex
    pack_dir = _kb_pack_dir(listing_id)
    if pack_dir.exists():
        shutil.rmtree(pack_dir, ignore_errors=True)
    pack_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    for f in files:
        if len(manifest) >= KNOWLEDGE_PACK_MAX_DOCS:
            break
        if not f.filename:
            continue
        ext = Path(f.filename).suffix.lower()
        if ext not in (".pdf", ".txt"):
            continue
        doc_id = uuid.uuid4().hex
        safe_name = f"{doc_id}{ext}"
        path = pack_dir / safe_name
        path.write_bytes(await f.read())
        manifest.append({
            "id": doc_id,
            "filename": f.filename,
            "path": safe_name,
        })
    if not manifest:
        shutil.rmtree(pack_dir, ignore_errors=True)
        raise HTTPException(400, "No valid PDF or TXT files uploaded")
    _save_pack_manifest(listing_id, manifest)
    listing = {
        "id": listing_id,
        "name": name,
        "description": (description or "").strip(),
        "logo_url": (logo_url or "").strip(),
        "price": float(price),
        "mcp_server_url": "",
        "listing_type": "knowledge_pack",
        "role_prompt": "",
        "image_id": "",
        "voice_id": "",
        "knowledge_pack_file_count": len(manifest),
        "created_by": current_user["id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    listings = load_listings()
    listings.append(listing)
    save_listings(listings)
    return listing


@app.put("/api/admin/marketplace/{listing_id}")
def update_listing(listing_id: str, body: ListingUpdate, current_user: dict = Depends(get_current_admin)):
    listings = load_listings()
    for i, l in enumerate(listings):
        if l.get("id") == listing_id:
            prev_type = _listing_type(l)
            if body.listing_type is not None:
                new_t = (body.listing_type or "").strip() or "integration"
                if prev_type == "knowledge_pack" and new_t != "knowledge_pack":
                    raise HTTPException(400, "Cannot change listing_type of a knowledge pack")
                if prev_type != "knowledge_pack" and new_t == "knowledge_pack":
                    raise HTTPException(400, "Use POST /api/admin/marketplace/knowledge-pack to create knowledge packs")
            if body.name is not None:
                listings[i]["name"] = body.name.strip()
            if body.description is not None:
                listings[i]["description"] = body.description.strip()
            if body.logo_url is not None:
                listings[i]["logo_url"] = body.logo_url.strip()
            if body.price is not None:
                listings[i]["price"] = body.price
            if body.mcp_server_url is not None:
                listings[i]["mcp_server_url"] = body.mcp_server_url.strip()
            if body.listing_type is not None:
                listings[i]["listing_type"] = body.listing_type.strip() or "integration"
            if body.role_prompt is not None:
                listings[i]["role_prompt"] = body.role_prompt.strip()
            if body.image_id is not None:
                listings[i]["image_id"] = body.image_id.strip()
            if body.voice_id is not None:
                listings[i]["voice_id"] = body.voice_id.strip()
            save_listings(listings)
            return listings[i]
    raise HTTPException(404, "Listing not found")


@app.delete("/api/admin/marketplace/{listing_id}")
def delete_listing(listing_id: str, current_user: dict = Depends(get_current_admin)):
    listings = load_listings()
    new_listings = [l for l in listings if l.get("id") != listing_id]
    if len(new_listings) == len(listings):
        raise HTTPException(404, "Listing not found")
    save_listings(new_listings)
    pack_dir = _kb_pack_dir(listing_id)
    if pack_dir.is_dir():
        shutil.rmtree(pack_dir, ignore_errors=True)
    return {"ok": True}


@app.post("/api/marketplace/{listing_id}/purchase")
def purchase_listing(listing_id: str, current_user: dict = Depends(get_current_user)):
    """Mock purchase: record that this user owns this listing."""
    listing = get_listing(listing_id)
    if not listing:
        raise HTTPException(404, "Listing not found")
    purchases = load_purchases()
    if any(p["user_id"] == current_user["id"] and p["listing_id"] == listing_id for p in purchases):
        return {"ok": True, "already_owned": True}
    purchases.append({
        "id": uuid.uuid4().hex,
        "user_id": current_user["id"],
        "listing_id": listing_id,
        "purchased_at": datetime.now(timezone.utc).isoformat(),
        "mock": True,
    })
    save_purchases(purchases)
    return {"ok": True, "already_owned": False}


@app.get("/api/me/purchases")
def my_purchases(current_user: dict = Depends(get_current_user)):
    """Return listings the current user has purchased."""
    return {"purchases": get_user_purchases(current_user["id"])}


@app.get("/api/personas")
def list_personas(current_user: dict = Depends(get_current_user)):
    """List personas belonging to the authenticated user."""
    personas = [p for p in load_personas() if p.get("user_id") == current_user["id"]]
    return {"personas": personas}


@app.get("/api/personas/{persona_id}")
def get_persona_endpoint(persona_id: str, current_user: dict = Depends(get_current_user)):
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    return p


@app.get("/api/personas/{persona_id}/ditto-cache")
def persona_ditto_cache_status(persona_id: str, current_user: dict = Depends(get_current_user)):
    """Proxy to Ditto: is this persona's face source_info already cached in GPU memory?"""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    image_id = p.get("image_id")
    if not image_id:
        return {"cached": False}
    url = f"{DITTO_API_URL}/personas/{image_id}/cached"
    try:
        with httpx.Client(timeout=5.0) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.json()
    except httpx.HTTPError as e:
        log.warning("Ditto ditto-cache check failed: %s", e)
        return {"cached": False}


@app.post("/api/personas/{persona_id}/prime")
def persona_prime(persona_id: str, current_user: dict = Depends(get_current_user)):
    """Proxy to Ditto: warm source_info cache before the first video clip."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    image_id = p.get("image_id")
    if not image_id:
        raise HTTPException(400, "Persona has no image_id")
    url = f"{DITTO_API_URL}/personas/{image_id}/prime"
    try:
        with httpx.Client(timeout=12.0) as client:
            r = client.post(url)
            r.raise_for_status()
            return r.json()
    except httpx.HTTPStatusError as e:
        log.warning("Ditto prime failed: %s %s", e.response.status_code, e.response.text)
        raise HTTPException(502, "Ditto prime failed") from e
    except httpx.HTTPError as e:
        log.warning("Ditto prime error: %s", e)
        raise HTTPException(502, "Ditto unreachable") from e


@app.post("/api/personas/{persona_id}/share")
def create_share_link(persona_id: str, request: Request, current_user: dict = Depends(get_current_user)):
    """Create or return a shareable link for a persona owned by the user."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    if not p.get("share_id"):
        p["share_id"] = secrets.token_urlsafe(12)
        personas = load_personas()
        for i, x in enumerate(personas):
            if x.get("id") == persona_id:
                personas[i] = p
                break
        save_personas(personas)
    base = str(request.base_url).rstrip("/")
    return {"share_id": p["share_id"], "url": f"{base}/p/{p['share_id']}"}


@app.get("/api/share/{share_id}")
def get_shared_persona(share_id: str):
    """Public: fetch limited persona info by share_id."""
    p = get_persona_by_share_id(share_id)
    if not p:
        raise HTTPException(404, "Shared persona not found")
    creator = get_user_by_id(p.get("user_id", "")) or {}
    creator_name = (creator.get("name") or "").strip()
    if not creator_name:
        email = (creator.get("email") or "").strip()
        if "@" in email:
            creator_name = email.split("@", 1)[0]
        else:
            creator_name = "TwynBook user"
    return {
        "share_id": share_id,
        "persona_id": p.get("id"),
        "name": p.get("name", ""),
        "system_prompt": p.get("system_prompt", ""),
        "image_id": p.get("image_id", ""),
        "preview_url": p.get("preview_url", ""),
        "creator_name": creator_name,
    }


@app.get("/api/share/{share_id}/preview")
def get_shared_preview(share_id: str):
    """Public: proxy persona preview by share_id."""
    p = get_persona_by_share_id(share_id)
    if not p:
        raise HTTPException(404, "Shared persona not found")
    image_id = p.get("image_id")
    if not image_id:
        raise HTTPException(404, "No image_id")
    url = f"{DITTO_API_URL}/personas/{image_id}/preview"
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(url)
            r.raise_for_status()
            return Response(content=r.content, media_type=r.headers.get("content-type", "image/png"))
    except (httpx.ReadTimeout, httpx.ConnectTimeout):
        raise HTTPException(504, "Preview request timed out")
    except httpx.ConnectError:
        raise HTTPException(502, "Ditto service unreachable")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(404, "Preview not available")
        raise HTTPException(502, f"Ditto error: {e.response.text}")


@app.get("/api/share/{share_id}/idle-video")
def get_shared_idle_video(share_id: str, request: Request):
    """Public: serve idle video for a shared persona."""
    p = get_persona_by_share_id(share_id)
    if not p:
        raise HTTPException(404, "Shared persona not found")
    path = p.get("idle_video_path")
    if not path or not Path(path).is_file():
        raise HTTPException(404, "Idle video not found")
    return _video_response(request, Path(path), "video/mp4")


@app.get("/api/marketplace/{listing_id}/preview")
def get_listing_preview(listing_id: str):
    """Proxy to Ditto preview for avatar/twyn listings so the browser can load the thumbnail."""
    listing = get_listing(listing_id)
    ltype = _listing_type(listing) if listing else None
    if not listing or ltype not in ("avatar", "twyn"):
        raise HTTPException(404, "Listing not found or has no preview")
    image_id = (listing.get("image_id") or "").strip()
    if not image_id:
        raise HTTPException(404, "Avatar has no image_id")
    url = f"{DITTO_API_URL}/personas/{image_id}/preview"
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(url)
            r.raise_for_status()
            return Response(content=r.content, media_type=r.headers.get("content-type", "image/png"))
    except (httpx.ReadTimeout, httpx.ConnectTimeout) as e:
        log.warning("Ditto preview timeout for image_id=%s: %s", image_id, e)
        raise HTTPException(504, "Preview request timed out")
    except httpx.ConnectError as e:
        log.warning("Ditto unreachable for preview image_id=%s: %s", image_id, e)
        raise HTTPException(502, "Ditto service unreachable")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(404, "Preview not available")
        raise HTTPException(502, f"Ditto error: {e.response.text}")
    except Exception as e:
        log.exception("Ditto preview failed for image_id=%s", image_id)
        raise HTTPException(502, "Preview failed")


@app.get("/api/personas/{persona_id}/preview")
def get_persona_preview(persona_id: str):
    """Proxy to Ditto preview image for thumbnails (avoids CORS)."""
    p = get_persona(persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    image_id = p.get("image_id")
    if not image_id:
        raise HTTPException(404, "No image_id")
    url = f"{DITTO_API_URL}/personas/{image_id}/preview"
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.get(url)
            r.raise_for_status()
            return Response(content=r.content, media_type=r.headers.get("content-type", "image/png"))
    except (httpx.ReadTimeout, httpx.ConnectTimeout) as e:
        log.warning("Ditto preview timeout for image_id=%s (persona %s): %s", image_id, persona_id, e)
        raise HTTPException(504, "Preview request timed out")
    except httpx.ConnectError as e:
        log.warning("Ditto unreachable for preview image_id=%s (persona %s): %s", image_id, persona_id, e)
        raise HTTPException(502, "Ditto service unreachable")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            log.warning("Ditto has no preview for image_id=%s (persona %s); persona may have been removed from Ditto", image_id, persona_id)
            raise HTTPException(404, "Preview image not available (Ditto may have been reset)")
        raise HTTPException(502, f"Ditto error: {e.response.text}")
    except Exception as e:
        log.exception("Ditto preview failed for image_id=%s persona_id=%s", image_id, persona_id)
        raise HTTPException(502, "Preview failed")


@app.get("/api/personas/{persona_id}/idle-video")
def get_idle_video(persona_id: str, request: Request):
    """Serve idle video file for a persona (with Range support for streaming)."""
    p = get_persona(persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    path = p.get("idle_video_path")
    if not path or not Path(path).is_file():
        raise HTTPException(404, "Idle video not found")
    return _video_response(request, Path(path), "video/mp4")


@app.put("/api/personas/{persona_id}")
def update_persona(persona_id: str, body: PersonaUpdate, current_user: dict = Depends(get_current_user)):
    """Update persona name and/or system_prompt and/or assigned_role_pack_id (stored locally only)."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    if body.name is not None:
        p["name"] = (body.name or "").strip() or p["name"]
    if body.system_prompt is not None:
        p["system_prompt"] = (body.system_prompt or "").strip()
    if body.assigned_listing_ids is not None:
        owned_ids = {l["id"] for l in get_user_purchases(current_user["id"])}
        p["assigned_listing_ids"] = [lid for lid in body.assigned_listing_ids if lid in owned_ids]
    if body.assigned_role_pack_id is not None:
        owned_ids = {l["id"] for l in get_user_purchases(current_user["id"])}
        rp_id = (body.assigned_role_pack_id or "").strip() or None
        if rp_id and rp_id not in owned_ids:
            rp_id = None
        rp = get_listing(rp_id) if rp_id else None
        if rp_id and rp and _listing_type(rp) != "role_pack":
            rp_id = None
        p["assigned_role_pack_id"] = rp_id
    personas = load_personas()
    for i, x in enumerate(personas):
        if x.get("id") == persona_id:
            personas[i] = p
            break
    save_personas(personas)
    return p


@app.post("/api/personas/{persona_id}/voice-wav")
async def upload_persona_voice_wav(
    persona_id: str,
    voice: UploadFile = File(...),
    voice_ref_text: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    """Upload/replace the persona voice WAV for XTTS (does not change chatterbox voice_id)."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    voice_bytes = await voice.read()
    if not voice_bytes:
        raise HTTPException(400, "Empty voice file")
    content_type = (voice.content_type or "").lower()
    if "wav" not in content_type:
        voice_bytes = _audio_to_wav(voice_bytes, content_type)
    try:
        voice_bytes = _trim_voice_wav(voice_bytes, max_seconds=MAX_VOICE_SECONDS, min_seconds=MIN_VOICE_SECONDS)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    path = DATA_DIR / f"voice_{persona_id}.wav"
    path.write_bytes(voice_bytes)
    voice_ref_text = (voice_ref_text or "").strip() or (_stt_transcribe_wav_sync(voice_bytes) or None)
    if TTS_PROVIDER == "cosyvoice":
        try:
            voice_ref_text = _stt_transcribe_wav_sync(voice_bytes) or None
        except Exception as e:
            voice_ref_text = None
            log.warning("CosyVoice voice_ref_text STT failed: %s", e)
        if not voice_ref_text:
            raise HTTPException(400, "Voice reference transcription failed. Please re-record in a quiet environment and read the script clearly.")
    personas = load_personas()
    for i, item in enumerate(personas):
        if item.get("id") == persona_id:
            personas[i]["voice_wav_path"] = str(path)
            personas[i]["voice_ref_text"] = voice_ref_text
            p = personas[i]
            break
    save_personas(personas)
    try:
        _ensure_greeting_cached(p)
    except Exception:
        pass
    if TTS_PROVIDER == "cosyvoice" and p.get("voice_wav_path"):
        if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE:
            _cosyvoice_cache_speaker_triton(str(persona_id), str(p["voice_wav_path"]), p.get("voice_ref_text"))
        else:
            if p.get("voice_ref_text"):
                _cosyvoice_register_speaker(str(persona_id), str(p["voice_wav_path"]), p.get("voice_ref_text"))
    return {"ok": True, "voice_wav_path": str(path), "voice_ref_text": voice_ref_text}


@app.post("/api/personas/{persona_id}/publish")
def publish_persona(persona_id: str, body: PersonaPublish, current_user: dict = Depends(get_current_user)):
    """Publish a user's persona to the marketplace as a twyn listing."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    listings = load_listings()
    existing_id = p.get("marketplace_listing_id")
    if existing_id:
        for i, l in enumerate(listings):
            if l.get("id") == existing_id:
                listings[i]["price"] = body.price
                listings[i]["name"] = p["name"]
                listings[i]["description"] = (p.get("system_prompt") or "").strip()
                break
        save_listings(listings)
        listing_id = existing_id
    else:
        listing_id = str(uuid.uuid4())
        listings.append({
            "id": listing_id,
            "name": p["name"],
            "description": (p.get("system_prompt") or "").strip(),
            "price": body.price,
            "listing_type": "twyn",
            "persona_id": persona_id,
            "image_id": p.get("image_id", ""),
            "owner_user_id": current_user["id"],
        })
        save_listings(listings)
    personas = load_personas()
    for i, x in enumerate(personas):
        if x.get("id") == persona_id:
            personas[i]["published"] = True
            personas[i]["marketplace_price"] = body.price
            personas[i]["marketplace_listing_id"] = listing_id
            p = personas[i]
            break
    save_personas(personas)
    return p


@app.post("/api/personas/{persona_id}/unpublish")
def unpublish_persona(persona_id: str, current_user: dict = Depends(get_current_user)):
    """Remove a persona's marketplace listing."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    listing_id = p.get("marketplace_listing_id")
    if listing_id:
        listings = load_listings()
        save_listings([l for l in listings if l.get("id") != listing_id])
    personas = load_personas()
    for i, x in enumerate(personas):
        if x.get("id") == persona_id:
            personas[i]["published"] = False
            personas[i].pop("marketplace_listing_id", None)
            personas[i].pop("marketplace_price", None)
            p = personas[i]
            break
    save_personas(personas)
    return p


@app.get("/api/personas/{persona_id}/documents")
def list_persona_documents(persona_id: str, current_user: dict = Depends(get_current_user)):
    """List knowledge base documents for this persona (scoped by ownership)."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    docs = _load_persona_docs(persona_id)
    return {"documents": docs}


@app.post("/api/personas/{persona_id}/documents")
async def upload_persona_document(
    persona_id: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    """Upload a document to the persona's knowledge base (PDF or TXT)."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    filename = (file.filename or "document").strip() or "document"
    ext = Path(filename).suffix.lower()
    if ext not in (".pdf", ".txt"):
        raise HTTPException(400, "Only PDF and TXT files are supported")
    doc_id = uuid.uuid4().hex
    kb_dir = _kb_persona_dir(persona_id)
    safe_name = f"{doc_id}{ext}"
    path = kb_dir / safe_name
    content = await file.read()
    path.write_bytes(content)
    docs = _load_persona_docs(persona_id)
    docs.append({"id": doc_id, "filename": filename, "path": safe_name, "uploaded_at": datetime.now(timezone.utc).isoformat()})
    _save_persona_docs(persona_id, docs)
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _process_document_sync, persona_id, doc_id, path, filename)
    return {"id": doc_id, "filename": filename}


@app.delete("/api/personas/{persona_id}/documents/{doc_id}")
def delete_persona_document(persona_id: str, doc_id: str, current_user: dict = Depends(get_current_user)):
    """Remove a document from the persona's knowledge base and delete its chunks."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    docs = _load_persona_docs(persona_id)
    doc = next((d for d in docs if d.get("id") == doc_id), None)
    if not doc:
        raise HTTPException(404, "Document not found")
    path = _kb_persona_dir(persona_id) / doc.get("path", "")
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass
    docs = [d for d in docs if d.get("id") != doc_id]
    _save_persona_docs(persona_id, docs)
    chunks = _load_persona_chunks(persona_id)
    chunks = [c for c in chunks if c.get("doc_id") != doc_id]
    _save_persona_chunks(persona_id, chunks)
    return {"ok": True}


def _append_knowledge_packs_to_persona_kb(
    persona_id: str,
    pack_listing_ids: list[str],
    owned: dict[str, dict],
) -> int:
    """Copy files from purchased knowledge_pack listings into persona KB; queue embedding. Returns docs added."""
    existing = _load_persona_docs(persona_id)
    kb_dir = _kb_persona_dir(persona_id)
    new_jobs: list[tuple[str, Path, str]] = []
    for lid in pack_listing_ids:
        lid = (lid or "").strip()
        if not lid or lid not in owned:
            continue
        pl = owned.get(lid) or {}
        if _listing_type(pl) != "knowledge_pack":
            continue
        for entry in _load_pack_manifest(lid):
            stored = (entry.get("path") or "").strip()
            orig_name = (entry.get("filename") or stored or "document").strip()
            if not stored:
                continue
            src = _kb_pack_dir(lid) / stored
            if not src.is_file():
                continue
            ext = Path(orig_name).suffix.lower() or Path(stored).suffix.lower()
            if ext not in (".pdf", ".txt"):
                continue
            doc_id = uuid.uuid4().hex
            safe_name = f"{doc_id}{ext}"
            dest = kb_dir / safe_name
            dest.write_bytes(src.read_bytes())
            existing.append({
                "id": doc_id,
                "filename": orig_name,
                "path": safe_name,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
                "source_knowledge_pack_id": lid,
            })
            new_jobs.append((doc_id, dest, orig_name))
    if not new_jobs:
        return 0
    _save_persona_docs(persona_id, existing)
    loop = asyncio.get_event_loop()
    for doc_id, path, filename in new_jobs:
        loop.run_in_executor(None, _process_document_sync, persona_id, doc_id, path, filename)
    return len(new_jobs)


@app.post("/api/personas/{persona_id}/knowledge-packs")
def attach_knowledge_packs_to_persona(
    persona_id: str,
    body: KnowledgePacksAttach,
    current_user: dict = Depends(get_current_user),
):
    """Attach one or more purchased knowledge packs to an existing persona (copy into KB + embed)."""
    if not get_persona(persona_id, current_user["id"]):
        raise HTTPException(404, "Persona not found")
    raw_ids = [str(x).strip() for x in (body.listing_ids or []) if x and str(x).strip()]
    if not raw_ids:
        raise HTTPException(400, "At least one knowledge pack listing id is required")
    owned = {l["id"]: l for l in get_user_purchases(current_user["id"])}
    n = _append_knowledge_packs_to_persona_kb(persona_id, raw_ids, owned)
    if n == 0:
        raise HTTPException(
            400,
            "No documents added — use purchased knowledge packs with valid files, or check listing ids.",
        )
    return {"ok": True, "documents_added": n}


@app.delete("/api/personas/{persona_id}")
def delete_persona(persona_id: str, current_user: dict = Depends(get_current_user)):
    """Remove persona from store and delete its idle/reply video files."""
    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")
    personas = load_personas()
    personas = [x for x in personas if x.get("id") != persona_id]
    save_personas(personas)
    # Clean up marketplace listing if published
    listing_id = p.get("marketplace_listing_id")
    if listing_id:
        listings = load_listings()
        save_listings([l for l in listings if l.get("id") != listing_id])
    # Clean up idle video
    idle_path = p.get("idle_video_path")
    if idle_path and Path(idle_path).is_file():
        try:
            os.unlink(idle_path)
        except OSError:
            log.warning("Could not delete idle video %s", idle_path)
    # Clean up reply videos for this persona
    for f in DATA_DIR.glob(f"reply_{persona_id}_*.mp4"):
        try:
            f.unlink()
        except OSError:
            log.warning("Could not delete reply video %s", f)
    return {"ok": True}


def _ditto_create_persona(image: bytes, persona_name: str) -> dict:
    """POST /personas to Ditto; returns {image_id, persona_name, preview_url}."""
    url = f"{DITTO_API_URL}/personas"
    with httpx.Client(timeout=60.0) as client:
        files = {"image": ("face.png", image, "image/png")}
        data = {"persona_name": persona_name}
        r = client.post(url, files=files, data=data)
        r.raise_for_status()
        return r.json()


def _wav_to_16k_float32_mono(wav_bytes: bytes) -> bytes:
    """Convert WAV bytes to 16 kHz, mono, float32 [-1, 1] for Ditto streaming API."""
    import soundfile as sf
    import numpy as np
    from scipy.signal import resample

    if not wav_bytes or len(wav_bytes) < 44:
        raise ValueError("WAV data too short (missing header or empty)")
    bio = io.BytesIO(wav_bytes)
    data, sr = sf.read(bio, dtype="float32", always_2d=False)
    if data.size == 0:
        raise ValueError("WAV has no samples")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if data.dtype != np.float32:
        data = data.astype(np.float32)
    np.clip(data, -1.0, 1.0, out=data)
    if sr != 16000:
        n_out = int(round(len(data) * 16000 / sr))
        data = resample(data, n_out).astype(np.float32)
    out = data.astype(np.float32).tobytes()
    log.info("WAV conversion: %s input bytes -> %s samples @ %s Hz -> %s float32 bytes", len(wav_bytes), len(data), 16000, len(out))
    return out


def _audio_to_wav_ffmpeg(data: bytes, ext: str) -> bytes:
    """Convert to WAV using ffmpeg subprocess (fallback when pydub unavailable)."""
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as inp:
        inp.write(data)
        inpath = inp.name
    outpath = inpath + ".wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", inpath, "-acodec", "pcm_s16le", "-ar", "22050", outpath],
            check=True,
            capture_output=True,
            timeout=60,
        )
        with open(outpath, "rb") as f:
            return f.read()
    finally:
        for p in (inpath, outpath):
            if os.path.exists(p):
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _trim_voice_wav(wav_bytes: bytes, max_seconds: float = 20.0, min_seconds: float = 15.0) -> bytes:
    """Trim WAV to at most max_seconds, validate min_seconds and speech ratio."""
    try:
        with io.BytesIO(wav_bytes) as bio:
            with wave.open(bio, "rb") as r:
                params = r.getparams()
                duration = params.nframes / params.framerate if params.framerate else 0.0
                if duration < min_seconds:
                    raise ValueError(f"Voice sample too short: {duration:.1f}s (min {min_seconds}s)")
                max_frames = int(params.framerate * max_seconds)
                if r.getnframes() <= max_frames:
                    original = wav_bytes
                else:
                    frames = r.readframes(max_frames)
                    out = io.BytesIO()
                    with wave.open(out, "wb") as w:
                        w.setparams(params)
                        w.writeframes(frames)
                    original = out.getvalue()
                    log.info("Voice WAV trimmed: %.1fs -> %.1fs (%d -> %d bytes)", params.nframes / params.framerate, max_seconds, len(wav_bytes), len(original))

        # Remove long silences and estimate speech ratio.
        cleaned = original
        speech_ratio = 1.0
        try:
            from pydub import AudioSegment, silence
            seg = AudioSegment.from_file(io.BytesIO(original), format="wav")
            nonsilent = silence.detect_nonsilent(seg, min_silence_len=200, silence_thresh=seg.dBFS - 16)
            if nonsilent:
                total_nonsilent = sum(end - start for start, end in nonsilent)
                speech_ratio = total_nonsilent / max(1, len(seg))
                # Concatenate nonsilent chunks to remove internal long pauses.
                parts = [seg[start:end] for start, end in nonsilent]
                seg = sum(parts)
                buf = io.BytesIO()
                seg.export(buf, format="wav")
                cleaned = buf.getvalue()
        except ImportError:
            # Fallback: no silence detection available.
            speech_ratio = 1.0
            cleaned = original
        except Exception as e:
            log.warning("Voice WAV silence trim failed, using original: %s", e)
            cleaned = original
            speech_ratio = 1.0

        if speech_ratio < MIN_SPEECH_RATIO:
            raise ValueError(f"Voice sample too silent: speech ratio {speech_ratio:.2f} (min {MIN_SPEECH_RATIO})")

        return cleaned
    except Exception as e:
        log.warning("_trim_voice_wav failed: %s", e)
        raise


def _audio_to_wav(data: bytes, content_type: str) -> bytes:
    """Convert browser-recorded audio (e.g. webm) to WAV for Chatterbox/Ditto."""
    content_type = (content_type or "").lower()
    ext = "webm" if "webm" in content_type else "ogg" if "ogg" in content_type else "mp3" if "mpeg" in content_type or "mp3" in content_type else "webm"
    # Try pydub first (preferred)
    try:
        from pydub import AudioSegment
        fmt = "webm" if ext == "webm" else "ogg" if ext == "ogg" else "mp3"
        seg = AudioSegment.from_file(io.BytesIO(data), format=fmt)
        buf = io.BytesIO()
        seg.export(buf, format="wav")
        return buf.getvalue()
    except ImportError:
        log.info("pydub not available, trying ffmpeg for webm→wav")
    except Exception as e:
        log.warning("pydub conversion failed (%s), trying ffmpeg", e)
    # Fallback: ffmpeg (installed in Docker image)
    try:
        return _audio_to_wav_ffmpeg(data, ext)
    except (FileNotFoundError, subprocess.CalledProcessError, OSError) as e:
        log.exception("ffmpeg conversion failed")
        raise HTTPException(400, "Could not convert voice to WAV. Rebuild the Docker image so the container includes ffmpeg (and optionally pydub).") from e


def _start_tts_stream_to_audio_queue(
    voice_id: str,
    text: str,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
    video_mode: bool = False,
) -> None:
    """Stream Chatterbox TTS into ffmpeg and push 16kHz float32 chunks into an asyncio queue.

    Uses GET /api/tts/pcm when CB_TTS_RAW_PCM=1 (lower latency than WAV container).
    Pre/post silence pads apply only in video_mode (Ditto clip boundary smoothing).
    """
    text_clean = (text or "").strip()[:TTS_MAX_CHARS]
    use_pcm = bool(CB_TTS_RAW_PCM and (CHATTERBOX_BASE_URL or "").strip())
    if use_pcm:
        url = f"{CHATTERBOX_BASE_URL.rstrip('/')}/api/tts/pcm"
        params: dict = {"voice_id": voice_id, "text": text_clean}
    else:
        url = f"{CHATTERBOX_BASE_URL.rstrip('/')}/api/tts/stream"
        params = {"voice_id": voice_id, "text": text_clean, "format": "wav"}
    gain = float(os.environ.get("AUDIO_GAIN", "1.0") or 1.0)
    t0 = time.monotonic()
    ff_base = ["ffmpeg", "-loglevel", "error"]
    if CB_FFMPEG_LOW_LATENCY:
        ff_base.extend(["-fflags", "nobuffer", "-flags", "low_delay"])
    chunk_sz = CB_HTTP_CHUNK_SIZE

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None
    proc: subprocess.Popen | None = None
    reader: threading.Thread | None = None

    def _silence_f32_bytes(ms: int, sr: int = 16000) -> bytes:
        if not ms or ms <= 0:
            return b""
        import numpy as np
        n = int(sr * (ms / 1000.0))
        if n <= 0:
            return b""
        return (np.zeros(n, dtype=np.float32)).tobytes()

    def _read_stdout():
        assert proc is not None
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                if gain != 1.0:
                    try:
                        arr = np.frombuffer(data, dtype=np.float32)
                        if arr.size:
                            arr = np.clip(arr * gain, -1.0, 1.0)
                            data = arr.astype(np.float32, copy=False).tobytes()
                    except Exception:
                        pass
                _put(data)
        except Exception:
            pass

    try:
        with httpx.Client(timeout=60.0) as client:
            with client.stream("GET", url, params=params) as r:
                try:
                    r.raise_for_status()
                except httpx.HTTPStatusError as e:
                    body = ""
                    try:
                        body = (e.response.text or "")[:800]
                    except Exception:
                        pass
                    log.error(
                        "Chatterbox TTS failed HTTP %s voice_id=%s text_len=%s body=%s",
                        e.response.status_code,
                        voice_id,
                        len(text_clean),
                        body or "(no body)",
                    )
                    raise
                status_code = r.status_code
                content_type = r.headers.get("content-type")
                if use_pcm:
                    try:
                        sr_in = int(r.headers.get("x-sample-rate") or "24000")
                    except ValueError:
                        sr_in = 24000
                    try:
                        ch_in = int(r.headers.get("x-channels") or "1")
                    except ValueError:
                        ch_in = 1
                    bits = int(r.headers.get("x-bits-per-sample") or "16")
                    if bits != 16:
                        log.warning("Chatterbox PCM unexpected x-bits-per-sample=%s; assuming s16le", bits)
                    proc = subprocess.Popen(
                        ff_base
                        + [
                            "-f",
                            "s16le",
                            "-ar",
                            str(sr_in),
                            "-ac",
                            str(ch_in),
                            "-i",
                            "pipe:0",
                            "-f",
                            "f32le",
                            "-ar",
                            "16000",
                            "-ac",
                            "1",
                            "pipe:1",
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                else:
                    ff_cmd = list(ff_base)
                    if CB_FFMPEG_LOW_LATENCY:
                        ff_cmd.extend(["-probesize", "32", "-analyzeduration", "0"])
                    ff_cmd.extend(["-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"])
                    proc = subprocess.Popen(
                        ff_cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                reader = threading.Thread(target=_read_stdout, daemon=True)
                reader.start()
                if video_mode:
                    pre = _silence_f32_bytes(DITTO_SILENCE_PRE_MS)
                    if pre:
                        _put(pre)
                try:
                    for chunk in r.iter_bytes(chunk_size=chunk_sz):
                        if not chunk:
                            continue
                        total_in += len(chunk)
                        if proc.stdin:
                            proc.stdin.write(chunk)
                finally:
                    try:
                        if proc.stdin:
                            proc.stdin.close()
                    except Exception:
                        pass
                    if reader:
                        reader.join(timeout=5)
                    try:
                        proc.wait(timeout=10)
                    except Exception:
                        pass
    except Exception as e:
        log.warning("Chatterbox TTS stream error: %s", e)
    finally:
        if proc is not None:
            try:
                err = proc.stderr.read() if proc.stderr else b""
                if err:
                    log.warning("TTS ffmpeg stderr: %s", err.decode("utf-8", "replace"))
            except Exception:
                pass
        audio_seconds = total_out / float(16000 * 4) if total_out else 0.0
        total_s = time.monotonic() - t0
        rtf = (total_s / audio_seconds) if audio_seconds > 0 else None
        rtf_str = f"{rtf:.2f}" if rtf is not None else "n/a"
        log.info(
            "TTS stream stats: pcm=%s video_mode=%s status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s audio_s=%.2f total_s=%.2f rtf=%s",
            use_pcm,
            video_mode,
            status_code,
            content_type,
            total_in,
            total_out,
            len(text_clean),
            audio_seconds,
            total_s,
            rtf_str,
        )
        if total_out == 0:
            try:
                log.warning("TTS stream produced no audio; falling back to download/wav")
                wav = _chatterbox_tts_wav(voice_id, text)
                f32 = _wav_to_16k_float32_mono(wav)
                if f32:
                    _put(f32)
            except Exception:
                pass
        if video_mode:
            post = _silence_f32_bytes(DITTO_SILENCE_POST_MS)
            if post:
                _put(post)
        _put(None)


def _start_xtts_stream_to_audio_queue(voice_wav_path: str, text: str, q: "asyncio.Queue[bytes | None]", loop: asyncio.AbstractEventLoop) -> None:
    """Stream XTTS raw float32 audio and resample to 16k mono f32le."""
    if not XTTS_BASE_URL:
        return
    path = Path(voice_wav_path)
    if not path.is_file():
        return

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    # Default XTTS sample rate is 24k; override if header says otherwise.
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None
    sr = 24000

    def _read_stdout():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                _put(data)
        except Exception:
            pass

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()

    try:
        with httpx.Client(timeout=60.0) as client:
            with open(path, "rb") as f:
                files = {"speaker_wav": (path.name, f, "audio/wav")}
                data = {"text": (text or "").strip()[:TTS_MAX_CHARS], "language": XTTS_LANGUAGE}
                with client.stream("POST", f"{XTTS_BASE_URL}/api/tts/stream_raw", data=data, files=files) as r:
                    status_code = r.status_code
                    content_type = r.headers.get("content-type")
                    sr_hdr = r.headers.get("x-sample-rate", "")
                    try:
                        if sr_hdr:
                            sr = int(sr_hdr)
                    except Exception:
                        sr = 24000
                    # If sample rate differs, restart ffmpeg with correct input rate.
                    if sr != 24000:
                        try:
                            if proc.stdin:
                                proc.stdin.close()
                        except Exception:
                            pass
                        try:
                            proc.kill()
                        except Exception:
                            pass
                        proc = subprocess.Popen(
                            ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        )
                    r.raise_for_status()
                    for chunk in r.iter_bytes(chunk_size=8192):
                        if not chunk:
                            continue
                        total_in += len(chunk)
                        if proc.stdin:
                            proc.stdin.write(chunk)
    except Exception as e:
        log.warning("XTTS stream error: %s", e)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        reader.join(timeout=5)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        _put(None)

    log.info(
        "XTTS stream stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
        status_code, content_type, total_in, total_out, len((text or "").strip()),
    )


def _start_f5_stream_to_audio_queue(
    voice_wav_path: str,
    voice_ref_text: str | None,
    text: str,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Stream F5-TTS raw float32 audio and resample to 16k mono f32le."""
    if not F5_TTS_BASE_URL:
        return
    path = Path(voice_wav_path)
    if not path.is_file():
        return

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None
    sr = 24000

    def _read_stdout():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                _put(data)
        except Exception:
            pass

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()

    try:
        with httpx.Client(timeout=60.0) as client:
            with open(path, "rb") as f:
                files = {"speaker_wav": (path.name, f, "audio/wav")}
                data = {
                    "text": (text or "").strip()[:TTS_MAX_CHARS],
                    "ref_text": (voice_ref_text or "").strip(),
                }
                with client.stream("POST", f"{F5_TTS_BASE_URL}/api/tts/stream_raw", data=data, files=files) as r:
                    status_code = r.status_code
                    content_type = r.headers.get("content-type")
                    sr_hdr = r.headers.get("x-sample-rate", "")
                    try:
                        if sr_hdr:
                            sr = int(sr_hdr)
                    except Exception:
                        sr = 24000
                    if sr != 24000:
                        try:
                            if proc.stdin:
                                proc.stdin.close()
                        except Exception:
                            pass
                        try:
                            proc.kill()
                        except Exception:
                            pass
                        proc = subprocess.Popen(
                            ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        )
                    r.raise_for_status()
                    for chunk in r.iter_bytes(chunk_size=8192):
                        if not chunk:
                            continue
                        total_in += len(chunk)
                        if proc.stdin:
                            proc.stdin.write(chunk)
    except Exception as e:
        log.warning("F5-TTS stream error: %s", e)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        reader.join(timeout=5)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        _put(None)

    log.info(
        "F5-TTS stream stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
        status_code, content_type, total_in, total_out, len((text or "").strip()),
    )


def _start_qwen3_stream_to_audio_queue(
    voice_id: str,
    text: str,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Stream Qwen3-TTS voice-cloning API: GET /api/v1/tts/stream (s16le 24 kHz) -> 16 kHz mono f32le."""
    if not QWEN3_TTS_BASE_URL or not (voice_id or "").strip():
        return
    t0 = time.monotonic()

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    # API: raw 16-bit PCM mono at 24 kHz (see service OpenAPI).
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None
    first_chunk_at = None
    params = {
        "voice_id": voice_id.strip(),
        "text": (text or "").strip()[:TTS_MAX_CHARS],
    }
    if QWEN3_TTS_LANGUAGE:
        params["language"] = QWEN3_TTS_LANGUAGE
    url = f"{QWEN3_TTS_BASE_URL}/api/v1/tts/stream"

    def _read_stdout():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                _put(data)
        except Exception:
            pass

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()

    try:
        with httpx.Client(timeout=120.0) as client:
            with client.stream("GET", url, params=params) as r:
                status_code = r.status_code
                content_type = r.headers.get("content-type")
                r.raise_for_status()
                for chunk in r.iter_bytes(chunk_size=8192):
                    if not chunk:
                        continue
                    if first_chunk_at is None:
                        first_chunk_at = time.monotonic()
                        log.info("Qwen3-TTS first_chunk at +%.2fs", first_chunk_at - t0)
                    total_in += len(chunk)
                    if proc.stdin:
                        proc.stdin.write(chunk)
    except Exception as e:
        log.warning("Qwen3-TTS stream error: %s", e)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        reader.join(timeout=5)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        _put(None)

    log.info(
        "Qwen3-TTS stream stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
        status_code, content_type, total_in, total_out, len((text or "").strip()),
    )
    log.info("Qwen3-TTS stream done total=+%.2fs", time.monotonic() - t0)


def _resample_to_f32_16k(audio: np.ndarray, sr_in: int) -> bytes:
    """Resample audio to 16 kHz and return normalized float32 bytes."""
    from scipy.signal import resample

    # Normalize if int16
    if audio.dtype == np.int16:
        audio = audio.astype(np.float32) / 32768.0
    elif audio.dtype != np.float32:
        audio = audio.astype(np.float32)

    if sr_in != 16000:
        n_out = int(round(len(audio) * 16000 / sr_in))
        audio = resample(audio, n_out).astype(np.float32)
    return audio.astype(np.float32, copy=False).tobytes()


def _start_cosyvoice_triton_to_audio_queue(
    voice_id: str | None,
    voice_wav_path: str,
    voice_ref_text: str | None,
    text: str,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Call Triton gRPC streaming for CosyVoice2 and stream f32le 16k audio to queue."""
    if not COSYVOICE_TRITON_URL:
        return
    path = Path(voice_wav_path)
    if not path.is_file():
        return

    def _put(item: bytes | None):
        nonlocal first_chunk_at
        if item and first_chunk_at is None:
            first_chunk_at = time.monotonic()
            log.info("CosyVoice Triton: first_audio_chunk at +%.2fs", first_chunk_at - t0)
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    use_ref = True
    if COSYVOICE_USE_CACHE and voice_id:
        use_ref = voice_id not in COSYVOICE_SPK_CACHE
    if COSYVOICE_USE_CACHE and voice_id:
        log.info("CosyVoice Triton: cache %s for spk_id=%s", "MISS" if use_ref else "HIT", voice_id)

    ref_f32 = None
    ref_text = ""
    if use_ref:
        try:
            with open(path, "rb") as f:
                wav_bytes = f.read()
        except OSError:
            return

        # Triton expects 16k float32 mono reference audio.
        try:
            ref_f32 = np.frombuffer(_wav_to_16k_float32_mono(wav_bytes), dtype=np.float32)
        except Exception as e:
            log.warning("CosyVoice Triton: ref wav load failed: %s", e)
            return

        ref_text = (voice_ref_text or "").strip()
        if not ref_text:
            try:
                ref_text = _stt_transcribe_wav_sync(wav_bytes) or ""
                if ref_text:
                    log.info("CosyVoice Triton: derived ref_text from STT (%d chars)", len(ref_text))
            except Exception as e:
                log.warning("CosyVoice Triton: STT ref_text failed: %s", e)
        # On cache MISS we must provide a real prompt text to build a good speaker cache.
        # We keep it short to reduce leakage.
        if COSYVOICE_REF_TEXT_MODE in ("none", "off", "false", "0"):
            ref_text = ""
        elif COSYVOICE_REF_TEXT_MODE in ("short", "first"):
            # Keep a short prompt to avoid leakage into outputs.
            # Use first sentence or first 80 chars.
            m = re.split(r"(?<=[.!?])\\s+", ref_text) if ref_text else []
            ref_text = (m[0] if m else ref_text)[:80]
        if COSYVOICE_PROMPT_MAX_CHARS > 0:
            ref_text = ref_text[:COSYVOICE_PROMPT_MAX_CHARS]

    import tritonclient.grpc as grpcclient
    from tritonclient.grpc import InferInput, InferRequestedOutput

    server = COSYVOICE_TRITON_URL
    if server.startswith("http://"):
        server = server[len("http://") :]
    if server.startswith("https://"):
        server = server[len("https://") :]

    out_bytes_total = 0
    done = threading.Event()
    t0 = time.monotonic()
    first_chunk_at: float | None = None

    try:
        client = grpcclient.InferenceServerClient(server, verbose=False)
        log.info(
            "CosyVoice Triton: %s request to %s model=%s text_len=%s",
            "offline" if COSYVOICE_TRITON_OFFLINE else "streaming",
            server,
            COSYVOICE_TRITON_MODEL,
            len((text or "").strip()),
        )

        inputs = []
        if use_ref and ref_f32 is not None:
            i_ref = InferInput("reference_wav", [1, ref_f32.shape[0]], "FP32")
            i_ref.set_data_from_numpy(ref_f32.reshape(1, -1))
            inputs.append(i_ref)

            i_len = InferInput("reference_wav_len", [1, 1], "INT32")
            i_len.set_data_from_numpy(np.array([[int(ref_f32.shape[0])]], dtype=np.int32))
            inputs.append(i_len)

            i_ref_text = InferInput("reference_text", [1, 1], "BYTES")
            i_ref_text.set_data_from_numpy(np.array([[ref_text.encode("utf-8")]], dtype=object))
            inputs.append(i_ref_text)

        # Only send speaker_id on cache HIT to avoid confusing Triton on first-time reference runs.
        if COSYVOICE_USE_CACHE and voice_id and not use_ref:
            i_spk = InferInput("speaker_id", [1, 1], "BYTES")
            i_spk.set_data_from_numpy(np.array([[str(voice_id).encode("utf-8")]], dtype=object))
            inputs.append(i_spk)

        target_text = (text or "").strip()[:TTS_MAX_CHARS]
        i_tgt_text = InferInput("target_text", [1, 1], "BYTES")
        i_tgt_text.set_data_from_numpy(np.array([[target_text.encode("utf-8")]], dtype=object))
        inputs.append(i_tgt_text)

        outputs = [InferRequestedOutput("waveform")]

        if COSYVOICE_TRITON_OFFLINE:
            result = client.infer(
                model_name=COSYVOICE_TRITON_MODEL,
                inputs=inputs,
                outputs=outputs,
            )
            log.info("CosyVoice Triton offline: audio_shape=%s dtype=%s min=%.3f max=%.3f", audio.shape, audio.dtype, np.min(audio) if audio.size else 0, np.max(audio) if audio.size else 0)
            audio = audio.reshape(-1)
            out_bytes = _resample_to_f32_16k(audio, 24000)
            out_bytes_total += len(out_bytes)
            chunk = 65536
            for i in range(0, len(out_bytes), chunk):
                _put(out_bytes[i : i + chunk])
            _put(None)
            log.info(
                "CosyVoice Triton offline stats: in_ref_samples=%s out_bytes=%s text_len=%s total_s=%.2f",
                ref_f32.shape[0] if ref_f32 is not None else 0, out_bytes_total, len((text or "").strip()), time.monotonic() - t0,
            )
            if COSYVOICE_USE_CACHE and use_ref and voice_id:
                COSYVOICE_SPK_CACHE.add(str(voice_id))
            done.set()
            return

        def _cb(result, error):
            nonlocal out_bytes_total
            if error:
                log.warning("CosyVoice Triton stream error: %s", error)
                done.set()
                return
            try:
                params = result.get_response().parameters
                final = bool(params.get("triton_final_response").bool_param) if params else False
            except Exception:
                final = False
            try:
                audio = result.as_numpy("waveform")
                if audio is not None:
                    if out_bytes_total == 0:
                        log.info("CosyVoice Triton stream: first_chunk_shape=%s dtype=%s min=%.3f max=%.3f", audio.shape, audio.dtype, np.min(audio) if audio.size else 0, np.max(audio) if audio.size else 0)
                    audio = audio.reshape(-1)
                    out_bytes = _resample_to_f32_16k(audio, 24000)
                    out_bytes_total += len(out_bytes)
                    chunk = 65536
                    for i in range(0, len(out_bytes), chunk):
                        _put(out_bytes[i : i + chunk])
            except Exception as e:
                if final:
                    log.warning("CosyVoice Triton final response had no waveform: %s", e)
                    done.set()
                    return
                log.warning("CosyVoice Triton response parse error: %s", e)
                done.set()
                return

            if final:
                done.set()

        log.info("CosyVoice Triton: start_stream")
        client.start_stream(callback=_cb, stream_timeout=60)
        log.info("CosyVoice Triton: async_stream_infer")
        client.async_stream_infer(
            model_name=COSYVOICE_TRITON_MODEL,
            inputs=inputs,
            outputs=outputs,
            enable_empty_final_response=True,
        )
        done.wait(timeout=60)
        log.info("CosyVoice Triton: done_wait finished (set=%s)", done.is_set())
        client.stop_stream()

        _put(None)
        log.info(
            "CosyVoice Triton stats: in_ref_samples=%s out_bytes=%s text_len=%s total_s=%.2f",
            ref_f32.shape[0] if ref_f32 is not None else 0, out_bytes_total, len((text or "").strip()), time.monotonic() - t0,
        )
        if COSYVOICE_USE_CACHE and use_ref and voice_id:
            COSYVOICE_SPK_CACHE.add(str(voice_id))
    except Exception as e:
        log.warning("CosyVoice Triton infer error: %s", e)
        return
    finally:
        if not done.is_set():
            log.warning("CosyVoice Triton: timed out waiting for final response after %.2fs", time.monotonic() - t0)


def _start_cosyvoice_stream_to_audio_queue(
    voice_wav_path: str,
    voice_ref_text: str | None,
    text: str,
    spk_id: str | None,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Stream CosyVoice raw int16 audio and resample to 16k mono f32le."""
    if COSYVOICE_USE_TRITON and COSYVOICE_TRITON_URL:
        _start_cosyvoice_triton_to_audio_queue(spk_id, voice_wav_path, voice_ref_text, text, q, loop)
        return
    if not COSYVOICE_BASE_URL:
        return
    path = Path(voice_wav_path)
    if not path.is_file():
        return

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    # CosyVoice returns raw int16 at 24kHz (CosyVoice2 sample_rate=24000)
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None

    def _read_stdout():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                _put(data)
        except Exception:
            pass

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()

    try:
        with httpx.Client(timeout=60.0) as client:
            with open(path, "rb") as f:
                files = {"prompt_wav": (path.name, f, "audio/wav")}
                prompt_text = (voice_ref_text or "").strip() or (text or "").strip()[:TTS_MAX_CHARS]
                if COSYVOICE_PROMPT_MAX_CHARS > 0:
                    prompt_text = prompt_text[:COSYVOICE_PROMPT_MAX_CHARS]
                if COSYVOICE_USE_SFT and spk_id and spk_id != "qwen3":
                    data = {
                        "tts_text": (text or "").strip()[:TTS_MAX_CHARS],
                        "spk_id": spk_id,
                        "speed": str(COSYVOICE_SPEED),
                    }
                    with client.stream("POST", f"{COSYVOICE_BASE_URL}/inference_sft", data=data) as r:
                        status_code = r.status_code
                        content_type = r.headers.get("content-type")
                        r.raise_for_status()
                        for chunk in r.iter_bytes(chunk_size=8192):
                            if not chunk:
                                continue
                            total_in += len(chunk)
                            if proc.stdin:
                                proc.stdin.write(chunk)
                else:
                    data = {
                        "tts_text": (text or "").strip()[:TTS_MAX_CHARS],
                        "speed": str(COSYVOICE_SPEED),
                    }
                    if spk_id:
                        data["spk_id"] = spk_id
                    # Prefer registered speaker to avoid re-sending prompt audio each time.
                    if COSYVOICE_USE_REGISTERED_SPK and spk_id:
                        data["prompt_text"] = ""
                        try:
                            with client.stream("POST", f"{COSYVOICE_BASE_URL}/inference_zero_shot", data=data) as r:
                                status_code = r.status_code
                                content_type = r.headers.get("content-type")
                                r.raise_for_status()
                                for chunk in r.iter_bytes(chunk_size=8192):
                                    if not chunk:
                                        continue
                                    total_in += len(chunk)
                                    if proc.stdin:
                                        proc.stdin.write(chunk)
                            r = None
                        except Exception:
                            # Fall back to zero-shot with prompt_wav if server doesn't have cached spk_id.
                            data["prompt_text"] = prompt_text
                            with client.stream("POST", f"{COSYVOICE_BASE_URL}/inference_zero_shot", data=data, files=files) as r:
                                status_code = r.status_code
                                content_type = r.headers.get("content-type")
                                r.raise_for_status()
                                for chunk in r.iter_bytes(chunk_size=8192):
                                    if not chunk:
                                        continue
                                    total_in += len(chunk)
                                    if proc.stdin:
                                        proc.stdin.write(chunk)
                    else:
                        data["prompt_text"] = prompt_text
                        with client.stream("POST", f"{COSYVOICE_BASE_URL}/inference_zero_shot", data=data, files=files) as r:
                            status_code = r.status_code
                            content_type = r.headers.get("content-type")
                            r.raise_for_status()
                            for chunk in r.iter_bytes(chunk_size=8192):
                                if not chunk:
                                    continue
                                total_in += len(chunk)
                                if proc.stdin:
                                    proc.stdin.write(chunk)
    except Exception as e:
        log.warning("CosyVoice stream error: %s", e)
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        reader.join(timeout=5)
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        _put(None)

    log.info(
        "CosyVoice stream stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
        status_code, content_type, total_in, total_out, len((text or "").strip()),
    )


def _cosyvoice_register_speaker(spk_id: str, voice_wav_path: str, voice_ref_text: str | None) -> None:
    if not COSYVOICE_BASE_URL:
        return
    path = Path(voice_wav_path)
    if not path.is_file():
        return
    try:
        with httpx.Client(timeout=30.0) as client:
            if COSYVOICE_USE_SFT:
                with open(path, "rb") as f:
                    files = {"prompt_wav": (path.name, f, "audio/wav")}
                    data = {"spk_id": spk_id}
                    r = client.post(f"{COSYVOICE_BASE_URL}/register_sft_spk", data=data, files=files)
                    if r.status_code >= 400:
                        log.warning("CosyVoice register_sft_spk failed status=%s body=%s", r.status_code, r.text[:200])
            prompt_text = (voice_ref_text or "").strip()
            if prompt_text:
                if COSYVOICE_PROMPT_MAX_CHARS > 0:
                    prompt_text = prompt_text[:COSYVOICE_PROMPT_MAX_CHARS]
                with open(path, "rb") as f:
                    files = {"prompt_wav": (path.name, f, "audio/wav")}
                    data = {"prompt_text": prompt_text, "spk_id": spk_id}
                    r = client.post(f"{COSYVOICE_BASE_URL}/register_spk", data=data, files=files)
                    if r.status_code >= 400:
                        log.warning("CosyVoice register_spk failed status=%s body=%s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("CosyVoice register_spk error: %s", e)


def _cosyvoice_cache_speaker_triton(spk_id: str, voice_wav_path: str, voice_ref_text: str | None = None) -> bool:
    """Warm CosyVoice2 Triton cache for a speaker (stores spk2info on server)."""
    if not (COSYVOICE_USE_TRITON and COSYVOICE_TRITON_URL and COSYVOICE_USE_CACHE):
        return False
    if not spk_id or spk_id in COSYVOICE_SPK_CACHE:
        return True
    path = Path(voice_wav_path)
    if not path.is_file():
        return False

    try:
        wav_bytes = path.read_bytes()
        ref_f32 = np.frombuffer(_wav_to_16k_float32_mono(wav_bytes), dtype=np.float32)
    except Exception as e:
        log.warning("CosyVoice cache: ref wav load failed for spk_id=%s: %s", spk_id, e)
        return False

    # Always provide ref_text to build a high-quality cached speaker.
    ref_text = (voice_ref_text or "").strip()
    if not ref_text:
        try:
            ref_text = _stt_transcribe_wav_sync(wav_bytes) or ""
            if ref_text:
                log.info("CosyVoice cache: derived ref_text from STT (%d chars)", len(ref_text))
        except Exception as e:
            log.warning("CosyVoice cache: STT ref_text failed: %s", e)
    if COSYVOICE_REF_TEXT_MODE in ("none", "off", "false", "0"):
        ref_text = ""
    elif COSYVOICE_REF_TEXT_MODE in ("short", "first"):
        m = re.split(r"(?<=[.!?])\\s+", ref_text) if ref_text else []
        ref_text = (m[0] if m else ref_text)[:80]
    if COSYVOICE_PROMPT_MAX_CHARS > 0:
        ref_text = ref_text[:COSYVOICE_PROMPT_MAX_CHARS]

    import tritonclient.grpc as grpcclient
    from tritonclient.grpc import InferInput

    server = COSYVOICE_TRITON_URL
    if server.startswith("http://"):
        server = server[len("http://") :]
    if server.startswith("https://"):
        server = server[len("https://") :]

    try:
        client = grpcclient.InferenceServerClient(server, verbose=False)
        inputs = []
        i_ref = InferInput("reference_wav", [1, ref_f32.shape[0]], "FP32")
        i_ref.set_data_from_numpy(ref_f32.reshape(1, -1))
        inputs.append(i_ref)

        i_len = InferInput("reference_wav_len", [1, 1], "INT32")
        i_len.set_data_from_numpy(np.array([[int(ref_f32.shape[0])]], dtype=np.int32))
        inputs.append(i_len)

        if ref_text:
            i_ref_text = InferInput("reference_text", [1, 1], "BYTES")
            i_ref_text.set_data_from_numpy(np.array([[ref_text.encode("utf-8")]], dtype=object))
            inputs.append(i_ref_text)

        i_spk = InferInput("speaker_id", [1, 1], "BYTES")
        i_spk.set_data_from_numpy(np.array([[str(spk_id).encode("utf-8")]], dtype=object))
        inputs.append(i_spk)

        warm_text = (COSYVOICE_CACHE_WARMUP_TEXT or "Hello.").strip() or "Hello."
        i_tgt_text = InferInput("target_text", [1, 1], "BYTES")
        i_tgt_text.set_data_from_numpy(np.array([[warm_text.encode("utf-8")]], dtype=object))
        inputs.append(i_tgt_text)

        client.infer(model_name=COSYVOICE_TRITON_MODEL, inputs=inputs)
        COSYVOICE_SPK_CACHE.add(spk_id)
        log.info("CosyVoice cache: warmed spk_id=%s", spk_id)
        return True
    except Exception as e:
        log.warning("CosyVoice cache warm error for spk_id=%s: %s", spk_id, e)
        return False


def _cosyvoice_cache_all_personas() -> None:
    """Warm CosyVoice2 Triton cache for all personas with voice WAVs."""
    try:
        personas = load_personas()
        warmed = 0
        for p in personas:
            voice_wav_path = (p.get("voice_wav_path") or "").strip()
            if not voice_wav_path or not Path(voice_wav_path).is_file():
                continue
            spk_id = p.get("id") or ""
            if _cosyvoice_cache_speaker_triton(str(spk_id), voice_wav_path, p.get("voice_ref_text")):
                warmed += 1
        log.info("CosyVoice cache: warmed %s personas", warmed)
    except Exception as e:
        log.warning("CosyVoice cache all failed: %s", e)


def _render_f5_greeting_to_file(persona: dict) -> Path | None:
    """Generate and cache a short greeting clip for the persona using F5."""
    if TTS_PROVIDER != "f5" or not F5_TTS_BASE_URL:
        return None
    voice_wav_path = persona.get("voice_wav_path")
    if not voice_wav_path or not Path(voice_wav_path).is_file():
        return None
    greet_path = DATA_DIR / f"greeting_{persona.get('id')}.f32"
    if greet_path.is_file():
        return greet_path
    text = f"Hey, I'm {persona.get('name') or 'your assistant'}."
    voice_ref_text = (persona.get("voice_ref_text") or "").strip()

    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    buf = bytearray()
    total_in = total_out = 0
    sr = 24000
    try:
        with httpx.Client(timeout=30.0) as client:
            with open(voice_wav_path, "rb") as f:
                files = {"speaker_wav": (Path(voice_wav_path).name, f, "audio/wav")}
                data = {"text": text[:TTS_MAX_CHARS], "ref_text": voice_ref_text}
                with client.stream("POST", f"{F5_TTS_BASE_URL}/api/tts/stream_raw", data=data, files=files) as r:
                    sr_hdr = r.headers.get("x-sample-rate", "")
                    try:
                        if sr_hdr:
                            sr = int(sr_hdr)
                    except Exception:
                        sr = 24000
                    if sr != 24000:
                        if proc.stdin:
                            proc.stdin.close()
                        try:
                            proc.kill()
                        except Exception:
                            pass
                        proc = subprocess.Popen(
                            ["ffmpeg", "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0", "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        )
                    for chunk in r.iter_bytes(chunk_size=8192):
                        if not chunk:
                            continue
                        total_in += len(chunk)
                        if proc.stdin:
                            proc.stdin.write(chunk)
                    if proc.stdin:
                        proc.stdin.close()
                    if proc.stdout:
                        buf.extend(proc.stdout.read())
    except Exception as e:
        log.warning("F5 greeting render failed: %s", e)
        return None
    finally:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    if buf:
        try:
            greet_path.write_bytes(buf)
            log.info("Greeting cached for persona %s (%s bytes)", persona.get("id"), len(buf))
            return greet_path
        except Exception as e:
            log.warning("Failed to write greeting cache: %s", e)
    return None


def _ensure_greeting_cached(persona: dict) -> Path | None:
    """Return greeting path; generate if missing."""
    greet_path = DATA_DIR / f"greeting_{persona.get('id')}.f32"
    if greet_path.is_file():
        return greet_path
    return _render_f5_greeting_to_file(persona)

def _chatterbox_voice_exists(voice_id: str) -> bool:
    """True if this voice_id is registered in Chatterbox (MongoDB)."""
    if not voice_id or not (CHATTERBOX_BASE_URL or "").strip():
        return False
    url = f"{CHATTERBOX_BASE_URL.rstrip('/')}/api/voices/{voice_id}"
    try:
        r = httpx.get(url, timeout=15.0)
        return r.status_code == 200
    except Exception as e:
        log.debug("Chatterbox voice lookup failed for %s: %s", voice_id, e)
        return False


def _ensure_chatterbox_voice_id(persona: dict) -> str:
    """Ensure Chatterbox has a usable voice_id; re-clone from voice_wav_path if missing or stale."""
    if TTS_PROVIDER != "chatterbox":
        return (persona.get("voice_id") or "").strip()
    pid = (persona.get("id") or "").strip()
    voice_id = (persona.get("voice_id") or "").strip()
    voice_wav_path = persona.get("voice_wav_path") or ""
    path = Path(voice_wav_path) if voice_wav_path else None

    if voice_id and _chatterbox_voice_exists(voice_id):
        return voice_id

    if voice_id:
        log.warning(
            "Chatterbox voice_id %s not found on TTS service (DB reset or new server); re-cloning if WAV exists (persona %s)",
            voice_id,
            pid,
        )

    if not path or not path.is_file():
        if voice_id:
            log.warning("Cannot re-clone Chatterbox voice for persona %s: missing or invalid voice_wav_path", pid)
        return voice_id

    try:
        audio = path.read_bytes()
        new_id = _chatterbox_clone_voice(audio, persona.get("name") or pid)
        if new_id:
            persona["voice_id"] = new_id
            try:
                personas = load_personas()
                for p in personas:
                    if p.get("id") == pid:
                        p["voice_id"] = new_id
                        break
                save_personas(personas)
            except Exception as e:
                log.warning("Failed to persist chatterbox voice_id for %s: %s", pid, e)
            log.info("Chatterbox re-cloned voice for persona %s -> voice_id %s", pid, new_id)
            return new_id
    except Exception as e:
        log.warning("Chatterbox re-clone failed for %s: %s", pid, e)
    return voice_id


def _qwen3_voice_exists(voice_id: str) -> bool:
    """True if voice_id is registered on the Qwen3-TTS voice-cloning service."""
    if not voice_id or not QWEN3_TTS_BASE_URL:
        return False
    url = f"{QWEN3_TTS_BASE_URL}/api/v1/voices/{voice_id}"
    try:
        r = httpx.get(url, timeout=15.0)
        return r.status_code == 200
    except Exception as e:
        log.debug("Qwen3-TTS voice lookup failed for %s: %s", voice_id, e)
        return False


def _qwen3_register_voice(
    audio_bytes: bytes,
    name: str,
    ref_text: str | None = None,
    user_id: str = "twynbook",
) -> str:
    """POST /api/v1/voices/register; returns voice_id from JSON (201)."""
    url = f"{QWEN3_TTS_BASE_URL}/api/v1/voices/register"
    data = {
        "name": (name or "Voice")[:200],
        "user_id": user_id,
        "description": (name or "")[:500],
        "ref_text": (ref_text or "").strip()[:4000],
    }
    if QWEN3_TTS_LANGUAGE:
        data["language"] = QWEN3_TTS_LANGUAGE
    with httpx.Client(timeout=300.0) as client:
        files = {"audio_file": ("voice.wav", audio_bytes, "audio/wav")}
        r = client.post(url, files=files, data=data)
        r.raise_for_status()
        out = r.json() if r.content else {}
        vid = (out.get("voice_id") or "").strip()
        if not vid:
            raise ValueError("Qwen3-TTS register response missing voice_id")
        return vid


def _ensure_qwen3_voice_id(persona: dict) -> str:
    """Ensure Qwen3-TTS has a registered voice_id; re-register from voice_wav_path if missing or stale."""
    if TTS_PROVIDER != "qwen3":
        return (persona.get("voice_id") or "").strip()
    pid = (persona.get("id") or "").strip()
    voice_id = (persona.get("voice_id") or "").strip()
    voice_wav_path = persona.get("voice_wav_path") or ""
    path = Path(voice_wav_path) if voice_wav_path else None

    # Legacy placeholder from old integration (per-utterance WAV upload).
    if voice_id == "qwen3":
        voice_id = ""
        persona["voice_id"] = ""

    if voice_id and _qwen3_voice_exists(voice_id):
        return voice_id

    if voice_id:
        log.warning(
            "Qwen3-TTS voice_id %s not found on TTS service; re-registering if WAV exists (persona %s)",
            voice_id,
            pid,
        )

    if not path or not path.is_file():
        if voice_id:
            log.warning("Cannot re-register Qwen3 voice for persona %s: missing or invalid voice_wav_path", pid)
        return voice_id

    try:
        audio = path.read_bytes()
        ref_text = (persona.get("voice_ref_text") or "").strip() or None
        new_id = _qwen3_register_voice(audio, persona.get("name") or pid, ref_text)
        if new_id:
            persona["voice_id"] = new_id
            try:
                personas = load_personas()
                for p in personas:
                    if p.get("id") == pid:
                        p["voice_id"] = new_id
                        break
                save_personas(personas)
            except Exception as e:
                log.warning("Failed to persist Qwen3 voice_id for %s: %s", pid, e)
            log.info("Qwen3-TTS registered voice for persona %s -> voice_id %s", pid, new_id)
            return new_id
    except Exception as e:
        log.warning("Qwen3-TTS re-register failed for %s: %s", pid, e)
    return voice_id


def _load_greeting_bytes(persona_id: str) -> bytes | None:
    path = DATA_DIR / f"greeting_{persona_id}.f32"
    if path.is_file():
        try:
            return path.read_bytes()
        except Exception:
            return None
    return None


def _start_audio_tts_stream_to_queue(
    voice_id: str,
    voice_wav_path: str | None,
    voice_ref_text: str | None,
    text: str,
    q: "asyncio.Queue[bytes | None]",
    loop: asyncio.AbstractEventLoop,
    video_mode: bool = False,
) -> None:
    log.info("Audio TTS: provider=%s voice_wav=%s video_mode=%s", TTS_PROVIDER, bool(voice_wav_path), video_mode)
    if TTS_PROVIDER == "xtts" and voice_wav_path and XTTS_BASE_URL:
        _start_xtts_stream_to_audio_queue(voice_wav_path, text, q, loop)
        return
    if TTS_PROVIDER == "f5" and voice_wav_path and F5_TTS_BASE_URL:
        _start_f5_stream_to_audio_queue(voice_wav_path, voice_ref_text, text, q, loop)
        return
    if TTS_PROVIDER == "qwen3" and (voice_id or "").strip() and QWEN3_TTS_BASE_URL:
        _start_qwen3_stream_to_audio_queue(voice_id, text, q, loop)
        return
    if TTS_PROVIDER == "cosyvoice" and voice_wav_path and (COSYVOICE_USE_TRITON or COSYVOICE_BASE_URL):
        _start_cosyvoice_stream_to_audio_queue(voice_wav_path, voice_ref_text, text, voice_id, q, loop)
        return
    _start_tts_stream_to_audio_queue(voice_id, text, q, loop, video_mode)


def _start_tts_stream_to_mp4_audio_queue(voice_id: str, text: str, q: "asyncio.Queue[bytes | None]", loop: asyncio.AbstractEventLoop, out: dict | None = None) -> None:
    """Stream TTS audio into ffmpeg and push fragmented MP4 (AAC) chunks into a queue."""
    if out is None:
        out = {}
    url = f"{CHATTERBOX_BASE_URL}/api/tts/stream"
    params = {
        "voice_id": voice_id,
        "text": (text or "").strip()[:TTS_MAX_CHARS],
        "format": "wav",
    }
    proc = subprocess.Popen(
        [
            "ffmpeg", "-loglevel", "error", "-i", "pipe:0",
            "-ac", "1", "-ar", "16000",
            "-c:a", "aac", "-b:a", "96k",
            "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "pipe:1",
        ],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    def _put(item: bytes | None):
        fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
        fut.result()

    total_out = 0
    total_in = 0
    status_code = None
    content_type = None

    def _read_stdout():
        try:
            while True:
                data = proc.stdout.read(65536)
                if not data:
                    break
                nonlocal total_out
                total_out += len(data)
                _put(data)
        except Exception:
            pass

    reader = threading.Thread(target=_read_stdout, daemon=True)
    reader.start()

    try:
        with httpx.Client(timeout=60.0) as client:
            with client.stream("GET", url, params=params) as r:
                r.raise_for_status()
                status_code = r.status_code
                content_type = r.headers.get("content-type")
                for chunk in r.iter_bytes(chunk_size=8192):
                    if not chunk:
                        continue
                    total_in += len(chunk)
                    if proc.stdin:
                        proc.stdin.write(chunk)
        if proc.stdin:
            proc.stdin.close()
        reader.join(timeout=5)
        proc.wait(timeout=10)
    except Exception as e:
        out["error"] = str(e)
    finally:
        try:
            err = proc.stderr.read() if proc.stderr else b""
            if err:
                log.warning("TTS audio ffmpeg stderr: %s", err.decode("utf-8", "replace"))
        except Exception:
            pass
        log.info(
            "TTS audio stream stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
            status_code, content_type, total_in, total_out, len((text or "").strip()),
        )
        if total_out == 0 and "error" not in out:
            out["error"] = "TTS audio stream produced no output"
        _put(None)


def _start_tts_wav_to_holder(
    voice_id: str,
    voice_wav_path: str | None,
    voice_ref_text: str | None,
    text: str,
    out: dict,
) -> None:
    """Fetch full WAV from TTS and store in out['wav']."""
    if not text or not text.strip():
        out["error"] = "Empty TTS text"
        return

    if TTS_PROVIDER == "qwen3":
        if not QWEN3_TTS_BASE_URL:
            out["error"] = "Qwen3-TTS not configured (missing QWEN3_TTS_BASE_URL)"
            return
        if not (voice_id or "").strip():
            out["error"] = "Qwen3-TTS requires a registered voice_id; re-save the persona or check voice registration"
            return

        t0 = time.monotonic()
        proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "wav", "-ar", "16000", "-ac", "1", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        buf = bytearray()
        total_in = 0
        status_code = None
        content_type = None
        params = {
            "voice_id": voice_id.strip(),
            "text": (text or "").strip()[:TTS_MAX_CHARS],
        }
        if QWEN3_TTS_LANGUAGE:
            params["language"] = QWEN3_TTS_LANGUAGE
        url = f"{QWEN3_TTS_BASE_URL}/api/v1/tts/wav"

        def _read_stdout():
            try:
                while True:
                    data = proc.stdout.read(65536)
                    if not data:
                        break
                    buf.extend(data)
            except Exception:
                pass

        reader = threading.Thread(target=_read_stdout, daemon=True)
        reader.start()
        try:
            with httpx.Client(timeout=120.0) as client:
                with client.stream("GET", url, params=params) as r:
                    status_code = r.status_code
                    content_type = r.headers.get("content-type")
                    first_chunk_at = None
                    r.raise_for_status()
                    for chunk in r.iter_bytes(chunk_size=8192):
                        if not chunk:
                            continue
                        if first_chunk_at is None:
                            first_chunk_at = time.monotonic()
                            log.info("Qwen3-TTS wav first_chunk at +%.2fs", first_chunk_at - t0)
                        total_in += len(chunk)
                        if proc.stdin:
                            proc.stdin.write(chunk)
            if proc.stdin:
                proc.stdin.close()
            reader.join(timeout=5)
            proc.wait(timeout=10)
        except Exception as e:
            out["error"] = str(e)
        finally:
            try:
                err = proc.stderr.read() if proc.stderr else b""
                if err:
                    log.warning("Qwen3-TTS wav ffmpeg stderr: %s", err.decode("utf-8", "replace"))
            except Exception:
                pass
            log.info(
                "Qwen3-TTS wav stats: status=%s content_type=%s in_bytes=%s out_bytes=%s text_len=%s",
                status_code, content_type, total_in, len(buf), len((text or "").strip()),
            )
            log.info("Qwen3-TTS wav done total=+%.2fs", time.monotonic() - t0)
            if not buf and "error" not in out:
                out["error"] = "Qwen3-TTS wav produced no audio"
            out["wav"] = bytes(buf)
        return

    try:
        out["wav"] = _chatterbox_tts_wav(voice_id, text)
    except Exception as e:
        out["error"] = str(e)


def _chatterbox_clone_voice(audio: bytes, voice_name: str, user_id: str = "twynbook") -> str:
    """POST /api/voices/clone; returns voice_id."""
    url = f"{CHATTERBOX_BASE_URL}/api/voices/clone"
    voice_id = str(uuid.uuid4())
    with httpx.Client(timeout=120.0) as client:
        files = {"audio_file": ("recording.wav", audio, "audio/wav")}
        data = {
            "voice_id": voice_id,
            "user_id": user_id,
            "voice_name": voice_name,
            "voice_description": voice_name,
        }
        r = client.post(url, files=files, data=data)
        r.raise_for_status()
        out = r.json() if r.content else {}
        return out.get("voice_id") or voice_id


def _is_wav_bytes(data: bytes) -> bool:
    """True if data looks like a WAV file (RIFF header, at least 44 bytes)."""
    return len(data) >= 44 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _chatterbox_tts_wav(voice_id: str, text: str) -> bytes:
    """TTS WAV: try streaming (GET /api/tts/wav), fallback to download/wav. Truncates to TTS limit."""
    if not text or not text.strip():
        raise ValueError("TTS text is empty")
    text = text.strip()[:TTS_MAX_CHARS]
    params = {"voice_id": voice_id, "text": text}
    with httpx.Client(timeout=60.0) as client:
        try:
            with client.stream("GET", f"{CHATTERBOX_BASE_URL}/api/tts/wav", params=params) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                for chunk in response.iter_bytes(chunk_size=8192):
                    if chunk:
                        chunks.append(chunk)
                out = b"".join(chunks)
                if not _is_wav_bytes(out):
                    log.warning("TTS stream response is not WAV (len=%s, head=%s); using download fallback", len(out), out[:12] if len(out) >= 12 else out)
                    raise ValueError("Stream response not WAV")
                log.info("TTS stream OK: %s bytes WAV for text len %s", len(out), len(text))
                return out
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError):
            pass
        r = client.get(f"{CHATTERBOX_BASE_URL}/api/tts/download/wav", params=params)
        r.raise_for_status()
        out = r.content
        if not _is_wav_bytes(out):
            raise ValueError(f"TTS download returned non-WAV (len={len(out)}, head={out[:12]!r})")
        log.info("TTS download OK: %s bytes WAV for text len %s", len(out), len(text))
        return out


@app.post("/api/personas/create")
async def create_persona(
    name: str = Form(...),
    system_prompt: str = Form(""),
    voice_ref_text: str = Form(""),
    face: UploadFile = File(None),
    voice: UploadFile = File(None),
    avatar_listing_id: str = Form(""),
    assigned_role_pack_id: str = Form(""),
    assigned_listing_ids: str = Form(""),
    knowledge_pack_ids: str = Form(""),
    documents: list[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_user),
):
    """
    Accept persona creation and return 202 immediately. Either provide avatar_listing_id (purchased
    avatar: use its image_id and voice_id) or upload face + voice. Optional assigned_role_pack_id,
    assigned_listing_ids (JSON array of integration listing IDs), knowledge_pack_ids (JSON array of
    purchased knowledge_pack listing IDs — files are copied into the persona KB), and documents
    (PDF/TXT uploads). Creation runs in the background so nginx doesn't timeout.
    """
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    avatar_id = (avatar_listing_id or "").strip()
    role_pack_id = (assigned_role_pack_id or "").strip() or None
    owned = {l["id"]: l for l in get_user_purchases(current_user["id"])}
    tool_ids_raw = (assigned_listing_ids or "").strip()
    assigned_tool_ids: list[str] = []
    if tool_ids_raw:
        try:
            parsed = json.loads(tool_ids_raw)
            if isinstance(parsed, list):
                assigned_tool_ids = [str(x).strip() for x in parsed if x and str(x).strip() in owned and _listing_type(owned.get(str(x).strip()) or {}) == "integration"]
        except (json.JSONDecodeError, TypeError):
            pass

    persona_id = uuid.uuid4().hex
    creation_status[persona_id] = "creating"

    docs_meta: list[dict] = []
    kb_dir: Path | None = None

    pack_ids_raw = (knowledge_pack_ids or "").strip()
    if pack_ids_raw:
        try:
            parsed_packs = json.loads(pack_ids_raw)
            if isinstance(parsed_packs, list):
                for pid in parsed_packs:
                    pid = str(pid).strip()
                    if not pid or pid not in owned:
                        continue
                    pl = owned.get(pid) or {}
                    if _listing_type(pl) != "knowledge_pack":
                        continue
                    for entry in _load_pack_manifest(pid):
                        stored = (entry.get("path") or "").strip()
                        orig_name = (entry.get("filename") or stored or "document").strip()
                        if not stored:
                            continue
                        src = _kb_pack_dir(pid) / stored
                        if not src.is_file():
                            continue
                        ext = Path(orig_name).suffix.lower() or Path(stored).suffix.lower()
                        if ext not in (".pdf", ".txt"):
                            continue
                        if kb_dir is None:
                            kb_dir = _kb_persona_dir(persona_id)
                        doc_id = uuid.uuid4().hex
                        safe_name = f"{doc_id}{ext}"
                        dest = kb_dir / safe_name
                        dest.write_bytes(src.read_bytes())
                        docs_meta.append({
                            "id": doc_id,
                            "filename": orig_name,
                            "path": safe_name,
                            "uploaded_at": datetime.now(timezone.utc).isoformat(),
                            "source_knowledge_pack_id": pid,
                        })
        except (json.JSONDecodeError, TypeError):
            pass

    if documents:
        if kb_dir is None:
            kb_dir = _kb_persona_dir(persona_id)
        for f in documents:
            if not f.filename:
                continue
            ext = Path(f.filename).suffix.lower()
            if ext not in (".pdf", ".txt"):
                continue
            doc_id = uuid.uuid4().hex
            safe_name = f"{doc_id}{ext}"
            path = kb_dir / safe_name
            content = await f.read()
            path.write_bytes(content)
            docs_meta.append({
                "id": doc_id,
                "filename": f.filename,
                "path": safe_name,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
            })
    if docs_meta:
        _save_persona_docs(persona_id, docs_meta)

    if avatar_id:
        if avatar_id not in owned:
            raise HTTPException(400, "Avatar listing not purchased or not found")
        av = get_listing(avatar_id)
        if not av or _listing_type(av) != "avatar":
            raise HTTPException(400, "Listing is not an avatar")
        image_id = (av.get("image_id") or "").strip()
        voice_id = (av.get("voice_id") or "").strip()
        if not image_id or not voice_id:
            raise HTTPException(400, "Avatar listing has no image_id or voice_id")
        face_bytes = None
        voice_bytes = None
        use_avatar_listing = True
    else:
        if not face or not voice:
            raise HTTPException(400, "Either provide avatar_listing_id or upload face and voice")
        face_bytes = await face.read()
        voice_bytes = await voice.read()
        content_type = (voice.content_type or "").lower()
        if "wav" not in content_type:
            voice_bytes = _audio_to_wav(voice_bytes, content_type)
        image_id = voice_id = None
        use_avatar_listing = False

    if role_pack_id and (role_pack_id not in owned or _listing_type(owned.get(role_pack_id) or {}) != "role_pack"):
        role_pack_id = None

    loop = asyncio.get_event_loop()
    loop.run_in_executor(
        None,
        _create_persona_sync,
        persona_id,
        name,
        (system_prompt or "").strip(),
        face_bytes,
        voice_bytes,
        current_user["id"],
        image_id,
        voice_id,
        (voice_ref_text or "").strip(),
        role_pack_id,
        assigned_tool_ids,
    )
    return JSONResponse(status_code=202, content={"id": persona_id, "status": "creating"})


@app.get("/api/personas/create/status/{persona_id}")
def get_creation_status(persona_id: str, current_user: dict = Depends(get_current_user)):
    """Return creation status: ready (persona exists), creating, or failed with error."""
    if get_persona(persona_id) is not None:
        if persona_id in creation_status:
            del creation_status[persona_id]
        return {"status": "ready"}
    if persona_id in creation_status:
        val = creation_status[persona_id]
        if val == "creating":
            return {"status": "creating"}
        if isinstance(val, dict) and val.get("status") == "failed":
            return {"status": "failed", "error": val.get("error", "Creation failed")}
    return {"status": "creating"}


def _create_persona_sync(
    persona_id: str,
    name: str,
    system_prompt: str,
    face_bytes: bytes | None,
    voice_bytes: bytes | None,
    user_id: str = "",
    avatar_image_id: str | None = None,
    avatar_voice_id: str | None = None,
    voice_ref_text_in: str | None = None,
    assigned_role_pack_id: str | None = None,
    assigned_listing_ids: list[str] | None = None,
) -> None:
    """Run in thread: Ditto (or use avatar), Chatterbox (or use avatar), 30s idle video, save. Logs errors; sets creation_status on failure."""
    log.info("Background create: starting persona_id=%s name=%s", persona_id, name)
    if avatar_image_id and avatar_voice_id:
        image_id = avatar_image_id
        preview_url = f"{DITTO_API_URL}/personas/{image_id}/preview"
        voice_id = avatar_voice_id
        voice_wav_path = None
        voice_ref_text = None
        try:
            listing = get_listing(avatar_image_id) or {}
            listing_wav = (listing.get("voice_wav_path") or "").strip()
            if listing_wav:
                src = Path(listing_wav)
                if src.is_file():
                    dest = DATA_DIR / f"voice_{persona_id}.wav"
                    dest.write_bytes(src.read_bytes())
                    voice_wav_path = dest
            voice_ref_text = (listing.get("voice_ref_text") or "").strip() or None
            if voice_ref_text is None and voice_wav_path and Path(voice_wav_path).is_file():
                try:
                    voice_ref_text = _stt_transcribe_wav_sync(Path(voice_wav_path).read_bytes()) or None
                except Exception:
                    voice_ref_text = None
        except Exception:
            pass
        log.info("Background create: using avatar image_id=%s voice_id=%s", image_id, voice_id)
        if TTS_PROVIDER == "cosyvoice" and voice_wav_path:
            if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE:
                _cosyvoice_cache_speaker_triton(str(voice_id), str(voice_wav_path), voice_ref_text)
            else:
                if voice_ref_text:
                    _cosyvoice_register_speaker(voice_id, str(voice_wav_path), voice_ref_text)
    else:
        try:
            ditto_persona = _ditto_create_persona(face_bytes, name)
        except Exception as e:
            log.exception("Background create: Ditto failed for persona_id=%s: %s", persona_id, e)
            creation_status[persona_id] = {"status": "failed", "error": str(e)}
            return
        image_id = ditto_persona["image_id"]
        preview_url = ditto_persona.get("preview_url") or f"{DITTO_API_URL}/personas/{image_id}/preview"
        log.info("Background create: Ditto OK persona_id=%s image_id=%s", persona_id, image_id)
        try:
            voice_wav_path = DATA_DIR / f"voice_{persona_id}.wav"
            if voice_bytes:
                voice_bytes = _trim_voice_wav(voice_bytes, max_seconds=MAX_VOICE_SECONDS, min_seconds=MIN_VOICE_SECONDS)
                voice_wav_path.write_bytes(voice_bytes)
            if TTS_PROVIDER == "cosyvoice":
                # CosyVoice uses the raw WAV directly; no Chatterbox clone needed.
                voice_id = persona_id
                log.info("Background create: cosyvoice voice OK persona_id=%s", persona_id)
            elif TTS_PROVIDER == "qwen3":
                if not QWEN3_TTS_BASE_URL:
                    creation_status[persona_id] = {"status": "failed", "error": "Qwen3-TTS not configured (missing QWEN3_TTS_BASE_URL)"}
                    return
                ref_for_reg = (voice_ref_text_in or "").strip() or None
                if not ref_for_reg:
                    try:
                        ref_for_reg = _stt_transcribe_wav_sync(voice_bytes) or None
                    except Exception as e:
                        log.warning("Background create: qwen3 ref_text STT failed: %s", e)
                        ref_for_reg = None
                try:
                    voice_id = _qwen3_register_voice(voice_bytes, name, ref_for_reg)
                    log.info("Background create: qwen3 registered persona_id=%s voice_id=%s", persona_id, voice_id)
                except Exception as e:
                    log.exception("Background create: Qwen3 register failed persona_id=%s: %s", persona_id, e)
                    creation_status[persona_id] = {"status": "failed", "error": f"Qwen3 voice register failed: {e}"}
                    return
            else:
                voice_id = _chatterbox_clone_voice(voice_bytes, name)
                log.info("Background create: Chatterbox OK persona_id=%s voice_id=%s", persona_id, voice_id)
        except Exception as e:
            log.exception("Background create: Voice setup failed for persona_id=%s: %s", persona_id, e)
            creation_status[persona_id] = {"status": "failed", "error": str(e)}
            return
        voice_ref_text = (voice_ref_text_in or "").strip() or None
        if TTS_PROVIDER == "cosyvoice":
            # Force prompt text to match the actual audio by transcribing the recording.
            try:
                voice_ref_text = _stt_transcribe_wav_sync(voice_bytes) or None
            except Exception as e:
                voice_ref_text = None
                log.warning("CosyVoice voice_ref_text STT failed: %s", e)
            if not voice_ref_text:
                creation_status[persona_id] = {
                    "status": "failed",
                    "error": "Voice reference transcription failed. Please re-record in a quiet environment and read the script clearly.",
                }
                return
        if TTS_PROVIDER == "cosyvoice" and voice_wav_path:
            if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE:
                _cosyvoice_cache_speaker_triton(str(voice_id), str(voice_wav_path), voice_ref_text)
            else:
                if voice_ref_text:
                    _cosyvoice_register_speaker(voice_id, str(voice_wav_path), voice_ref_text)
    # Idle video: 30s silence via POST /generate only (streaming is for chat reply clips)
    idle_path = DATA_DIR / f"idle_{persona_id}.mp4"
    idle_path_resolved = None
    for attempt in range(2):
        try:
            silence_wav = _make_silence_wav(30.0)
            ditto_generate_post(image_id, silence_wav, str(idle_path))
            if idle_path.is_file():
                idle_path_resolved = idle_path
                log.info("Idle video created (30s) for persona %s", persona_id)
                break
        except Exception as e:
            log.warning("Idle video attempt %s failed for %s: %s", attempt + 1, persona_id, e)
            if attempt == 0:
                time.sleep(10)
    persona = {
        "id": persona_id,
        "user_id": user_id,
        "name": name,
        "image_id": image_id,
        "voice_id": voice_id,
        "voice_wav_path": str(voice_wav_path) if voice_wav_path else None,
        "voice_ref_text": voice_ref_text,
        "system_prompt": system_prompt,
        "preview_url": preview_url,
        "idle_video_path": str(idle_path_resolved) if idle_path_resolved else None,
        "conversation": [],
        "assigned_role_pack_id": assigned_role_pack_id or None,
        "assigned_listing_ids": assigned_listing_ids or [],
    }
    personas = load_personas()
    personas.append(persona)
    save_personas(personas)
    try:
        _ensure_greeting_cached(persona)
    except Exception:
        pass
    if persona_id in creation_status:
        del creation_status[persona_id]
    log.info("Persona %s created (idle_video=%s)", persona_id, bool(idle_path_resolved))

    # Process any knowledge base documents saved at create time
    docs = _load_persona_docs(persona_id)
    kb_dir = _kb_persona_dir(persona_id)
    for doc in docs:
        path = kb_dir / doc.get("path", "")
        if path.is_file():
            try:
                _process_document_sync(persona_id, doc["id"], path, doc.get("filename") or doc.get("path", ""))
            except Exception as e:
                log.warning("KB doc processing failed for persona_id=%s doc_id=%s: %s", persona_id, doc.get("id"), e)


async def _ditto_stream_reader(
    ws,
    video_chunks: list[bytes],
    read_error: list[Exception | None],
    segment_queue: asyncio.Queue[bytes | None] | None = None,
    input_ready: asyncio.Event | None = None,
) -> None:
    """Read WebSocket messages in background; collect video bytes after sending_video.
    If segment_queue is set, put each binary chunk there (and None when done) for Phase 2 streaming.
    When input_ready is set, it is signaled on {"status":"ready"} or on fatal error so the sender
    can start audio only after Ditto has finished setup and entered its receive loop (avoids WS deadlock).
    """
    try:
        receiving_video = False
        first_binary = True
        chunk_count = 0
        async for message in ws:
            if isinstance(message, str):
                data = json.loads(message)
                if data.get("error"):
                    read_error.append(RuntimeError(data["error"]))
                    if input_ready is not None:
                        input_ready.set()
                    if segment_queue is not None:
                        segment_queue.put_nowait(None)
                    return
                status = data.get("status", "")
                # Ditto may buffer inbound audio during sdk.setup (input_buffering); then we can send TTS
                # before "ready". Legacy servers: only "ready" means receive loop is active.
                if input_ready is not None and not input_ready.is_set():
                    if status == "ready" or (
                        status == "initializing" and data.get("input_buffering")
                    ):
                        input_ready.set()
                if status == "sending_video":
                    log.info("Ditto stream: received sending_video status")
                    receiving_video = True
                elif status == "done":
                    log.info("Ditto stream: received done status (chunks=%s)", chunk_count)
                    if segment_queue is not None:
                        segment_queue.put_nowait(None)
                    return
            elif isinstance(message, bytes):
                # Some servers may send binary before the "sending_video" status.
                if not receiving_video:
                    receiving_video = True
                if first_binary:
                    log.info("Ditto stream: first binary chunk (%s bytes)", len(message))
                    first_binary = False
                chunk_count += 1
                video_chunks.append(message)
                if segment_queue is not None:
                    segment_queue.put_nowait(message)
        log.info("Ditto stream: reader completed (chunks=%s)", chunk_count)
        if segment_queue is not None:
            segment_queue.put_nowait(None)
    except ConnectionClosed:
        if input_ready is not None:
            input_ready.set()
        if not video_chunks and not read_error:
            log.warning("Ditto stream: connection closed before sending video")
            read_error.append(RuntimeError("Ditto closed connection before sending video"))
        if segment_queue is not None:
            segment_queue.put_nowait(None)
    except Exception as e:
        if input_ready is not None:
            input_ready.set()
        log.warning("Ditto stream: reader error: %s", e)
        read_error.append(e)
        if segment_queue is not None:
            segment_queue.put_nowait(None)

async def ditto_stream_generate(
    image_id: str,
    output_path: str,
    segment_queue: asyncio.Queue[bytes | None] | None = None,
    *,
    audio_float32_16k: bytes | None = None,
    audio_queue: asyncio.Queue[bytes | None] | None = None,
    ws_base: str | None = None,
    worker_idx: int | None = None,
) -> None:
    """WebSocket to Ditto /stream: send float32 16 kHz mono audio (buffer or queue), receive fMP4, write output_path.

    Pass exactly one of ``audio_float32_16k`` (full utterance) or ``audio_queue`` (TTS chunks + trailing None).
    If ``segment_queue`` is set, each binary chunk is forwarded there for live MSE streaming.
    """
    if (audio_float32_16k is None) == (audio_queue is None):
        raise RuntimeError("Ditto stream: pass exactly one of audio_float32_16k or audio_queue")
    if audio_float32_16k is not None and not audio_float32_16k:
        raise RuntimeError("Ditto stream: no audio bytes to send")
    if ws_base is None or worker_idx is None:
        worker_idx, ws_base = _pick_ditto_worker()
    ws_url = f"{ws_base}/stream?image_id={image_id}"
    if audio_float32_16k is not None:
        log.info(
            "Ditto stream: connecting to %s (sending %s bytes, then empty binary for end)",
            ws_url,
            len(audio_float32_16k),
        )
    else:
        log.info("Ditto stream: connecting to %s (streaming audio chunks from queue)", ws_url)
    video_chunks: list[bytes] = []
    read_error: list[Exception | None] = []
    t_send0 = time.monotonic()
    lock_acquired = False
    lock = _DITTO_WS_LOCKS[worker_idx] if (worker_idx is not None and worker_idx < len(_DITTO_WS_LOCKS)) else None
    try:
        if lock:
            if lock.locked():
                log.info(
                    "Ditto stream: waiting for worker %s lock (prior clip still rendering; single Ditto GPU)",
                    worker_idx,
                )
            await lock.acquire()
            lock_acquired = True
        try:
            async with websockets.connect(
                ws_url, close_timeout=30, max_size=2**26,
                ping_interval=20, ping_timeout=120,
                open_timeout=30,
            ) as ws:
                ditto_input_ready = asyncio.Event()
                reader_task = asyncio.create_task(
                    _ditto_stream_reader(
                        ws, video_chunks, read_error, segment_queue, ditto_input_ready
                    )
                )
                try:
                    await asyncio.wait_for(ditto_input_ready.wait(), timeout=120.0)
                except asyncio.TimeoutError:
                    log.error("Ditto stream: timed out waiting for server ready (reply from %s)", ws_url)
                    raise RuntimeError("Ditto stream: server did not send status=ready within 120s") from None
                if read_error:
                    try:
                        await reader_task
                    except Exception:
                        pass
                    raise read_error[0]
                if audio_float32_16k is not None:
                    chunk_size = 65536
                    for i in range(0, len(audio_float32_16k), chunk_size):
                        await ws.send(audio_float32_16k[i : i + chunk_size])
                    await ws.send(b"")
                    log.info("Ditto stream: sent audio bytes in %.2fs", time.monotonic() - t_send0)
                else:
                    assert audio_queue is not None
                    while True:
                        chunk = await audio_queue.get()
                        if chunk is None:
                            break
                        await ws.send(chunk)
                    await ws.send(b"")

                await reader_task
                log.info("Ditto stream: reader_task completed in %.2fs", time.monotonic() - t_send0)
                if read_error:
                    raise read_error[0]
        finally:
            if lock and lock_acquired and lock.locked():
                lock.release()

        full_mp4 = b"".join(video_chunks)
        if not full_mp4:
            log.warning("Ditto stream: no video data received for %s", output_path)
        else:
            with open(output_path, "wb") as f:
                f.write(full_mp4)
            log.info("Ditto stream: wrote %s (%s bytes, %s chunks)", output_path, len(full_mp4), len(video_chunks))
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("Ditto stream failed for %s", output_path)
        raise
    finally:
        if segment_queue is not None:
            try:
                segment_queue.put_nowait(None)
            except Exception:
                pass


def ditto_generate_post(image_id: str, audio_wav_bytes: bytes, output_path: str, base_url: str | None = None) -> None:
    """POST /generate: send audio WAV + image_id, receive MP4. Used for idle video and chunked replies."""
    base = (base_url or DITTO_API_URL).rstrip("/")
    url = f"{base}/generate"
    log.info("Ditto POST /generate: %s (%s audio bytes)", url, len(audio_wav_bytes))
    with httpx.Client(timeout=httpx.Timeout(connect=30, read=600, write=30, pool=600)) as client:
        resp = client.post(
            url,
            data={"image_id": image_id},
            files={"audio": ("silence.wav", io.BytesIO(audio_wav_bytes), "audio/wav")},
        )
        resp.raise_for_status()
        with open(output_path, "wb") as f:
            f.write(resp.content)
    log.info("Ditto POST /generate: wrote %s (%s bytes)", output_path, len(resp.content))


def _make_silence_wav(duration_sec: float, sample_rate: int = 16000) -> bytes:
    """Create a WAV file with silence (16-bit PCM mono)."""
    n_samples = int(duration_sec * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_samples)
    return buf.getvalue()


def _stream_ollama_sentences_sync(
    ollama_url: str,
    ollama_model: str,
    messages: list,
    sentence_queue: "asyncio.Queue[str | None]",
    loop: asyncio.AbstractEventLoop,
    boundary_re: re.Pattern | None = None,
    split_re: re.Pattern | None = None,
    audio_chunk_max: int | None = None,
    audio_chunk_min: int | None = None,
) -> str:
    """
    Synchronous worker (runs in executor).
    Streams Ollama /api/chat with stream=true, detects completed sentences,
    puts each onto sentence_queue. Puts None when done. Returns full assistant text.
    """
    url = f"{ollama_url.rstrip('/')}/v1/chat/completions"
    payload = {"model": ollama_model, "messages": messages, "stream": True}
    content = ""
    emitted_up_to = 0
    t0 = time.monotonic()
    # Audio chunking: prefer punctuation before max chars, otherwise hard split.
    audio_chunker = bool(audio_chunk_max)
    if audio_chunker:
        audio_chunk_max = max(30, int(audio_chunk_max))
        audio_chunk_min = max(1, int(audio_chunk_min or 1))
        punct_re = re.compile(r"(?<!\d)[.!?]|(?<!\d),(?!\d)")

    def _emit_text_chunk(chunk: str):
        s = (chunk or "").strip()
        if not s:
            return
        log.info("Ollama: sentence yielded (+%.2fs, %s chars): %s", time.monotonic()-t0, len(s), s[:40])
        asyncio.run_coroutine_threadsafe(sentence_queue.put(s), loop).result()

    def _emit_audio_chunks(force_flush: bool = False):
        nonlocal emitted_up_to
        while True:
            window = content[emitted_up_to:]
            if not window:
                return
            if len(window) < audio_chunk_min and not force_flush:
                return

            cut = None
            if len(window) >= audio_chunk_max:
                # Prefer last punctuation within [min, max], otherwise hard split at max.
                last = None
                for mm in punct_re.finditer(window[:audio_chunk_max]):
                    if mm.end() >= audio_chunk_min:
                        last = mm
                cut = last.end() if last else audio_chunk_max
            else:
                # We have >= min and < max: emit at first punctuation >= min.
                for mm in punct_re.finditer(window):
                    if mm.end() >= audio_chunk_min:
                        cut = mm.end()
                        break
                if cut is None:
                    if force_flush:
                        cut = len(window)
                    else:
                        return
            _emit_text_chunk(window[:cut])
            emitted_up_to += cut

    try:
        with httpx.Client(timeout=60.0) as client_http:
            log.info("Ollama: starting stream for %s messages", len(messages))
            with client_http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line: continue
                    clean_line = line.strip()
                    if clean_line.startswith("data:"): clean_line = clean_line[5:].strip()
                    if not clean_line or clean_line == "[DONE]": continue

                    try:
                        data = json.loads(clean_line)
                    except: continue
                    
                    msg = data.get("message")
                    delta = ""
                    if isinstance(msg, dict):
                        delta = msg.get("content") or ""
                    elif "choices" in data:
                        choices = data.get("choices")
                        if choices: delta = choices[0].get("delta", {}).get("content") or ""

                    if not delta:
                        if data.get("done"): break
                        continue
                    
                    content += delta
                    if audio_chunker:
                        _emit_audio_chunks()
                    else:
                        boundary_re = boundary_re or SENTENCE_BOUNDARY_PERIOD_RE
                        split_re = split_re or SENTENCE_SPLIT_PERIOD_RE
                        # Yield sentences as they form based on provided boundary regex.
                        matches = list(boundary_re.finditer(content[emitted_up_to:]))
                        if matches:
                            last_match = matches[-1]
                            block = content[emitted_up_to : emitted_up_to + last_match.end()]
                            for s in _chunk_by_sentences(block, split_re=split_re):
                                s = s.strip()
                                if s:
                                    _emit_text_chunk(s)
                            emitted_up_to += last_match.end()
                    
                    if data.get("done"): break
        
        # Flush
        if audio_chunker:
            _emit_audio_chunks(force_flush=True)
            remaining = content[emitted_up_to:].strip()
            if remaining:
                _emit_text_chunk(remaining)
        else:
            remaining = content[emitted_up_to:].strip()
            if remaining:
                log.info("Ollama: final sentence yielded (+%.2fs): %s", time.monotonic()-t0, remaining[:40])
                asyncio.run_coroutine_threadsafe(sentence_queue.put(remaining), loop).result()
        log.info("Ollama: finished in %.2fs, total_len=%d", time.monotonic()-t0, len(content))
    except Exception as e:
        log.exception("Ollama: worker failed: %s", e)
    finally:
        asyncio.run_coroutine_threadsafe(sentence_queue.put(None), loop).result()
    return content.strip()


def _stream_openai_sentences_sync(
    client: OpenAI,
    messages: list,
    sentence_queue: "asyncio.Queue[str | None]",
    loop: asyncio.AbstractEventLoop,
    boundary_re: re.Pattern | None = None,
    split_re: re.Pattern | None = None,
) -> str:
    """
    Synchronous worker (runs in executor).
    Streams OpenAI tokens, detects completed sentences, and puts each one onto
    sentence_queue as soon as it is complete. Puts None when done.
    Returns the full assistant text.
    """
    content = ""
    emitted_up_to = 0
    t0 = time.monotonic()
    try:
        log.info("LLM: starting stream for %s messages", len(messages))
        # Support both Ollama and OpenAI patterns
        if client:
            resp = client.chat.completions.create(model="gpt-4o-mini", messages=messages, stream=True)
            for chunk in resp:
                if not chunk or not chunk.choices: continue
                delta = chunk.choices[0].delta.content
                if delta is None: continue
                content += delta
                
                boundary_re = boundary_re or SENTENCE_BOUNDARY_PERIOD_RE
                split_re = split_re or SENTENCE_SPLIT_PERIOD_RE
                # Yield sentences as they form based on provided boundary regex.
                matches = list(boundary_re.finditer(content[emitted_up_to:]))
                if matches:
                    last_match = matches[-1]
                    sentence_block = content[emitted_up_to : emitted_up_to + last_match.end()]
                    for s in _chunk_by_sentences(sentence_block, split_re=split_re):
                        s = s.strip()
                        if s:
                            log.info("LLM: sentence yielded (+%.2fs): %s", time.monotonic() - t0, s[:40])
                            asyncio.run_coroutine_threadsafe(sentence_queue.put(s), loop).result()
                    emitted_up_to += last_match.end()
        else:
            # Placeholder if we used another direct client; currently chat_stream_ws uses 'client'
            pass

        # Final flush
        remaining = content[emitted_up_to:].strip()
        if remaining:
            log.info("LLM: final sentence yielded (+%.2fs): %s", time.monotonic() - t0, remaining[:40])
            asyncio.run_coroutine_threadsafe(sentence_queue.put(remaining), loop).result()
        log.info("LLM: finished in %.2fs, total_len=%d", time.monotonic() - t0, len(content))
    except Exception as e:
        log.exception("LLM: worker failed: %s", e)
    finally:
        asyncio.run_coroutine_threadsafe(sentence_queue.put(None), loop).result()
    return content.strip()


def _stream_ollama_continuous_sync(
    ollama_url: str,
    ollama_model: str,
    messages: list,
    sentence_queue: "asyncio.Queue[str | None]",
    loop: asyncio.AbstractEventLoop,
    chunk_chars: int,
) -> str:
    """Stream Ollama tokens and emit fixed-size chunks (no sentence boundaries)."""
    url = f"{ollama_url.rstrip('/')}/v1/chat/completions"
    payload = {"model": ollama_model, "messages": messages, "stream": True}
    content = ""
    emitted_up_to = 0
    t0 = time.monotonic()
    chunk_chars = max(20, int(chunk_chars))
    try:
        with httpx.Client(timeout=60.0) as client_http:
            log.info("Ollama: starting stream for %s messages", len(messages))
            with client_http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line:
                        continue
                    clean_line = line.strip()
                    if clean_line.startswith("data:"):
                        clean_line = clean_line[5:].strip()
                    if not clean_line or clean_line == "[DONE]":
                        continue
                    try:
                        data = json.loads(clean_line)
                    except Exception:
                        continue
                    msg = data.get("message")
                    delta = ""
                    if isinstance(msg, dict):
                        delta = msg.get("content") or ""
                    elif "choices" in data:
                        choices = data.get("choices")
                        if choices:
                            delta = choices[0].get("delta", {}).get("content") or ""
                    if not delta:
                        if data.get("done"):
                            break
                        continue
                    content += delta
                    while len(content) - emitted_up_to >= chunk_chars:
                        chunk = content[emitted_up_to : emitted_up_to + chunk_chars]
                        if chunk.strip():
                            log.info("Ollama: chunk yielded (+%.2fs): %s", time.monotonic() - t0, chunk[:40])
                            asyncio.run_coroutine_threadsafe(sentence_queue.put(chunk), loop).result()
                        emitted_up_to += chunk_chars
                    if data.get("done"):
                        break
        remaining = content[emitted_up_to:]
        if remaining.strip():
            log.info("Ollama: final chunk yielded (+%.2fs): %s", time.monotonic() - t0, remaining[:40])
            asyncio.run_coroutine_threadsafe(sentence_queue.put(remaining), loop).result()
        log.info("Ollama: finished in %.2fs, total_len=%d", time.monotonic() - t0, len(content))
    except Exception as e:
        log.exception("Ollama: worker failed: %s", e)
    finally:
        asyncio.run_coroutine_threadsafe(sentence_queue.put(None), loop).result()
    return content.strip()


def _stream_openai_continuous_sync(
    client: OpenAI,
    messages: list,
    sentence_queue: "asyncio.Queue[str | None]",
    loop: asyncio.AbstractEventLoop,
    chunk_chars: int,
) -> str:
    """Stream OpenAI tokens and emit fixed-size chunks (no sentence boundaries)."""
    content = ""
    emitted_up_to = 0
    t0 = time.monotonic()
    chunk_chars = max(20, int(chunk_chars))
    try:
        log.info("LLM: starting stream for %s messages", len(messages))
        resp = client.chat.completions.create(model="gpt-4o-mini", messages=messages, stream=True)
        for chunk in resp:
            if not chunk or not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta is None:
                continue
            content += delta
            while len(content) - emitted_up_to >= chunk_chars:
                segment = content[emitted_up_to : emitted_up_to + chunk_chars]
                if segment.strip():
                    log.info("LLM: chunk yielded (+%.2fs): %s", time.monotonic() - t0, segment[:40])
                    asyncio.run_coroutine_threadsafe(sentence_queue.put(segment), loop).result()
                emitted_up_to += chunk_chars
        remaining = content[emitted_up_to:]
        if remaining.strip():
            log.info("LLM: final chunk yielded (+%.2fs): %s", time.monotonic() - t0, remaining[:40])
            asyncio.run_coroutine_threadsafe(sentence_queue.put(remaining), loop).result()
        log.info("LLM: finished in %.2fs, total_len=%d", time.monotonic() - t0, len(content))
    except Exception as e:
        log.exception("LLM: worker failed: %s", e)
    finally:
        asyncio.run_coroutine_threadsafe(sentence_queue.put(None), loop).result()
    return content.strip()


async def _await_with_keepalive(coro_or_future, keepalive_interval: float = 4.0):
    """
    Async generator: awaits coro_or_future and yields SSE keepalive strings every
    keepalive_interval seconds while waiting. Callers should get the result from the
    original future after the loop (not from this generator).
    """
    fut = asyncio.ensure_future(coro_or_future)
    while not fut.done():
        try:
            await asyncio.wait_for(asyncio.shield(fut), timeout=keepalive_interval)
            break
        except asyncio.TimeoutError:
            yield ": keepalive\n\n"
    # Trigger any exception stored in the future so callers see it via fut.result()
    fut.result()


# --- IDLE MOTION MANAGER ---
class IdleMotionManager:
    """Manages constant 'listening' video segments by feeding silence to Ditto."""
    def __init__(self, media_ws_url, webrtc_session_id, image_id):
        self.url = f"{media_ws_url}/push?session_id={webrtc_session_id}"
        self.image_id = image_id
        self.session_id = webrtc_session_id
        self._active = False
        self._task = None
        # Pre-generate 1s of silence (16000 samples for 16kHz float32)
        self._silence = struct.pack("<16000f", *([0.0] * 16000))

    async def start(self):
        if self._task: return
        self._active = True
        self._task = asyncio.create_task(self._run())
        log.info("IdleMotion: Started for session %s", self.session_id)

    async def stop(self):
        self._active = False
        if self._task:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None
        log.info("IdleMotion: Stopped for session %s", self.session_id)

    async def _run(self):
        try:
            # Connect to Media Server's push endpoint
            async with websockets.connect(self.url) as push_ws:
                while self._active:
                    # Generate 1 second of "idle" motion from silence
                    s_queue = asyncio.Queue()
                    c_path = f"/tmp/idle_{self.session_id}.mp4"
                    
                    # Start Ditto for silence
                    ditto_fut = asyncio.ensure_future(
                        ditto_stream_generate(self.image_id, c_path, s_queue, audio_float32_16k=self._silence)
                    )
                    
                    # Push segments from queue to media server
                    while True:
                        try:
                            chunk = await asyncio.wait_for(s_queue.get(), timeout=2.0)
                        except asyncio.TimeoutError: break
                        if chunk is None: break
                        await push_ws.send(chunk)
                    
                    await ditto_fut
                    # Small gap between heartbeat segments to avoid CPU spike
                    await asyncio.sleep(0.1) 
        except Exception as e:
            if self._active:
                log.exception("IdleMotion: Run failed for session %s: %s", self.session_id, e)

# Global store for persistent idle managers
webrtc_managers: dict[str, IdleMotionManager] = {}
# --- END IDLE ---


async def _run_chat_stream(ctx: dict):
    """
    Shared pipeline: yields ('event', name, data), ('binary', clip_index, bytes), or ('keepalive',).
    ctx: p, client, messages, persona_id, reply_id, loop, voice_id, image_id, t_request, message
    """
    p = ctx["p"]
    client = ctx["client"]
    messages = ctx["messages"]
    persona_id = ctx["persona_id"]
    reply_id = ctx["reply_id"]
    loop = ctx["loop"]
    voice_id = ctx["voice_id"]
    image_id = ctx["image_id"]
    t_request = ctx["t_request"]
    message = ctx["message"]

    t_start = time.monotonic()
    log.info("Chat pipeline: started at +%.3fs since request", t_start - t_request)
    # total must be non-zero: frontend must not treat "started" as stream end (avoid falsy total)
    yield ("event", "started", {"reply_id": reply_id, "total": 1})
    yield ("keepalive",)  # immediate keepalive so connection is not idle before first sentence
    log.info("Chat pipeline: yielded started + keepalive, now waiting for first sentence")

    ollama_url = ctx.get("ollama_url") or ""
    ollama_model = ctx.get("ollama_model") or OLLAMA_MODEL
    use_ollama = bool(ollama_url)

    # Tool support: only when not using Ollama (implement Ollama tools later)
    tools_for_llm: list[dict] = []
    tool_name_to_url: dict[str, str] = {}
    if not use_ollama:
        assigned_ids = p.get("assigned_listing_ids") or []
        if assigned_ids:
            for listing in load_listings():
                if listing.get("id") in assigned_ids and _listing_type(listing) == "integration":
                    mcp_url = (listing.get("mcp_server_url") or "").strip()
                    if mcp_url:
                        try:
                            mcp_tools = await loop.run_in_executor(None, _mcp_list_tools, mcp_url)
                            for t in mcp_tools:
                                tools_for_llm.append({
                                    "type": "function",
                                    "function": {
                                        "name": t["name"],
                                        "description": t.get("description", ""),
                                        "parameters": t.get("inputSchema", {"type": "object", "properties": {}}),
                                    },
                                })
                                tool_name_to_url[t["name"]] = mcp_url
                        except Exception as mcp_err:
                            log.warning("MCP list_tools failed %s: %s", mcp_url, mcp_err)
        if tools_for_llm:
            tool_descs = "; ".join(
                f"{t['function']['name']}: {t['function'].get('description', '') or 'No description'}"
                for t in tools_for_llm
            )
            messages[0]["content"] = (
                (messages[0].get("content") or "")
                + f"\n\nYou have access to these tools: {tool_descs}. If the user asks what tools or capabilities you have, describe these tools."
            )

    sentence_queue: asyncio.Queue[str | None] = asyncio.Queue()
    openai_task: asyncio.Task | None = None
    mode = (ctx.get("mode") or "audio").strip().lower()
    if mode == "audio":
        boundary_re = SENTENCE_BOUNDARY_AUDIO_RE
        split_re = SENTENCE_SPLIT_AUDIO_RE
    else:
        boundary_re = SENTENCE_BOUNDARY_PERIOD_RE
        split_re = SENTENCE_SPLIT_PERIOD_RE
    if use_ollama:
        if mode == "audio" and AUDIO_CONTINUOUS:
            openai_task = asyncio.ensure_future(
                loop.run_in_executor(
                    None,
                    _stream_ollama_continuous_sync,
                    ollama_url,
                    ollama_model,
                    messages,
                    sentence_queue,
                    loop,
                    AUDIO_CHUNK_CHARS,
                )
            )
            log.info("Chat timing: Ollama stream started (continuous, model=%s)", ollama_model)
        else:
            openai_task = asyncio.ensure_future(
                loop.run_in_executor(
                    None,
                    _stream_ollama_sentences_sync,
                    ollama_url,
                    ollama_model,
                    messages,
                    sentence_queue,
                    loop,
                    boundary_re,
                    split_re,
                    None,
                    None,
                )
            )
            log.info("Chat timing: Ollama stream started (model=%s)", ollama_model)
    elif tools_for_llm and client:
        async def _tool_task():
            full = await loop.run_in_executor(
                None, _run_with_tools_sync, client, messages, tools_for_llm, tool_name_to_url
            )
            for s in _chunk_by_sentences(full):
                await sentence_queue.put(s)
            await sentence_queue.put(None)
            return full
        openai_task = asyncio.ensure_future(_tool_task())
    else:
        if not client:
            raise RuntimeError("Set OLLAMA_URL or OPENAI_API_KEY for chat")
        if mode == "audio" and AUDIO_CONTINUOUS:
            openai_task = asyncio.ensure_future(
                loop.run_in_executor(
                    None, _stream_openai_continuous_sync, client, messages, sentence_queue, loop, AUDIO_CHUNK_CHARS
                )
            )
            log.info("Chat timing: OpenAI stream started (continuous)")
        else:
            openai_task = asyncio.ensure_future(
                loop.run_in_executor(
                    None, _stream_openai_sentences_sync, client, messages, sentence_queue, loop, boundary_re, split_re
                )
            )
            log.info("Chat timing: OpenAI stream started (stream=True)")

    async def prefetch_clip(idx, bundle):
        """Video: TTS only. Streams float32 chunks into audio_queue (unbounded). Ditto runs in the main loop."""
        try:
            text_to_prefetch = bundle.get("text") if isinstance(bundle, dict) else bundle
            deltas = bundle.get("deltas", []) if isinstance(bundle, dict) else []
            log.info("Prefetch: clip %s (%s chars)", idx, len(text_to_prefetch))
            if TTS_PROVIDER == "qwen3":
                if not QWEN3_TTS_BASE_URL:
                    return {"error": "Qwen3-TTS not configured (missing QWEN3_TTS_BASE_URL)"}
                if not (voice_id or "").strip():
                    return {"error": "Qwen3-TTS requires a registered voice_id; open the persona again or re-save voice"}
            c_path = str(DATA_DIR / f"reply_{persona_id}_{reply_id}_{idx}.mp4")
            t_tts0 = time.monotonic()
            metrics = {"prefetch_at": t_tts0, "tts_started_at": t_tts0}
            if use_streaming:
                audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
                tts_thread = threading.Thread(
                    target=_start_audio_tts_stream_to_queue,
                    args=(voice_id, p.get("voice_wav_path"), p.get("voice_ref_text"), text_to_prefetch, audio_queue, loop, True),
                    daemon=True,
                )
                tts_thread.start()
                log.info("Prefetch: TTS streaming started for clip %s (Ditto deferred to pipeline)", idx)
                return {
                    "index": idx,
                    "text": text_to_prefetch,
                    "deltas": deltas,
                    "path": c_path,
                    "audio_queue": audio_queue,
                    "tts_started_at": t_tts0,
                    "tts_thread": tts_thread,
                    "metrics": metrics,
                }
            audio_holder: dict = {}
            tts_thread = threading.Thread(
                target=_start_tts_wav_to_holder,
                args=(voice_id, p.get("voice_wav_path"), p.get("voice_ref_text"), text_to_prefetch, audio_holder),
                daemon=True,
            )
            tts_thread.start()
            log.info("Prefetch: TTS WAV started for clip %s", idx)
            return {
                "index": idx,
                "text": text_to_prefetch,
                "deltas": deltas,
                "path": c_path,
                "audio_queue": None,
                "tts_started_at": t_tts0,
                "tts_thread": tts_thread,
                "audio_holder": audio_holder,
                "metrics": metrics,
            }
        except Exception as pre_err:
            log.exception("Prefetch failed for clip %s: %s", idx, pre_err)
            return {"error": str(pre_err)}

    sentences_log: list[str] = []
    clip_index = 0
    stream_ended = False
    use_streaming = os.environ.get("DITTO_STREAMING", "").lower() in ("1", "true", "yes")
    mode = (ctx.get("mode") or "audio").strip().lower()

    def _split_text(text: str, max_chars: int | None, force_hard: bool = False, min_cut: int = 20) -> tuple[str, str]:
        """Split text into head/tail at natural boundaries within max_chars."""
        if not text:
            return "", ""
        if max_chars is None:
            return text.strip(), ""
        max_chars = max(30, int(max_chars))
        if len(text) <= max_chars:
            return text.strip(), ""
        # Prefer sentence boundaries, then clause boundaries, then space.
        puncts = [".", "?", "!", ";", ":", ","]
        cut = -1
        for p in puncts:
            idx = text.rfind(p, 0, max_chars)
            if idx > cut:
                cut = idx
        if cut < min_cut:
            cut = text.rfind(" ", 0, max_chars)
        if cut < min_cut and force_hard:
            cut = max_chars
        if cut < min_cut:
            cut = max_chars
        head = text[:cut + 1].rstrip()
        tail = text[cut + 1:].lstrip()
        return head, tail

    pending_text: str | None = None

    async def get_next_bundle():
        nonlocal stream_ended
        nonlocal pending_text
        deltas = []
        # If we have leftover text from a previous split, emit it first.
        if pending_text:
            text = pending_text
            pending_text = None
        else:
            bundle = []
            if mode == "audio":
                if AUDIO_CONTINUOUS:
                    max_sentences = 1
                    min_chars = 0
                else:
                    max_sentences = AUDIO_FIRST_CLIP_SENTENCES if clip_index == 0 else AUDIO_SENTENCES_PER_CLIP
                    min_chars = AUDIO_CLIP_MIN_CHARS
            elif mode == "video" and clip_index == 0:
                # First muxed Ditto clip: VIDEO_FIRST_CLIP_SENTENCES (default 2) gives a longer
                # first clip so Ditto has time to finish clip 1 before clip 0 plays out.
                max_sentences = VIDEO_FIRST_CLIP_SENTENCES
                min_chars = AUDIO_CLIP_MIN_CHARS
            else:
                max_sentences = FIRST_CLIP_SENTENCES if clip_index == 0 else SENTENCES_PER_CLIP
                min_chars = CLIP_MIN_CHARS
            current_len = 0
            while not stream_ended and (len(bundle) < max_sentences or (min_chars and current_len < min_chars)):
                try:
                    s = await asyncio.wait_for(sentence_queue.get(), timeout=30.0)
                    if s is None:
                        stream_ended = True
                        break
                    bundle.append(s)
                    if current_len:
                        current_len += 1  # space
                    current_len += len(s)
                    sentences_log.append(s)
                    deltas.append(s)
                    if min_chars and current_len >= min_chars and len(bundle) >= max_sentences:
                        break
                except asyncio.TimeoutError:
                    break
            text = " ".join(bundle) if bundle else None

        if not text:
            return None

        if mode == "audio":
            head, tail = _split_text(text, None)
        elif mode == "video" and clip_index == 0:
            # Cap first utterance like audio-friendly TTFR; env override else AUDIO_CLIP_MAX_CHARS.
            vcap = FIRST_CLIP_MAX_CHARS if FIRST_CLIP_MAX_CHARS is not None else AUDIO_CLIP_MAX_CHARS
            head, tail = _split_text(text, vcap)
        else:
            if clip_index == 0:
                head, tail = _split_text(text, FIRST_CLIP_MAX_CHARS)
            else:
                head, tail = _split_text(text, CLIP_MAX_CHARS)
        if tail:
            pending_text = tail
        return {"text": head if head else None, "deltas": deltas}
    
    async def get_and_prefetch(idx):
        bundle = await get_next_bundle()
        if not bundle or not bundle.get("text"):
            return None
        return await prefetch_clip(idx, bundle)

    prefetch_task = None
    video_ditto_task: asyncio.Task | None = None  # video streaming: cancel on WS teardown so Ditto lock is not stuck
    try:
        if mode == "audio":
            async def prefetch_audio_clip(idx, text_to_prefetch, unbounded=False):
                try:
                    text_value = text_to_prefetch.get("text") if isinstance(text_to_prefetch, dict) else text_to_prefetch
                    deltas = text_to_prefetch.get("deltas", []) if isinstance(text_to_prefetch, dict) else []
                    log.info("Prefetch: audio clip %s (%s chars)", idx, len(text_value))
                    if TTS_PROVIDER == "qwen3":
                        if not QWEN3_TTS_BASE_URL:
                            return {"error": "Qwen3-TTS not configured (missing QWEN3_TTS_BASE_URL)"}
                        if not (voice_id or "").strip():
                            return {"error": "Qwen3-TTS requires a registered voice_id; open the persona again or re-save voice"}
                    t_tts0 = time.monotonic()
                    metrics = {"prefetch_at": t_tts0, "tts_started_at": t_tts0}
                    audio_holder = {}
                    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=0 if unbounded else 8)
                    tts_thread = threading.Thread(
                        target=_start_audio_tts_stream_to_queue,
                        args=(voice_id, p.get("voice_wav_path"), p.get("voice_ref_text"), text_value, audio_queue, loop, False),
                        daemon=True,
                    )
                    tts_thread.start()
                    return {
                        "index": idx,
                        "text": text_value,
                        "deltas": deltas,
                        "audio_queue": audio_queue,
                        "tts_started_at": t_tts0,
                        "tts_thread": tts_thread,
                        "audio_holder": audio_holder,
                        "metrics": metrics,
                    }
                except Exception as pre_err:
                    log.exception("Prefetch audio failed for clip %s: %s", idx, pre_err)
                    return {"error": str(pre_err)}

            async def get_and_prefetch_audio(idx, unbounded=False):
                bundle = await get_next_bundle()
                if not bundle or not bundle.get("text"):
                    return None
                return await prefetch_audio_clip(idx, bundle, unbounded=unbounded)

            audio_serial = TTS_PROVIDER in ("xtts", "f5", "cosyvoice", "qwen3", "chatterbox")
            prefetch_task = asyncio.create_task(get_and_prefetch_audio(0)) if not audio_serial else None
            next_serial_task = None  # early-prefetched next clip for serial mode
            while True:
                if audio_serial:
                    if next_serial_task is not None:
                        clip_data = await next_serial_task
                        next_serial_task = None
                    else:
                        clip_data = await get_and_prefetch_audio(clip_index)
                else:
                    clip_data = await prefetch_task
                if not clip_data:
                    break

                i = clip_index
                clip_index += 1
                if "error" in clip_data:
                    log.error("Audio clip %s failed: %s", i, clip_data["error"])
                    yield ("event", "error", {"index": i, "error": clip_data["error"]})
                    break
                current_text = clip_data["text"]
                if not audio_serial:
                    prefetch_task = asyncio.create_task(get_and_prefetch_audio(i + 1))
                for delta in clip_data.get("deltas", []):
                    yield ("event", "text_delta", {"text": delta})

                tts_thread = clip_data.get("tts_thread")
                audio_holder = clip_data.get("audio_holder")
                if audio_holder is None:
                    audio_holder = {}
                audio_queue = clip_data.get("audio_queue")
                if audio_queue is None:
                    raise RuntimeError("Audio queue missing")
                metrics = clip_data.get("metrics") or {}

                segment_count = 0
                audio_start_at = None
                while True:
                    try:
                        chunk = await asyncio.wait_for(audio_queue.get(), timeout=1.0)
                    except asyncio.TimeoutError:
                        yield ("keepalive",)
                        continue
                    if chunk is None:
                        break
                    if segment_count == 0:
                        audio_start_at = time.monotonic()
                        log.info("Pipeline: emitting audio_start for clip %s at +%.2fs", i, audio_start_at - t_start)
                        if metrics:
                            log.info(
                                "ClipTiming audio clip=%s prefetch=+%.2fs tts_start=+%.2fs audio_start=+%.2fs",
                                i,
                                metrics.get("prefetch_at", t_start) - t_start,
                                metrics.get("tts_started_at", t_start) - t_start,
                                audio_start_at - t_start,
                            )
                        yield ("event", "audio_start", {"index": i, "format": "f32le", "sample_rate": 16000, "channels": 1})
                        yield ("event", "clip", {"index": i, "text": current_text, "mode": "audio", "streaming": True})
                        # Serial mode: kick off next clip's TTS now while current clip plays,
                        # using an unbounded queue so it buffers freely without stalling F5-TTS.
                        if audio_serial and next_serial_task is None:
                            next_serial_task = asyncio.create_task(get_and_prefetch_audio(clip_index, unbounded=True))
                    segment_count += 1
                    yield ("binary_audio", i, chunk)

                if tts_thread:
                    tts_thread.join(timeout=5)
                if audio_holder.get("error"):
                    raise RuntimeError(audio_holder["error"])
                if audio_start_at:
                    log.info(
                        "ClipTiming audio clip=%s done segments=%s total=+%.2fs",
                        i, segment_count, time.monotonic() - t_start
                    )
        else:
            # Video: TTS prefetch overlaps with Ditto for the previous clip.
            # With multiple Ditto workers, a "lookahead" task starts Ditto for clip N+1 as soon
            # as its TTS is ready — while clip N is still streaming — so both workers run in
            # parallel and inter-clip gaps are eliminated.
            prefetch_task = asyncio.create_task(get_and_prefetch(0))
            # lookahead holds a pre-started Ditto task for the NEXT clip (when >1 worker available).
            lookahead: dict | None = None

            while True:
                if lookahead is not None:
                    # Ditto for this clip was already launched during the previous clip's streaming.
                    clip_data = lookahead["clip_data"]
                    seq_queue  = lookahead["seq_queue"]
                    ditto_fut  = lookahead["ditto_fut"]
                    metrics    = lookahead["metrics"]
                    lookahead  = None
                    # prefetch_task already points to clip i+2 (advanced when lookahead was created)
                else:
                    clip_data = await prefetch_task
                    if not clip_data:
                        break
                    seq_queue = ditto_fut = metrics = None  # will be set in use_streaming block

                i = clip_index
                clip_index += 1

                if "error" in clip_data:
                    log.error("Clip %s failed: %s", i, clip_data["error"])
                    yield ("event", "error", {"index": i, "error": clip_data["error"]})
                    break

                current_text = clip_data["text"]

                if ditto_fut is None:
                    # Normal (non-lookahead) path: start next clip's TTS now so it overlaps Ditto.
                    prefetch_task = asyncio.create_task(get_and_prefetch(i + 1))

                for delta in clip_data.get("deltas", []):
                    yield ("event", "text_delta", {"text": delta})

                if use_streaming:
                    audio_queue = clip_data.get("audio_queue")
                    if audio_queue is None:
                        raise RuntimeError("Video streaming clip missing audio_queue")

                    if ditto_fut is None:
                        # Normal path: start Ditto for this clip now.
                        seq_queue = asyncio.Queue()
                        worker_idx, ws_base = _pick_ditto_worker()
                        metrics = clip_data.get("metrics") or {}
                        metrics["worker_idx"] = worker_idx
                        metrics["ws_base"] = ws_base
                        metrics["tts_ready_at"] = time.monotonic()
                        metrics["ditto_started_at"] = time.monotonic()
                        ditto_fut = asyncio.ensure_future(
                            ditto_stream_generate(
                                image_id,
                                clip_data["path"],
                                seq_queue,
                                audio_queue=audio_queue,
                                ws_base=ws_base,
                                worker_idx=worker_idx,
                            )
                        )
                    video_ditto_task = ditto_fut

                    segment_count = 0
                    first_chunk_at = None
                    normal_clip_end = False
                    try:
                        while True:
                            try:
                                chunk = await asyncio.wait_for(seq_queue.get(), timeout=1.0)
                            except asyncio.TimeoutError:
                                yield ("keepalive",)
                                continue

                            if chunk is None:
                                normal_clip_end = True
                                break

                            if segment_count == 0:
                                first_chunk_at = time.monotonic()
                                log.info("Pipeline: emitting video_start for clip %s at +%.2fs", i, first_chunk_at - t_start)
                                if metrics:
                                    log.info(
                                        "ClipTiming video clip=%s prefetch=+%.2fs tts_start=+%.2fs tts_ready=+%.2fs ditto_start=+%.2fs first_chunk=+%.2fs",
                                        i,
                                        metrics.get("prefetch_at", t_start) - t_start,
                                        metrics.get("tts_started_at", t_start) - t_start,
                                        metrics.get("tts_ready_at", t_start) - t_start,
                                        metrics.get("ditto_started_at", t_start) - t_start,
                                        first_chunk_at - t_start,
                                    )
                                    log.info(
                                        "ClipTiming video clip=%s worker=%s base=%s",
                                        i,
                                        metrics.get("worker_idx"),
                                        metrics.get("ws_base"),
                                    )
                                yield ("event", "video_start", {"index": i})

                            segment_count += 1
                            yield ("binary", i, chunk)

                            # LOOKAHEAD: once TTS for clip i+1 is ready while we're still
                            # streaming clip i, fire Ditto for it on the other worker immediately.
                            # Only when >1 worker is available (otherwise serial is correct).
                            if (
                                lookahead is None
                                and len(_DITTO_WS_BASES) > 1
                                and prefetch_task.done()
                                and not prefetch_task.cancelled()
                            ):
                                try:
                                    next_clip = prefetch_task.result()
                                    if next_clip and "error" not in next_clip:
                                        next_sq: asyncio.Queue[bytes | None] = asyncio.Queue()
                                        next_wi, next_wb = _pick_ditto_worker()
                                        next_m = next_clip.get("metrics") or {}
                                        next_m["worker_idx"] = next_wi
                                        next_m["ws_base"] = next_wb
                                        next_m["tts_ready_at"] = time.monotonic()
                                        next_m["ditto_started_at"] = time.monotonic()
                                        next_fut = asyncio.ensure_future(
                                            ditto_stream_generate(
                                                image_id,
                                                next_clip["path"],
                                                next_sq,
                                                audio_queue=next_clip.get("audio_queue"),
                                                ws_base=next_wb,
                                                worker_idx=next_wi,
                                            )
                                        )
                                        lookahead = {
                                            "clip_data": next_clip,
                                            "seq_queue": next_sq,
                                            "ditto_fut": next_fut,
                                            "metrics": next_m,
                                        }
                                        # Advance prefetch to clip i+2 so next iteration is ready.
                                        prefetch_task = asyncio.create_task(get_and_prefetch(i + 2))
                                        log.info(
                                            "Lookahead: started Ditto for clip %s on worker %s"
                                            " while clip %s is still streaming",
                                            i + 1, next_wi, i,
                                        )
                                except Exception as _la_err:
                                    log.warning("Lookahead: failed to pre-start clip %s Ditto: %s", i + 1, _la_err)

                    except asyncio.CancelledError:
                        # Cancel lookahead Ditto first, then current.
                        if lookahead is not None:
                            lookahead["ditto_fut"].cancel()
                            try:
                                await lookahead["ditto_fut"]
                            except Exception:
                                pass
                            lookahead = None
                        if not ditto_fut.done():
                            log.info(
                                "Ditto stream: cancelling background task (pipeline cancelled) reply_id=%s",
                                reply_id,
                            )
                            ditto_fut.cancel()
                        try:
                            await ditto_fut
                        except (asyncio.CancelledError, Exception):
                            pass
                        video_ditto_task = None
                        raise
                    finally:
                        video_ditto_task = None
                        # If the client disconnects or the generator is closed during yield, the else-branch
                        # never ran and ditto_fut would keep running — leaving _DITTO_WS_LOCKS held forever.
                        if normal_clip_end:
                            try:
                                await ditto_fut
                            except Exception:
                                pass
                        elif not ditto_fut.done():
                            # Abnormal exit: cancel lookahead before cancelling current.
                            if lookahead is not None:
                                lookahead["ditto_fut"].cancel()
                                try:
                                    await lookahead["ditto_fut"]
                                except Exception:
                                    pass
                                lookahead = None
                            log.info(
                                "Ditto stream: cancelling orphan task (abnormal clip end / generator exit) reply_id=%s",
                                reply_id,
                            )
                            ditto_fut.cancel()
                            try:
                                await ditto_fut
                            except (asyncio.CancelledError, Exception):
                                pass

                    metrics["ditto_done_at"] = time.monotonic()

                    tts_thread = clip_data.get("tts_thread")
                    if tts_thread:
                        tts_thread.join(timeout=30)
                        if tts_thread.is_alive():
                            log.warning("TTS thread still running after 30s for clip %s", i)

                    log.info("Pipeline: clip %s finished yielding (%s segments)", i, segment_count)
                    if metrics:
                        log.info(
                            "ClipTiming video clip=%s done segments=%s total=+%.2fs",
                            i, segment_count, time.monotonic() - t_start
                        )
                    clip_url = f"/api/personas/{persona_id}/reply/{reply_id}/{i}"
                    yield ("event", "clip", {"index": i, "text": current_text, "streaming": True, "url": clip_url})

                else:
                    tts_thread = clip_data.get("tts_thread")
                    audio_holder = clip_data.get("audio_holder")
                    if audio_holder is None:
                        audio_holder = {}
                    if tts_thread:
                        tts_thread.join(timeout=60)
                        if tts_thread.is_alive():
                            log.warning("TTS thread still running after 60s for clip %s", i)
                    audio_wav = audio_holder.get("wav", b"")
                    if audio_holder.get("error"):
                        raise RuntimeError(audio_holder["error"])
                    if not audio_wav:
                        raise RuntimeError("TTS produced no audio")
                    audio_f32 = _wav_to_16k_float32_mono(audio_wav)
                    widx, wbase = _pick_ditto_worker()
                    await ditto_stream_generate(
                        image_id,
                        clip_data["path"],
                        None,
                        audio_float32_16k=audio_f32,
                        ws_base=wbase,
                        worker_idx=widx,
                    )
                    log.info("Pipeline: emitting video_start for clip %s at +%.2fs", i, time.monotonic() - t_start)
                    yield ("event", "video_start", {"index": i})
                    clip_url = f"/api/personas/{persona_id}/reply/{reply_id}/{i}"
                    yield ("event", "clip", {"index": i, "text": current_text, "streaming": False, "url": clip_url})

    finally:
        if video_ditto_task and not video_ditto_task.done():
            log.warning(
                "Chat pipeline: cancelling stray Ditto task on teardown reply_id=%s (release worker lock)",
                reply_id,
            )
            video_ditto_task.cancel()
            try:
                await video_ditto_task
            except (asyncio.CancelledError, Exception):
                pass

        # Cleanup both pipeline tasks
        if prefetch_task:
            prefetch_task.cancel()
            try: await prefetch_task
            except: pass

        if openai_task and not openai_task.done():
            openai_task.cancel()
        
        # Ensure we always try to save whatever we got
        try:
            full_text = ""
            if openai_task and not openai_task.cancelled():
                full_text = await openai_task
            
            if not full_text:
                full_text = " ".join(sentences_log)
            
            log.info("AI Text: %s...", full_text[:60].replace("\n", " "))
            if ctx.get("persist", True):
                p["conversation"] = p.get("conversation", []) + [
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": full_text},
                ]
                personas = load_personas()
                for idx, x in enumerate(personas):
                    if x.get("id") == persona_id:
                        personas[idx] = p
                        break
                save_personas(personas)
        except Exception as save_err:
            log.error("Failed to finalize conversation state: %s", save_err)

    log.info("Chat pipeline: finished reply_id=%s with %s clips", reply_id, clip_index)
    yield ("event", "done", {"reply_id": reply_id, "total": clip_index})


@app.post("/api/personas/{persona_id}/chat")
async def chat(persona_id: str, message: str = Form(...), current_user: dict = Depends(get_current_user)):
    """
    Pipelined chat: OpenAI token stream → sentence detection → TTS → Ditto → SSE clip events.

    Pipeline overlap:
      - OpenAI streams tokens in a background executor thread.
      - As each sentence completes, TTS starts immediately (also in executor).
      - As soon as TTS is done for sentence N, Ditto starts immediately.
      - While Ditto renders clip N, TTS is already running for sentence N+1.
      - The frontend receives clip N as soon as Ditto finishes, without waiting
        for subsequent clips to be ready.
    """
    message = (message or "").strip()
    if not message:
        raise HTTPException(400, "message is required")

    p = get_persona(persona_id, current_user["id"])
    if not p:
        raise HTTPException(404, "Persona not found")

    use_ollama = bool(OLLAMA_URL)
    if not use_ollama and not OPENAI_API_KEY:
        raise HTTPException(503, "Set OLLAMA_URL or OPENAI_API_KEY for chat")

    client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
    about = (p.get("system_prompt") or "").strip() or "You are a helpful assistant."
    system_content = (
        "You are a character in a conversation. The following describes you (the character), not the person you are chatting with. "
        "Any name or trait in that description refers to you—do not use it for the user. Refer to the other person as 'you' or by what they tell you.\n\n"
        "About you (the character):\n" + about
    )
    # Append assigned role pack prompt (one per twyn).
    rp_id = (p.get("assigned_role_pack_id") or "").strip() or None
    if rp_id:
        rp_listing = get_listing(rp_id)
        if rp_listing and _listing_type(rp_listing) == "role_pack":
            role_prompt = (rp_listing.get("role_prompt") or "").strip()
            if role_prompt:
                system_content = system_content + "\n\n" + role_prompt

    # RAG: inject knowledge base context only when relevant; otherwise model uses general knowledge.
    rag_context = get_rag_context(persona_id, current_user["id"], message)
    if rag_context:
        system_content = system_content + "\n\nUse the following information when relevant to the user's question:\n" + rag_context

    messages = [
        {"role": "system", "content": system_content + "\n\nIMPORTANT: Do NOT use exclamation marks (!) in your response. Use only periods (.) and question marks (?) for punctuation."},
    ]
    for m in p.get("conversation", []):
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": message})

    loop = asyncio.get_event_loop()
    if TTS_PROVIDER == "cosyvoice":
        voice_id = persona_id
    elif TTS_PROVIDER == "qwen3":
        voice_id = _ensure_qwen3_voice_id(p)
    else:
        voice_id = _ensure_chatterbox_voice_id(p)
    image_id = p["image_id"]
    reply_id = uuid.uuid4().hex
    t_request = time.monotonic()
    log.info("Chat: request received (persona_id=%s)", persona_id)

    ctx = {
        "p": p,
        "client": client,
        "messages": messages,
        "persona_id": persona_id,
        "reply_id": reply_id,
        "loop": loop,
        "voice_id": voice_id,
        "image_id": image_id,
        "t_request": t_request,
        "message": message,
        "ollama_url": OLLAMA_URL if use_ollama else "",
        "ollama_model": OLLAMA_MODEL,
    }

    async def stream_clips_sse():
        """Adapt _run_chat_stream to SSE (for POST /chat)."""
        async for item in _run_chat_stream(ctx):
            if item[0] == "event":
                _, name, data = item
                yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
            elif item[0] == "binary":
                _, idx, b = item
                yield f"event: video_segment\ndata: {json.dumps({'index': idx, 'base64': base64.b64encode(b).decode('ascii')})}\n\n"
            elif item[0] == "binary_audio":
                _, idx, b = item
                yield f"event: audio_segment\ndata: {json.dumps({'index': idx, 'base64': base64.b64encode(b).decode('ascii')})}\n\n"
            elif item[0] == "keepalive":
                yield ": keepalive\n\n"

    return StreamingResponse(
        stream_clips_sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.websocket("/api/personas/{persona_id}/audio/rtc")
async def audio_rtc_ws(websocket: WebSocket, persona_id: str):
    """Bidirectional WebRTC audio: mic in -> STT -> LLM -> TTS out (no auth, share-like)."""
    if RTCPeerConnection is None or RTCSessionDescription is None or AudioResampler is None or AudioFrame is None or MediaStreamTrack is None or candidate_from_sdp is None:
        await websocket.accept()
        await websocket.send_json({"event": "error", "data": {"error": "WebRTC not available on server"}})
        await websocket.close()
        return

    await websocket.accept()
    stt_only = (websocket.query_params.get("stt_only") or "").strip().lower() in ("1", "true", "yes")
    log.info(
        "RTC audio: ws accepted persona_id=%s stt_base=%s stt_only=%s",
        persona_id,
        STT_BASE_URL or "(unset)",
        stt_only,
    )
    persona_cached = get_persona(persona_id)
    if not persona_cached:
        await websocket.send_json({"event": "error", "data": {"error": "Persona not found"}})
        await websocket.close()
        return
    if TTS_PROVIDER == "chatterbox":
        try:
            persona_cached["voice_id"] = _ensure_chatterbox_voice_id(persona_cached)
        except Exception:
            pass
    if TTS_PROVIDER == "qwen3":
        try:
            persona_cached["voice_id"] = _ensure_qwen3_voice_id(persona_cached)
        except Exception:
            pass
    if TTS_PROVIDER == "cosyvoice":
        try:
            voice_wav_path = persona_cached.get("voice_wav_path")
            voice_ref_text = persona_cached.get("voice_ref_text")
            if voice_wav_path:
                if COSYVOICE_USE_TRITON and COSYVOICE_USE_CACHE:
                    _cosyvoice_cache_speaker_triton(str(persona_id), str(voice_wav_path), voice_ref_text)
                else:
                    if voice_ref_text:
                        _cosyvoice_register_speaker(str(persona_id), str(voice_wav_path), voice_ref_text)
        except Exception:
            pass
    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _ensure_greeting_cached, persona_cached)
    except Exception:
        pass
    pc = RTCPeerConnection(RTCConfiguration(_get_ice_servers()))
    out_track = _OutgoingAudioTrack()
    pc.addTrack(out_track)
    transcript_dc = {"ch": None}
    remote_candidates: list[RTCIceCandidate] = []
    utterance_queue: asyncio.Queue[str | None] = asyncio.Queue()

    connection_ready = asyncio.Event()

    @pc.on("connectionstatechange")
    async def on_conn_state():
        log.info("RTC audio state=%s", pc.connectionState)
        if pc.connectionState == "connected":
            connection_ready.set()

    @pc.on("datachannel")
    def on_datachannel(channel):
        if channel.label in ("transcript", "events", "control"):
            transcript_dc["ch"] = channel

    async def send_dc(payload: dict):
        ch = transcript_dc.get("ch")
        if ch and ch.readyState == "open":
            try:
                ch.send(json.dumps(payload))
            except Exception:
                pass

    @pc.on("icecandidate")
    async def on_icecandidate(candidate):
        if candidate is None:
            return
        payload = {
            "action": "candidate",
            "candidate": candidate.candidate,
            "sdpMid": candidate.sdpMid,
            "sdpMLineIndex": candidate.sdpMLineIndex,
        }
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    async def process_audio_track(track):
        resampler = AudioResampler(format="s16", layout="mono", rate=16000)
        vad = _AudioVADBuffer()
        await send_dc({"event": "ready"})
        log.info("RTC audio: track receiver started")
        try:
            await asyncio.wait_for(connection_ready.wait(), timeout=3.0)
        except Exception:
            pass

        async def play_greeting():
            data = _load_greeting_bytes(persona_id)
            if not data:
                return
            chunk_bytes = 3200 * 4  # ~0.2s at 16k f32
            idx = 0
            while idx < len(data):
                chunk = data[idx : idx + chunk_bytes]
                out_track.put_f32_16k(chunk)
                samples = len(chunk) // 4
                await asyncio.sleep(max(samples / 16000.0, 0.01))
                idx += chunk_bytes
        try:
            if not stt_only:
                await play_greeting()
        except Exception as e:
            log.warning("RTC audio: greeting playback skipped: %s", e)
        _rms_log_counter = 0
        while True:
            try:
                frame = await track.recv()
            except Exception:
                break
            frames = resampler.resample(frame)
            if not isinstance(frames, list):
                frames = [frames]
            for f in frames:
                pcm = f.to_ndarray()
                if pcm.ndim > 1:
                    pcm = pcm[0]
                # Pause STT while TTS is speaking (half-duplex) + short cooldown after speech ends.
                if out_track._speaking or (time.monotonic() - out_track._speaking_ended_at) < 0.3:
                    vad._reset()
                    continue
                # Log RMS every ~2s (100 frames @ 20ms) to show incoming audio levels
                _rms_log_counter += 1
                if _rms_log_counter >= 100:
                    _rms_log_counter = 0
                    rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2)))
                    log.info("RTC audio: RMS=%.4f (threshold=%.4f speech=%dms)", rms, vad.rms_threshold, vad._speech_ms)
                segs = vad.push(pcm.astype(np.int16, copy=False))
                for seg in segs:
                    seg_ms = int(len(seg) / 16)
                    log.info("RTC audio: VAD segment %sms", seg_ms)
                    wav_bytes = _pcm16_to_wav_bytes(seg)
                    text = await _stt_transcribe_wav(wav_bytes)
                    log.info("RTC audio: STT result %r (%dms segment)", text or "(empty)", seg_ms)
                    if text:
                        await send_dc({"event": "user_transcript", "text": text})
                        if not stt_only:
                            await utterance_queue.put(text)

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            log.info("RTC audio: inbound audio track received")
            asyncio.create_task(process_audio_track(track))

    async def run_llm_loop():
        while True:
            text = await utterance_queue.get()
            if text is None:
                return
            p = get_persona(persona_id)
            if not p:
                await send_dc({"event": "error", "text": "Persona not found"})
                continue
            if TTS_PROVIDER == "chatterbox":
                try:
                    p["voice_id"] = _ensure_chatterbox_voice_id(p)
                except Exception:
                    pass
            if TTS_PROVIDER == "qwen3":
                try:
                    p["voice_id"] = _ensure_qwen3_voice_id(p)
                except Exception:
                    pass
            about = (p.get("system_prompt") or "").strip() or "You are a helpful assistant."
            system_content = (
                "You are a character in a conversation. The following describes you (the character), not the person you are chatting with. "
                "Any name or trait in that description refers to you—do not use it for the user. Refer to the other person as 'you' or by what they tell you.\n\n"
                "About you (the character):\n" + about
            )
            rp_id = (p.get("assigned_role_pack_id") or "").strip() or None
            if rp_id:
                rp_listing = get_listing(rp_id)
                if rp_listing and _listing_type(rp_listing) == "role_pack":
                    role_prompt = (rp_listing.get("role_prompt") or "").strip()
                    if role_prompt:
                        system_content = system_content + "\n\n" + role_prompt
            rag_user_id = p.get("user_id")
            rag_context = get_rag_context(persona_id, rag_user_id, text)
            if rag_context:
                system_content = system_content + "\n\nUse the following information when relevant to the user's question:\n" + rag_context
            messages = [
                {"role": "system", "content": system_content + "\n\nIMPORTANT: Do NOT use exclamation marks (!) in your response. Use only periods (.) and question marks (?) for punctuation.\nKeep responses to one short sentence (max 12 words)."},
            ]
            for m in p.get("conversation", []):
                messages.append({"role": m["role"], "content": m["content"]})
            messages.append({"role": "user", "content": text})
            if AUDIO_HISTORY_MAX > 0:
                messages = _trim_messages_for_audio(messages, AUDIO_HISTORY_MAX)

            client = httpx.Client(timeout=60.0)
            ctx = {
                "p": p,
                "client": client,
                "messages": messages,
                "persona_id": persona_id,
                "reply_id": uuid.uuid4().hex,
                "loop": asyncio.get_event_loop(),
                "voice_id": (persona_id if TTS_PROVIDER == "cosyvoice" else p["voice_id"]),
                "image_id": p["image_id"],
                "t_request": time.monotonic(),
                "message": text,
                "ollama_url": OLLAMA_URL,
                "ollama_model": OLLAMA_MODEL,
                "persist": True,
                "mode": "audio",
            }

            await send_dc({"event": "assistant_start"})
            try:
                out_track.set_speaking(True)
                prefill_ms = int(os.environ.get("AUDIO_PREFILL_MS", "1200") or "1200")
                prefill_bytes = int(16000 * 4 * (prefill_ms / 1000.0))
                play_buf = bytearray()
                prefilled = False
                async def _play_audio(buf: bytearray):
                    if not buf:
                        return
                    chunk_bytes = 3200 * 4  # ~0.2s at 16k f32
                    idx = 0
                    data = bytes(buf)
                    while idx < len(data):
                        chunk = data[idx : idx + chunk_bytes]
                        out_track.put_f32_16k(chunk)
                        samples = len(chunk) // 4
                        await asyncio.sleep(max(samples / 16000.0, 0.01))
                        idx += chunk_bytes
                async for item in _run_chat_stream(ctx):
                    if item[0] == "event" and item[1] == "clip":
                        payload = item[2] or {}
                        clip_text = (payload.get("text") or "").strip()
                        if clip_text:
                            await send_dc({"event": "assistant_text", "text": clip_text})
                    elif item[0] == "binary_audio":
                        if item[2]:
                            play_buf.extend(item[2])
                        if not prefilled:
                            if len(play_buf) >= prefill_bytes:
                                await _play_audio(play_buf)
                                play_buf.clear()
                                prefilled = True
                        else:
                            if play_buf:
                                await _play_audio(play_buf)
                                play_buf.clear()
                if play_buf:
                    await _play_audio(play_buf)
                out_track.flush()
                out_track.put_f32_16k(b"\x00" * (320 * 2))  # ~20ms of silence to ensure tail delivery
                await send_dc({"event": "assistant_done"})
            except Exception as e:
                log.warning("RTC audio pipeline error: %s", e)
                await send_dc({"event": "error", "text": str(e)})
            finally:
                out_track.set_speaking(False)
                try:
                    client.close()
                except Exception:
                    pass

    llm_task = asyncio.create_task(run_llm_loop()) if not stt_only else None

    try:
        while True:
            msg = json.loads(await websocket.receive_text())
            action = msg.get("action")
            if action == "offer":
                offer = RTCSessionDescription(sdp=msg["sdp"], type=msg["type"])
                await pc.setRemoteDescription(offer)
                if remote_candidates:
                    for cand in remote_candidates:
                        try:
                            await pc.addIceCandidate(cand)
                        except Exception:
                            pass
                    remote_candidates.clear()
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await websocket.send_text(json.dumps({"action": "answer", "sdp": pc.localDescription.sdp, "type": pc.localDescription.type}))
            elif action == "candidate":
                cand_sdp = (msg.get("candidate") or "").strip()
                if not cand_sdp:
                    continue
                if not cand_sdp.startswith("candidate:"):
                    cand_sdp = "candidate:" + cand_sdp
                try:
                    cand = candidate_from_sdp(cand_sdp)
                    cand.sdpMid = msg.get("sdpMid")
                    cand.sdpMLineIndex = msg.get("sdpMLineIndex")
                except Exception:
                    continue
                if pc.remoteDescription is None:
                    remote_candidates.append(cand)
                else:
                    await pc.addIceCandidate(cand)
            elif action == "ping":
                try:
                    await websocket.send_text(json.dumps({"action": "pong", "ts": msg.get("ts")}))
                except Exception:
                    pass
    except WebSocketDisconnect:
        log.info("RTC audio websocket disconnect persona_id=%s", persona_id)
    except Exception as e:
        log.warning("RTC audio websocket error: %s", e)
        try:
            await websocket.send_json({"event": "error", "data": {"error": str(e)}})
        except Exception:
            pass
    finally:
        try:
            await utterance_queue.put(None)
        except Exception:
            pass
        if llm_task:
            try:
                llm_task.cancel()
            except Exception:
                pass
        await pc.close()


@app.websocket("/api/personas/{persona_id}/chat/stream")
async def chat_stream_ws(websocket: WebSocket, persona_id: str, token: str = ""):
    """
    WebSocket chat: same pipeline as POST /chat but sends JSON events + binary segments.
    Query param: token (JWT). First message must be JSON: {"message": "..."}.
    """
    await websocket.accept()
    auth_token = token or (websocket.query_params.get("token") or "")
    try:
        current_user = get_current_user_from_token(auth_token)
    except HTTPException as e:
        try:
            await websocket.send_json({"event": "error", "data": {"error": str(e.detail)}})
        except Exception:
            pass
        await websocket.close()
        return

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
        msg = json.loads(raw)
        message = (msg.get("message") or "").strip()
        mode = (msg.get("mode") or "audio").strip().lower()
        webrtc_session_id = (msg.get("webrtc_session_id") or "").strip() or None
    except Exception as e:
        try:
            await websocket.send_json({"event": "error", "data": {"error": f"Invalid message: {e}"}})
        except:
            pass
        await websocket.close()
        return

    if not message:
        log.info("Chat WS: Empty message (Initialization only) for session %s", webrtc_session_id)
        try:
            while True:
                await websocket.receive_text()
        except:
            pass
        return

    p = get_persona(persona_id, current_user["id"])
    if not p:
        await websocket.send_json({"event": "error", "data": {"error": "Persona not found"}})
        await websocket.close()
        return
    if TTS_PROVIDER == "chatterbox":
        try:
            p["voice_id"] = _ensure_chatterbox_voice_id(p)
        except Exception:
            pass
    if TTS_PROVIDER == "qwen3":
        try:
            p["voice_id"] = _ensure_qwen3_voice_id(p)
        except Exception:
            pass

    ws_use_ollama = bool(OLLAMA_URL)
    if not ws_use_ollama and not OPENAI_API_KEY:
        await websocket.send_json({"event": "error", "data": {"error": "Set OLLAMA_URL or OPENAI_API_KEY for chat"}})
        await websocket.close()
        return

    client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
    about = (p.get("system_prompt") or "").strip() or "You are a helpful assistant."
    system_content = (
        "You are a character in a conversation. The following describes you (the character), not the person you are chatting with. "
        "Any name or trait in that description refers to you—do not use it for the user. Refer to the other person as 'you' or by what they tell you.\n\n"
        "About you (the character):\n" + about
    )
    rp_id = (p.get("assigned_role_pack_id") or "").strip() or None
    if rp_id:
        rp_listing = get_listing(rp_id)
        if rp_listing and _listing_type(rp_listing) == "role_pack":
            role_prompt = (rp_listing.get("role_prompt") or "").strip()
            if role_prompt:
                system_content = system_content + "\n\n" + role_prompt
    rag_context = get_rag_context(persona_id, current_user["id"], message)
    if rag_context:
        system_content = system_content + "\n\nUse the following information when relevant to the user's question:\n" + rag_context
    messages = [
        {"role": "system", "content": system_content + "\n\nIMPORTANT: Do NOT use exclamation marks (!) in your response. Use only periods (.) and question marks (?) for punctuation."},
    ]
    for m in p.get("conversation", []):
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": message})
    if mode == "audio":
        if AUDIO_HISTORY_MAX > 0:
            before = len(messages)
            messages = _trim_messages_for_audio(messages, AUDIO_HISTORY_MAX)
            after = len(messages)
            if after < before:
                log.info("History trimmed for mode=audio: %s -> %s messages", before, after)
    else:
        if CHAT_HISTORY_MAX > 0:
            before = len(messages)
            messages = _trim_messages_for_audio(messages, CHAT_HISTORY_MAX)
            after = len(messages)
            if after < before:
                log.info("History trimmed for mode=%s: %s -> %s messages", mode, before, after)

    loop = asyncio.get_event_loop()
    voice_id = (persona_id if TTS_PROVIDER == "cosyvoice" else p["voice_id"])
    image_id = p["image_id"]
    reply_id = uuid.uuid4().hex
    t_request = time.monotonic()
    p = get_persona(persona_id, current_user["id"])
    if not p:
        await websocket.send_json({"event": "error", "data": {"error": "Persona not found"}})
        await websocket.close()
        return

    if not message:
        log.info("Chat WS: Empty message (Initialization only)")
        try:
            while True:
                await websocket.receive_text()
        except: pass
        return

    log.info(
        "Chat WS: request received persona_id=%s mode=%s webrtc_session_id=%s use_ollama=%s",
        persona_id, mode, webrtc_session_id or "(none)", ws_use_ollama,
    )

    ctx = {
        "p": p,
        "client": client,
        "messages": messages,
        "persona_id": persona_id,
        "reply_id": reply_id,
        "loop": loop,
        "voice_id": voice_id,
        "image_id": image_id,
        "t_request": t_request,
        "message": message,
        "ollama_url": OLLAMA_URL if ws_use_ollama else "",
        "ollama_model": OLLAMA_MODEL,
        "persist": True,
        "mode": mode,
    }
    push_ws = None

    sent_count = 0
    keepalive_count = 0
    last_log_at = 0.0
    ws_send_lock = asyncio.Lock()
    KEEPALIVE_INTERVAL = 5.0

    pipeline_queue: asyncio.Queue[tuple | None] = asyncio.Queue()

    async def pipeline_producer():
        """Run pipeline in separate task; put items in queue so main loop never blocks on LLM."""
        try:
            log.info("Chat WS: producer starting for reply_id=%s", reply_id)
            # Use the already defined ctx dictionary
            async for item in _run_chat_stream(ctx):
                await pipeline_queue.put(item)
            log.info("Chat WS: producer finished for reply_id=%s", reply_id)
        except Exception as e:
            log.error("Chat WS: pipeline_producer CRASHED: %s", e, exc_info=True)
            await pipeline_queue.put(("event", "error", {"error": str(e)}))
        finally:
            await pipeline_queue.put(None)

    pipeline_task = asyncio.create_task(pipeline_producer(), name=f"chat_{reply_id}")

    async def ws_consumer():
        """Detect disconnects."""
        try:
            while True:
                await websocket.receive_text()
        except: pass

    consumer_task = asyncio.create_task(ws_consumer())

    def _on_pipeline_done(t: asyncio.Task):
        if t.cancelled(): return
        exc = t.exception()
        if exc is not None:
            log.error("Chat WS: pipeline task %s failed: %s", t.get_name(), exc)

    pipeline_task.add_done_callback(_on_pipeline_done)

    # In continuous mode, we keep the loop alive for multiple user interactions
    try:
        log.info("Chat WS: entering main pipeline loop for reply_id=%s", reply_id)
        while True:
            try:
                # Wait for items from the producer.
                item = await asyncio.wait_for(pipeline_queue.get(), timeout=KEEPALIVE_INTERVAL)
            except asyncio.TimeoutError:
                if consumer_task.done():
                    break
                # Client may have disconnected; avoid send after close (RuntimeError on ASGI).
                if websocket.application_state != WebSocketState.CONNECTED:
                    break
                # No pipeline item; send keepalive so socket always has traffic (avoids proxy timeout)
                try:
                    async with ws_send_lock:
                        await websocket.send_json({"event": "keepalive", "data": {}})
                    keepalive_count += 1
                    sent_count += 1
                    now = time.monotonic()
                    if keepalive_count <= 3 or (now - last_log_at >= 10.0):
                        log.info("Chat WS: local keepalive (count=%s) reply_id=%s", keepalive_count, reply_id)
                        last_log_at = now
                except Exception as e:
                    log.debug("Chat WS: keepalive send ended: %s", e)
                    break
                continue
            
            # Log what we got so we can see if items arrive or loop exits early
            if item is None:
                print(f"DEBUG: Chat WS: CONSUMING None sentinel for reply_id={reply_id}", flush=True)
                break
            
            kind = item[0]
            try:
                if kind == "event":
                    print(f"DEBUG: Chat WS: SENDING event {item[1]} for reply_id={reply_id}", flush=True)
                    async with ws_send_lock:
                        await websocket.send_json({"event": item[1], "data": item[2]})
                    sent_count += 1
                elif kind in ("binary", "binary_audio"):
                    async with ws_send_lock:
                        await websocket.send_bytes(item[2])
                    sent_count += 1
                elif kind == "keepalive":
                    async with ws_send_lock:
                        await websocket.send_json({"event": "keepalive", "data": {}})
                    sent_count += 1
            except Exception as e:
                log.debug("Chat WS: client gone or send failed: %s", e)
                break
    except WebSocketDisconnect:
        print(f"DEBUG: Chat WS: WebSocketDisconnect for reply_id={reply_id}", flush=True)
    except asyncio.CancelledError:
        print(f"DEBUG: Chat WS: CancelledError for reply_id={reply_id}", flush=True)
    except Exception as e:
        print(f"ERROR: Chat WS loop: {e}", flush=True)
        log.exception("Chat WS: Exception sent_count=%s %s", sent_count, e)
        if websocket.application_state == WebSocketState.CONNECTED:
            try:
                await websocket.send_json({"event": "error", "data": {"error": str(e)}})
            except Exception:
                pass
    finally:
        pipeline_task.cancel()
        consumer_task.cancel()
        try:
            await pipeline_task
            await consumer_task
        except asyncio.CancelledError:
            pass
        print(f"DEBUG: Chat WS: finally for reply_id={reply_id}, sent_count={sent_count}", flush=True)

        # No cleanup for idle_mgr needed here as we removed it
        if push_ws:
            try:
                await push_ws.close()
            except:
                pass
        
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/api/share/{share_id}/chat/stream")
async def share_chat_stream_ws(websocket: WebSocket, share_id: str):
    """Public WebSocket chat for shared persona. No auth, no persistence."""
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
        msg = json.loads(raw)
        message = (msg.get("message") or "").strip()
        mode = (msg.get("mode") or "audio").strip().lower()
    except Exception as e:
        try:
            await websocket.send_json({"event": "error", "data": {"error": f"Invalid message: {e}"}})
        except Exception:
            pass
        await websocket.close()
        return

    if not message:
        try:
            while True:
                await websocket.receive_text()
        except Exception:
            pass
        return

    p = get_persona_by_share_id(share_id)
    if not p:
        await websocket.send_json({"event": "error", "data": {"error": "Shared persona not found"}})
        await websocket.close()
        return
    if TTS_PROVIDER == "chatterbox":
        try:
            p["voice_id"] = _ensure_chatterbox_voice_id(p)
        except Exception:
            pass
    if TTS_PROVIDER == "qwen3":
        try:
            p["voice_id"] = _ensure_qwen3_voice_id(p)
        except Exception:
            pass

    ws_use_ollama = bool(OLLAMA_URL)
    if not ws_use_ollama and not OPENAI_API_KEY:
        await websocket.send_json({"event": "error", "data": {"error": "Set OLLAMA_URL or OPENAI_API_KEY for chat"}})
        await websocket.close()
        return

    client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
    about = (p.get("system_prompt") or "").strip() or "You are a helpful assistant."
    system_content = (
        "You are a character in a conversation. The following describes you (the character), not the person you are chatting with. "
        "Any name or trait in that description refers to you—do not use it for the user. Refer to the other person as 'you' or by what they tell you.\n\n"
        "About you (the character):\n" + about
    )
    messages = [
        {"role": "system", "content": system_content + "\n\nIMPORTANT: Do NOT use exclamation marks (!) in your response. Use only periods (.) and question marks (?) for punctuation."},
        {"role": "user", "content": message},
    ]

    loop = asyncio.get_event_loop()
    voice_id = (p.get("id") if TTS_PROVIDER == "cosyvoice" else p["voice_id"])
    image_id = p["image_id"]
    reply_id = uuid.uuid4().hex
    t_request = time.monotonic()

    log.info(
        "Share Chat WS: request received share_id=%s persona_id=%s use_ollama=%s",
        share_id, p.get("id"), ws_use_ollama,
    )

    ctx = {
        "p": p,
        "client": client,
        "messages": messages,
        "persona_id": p.get("id"),
        "reply_id": reply_id,
        "loop": loop,
        "voice_id": voice_id,
        "image_id": image_id,
        "t_request": t_request,
        "message": message,
        "ollama_url": OLLAMA_URL if ws_use_ollama else "",
        "ollama_model": OLLAMA_MODEL,
        "persist": False,
        "mode": mode,
    }

    pipeline_queue: asyncio.Queue[tuple | None] = asyncio.Queue()

    async def pipeline_producer():
        try:
            async for item in _run_chat_stream(ctx):
                await pipeline_queue.put(item)
        except Exception as e:
            log.error("Share Chat WS: pipeline_producer CRASHED: %s", e, exc_info=True)
            await pipeline_queue.put(("event", "error", {"error": str(e)}))
        finally:
            await pipeline_queue.put(None)

    pipeline_task = asyncio.create_task(pipeline_producer(), name=f"share_chat_{reply_id}")

    try:
        while True:
            item = await pipeline_queue.get()
            if item is None:
                break
            kind = item[0]
            if kind == "event":
                await websocket.send_json({"event": item[1], "data": item[2]})
            elif kind in ("binary", "binary_audio"):
                await websocket.send_bytes(item[2])
            elif kind == "keepalive":
                await websocket.send_json({"event": "keepalive", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        pipeline_task.cancel()
        try:
            await pipeline_task
        except asyncio.CancelledError:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/api/personas/{persona_id}/reply/{reply_id}/{clip_index}")
def get_reply_video_clip(persona_id: str, reply_id: str, clip_index: int, request: Request):
    """Serve one clip of a chunked reply (for streaming playback)."""
    p = get_persona(persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    path = DATA_DIR / f"reply_{persona_id}_{reply_id}_{clip_index}.mp4"
    if not path.is_file():
        raise HTTPException(404, "Reply clip not found")
    return _video_response(request, path, "video/mp4")


@app.get("/api/personas/{persona_id}/reply-audio/{reply_id}/{clip_index}")
def get_reply_audio_clip(persona_id: str, reply_id: str, clip_index: int):
    """Serve one audio clip (WAV) of a reply."""
    p = get_persona(persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    path = DATA_DIR / f"reply_{persona_id}_{reply_id}_{clip_index}.wav"
    if not path.is_file():
        raise HTTPException(404, "Reply audio not found")
    return FileResponse(path, media_type="audio/wav")


# ---- Serve frontend (when STATIC_DIR is set, e.g. in Docker) ----
if STATIC_DIR and STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve built SPA: static files or index.html for client-side routes."""
        if full_path.startswith("api/") or full_path.startswith("webrtc/"):
            raise HTTPException(404, "Not found")
        static_dir = STATIC_DIR.resolve()
        path = (STATIC_DIR / full_path).resolve()
        if not str(path).startswith(str(static_dir)):
            return FileResponse(static_dir / "index.html", media_type="text/html")
        if path.is_file():
            return FileResponse(path)
        return FileResponse(static_dir / "index.html", media_type="text/html")
