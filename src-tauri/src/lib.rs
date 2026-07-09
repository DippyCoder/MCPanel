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
                app_handle: handle.clone(),
                active_backup: Mutex::new(None),
            });
            app.manage(commands::PtyState {
                master: Mutex::new(None),
                writer: Mutex::new(None),
            });
            tauri::async_runtime::spawn(commands::run_scheduler(handle));
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
            commands::get_log_since,
            commands::open_terminal,
            commands::write_server_file,
            commands::upload_files_to_server,
            commands::delete_server_file,
            commands::create_server_dir,
            commands::create_server_file,
            commands::rename_server_file,
            commands::read_server_file,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
            commands::get_server_start_time,
            commands::check_first_start_flag,
            commands::quit_app,
            commands::proxy_info,
            commands::link_to_proxy,
            commands::get_velocity_secret,
            commands::get_system_stats,
            commands::get_default_theme,
            commands::set_default_theme,
            commands::ensure_builtin_themes,
            commands::theme_exists,
            commands::install_builtin_theme,
            commands::get_themes,
            commands::delete_theme,
            commands::check_app_update,
            commands::check_cli_update,
            commands::fetch_github_themes,
            commands::install_theme_from_file,
            commands::install_theme_from_url,
            commands::update_profile,
            commands::get_profile_file_tree,
            commands::read_profile_file,
            commands::write_profile_file,
            commands::delete_profile_file,
            commands::create_profile_dir,
            commands::create_profile_file,
            commands::rename_profile_file,
            commands::upload_files_to_profile,
            commands::create_backup,
            commands::list_backups,
            commands::delete_backup,
            commands::restore_backup,
            commands::get_schedules,
            commands::save_schedule,
            commands::delete_schedule,
            commands::run_schedule_now,
            commands::get_app_settings,
            commands::save_app_settings,
            commands::shutdown_all_servers,
            commands::list_system_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
