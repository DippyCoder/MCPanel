use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ─── App State ────────────────────────────────────────────────────────────────

pub struct BackupInProgress {
    pub pid: u32,
    pub zip_path: String,
}

pub struct AppState {
    pub log_streamers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    pub app_handle: AppHandle,
    pub active_backup: Mutex<Option<BackupInProgress>>,
}

pub struct PtyState {
    pub master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    pub writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

pub fn mcpanel_home() -> String {
    if let Ok(v) = std::env::var("MCPANEL_HOME") {
        return v;
    }
    // Must match the path returned by each platform's CLI (mcpanel/paths.py).
    #[cfg(windows)]
    {
        // Matches Electron's app.getPath('userData') on Windows: %APPDATA%\mcpanel
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| {
            format!(
                "{}/AppData/Roaming",
                std::env::var("USERPROFILE").unwrap_or_else(|_| "C:/Users/Default".into())
            )
        });
        return format!("{}/mcpanel", appdata);
    }
    #[cfg(target_os = "macos")]
    {
        // Matches Electron's app.getPath('userData') on macOS:
        // ~/Library/Application Support/mcpanel
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        return format!("{}/Library/Application Support/mcpanel", home);
    }
    // Linux: $XDG_CONFIG_HOME/mcpanel or ~/.config/mcpanel
    let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
        format!(
            "{}/.config",
            std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
        )
    });
    format!("{}/mcpanel", base)
}

fn mcpanel_config_path() -> String {
    format!("{}/config.json", mcpanel_home())
}

pub fn mcpanel_run_dir() -> String {
    format!("{}/run", mcpanel_home())
}

fn mcpanel_themes_dir() -> String {
    format!("{}/themes", mcpanel_home())
}

fn app_logs_dir() -> String {
    format!("{}/logs", mcpanel_home())
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

// On Windows, pip --user installs to %APPDATA%\Python\Python3XX\Scripts\ which is
// not on PATH by default. Enumerate the common locations so mcpanel is always
// found regardless of whether the user updated their PATH.
#[cfg(windows)]
fn windows_python_scripts_paths() -> String {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut paths = Vec::new();
    // Check Python 3.8–3.14 (newest first so the latest takes precedence)
    for minor in (8u32..=14).rev() {
        let candidates = [
            format!("{}\\Python\\Python3{}\\Scripts", appdata, minor),
            format!("{}\\Programs\\Python\\Python3{}\\Scripts", localappdata, minor),
        ];
        for p in candidates {
            if std::path::Path::new(&p).exists() {
                paths.push(p);
            }
        }
    }
    paths.join(";")
}

// Locate the mcpanel-cli executable by checking the filesystem locations where
// `pip --user` / `pipx` install it on each OS — WITHOUT executing anything.
//
// This is the fix for the "1000 windows" fork bomb: on Linux/macOS this GUI
// binary is itself named `mcpanel`, so spawning a bare `mcpanel` from PATH can
// launch another copy of the GUI instead of the Python CLI. Each new GUI re-runs
// the CLI check on startup, which spawns another GUI… → unbounded recursion.
//
// By resolving an ABSOLUTE path to the Python console-script — and explicitly
// skipping our own executable (current_exe) — it becomes impossible to ever
// accidentally launch the GUI as if it were the CLI. User-install locations are
// checked first so a pip/pipx install always wins over anything in /usr/bin.
fn find_cli_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "mcpanel.exe" } else { "mcpanel" };
    let self_exe = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok());

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
        // pip --user installs to %APPDATA%\Python\Python3XX\Scripts (newest first).
        for minor in (8u32..=14).rev() {
            if !appdata.is_empty() {
                candidates.push(format!("{}\\Python\\Python3{}\\Scripts\\{}", appdata, minor, exe).into());
            }
            if !localappdata.is_empty() {
                candidates.push(format!("{}\\Programs\\Python\\Python3{}\\Scripts\\{}", localappdata, minor, exe).into());
            }
        }
        if !userprofile.is_empty() {
            candidates.push(format!("{}\\.local\\bin\\{}", userprofile, exe).into()); // pipx
        }
    }

    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            candidates.push(format!("{}/.local/bin/{}", home, exe).into());      // pip --user (Linux)
            candidates.push(format!("{}/.local/pipx/bin/{}", home, exe).into()); // pipx
            // pip --user on macOS lands in ~/Library/Python/3.x/bin.
            #[cfg(target_os = "macos")]
            for minor in (8u32..=14).rev() {
                candidates.push(format!("{}/Library/Python/3.{}/bin/{}", home, minor, exe).into());
            }
        }
        candidates.push(format!("/usr/local/bin/{}", exe).into());
        #[cfg(target_os = "macos")]
        candidates.push(format!("/opt/homebrew/bin/{}", exe).into()); // Homebrew (Apple Silicon)
        candidates.push(format!("/usr/bin/{}", exe).into());
    }

    for cand in candidates {
        if !cand.is_file() {
            continue;
        }
        // Never return our own GUI binary — resolving symlinks first so a
        // `mcpanel` symlink pointing at the GUI is also caught.
        if let Some(ref me) = self_exe {
            if std::fs::canonicalize(&cand).ok().as_ref() == Some(me) {
                continue;
            }
        }
        // CRITICAL: a system .deb/.rpm install puts the *GUI* binary in /usr/bin
        // (and other shared dirs), so a matching path is NOT proof we found the
        // CLI. On Unix, positively confirm the candidate is the Python console
        // script (text file with a `#!…python` shebang) and not a compiled ELF/
        // Mach-O binary. Spawning a GUI here is exactly the fork bomb, so any
        // non-CLI candidate must be rejected.
        #[cfg(not(windows))]
        if !looks_like_python_cli(&cand) {
            continue;
        }
        return Some(cand);
    }
    None
}

// True only if `path` is a Python console-script: a small text file whose first
// line is a `#!` shebang invoking python. Compiled GUI binaries (ELF on Linux,
// Mach-O on macOS) are rejected, which is what stops us ever launching the GUI
// as if it were the CLI. Windows pip launchers are `.exe` files in pip-only
// Scripts dirs the GUI never installs to, so this check is Unix-only.
#[cfg(not(windows))]
fn looks_like_python_cli(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = [0u8; 128];
    let n = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = &buf[..n];
    if !head.starts_with(b"#!") {
        return false; // ELF/Mach-O and anything non-script falls out here
    }
    let first_line = head.split(|&b| b == b'\n').next().unwrap_or(head);
    String::from_utf8_lossy(first_line).to_lowercase().contains("python")
}

// Program to invoke for the CLI: the resolved absolute path when found, else a
// bare "mcpanel" fallback (only reached when callers have already confirmed the
// CLI exists, so this never reintroduces the fork bomb in practice).
fn cli_program() -> std::ffi::OsString {
    find_cli_path()
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("mcpanel"))
}

// AppImage launchers and some desktop environments strip ~/.local/bin from PATH.
// These helpers prepend the common user-install locations so `mcpanel` (installed
// via pip --user or pipx) is always found regardless of how the app was launched.
fn mcpanel_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new(cli_program());
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{}", extra, path));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let extra = windows_python_scripts_paths();
        if !extra.is_empty() {
            let path = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", extra, path));
        }
    }
    // AppImage bundles its own Python and exports PYTHONHOME/PYTHONPATH pointing
    // inside the AppImage. Those break the system-installed mcpanel CLI because
    // Python can't find its standard library (encodings, etc.). Unset them so the
    // system Python is used when mcpanel is invoked.
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd
}

fn mcpanel_async_cmd() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(cli_program());
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{}", extra, path));
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let extra = windows_python_scripts_paths();
        if !extra.is_empty() {
            let path = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", extra, path));
        }
    }
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd
}

#[tauri::command]
pub async fn check_cli() -> Value {
    use tokio::time::{timeout, Duration};

    // STEP 1 — existence check ONLY, no process spawned. Detect the CLI by
    // finding its file at a known pip/pipx install location. We deliberately do
    // NOT run a bare `mcpanel` to probe for it: on systems where this GUI binary
    // is named `mcpanel`, that probe would open another window (and so on — the
    // "1000 windows" fork bomb). If nothing is on disk, report not-installed
    // without launching anything at all.
    let cli_path = match find_cli_path() {
        Some(p) => p,
        None => {
            crate::app_log::warn("check_cli: MCPanel-CLI not found on this system");
            return serde_json::json!({
                "ok": false,
                "error": "mcpanel CLI not found. Install it from https://github.com/DippyCoder/mcpanel-cli"
            });
        }
    };
    crate::app_log::info(format!("check_cli: found CLI at {}", cli_path.display()));

    // STEP 2 — the CLI exists, so detection already succeeded (ok:true). Reading
    // the version is best-effort enrichment for the UI. Because we exec the
    // resolved absolute path (never our own exe, never a bare PATH lookup), this
    // can't hit the GUI; timeout + kill_on_drop guard against a hung process.
    let mut result = serde_json::json!({ "ok": true });

    if let Ok(Ok(out)) = timeout(
        Duration::from_secs(3),
        mcpanel_async_cmd().args(["api", "version"]).output(),
    ).await {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(v) = serde_json::from_str::<Value>(&stdout)
                .ok()
                .and_then(|v| v["version"].as_str().map(|s| s.to_string()))
            {
                crate::app_log::note_cli_version(&v);
                result["version"] = Value::String(v);
            }
        }
    }

    result
}

#[tauri::command]
pub fn run_cli(args: Vec<String>) -> Result<String, String> {
    let mut argv = vec!["api".to_string()];
    argv.extend(args);
    // Status/file-tree polling happens every few seconds per server and is
    // noise when it's succeeding — only worth a log line when it fails.
    let is_fetch = argv.get(1).map(|s| s == "fetch").unwrap_or(false);
    if !is_fetch {
        crate::app_log::info(format!("run_cli: mcpanel {}", argv.join(" ")));
    }

    let out = mcpanel_cmd()
        .args(&argv)
        .output()
        .map_err(|e| format!("Failed to run mcpanel: {}", e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if is_fetch {
            crate::app_log::error(format!("run_cli: mcpanel {} failed: {}", argv.join(" "), stderr));
        } else {
            crate::app_log::error(format!("  error: {}", stderr));
        }
        return Err(stderr);
    }
    if !is_fetch {
        crate::app_log::info(format!("  ok ({} bytes)", stdout.len()));
    }
    Ok(stdout)
}

// ─── Config ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_config(config: Value) -> Result<(), String> {
    let home = mcpanel_home();
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(mcpanel_config_path(), json).map_err(|e| e.to_string())
}

// ─── Server helpers ───────────────────────────────────────────────────────────

