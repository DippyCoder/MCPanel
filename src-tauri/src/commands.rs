use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ─── App State ────────────────────────────────────────────────────────────────

pub struct AppState {
    pub log_streamers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    pub app_handle: AppHandle,
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

fn app_log_path() -> String {
    format!("{}/mcpanel-app.log", mcpanel_home())
}

fn log_to_file(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_log_path())
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = writeln!(f, "[{}] {}", ts, line);
    }
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

// AppImage launchers and some desktop environments strip ~/.local/bin from PATH.
// These helpers prepend the common user-install locations so `mcpanel` (installed
// via pip --user or pipx) is always found regardless of how the app was launched.
fn mcpanel_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new("mcpanel");
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{}", extra, path));
    // AppImage bundles its own Python and exports PYTHONHOME/PYTHONPATH pointing
    // inside the AppImage. Those break the system-installed mcpanel CLI because
    // Python can't find its standard library (encodings, etc.). Unset them so the
    // system Python is used when mcpanel is invoked.
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd
}

fn mcpanel_async_cmd() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("mcpanel");
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{}/.local/bin:{}/.local/pipx/bin:/usr/local/bin", home, home);
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{}", extra, path));
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    cmd
}

#[tauri::command]
pub fn check_cli() -> Value {
    match mcpanel_cmd()
        .args(["api", "version"])
        .output()
    {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version = serde_json::from_str::<Value>(&stdout)
                .ok()
                .and_then(|v| v["version"].as_str().map(|s| s.to_string()));
            let mut result = serde_json::json!({"ok": true});
            if let Some(v) = version {
                result["version"] = Value::String(v);
            }
            result
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            serde_json::json!({"ok": false, "error": err})
        }
        Err(e) => serde_json::json!({
            "ok": false,
            "error": format!(
                "mcpanel CLI not found.\nInstall it with:  pip3 install --user git+https://github.com/DippyCoder/mcpanel-cli.git\n({})",
                e
            )
        }),
    }
}

#[tauri::command]
pub fn run_cli(args: Vec<String>) -> Result<String, String> {
    let mut argv = vec!["api".to_string()];
    argv.extend(args);
    log_to_file(&format!("run_cli: mcpanel {}", argv.join(" ")));

    let out = mcpanel_cmd()
        .args(&argv)
        .output()
        .map_err(|e| format!("Failed to run mcpanel: {}", e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        log_to_file(&format!("  error: {}", stderr));
        return Err(stderr);
    }
    log_to_file(&format!("  ok ({} bytes)", stdout.len()));
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

    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": new_id, "progress": 100, "status": "Done!"}),
    );

    Ok(serde_json::json!({"success": true, "server": new_srv}).to_string())
}

fn copy_dir_all(src: &str, dst: &str) -> Result<(), String> {
    for entry in
        std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {}", src, e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
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
    let _ = app.emit(
        "download-progress",
        serde_json::json!({"id": "__creating__", "progress": 5, "status": "Downloading server jar…"}),
    );

    let mut argv = vec!["api".into(), "create".into(), "server".into()];
    argv.extend(args);
    log_to_file(&format!("create_server: mcpanel {}", argv.join(" ")));

    // Slow fake progress ticker while CLI runs
    let app2 = app.clone();
    let ticker = tokio::spawn(async move {
        let mut p = 5u8;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            p = (p + 12).min(88);
            let _ = app2.emit(
                "download-progress",
                serde_json::json!({"id": "__creating__", "progress": p, "status": "Downloading server jar…"}),
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
        log_to_file(&format!("  error: {}", stderr));
        return Err(stderr);
    }
    log_to_file(&format!("  ok ({} bytes)", stdout.len()));
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
pub fn fetch_github_themes() -> Value {
    let url = "https://raw.githubusercontent.com/DippyCoder/MCPanel/themes/themes-index.json";
    let out = std::process::Command::new("curl")
        .args(["-fsSL", "--max-time", "10", url])
        .output();
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
    let status = std::process::Command::new("curl")
        .args(["-fsSL", "--max-time", "60", "-o", &tmp, &url])
        .status()
        .map_err(|e| e.to_string())?;
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
    const GITHUB_URL: &str = "git+https://github.com/DippyCoder/mcpanel-cli.git";
    for pip in &["pip3", "pip"] {
        let out = tokio::process::Command::new(pip)
            .args(["install", "--user", GITHUB_URL])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                log_to_file("install_cli: mcpanel-cli installed from GitHub");
                return Ok("mcpanel-cli installed successfully".into());
            }
            _ => continue,
        }
    }
    Err("Could not install mcpanel-cli. Make sure python3 and pip are installed,\nthen run:  pip3 install --user git+https://github.com/DippyCoder/mcpanel-cli.git".into())
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
        if src.is_file() {
            if let Some(name) = src.file_name() {
                std::fs::copy(src, dest_base.join(name)).map_err(|e| e.to_string())?;
            }
        }
    }
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

// ─── Logs ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_log_path() -> String {
    app_log_path()
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
    app.exit(0);
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
    let (try_start, try_end, mut entries) = find_velocity_try_array(&lines)
        .ok_or("Could not find try = [...] in [servers] section of velocity.toml")?;

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
    Ok(result)
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
    let secret = read_velocity_secret_str(&velocity_dir).unwrap_or_default();
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

    let cpu_count = std::fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .lines()
        .filter(|l| l.starts_with("processor"))
        .count()
        .max(1);

    let cpu_pct = ((load1m / cpu_count as f64) * 1000.0).round() / 10.0;
    let cpu_pct = cpu_pct.min(100.0);
    let used_ram = total_ram.saturating_sub(avail_ram);

    serde_json::json!({
        "totalRam": total_ram,
        "availRam": avail_ram,
        "usedRam": used_ram,
        "cpuPct": cpu_pct,
        "loadAvg": load1m,
    })
}
