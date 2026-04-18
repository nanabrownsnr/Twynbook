import os
import time
import json
import asyncio
import logging
import io
import numpy as np
import soundfile as sf
import httpx
from pathlib import Path

# --- Configuration ---
BACKEND_DIR = Path("/home/nbrown/twynbook/backend")
PERSONAS_FILE = Path("/home/nbrown/twynbook/data/personas.json")
OLLAMA_URL = "http://127.0.0.1:11434"
STT_BASE_URL = "http://localhost:8090"
COSYVOICE_TRITON_URL = "localhost:18001"
COSYVOICE_TRITON_MODEL = "cosyvoice2"

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("test_pipeline")

async def get_ollama_response(prompt: str) -> str:
    """Call Ollama for LLM logic."""
    log.info("LLM: Calling Ollama (qwen2.5:0.5b) for prompt: %s", prompt)
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": "qwen2.5:0.5b",
                "messages": [{"role": "user", "content": prompt}],
                "stream": False
            }
        )
        resp.raise_for_status()
        content = resp.json()["message"]["content"]
        log.info("LLM: Got response in %.2fs (len=%d)", time.monotonic() - t0, len(content))
        return content

async def get_cosyvoice_audio(text: str, voice_wav_path: str, voice_ref_text: str = "") -> bytes:
    """Minimal Triton CosyVoice2 call."""
    import tritonclient.grpc as grpcclient
    from tritonclient.grpc import InferInput, InferRequestedOutput

    log.info("TTS: Calling Triton for text: %s...", text[:40])
    t0 = time.monotonic()

    # Load reference
    audio_data, sr = sf.read(str(voice_wav_path), dtype="float32")
    if audio_data.ndim > 1: audio_data = audio_data.mean(axis=1)
    
    # Resample to 16k for Triton input
    if sr != 16000:
        log.info("TTS: Resampling reference %sHz->16kHz", sr)
        from scipy.signal import resample
        n_out = int(round(len(audio_data) * 16000 / sr))
        audio_data = resample(audio_data, n_out).astype(np.float32)

    client = grpcclient.InferenceServerClient(COSYVOICE_TRITON_URL, verbose=False)
    inputs = []
    
    # Target
    i_tgt = InferInput("target_text", [1, 1], "BYTES")
    i_tgt.set_data_from_numpy(np.array([[text.encode("utf-8")]], dtype=object))
    inputs.append(i_tgt)

    # Reference Audio
    i_ref = InferInput("reference_wav", [1, audio_data.shape[0]], "FP32")
    i_ref.set_data_from_numpy(audio_data.reshape(1, -1))
    inputs.append(i_ref)

    i_len = InferInput("reference_wav_len", [1, 1], "INT32")
    i_len.set_data_from_numpy(np.array([[int(audio_data.shape[0])]], dtype=np.int32))
    inputs.append(i_len)

    # Reference Text
    i_ref_text = InferInput("reference_text", [1, 1], "BYTES")
    i_ref_text.set_data_from_numpy(np.array([[voice_ref_text.encode("utf-8")]], dtype=object))
    inputs.append(i_ref_text)

    outputs = [InferRequestedOutput("waveform")]
    result = client.infer(model_name=COSYVOICE_TRITON_MODEL, inputs=inputs, outputs=outputs, client_timeout=60)
    
    audio_out = result.as_numpy("waveform").reshape(-1)
    
    # Resample output 24k->16k for STT
    from scipy.signal import resample
    n_out = int(round(len(audio_out) * 16000 / 24000))
    audio_16k = resample(audio_out, n_out).astype(np.float32)

    buf = io.BytesIO()
    sf.write(buf, audio_16k, 16000, format="WAV", subtype="PCM_16")
    log.info("TTS: Generated in %.2fs", time.monotonic() - t0)
    return buf.getvalue()

async def get_stt_transcription(audio_bytes: bytes) -> str:
    """Call Whisper."""
    log.info("STT: Transcribing...")
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{STT_BASE_URL}/transcribe", files={"file": ("test.wav", audio_bytes, "audio/wav")})
        text = resp.json().get("text", "").strip()
        log.info("STT: Done in %.2fs: %s", time.monotonic() - t0, text)
        return text

async def main():
    log.info("=== Starting Pipeline Quality Test (Minimal) ===")
    
    # Use Nana (from admin account) - use correct voice file
    nana_ref_wav = "/app/data/voice_2b2f24953f324d85bf14e02f7841c3b8.wav"
    nana_ref_text = "This is my standard voice sample for my digital tune. I speak clearly at steady pace with a natural tone. The system will use this recording to learn my voice and speech patterns. I always avoid long pauses and speak naturally at all times."
    
    # 1. LLM
    llm_text = "I am Nana and I am your digital twin."
    
    # 2. TTS
    audio_wav = await get_cosyvoice_audio(llm_text, nana_ref_wav, nana_ref_text)
    test_out = "/app/backend/scripts/test_output.wav"
    with open(test_out, "wb") as f: f.write(audio_wav)
    
    # 3. STT
    stt_text = await get_stt_transcription(audio_wav)
    
    # 4. Report
    log.info("=== RESULT ===")
    log.info("LLM: %s", llm_text)
    log.info("STT: %s", stt_text)
    
    # Fuzzy match
    from difflib import SequenceMatcher
    score = SequenceMatcher(None, llm_text.lower(), stt_text.lower()).ratio()
    log.info("Similarity: %.2f%%", score * 100)

if __name__ == "__main__":
    asyncio.run(main())
