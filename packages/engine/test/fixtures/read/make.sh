#!/bin/sh
# Rebuilds the PDF fixtures on macOS with Google Chrome. The tests read the committed outputs.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$dir/report.pdf" "file://$dir/report.html" 2>/dev/null
swift "$dir/make.swift" "$dir"
