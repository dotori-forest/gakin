#!/usr/bin/env bash
# Builds the GitHub Pages version into dist/site. It is the same editor page
# as the extension, minus the extension-only service worker and manifest.
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/site
rm -rf "$out"
mkdir -p "$out"
cp editor.html "$out/index.html"
cp privacy.html "$out/privacy.html"
cp -r icons fonts vendor LICENSE THIRD_PARTY_NOTICES.txt "$out/"
mkdir -p "$out/src"
cp src/*.js src/*.css "$out/src/"
rm "$out/src/background.js"
touch "$out/.nojekyll"
echo "$out ($(du -sh "$out" | cut -f1))"
