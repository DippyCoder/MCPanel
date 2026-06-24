// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // If `mcpanel` on PATH resolves to this GUI binary instead of the Python CLI,
    // `check_cli` in the running app will spawn this binary as a subprocess to
    // verify the CLI is present. Exit immediately for any non-GUI argument so the
    // subprocess returns a non-zero code instantly rather than opening a window and
    // hanging for the full CLI-check timeout.
    if std::env::args().skip(1).any(|a| {
        matches!(
            a.as_str(),
            "--version" | "-V" | "--help" | "-h" | "api" | "start" | "stop"
                | "restart" | "kill" | "fetch" | "list" | "create" | "delete"
                | "import" | "scan" | "detect-jdk" | "system" | "versions"
                | "open" | "config"
        )
    }) {
        std::process::exit(1);
    }

    // Disable GPU compositing in WebKit2GTK to prevent fatal Wayland protocol
    // errors (EPROTO / Error 71) during WebKit network process initialization
    // on Wayland. Must be set before WebKit initializes.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    mcpanel_lib::run()
}
