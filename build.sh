#!/bin/bash
# MCPanel Build Script
cd "$(dirname "$0")"

echo ""
echo "  MCPanel Build Tool"
echo "  ==================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed."
    echo "        Install from: https://nodejs.org"
    exit 1
fi

echo "[*] Checking for MCPanel updates..."
CURRENT_VER=$(node -pe "require('./package.json').version" 2>/dev/null || echo "unknown")
LATEST_VER=$(curl -s "https://api.github.com/repos/DippyCoder/MCPanel/releases/latest" 2>/dev/null | grep '"tag_name"' | cut -d'"' -f4)
[ -z "$LATEST_VER" ] && LATEST_VER="unknown"
echo "    Installed : v$CURRENT_VER"
echo "    Latest    : $LATEST_VER"
if [ "$LATEST_VER" = "v$CURRENT_VER" ] || [ "$LATEST_VER" = "$CURRENT_VER" ]; then
    echo "    Up to date!"
elif [ "$LATEST_VER" != "unknown" ]; then
    echo "    [!] Update available > https://github.com/DippyCoder/MCPanel/releases"
fi
echo ""

do_install() { npm install; }

build_win() {
    echo "[*] Building Windows  ->  dist/win"
    do_install && npm run build:win
    [ $? -eq 0 ] && echo "[OK] Done! Output: dist/win" || echo "[FAILED] Windows build failed."
}

build_mac() {
    echo "[*] Building macOS  ->  dist/mac"
    do_install && npm run build:mac
    [ $? -eq 0 ] && echo "[OK] Done! Output: dist/mac" || echo "[FAILED] macOS build failed."
}

build_appimage() {
    echo "[*] Building Linux AppImage  ->  dist/linux"
    do_install && npm run build:linux:appimage
    [ $? -eq 0 ] && echo "[OK] Done! Output: dist/linux" || echo "[FAILED] AppImage build failed."
}

build_deb() {
    echo "[*] Building Linux .deb  ->  dist/linux"
    do_install && npm run build:linux:deb
    [ $? -eq 0 ] && echo "[OK] Done! Output: dist/linux" || echo "[FAILED] .deb build failed."
}

build_rpm() {
    echo "[*] Building Linux .rpm  ->  dist/linux"
    do_install && npm run build:linux:rpm
    [ $? -eq 0 ] && echo "[OK] Done! Output: dist/linux" || echo "[FAILED] .rpm build failed."
}

do_clean() {
    echo "[*] Cleaning dist folder..."
    if [ -d dist ]; then
        rm -rf dist
        echo "[OK] dist folder cleared."
    else
        echo "[*] dist folder is already empty."
    fi
}

build_all() {
    do_install
    echo ""
    echo "[1/5] Building Windows  ->  dist/win"
    npm run build:win; WIN=$?
    echo ""
    echo "[2/5] Building macOS  ->  dist/mac"
    npm run build:mac; MAC=$?
    echo ""
    echo "[3/5] Building Linux AppImage  ->  dist/linux"
    npm run build:linux:appimage; IMG=$?
    echo ""
    echo "[4/5] Building Linux .deb  ->  dist/linux"
    npm run build:linux:deb; DEB=$?
    echo ""
    echo "[5/5] Building Linux .rpm  ->  dist/linux"
    npm run build:linux:rpm; RPM=$?
    echo ""
    echo "================================"
    echo "  Build Summary"
    echo "================================"
    [ $WIN -eq 0 ] && echo "  Windows       : [OK]  ->  dist/win"    || echo "  Windows       : [FAILED]"
    [ $MAC -eq 0 ] && echo "  macOS         : [OK]  ->  dist/mac"    || echo "  macOS         : [FAILED]"
    [ $IMG -eq 0 ] && echo "  Linux AppImage: [OK]  ->  dist/linux"  || echo "  Linux AppImage: [FAILED]"
    [ $DEB -eq 0 ] && echo "  Linux .deb    : [OK]  ->  dist/linux"  || echo "  Linux .deb    : [FAILED]"
    [ $RPM -eq 0 ] && echo "  Linux .rpm    : [OK]  ->  dist/linux"  || echo "  Linux .rpm    : [FAILED]"
    echo "================================"
}

if [ -n "$1" ]; then
    case "$1" in
        win)      build_win ;;
        mac)      build_mac ;;
        appimage) build_appimage ;;
        deb)      build_deb ;;
        rpm)      build_rpm ;;
        all)      build_all ;;
        clean)    do_clean ;;
        *)
            echo "[ERROR] Unknown argument: $1"
            echo "Usage: ./build.sh [win|mac|appimage|deb|rpm|all|clean]"
            exit 1
            ;;
    esac
    echo ""
    exit 0
fi

echo "  Select target platform:"
echo ""
echo "    [1]  Windows                        ->  dist/win"
echo "    [2]  macOS                          ->  dist/mac"
echo "    [3]  Linux  (.AppImage)             ->  dist/linux"
echo "    [4]  Linux  (.deb - Debian/Ubuntu)  ->  dist/linux"
echo "    [5]  Linux  (.rpm - Fedora/RHEL)    ->  dist/linux"
echo "    [6]  All platforms"
echo "    [7]  Clean dist folder"
echo ""
read -p "  Enter choice (1-7): " CHOICE
echo ""

case "$CHOICE" in
    1) build_win ;;
    2) build_mac ;;
    3) build_appimage ;;
    4) build_deb ;;
    5) build_rpm ;;
    6) build_all ;;
    7) do_clean ;;
    *) echo "[ERROR] Invalid choice."; exit 1 ;;
esac

echo ""
