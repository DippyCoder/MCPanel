#!/bin/bash
# MCPanel Build Script (macOS / Tauri)
# Usage: ./build-macos.sh [dmg|universal|all|clean]
#        No argument → interactive menu
#
# "universal" builds a single DMG that runs on both Intel and Apple Silicon.

set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="src-tauri/target/release/bundle"

ok()  { echo "  [OK]  $*"; }
err() { echo "  [!!]  $*" >&2; exit 1; }
msg() { echo "  [*]   $*"; }

check_deps() {
    # Xcode Command Line Tools
    if ! xcode-select -p >/dev/null 2>&1; then
        msg "Xcode Command Line Tools not found – installing..."
        xcode-select --install
        err "Re-run this script after the Xcode CLT installation finishes."
    fi

    command -v cargo >/dev/null 2>&1 || err "Rust not found. Install from: https://rustup.rs"

    if ! cargo tauri --version >/dev/null 2>&1; then
        msg "Tauri CLI not found – installing..."
        cargo install tauri-cli --version "^2" --locked
    fi
}

add_arm_target() {
    if ! rustup target list --installed | grep -q "aarch64-apple-darwin"; then
        msg "Adding aarch64-apple-darwin target for universal build..."
        rustup target add aarch64-apple-darwin
    fi
}

build_dmg() {
    msg "Building macOS DMG (current architecture)..."
    (cd src-tauri && cargo tauri build --bundles dmg)
    ok "DMG → $OUT_DIR/dmg/"
}

build_universal() {
    msg "Building universal macOS DMG (Intel + Apple Silicon)..."
    add_arm_target
    (cd src-tauri && cargo tauri build --target universal-apple-darwin --bundles dmg)
    ok "Universal DMG → src-tauri/target/universal-apple-darwin/release/bundle/dmg/"
}

build_all() {
    msg "Building macOS packages (universal DMG + .app)..."
    add_arm_target
    (cd src-tauri && cargo tauri build --target universal-apple-darwin --bundles dmg,app)
    ok ".app → src-tauri/target/universal-apple-darwin/release/bundle/macos/"
    ok "DMG  → src-tauri/target/universal-apple-darwin/release/bundle/dmg/"
}

do_clean() {
    msg "Cleaning build artifacts (src-tauri/target/)..."
    rm -rf src-tauri/target
    ok "Done."
}

check_deps

if [ -n "${1:-}" ]; then
    case "$1" in
        dmg)       build_dmg ;;
        universal) build_universal ;;
        all)       build_all ;;
        clean)     do_clean ;;
        *)
            echo "Usage: $0 [dmg|universal|all|clean]"
            exit 1
            ;;
    esac
    exit 0
fi

echo ""
echo "  MCPanel Build Tool (macOS / Tauri)"
echo "  ==================================="
echo ""
echo "    [1]  macOS  Universal DMG + .app (Intel + Apple Silicon)"
echo "    [2]  macOS  Universal DMG only"
echo "    [3]  macOS  DMG for current architecture"
echo "    [4]  Clean build artifacts"
echo ""
read -rp "  Enter choice (1-4): " CHOICE
echo ""

case "$CHOICE" in
    1) build_all ;;
    2) build_universal ;;
    3) build_dmg ;;
    4) do_clean ;;
    *) err "Invalid choice." ;;
esac

echo ""
