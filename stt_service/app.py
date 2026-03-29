import io
import os
import logging
from fastapi import FastAPI, UploadFile, File, HTTPException
import numpy as np
import soundfile as sf

try:
    from faster_whisper import WhisperModel
except Exception as e:
    WhisperModel = None
    _import_error = e
else:
    _import_error = None

log = logging.getLogger("stt")
logging.basicConfig(level=logging.INFO)

MODEL_NAME = os.environ.get("STT_MODEL", "tiny.en")
DEVICE = os.environ.get("STT_DEVICE", "auto")  # auto|cuda|cpu
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "auto")
VAD_FILTER = os.environ.get("STT_VAD_FILTER", "true").lower() in ("1", "true", "yes", "on")

app = FastAPI(title="STT Service", version="0.1.0")
_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    if WhisperModel is None:
        raise RuntimeError(f"faster-whisper import failed: {_import_error}")
    device = DEVICE
    if device == "auto":
        device = "cuda" if os.environ.get("NVIDIA_VISIBLE_DEVICES") not in (None, "", "void", "none") else "cpu"
    compute_type = COMPUTE_TYPE
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    log.info("Loading Whisper model %s on %s (%s)", MODEL_NAME, device, compute_type)
    _model = WhisperModel(MODEL_NAME, device=device, compute_type=compute_type)
    return _model


@app.on_event("startup")
def _startup():
    _load_model()


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if file is None:
        raise HTTPException(400, "No audio file provided")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty audio")
    try:
        audio, sr = sf.read(io.BytesIO(data))
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}")

    if audio is None or len(audio) == 0:
        raise HTTPException(400, "Empty audio samples")

    # Convert to mono float32
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    audio = audio.astype(np.float32)

    model = _load_model()
    segments, info = model.transcribe(audio, language="en", vad_filter=VAD_FILTER)
    text = "".join(seg.text for seg in segments).strip()
    return {"text": text, "language": info.language, "duration": info.duration}
