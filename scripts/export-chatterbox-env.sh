#!/usr/bin/env bash
# Writes docker-data/.env.chatterbox.runtime for docker-compose chatterbox service.
# Captures env from a running chatterbox-api container, or creates a stub if none exists.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/docker-data/chatterbox"
OUT="$ROOT/docker-data/.env.chatterbox.runtime"
if docker inspect chatterbox-api >/dev/null 2>&1; then
  docker inspect chatterbox-api -f '{{range .Config.Env}}{{println .}}{{end}}' >"$OUT"
  echo "Wrote $OUT from container chatterbox-api"
else
  : >"$OUT"
  echo "# Add at least HF_TOKEN=... if you use Hugging Face–gated models" >>"$OUT"
  echo "HF_TOKEN=" >>"$OUT"
  echo "Wrote stub $OUT (no chatterbox-api container). Edit before compose up."
fi
