#!/bin/sh
set -eu
# /src is the host checkout, read-only. /work is this checkout's own volume, so its Linux node_modules survive between runs.
rsync -a --delete --exclude node_modules --exclude '/packages/*/dist' --exclude /.vscode-test --exclude /.git --exclude '*.vsix' /src/ /work/
pnpm install --frozen-lockfile --store-dir /pnpm-store --config.confirmModulesPurge=false
pnpm -r build
exec xvfb-run -a -s '-screen 0 1920x1200x24' pnpm vitest run --project vscode "$@"
