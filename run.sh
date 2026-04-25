#!/bin/bash
echo ""
echo "  MCPanel - Minecraft Server Panel"
echo "  =================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed."
    echo "        Install from: https://nodejs.org"
    exit 1
fi

echo "[1/4] Checking for MCPanel updates..."
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

echo "[2/4] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] npm install failed."
    exit 1
fi

echo ""
echo "[3/4] Dependencies installed!"
echo ""
echo "[4/4] Launching MCPanel..."
echo ""
npm start
