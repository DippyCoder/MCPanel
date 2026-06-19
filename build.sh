#!/bin/bash
# MCPanel Build Script (Tauri)
# Usage: ./build.sh [appimage|deb|rpm|linux|all|clean]
#        No argument → interactive menu

set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="src-tauri/target/release/bundle"

ok()  { echo "  [OK]  $*"; }
err() { echo "  [!!]  $*" >&2; exit 1; }
msg() { echo "  [*]   $*"; }

check_deps() {
    command -v cargo >/dev/null 2>&1 || err "Rust not found. Install from: https://rustup.rs"

    if ! cargo tauri --version >/dev/null 2>&1; then
        msg "Tauri CLI not found – installing..."
        cargo install tauri-cli --version "^2" --locked
    fi

    if [[ "$(uname -s)" == "Linux" ]]; then
        if command -v apt-get >/dev/null 2>&1; then
            for pkg in libwebkit2gtk-4.1-dev libssl-dev pkg-config; do
                dpkg -s "$pkg" >/dev/null 2>&1 || {
                    msg "Installing system dependency: $pkg"
                    sudo apt-get install -y "$pkg"
                }
            done
        elif command -v dnf >/dev/null 2>&1; then
            for pkg in webkit2gtk4.1-devel openssl-devel pkgconf-pkg-config; do
                rpm -q "$pkg" >/dev/null 2>&1 || {
                    msg "Installing system dependency: $pkg"
                    sudo dnf install -y "$pkg"
                }
            done
        fi
    fi
}

build_all() {
    msg "Building Linux packages (AppImage + .deb + .rpm)..."
    (cd src-tauri && cargo tauri build --bundles appimage,deb,rpm)
    echo ""
    ok "AppImage  → $OUT_DIR/appimage/"
    ok ".deb      → $OUT_DIR/deb/"
    ok ".rpm      → $OUT_DIR/rpm/"
}

build_appimage() {
    msg "Building AppImage..."
    (cd src-tauri && cargo tauri build --bundles appimage)
    ok "Output: $OUT_DIR/appimage/"
}

build_deb() {
    msg "Building .deb package..."
    (cd src-tauri && cargo tauri build --bundles deb)
    ok "Output: $OUT_DIR/deb/"
}

build_rpm() {
    msg "Building .rpm package..."
    if command -v dnf >/dev/null 2>&1; then
        rpm -q rpm-build >/dev/null 2>&1 || sudo dnf install -y rpm-build
    elif command -v apt-get >/dev/null 2>&1; then
        err "RPM builds require a Fedora/RHEL system. Use the GitHub Actions workflow or a Fedora container."
    fi
    (cd src-tauri && cargo tauri build --bundles rpm)
    ok "Output: $OUT_DIR/rpm/"
}

do_clean() {
    msg "Cleaning build artifacts (src-tauri/target/)..."
    rm -rf src-tauri/target
    ok "Done."
}

check_deps

if [ -n "${1:-}" ]; then
    case "$1" in
        appimage)    build_appimage ;;
        deb)         build_deb ;;
        rpm)         build_rpm ;;
        linux|all)   build_all ;;
        clean)       do_clean ;;
        *)
            echo "Usage: $0 [appimage|deb|rpm|linux|all|clean]"
            exit 1
            ;;
    esac
    exit 0
fi

echo ""
echo "  MCPanel Build Tool (Tauri)"
echo "  =========================="
echo ""
echo "    [1]  Linux  (AppImage + .deb + .rpm)   →  $OUT_DIR/"
echo "    [2]  Linux  AppImage only"
echo "    [3]  Linux  .deb  (Debian / Ubuntu)"
echo "    [4]  Linux  .rpm  (Fedora / RHEL)"
echo "    [5]  Clean build artifacts"
echo ""
read -rp "  Enter choice (1-5): " CHOICE
echo ""

case "$CHOICE" in
    1) build_all ;;
    2) build_appimage ;;
    3) build_deb ;;
    4) build_rpm ;;
    5) do_clean ;;
    *) err "Invalid choice." ;;
esac

echo ""
