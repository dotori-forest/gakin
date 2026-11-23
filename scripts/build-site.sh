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

# Cache busting: Safari kept the old editor.css/editor.js after a deploy and
# mixed them with the new page, which broke the layout. Every deploy gets its
# own ?v= on the stylesheet, the entry script and every import inside src/, so
# a new page always loads the scripts and styles that came with it.
version="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
sed -i -E "s#(href|src)=\"(src/[^\"?]+\.(css|js))\"#\1=\"\2?v=$version\"#g" "$out/index.html"
sed -i -E "s#((from |import\()\"\.{1,2}/[^\"?]+\.m?js)\"#\1?v=$version\"#g" "$out"/src/*.js

touch "$out/.nojekyll"
echo "$out ($(du -sh "$out" | cut -f1))"
