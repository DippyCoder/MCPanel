// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Single-instance guard: write our PID to a file and check /proc/<pid>
    // to see if a previous instance is still alive. If so, exit immediately.
    // This stops the AppImage from accumulating zombie instances when it is
    // launched multiple times before the window appears.
    ensure_single_instance();

    // WebKit2GTK on Fedora/Wayland: the WebKitWebProcess crashes when it tries
    // to connect to an X11 display that doesn't exist. Two mitigations:
    //   1. Disable GPU compositing (avoids the WebKitWebProcess fork failing).
    //   2. Force GTK to use Wayland when DISPLAY is absent so GTK/WebKit don't
    //      fall back to a non-existent X11 socket.
    // These must be set before tauri::Builder initialises GTK.
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    // KDE sets both DISPLAY (XWayland) and WAYLAND_DISPLAY simultaneously, so
    // checking DISPLAY.is_err() never triggered there. Force the Wayland backend
    // whenever a Wayland compositor is present, unless the caller already set it.
    if std::env::var("WAYLAND_DISPLAY").is_ok() && std::env::var("GDK_BACKEND").is_err() {
        std::env::set_var("GDK_BACKEND", "wayland");
    }

    mcpanel_lib::run()
}

fn ensure_single_instance() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let lock_dir = format!("{}/.local/share/mcpanel", home);
    let _ = std::fs::create_dir_all(&lock_dir);
    let lock_path = format!("{}/mcpanel.pid", lock_dir);

    if let Ok(content) = std::fs::read_to_string(&lock_path) {
        if let Ok(pid) = content.trim().parse::<u32>() {
            let proc_path = format!("/proc/{}", pid);
            if std::path::Path::new(&proc_path).exists() {
                // Confirm the process at this PID is actually MCPanel, not a
                // PID-recycled unrelated process (common cause of silent crashes
                // on RPM installs where the lock file survives a crash).
                let their_exe = std::fs::read_link(format!("{}/exe", proc_path));
                let our_exe = std::fs::read_link("/proc/self/exe");
                if let (Ok(theirs), Ok(ours)) = (their_exe, our_exe) {
                    if theirs == ours {
                        std::process::exit(0);
                    }
                }
                // PID exists but belongs to a different binary — stale lock, fall through.
            }
        }
    }

    // No live MCPanel instance found — claim the lock with our PID.
    let _ = std::fs::write(&lock_path, std::process::id().to_string());
}
