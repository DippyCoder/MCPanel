#!/bin/bash
# MCPanel Build Script (Tauri)
# Usage: ./build.sh [appimage|deb|rpm|linux|all|clean]
#        No argument → interactive menu

set -euo pipefail
cd "$(dirname "$0")"

# linuxdeploy (used by Tauri's AppImage bundler) is itself an AppImage.
# On Fedora / systems without FUSE mounted, it must extract and run without FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1

# linuxdeploy bundles its own ancient `strip` binary that can't parse the
# `.relr.dyn` ELF section type used by Fedora 43+ libraries. Skip stripping
# to avoid the build failure; the AppImage is slightly larger but works fine.
export NO_STRIP=1

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
        if command -v dnf >/dev/null 2>&1; then
            # Fedora / RHEL / openSUSE (dnf)
            DNF_PKGS=(webkit2gtk4.1-devel openssl-devel pkg-config gcc
                      libappindicator-gtk3-devel librsvg2-devel rpm-build fuse fuse-libs)
            MISSING=()
            for pkg in "${DNF_PKGS[@]}"; do
                rpm -q "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
            done
            if [[ ${#MISSING[@]} -gt 0 ]]; then
                msg "Installing system dependencies via dnf: ${MISSING[*]}"
                sudo dnf install -y "${MISSING[@]}"
            fi
        elif command -v apt-get >/dev/null 2>&1; then
            # Debian / Ubuntu (apt)
            APT_PKGS=(libwebkit2gtk-4.1-dev libssl-dev pkg-config gcc
                      libappindicator3-dev librsvg2-dev rpm fuse libfuse2)
            for pkg in "${APT_PKGS[@]}"; do
                dpkg -s "$pkg" >/dev/null 2>&1 || {
                    msg "Installing system dependency: $pkg"
                    sudo apt-get install -y "$pkg"
                }
            done
        else
            msg "Unknown package manager — make sure webkit2gtk4.1-devel, openssl-devel and pkg-config are installed."
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
    sudo apt-get install -y rpm >/dev/null 2>&1 || true
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
