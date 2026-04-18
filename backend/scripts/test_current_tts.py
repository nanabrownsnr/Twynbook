import asyncio
import httpx
import logging
import io
import numpy as np
import soundfile as sf
from difflib import SequenceMatcher
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("current_tts_test")

async def test_current_tts_provider():
    """Test the current TTS provider configured in TwynBook."""
    
    # Get personas to find a test voice
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get("http://localhost:8087/api/personas")
            if resp.status_code != 200:
                log.error("Failed to get personas: %s", resp.status_code)
                return
            
            personas = resp.json()
            if not personas:
                log.error("No personas found")
                return
            
            # Use first available persona
            persona = personas[0]
            log.info("Testing with persona: %s (ID: %s)", persona.get("name"), persona.get("id"))
            
            # Test message
            test_message = "Hello, this is a test of the current TTS system."
            
            # Start a chat session to test TTS
            ws_url = f"ws://localhost:8087/v1/chat/completions/{persona['id']}"
            
            log.info("Testing TTS with message: %s", test_message)
            
            # Use HTTP API for testing (simpler than WebSocket)
            async with httpx.AsyncClient(timeout=60.0) as chat_client:
                # This will trigger the full pipeline including TTS
                resp = await chat_client.post(
                    f"http://localhost:8087/v1/chat/completions/{persona['id']}", 
                    json={"message": test_message}
                )
                
                if resp.status_code == 200:
                    log.info("✅ Chat request successful")
                    log.info("Response headers: %s", dict(resp.headers))
                    
                    # Try to read response content
                    content = resp.content
                    if len(content) > 1000:
                        log.info("✅ Received substantial audio data: %d bytes", len(content))
                        
                        # Test STT on the audio
                        try:
                            # Convert to WAV for STT if needed
                            audio_data = content
                            
                            async with httpx.AsyncClient(timeout=30.0) as stt_client:
                                stt_resp = await stt_client.post(
                                    "http://localhost:8090/transcribe",
                                    files={"file": ("test.wav", audio_data, "audio/wav")}
                                )
                                
                                if stt_resp.status_code == 200:
                                    stt_text = stt_resp.json().get("text", "").strip()
                                    log.info("🎯 STT Result: %s", stt_text)
                                    
                                    # Calculate similarity
                                    if stt_text:
                                        similarity = SequenceMatcher(
                                            None, 
                                            test_message.lower(), 
                                            stt_text.lower()
                                        ).ratio()
                                        log.info("📊 Similarity: %.2f%%", similarity * 100)
                                        
                                        if similarity > 0.5:
                                            log.info("🎉 TTS WORKING WELL!")
                                        elif similarity > 0.2:
                                            log.info("✅ TTS IMPROVED!")
                                        else:
                                            log.info("⚠️  TTS needs work")
                                    else:
                                        log.info("⚠️  STT returned empty text")
                                else:
                                    log.error("❌ STT failed: %s", stt_resp.status_code)
                                    
                        except Exception as e:
                            log.error("❌ STT test failed: %s", e)
                            
                    else:
                        log.error("❌ No audio data received: %d bytes", len(content))
                        
                else:
                    log.error("❌ Chat request failed: %s", resp.status_code)
                    log.error("Response: %s", resp.text)
                    
    except Exception as e:
        log.error("❌ Test failed: %s", e)

if __name__ == "__main__":
    asyncio.run(test_current_tts_provider())
