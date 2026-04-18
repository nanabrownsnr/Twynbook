import os
import asyncio
import logging
import numpy as np
import soundfile as sf
from pathlib import Path

# Add backend to path
import sys
sys.path.append(str(Path(__file__).parent))

from main import _cosyvoice_cache_speaker_triton, _start_cosyvoice_stream_to_audio_queue
import time

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("test_correct")

async def test_cosyvoice_with_correct_ref():
    """Test CosyVoice with correct reference text."""
    
    # Test persona data
    voice_id = "90eeb033100a48bea72ab56b92c21610"  # Nana's ID
    voice_wav_path = "/home/nbrown/twynbook/backend/scripts/nana_voice.wav"
    # Correct reference text from actual audio transcription
    voice_ref_text = "This is my standard voice sample for my digital tune. I speak clearly at steady pace with a natural tone. The system will use this recording to learn my voice and speech patterns. I always avoid long pauses and speak naturally at all times."
    
    test_text = "The quick brown fox jumps over the lazy dog."
    
    log.info("=== Testing CosyVoice with CORRECT Reference Text ===")
    log.info("Voice ID: %s", voice_id)
    log.info("Reference text length: %d chars", len(voice_ref_text))
    log.info("Test text: %s", test_text)
    
    # Create audio queue
    q = asyncio.Queue()
    loop = asyncio.get_event_loop()
    
    # Start CosyVoice generation
    start_time = time.time()
    _start_cosyvoice_stream_to_audio_queue(voice_id, voice_wav_path, voice_ref_text, test_text, q, loop)
    
    # Collect audio
    audio_chunks = []
    while True:
        chunk = await q.get()
        if chunk is None:
            break
        audio_chunks.append(chunk)
    
    total_audio = b''.join(audio_chunks)
    duration = len(total_audio) / (16000 * 4)  # 16kHz, 4 bytes per sample (float32)
    
    log.info("Generated audio: %.2f seconds, %.2f MB", duration, len(total_audio) / (1024*1024))
    log.info("Total generation time: %.2fs", time.time() - start_time)
    
    # Save for manual inspection
    with open("/home/nbrown/twynbook/backend/scripts/correct_ref_test.wav", "wb") as f:
        f.write(total_audio)
    
    log.info("Audio saved to: correct_ref_test.wav")
    
    # Test with STT
    try:
        import httpx
        
        # Convert to WAV format for STT
        audio_f32 = np.frombuffer(total_audio, dtype=np.float32)
        audio_int16 = (audio_f32 * 32767).astype(np.int16)
        
        import io
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio_int16, 16000, format='WAV', subtype='PCM_16')
        wav_bytes = wav_buffer.getvalue()
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "http://127.0.0.1:8090/transcribe", 
                files={"file": ("test.wav", wav_bytes, "audio/wav")}
            )
            stt_result = resp.json().get("text", "").strip()
            log.info("STT Result: %s", stt_result)
            
            # Calculate similarity
            from difflib import SequenceMatcher
            similarity = SequenceMatcher(None, test_text.lower(), stt_result.lower()).ratio()
            log.info("Similarity: %.2f%%", similarity * 100)
            
    except Exception as e:
        log.error("STT test failed: %s", e)

if __name__ == "__main__":
    asyncio.run(test_cosyvoice_with_correct_ref())
