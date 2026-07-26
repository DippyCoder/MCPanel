// ─── MCPanel's own diagnostic log ──────────────────────────────────────────
//
// Distinct from per-server console logs (those live under run/<id>.log.jsonl
// and are shown in the Console tab). This is MCPanel-the-app's own record of
// what it did — CLI invocations, install steps, errors — kept in its own
// `logs/` folder so it never gets confused with a Minecraft server's output.
//
// Rotation:
//   - a fresh `latest.log` starts on every app launch
//   - `latest.log` rotates to a timestamped file when it crosses 10,000 lines
//     or when the local calendar day changes
//   - oldest rotated files are deleted once the configured file count (see
//     `app-settings.json`'s `maxLogFiles`, default 10) is exceeded
//
// Near-duplicate lines that repeat within a short window (e.g. the same
// "fetch status" line for many server ids in a row) are bundled into one
// summarized line instead of flooding the file — see `Pending`.

use chrono::Local;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::commands::mcpanel_home;

const MAX_LINES_PER_FILE: usize = 10_000;
const BUNDLE_WINDOW: Duration = Duration::from_secs(5);
const DEFAULT_MAX_FILES: u64 = 10;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn tag(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

struct FileState {
    date: String, // local YYYY-MM-DD the current latest.log was opened on
    line_count: usize,
}

struct Pending {
    level: Level,
    template: String,   // message with the differing token replaced by "{}"
    tokens: Vec<String>, // distinct tokens seen (e.g. server ids)
    count: u32,
    first_seen: Instant,
}

static FILE_STATE: OnceLock<Mutex<FileState>> = OnceLock::new();
static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();

fn logs_dir() -> String {
    format!("{}/logs", mcpanel_home())
}

fn latest_path() -> String {
    format!("{}/latest.log", logs_dir())
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn os_label() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            let mut id = None;
            let mut version_id = None;
            for line in content.lines() {
                if let Some(v) = line.strip_prefix("ID=") {
                    id = Some(v.trim_matches('"').to_string());
                } else if let Some(v) = line.strip_prefix("VERSION_ID=") {
                    version_id = Some(v.trim_matches('"').to_string());
                }
            }
            if let Some(id) = id {
                return match version_id {
                    Some(v) => format!("{} {} / linux", id, v),
                    None => format!("{} / linux", id),
                };
            }
        }
        "linux".to_string()
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::env::consts::OS.to_string()
    }
}

/// Call once at app startup, before anything else logs.
pub fn init(app_version: &str) {
    let _ = std::fs::create_dir_all(logs_dir());
    PENDING.set(Mutex::new(None)).ok();

    // A previous run's latest.log (if the app crashed or was killed without
    // a clean rotation) becomes an archived file so this run starts fresh.
    rotate_if_nonempty();
    prune_old_files();

    FILE_STATE
        .set(Mutex::new(FileState {
            date: today(),
            line_count: 0,
        }))
        .ok();

    let tz = Local::now().format("%:z").to_string();
    write_line(Level::Info, "== MCPanel starting ==".into());
    write_line(Level::Info, format!("Version: {}", app_version));
    write_line(
        Level::Info,
        format!("OS: {} ({})", os_label(), std::env::consts::ARCH),
    );
    write_line(Level::Info, format!("Timezone: UTC{}", tz));
    write_line(Level::Info, format!("Started: {}", timestamp()));

    // Background tick: flushes a bundled group once it's been open 5s even
    // if nothing new arrives to trigger that flush, and rotates the file at
    // midnight even if the app is otherwise idle.
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(2));
        flush_pending_if_stale();
        rotate_if_new_day();
    });
}

pub fn info(msg: impl Into<String>) {
    submit(Level::Info, msg.into());
}
pub fn warn(msg: impl Into<String>) {
    submit(Level::Warn, msg.into());
}
pub fn error(msg: impl Into<String>) {
    submit(Level::Error, msg.into());
}

/// Also records the CLI's own reported version alongside our startup banner,
/// once it's known (checked async right after launch).
pub fn note_cli_version(version: &str) {
    write_line(Level::Info, format!("MCPanel-CLI version: {}", version));
}

// ─── Bundling ───────────────────────────────────────────────────────────────

// Splits a message like "run_cli: mcpanel fetch status -id abc123" into
// ("run_cli: mcpanel fetch status -id {}", "abc123") so repeats that only
// differ by that trailing token can be bundled into one line.
fn normalize(msg: &str) -> (String, Option<String>) {
    if let Some(idx) = msg.find("-id ") {
        let after = idx + 4;
        let rest = &msg[after..];
        let token_len = rest.find(' ').unwrap_or(rest.len());
        let token = &rest[..token_len];
        if !token.is_empty() {
            let mut template = String::with_capacity(msg.len());
            template.push_str(&msg[..after]);
            template.push_str("{}");
            template.push_str(&rest[token_len..]);
            return (template, Some(token.to_string()));
        }
    }
    (msg.to_string(), None)
}

