#!/bin/sh
# Shows that a test catches a defect: `sh scripts/defect-check.sh <file> <from> <to> <test files...>` replaces the
# first <from> in <file> with <to>, runs each test file in its own vitest project, prints whether it failed and its
# first assertion, and puts <file> back whatever happens. A VS Code file gets a `pnpm build` first.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
file=$repo/$1; from=$2; to=$3; shift 3
backup=$(mktemp)
cp "$file" "$backup"
trap 'cp "$backup" "$file"; rm -f "$backup"' EXIT INT TERM
python3 - "$file" "$from" "$to" <<'EOF' || exit 2
import sys
path, old, new = sys.argv[1:4]
text = open(path).read()
if old not in text:
    sys.exit(f'{old!r} is not in {path}')
open(path, 'w').write(text.replace(old, new, 1))
EOF
cd "$repo" || exit 1
for test in "$@"; do
  project=unit
  case "$test" in
    *.integration.test.ts) project=vscode; pnpm build > /dev/null 2>&1 ;;
    *.webview.test.ts) project=webview ;;
  esac
  log=$(mktemp)
  start=$(date +%s)
  if pnpm vitest run --project "$project" "$test" > "$log" 2>&1; then verdict='passed: the defect went unseen'; else verdict='failed'; fi
  echo "$(basename "$test"): $verdict in $(($(date +%s) - start))s. $(grep -m1 -E 'AssertionError|Error: ' "$log" | cut -c1-240)"
  rm -f "$log"
done
