// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