fn submit(level: Level, msg: String) {
    let (template, token) = normalize(&msg);
    let mut guard = PENDING.get_or_init(|| Mutex::new(None)).lock().unwrap();

    if let Some(p) = guard.as_mut() {
        if p.level == level && p.template == template && p.first_seen.elapsed() < BUNDLE_WINDOW {
            p.count += 1;
            if let Some(t) = token {
                if !p.tokens.contains(&t) {
                    p.tokens.push(t);
                }
            }
            return;
        }
        let finished = guard.take().unwrap();
        drop(guard);
        flush(finished);
        guard = PENDING.get().unwrap().lock().unwrap();
    }

    *guard = Some(Pending {
        level,
        template,
        tokens: token.into_iter().collect(),
        count: 1,
        first_seen: Instant::now(),
    });
}

fn flush_pending_if_stale() {
    let Some(pending_lock) = PENDING.get() else { return };
    let mut guard = pending_lock.lock().unwrap();
    let is_stale = guard
        .as_ref()
        .map(|p| p.first_seen.elapsed() >= BUNDLE_WINDOW)
        .unwrap_or(false);
    if !is_stale {
        return;
    }
    let finished = guard.take().unwrap();
    drop(guard);
    flush(finished);
}

fn flush(p: Pending) {
    let line = if p.count <= 1 {
        p.template.replacen("{}", p.tokens.first().map(|s| s.as_str()).unwrap_or(""), 1)
    } else {
        const MAX_SHOWN: usize = 8;
        let shown: Vec<&str> = p.tokens.iter().take(MAX_SHOWN).map(|s| s.as_str()).collect();
        let mut ids = shown.join(", ");
        if p.tokens.len() > MAX_SHOWN {
            ids.push_str(&format!(", …+{} more", p.tokens.len() - MAX_SHOWN));
        }
        let base = p.template.replacen("{}", &format!("[{}]", ids), 1);
        format!("{} (×{})", base, p.count)
    };
    write_line(p.level, line);
}

// ─── File writing / rotation ────────────────────────────────────────────────

fn write_line(level: Level, msg: String) {
    let Some(state_lock) = FILE_STATE.get() else {
        // init() hasn't run (shouldn't happen in practice) — best-effort direct write.
        let _ = std::fs::create_dir_all(logs_dir());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(latest_path()) {
            let _ = writeln!(f, "[{}] [{}] {}", timestamp(), level.tag(), msg);
        }
        return;
    };
    let mut state = state_lock.lock().unwrap();

    if state.date != today() {
        drop(state);
        rotate();
        state = state_lock.lock().unwrap();
    }
    if state.line_count >= MAX_LINES_PER_FILE {
        drop(state);
        rotate();
        state = state_lock.lock().unwrap();
    }

    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(latest_path()) {
        let _ = writeln!(f, "[{}] [{}] {}", timestamp(), level.tag(), msg);
        state.line_count += 1;
    }
}

fn rotate_if_new_day() {
    let Some(state_lock) = FILE_STATE.get() else { return };
    let state = state_lock.lock().unwrap();
    if state.date != today() {
        drop(state);
        rotate();
    }
}

// Renames the current latest.log to a timestamped archive name and starts a
// fresh, empty latest.log. Safe to call when latest.log doesn't exist yet.
fn rotate() {
    rotate_if_nonempty();
    prune_old_files();
    if let Some(state_lock) = FILE_STATE.get() {
        *state_lock.lock().unwrap() = FileState { date: today(), line_count: 0 };
    }
}

fn rotate_if_nonempty() {
    let path = latest_path();
    let Ok(meta) = std::fs::metadata(&path) else { return };
    if meta.len() == 0 {
        return;
    }
    let base = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut archive = format!("{}/{}.log", logs_dir(), base);
    let mut n = 1;
    while std::path::Path::new(&archive).exists() {
        archive = format!("{}/{}-{}.log", logs_dir(), base, n);
        n += 1;
    }
    let _ = std::fs::rename(&path, &archive);
}

fn max_files_setting() -> u64 {
    let path = format!("{}/app-settings.json", mcpanel_home());
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("maxLogFiles").and_then(|n| n.as_u64()))
        .filter(|n| *n >= 1)
        .unwrap_or(DEFAULT_MAX_FILES)
}

fn prune_old_files() {
    let dir = logs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut archived: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name != "latest.log" && name.ends_with(".log") {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    archived.sort(); // timestamp-prefixed names sort chronologically

    let max_total = max_files_setting().max(1) as usize;
    let archive_limit = max_total.saturating_sub(1); // latest.log takes one slot
    if archived.len() > archive_limit {
        for name in &archived[..archived.len() - archive_limit] {
            let _ = std::fs::remove_file(format!("{}/{}", dir, name));
        }
    }
}
