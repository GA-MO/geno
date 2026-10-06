#!/bin/sh
# Runs the `vscode` vitest project in a Linux container under Xvfb: `pnpm test:vscode:docker [files...]`.
# GCODE_SCREENSHOTS, if set, names a host folder that receives the screenshots.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
image=gcode-vscode-tests
key=$(printf %s "$repo" | shasum | cut -c1-12)

# Docker's VM is small (4 CPUs, 4 GB here) and each run starts a whole VS Code, so runs from several checkouts queue
# here, one at a time, instead of starving each other. A lock whose owner died is taken over.
lock="${HOME}/.g-code/vscode-docker.lock"
mkdir -p "$(dirname "$lock")"
until mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$lock"; continue; fi
  echo "waiting for another vscode docker run (pid ${owner:-?}) to finish" >&2
  sleep 15
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM

docker build -q -t "$image" -f "$repo/docker/vscode-tests.Dockerfile" "$repo/docker" >/dev/null

shots=
if [ -n "${GCODE_SCREENSHOTS:-}" ]; then
  mkdir -p "$GCODE_SCREENSHOTS"
  shots="-v $(cd "$GCODE_SCREENSHOTS" && pwd):/shots -e GCODE_SCREENSHOTS=/shots"
fi

# The engine sandbox runs commands in bubblewrap. Docker's default seccomp profile refuses it a user namespace, and its masked
# /proc paths stop it mounting a fresh /proc; both options lift only that, with no added capabilities and no --privileged.
# One work volume serves every checkout: the lock above lets only one run use it at a time, so it never piles up per worktree.
# shellcheck disable=SC2086
docker run --rm --init --name "gcode-vscode-$key" \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined --shm-size=2g \
  -v "$repo:/src:ro" \
  -v gcode-vscode-work:/work \
  -v gcode-vscode-download:/work/.vscode-test \
  -v gcode-vscode-pnpm:/pnpm-store \
  -e GCODE_VSCODE_VERSION="${GCODE_VSCODE_VERSION:-}" \
  $shots \
  "$image" "$@"