fn read_config() -> Result<Value, String> {
    let raw = std::fs::read_to_string(mcpanel_config_path())
        .unwrap_or_else(|_| r#"{"servers":[],"jdkPaths":[],"activeTheme":null}"#.into());
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_config(cfg: &Value) -> Result<(), String> {
    let home = mcpanel_home();
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(mcpanel_config_path(), json).map_err(|e| e.to_string())
}

fn get_server_dir(id: &str) -> Result<String, String> {
    let cfg = read_config()?;
    cfg["servers"]
        .as_array()
        .and_then(|arr| arr.iter().find(|s| s["id"].as_str() == Some(id)))
        .and_then(|s| s["dir"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Server not found".into())
}

// Mirrors mcpanel-cli's config.write_server_manifest: a copy of this server's
// config entry (minus `dir`, so the manifest stays valid if the folder is
// moved) written into its own directory as mcpanel.json. Some server
// mutations happen natively here in Rust rather than shelling out to the
// CLI, so this needs to run on both sides to keep the manifest in sync with
// whichever app the user touched last.
fn write_server_manifest(server: &Value) {
    let dir = match server.get("dir").and_then(|d| d.as_str()) {
        Some(d) if !d.is_empty() => d,
        _ => return,
    };
    let mut manifest = server.clone();
    if let Some(obj) = manifest.as_object_mut() {
        obj.remove("dir");
    }
    let json = match serde_json::to_string_pretty(&manifest) {
        Ok(j) => j,
        Err(_) => return,
    };
    let path = format!("{}/mcpanel.json", dir);
    let tmp = format!("{}.tmp", path);
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

// ─── Update server (direct config write) ─────────────────────────────────────

#[tauri::command]
pub fn update_server(id: String, updates: Value) -> Result<String, String> {
    let mut cfg = read_config()?;
    let servers = cfg["servers"]
        .as_array_mut()
        .ok_or("No servers array")?;
    let srv = servers
        .iter_mut()
        .find(|s| s["id"].as_str() == Some(&id))
        .ok_or("Server not found")?;

    if let Some(obj) = updates.as_object() {
        let fields: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        if !fields.is_empty() {
            let name = srv["name"].as_str().unwrap_or(&id);
            crate::app_log::info(format!(
                "Updated server \"{}\" ({}) -id {}",
                name, fields.join(", "), id
            ));
        }
        for (k, v) in obj {
            srv[k] = v.clone();
        }
    }

    // Update config file if port changed
    if let Some(port) = updates.get("port").and_then(|p| p.as_i64()) {
        if let Some(dir) = srv["dir"].as_str() {
            let software = srv["software"].as_str().unwrap_or("");
            if software == "velocity" {
                // Velocity: update bind = "host:port" in velocity.toml
                let toml_file = format!("{}/velocity.toml", dir);
                let new_bind = format!("bind = \"0.0.0.0:{}\"", port);
                let contents = std::fs::read_to_string(&toml_file).unwrap_or_default();
                let has_bind = contents.lines().any(|l| {
                    let t = l.trim();
                    t.starts_with("bind") && t.contains('=') && t.contains('"')
                });
                let updated = if has_bind {
                    let mut result = String::new();
                    for line in contents.lines() {
                        let t = line.trim();
                        if t.starts_with("bind") && t.contains('=') && t.contains('"') {
                            result.push_str(&new_bind);
                        } else {
                            result.push_str(line);
                        }
                        result.push('\n');
                    }
                    result
                } else {
                    format!("{}\n{}\n", new_bind, contents.trim_end())
                };
                let _ = std::fs::write(&toml_file, updated);
            } else {
                // Standard servers: update server-port in server.properties
                let props_file = format!("{}/server.properties", dir);
                if let Ok(contents) = std::fs::read_to_string(&props_file) {
                    let re = format!("server-port={}", port);
                    let updated = if contents.contains("server-port=") {
                        let mut result = String::new();
                        for line in contents.lines() {
                            if line.starts_with("server-port=") {
                                result.push_str(&re);
                            } else {
                                result.push_str(line);
                            }
                            result.push('\n');
                        }
                        result
                    } else {
                        format!("{}\n{}\n", contents.trim_end(), re)
                    };
                    let _ = std::fs::write(&props_file, updated);
                }
            }
        }
    }

    let server = srv.clone();
    write_config(&cfg)?;
    write_server_manifest(&server);
    Ok(serde_json::json!({"success": true, "server": server}).to_string())
}

// ─── Accept EULA (direct file write) ─────────────────────────────────────────

#[tauri::command]
pub fn accept_eula(id: String) -> Result<String, String> {
    let dir = get_server_dir(&id)?;
    std::fs::write(format!("{}/eula.txt", dir), "eula=true\n")
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success": true}).to_string())
}

// ─── Duplicate server (direct Rust impl) ─────────────────────────────────────

#[tauri::command]
pub async fn duplicate_server(id: String, new_name: String, app: AppHandle) -> Result<String, String> {
    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": "__dup__", "progress": 0, "status": "Copying server files…"}),
    );

    let mut cfg = read_config()?;
    let src = cfg["servers"]
        .as_array()
        .and_then(|arr| arr.iter().find(|s| s["id"].as_str() == Some(&id)))
        .cloned()
        .ok_or("Server not found")?;

    let src_dir = src["dir"].as_str().ok_or("No dir")?.to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let new_id = format!("srv_{}", now_ms);
    let home = mcpanel_home();
    let new_dir = format!("{}/servers/{}", home, new_id);

    std::fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    copy_dir_all(&src_dir, &new_dir)?;

    let mut new_srv = src.clone();
    new_srv["id"] = Value::String(new_id.clone());
    new_srv["name"] = Value::String(new_name.clone());
    new_srv["dir"] = Value::String(new_dir);
    new_srv["created"] = Value::Number(serde_json::Number::from(now_ms as u64));

    cfg["servers"]
        .as_array_mut()
        .ok_or("No servers array")?
        .push(new_srv.clone());
    write_config(&cfg)?;
    write_server_manifest(&new_srv);

    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": new_id, "progress": 100, "status": "Done!"}),
    );

    Ok(serde_json::json!({"success": true, "server": new_srv}).to_string())
}

// Skips profile.json and mcpanel.json — matches mcpanel-cli's util.copy_dir.
// The manifest is skipped so the duplicate gets its own fresh one (written by
// write_server_manifest above) instead of inheriting the source's id.
fn copy_dir_all(src: &str, dst: &str) -> Result<(), String> {
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {}", src, e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == "profile.json" || name == "mcpanel.json" {
            continue;
        }
        let dest_path = format!("{}/{}", dst, name.to_string_lossy());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            copy_dir_all(&entry.path().display().to_string(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ─── Start server + log streaming ─────────────────────────────────────────────

#[tauri::command]
pub async fn start_server(
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let result = run_cli(vec![
        "start".into(),
        "server".into(),
        "-id".into(),
        id.clone(),
    ])?;

    let parsed: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
    let success = parsed
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if success {
        let run_dir = mcpanel_run_dir();
        let id_clone = id.clone();
        let app = state.app_handle.clone();

        let handle = tokio::spawn(async move {
            stream_log_task(id_clone, app, run_dir).await;
        });
        state
            .log_streamers
            .lock()
            .unwrap()
            .insert(id, handle.abort_handle());
    }

    Ok(result)
}

#[tauri::command]
pub fn stop_log_stream(id: String, state: State<'_, AppState>) {
    if let Some(handle) = state.log_streamers.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

async fn stream_log_task(id: String, app: AppHandle, run_dir: String) {
    let log_path = format!("{}/{}.log.jsonl", run_dir, id);
    let state_path = format!("{}/{}.json", run_dir, id);
    let mut pos = 0usize;
    let mut no_state_count = 0u32;

    // Wait for log file (up to 10 s)
    for _ in 0..40 {
        if std::path::Path::new(&log_path).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    loop {
        if let Ok(content) = tokio::fs::read_to_string(&log_path).await {
            if content.len() > pos {
                let new_content = &content[pos..];
                pos = content.len();
                for line in new_content.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(rec) = serde_json::from_str::<Value>(line) {
                        let _ = app.emit(
                            "server-log",
                            serde_json::json!({
                                "id": id,
                                "line": rec["text"].as_str().unwrap_or(""),
                                "type": rec["type"].as_str().unwrap_or("out")
                            }),
                        );
                    }
                }
            }
        }

        let state_exists = tokio::fs::try_exists(&state_path).await.unwrap_or(false);
        if !state_exists {
            no_state_count += 1;
            if no_state_count >= 3 {
                // Drain final log lines
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                if let Ok(content) = tokio::fs::read_to_string(&log_path).await {
                    if content.len() > pos {
                        for line in content[pos..].lines() {
                            if line.is_empty() {
                                continue;
                            }
                            if let Ok(rec) = serde_json::from_str::<Value>(line) {
                                let _ = app.emit(
                                    "server-log",
                                    serde_json::json!({
                                        "id": id,
                                        "line": rec["text"].as_str().unwrap_or(""),
                                        "type": rec["type"].as_str().unwrap_or("out")
                                    }),
                                );
                            }
                        }
                    }
                }
                let _ = app.emit("server-stopped", serde_json::json!({"id": id, "code": null}));
                break;
            }
        } else {
            no_state_count = 0;
        }

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

// ─── Create server (with download-progress events) ────────────────────────────

#[tauri::command]
pub async fn create_server(args: Vec<String>, app: AppHandle) -> Result<String, String> {
    // Spigot has no prebuilt jar — the CLI compiles it locally with BuildTools,
    // which takes minutes rather than the few seconds a normal jar download takes.
    let is_spigot = args.windows(2).any(|w| {
        (w[0] == "-sw" || w[0] == "--software") && w[1] == "spigot"
    });
    let status_msg = if is_spigot {
        "Building Spigot with BuildTools… (this can take several minutes)"
    } else {
        "Downloading server jar…"
    };

    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": "__creating__", "progress": 5, "status": status_msg}),
    );

    let mut argv = vec!["api".into(), "create".into(), "server".into()];
    argv.extend(args);
    crate::app_log::info(format!("create_server: mcpanel {}", argv.join(" ")));

    // Slow fake progress ticker while CLI runs
    let app2 = app.clone();
    let ticker = tokio::spawn(async move {
        let mut p = 5u8;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            p = (p + 12).min(88);
            let _ = app2.emit(
                "download-progress",
                serde_json::json!({"id": "__creating__", "progress": p, "status": status_msg}),
            );
        }
    });

    let out = mcpanel_async_cmd()
        .args(&argv)
        .output()
        .await
        .map_err(|e| format!("Failed to run mcpanel: {}", e))?;

    ticker.abort();

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let server_id = serde_json::from_str::<Value>(&stdout)
        .ok()
        .and_then(|v| v.pointer("/server/id").and_then(|id| id.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "__creating__".into());

    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": server_id, "progress": 100, "status": "Done!"}),
    );

    if stdout.is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        crate::app_log::error(format!("  error: {}", stderr));
        return Err(stderr);
    }
    crate::app_log::info(format!("  ok ({} bytes)", stdout.len()));
    Ok(stdout)
}

// ─── Import server (with copy-progress events) ───────────────────────────────

#[tauri::command]
pub async fn import_server_cmd(args: Vec<String>, app: AppHandle) -> Result<String, String> {
    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": "__importing__", "progress": 5, "status": "Copying server files…"}),
    );

    let app2 = app.clone();
    let ticker = tokio::spawn(async move {
        let mut p = 5u8;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            p = (p + 15).min(88);
            let _ = app2.emit(
                "download-progress",
                serde_json::json!({"id": "__importing__", "progress": p, "status": "Copying server files…"}),
            );
        }
    });

    let mut argv = vec!["api".into(), "import".into(), "server".into()];
    argv.extend(args);

    let out = mcpanel_async_cmd()
        .args(&argv)
        .output()
        .await
        .map_err(|e| format!("Failed to run mcpanel: {}", e))?;

    ticker.abort();

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let server_id = serde_json::from_str::<Value>(&stdout)
        .ok()
        .and_then(|v| v.pointer("/server/id").and_then(|id| id.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "__importing__".into());

    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": server_id, "progress": 100, "status": "Done!"}),
    );

    if stdout.is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(stderr);
    }
    Ok(stdout)
}

// ─── Send command via unix socket ─────────────────────────────────────────────

// ─── Send command via unix socket ─────────────────────────────────────────────
// Unix sockets are only available on Unix-like systems

#[tauri::command]
#[cfg(unix)]
pub fn send_server_command(id: String, cmd: String) -> Value {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let sock = format!("{}/{}.sock", mcpanel_run_dir(), id);
    match UnixStream::connect(&sock) {
        Ok(mut stream) => {
            let req = format!("{}\n", serde_json::json!({"op": "cmd", "text": cmd}));
            if let Err(e) = stream.write_all(req.as_bytes()) {
                return serde_json::json!({"error": e.to_string()});
            }
            let mut buf = String::new();
            let _ = BufReader::new(&stream).read_line(&mut buf);
            serde_json::from_str(buf.trim()).unwrap_or(serde_json::json!({"ok": true}))
        }
        Err(e) => serde_json::json!({"error": format!("Not running: {}", e)}),
    }
}

#[tauri::command]
#[cfg(not(unix))]
pub fn send_server_command(id: String, cmd: String) -> Value {
    serde_json::json!({"error": "Unix sockets not supported on this platform"})
}

// ─── TCP Ping ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ping_server(host: String, port: u16) -> Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    fn varint(buf: &mut Vec<u8>, mut v: i32) {
        loop {
            let mut b = (v & 0x7F) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            buf.push(b);
            if v == 0 {
                break;
            }
        }
    }

    let addr = format!("{}:{}", host, port);
    let Ok(Ok(mut stream)) = timeout(
        std::time::Duration::from_secs(3),
        TcpStream::connect(&addr),
    )
    .await else {
        return serde_json::json!({"online": false});
    };

    let host_b = host.as_bytes();
    let mut body = Vec::new();
    varint(&mut body, 0x00);
    varint(&mut body, 762);
    varint(&mut body, host_b.len() as i32);
    body.extend_from_slice(host_b);
    body.push(((port >> 8) & 0xFF) as u8);
    body.push((port & 0xFF) as u8);
    varint(&mut body, 1);

    let mut packet = Vec::new();
    varint(&mut packet, body.len() as i32);
    packet.extend_from_slice(&body);
    // Status request packet
    packet.push(1);
    packet.push(0x00);

    if stream.write_all(&packet).await.is_err() {
        return serde_json::json!({"online": false});
    }

    let mut buf = vec![0u8; 8192];
    let Ok(Ok(n)) =
        timeout(std::time::Duration::from_secs(3), stream.read(&mut buf)).await
    else {
        return serde_json::json!({"online": false});
    };

    let text = String::from_utf8_lossy(&buf[..n]);
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if let Ok(data) = serde_json::from_str::<Value>(&text[start..=end]) {
            let motd = match &data["description"] {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            };
            return serde_json::json!({
                "online": true,
                "players": data["players"]["online"].as_i64().unwrap_or(0),
                "maxPlayers": data["players"]["max"].as_i64().unwrap_or(0),
                "playerList": data["players"]["sample"].as_array()
                    .map(|a| a.iter().filter_map(|p| p["name"].as_str()).collect::<Vec<_>>())
                    .unwrap_or_default(),
                "version": data["version"]["name"].as_str().unwrap_or("Unknown"),
                "motd": motd
            });
        }
    }
    serde_json::json!({"online": false})
}

