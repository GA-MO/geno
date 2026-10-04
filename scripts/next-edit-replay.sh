#!/usr/bin/env bash
# One measured replay run on a fresh next-edit server, so llama-server's RAM prompt cache holds nothing from earlier
# runs. Usage: scripts/next-edit-replay.sh <label> <history N> [llama-server args...]
# Writes docs/results/<label>.txt (the printed summary) and docs/results/<label>.jsonl (one row per moment).
set -euo pipefail

label="$1"
history="$2"
shift 2
root="$(cd "$(dirname "$0")/.." && pwd)"
results="$root/docs/results"
port="${GCODE_NEXT_EDIT_PORT:-8013}"
mkdir -p "$results"
rm -f "$results/$label.jsonl"

"$root/scripts/next-edit-server.sh" "$@" >"$results/$label.server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null || true' EXIT

until curl -sf "http://127.0.0.1:$port/health" >/dev/null; do
  kill -0 "$server" 2>/dev/null || { echo "server exited; see $results/$label.server.log" >&2; exit 1; }
  sleep 1
done

{
  echo "label: $label"
  echo "server args: --ctx-size 8192 $*"
  echo "llama-server: $(llama-server --version 2>&1 | grep version)"
  pnpm --silent --dir "$root" gcode tab replay --history "$history" --endpoint "http://127.0.0.1:$port" --out "$results/$label.jsonl"
} | tee "$results/$label.txt"
rm -f "$results/$label.server.log"
