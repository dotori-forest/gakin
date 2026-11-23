#!/usr/bin/env bash
# Builds the Chrome Web Store upload: only files the extension loads at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./manifest.json").version')
mkdir -p dist
out="dist/gakin-${version}.zip"
rm -f "$out"
zip -qr "$out" manifest.json editor.html icons fonts src vendor LICENSE THIRD_PARTY_NOTICES.txt -x "*.DS_Store" "src/page.css" "src/wordmark.css" "icons/og.png"
echo "$out ($(du -h "$out" | cut -f1))"
