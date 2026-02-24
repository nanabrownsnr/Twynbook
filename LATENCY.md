# Chat reply latency and how to get to 5–10s

## Current timing (example)

- **First clip emitted:** ~38s since request
- **Ditto:** ~29s (TTS done → first video byte)
- **Rest:** ~9s (OpenAI to 1–2 sentences + TTS + overhead)

So most of the delay is Ditto (neural render + writer + ffmpeg). The pipeline does **not** send any video until the full clip is rendered and encoded.

## Quick wins (no Ditto code changes)

### 1. First clip = 1 sentence (done)

- `FIRST_CLIP_SENTENCES = 1` in the TwynBook backend.
- Less text → fewer frames → less Ditto work. Expect a noticeable drop (e.g. 30–40% less Ditto time if frame count scales with clip length).

### 2. Ditto speed preset and resolution

On the **Ditto** container, set:

```bash
# Fastest preset: fewer diffusion steps, smaller max size
export DITTO_SPEED_PRESET=ultra

# Optional: lower resolution for even faster render
export DITTO_MAX_SIZE=1024
# or 960 / 1280 (ultra default is 1280)
```

- **ultra:** 10 sampling steps, max_size 1280 (vs fast: 25 steps, 1920). Can cut Ditto time roughly in half depending on hardware.
- **DITTO_USE_TRT=1** (if TensorRT engines are built): use TensorRT for warp/decoder for extra speed.

### 3. TTS and OpenAI

- Use a fast TTS engine and keep first-sentence text short (model and prompt).
- Streaming OpenAI is already used; first sentence arrives as soon as the model produces it.

With **1 sentence + DITTO_SPEED_PRESET=ultra** (and optionally lower `DITTO_MAX_SIZE`), first-clip time in the **~15–25s** range is realistic, depending on hardware. Getting reliably into **5–10s** needs the next step.

## Path to 5–10s: incremental (streaming) video from Ditto

Right now Ditto:

1. Runs the full pipeline (all audio windows → all frames).
2. Writes **all** frames to a temp file.
3. Runs ffmpeg on that file and streams fMP4 to the client.

So the **first** video byte is sent only after the **entire** clip is rendered. To get near real time (5–10s to first frame):

- **Stream frames into ffmpeg as they’re ready** instead of writing a full file first.
- Example design:
  - Writer (or a new “pipe” consumer) sends raw frames to **ffmpeg stdin** (e.g. `-f rawvideo -pix_fmt rgb24 -s WxH -r 25 -i pipe:0`).
  - ffmpeg encodes to fMP4 and writes to stdout with `-movflags frag_keyframe+empty_moov+default_base_moof`.
  - The API reads ffmpeg stdout in chunks and sends them over the WebSocket as today.
- Then “time to first byte” = time to render and encode **one keyframe’s worth of frames** (e.g. ~1s of video) instead of the full clip. Playback can start while the rest of the clip is still being rendered.

That requires changes in **Ditto** (e.g. `stream_pipeline_online.py` and `api_streaming.py`): a pipeline that feeds ffmpeg from a pipe and handles audio sync (e.g. two-pass or buffered mux). TwynBook and the frontend can keep using the same SSE/fMP4/MSE path.

## Summary

| Goal              | Action |
|-------------------|--------|
| **~15–25s**       | FIRST_CLIP_SENTENCES=1 (done) + DITTO_SPEED_PRESET=ultra + optional DITTO_MAX_SIZE=1024. |
| **5–10s**        | Implement incremental frame streaming in Ditto (pipe frames → ffmpeg → stream fMP4 as it’s encoded). |
