use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

mod commands;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(commands::AppState {
                log_streamers: Mutex::new(HashMap::new()),
                app_handle: handle,
            });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::check_cli,
            commands::run_cli,
            commands::save_config,
            commands::update_server,
            commands::accept_eula,
            commands::duplicate_server,
            commands::start_server,
            commands::stop_log_stream,
            commands::create_server,
            commands::import_server_cmd,
            commands::send_server_command,
            commands::ping_server,
            commands::get_theme_css,
            commands::get_app_version,
            commands::open_external,
            commands::open_path,
            commands::browse_folder,
            commands::browse_file,
            commands::install_cli,
            commands::get_app_log_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