// ─── Theme management ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn ensure_builtin_themes() -> Result<(), String> {
    const THEMES: &[(&str, &str, &str)] = &[
        ("purple-dark",
         include_str!("../../src/themes/purple-dark/theme.css"),
         include_str!("../../src/themes/purple-dark/theme.json")),
        ("clean-dark",
         include_str!("../../src/themes/clean-dark/theme.css"),
         include_str!("../../src/themes/clean-dark/theme.json")),
        ("dark-slate",
         include_str!("../../src/themes/dark-slate/theme.css"),
         include_str!("../../src/themes/dark-slate/theme.json")),
        ("bright-slate",
         include_str!("../../src/themes/bright-slate/theme.css"),
         include_str!("../../src/themes/bright-slate/theme.json")),
    ];
    for (id, css, json) in THEMES {
        let theme_dir = format!("{}/{}", mcpanel_themes_dir(), id);
        std::fs::create_dir_all(&theme_dir).map_err(|e| e.to_string())?;
        std::fs::write(format!("{}/theme.css", theme_dir), css).map_err(|e| e.to_string())?;
        std::fs::write(format!("{}/theme.json", theme_dir), json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn default_theme_path() -> String {
    format!("{}/default-theme", mcpanel_home())
}

#[tauri::command]
pub fn get_default_theme() -> String {
    let path = default_theme_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let _ = std::fs::write(&path, "clean-dark");
    "clean-dark".to_string()
}

#[tauri::command]
pub fn set_default_theme(id: String) -> Result<(), String> {
    std::fs::write(default_theme_path(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn theme_exists(id: String) -> bool {
    std::path::Path::new(&format!("{}/{}/theme.json", mcpanel_themes_dir(), id)).exists()
}

#[tauri::command]
pub fn install_builtin_theme(id: String, css: String, json: String) -> Result<(), String> {
    let dir = format!("{}/{}", mcpanel_themes_dir(), id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(format!("{}/theme.css", dir), css).map_err(|e| e.to_string())?;
    std::fs::write(format!("{}/theme.json", dir), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_themes() -> Vec<Value> {
    let themes_dir = mcpanel_themes_dir();
    let mut themes: Vec<Value> = Vec::new();
    let entries = match std::fs::read_dir(&themes_dir) {
        Ok(e) => e,
        Err(_) => return themes,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("._") || name.starts_with("_tmp_") || name.starts_with("_download_") {
            continue;
        }
        let meta_path = format!("{}/{}/theme.json", themes_dir, name);
        if !std::path::Path::new(&meta_path).exists() {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut meta) = serde_json::from_str::<Value>(&raw) {
                meta["id"] = Value::String(name.clone());
                meta["dir"] = Value::String(format!("{}/{}", themes_dir, name));
                themes.push(meta);
            }
        }
    }
    themes
}

#[tauri::command]
pub fn delete_theme(id: String) -> Result<(), String> {
    let dir = format!("{}/{}", mcpanel_themes_dir(), id);
    if std::path::Path::new(&dir).exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn check_app_update() -> Value {
    let url = "https://api.github.com/repos/DippyCoder/MCPanel/releases/latest";
    let mut curl = std::process::Command::new("curl");
    curl.args(["-fsSL", "--max-time", "10", "-H", "User-Agent: MCPanel", url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        curl.creation_flags(0x08000000);
    }
    match curl.output() {
        Ok(o) if o.status.success() => {
            serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

#[tauri::command]
pub fn check_cli_update() -> Value {
    let url = "https://api.github.com/repos/DippyCoder/mcpanel-cli/releases/latest";
    let mut curl = std::process::Command::new("curl");
    curl.args(["-fsSL", "--max-time", "10", "-H", "User-Agent: MCPanel", url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        curl.creation_flags(0x08000000);
    }
    match curl.output() {
        Ok(o) if o.status.success() => {
            serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

#[tauri::command]
pub fn fetch_github_themes() -> Value {
    let url = "https://raw.githubusercontent.com/DippyCoder/MCPanel/themes/themes-index.json";
    let mut curl = std::process::Command::new("curl");
    curl.args(["-fsSL", "--max-time", "10", url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        curl.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = curl.output();
    match out {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({"themes": []}))
        }
        _ => serde_json::json!({"themes": [], "error": "Failed to fetch themes"}),
    }
}

#[tauri::command]
pub fn install_theme_from_file(path: String) -> Result<Value, String> {
    _install_theme_zip(&path)
}

#[tauri::command]
pub fn install_theme_from_url(url: String) -> Result<Value, String> {
    let themes_dir = mcpanel_themes_dir();
    std::fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let tmp = format!("{}/._download_{}.zip", themes_dir, ts);
    let mut curl = std::process::Command::new("curl");
    curl.args(["-fsSL", "--max-time", "60", "-o", &tmp, &url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        curl.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let status = curl.status().map_err(|e| e.to_string())?;
    let result = if status.success() {
        _install_theme_zip(&tmp)
    } else {
        Err("Download failed".to_string())
    };
    let _ = std::fs::remove_file(&tmp);
    result
}

fn _install_theme_zip(zip_path: &str) -> Result<Value, String> {
    use std::io::Read;
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Find theme.json and read it
    let (meta_str, meta_idx) = {
        let mut found = None;
        for i in 0..archive.len() {
            let name = archive.by_index(i).map_err(|e| e.to_string())?.name().to_string();
            if name.ends_with("theme.json") && !name.starts_with("__MACOSX") {
                found = Some(i);
                break;
            }
        }
        let idx = found.ok_or_else(|| "theme.json not found in archive".to_string())?;
        let mut f = archive.by_index(idx).map_err(|e| e.to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        (s, idx)
    };

    let meta: Value = serde_json::from_str(&meta_str)
        .map_err(|e| format!("Invalid theme.json: {}", e))?;
    if meta["name"].as_str().unwrap_or("").is_empty() {
        return Err("theme.json must include a name field".to_string());
    }

    // Find the directory prefix that contains theme.json
    let prefix = {
        let name = archive.by_index(meta_idx).map_err(|e| e.to_string())?.name().to_string();
        name[..name.len() - "theme.json".len()].to_string()
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let tid = format!("theme_{}", ts);
    let theme_dir = format!("{}/{}", mcpanel_themes_dir(), tid);
    std::fs::create_dir_all(&theme_dir).map_err(|e| e.to_string())?;

    // Re-open archive to extract
    let file2 = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive2 = zip::ZipArchive::new(file2).map_err(|e| e.to_string())?;
    for i in 0..archive2.len() {
        let mut entry = archive2.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().to_string();
        if raw_name.starts_with("__MACOSX") || raw_name.ends_with('/') {
            continue;
        }
        let rel = if raw_name.starts_with(&prefix) { &raw_name[prefix.len()..] } else { &raw_name };
        if rel.is_empty() { continue; }
        let dest = format!("{}/{}", theme_dir, rel);
        if let Some(parent) = std::path::Path::new(&dest).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&dest, buf).map_err(|e| e.to_string())?;
    }

    let mut result = meta.clone();
    result["id"] = Value::String(tid);
    result["dir"] = Value::String(theme_dir);
    Ok(serde_json::json!({"success": true, "theme": result}))
}

// ─── Theme CSS ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_theme_css(id: String) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    let themes_dir = mcpanel_themes_dir();
    let css_path = format!("{}/{}/theme.css", themes_dir, id);
    if !std::path::Path::new(&css_path).exists() {
        return None;
    }
    let css = std::fs::read_to_string(&css_path).ok()?;
    let theme_dir = format!("{}/{}", themes_dir, id);
    Some(rewrite_css_urls(&css, &theme_dir))
}

fn rewrite_css_urls(css: &str, theme_dir: &str) -> String {
    let mut result = String::with_capacity(css.len() + 128);
    let lower = css.to_ascii_lowercase();
    let mut pos = 0usize;

    while let Some(rel_start) = lower[pos..].find("url(") {
        let abs = pos + rel_start;
        result.push_str(&css[pos..abs]);
        // skip "url("
        let after = abs + 4;
        let rest = &css[after..];
        let lower_rest = rest.to_ascii_lowercase();

        let (quote, inner_start) = if rest.starts_with('\'') || rest.starts_with('"') {
            (Some(rest.chars().next().unwrap()), 1usize)
        } else {
            (None, 0usize)
        };

        let inner = &rest[inner_start..];
        let inner_lower = &lower_rest[inner_start..];
        let end_inner = if let Some(q) = quote {
            inner.find(q).unwrap_or(inner.len())
        } else {
            inner.find(')').unwrap_or(inner.len())
        };

        let rel = &inner[..end_inner];
        let is_abs = inner_lower.starts_with("https://")
            || inner_lower.starts_with("http://")
            || inner_lower.starts_with("data:")
            || inner_lower.starts_with("file://")
            || rel.is_empty();

        if is_abs {
            let len = 4 + inner_start + end_inner;
            result.push_str(&css[abs..abs + len]);
            pos = abs + len;
        } else {
            let q = quote.map(|c| c.to_string()).unwrap_or_else(|| "'".into());
            result.push_str(&format!("url({}file://{}/{}{})", q, theme_dir, rel, q));
            // skip past the closing paren
            let consumed = 4 + inner_start + end_inner;
            let remaining = &css[abs + consumed..];
            if let Some(paren) = remaining.find(')') {
                pos = abs + consumed + paren + 1;
            } else {
                pos = css.len();
            }
        }
    }
    result.push_str(&css[pos..]);
    result
}

// ─── Direct log read (used by 15 ms console poll) ────────────────────────────

#[tauri::command]
pub async fn get_log_since(id: String, offset: u64) -> Value {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let log_path = format!("{}/{}.log.jsonl", mcpanel_run_dir(), id);

    let mut file = match tokio::fs::File::open(&log_path).await {
        Ok(f) => f,
        Err(_) => return serde_json::json!({"lines": [], "offset": 0}),
    };

    let total = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return serde_json::json!({"lines": [], "offset": offset}),
    };

    // File was truncated or rotated — restart from the beginning.
    let seek_to = if offset > total { 0 } else { offset };

    if seek_to > 0 {
        let _ = file.seek(SeekFrom::Start(seek_to)).await;
    }

    let mut buf = String::new();
    if file.read_to_string(&mut buf).await.is_err() {
        return serde_json::json!({"lines": [], "offset": offset});
    }

    let lines: Vec<Value> = buf
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();

    serde_json::json!({"lines": lines, "offset": total})
}

// ─── App info ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ─── Open external URL / folder ───────────────────────────────────────────────

#[tauri::command]
pub fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(path: String, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

// ─── File dialogs ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn browse_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .pick_folder(move |p| { let _ = tx.send(p); });
    rx.await.ok().flatten().map(|p| filepath_to_string(p))
}

#[tauri::command]
pub async fn browse_file(
    app: AppHandle,
    title: String,
    extensions: Vec<String>,
) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let ext_refs: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let mut dlg = app.dialog().file();
    if !ext_refs.is_empty() {
        dlg = dlg.add_filter(title, &ext_refs);
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    dlg.pick_file(move |p| { let _ = tx.send(p); });
    rx.await.ok().flatten().map(|p| filepath_to_string(p))
}

fn filepath_to_string(p: tauri_plugin_dialog::FilePath) -> String {
    p.to_string()
}

// ─── Install CLI (for AppImage / rpm users without postinst) ─────────────────

#[tauri::command]
pub async fn install_cli() -> Result<String, String> {
    // Zip archive URL — pip downloads it directly, no git required on any platform.
    const ZIP_URL: &str =
        "https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip";

    // Platform-specific candidate commands.
    // Each entry is (program, args_before_url):
    //   program install --user <ZIP_URL>
    #[cfg(windows)]
    let candidates: &[(&str, &[&str])] = &[
        // py is the Python Launcher, standard on Windows installs
        ("py",      &["-m", "pip", "install", "--user"]),
        ("pip",     &["install", "--user"]),
        ("python",  &["-m", "pip", "install", "--user"]),
    ];
    #[cfg(not(windows))]
    let candidates: &[(&str, &[&str])] = &[
        ("pip3",    &["install", "--user"]),
        ("pip",     &["install", "--user"]),
        ("python3", &["-m", "pip", "install", "--user"]),
    ];

    let mut last_err = String::new();
    for (prog, prefix_args) in candidates {
        let mut cmd = tokio::process::Command::new(prog);
        cmd.args(*prefix_args);
        cmd.arg(ZIP_URL);
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
        match cmd.output().await {
            Ok(o) if o.status.success() => {
                crate::app_log::info("install_cli: mcpanel-cli installed from GitHub zip");

                // On Windows, pip --user installs to a Scripts dir that isn't on PATH
                // by default. Ask the same Python interpreter where it put the scripts,
                // then persist that directory into the user's PATH registry entry.
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    // The pip candidate may be "pip" itself; find the associated Python.
                    let py = if prog.starts_with("pip") { "python" } else { prog };
                    if let Ok(out) = tokio::process::Command::new(py)
                        .args(["-c", "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))"])
                        .creation_flags(0x08000000)
                        .output().await
                    {
                        let scripts = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !scripts.is_empty() {
                            // Try machine PATH first (requires admin); fall back to user PATH.
                            let ps_cmd = format!(
                                "$s='{s}'; \
                                 $m=[Environment]::GetEnvironmentVariable('PATH','Machine'); \
                                 $u=[Environment]::GetEnvironmentVariable('PATH','User'); \
                                 if($m -notlike ('*'+$s+'*')){{ \
                                   try{{[Environment]::SetEnvironmentVariable('PATH',$m.TrimEnd(';')+';'+$s,'Machine')}}catch{{}} \
                                 }}; \
                                 if((([Environment]::GetEnvironmentVariable('PATH','Machine')) -notlike ('*'+$s+'*')) -and ($u -notlike ('*'+$s+'*'))){{ \
                                   [Environment]::SetEnvironmentVariable('PATH',$u.TrimEnd(';')+';'+$s,'User') \
                                 }}",
                                s = scripts
                            );
                            let _ = tokio::process::Command::new("powershell")
                                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                                       "-ExecutionPolicy", "Bypass", "-Command", &ps_cmd])
                                .creation_flags(0x08000000)
                                .output().await;
                            crate::app_log::info(format!("install_cli: added {} to PATH", scripts));
                        }
                    }
                }

                return Ok("mcpanel-cli installed successfully".into());
            }
            Ok(o) => {
                last_err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            }
            Err(e) => { last_err = e.to_string(); }
        }
    }

    #[cfg(windows)]
    let hint = "py -m pip install --user https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip";
    #[cfg(not(windows))]
    let hint = "pip3 install --user https://github.com/DippyCoder/mcpanel-cli/archive/refs/heads/main.zip";

    Err(format!(
        "Could not install mcpanel-cli. Make sure Python and pip are installed, then run:\n  {hint}\nLast error: {last_err}"
    ))
}

// ─── File upload ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn write_server_file(id: String, rel_path: String, data: Vec<u8>) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let dest = std::path::Path::new(&dir).join(&rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, &data).map_err(|e| e.to_string())
}

// ─── Open terminal in MCPanel home dir ───────────────────────────────────────

#[tauri::command]
pub fn open_terminal() -> Result<(), String> {
    let dir = mcpanel_home();
    let _ = std::fs::create_dir_all(&dir);

    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
    let path = std::env::var("PATH").unwrap_or_default();
    let full_path = format!("{}:{}", extra, path);

    // (terminal, dir-flag) – empty string means use current_dir only
    let candidates: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--working-directory"]),
        ("konsole",        &["--workdir"]),
        ("xfce4-terminal", &["--working-directory"]),
        ("alacritty",      &["--working-directory"]),
        ("kitty",          &[]),
        ("wezterm",        &["start", "--cwd"]),
        ("xterm",          &[]),
        ("x-terminal-emulator", &[]),
    ];

    for (term, flags) in candidates {
        let mut cmd = std::process::Command::new(term);
        cmd.current_dir(&dir).env("PATH", &full_path);
        for flag in *flags {
            cmd.arg(flag);
        }
        // flags that take the dir as the next arg need the dir appended
        if !flags.is_empty() && *flags.last().unwrap() != "start" {
            cmd.arg(&dir);
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }

    Err("No terminal emulator found. Install gnome-terminal, konsole, or xterm.".into())
}

// ─── Drag-drop upload (Tauri intercepts OS drops, gives us paths) ─────────────

// Copies a single dropped path into dst, recursing into directories so a
// dragged folder (and its contents) lands intact rather than being silently
// skipped. src_paths from a multi-select OS drop are handled by the caller
// looping this per path.
fn copy_dropped_path(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_dropped_path(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else if src.is_file() {
        std::fs::copy(src, dst).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn upload_files_to_server(id: String, src_paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    if !dest_dir.is_empty() && (dest_dir.contains("..") || dest_dir.starts_with('/')) {
        return Err("Invalid destination path".into());
    }
    let server_dir = get_server_dir(&id)?;
    let base = std::path::Path::new(&server_dir);
    let dest_base = if dest_dir.is_empty() { base.to_path_buf() } else { base.join(&dest_dir) };
    std::fs::create_dir_all(&dest_base).map_err(|e| e.to_string())?;
    for src_path in &src_paths {
        let src = std::path::Path::new(src_path);
        if let Some(name) = src.file_name() {
            copy_dropped_path(src, &dest_base.join(name))?;
        }
    }
    crate::app_log::info(format!(
        "Uploaded {} item(s) to server{} -id {}",
        src_paths.len(),
        if dest_dir.is_empty() { String::new() } else { format!(" (/{})", dest_dir) },
        id
    ));
    Ok(())
}

// ─── Export (download to an OS folder) ───────────────────────────────────────

// Picks a non-colliding name inside dest for `name`: "world" -> "world (1)".
// The export target is a user folder we don't own, so silently overwriting
// (or merging into) whatever is already there would be destructive.
fn unique_export_path(dest: &std::path::Path, name: &std::ffi::OsStr) -> std::path::PathBuf {
    let first = dest.join(name);
    if !first.exists() {
        return first;
    }
    let name = name.to_string_lossy();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{}", e)),
        _ => (name.to_string(), String::new()),
    };
    for n in 1..1000 {
        let candidate = dest.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

fn export_paths(base: &std::path::Path, rel_paths: &[String], dest_dir: &str) -> Result<(), String> {
    let dest = std::path::Path::new(dest_dir);
    if !dest.is_dir() {
        return Err("Destination folder not found".into());
    }
    for rel in rel_paths {
        if rel.contains("..") || rel.starts_with('/') {
            return Err("Invalid path".into());
        }
        let src = base.join(rel);
        if !src.exists() {
            return Err(format!("Not found: {}", rel));
        }
        let Some(name) = src.file_name() else { continue };
        copy_dropped_path(&src, &unique_export_path(dest, name))?;
    }
    Ok(())
}

#[tauri::command]
pub fn export_server_files(id: String, rel_paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    let server_dir = get_server_dir(&id)?;
    export_paths(std::path::Path::new(&server_dir), &rel_paths, &dest_dir)?;
    crate::app_log::info(format!(
        "Downloaded {} item(s) from server -id {} to {}",
        rel_paths.len(), id, dest_dir
    ));
    Ok(())
}

#[tauri::command]
pub fn export_profile_files(id: String, rel_paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    let profile_dir = get_profile_dir(&id)?;
    export_paths(std::path::Path::new(&profile_dir), &rel_paths, &dest_dir)?;
    crate::app_log::info(format!(
        "Downloaded {} item(s) from profile -id {} to {}",
        rel_paths.len(), id, dest_dir
    ));
    Ok(())
}

// ─── File operations ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn delete_server_file(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let target = std::path::Path::new(&dir).join(&rel_path);
    if !target.exists() {
        return Err("File not found".into());
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn create_server_dir(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let target = std::path::Path::new(&dir).join(&rel_path);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_server_file(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let dest = std::path::Path::new(&dir).join(&rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if dest.exists() {
        return Err("A file with that name already exists".into());
    }
    std::fs::write(&dest, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_server_file(id: String, old_path: String, new_path: String) -> Result<(), String> {
    if old_path.contains("..") || old_path.starts_with('/')
        || new_path.contains("..") || new_path.starts_with('/')
    {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let base = std::path::Path::new(&dir);
    let src = base.join(&old_path);
    let dst = base.join(&new_path);
    if !src.exists() {
        return Err("Source not found".into());
    }
    if dst.exists() {
        return Err("A file with that name already exists".into());
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_server_file(id: String, rel_path: String) -> Result<String, String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_server_dir(&id)?;
    let target = std::path::Path::new(&dir).join(&rel_path);
    let metadata = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File too large to edit in-app (max 5MB)".into());
    }
    std::fs::read_to_string(&target).map_err(|_| "File is binary or cannot be read as text".into())
}

// ─── Profile file system ─────────────────────────────────────────────────────

#[tauri::command]
pub fn update_profile(id: String, name: Option<String>, description: Option<String>, software: Option<Vec<String>>, versions: Option<Vec<String>>) -> Result<(), String> {
    let dir = format!("{}/profiles/{}", mcpanel_home(), id);
    let profile_json = format!("{}/profile.json", dir);
    let content = std::fs::read_to_string(&profile_json).map_err(|e| e.to_string())?;
    let mut profile: serde_json::Map<String, Value> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if let Some(v) = name        { profile.insert("name".into(), Value::String(v)); }
    if let Some(v) = description { profile.insert("description".into(), Value::String(v)); }
    if let Some(v) = software    { profile.insert("software".into(), Value::Array(v.into_iter().map(Value::String).collect())); }
    if let Some(v) = versions    { profile.insert("versions".into(), Value::Array(v.into_iter().map(Value::String).collect())); }
    let out = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&profile_json, out).map_err(|e| e.to_string())
}

fn get_profile_dir(id: &str) -> Result<String, String> {
    let dir = format!("{}/profiles/{}", mcpanel_home(), id);
    if std::path::Path::new(&dir).is_dir() {
        Ok(dir)
    } else {
        Err("Profile not found".into())
    }
}

fn walk_dir_tree(path: &std::path::Path, base: &std::path::Path) -> Value {
    let mut entries: Vec<Value> = vec![];
    if let Ok(read_dir) = std::fs::read_dir(path) {
        let mut items: Vec<_> = read_dir.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = entry.path()
                .strip_prefix(base).unwrap_or(&entry.path())
                .to_string_lossy().replace('\\', "/");
            if meta.is_dir() {
                entries.push(serde_json::json!({
                    "name": name, "type": "dir", "path": rel,
                    "children": walk_dir_tree(&entry.path(), base)
                }));
            } else {
                entries.push(serde_json::json!({
                    "name": name, "type": "file", "path": rel, "size": meta.len()
                }));
            }
        }
    }
    Value::Array(entries)
}

#[tauri::command]
pub fn get_profile_file_tree(id: String) -> Value {
    match get_profile_dir(&id) {
        Ok(dir) => {
            let base = std::path::PathBuf::from(&dir);
            serde_json::json!({ "tree": walk_dir_tree(&base, &base) })
        }
        Err(e) => serde_json::json!({ "error": e }),
    }
}

#[tauri::command]
pub fn read_profile_file(id: String, rel_path: String) -> Result<String, String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    let target = std::path::Path::new(&dir).join(&rel_path);
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("File too large to edit in-app (max 5MB)".into());
    }
    std::fs::read_to_string(&target).map_err(|_| "File is binary or cannot be read as text".into())
}

#[tauri::command]
pub fn write_profile_file(id: String, rel_path: String, data: Vec<u8>) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    let dest = std::path::Path::new(&dir).join(&rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile_file(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    let target = std::path::Path::new(&dir).join(&rel_path);
    if !target.exists() { return Err("File not found".into()); }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn create_profile_dir(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    std::fs::create_dir_all(std::path::Path::new(&dir).join(&rel_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_profile_file(id: String, rel_path: String) -> Result<(), String> {
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    let dest = std::path::Path::new(&dir).join(&rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if dest.exists() { return Err("A file with that name already exists".into()); }
    std::fs::write(&dest, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_profile_file(id: String, old_path: String, new_path: String) -> Result<(), String> {
    if old_path.contains("..") || old_path.starts_with('/')
        || new_path.contains("..") || new_path.starts_with('/')
    {
        return Err("Invalid path".into());
    }
    let dir = get_profile_dir(&id)?;
    let base = std::path::Path::new(&dir);
    let src = base.join(&old_path);
    let dst = base.join(&new_path);
    if !src.exists() { return Err("Source not found".into()); }
    if dst.exists() { return Err("A file with that name already exists".into()); }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upload_files_to_profile(id: String, src_paths: Vec<String>, dest_dir: String) -> Result<(), String> {
    if !dest_dir.is_empty() && (dest_dir.contains("..") || dest_dir.starts_with('/')) {
        return Err("Invalid destination path".into());
    }
    let profile_dir = get_profile_dir(&id)?;
    let base = std::path::Path::new(&profile_dir);
    let dest_base = if dest_dir.is_empty() { base.to_path_buf() } else { base.join(&dest_dir) };
    std::fs::create_dir_all(&dest_base).map_err(|e| e.to_string())?;
    for src_path in &src_paths {
        let src = std::path::Path::new(src_path);
        if let Some(name) = src.file_name() {
            copy_dropped_path(src, &dest_base.join(name))?;
        }
    }
    crate::app_log::info(format!(
        "Uploaded {} item(s) to profile{} -id {}",
        src_paths.len(),
        if dest_dir.is_empty() { String::new() } else { format!(" (/{})", dest_dir) },
        id
    ));
    Ok(())
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_log_path() -> String {
    app_logs_dir()
}

// Lets the frontend record UI-level events (opening a server's panel, etc.)
// that have no natural Rust command of their own to hang a log line off of.
#[tauri::command]
pub fn log_event(level: String, message: String) {
    match level.as_str() {
        "warn" => crate::app_log::warn(message),
        "error" => crate::app_log::error(message),
        _ => crate::app_log::info(message),
    }
}

// ─── Server start time (reads run/<id>.json directly, no CLI round-trip) ─────

#[tauri::command]
pub fn get_server_start_time(id: String) -> Option<u64> {
    let path = format!("{}/{}.json", mcpanel_run_dir(), id);
    let content = std::fs::read_to_string(&path).ok()?;
    let v: Value = serde_json::from_str(&content).ok()?;
    v["started"].as_u64()
}

// ─── First-start debug flag ───────────────────────────────────────────────────

#[tauri::command]
pub fn check_first_start_flag() -> bool {
    let flag = format!("{}/debug_first_start", mcpanel_home());
    if std::path::Path::new(&flag).exists() {
        let _ = std::fs::remove_file(&flag);
        true
    } else {
        false
    }
}

// ─── Embedded PTY terminal ────────────────────────────────────────────────────

#[tauri::command]
pub fn pty_open(app: AppHandle, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    *state.master.lock().unwrap() = None;
    *state.writer.lock().unwrap() = None;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("bash");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{}", extra, path));
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd.cwd(mcpanel_home());

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    *state.master.lock().unwrap() = Some(pair.master);
    *state.writer.lock().unwrap() = Some(writer);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app2.emit("pty-data", data);
                }
            }
        }
        let _ = app2.emit("pty-closed", ());
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(data: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    use std::io::Write;
    if let Some(w) = state.writer.lock().unwrap().as_mut() {
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(rows: u16, cols: u16, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    use portable_pty::PtySize;
    if let Some(m) = state.master.lock().unwrap().as_ref() {
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: tauri::State<'_, PtyState>) {
    *state.master.lock().unwrap() = None;
    *state.writer.lock().unwrap() = None;
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    // Cancel any in-progress backup and delete the partial zip
    if let Ok(mut guard) = app.state::<AppState>().active_backup.lock() {
        if let Some(bkp) = guard.take() {
            #[cfg(unix)]
            { let _ = std::process::Command::new("kill").args(["-9", &bkp.pid.to_string()]).status(); }
            #[cfg(windows)]
            { let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &bkp.pid.to_string()]).status(); }
            if !bkp.zip_path.is_empty() {
                let _ = std::fs::remove_file(&bkp.zip_path);
            }
        }
    }
    app.exit(0);
}

// ─── App settings ─────────────────────────────────────────────────────────────

fn app_settings_path() -> String {
    format!("{}/app-settings.json", mcpanel_home())
}

#[tauri::command]
pub fn get_app_settings() -> Value {
    let raw = std::fs::read_to_string(app_settings_path()).unwrap_or_else(|_| "{}".into());
    let mut v: Value = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    if v.get("runInBackground").is_none() {
        v["runInBackground"] = Value::Bool(true);
    }
    if v.get("fonts").is_none() {
        v["fonts"] = serde_json::json!({"display": "Poppins", "displayWeight": "400", "mono": "JetBrains Mono", "monoWeight": "400"});
    }
    v
}

#[tauri::command]
pub fn save_app_settings(settings: Value) -> Value {
    let home = mcpanel_home();
    if let Err(e) = std::fs::create_dir_all(&home) {
        return serde_json::json!({"error": e.to_string()});
    }

    let old = std::fs::read_to_string(app_settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let changed = changed_setting_keys(old.as_ref(), &settings);
    if !changed.is_empty() {
        crate::app_log::info(format!("Settings updated: {}", changed.join(", ")));
    }

    let json = serde_json::to_string_pretty(&settings).unwrap_or_default();
    match std::fs::write(app_settings_path(), json) {
        Ok(_) => serde_json::json!({"success": true}),
        Err(e) => serde_json::json!({"error": e.to_string()}),
    }
}

// Names only, not values — some settings (fonts, etc.) are nested objects
// that would be noisy to log in full.
fn changed_setting_keys(old: Option<&Value>, new: &Value) -> Vec<String> {
    let Some(new_obj) = new.as_object() else { return vec![] };
    let old_obj = old.and_then(|v| v.as_object());
    new_obj
        .iter()
        .filter(|(k, v)| old_obj.and_then(|o| o.get(k.as_str())) != Some(*v))
        .map(|(k, _)| k.clone())
        .collect()
}

#[tauri::command]
pub async fn shutdown_all_servers() -> Value {
    let out = mcpanel_async_cmd().args(["api", "shutdown"]).output().await;
    match out {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or_else(|_| serde_json::json!({"success": true})),
        Err(e) => serde_json::json!({"error": e.to_string()}),
    }
}

// ─── System fonts ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Drawing.FontFamily]::Families | Select-Object -ExpandProperty Name",
            ])
            .output();
        if let Ok(o) = output {
            let text = String::from_utf8_lossy(&o.stdout);
            let mut fonts: Vec<String> = text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            fonts.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
            fonts.dedup();
            return fonts;
        }
        return vec![];
    }
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("fc-list")
            .args(["--format", "%{family}\n"])
            .output();
        if let Ok(o) = output {
            let text = String::from_utf8_lossy(&o.stdout);
            let mut seen = std::collections::HashSet::new();
            let mut fonts: Vec<String> = Vec::new();
            for line in text.lines() {
                // fontconfig may give comma-separated names for multi-script families; take the first
                let name = line.split(',').next().unwrap_or("").trim().to_string();
                if !name.is_empty() && seen.insert(name.clone()) {
                    fonts.push(name);
                }
            }
            fonts.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
            return fonts;
        }
        return vec![];
    }
}

// ─── Velocity proxy link ──────────────────────────────────────────────────────

fn find_velocity_try_array(lines: &[&str]) -> Option<(usize, usize, Vec<String>)> {
    let mut in_servers = false;
    let mut try_start: Option<usize> = None;
    let mut in_array = false;
    let mut entries: Vec<String> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == "[servers]" {
            in_servers = true;
            continue;
        }
        if in_servers && t.starts_with('[') && t != "[servers]" {
            in_servers = false;
        }
        if !in_servers { continue; }

        if try_start.is_none() && t.starts_with("try") {
            if let Some(eq) = t.find('=') {
                let after = t[eq + 1..].trim();
                if after.starts_with('[') {
                    try_start = Some(i);
                    if after.ends_with(']') {
                        let inner = &after[1..after.len() - 1];
                        for part in inner.split(',') {
                            let s = part.trim().trim_matches('"').trim();
                            if !s.is_empty() { entries.push(s.to_string()); }
                        }
                        return Some((i, i, entries));
                    }
                    in_array = true;
                    continue;
                }
            }
        }

        if in_array {
            if t == "]" || t == "]," {
                return Some((try_start.unwrap(), i, entries));
            }
            let entry = t.trim_matches(',').trim().trim_matches('"').trim().to_string();
            if !entry.is_empty() { entries.push(entry); }
        }
    }
    None
}

fn parse_velocity_try_list(contents: &str) -> Vec<String> {
    let lines: Vec<&str> = contents.lines().collect();
    find_velocity_try_array(&lines).map(|(_, _, v)| v).unwrap_or_default()
}

fn get_server_port_from_config(id: &str) -> u16 {
    let dir = match get_server_dir(id) {
        Ok(d) => d,
        Err(_) => return 25565,
    };
    let props = format!("{}/server.properties", dir);
    if let Ok(contents) = std::fs::read_to_string(&props) {
        for line in contents.lines() {
            if line.starts_with("server-port=") {
                if let Ok(p) = line["server-port=".len()..].trim().parse::<u16>() {
                    return p;
                }
            }
        }
    }
    25565
}

fn read_velocity_secret_str(velocity_dir: &str) -> Option<String> {
    let toml_path = format!("{}/velocity.toml", velocity_dir);
    if let Ok(contents) = std::fs::read_to_string(&toml_path) {
        for line in contents.lines() {
            let t = line.trim();
            if t.starts_with("forwarding-secret-file") && t.contains('=') {
                if let Some(s) = t.find('"') {
                    if let Some(e) = t[s + 1..].find('"') {
                        let fname = &t[s + 1..s + 1 + e];
                        let file_path = format!("{}/{}", velocity_dir, fname);
                        if let Ok(secret) = std::fs::read_to_string(&file_path) {
                            let secret = secret.trim().to_string();
                            if !secret.is_empty() { return Some(secret); }
                        }
                    }
                }
            }
        }
        for line in contents.lines() {
            let t = line.trim();
            if t.starts_with("forwarding-secret") && !t.starts_with("forwarding-secret-file") && t.contains('=') {
                if let Some(s) = t.find('"') {
                    if let Some(e) = t[s + 1..].find('"') {
                        let secret = &t[s + 1..s + 1 + e];
                        if !secret.is_empty() { return Some(secret.to_string()); }
                    }
                }
            }
        }
    }
    let secret_path = format!("{}/forwarding.secret", velocity_dir);
    if let Ok(secret) = std::fs::read_to_string(&secret_path) {
        let s = secret.trim().to_string();
        if !s.is_empty() { return Some(s); }
    }
    None
}

fn update_velocity_toml(contents: &str, server_name: &str, address: &str, priority: u64) -> Result<String, String> {
    let lines: Vec<&str> = contents.lines().collect();

    if let Some((try_start, try_end, mut entries)) = find_velocity_try_array(&lines) {
        let server_entry_exists = lines.iter().any(|l| {
            let t = l.trim();
            t.starts_with(&format!("{} =", server_name)) || t.starts_with(&format!("{}=", server_name))
        });

        if !entries.contains(&server_name.to_string()) {
            let pos = (priority as usize).min(entries.len());
            entries.insert(pos, server_name.to_string());
        }

        let try_line = format!(
            "try = [{}]",
            entries.iter().map(|e| format!("\"{}\"", e)).collect::<Vec<_>>().join(", ")
        );

        let mut result = String::new();
        let mut i = 0;
        while i < lines.len() {
            if i == try_start {
                if !server_entry_exists {
                    result.push_str(&format!("{} = \"{}\"\n", server_name, address));
                }
                result.push_str(&try_line);
                result.push('\n');
                i = try_end + 1;
                continue;
            }
            result.push_str(lines[i]);
            result.push('\n');
            i += 1;
        }
        return Ok(result);
    }

    // No [servers]/try = [...] found. This is expected (not an error) when Velocity
    // has never been started: velocity.toml only gets its full default template —
    // including the [servers] section — merged in by Velocity's own config loader
    // on first run. mcpanel-cli's initial velocity.toml (written at server-creation
    // time, before the jar has ever executed) only contains a `bind = "..."` line.
    // Rather than failing the link, create the section ourselves.
    let entry_line = format!("{} = \"{}\"", server_name, address);
    let try_line = format!("try = [\"{}\"]", server_name);

    if let Some(idx) = lines.iter().position(|l| l.trim() == "[servers]") {
        let mut result = String::new();
        for (i, line) in lines.iter().enumerate() {
            result.push_str(line);
            result.push('\n');
            if i == idx {
                result.push_str(&entry_line);
                result.push('\n');
                result.push_str(&try_line);
                result.push('\n');
            }
        }
        Ok(result)
    } else {
        let mut result = contents.trim_end().to_string();
        if !result.is_empty() {
            result.push_str("\n\n");
        }
        result.push_str(&format!("[servers]\n{}\n{}\n", entry_line, try_line));
        Ok(result)
    }
}

fn ensure_velocity_forwarding_modern(contents: &str) -> String {
    let mut result = String::new();
    for line in contents.lines() {
        let t = line.trim();
        if t.starts_with("player-info-forwarding-mode") && t.contains('=') {
            if let Some(eq) = t.find('=') {
                let val = t[eq + 1..].trim().trim_matches('"').to_uppercase();
                if val == "NONE" {
                    result.push_str("player-info-forwarding-mode = \"MODERN\"\n");
                    continue;
                }
            }
        }
        result.push_str(line);
        result.push('\n');
    }
    result
}

fn update_paper_global_yml(contents: &str, secret: &str) -> String {
    let mut result = String::new();
    let mut in_proxies = false;
    let mut in_velocity = false;
    let mut proxies_indent: usize = 0;
    let mut velocity_indent: usize = 0;

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        let indent = line.len() - line.trim_start().len();

        if in_velocity && indent <= velocity_indent {
            in_velocity = false;
        }
        if in_proxies && indent <= proxies_indent && trimmed != "proxies:" {
            in_proxies = false;
            in_velocity = false;
        }

        if !in_proxies && trimmed == "proxies:" {
            in_proxies = true;
            proxies_indent = indent;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if in_proxies && !in_velocity && trimmed == "velocity:" {
            in_velocity = true;
            velocity_indent = indent;
            result.push_str(line);
            result.push('\n');
            continue;
        }

        if in_velocity {
            let spaces = " ".repeat(indent);
            if trimmed.starts_with("enabled:") {
                result.push_str(&format!("{}enabled: true\n", spaces));
                continue;
            }
            if trimmed.starts_with("online-mode:") {
                result.push_str(&format!("{}online-mode: true\n", spaces));
                continue;
            }
            if trimmed.starts_with("secret:") {
                result.push_str(&format!("{}secret: '{}'\n", spaces, secret));
                continue;
            }
        }

        result.push_str(line);
        result.push('\n');
    }
    result
}

#[tauri::command]
pub fn proxy_info(velocity_id: String) -> Value {
    let dir = match get_server_dir(&velocity_id) {
        Ok(d) => d,
        Err(e) => return serde_json::json!({"error": e}),
    };
    let toml_path = format!("{}/velocity.toml", dir);
    let contents = match std::fs::read_to_string(&toml_path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": format!("Failed to read velocity.toml: {}", e)}),
    };
    serde_json::json!({"tryList": parse_velocity_try_list(&contents)})
}

#[tauri::command]
pub fn link_to_proxy(
    paper_id: String,
    velocity_id: String,
    server_name: String,
    priority: u64,
    custom_ip: Option<String>,
) -> Value {
    let paper_dir = match get_server_dir(&paper_id) {
        Ok(d) => d,
        Err(e) => return serde_json::json!({"error": e}),
    };
    let velocity_dir = match get_server_dir(&velocity_id) {
        Ok(d) => d,
        Err(e) => return serde_json::json!({"error": e}),
    };

    let port = get_server_port_from_config(&paper_id);
    let address = match custom_ip {
        Some(ref ip) if !ip.is_empty() => format!("{}:{}", ip, port),
        _ => format!("127.0.0.1:{}", port),
    };

    // The forwarding secret (and the [servers]/try = [...] section handled below)
    // only exist once Velocity has generated its full config, which happens on its
    // own first run — not at server-creation time. Check this up front: without a
    // real secret, linking would "succeed" but leave modern forwarding silently
    // broken (empty secret in paper-global.yml).
    let secret = read_velocity_secret_str(&velocity_dir).unwrap_or_default();
    if secret.is_empty() {
        return serde_json::json!({"error": "This Velocity proxy hasn't been started yet, so it hasn't generated its forwarding secret. Start it once, then try linking again."});
    }

    // Update velocity.toml
    let toml_path = format!("{}/velocity.toml", velocity_dir);
    let toml_contents = match std::fs::read_to_string(&toml_path) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": format!("Failed to read velocity.toml: {}", e)}),
    };
    let updated_toml = match update_velocity_toml(&toml_contents, &server_name, &address, priority) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e}),
    };
    let updated_toml = ensure_velocity_forwarding_modern(&updated_toml);
    if let Err(e) = std::fs::write(&toml_path, &updated_toml) {
        return serde_json::json!({"error": format!("Failed to write velocity.toml: {}", e)});
    }

    // Set online-mode=false in server.properties
    let props_path = format!("{}/server.properties", paper_dir);
    if let Ok(props) = std::fs::read_to_string(&props_path) {
        let updated = if props.contains("online-mode=") {
            let mut r = String::new();
            for line in props.lines() {
                if line.starts_with("online-mode=") {
                    r.push_str("online-mode=false\n");
                } else {
                    r.push_str(line);
                    r.push('\n');
                }
            }
            r
        } else {
            format!("{}\nonline-mode=false\n", props.trim_end())
        };
        let _ = std::fs::write(&props_path, updated);
    }

    // Update paper-global.yml with forwarding secret
    let paper_global_path = format!("{}/config/paper-global.yml", paper_dir);
    if let Ok(paper_global) = std::fs::read_to_string(&paper_global_path) {
        let updated = update_paper_global_yml(&paper_global, &secret);
        let _ = std::fs::write(&paper_global_path, updated);
    }

    serde_json::json!({"success": true})
}

// ─── Velocity forwarding secret ───────────────────────────────────────────────

#[tauri::command]
pub fn get_velocity_secret(id: String) -> Value {
    let dir = match get_server_dir(&id) {
        Ok(d) => d,
        Err(e) => return serde_json::json!({"error": e}),
    };

    // Modern Velocity: forwarding-secret in velocity.toml
    let toml_path = format!("{}/velocity.toml", dir);
    if let Ok(contents) = std::fs::read_to_string(&toml_path) {
        // Check forwarding-secret-file directive first
        for line in contents.lines() {
            let t = line.trim();
            if t.starts_with("forwarding-secret-file") && t.contains('=') {
                if let Some(s) = t.find('"') {
                    if let Some(e) = t[s + 1..].find('"') {
                        let fname = &t[s + 1..s + 1 + e];
                        let file_path = format!("{}/{}", dir, fname);
                        if let Ok(secret) = std::fs::read_to_string(&file_path) {
                            let secret = secret.trim().to_string();
                            if !secret.is_empty() {
                                return serde_json::json!({"secret": secret});
                            }
                        }
                    }
                }
            }
        }
        // Inline forwarding-secret = "value"
        for line in contents.lines() {
            let t = line.trim();
            if t.starts_with("forwarding-secret") && !t.starts_with("forwarding-secret-file") && t.contains('=') {
                if let Some(s) = t.find('"') {
                    if let Some(e) = t[s + 1..].find('"') {
                        let secret = &t[s + 1..s + 1 + e];
                        if !secret.is_empty() {
                            return serde_json::json!({"secret": secret});
                        }
                    }
                }
            }
        }
    }

    // Legacy Velocity: forwarding.secret plain-text file
    let secret_path = format!("{}/forwarding.secret", dir);
    if let Ok(secret) = std::fs::read_to_string(&secret_path) {
        let secret = secret.trim().to_string();
        if !secret.is_empty() {
            return serde_json::json!({"secret": secret});
        }
    }

    serde_json::json!({"error": "Forwarding secret not found. Check velocity.toml or forwarding.secret."})
}

// ─── System stats (RAM + CPU load) ───────────────────────────────────────────

#[tauri::command]
pub fn get_system_stats() -> Value {
    #[cfg(windows)]
    return get_system_stats_windows();
    #[cfg(target_os = "macos")]
    return get_system_stats_macos();
    #[cfg(not(any(windows, target_os = "macos")))]
    return get_system_stats_linux();
}

#[cfg(not(any(windows, target_os = "macos")))]
fn get_system_stats_linux() -> Value {
    let mut total_ram: u64 = 0;
    let mut avail_ram: u64 = 0;

    if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
        for line in meminfo.lines() {
            if line.starts_with("MemTotal:") {
                if let Some(kb) = line.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok()) {
                    total_ram = kb * 1024;
                }
            } else if line.starts_with("MemAvailable:") {
                if let Some(kb) = line.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok()) {
                    avail_ram = kb * 1024;
                }
            }
        }
    }

    let load1m: f64 = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|n| n.parse().ok()))
        .unwrap_or(0.0);

    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();

    let cpu_name = cpuinfo.lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let cpu_threads = cpuinfo.lines()
        .filter(|l| l.starts_with("processor"))
        .count()
        .max(1);

    let cores_per_socket: usize = cpuinfo.lines()
        .find(|l| l.starts_with("cpu cores"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(cpu_threads);

    let mut phys_ids: Vec<&str> = cpuinfo.lines()
        .filter(|l| l.starts_with("physical id"))
        .filter_map(|l| l.split(':').nth(1).map(|s| s.trim()))
        .collect();
    phys_ids.sort();
    phys_ids.dedup();
    let cpu_cores = cores_per_socket * phys_ids.len().max(1);

    let cpu_pct = ((load1m / cpu_threads as f64) * 1000.0).round() / 10.0;
    let cpu_pct = cpu_pct.min(100.0);

    let cpu_freq_mhz: f64 = std::fs::read_to_string("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|khz| khz as f64 / 1000.0)
        .unwrap_or(0.0);

    let used_ram = total_ram.saturating_sub(avail_ram);

    serde_json::json!({
        "totalRam": total_ram,
        "availRam": avail_ram,
        "usedRam": used_ram,
        "cpuPct": cpu_pct,
        "loadAvg": load1m,
        "cpuName": cpu_name,
        "cpuCores": cpu_cores,
        "cpuThreads": cpu_threads,
        "cpuFreqMhz": cpu_freq_mhz,
    })
}

// Cache previous CPU times between polls so we can compute a delta without sleeping.
// First call returns 0% (no previous sample); subsequent calls are accurate.
#[cfg(windows)]
fn cpu_prev_mutex() -> &'static std::sync::Mutex<Option<(u64, u64)>> {
    static M: std::sync::OnceLock<std::sync::Mutex<Option<(u64, u64)>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(windows)]
fn get_system_stats_windows() -> Value {
    use std::mem;

    // ── RAM ──────────────────────────────────────────────────────────────────
    #[repr(C)]
    struct MEMORYSTATUSEX {
        dwLength: u32,
        dwMemoryLoad: u32,
        ullTotalPhys: u64,
        ullAvailPhys: u64,
        ullTotalPageFile: u64,
        ullAvailPageFile: u64,
        ullTotalVirtual: u64,
        ullAvailVirtual: u64,
        ullAvailExtendedVirtual: u64,
    }

    extern "system" {
        fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
    }

    let (total_ram, avail_ram) = unsafe {
        let mut s: MEMORYSTATUSEX = mem::zeroed();
        s.dwLength = mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut s) != 0 {
            (s.ullTotalPhys, s.ullAvailPhys)
        } else {
            (0u64, 0u64)
        }
    };

    // ── CPU (delta between successive calls) ──────────────────────────────────
    #[repr(C)]
    struct FILETIME { lo: u32, hi: u32 }

    extern "system" {
        fn GetSystemTimes(idle: *mut FILETIME, kernel: *mut FILETIME, user: *mut FILETIME) -> i32;
    }

    let ft64 = |ft: &FILETIME| -> u64 { ((ft.hi as u64) << 32) | ft.lo as u64 };

    let cpu_pct: f64 = unsafe {
        let mut idle: FILETIME = mem::zeroed();
        let mut kern: FILETIME = mem::zeroed();
        let mut user: FILETIME = mem::zeroed();

        if GetSystemTimes(&mut idle, &mut kern, &mut user) != 0 {
            let idle_now  = ft64(&idle);
            // Kernel time includes idle time on Windows.
            let total_now = ft64(&kern) + ft64(&user);

            let mut prev = cpu_prev_mutex().lock().unwrap();
            let pct = if let Some((prev_idle, prev_total)) = *prev {
                let d_idle  = idle_now.saturating_sub(prev_idle);
                let d_total = total_now.saturating_sub(prev_total);
                if d_total > 0 {
                    let busy = d_total.saturating_sub(d_idle);
                    ((busy as f64 / d_total as f64) * 100.0).min(100.0).round()
                } else {
                    0.0
                }
            } else {
                0.0 // first sample — no previous reading yet
            };
            *prev = Some((idle_now, total_now));
            pct
        } else {
            0.0
        }
    };

    let parse_wmic = |args: &[&str], prefix: &str| -> Option<String> {
        std::process::Command::new("wmic")
            .args(args)
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .find(|l| l.starts_with(prefix))
                    .map(|l| l[prefix.len()..].trim().to_string())
            })
    };

    let cpu_name = parse_wmic(&["cpu", "get", "Name", "/value"], "Name=")
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let cpu_cores: u32 = parse_wmic(&["cpu", "get", "NumberOfCores", "/value"], "NumberOfCores=")
        .and_then(|s| s.parse().ok()).unwrap_or(1);
    let cpu_threads: u32 = parse_wmic(&["cpu", "get", "NumberOfLogicalProcessors", "/value"], "NumberOfLogicalProcessors=")
        .and_then(|s| s.parse().ok()).unwrap_or(1);
    let cpu_freq_mhz: f64 = parse_wmic(&["cpu", "get", "MaxClockSpeed", "/value"], "MaxClockSpeed=")
        .and_then(|s| s.parse().ok()).unwrap_or(0.0);

    let used_ram = total_ram.saturating_sub(avail_ram);
    serde_json::json!({
        "totalRam": total_ram,
        "availRam": avail_ram,
        "usedRam": used_ram,
        "cpuPct": cpu_pct,
        "loadAvg": cpu_pct,
        "cpuName": cpu_name,
        "cpuCores": cpu_cores,
        "cpuThreads": cpu_threads,
        "cpuFreqMhz": cpu_freq_mhz,
    })
}

#[cfg(target_os = "macos")]
fn get_system_stats_macos() -> Value {
    // ── Total RAM ─────────────────────────────────────────────────────────────
    let total_ram: u64 = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0);

    // ── Available RAM (free + inactive + speculative pages × page size) ───────
    let avail_ram: u64 = (|| -> Option<u64> {
        let page_size: u64 = std::process::Command::new("sysctl")
            .args(["-n", "hw.pagesize"])
            .output().ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(4096);

        let vm = std::process::Command::new("vm_stat").output().ok()?;
        let text = String::from_utf8_lossy(&vm.stdout);
        let mut pages_free: u64 = 0;
        let mut pages_inactive: u64 = 0;
        let mut pages_speculative: u64 = 0;
        for line in text.lines() {
            let val = || -> Option<u64> {
                line.split(':').nth(1)?.trim().trim_end_matches('.').parse().ok()
            };
            if line.starts_with("Pages free:")          { pages_free         = val().unwrap_or(0); }
            if line.starts_with("Pages inactive:")       { pages_inactive      = val().unwrap_or(0); }
            if line.starts_with("Pages speculative:")    { pages_speculative   = val().unwrap_or(0); }
        }
        Some((pages_free + pages_inactive + pages_speculative) * page_size)
    })().unwrap_or(0);

    // ── CPU (load average ÷ logical CPU count) ────────────────────────────────
    let load1m: f64 = std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .and_then(|o| {
            // Output: "{ 0.42 0.38 0.31 }"
            let s = String::from_utf8_lossy(&o.stdout);
            s.split_whitespace().nth(1).and_then(|n| n.parse().ok())
        })
        .unwrap_or(0.0);

    let cpu_count: f64 = std::process::Command::new("sysctl")
        .args(["-n", "hw.logicalcpu"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(1.0_f64.into());

    let cpu_pct = ((load1m / cpu_count) * 100.0).min(100.0).round();

    let cpu_name = std::process::Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let cpu_cores: u32 = std::process::Command::new("sysctl")
        .args(["-n", "hw.physicalcpu"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(1);

    let cpu_freq_mhz: f64 = std::process::Command::new("sysctl")
        .args(["-n", "hw.cpufrequency_max"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .map(|hz| hz as f64 / 1_000_000.0)
        .unwrap_or(0.0);

    let used_ram = total_ram.saturating_sub(avail_ram);

    serde_json::json!({
        "totalRam": total_ram,
        "availRam": avail_ram,
        "usedRam": used_ram,
        "cpuPct": cpu_pct,
        "loadAvg": load1m,
        "cpuName": cpu_name,
        "cpuCores": cpu_cores,
        "cpuThreads": cpu_count as u32,
        "cpuFreqMhz": cpu_freq_mhz,
    })
}

// ─── Backup system (CLI-backed) ───────────────────────────────────────────────

fn server_backups_dir(server_id: &str) -> String {
    format!("{}/backups/{}", mcpanel_home(), server_id)
}

#[tauri::command]
pub async fn create_backup(id: String, app: AppHandle) -> Value {
    use tokio::io::AsyncBufReadExt;

    let backup_dir = server_backups_dir(&id);
    if let Err(e) = std::fs::create_dir_all(&backup_dir) {
        return serde_json::json!({"error": e.to_string()});
    }

    let mut child = match mcpanel_async_cmd()
        .args(["api", "backup", "create", "-id", &id])
        .stdout(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e.to_string()}),
    };

    let pid = child.id().unwrap_or(0);
    {
        let state = app.state::<AppState>();
        *state.active_backup.lock().unwrap() = Some(BackupInProgress {
            pid,
            zip_path: String::new(), // filled when we see the backup name in progress
        });
    }

    let stdout = child.stdout.take().unwrap();
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut final_result = serde_json::json!({"error": "Backup produced no output"});

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            let pct = val["progress"].as_u64().unwrap_or(0);
            let status = val["status"].as_str().unwrap_or("").to_string();
            let _ = app.emit("backup-progress", serde_json::json!({"id": &id, "progress": pct, "status": &status}));
            if val.get("success").is_some() || val.get("error").is_some() {
                final_result = val;
            }
        }
    }
    let _ = child.wait().await;

    {
        let state = app.state::<AppState>();
        *state.active_backup.lock().unwrap() = None;
    }
    final_result
}

#[tauri::command]
pub async fn list_backups(id: String) -> Value {
    let out = mcpanel_async_cmd().args(["api", "backup", "list", "-id", &id]).output().await;
    match out {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or_else(|_| serde_json::json!({"backups": []})),
        Err(e) => serde_json::json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub async fn delete_backup(id: String, backup_name: String) -> Value {
    let out = mcpanel_async_cmd().args(["api", "backup", "delete", "-id", &id, "-name", &backup_name]).output().await;
    match out {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or_else(|_| serde_json::json!({"error": "Invalid response"})),
        Err(e) => serde_json::json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub async fn restore_backup(id: String, backup_name: String, app: AppHandle) -> Value {
    use tokio::io::AsyncBufReadExt;

    let mut child = match mcpanel_async_cmd()
        .args(["api", "backup", "restore", "-id", &id, "-name", &backup_name])
        .stdout(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e.to_string()}),
    };

    let stdout = child.stdout.take().unwrap();
    let reader = tokio::io::BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut final_result = serde_json::json!({"error": "Restore produced no output"});

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            let pct = val["progress"].as_u64().unwrap_or(0);
            let status = val["status"].as_str().unwrap_or("").to_string();
            let _ = app.emit("backup-progress", serde_json::json!({"id": &id, "progress": pct, "status": &status}));
            if val.get("success").is_some() || val.get("error").is_some() {
                final_result = val;
            }
        }
    }
    let _ = child.wait().await;
    final_result
}

// ─── Schedule system ──────────────────────────────────────────────────────────

fn mcpanel_schedules_path() -> String {
    format!("{}/schedules.json", mcpanel_home())
}

pub fn read_all_schedules() -> Vec<Value> {
    let raw = std::fs::read_to_string(mcpanel_schedules_path()).unwrap_or_else(|_| "[]".into());
    serde_json::from_str::<Vec<Value>>(&raw).unwrap_or_default()
}

pub fn write_all_schedules(schedules: &[Value]) -> Result<(), String> {
    let home = mcpanel_home();
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(schedules).map_err(|e| e.to_string())?;
    std::fs::write(mcpanel_schedules_path(), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_schedules(server_id: String) -> Value {
    let schedules = read_all_schedules();
    let filtered: Vec<&Value> = schedules.iter()
        .filter(|s| s["server_id"].as_str() == Some(&server_id))
        .collect();
    serde_json::json!({"schedules": filtered})
}

#[tauri::command]
pub fn save_schedule(schedule: Value) -> Value {
    let mut schedules = read_all_schedules();
    let id = match schedule["id"].as_str() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return serde_json::json!({"error": "Schedule must have an id"}),
    };
    let pos = schedules.iter().position(|s| s["id"].as_str() == Some(&id));
    if let Some(idx) = pos { schedules[idx] = schedule.clone(); } else { schedules.push(schedule.clone()); }
    match write_all_schedules(&schedules) {
        Ok(_) => serde_json::json!({"success": true, "schedule": schedule}),
        Err(e) => serde_json::json!({"error": e}),
    }
}

#[tauri::command]
pub fn delete_schedule(schedule_id: String) -> Value {
    let mut schedules = read_all_schedules();
    let before = schedules.len();
    schedules.retain(|s| s["id"].as_str() != Some(&schedule_id));
    if schedules.len() == before { return serde_json::json!({"error": "Schedule not found"}); }
    match write_all_schedules(&schedules) {
        Ok(_) => serde_json::json!({"success": true}),
        Err(e) => serde_json::json!({"error": e}),
    }
}

#[tauri::command]
pub async fn run_schedule_now(server_id: String, action: String, command: Option<String>) -> Value {
    match execute_scheduled_action(&server_id, &action, command.as_deref()).await {
        Ok(_) => serde_json::json!({"success": true}),
        Err(e) => serde_json::json!({"error": e}),
    }
}

async fn execute_scheduled_action(server_id: &str, action: &str, command: Option<&str>) -> Result<(), String> {
    match action {
        "start" => { mcpanel_async_cmd().args(["api", "start", "server", "-id", server_id]).output().await.map_err(|e| e.to_string())?; }
        "stop"  => { mcpanel_async_cmd().args(["api", "stop", "server", "-id", server_id]).output().await.map_err(|e| e.to_string())?; }
        "restart" => { mcpanel_async_cmd().args(["api", "restart", "server", "-id", server_id]).output().await.map_err(|e| e.to_string())?; }
        "backup" => {
            mcpanel_async_cmd()
                .args(["api", "backup", "create", "-id", server_id])
                .output()
                .await
                .map_err(|e| e.to_string())?;
        }
        "command" => {
            if let Some(cmd) = command {
                #[cfg(unix)]
                {
                    use std::io::Write;
                    use std::os::unix::net::UnixStream;
                    let sock = format!("{}/{}.sock", mcpanel_run_dir(), server_id);
                    if let Ok(mut stream) = UnixStream::connect(&sock) {
                        let req = format!("{}\n", serde_json::json!({"op": "cmd", "text": cmd}));
                        let _ = stream.write_all(req.as_bytes());
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub async fn run_scheduler(app: AppHandle) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let mut schedules = read_all_schedules();
        let mut changed = false;
        for schedule in schedules.iter_mut() {
            if schedule["enabled"].as_bool() != Some(true) { continue; }
            let next_run = match schedule["next_run"].as_u64() { Some(n) => n, None => continue };
            if now_ms < next_run { continue; }
            let server_id = match schedule["server_id"].as_str() { Some(id) => id.to_string(), None => continue };
            let action = schedule["action"].as_str().unwrap_or("").to_string();
            let cmd_text = schedule["command"].as_str().map(|s| s.to_string());
            let _ = execute_scheduled_action(&server_id, &action, cmd_text.as_deref()).await;
            let _ = app.emit("schedule-fired", serde_json::json!({
                "schedule_id": schedule["id"].as_str().unwrap_or(""),
                "server_id": &server_id,
                "action": &action,
            }));
            let repeat = schedule["repeat"].as_bool().unwrap_or(false);
            if repeat {
                let every = schedule["repeat_every"].as_u64().unwrap_or(1).max(1);
                let unit = schedule["repeat_unit"].as_str().unwrap_or("days");
                let ms: u64 = match unit {
                    "minutes" => every * 60_000,
                    "hours"   => every * 3_600_000,
                    "days"    => every * 86_400_000,
                    "weeks"   => every * 604_800_000,
                    _         => every * 86_400_000,
                };
                let mut new_next = next_run + ms;
                while new_next <= now_ms { new_next += ms; }
                schedule["next_run"] = Value::Number(serde_json::Number::from(new_next));
                schedule["last_run"] = Value::Number(serde_json::Number::from(now_ms));
            } else {
                schedule["enabled"] = Value::Bool(false);
                schedule["last_run"] = Value::Number(serde_json::Number::from(now_ms));
            }
            changed = true;
        }
        if changed { let _ = write_all_schedules(&schedules); }
    }
}
