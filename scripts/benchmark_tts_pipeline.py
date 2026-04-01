#!/usr/bin/env python3
"""
Approximate TwynBook TTS path: HTTP stream -> ffmpeg -> 16 kHz mono f32le.
Measures time until FIRST_BYTES of f32le output (proxy for first chunk to client).

Requires: curl, ffmpeg on PATH; Qwen + Chatterbox reachable on localhost.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
import urllib.parse
import urllib.request

FIRST_BYTES = 3200 * 4  # ~0.2 s at 16 kHz mono f32 (matches RTC chunk size in main.py)

SHORT = "Hello, this is a short test sentence for timing."
LONG = (
    "This is a longer passage to stress the TTS pipeline a bit more. "
    "We want to see time to first decoded audio chunk versus total synthesis time. "
    "The quick brown fox jumps over the lazy dog near the riverbank."
)


def _get_json(url: str, timeout: float = 5.0) -> dict:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def first_voice_id_qwen() -> str:
    d = _get_json("http://127.0.0.1:8001/api/v1/voices/?page_size=5")
    items = d.get("items") or d.get("voices") or []
    if not items:
        raise SystemExit("No Qwen voices; register one first.")
    return (items[0].get("voice_id") or items[0].get("id") or "").strip()


def first_voice_id_chatterbox() -> str:
    try:
        d = _get_json("http://127.0.0.1:8000/api/voices/")
    except Exception:
        d = _get_json("http://127.0.0.1:8000/api/voices")
    if isinstance(d, list) and d:
        return (d[0].get("voice_id") or d[0].get("id") or "").strip()
    for k in ("voices", "items", "data"):
        v = d.get(k) if isinstance(d, dict) else None
        if isinstance(v, list) and v:
            return (v[0].get("voice_id") or v[0].get("id") or "").strip()
    raise SystemExit("No Chatterbox voices found.")


def pump(src: subprocess.Popen, dst: subprocess.Popen) -> None:
    try:
        assert src.stdout is not None and dst.stdin is not None
        while True:
            chunk = src.stdout.read(65536)
            if not chunk:
                break
            dst.stdin.write(chunk)
    finally:
        try:
            dst.stdin.close()
        except Exception:
            pass


def measure_qwen(voice_id: str, text: str) -> tuple[float, float, int]:
    params = urllib.parse.urlencode(
        {"voice_id": voice_id, "text": text, "language": "English"}
    )
    url = f"http://127.0.0.1:8001/api/v1/tts/stream?{params}"
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            "24000",
            "-ac",
            "1",
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
    curl = subprocess.Popen(
        ["curl", "-sS", "--max-time", "180", url],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    threading.Thread(target=pump, args=(curl, ff), daemon=True).start()
    t0 = time.perf_counter()
    buf = b""
    while len(buf) < FIRST_BYTES:
        piece = ff.stdout.read(FIRST_BYTES - len(buf))
        if not piece:
            break
        buf += piece
    t_first = time.perf_counter()
    # drain rest
    while ff.stdout.read(65536):
        pass
    ff.wait(timeout=30)
    curl.wait(timeout=5)
    t_end = time.perf_counter()
    return (t_first - t0, t_end - t0, len(buf))


def measure_chatterbox(voice_id: str, text: str) -> tuple[float, float, int]:
    params = urllib.parse.urlencode(
        {"voice_id": voice_id, "text": text, "format": "wav"}
    )
    url = f"http://127.0.0.1:8000/api/tts/stream?{params}"
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-loglevel",
            "error",
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
    curl = subprocess.Popen(
        ["curl", "-sS", "--max-time", "180", url],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    threading.Thread(target=pump, args=(curl, ff), daemon=True).start()
    t0 = time.perf_counter()
    buf = b""
    while len(buf) < FIRST_BYTES:
        piece = ff.stdout.read(FIRST_BYTES - len(buf))
        if not piece:
            break
        buf += piece
    t_first = time.perf_counter()
    while ff.stdout.read(65536):
        pass
    ff.wait(timeout=30)
    curl.wait(timeout=5)
    t_end = time.perf_counter()
    return (t_first - t0, t_end - t0, len(buf))


def main() -> None:
    qv = first_voice_id_qwen()
    cv = first_voice_id_chatterbox()
    print(f"Qwen voice_id: {qv}")
    print(f"Chatterbox voice_id: {cv}")
    print(f"Target first output: {FIRST_BYTES} bytes (~{FIRST_BYTES / 4 / 16000:.2f}s @ 16k mono f32)")
    print()

    for label, text in ("SHORT", SHORT), ("LONG", LONG):
        print(f"=== {label} text ({len(text)} chars) ===")
        for name, fn, vid in (
            ("Qwen+ffmpeg (TwynBook path)", measure_qwen, qv),
            ("Chatterbox+ffmpeg (TwynBook path)", measure_chatterbox, cv),
        ):
            ttffs = []
            totals = []
            sizes = []
            for _ in range(3):
                a, b, n = fn(vid, text)
                ttffs.append(a)
                totals.append(b)
                sizes.append(n)
            med_ttf = sorted(ttffs)[1]
            med_tot = sorted(totals)[1]
            med_sz = sorted(sizes)[1]
            print(
                f"  {name}: median time_to_{FIRST_BYTES}b_f32le={med_ttf:.3f}s "
                f"median pipeline_total={med_tot:.3f}s first_read_len={med_sz}"
            )
        print()


if __name__ == "__main__":
    main()
