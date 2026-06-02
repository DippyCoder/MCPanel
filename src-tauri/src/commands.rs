use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ─── App State ────────────────────────────────────────────────────────────────

pub struct AppState {
    pub log_streamers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    pub app_handle: AppHandle,
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

    // Update server.properties if port changed
    if let Some(port) = updates.get("port").and_then(|p| p.as_i64()) {
        if let Some(dir) = srv["dir"].as_str() {
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

#[tauri::command]
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

// ─── Logs ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_log_path() -> String {
    app_log_path()
}
