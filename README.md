<div align="center">
  <img src="public/banner.svg" alt="MCPanel Banner" width="860"/>
</div>

<div align="center">

[![Download](https://img.shields.io/badge/releases-blue?label=download&style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://github.com/DippyCoder/MCPanel/releases)⠀
[![Source](https://img.shields.io/badge/source-code?label=source&style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://github.com/DippyCoder/MCPanel)
[![Discord](https://img.shields.io/badge/discord-join-blue?style=for-the-badge&colorA=19201a&colorB=7B2FBE)](https://discord.gg/xe5BPEd6JA)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge&colorA=19201a&colorB=7B2FBE)](LICENSE)

</div>

This branch hosts community themes for **MCPanel**. Each folder is a self-contained theme — a `theme.json` metadata file and a `theme.css` stylesheet.

---

## 🎨 Installing a Theme

Themes can be installed directly from inside MCPanel:

**Option A — Browse online (recommended)**
1. Open MCPanel → **Settings** → scroll to **Themes**
2. Click **Browse Online** — MCPanel fetches the theme list from this branch
3. Click **Install** on any theme you like

**Option B — Import a ZIP**
1. Download the `.zip` for a theme from this branch (or anywhere else)
2. Open MCPanel → **Settings** → **Themes** → **Import ZIP**
3. Select the downloaded file — the theme is installed instantly

**Option C — Import from URL**
1. Open MCPanel → **Settings** → **Themes** → **Install from URL**
2. Paste a direct link to a `.zip` file and confirm

Once installed, click **Apply** next to the theme. To go back to the default purple-dark look, click **Reset to Default**.

---

## 🛠️ Creating a Theme

A theme is just a folder with two files:

```
my-theme/
├── theme.json   ← metadata
└── theme.css    ← CSS overrides
```

### theme.json

```json
{
  "name": "My Theme",
  "creator": "YourName",
  "creatorUrl": "https://github.com/YourName",
  "version": "1.0.0",
  "appVersion": "1.0.3",
  "description": "A short description of your theme."
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Display name shown in MCPanel |
| `creator` | yes | Your name or handle |
| `creatorUrl` | no | Clickable link next to your name |
| `version` | yes | Theme version (semver) |
| `appVersion` | yes | MCPanel version this targets |
| `description` | no | Short description shown in the browser |

### theme.css

Override CSS variables and component styles. MCPanel's entire UI is built on a set of CSS custom properties — you only need to include the ones you want to change.

**Core variables:**

```css
:root {
  /* Backgrounds */
  --bg-base:      #0d0d0d;   /* app background */
  --bg-surface:   #141414;   /* panels, sidebar */
  --bg-elevated:  #1c1c1c;   /* inputs, buttons */
  --bg-card:      #16161680; /* server/profile cards */
  --bg-hover:     #222222;   /* hover state */

  /* Accent palette (maps to purple-* internally) */
  --purple-900: …;  /* darkest shade */
  --purple-800: …;
  --purple-700: …;
  --purple-600: …;
  --purple-500: …;  /* mid accent */
  --purple-400: …;
  --purple-300: …;
  --purple-200: …;
  --purple-100: …;  /* lightest shade */

  /* Shorthand accent tokens */
  --accent:       #60a5fa;               /* primary accent color */
  --accent-glow:  rgba(96,165,250,0.25); /* glow effects */
  --accent-dim:   rgba(96,165,250,0.10); /* subtle accent fills */

  /* Text */
  --text-primary:   #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted:     #475569;
  --text-accent:    #93c5fd;

  /* Borders */
  --border:       rgba(255,255,255,0.07);
  --border-focus: rgba(96,165,250,0.5);

  /* Shadows */
  --shadow-purple: 0 4px 24px rgba(96,165,250,0.15);
}
```

You can also target specific components directly — see the bundled themes for examples.

---

## 📤 Packing a Theme

Use the included script to produce a `.zip` ready to share or import:

```bash
node tools/pack-theme.js src/themes/my-theme
```

This outputs `my-theme.zip` in the project root.

---

## 🤝 Submitting a Theme

1. Compress your Theme using the steps in `## 🤝 Submitting a Theme`
2. Open a new GitHub Issue with the name:
```
Add new Theme - My Theme
```
3. Attatch your .zip file to the Issue.
4. Wait until someone reviewed it and added it.

Please keep themes tasteful and working — test against the latest MCPanel release before submitting.
