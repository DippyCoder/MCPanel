# MCPanel Build Script (Windows / PowerShell)
# Usage: .\build-windows.ps1 [nsis|all|linux|clean]
#        No argument → interactive menu

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Definition)

$OUT_DIR = "src-tauri\target\release\bundle"

function Ok  { param($msg) Write-Host "  [OK]  $msg" -ForegroundColor Green }
function Err { param($msg) Write-Host "  [!!]  $msg" -ForegroundColor Red; exit 1 }
function Msg { param($msg) Write-Host "  [*]   $msg" -ForegroundColor Cyan }

function Check-Deps {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        Err "Rust not found. Install from: https://rustup.rs"
    }

    $tauriVer = cargo tauri --version 2>&1
    if ($LASTEXITCODE -ne 0 -or $tauriVer -notmatch "tauri") {
        Msg "Tauri CLI not found – installing..."
        cargo install tauri-cli --version "^2" --locked
        if ($LASTEXITCODE -ne 0) { Err "Failed to install Tauri CLI." }
    }
}

function Build-Nsis {
    Msg "Building NSIS installer (.exe)..."
    Push-Location src-tauri
    cargo tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { Err "Build failed." }
    Pop-Location
    Ok "Output: $OUT_DIR\nsis\"
}

function Build-All {
    Msg "Building Windows packages (NSIS + MSI)..."
    Push-Location src-tauri
    cargo tauri build --bundles nsis,msi
    if ($LASTEXITCODE -ne 0) { Err "Build failed." }
    Pop-Location
    Ok "NSIS → $OUT_DIR\nsis\"
    Ok "MSI  → $OUT_DIR\msi\"
}

function Build-Linux {
    Msg "Cross-compiling Linux binary (x86_64-unknown-linux-gnu) via 'cross'..."
    if (-not (Get-Command cross -ErrorAction SilentlyContinue)) {
        Msg "'cross' not found – installing (requires Docker Desktop to be running)..."
        cargo install cross --locked
        if ($LASTEXITCODE -ne 0) { Err "Failed to install 'cross'." }
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Err "Docker Desktop is required for Linux cross-compilation. Install from: https://www.docker.com/products/docker-desktop"
    }
    rustup target add x86_64-unknown-linux-gnu
    Push-Location src-tauri
    cross build --target x86_64-unknown-linux-gnu --release
    if ($LASTEXITCODE -ne 0) { Err "Build failed." }
    Pop-Location
    Ok "Binary → src-tauri\target\x86_64-unknown-linux-gnu\release\mcpanel"
    Msg "Note: Linux installers (AppImage/deb/rpm) require a Linux machine or the CI workflow."
}

function Do-Clean {
    Msg "Cleaning build artifacts (src-tauri\target\)..."
    Remove-Item -Recurse -Force "src-tauri\target" -ErrorAction SilentlyContinue
    Ok "Done."
}

Check-Deps

if ($args.Count -gt 0) {
    switch ($args[0]) {
        "nsis"  { Build-Nsis;  exit 0 }
        "all"   { Build-All;   exit 0 }
        "linux" { Build-Linux; exit 0 }
        "clean" { Do-Clean;    exit 0 }
        default { Write-Host "Usage: .\build-windows.ps1 [nsis|all|linux|clean]"; exit 1 }
    }
}

Write-Host ""
Write-Host "  MCPanel Build Tool (Windows / Tauri)"
Write-Host "  ====================================="
Write-Host ""
Write-Host "    [1]  Windows  NSIS + MSI  ->  $OUT_DIR\"
Write-Host "    [2]  Windows  NSIS installer (.exe) only"
Write-Host "    [3]  Linux    cross-compile binary (requires Docker Desktop)"
Write-Host "    [4]  Clean build artifacts"
Write-Host ""
$choice = Read-Host "  Enter choice (1-4)"
Write-Host ""

switch ($choice) {
    "1" { Build-All }
    "2" { Build-Nsis }
    "3" { Build-Linux }
    "4" { Do-Clean }
    default { Err "Invalid choice." }
}

Write-Host ""
