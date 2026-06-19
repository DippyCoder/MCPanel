# MCPanel Build Script (Windows / PowerShell)
# Usage: .\build-windows.ps1 [nsis|all|clean]
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

function Do-Clean {
    Msg "Cleaning build artifacts (src-tauri\target\)..."
    Remove-Item -Recurse -Force "src-tauri\target" -ErrorAction SilentlyContinue
    Ok "Done."
}

Check-Deps

if ($args.Count -gt 0) {
    switch ($args[0]) {
        "nsis"  { Build-Nsis; exit 0 }
        "all"   { Build-All;  exit 0 }
        "clean" { Do-Clean;   exit 0 }
        default { Write-Host "Usage: .\build-windows.ps1 [nsis|all|clean]"; exit 1 }
    }
}

Write-Host ""
Write-Host "  MCPanel Build Tool (Windows / Tauri)"
Write-Host "  ====================================="
Write-Host ""
Write-Host "    [1]  Windows  NSIS + MSI  ->  $OUT_DIR\"
Write-Host "    [2]  Windows  NSIS installer (.exe) only"
Write-Host "    [3]  Clean build artifacts"
Write-Host ""
$choice = Read-Host "  Enter choice (1-3)"
Write-Host ""

switch ($choice) {
    "1" { Build-All }
    "2" { Build-Nsis }
    "3" { Do-Clean }
    default { Err "Invalid choice." }
}

Write-Host ""
