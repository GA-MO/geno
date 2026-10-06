#!/bin/sh
set -eu
# /src is the host checkout, read-only. /work is one volume every checkout shares, one run at a time; its Linux node_modules survive between runs and pnpm install fits them to this checkout's lockfile.
rsync -a --delete --exclude node_modules --exclude '/packages/*/dist' --exclude /.vscode-test --exclude /.git --exclude '*.vsix' /src/ /work/
pnpm install --frozen-lockfile --store-dir /pnpm-store --config.confirmModulesPurge=false
pnpm -r build
exec xvfb-run -a -s '-screen 0 1920x1200x24' pnpm vitest run --project vscode "$@"
