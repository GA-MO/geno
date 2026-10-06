#!/bin/sh
# Runs the `vscode` vitest project in a Linux container under Xvfb: `pnpm test:vscode:docker [files...]`.
# GCODE_SCREENSHOTS, if set, names a host folder that receives the screenshots.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
image=gcode-vscode-tests
key=$(printf %s "$repo" | shasum | cut -c1-12)

docker build -q -t "$image" -f "$repo/docker/vscode-tests.Dockerfile" "$repo/docker" >/dev/null

shots=
if [ -n "${GCODE_SCREENSHOTS:-}" ]; then
  mkdir -p "$GCODE_SCREENSHOTS"
  shots="-v $(cd "$GCODE_SCREENSHOTS" && pwd):/shots -e GCODE_SCREENSHOTS=/shots"
fi

# The engine sandbox runs commands in bubblewrap. Docker's default seccomp profile refuses it a user namespace, and its masked
# /proc paths stop it mounting a fresh /proc; both options lift only that, with no added capabilities and no --privileged.
# The container name holds one run per checkout, since the checkout's volume is not safe to share.
# shellcheck disable=SC2086
exec docker run --rm --init --name "gcode-vscode-$key" \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined --shm-size=2g \
  -v "$repo:/src:ro" \
  -v "gcode-vscode-work-$key:/work" \
  -v gcode-vscode-download:/work/.vscode-test \
  -v gcode-vscode-pnpm:/pnpm-store \
  -e GCODE_VSCODE_VERSION="${GCODE_VSCODE_VERSION:-}" \
  $shots \
  "$image" "$@"
