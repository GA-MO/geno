#!/usr/bin/env bash
set -euo pipefail

home="${GCODE_HOME:-$HOME/.g-code}"
model="${GCODE_TAB_MODEL:-$home/models/qwen2.5-coder-1.5b-q8_0.gguf}"

exec llama-server \
  --model "$model" \
  --alias "$(basename "$model" .gguf)" \
  --host 127.0.0.1 \
  --port "${GCODE_TAB_PORT:-8012}" \
  --n-gpu-layers 99 \
  --flash-attn on \
  --ctx-size 4096 \
  --parallel 1 \
  --cache-reuse 256 \
  --no-webui \
  "$@"
