#!/bin/bash
# Run MCPanel.
#
# - Release binary: runs instantly with the frontend embedded.
# - No release binary: builds a release binary (~5-10 min first time),
#   then runs it. Subsequent runs are instant.
#
# NOTE: The debug binary (target/debug/mcpanel) cannot be run directly —
# it requires Tauri's dev file-server. Use "cargo tauri dev" for development.

cd "$(dirname "$0")"

RELEASE_BIN="src-tauri/target/release/mcpanel"

if [ -f "$RELEASE_BIN" ]; then
    exec "$RELEASE_BIN"
fi

echo ""
echo "  MCPanel - Minecraft Server Panel"
echo "  =================================="
echo ""
echo "  No release binary found."
echo "  Building — this takes ~5-10 min on first run."
echo "  Subsequent runs with ./run.sh will be instant."
echo ""

if ! command -v cargo >/dev/null 2>&1; then
    echo "  [ERROR] Rust not installed. Get it from: https://rustup.rs"
    exit 1
fi

if ! cargo tauri --version >/dev/null 2>&1; then
    echo "  [*] Installing Tauri CLI..."
    cargo install tauri-cli --version "^2" --locked
fi

cd src-tauri && cargo tauri build && exec "../$RELEASE_BIN"
