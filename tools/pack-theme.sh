#!/bin/bash
# Pack a theme folder into a ZIP for distribution.
# Usage:  ./tools/pack-theme.sh <theme-folder>
# e.g.:  ./tools/pack-theme.sh src/themes/dark-slate
#
# Output: <theme-slug>.zip in the current working directory.

set -euo pipefail

THEME_DIR="${1:-}"
if [ -z "$THEME_DIR" ]; then
    echo "Usage: $0 <theme-folder>"
    exit 1
fi

if [ ! -d "$THEME_DIR" ]; then
    echo "Folder not found: $THEME_DIR"
    exit 1
fi

if [ ! -f "$THEME_DIR/theme.json" ]; then
    echo "theme.json not found in $THEME_DIR"
    exit 1
fi

SLUG=$(basename "$THEME_DIR")
OUT="$(pwd)/$SLUG.zip"

# Remove stale zip if it exists
[ -f "$OUT" ] && rm "$OUT"

(cd "$(dirname "$THEME_DIR")" && zip -r "$OUT" "$SLUG")

SIZE=$(du -sh "$OUT" | cut -f1)
echo "Packed \"$SLUG\" → $OUT ($SIZE)"
