import os
import asyncio
import logging
import httpx
import io
import numpy as np
import soundfile as sf
from pathlib import Path
from difflib import SequenceMatcher
import time

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("chatterbox_test")

# Configuration
BACKEND_DIR = Path("/home/nbrown/twynbook/backend")
CHATTERBOX_BASE_URL = "http://localhost:8000"
STT_BASE_URL = "http://localhost:8090"

async def clone_voice_to_chatterbox(voice_wav_path: str, voice_name: str) -> str:
    """Clone a voice to Chatterbox and return the voice_id."""
    log.info("Cloning voice to Chatterbox: %s", voice_name)
    
    try:
        # Read the voice file
        with open(voice_wav_path, "rb") as f:
            voice_data = f.read()
        
        # Clone the voice
        async with httpx.AsyncClient(timeout=120.0) as client:
            files = {"voice_file": (voice_name, voice_data, "audio/wav")}
            data = {"name": voice_name}
            
            resp = await client.post(f"{CHATTERBOX_BASE_URL}/api/voices/clone", files=files, data=data)
            
            if resp.status_code == 200:
                result = resp.json()
                voice_id = result.get("voice_id")
                log.info("Voice cloned successfully: %s", voice_id)
                return voice_id
            else:
                log.error("Voice cloning failed: %s", resp.text)
                return None
                
    except Exception as e:
        log.error("Error cloning voice: %s", e)
        return None

async def get_chatterbox_audio(voice_id: str, text: str) -> bytes:
    """Generate audio using Chatterbox TTS."""
    log.info("TTS: Calling Chatterbox for text: %s...", text[:40])
    t0 = time.monotonic()
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Use streaming endpoint for better performance
            resp = await client.get(
                f"{CHATTERBOX_BASE_URL}/api/tts/stream",
                params={
                    "voice_id": voice_id,
                    "text": text,
                    "format": "wav"
                }
            )
            
            if resp.status_code == 200:
                audio_data = resp.content
                log.info("TTS: Generated in %.2fs, size: %.2f MB", 
                        time.monotonic() - t0, len(audio_data) / (1024*1024))
                return audio_data
            else:
                log.error("TTS failed: %s", resp.text)
                return None
                
    except Exception as e:
        log.error("TTS error: %s", e)
        return None

async def get_stt_transcription(audio_bytes: bytes) -> str:
    """Call Whisper STT."""
    log.info("STT: Transcribing...")
    t0 = time.monotonic()
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{STT_BASE_URL}/transcribe", 
                files={"file": ("test.wav", audio_bytes, "audio/wav")}
            )
            text = resp.json().get("text", "").strip()
            log.info("STT: Done in %.2fs: %s", time.monotonic() - t0, text)
            return text
            
    except Exception as e:
        log.error("STT error: %s", e)
        return ""

async def main():
    log.info("=== Chatterbox Pipeline Quality Test ===")
    
    # Use Nana's voice file
    voice_wav_path = "/home/nbrown/twynbook/backend/scripts/nana_voice.wav"
    voice_name = "nana_test"
    
    # Test text
    test_text = "The quick brown fox jumps over the lazy dog."
    
    # Step 1: Clone voice to Chatterbox
    voice_id = await clone_voice_to_chatterbox(voice_wav_path, voice_name)
    if not voice_id:
        log.error("Failed to clone voice - aborting test")
        return
    
    # Step 2: Generate audio with Chatterbox
    audio_wav = await get_chatterbox_audio(voice_id, test_text)
    if not audio_wav:
        log.error("Failed to generate audio - aborting test")
        return
    
    # Save for manual inspection
    test_out = BACKEND_DIR / "scripts" / "chatterbox_test_output.wav"
    with open(test_out, "wb") as f:
        f.write(audio_wav)
    log.info("Audio saved to: %s", test_out)
    
    # Step 3: Transcribe with STT
    stt_text = await get_stt_transcription(audio_wav)
    
    # Step 4: Report results
    log.info("=== CHATTERBOX TEST RESULTS ===")
    log.info("Target: %s", test_text)
    log.info("STT: %s", stt_text)
    
    # Calculate similarity
    if stt_text:
        similarity = SequenceMatcher(None, test_text.lower(), stt_text.lower()).ratio()
        log.info("Similarity: %.2f%%", similarity * 100)
        
        if similarity > 0.7:
            log.info("🎉 CHATTERBOX TEST PASSED!")
        elif similarity > 0.4:
            log.info("✅ CHATTERBOX TEST IMPROVED!")
        else:
            log.error("❌ CHATTERBOX TEST FAILED")
    else:
        log.error("❌ STT returned empty text")

if __name__ == "__main__":
    asyncio.run(main())
