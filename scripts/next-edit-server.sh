#!/usr/bin/env bash
# Serves Zeta 2.1 for next-edit on port 8013, beside the FIM server on 8012.
# Zeta's prompts reach 4096 estimated tokens and its reply rewrites up to a whole editable region, so the context is
# larger than FIM's. Extra arguments pass through to llama-server.
set -euo pipefail

home="${GCODE_HOME:-$HOME/.g-code}"
GCODE_TAB_MODEL="${GCODE_NEXT_EDIT_MODEL:-$home/models/zeta-2.1.Q4_K_M.gguf}" \
  GCODE_TAB_PORT="${GCODE_NEXT_EDIT_PORT:-8013}" \
  exec "$(dirname "$0")/tab-server.sh" --ctx-size 8192 "$@"
