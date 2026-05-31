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

## ✨ Features

- **Multi-server management** — Run and manage multiple Minecraft servers simultaneously
- **Auto version fetching** — Live version lists from official APIs:
  - Paper, Purpur, Folia, Leaf, Velocity (PaperMC / PurpurMC APIs)
  - Vanilla (Mojang launcher manifest)
  - Fabric (FabricMC meta API)
  - Spigot (manual jar via BuildTools)
- **Profiles** — Server presets: add plugins, configs, and properties once, apply to any new server
- **Live Console** — Real-time server output streamed from the CLI supervisor, with command input and history (↑↓)
- **Server Controls** — Start, Stop, Restart, Kill
- **Quick settings** — Change port, RAM, Java path, and arguments without opening a modal
- **Storage tracking** — Server folder size with optional per-server storage limits
- **Theme system** — Install, browse, and swap themes live without restarting
  - Browse community themes and install with one click
  - Import any theme as a `.zip` or from a direct URL
  - Ships with **Dark Slate** and **Bright Slate** built in
  - Create your own: `theme.json` + `theme.css` — see the [themes branch](https://github.com/DippyCoder/MCPanel/tree/themes)

---

## 🚀 Quick Start

### Install a pre-built package (Linux)

Download the latest release from the [releases page](https://github.com/DippyCoder/MCPanel/releases):

| Format | Distro |
|--------|--------|
| `.AppImage` | Any Linux (portable, no install needed) |
| `.deb` | Debian, Ubuntu, Linux Mint, Pop!_OS |
| `.rpm` | Fedora, RHEL, openSUSE |

> **Note:** The `.deb` package automatically installs `mcpanel-cli` via pip on first install. For `.AppImage` and `.rpm`, the app will offer to install it on first launch.

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

---

### Install a pre-built package (Windows + MacOS)
> **Note:** As long as `mcpanel-cli` isn't available for `Windows` and `MacOS`, v2 is not available. Use v1 if using Windows or MacOS!

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

## 🔨 Compiling

Use `build.sh` for an interactive menu, or pass a target directly:

```bash
chmod +x build.sh
./build.sh             # interactive menu
./build.sh linux       # AppImage + .deb + .rpm
./build.sh appimage    # AppImage only
./build.sh deb         # .deb only
./build.sh rpm         # .rpm only
./build.sh clean       # remove build artifacts
```

Output: `src-tauri/target/release/bundle/`

```
src-tauri/target/release/bundle/
├── appimage/  ← MCPanel_x.x.x_amd64.AppImage
├── deb/       ← mcpanel_x.x.x_amd64.deb
└── rpm/       ← mcpanel-x.x.x-1.x86_64.rpm
```

**Manual (cargo):**
```bash
cargo install tauri-cli --version "^2" --locked
cd src-tauri
cargo tauri build --bundles appimage,deb,rpm
```

---

## 📂 Data directory

All data is stored in **`~/.config/mcpanel/`** — the same directory used by MCPanel v1 (Electron) and `mcpanel-cli`:

```
~/.config/mcpanel/
├── config.json       ← server list, active theme
├── servers/<id>/     ← each server's working directory and JAR
├── profiles/<id>/    ← profile presets
├── themes/<id>/      ← installed themes
└── run/              ← runtime state for running servers (managed by CLI)
```

Upgrading from MCPanel v1 keeps all your servers, profiles, and themes intact — nothing to migrate.

---

## 📦 Using Profiles

1. Go to **Profiles** → **New Profile**
2. Enter a name, optionally restrict to software/versions
3. Click **Open Folder** → add files (plugins, configs, server.properties…)
4. When creating a server, select the profile — all files are copied over

**Profile folder structure:**
```
~/.config/mcpanel/profiles/profile_1234567890/
├── profile.json          ← metadata (don't delete)
├── plugins/
│   ├── EssentialsX.jar
│   └── LuckPerms.jar
└── server.properties
```

---

## ⚙️ Java Configuration

Each server has its own Java path and arguments (editable in the server detail view):

- **Java Path** — full path to `java`, or just `java` if it's in PATH
- **Java Args** — JVM flags (default: G1GC tuning)

Use **Settings → Scan for Java** to auto-detect installed JDKs.

Recommended flags for large servers:
```
-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch
```

---

## 🎨 Themes

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
# outputs my-theme.zip ready to push or share
```

---

## 🔧 Notes

- **Spigot** requires [BuildTools](https://www.spigotmc.org/wiki/buildtools/). MCPanel creates the server folder but won't download the JAR automatically.
- **Fabric** downloads the server-side installer JAR directly from FabricMC.
- **EULA** — click Accept when prompted; MCPanel writes `eula=true` to the server folder.
- Server processes are managed by the `mcpanel-cli` supervisor daemon — they keep running even if the GUI is closed, and reconnect on relaunch.

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust + WebView) |
| Backend | [mcpanel-cli](https://github.com/DippyCoder/MCPanel-CLI) (Python CLI, `mcpanel api` JSON surface) |
| Frontend | Vanilla HTML / CSS / JS |
| Fonts | Poppins + JetBrains Mono |
| Build | `cargo tauri build` |
| CI/CD | GitHub Actions → AppImage, .deb, .rpm on release |
