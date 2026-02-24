"""
TwynBook backend: personas (JSON store), Ditto + Chatterbox + OpenAI.
Endpoints: personas CRUD, create persona (face→Ditto, voice→Chatterbox, idle video), chat (OpenAI→TTS→Ditto).
"""
import asyncio
import base64
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import struct
import uuid
import wave
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx
import jwt
import websockets
import bcrypt
from websockets.exceptions import ConnectionClosed
from dotenv import load_dotenv
from pydantic import BaseModel

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from openai import OpenAI

# Chatterbox TTS has a 1000-character limit per request
TTS_MAX_CHARS = 1000
# FIRST_CLIP_SENTENCES = 2 provides a solid buffer to prevent early stalling.
# SENTENCES_PER_CLIP = 2 balances throughput with stability.
FIRST_CLIP_SENTENCES = 2
SENTENCES_PER_CLIP = 2


def _chunk_by_sentences(text: str, max_chars: int = TTS_MAX_CHARS) -> list[str]:
    """Split text into chunks by sentence or newline, each chunk <= max_chars."""
    if not (text or "").strip():
        return []
    # Split on . ! ? followed by space/newline, or on double newline (paragraph), or single newline
    normalized = text.strip().replace("\r\n", "\n")
    # Split on . ? followed by space or end of string, or on newlines
    raw = re.split(r"(?<=[.?])(?:\s+|$)|(?:\s*\n\s*)+", normalized)
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
DITTO_API_URL = (os.environ.get("DITTO_API_URL", "http://localhost:8080")).rstrip("/")

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
RAG_EMBED_MODEL = "text-embedding-3-small"
RAG_CHUNK_TOKENS = 500
RAG_OVERLAP_TOKENS = 50
RAG_TOP_K = 5
RAG_RELEVANCE_THRESHOLD = 0.25  # min cosine similarity to inject context; below = use general knowledge only


def _kb_persona_dir(persona_id: str) -> Path:
    d = KB_DIR / persona_id
    d.mkdir(parents=True, exist_ok=True)
    return d


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


