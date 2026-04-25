@echo off
cd /d "%~dp0"
echo.
echo   MCPanel Build Tool
echo   ===================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Not running as Administrator.
    echo     Right-click build.bat and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download it from: https://nodejs.org
    pause
    exit /b 1
)

echo [*] Checking for MCPanel updates...
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content 'package.json' | ConvertFrom-Json).version" 2^>nul`) do set CURRENT_VER=%%v
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "try{(Invoke-RestMethod 'https://api.github.com/repos/DippyCoder/MCPanel/releases/latest').tag_name}catch{'unknown'}" 2^>nul`) do set LATEST_VER=%%v
echo     Installed : v%CURRENT_VER%
echo     Latest    : %LATEST_VER%
if "%LATEST_VER%"=="v%CURRENT_VER%" (echo     Up to date!) else if "%LATEST_VER%"=="%CURRENT_VER%" (echo     Up to date!) else if not "%LATEST_VER%"=="unknown" (echo     [!] Update available -- https://github.com/DippyCoder/MCPanel/releases)
echo.

if not "%1"=="" (
    if /i "%1"=="win"     goto win
    if /i "%1"=="mac"     goto mac
    if /i "%1"=="linux"   goto linux
    if /i "%1"=="appimage" goto appimage
    if /i "%1"=="deb"     goto deb
    if /i "%1"=="rpm"     goto rpm
    if /i "%1"=="all"     goto all
    if /i "%1"=="clean"   goto clean
    echo [ERROR] Unknown argument: %1
    echo Usage: build.bat [win^|mac^|linux^|appimage^|deb^|rpm^|all^|clean]
    pause
    exit /b 1
)

echo   Select target platform:
echo.
echo     [1]  Windows                       -^>  dist\win
echo     [2]  macOS                         -^>  dist\mac
echo     [3]  Linux  ^(.AppImage^)            -^>  dist\linux
echo     [4]  Linux  ^(.deb - Debian/Ubuntu^) -^>  dist\linux
echo     [5]  Linux  ^(.rpm - Fedora/RHEL^)   -^>  dist\linux
echo     [6]  All platforms
echo     [7]  Clean dist folder
echo.
set /p CHOICE="  Enter choice (1-7): "
echo.

if "%CHOICE%"=="1" goto win
if "%CHOICE%"=="2" goto mac
if "%CHOICE%"=="3" goto appimage
if "%CHOICE%"=="4" goto deb
if "%CHOICE%"=="5" goto rpm
if "%CHOICE%"=="6" goto all
if "%CHOICE%"=="7" goto clean

echo [ERROR] Invalid choice. Please enter 1-7.
pause
exit /b 1

:win
echo [*] Building for Windows  -^>  dist\win
call npm install
npm run build:win
if %errorlevel% equ 0 (echo [OK] Done! Output: dist\win) else (echo [FAILED] Windows build failed.)
goto end

:mac
echo [*] Building for macOS  -^>  dist\mac
call npm install
npm run build:mac
if %errorlevel% equ 0 (echo [OK] Done! Output: dist\mac) else (echo [FAILED] macOS build failed.)
goto end

:linux
:appimage
echo [*] Building Linux AppImage  -^>  dist\linux
call npm install
npm run build:linux:appimage
if %errorlevel% equ 0 (echo [OK] Done! Output: dist\linux) else (echo [FAILED] AppImage build failed.)
goto end

:deb
echo [*] Building Linux .deb  -^>  dist\linux
call npm install
npm run build:linux:deb
if %errorlevel% equ 0 (echo [OK] Done! Output: dist\linux) else (echo [FAILED] .deb build failed.)
goto end

:rpm
echo [*] Building Linux .rpm  -^>  dist\linux
call npm install
npm run build:linux:rpm
if %errorlevel% equ 0 (echo [OK] Done! Output: dist\linux) else (echo [FAILED] .rpm build failed.)
goto end

:all
echo [*] Installing dependencies...
call npm install
echo.

echo [1/4] Building Windows  -^>  dist\win
npm run build:win
if %errorlevel% equ 0 (set WIN_STATUS=[OK]) else (set WIN_STATUS=[FAILED])
echo.

echo [2/4] Building macOS  -^>  dist\mac
npm run build:mac
if %errorlevel% equ 0 (set MAC_STATUS=[OK]) else (set MAC_STATUS=[FAILED])
echo.

echo [3/4] Building Linux AppImage  -^>  dist\linux
npm run build:linux:appimage
if %errorlevel% equ 0 (set IMG_STATUS=[OK]) else (set IMG_STATUS=[FAILED])
echo.

echo [4/4] Building Linux .deb + .rpm  -^>  dist\linux
npm run build:linux:deb
if %errorlevel% equ 0 (set DEB_STATUS=[OK]) else (set DEB_STATUS=[FAILED])
npm run build:linux:rpm
if %errorlevel% equ 0 (set RPM_STATUS=[OK]) else (set RPM_STATUS=[FAILED])
echo.

echo ================================
echo   Build Summary
echo ================================
echo   Windows       : %WIN_STATUS%  -^>  dist\win
echo   macOS         : %MAC_STATUS%  -^>  dist\mac
echo   Linux AppImage: %IMG_STATUS%  -^>  dist\linux
echo   Linux .deb    : %DEB_STATUS%  -^>  dist\linux
echo   Linux .rpm    : %RPM_STATUS%  -^>  dist\linux
echo ================================
echo.
pause
exit /b 0

:clean
echo [*] Cleaning dist folder...
if exist dist (
    rmdir /s /q dist
    echo [OK] dist folder cleared.
) else (
    echo [*] dist folder is already empty.
)
goto end

:end
echo.
pause
exit /b 0
