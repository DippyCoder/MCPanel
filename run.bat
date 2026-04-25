@echo off
echo.
echo MCPanel - Minecraft Server Panel
echo ==================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download it from: https://nodejs.org
    pause
    exit /b 1
)

echo [1/4] Checking for MCPanel updates...
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content 'package.json' | ConvertFrom-Json).version" 2^>nul`) do set CURRENT_VER=%%v
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "try{(Invoke-RestMethod 'https://api.github.com/repos/DippyCoder/MCPanel/releases/latest').tag_name}catch{'unknown'}" 2^>nul`) do set LATEST_VER=%%v
echo     Installed : v%CURRENT_VER%
echo     Latest    : %LATEST_VER%
if "%LATEST_VER%"=="v%CURRENT_VER%" (echo     Up to date!) else if "%LATEST_VER%"=="%CURRENT_VER%" (echo     Up to date!) else if not "%LATEST_VER%"=="unknown" (echo     [!] Update available -- https://github.com/DippyCoder/MCPanel/releases)
echo.

echo [2/4] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [3/4] Dependencies installed successfully!
echo.
echo [4/4] Launching MCPanel...
echo.
call npm start