def _ditto_streaming_url() -> str:
    """WebSocket base URL for Ditto streaming (same host/port as REST API, path /stream). From env or derived from DITTO_API_URL."""
    url = os.environ.get("DITTO_STREAMING_URL", "").strip()
    if url:
        return url.rstrip("/")
    # Derive: same host and port as REST API, only change scheme (e.g. http://ditto-api:8080 -> ws://ditto-api:8080)
    base = DITTO_API_URL
    if base.startswith("https://"):
        base = "wss://" + base[8:]
    elif base.startswith("http://"):
        base = "ws://" + base[7:]
    return base.rstrip("/")

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
    # Use a temp name for Ditto/Chatterbox (avatar name is for marketplace only)
    ditto_name = name or "Avatar"
    try:
        ditto_persona = _ditto_create_persona(face_bytes, ditto_name)
        image_id = ditto_persona["image_id"]
    except Exception as e:
        log.exception("Avatar listing: Ditto failed: %s", e)
        raise HTTPException(502, f"Ditto failed: {e}") from e
    try:
        voice_id = _chatterbox_clone_voice(voice_bytes, ditto_name)
    except Exception as e:
        log.exception("Avatar listing: Chatterbox failed: %s", e)
        raise HTTPException(502, f"Voice clone failed: {e}") from e
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
    face: UploadFile = File(None),
    voice: UploadFile = File(None),
    avatar_listing_id: str = Form(""),
    assigned_role_pack_id: str = Form(""),
    assigned_listing_ids: str = Form(""),
    documents: list[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_user),
):
    """
    Accept persona creation and return 202 immediately. Either provide avatar_listing_id (purchased
    avatar: use its image_id and voice_id) or upload face + voice. Optional assigned_role_pack_id,
    assigned_listing_ids (JSON array of integration listing IDs), and documents (PDF/TXT for knowledge base).
    Creation runs in the background so nginx doesn't timeout.
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

    # Save optional knowledge base documents to kb/persona_id before background job (so sync can process them)
    if documents:
        kb_dir = _kb_persona_dir(persona_id)
        docs_meta: list[dict] = []
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
    assigned_role_pack_id: str | None = None,
    assigned_listing_ids: list[str] | None = None,
) -> None:
    """Run in thread: Ditto (or use avatar), Chatterbox (or use avatar), 30s idle video, save. Logs errors; sets creation_status on failure."""
    log.info("Background create: starting persona_id=%s name=%s", persona_id, name)
    if avatar_image_id and avatar_voice_id:
        image_id = avatar_image_id
        preview_url = f"{DITTO_API_URL}/personas/{image_id}/preview"
        voice_id = avatar_voice_id
        log.info("Background create: using avatar image_id=%s voice_id=%s", image_id, voice_id)
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
            voice_id = _chatterbox_clone_voice(voice_bytes, name)
        except Exception as e:
            log.exception("Background create: Chatterbox failed for persona_id=%s: %s", persona_id, e)
            creation_status[persona_id] = {"status": "failed", "error": str(e)}
            return
        log.info("Background create: Chatterbox OK persona_id=%s voice_id=%s", persona_id, voice_id)
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
) -> None:
    """Read WebSocket messages in background; collect video bytes after sending_video.
    If segment_queue is set, put each binary chunk there (and None when done) for Phase 2 streaming.
    """
    try:
        receiving_video = False
        async for message in ws:
            if isinstance(message, str):
                data = json.loads(message)
                if data.get("error"):
                    read_error.append(RuntimeError(data["error"]))
                    if segment_queue is not None:
                        segment_queue.put_nowait(None)
                    return
                status = data.get("status", "")
                if status == "sending_video":
                    receiving_video = True
                elif status == "done":
                    if segment_queue is not None:
                        segment_queue.put_nowait(None)
                    return
            elif isinstance(message, bytes) and receiving_video:
                video_chunks.append(message)
                if segment_queue is not None:
                    segment_queue.put_nowait(message)
        if segment_queue is not None:
            segment_queue.put_nowait(None)
    except ConnectionClosed:
        if not video_chunks and not read_error:
            read_error.append(RuntimeError("Ditto closed connection before sending video"))
        if segment_queue is not None:
            segment_queue.put_nowait(None)
    except Exception as e:
        read_error.append(e)
        if segment_queue is not None:
            segment_queue.put_nowait(None)

async def ditto_stream_generate(
    image_id: str,
    audio_float32_16k: bytes,
    output_path: str,
    segment_queue: asyncio.Queue[bytes | None] | None = None,
) -> None:
    """WebSocket streaming: send float32 16 kHz mono audio to Ditto /stream, receive MP4 (or fMP4), write to output_path.
    If segment_queue is set, each binary chunk is also put there for Phase 2 SSE streaming (caller yields video_segment events).
    """
    if not audio_float32_16k:
        raise RuntimeError("Ditto stream: no audio bytes to send")
    ws_base = _ditto_streaming_url()
    ws_url = f"{ws_base}/stream?image_id={image_id}"
    log.info("Ditto stream: connecting to %s (sending %s bytes, then empty binary for end)", ws_url, len(audio_float32_16k))
    video_chunks: list[bytes] = []
    read_error: list[Exception | None] = []
    try:
        async with websockets.connect(
            ws_url, close_timeout=30, max_size=2**26,
            ping_interval=20, ping_timeout=120,
            open_timeout=30,
        ) as ws:
            reader_task = asyncio.create_task(
                _ditto_stream_reader(ws, video_chunks, read_error, segment_queue)
            )

            chunk_size = 65536
            for i in range(0, len(audio_float32_16k), chunk_size):
                await ws.send(audio_float32_16k[i : i + chunk_size])
            await ws.send(b"")

            await reader_task
            if read_error:
                raise read_error[0]

        full_mp4 = b"".join(video_chunks)
        if not full_mp4:
            log.warning("Ditto stream: no video data received for %s", output_path)
        else:
            with open(output_path, "wb") as f:
                f.write(full_mp4)
            log.info("Ditto stream: wrote %s (%s bytes, %s chunks)", output_path, len(full_mp4), len(video_chunks))
    except Exception as e:
        log.exception("Ditto stream failed for %s", output_path)
        raise
    finally:
        if segment_queue is not None:
            segment_queue.put_nowait(None)


def ditto_generate_post(image_id: str, audio_wav_bytes: bytes, output_path: str) -> None:
    """POST /generate: send audio WAV + image_id, receive MP4. Used only for idle video on persona create."""
    url = f"{DITTO_API_URL}/generate"
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
) -> str:
    """
    Synchronous worker (runs in executor).
    Streams Ollama /api/chat with stream=true, detects completed sentences,
    puts each onto sentence_queue. Puts None when done. Returns full assistant text.
    """
    url = f"{ollama_url.rstrip('/')}/api/chat"
    payload = {"model": ollama_model, "messages": messages, "stream": True}
    content = ""
    emitted_up_to = 0
    t0 = time.monotonic()
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
                    # Yield sentences as they form: match punctuation followed by space/newline or end of string
                    matches = list(re.finditer(r"(?<=[.?])(?:\s+|$)|(?:\s*\n\s*)+", content[emitted_up_to:]))
                    if matches:
                        last_match = matches[-1]
                        block = content[emitted_up_to : emitted_up_to + last_match.end()]
                        for s in _chunk_by_sentences(block):
                            s = s.strip()
                            if s:
                                log.info("Ollama: sentence yielded (+%.2fs): %s", time.monotonic()-t0, s[:40])
                                asyncio.run_coroutine_threadsafe(sentence_queue.put(s), loop).result()
                        emitted_up_to += last_match.end()
                    
                    if data.get("done"): break
        
        # Flush
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
                
                # Yield sentences as they form: match punctuation followed by space/newline or end of string
                matches = list(re.finditer(r"(?<=[.?])(?:\s+|$)|(?:\s*\n\s*)+", content[emitted_up_to:]))
                if matches:
                    last_match = matches[-1]
                    sentence_block = content[emitted_up_to : emitted_up_to + last_match.end()]
                    for s in _chunk_by_sentences(sentence_block):
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
                        ditto_stream_generate(self.image_id, self._silence, c_path, s_queue)
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
    if use_ollama:
        openai_task = asyncio.ensure_future(
            loop.run_in_executor(
                None,
                _stream_ollama_sentences_sync,
                ollama_url,
                ollama_model,
                messages,
                sentence_queue,
                loop,
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
        openai_task = asyncio.ensure_future(
            loop.run_in_executor(
                None, _stream_openai_sentences_sync, client, messages, sentence_queue, loop
            )
        )
        log.info("Chat timing: OpenAI stream started (stream=True)")

    async def prefetch_clip(idx, text_to_prefetch):
        """Prepare TTS and start Ditto generation for a clip index."""
        try:
            log.info("Prefetch: clip %s (%s chars)", idx, len(text_to_prefetch))
            # 1. TTS
            t_tts0 = time.monotonic()
            wav_data = await loop.run_in_executor(None, _chatterbox_tts_wav, voice_id, text_to_prefetch)
            log.info("Prefetch: TTS done in %.2fs for clip %s", time.monotonic() - t_tts0, idx)
            if not wav_data or len(wav_data) < 44:
                return {"error": "Invalid WAV"}
            
            # 2. Conversion
            audio_f32_data = _wav_to_16k_float32_mono(wav_data)
            if not audio_f32_data or len(audio_f32_data) < 6400:
                return {"error": "Audio too short"}
            
            # 3. Ditto Start
            c_path = str(DATA_DIR / f"reply_{persona_id}_{reply_id}_{idx}.mp4")
            s_queue = asyncio.Queue()
            d_fut = asyncio.ensure_future(
                ditto_stream_generate(image_id, audio_f32_data, c_path, s_queue)
            )
            return {
                "index": idx,
                "text": text_to_prefetch,
                "wav": wav_data,
                "audio_f32": audio_f32_data,
                "path": c_path,
                "segment_queue": s_queue,
                "ditto_fut": d_fut,
            }
        except Exception as pre_err:
            log.exception("Prefetch failed for clip %s: %s", idx, pre_err)
            return {"error": str(pre_err)}

    sentences_log: list[str] = []
    clip_index = 0
    stream_ended = False

    async def get_next_bundle():
        nonlocal stream_ended
        bundle = []
        needed = FIRST_CLIP_SENTENCES if clip_index == 0 else SENTENCES_PER_CLIP
        while len(bundle) < needed and not stream_ended:
            try:
                s = await asyncio.wait_for(sentence_queue.get(), timeout=30.0)
                if s is None:
                    stream_ended = True
                    break
                bundle.append(s)
                sentences_log.append(s)
            except asyncio.TimeoutError:
                break
        return " ".join(bundle) if bundle else None

    FIRST_CLIP_SENTENCES = 1
    
    async def get_and_prefetch(idx):
        bundle = await get_next_bundle()
        if not bundle:
            return None
        return await prefetch_clip(idx, bundle)

    # Start preparing the first clip immediately
    prefetch_task = asyncio.create_task(get_and_prefetch(0))
    
    try:
        while True:
            # Wait for the current clip's pre-generation to finish (if not already done)
            clip_data = await prefetch_task
            if not clip_data:
                break
            
            i = clip_index
            clip_index += 1
            current_text = clip_data["text"]
            
            # IMMEDIATELY start preparing the NEXT clip while we stream this one
            prefetch_task = asyncio.create_task(get_and_prefetch(i + 1))
            
            if "error" in clip_data:
                log.error("Clip %s failed: %s", i, clip_data["error"])
                yield ("event", "error", {"index": i, "error": clip_data["error"]})
                break
            
            # Yield binary data for the current clip
            seq_queue = clip_data["segment_queue"]
            ditto_fut = clip_data["ditto_fut"]
            
            segment_count = 0
            while True:
                try:
                    # Shorter timeout during binary yield to keep connection alive
                    chunk = await asyncio.wait_for(seq_queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    yield ("keepalive",)
                    continue
                
                if chunk is None:
                    break
                
                if segment_count == 0:
                    log.info("Pipeline: emitting video_start for clip %s at +%.2fs", i, time.monotonic() - t_start)
                    yield ("event", "video_start", {"index": i})
                
                segment_count += 1
                yield ("binary", i, chunk)
            
            # Wait for render cleanup
            try: await ditto_fut
            except: pass
            
            log.info("Pipeline: clip %s finished yielding (%s segments)", i, segment_count)
            yield ("event", "clip", {"index": i, "text": current_text, "streaming": True})

    finally:
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
    voice_id, image_id = p["voice_id"], p["image_id"]
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
            elif item[0] == "keepalive":
                yield ": keepalive\n\n"

    return StreamingResponse(
        stream_clips_sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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

    loop = asyncio.get_event_loop()
    voice_id, image_id = p["voice_id"], p["image_id"]
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
        "Chat WS: request received persona_id=%s webrtc_session_id=%s use_ollama=%s",
        persona_id, webrtc_session_id or "(none)", ws_use_ollama,
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
                    print(f"DEBUG: Chat WS: keepalive send error: {e}", flush=True)
                continue
            
            # Log what we got so we can see if items arrive or loop exits early
            if item is None:
                print(f"DEBUG: Chat WS: CONSUMING None sentinel for reply_id={reply_id}", flush=True)
                break
            
            kind = item[0]
            if kind == "event":
                print(f"DEBUG: Chat WS: SENDING event {item[1]} for reply_id={reply_id}", flush=True)
                async with ws_send_lock:
                    await websocket.send_json({"event": item[1], "data": item[2]})
                sent_count += 1
            elif kind == "binary":
                async with ws_send_lock:
                    await websocket.send_bytes(item[2])
                sent_count += 1
            elif kind == "keepalive":
                async with ws_send_lock:
                    await websocket.send_json({"event": "keepalive", "data": {}})
                sent_count += 1
    except WebSocketDisconnect:
        print(f"DEBUG: Chat WS: WebSocketDisconnect for reply_id={reply_id}", flush=True)
    except asyncio.CancelledError:
        print(f"DEBUG: Chat WS: CancelledError for reply_id={reply_id}", flush=True)
    except Exception as e:
        print(f"ERROR: Chat WS loop: {e}", flush=True)
        log.exception("Chat WS: Exception sent_count=%s %s", sent_count, e)
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
