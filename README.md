<div align="center">
  <img src="public/banner.svg" alt="MCPanel Banner" width="860"/>
</div>

<div align="center">

[![Download](https://img.shields.io/badge/releases-blue?label=download&style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://github.com/DippyCoder/MCPanel/releases)⠀
[![Source](https://img.shields.io/badge/source-code?label=source&style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://github.com/DippyCoder/MCPanel)
[![Discord](https://img.shields.io/badge/discord-join-blue?style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://discord.gg/xe5BPEd6JA)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge&colorA=19201a&colorB=7B2FBE)](LICENSE)

</div>

An open-source Minecraft server panel built with **Tauri** (Rust + WebView) and backed by **[mcpanel-cli](https://github.com/DippyCoder/MCPanel-CLI)**.

---

## Features

- **Multi-server management** - Run and manage multiple Minecraft servers simultaneously
- **Auto version fetching** - Live version lists from official APIs:
  - Paper, Purpur, Folia, Leaf, Velocity (PaperMC / PurpurMC APIs)
  - Vanilla (Mojang launcher manifest)
  - Fabric (FabricMC meta API)
  - Spigot (manual jar via BuildTools)
- **Profiles** - Server presets: add plugins, configs, and properties once, apply to any new server
- **Live Console** - Real-time server output streamed from the CLI supervisor, with command input and history
- **Server Controls** - Start, Stop, Restart, Kill
- **File manager** - Browse, edit, and manage server and profile files without leaving the app
  - Built-in editor with syntax highlighting for `.yml`, `.json`, `.properties`, and more
  - Upload by drag & drop, download files back out to any folder
  - Multi-select to move, download, or delete several items at once
- **Plugin & mod browser** - Search and install straight into a server or profile
  - **Hangar**, **Modrinth**, and **SpigotMC** as sources - the tab list adapts to whether the server runs plugins or mods
  - Installed plugins are detected and can be removed from the same list
- **Backups** - One-click `.zip` snapshots per server, restore or delete from the Backups tab
- **Scheduled tasks** - Restart, start, stop, back up, or run a console command at a set time, once or on repeat
- **Player management** - Roster of known players with whitelist, op, kick, and ban controls
- **Velocity proxy linking** - Point a server at a Velocity proxy in one step: registers it in `velocity.toml` at the try-list position you pick, enables modern forwarding, copies the proxy's forwarding secret into `paper-global.yml`, and sets `online-mode=false`
- **Import & duplicate** - Adopt an existing server folder, duplicate a configured server, or turn a server into a reusable profile
- **Quick settings** - Change port, RAM, Java path, and arguments without opening a modal
- **Storage tracking** - Server folder size with optional per-server storage limits
- **Update checks** - Notifies you when a new MCPanel or `mcpanel-cli` release is out
- **Diagnostic log** - MCPanel's own rotating log (CLI errors, install steps), separate from each server's console
- **Theme system** - Install, browse, and swap themes live without restarting
  - Browse community themes and install with one click
  - Import any theme as a `.zip` or from a direct URL
  - Ships with **Purple Dark**, **Clean Dark**, **Dark Slate**, and **Bright Slate** built in
  - Create your own: `theme.json` + `theme.css` - see the [themes branch](https://github.com/DippyCoder/MCPanel/tree/themes)
- **App icon & fonts** - Pick the titlebar logo colour (or let the theme choose it) and swap the UI and monospace fonts in Settings

---

## Quick Start

### Install a pre-built package (Linux)

Download the latest release from the [releases page](https://github.com/DippyCoder/MCPanel/releases):

| Format | Distro |
|--------|--------|
| `.AppImage` | Any Linux (portable, no install needed) |
| `.deb` | Debian, Ubuntu, Linux Mint, Pop!_OS |
| `.rpm` | Fedora, RHEL, openSUSE |

> **Note:** All three formats need `mcpanel-cli`. If it isn't on your PATH, MCPanel shows a banner on launch - click **Install CLI** and it pulls the CLI in for you. Python 3 + pip must be installed.

#### AppImage
```bash
chmod +x MCPanel_*.AppImage
./MCPanel_*.AppImage
```

#### deb
```bash
sudo dpkg -i mcpanel_*.deb
```

#### rpm
```bash
sudo rpm -i mcpanel_*.rpm
```

#### Manual CLI install (if needed)
```bash
python3 -m pip install --user https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip
```

---

### Install a pre-built package (Windows)

Download the latest release from the [releases page](https://github.com/DippyCoder/MCPanel/releases):

| Format | Notes |
|--------|-------|
| `.msi` | Recommended - installs silently and sets up `mcpanel-cli` automatically |
| `.exe` | NSIS installer - requires Python to be installed first |

> **Prerequisite:** [Python 3](https://www.python.org/downloads/) must be installed before running MCPanel.
> The `.msi` installer auto-installs `mcpanel-cli` via pip and adds it to your PATH during setup.
> If Python wasn't installed at install time, open MCPanel and click **Install CLI** on the banner that appears.

#### MSI (recommended)
1. Download `MCPanel_x.x.x_x64_en-US.msi`
2. Double-click to install - accepts UAC prompt, installs the CLI automatically
3. Launch MCPanel from the Start Menu

#### Manual CLI install (if needed)
```powershell
py -m pip install --user https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip
```

---

### Install a pre-built package (macOS)

Download the `.dmg` from the [releases page](https://github.com/DippyCoder/MCPanel/releases), open it, and drag MCPanel to Applications.

> **Prerequisite:** Python 3 must be installed. The app offers to install `mcpanel-cli` on first launch.
> The build is unsigned, so the first launch needs **right-click → Open** (or Settings → Privacy & Security → Open Anyway).
> The released `.dmg` is built for Apple Silicon - for an Intel-compatible bundle, build from source with `./build-macos.sh universal`.

#### Manual CLI install (if needed)
```bash
python3 -m pip install --user https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip
```

---

### Run from source

**Requirements:**
- [Rust](https://rustup.rs) (stable)
- `libwebkit2gtk-4.1` and `libssl-dev` (Linux)
- Python 3 + pip (for `mcpanel-cli`)

**First run** (compiles the Rust backend, ~2–5 min):
```bash
git clone https://github.com/DippyCoder/MCPanel
cd MCPanel
chmod +x run.sh
./run.sh
```

**Subsequent runs** (instant, uses cached binary):
```bash
./run.sh
```

> This is the equivalent of the old `electron .` / `npm start` workflow.  
> After the first compile, `./run.sh` detects the built binary and launches it directly.

---

## Compiling

Use `build.sh` for an interactive menu, or pass a target directly:

```bash
chmod +x build.sh
./build.sh             # interactive menu
./build.sh linux       # AppImage + .deb + .rpm
./build.sh appimage    # AppImage only
./build.sh deb         # .deb only
./build.sh rpm         # .rpm only
./build.sh windows     # cross-compile an NSIS .exe from Linux
./build.sh clean       # remove build artifacts
```

Output: `src-tauri/target/release/bundle/`

```
src-tauri/target/release/bundle/
├── appimage/  ← MCPanel_x.x.x_amd64.AppImage
├── deb/       ← mcpanel_x.x.x_amd64.deb
└── rpm/       ← mcpanel-x.x.x-1.x86_64.rpm
```

**Windows and macOS** have their own scripts, each with the same interactive menu:

```powershell
.\build-windows.ps1         # interactive menu
.\build-windows.ps1 all     # NSIS .exe + .msi
.\build-windows.ps1 nsis    # NSIS .exe only
```

```bash
./build-macos.sh            # interactive menu
./build-macos.sh dmg        # .dmg for the host architecture
./build-macos.sh universal  # single .dmg for Intel + Apple Silicon
```

**Manual (cargo):**
```bash
cargo install tauri-cli --version "^2" --locked
cd src-tauri
cargo tauri build --bundles appimage,deb,rpm
```

---

## Data directory

All data is stored in a platform-specific directory - the same location used by MCPanel v1 (Electron) and `mcpanel-cli`:

| Platform | Path |
|----------|------|
| Linux | `~/.config/mcpanel/` |
| Windows | `%APPDATA%\mcpanel\` |
| macOS | `~/Library/Application Support/mcpanel/` |

```
<data dir>/
├── config.json         ← server list, active theme
├── app-settings.json   ← app preferences (fonts, icon, behavior)
├── schedules.json      ← scheduled tasks
├── default-theme       ← theme applied to new installs
├── servers/<id>/       ← each server's working directory and JAR
├── profiles/<id>/      ← profile presets
├── themes/<id>/        ← installed themes
├── backups/<id>/       ← server backup .zip files
├── logs/               ← MCPanel's diagnostic log (latest.log + rotations)
└── run/                ← runtime state for running servers (managed by CLI)
```

Upgrading from MCPanel v1 keeps all your servers, profiles, and themes intact - nothing to migrate.

---

## Using Profiles

1. Go to **Profiles** → **New Profile**
2. Enter a name, optionally restrict to software/versions
3. Add files (plugins, configs, server.properties…) from the profile's **Files** tab, its **Plugins** tab, or by clicking **Open Folder**
4. When creating a server, select the profile - all files are copied over

Already have a server set up the way you like it? Open it and use **Create Profile from Server** to pick the folders worth keeping and save them as a profile.

**Profile folder structure:**
```
~/.config/mcpanel/profiles/profile_1234567890/
├── profile.json          ← metadata (don't delete)
├── plugins/
│   ├── NovaEssentials.jar
│   └── LuckPerms.jar
└── server.properties
```

---

## Java Configuration

Each server has its own Java path and arguments (editable in the server detail view):

- **Java Path** - full path to `java`, or just `java` if it's in PATH
- **Java Args** - JVM flags (default: G1GC tuning)

Use **Settings → Scan for Java** to auto-detect installed JDKs.

Recommended flags for large servers:
```
-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch
```

---

## Themes

Themes reskin MCPanel without touching source code. Install from inside the app:

| Method | Steps |
|--------|-------|
| Browse online | Settings → Themes → Browse Online → Install |
| Import ZIP | Settings → Themes → Import ZIP |
| Install from URL | Settings → Themes → Install from URL |

To go back to the default, click **Reset to Default**.

Community themes and authoring docs: [`themes` branch](https://github.com/DippyCoder/MCPanel/tree/themes)

**Pack a theme for distribution:**
```bash
./tools/pack-theme.sh src/themes/my-theme
```

---

## Notes

- **Spigot** requires [BuildTools](https://www.spigotmc.org/wiki/buildtools/). MCPanel creates the server folder but won't download the JAR automatically.
- **Fabric** downloads the server-side installer JAR directly from FabricMC.
- **EULA** - click Accept when prompted; MCPanel writes `eula=true` to the server folder.
- Server processes are managed by the `mcpanel-cli` supervisor daemon - they keep running even if the GUI is closed, and reconnect on relaunch.
- **Scheduled tasks only fire while MCPanel is open** - they are not system cron jobs.
- **Backups** are plain `.zip` archives of the server folder, with `logs/` excluded to save space. Stop the server before restoring one.

This README was created for MCPanel v2.2.0 and requires [MCPanel-CLI v1.2.1](https://github.com/DippyCoder/mcpanel-cli/releases) or newer!


---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust + WebView) |
| Backend | [mcpanel-cli](https://github.com/DippyCoder/MCPanel-CLI) (Python CLI, `mcpanel api` JSON surface) |
| Frontend | Vanilla HTML / CSS / JS |
| Editor | [Ace](https://ace.c9.io) (in-app file editing) |
| Fonts | Poppins + JetBrains Mono (bundled; swappable in Settings) |
| Build | `cargo tauri build` |
| CI/CD | GitHub Actions → AppImage, .deb, .rpm, .msi, .exe, .dmg on release |
