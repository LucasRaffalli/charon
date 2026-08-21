mod fs;
mod ftp;
mod profiles;
mod sftp;
mod shell;

use ftp::FtpPool;
use sftp::{ConnectionPool, IdleConfig, TransferRegistry};
use shell::ShellRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Console ouverte d'office en dev ; inerte en build release
            // (les devtools n'existent qu'en debug, la prod reste verrouillée).
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Fermeture des connexions inactives (vérification chaque minute).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    sftp::reap_idle_connections(&handle).await;
                    ftp::reap_idle_connections(&handle).await;
                }
            });

            Ok(())
        })
        .manage(ConnectionPool::default())
        .manage(FtpPool::default())
        .manage(TransferRegistry::default())
        .manage(IdleConfig::default())
        .manage(ShellRegistry::default())
        .invoke_handler(tauri::generate_handler![
            sftp::sftp_connect,
            sftp::sftp_list_dir,
            sftp::sftp_disconnect,
            sftp::sftp_active_connections,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_transfer_cancel,
            sftp::set_idle_timeout,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_remove_all,
            sftp::sftp_rename,
            ftp::ftp_connect,
            ftp::ftp_list_dir,
            ftp::ftp_disconnect,
            ftp::ftp_mkdir,
            ftp::ftp_remove,
            ftp::ftp_remove_all,
            ftp::ftp_rename,
            ftp::ftp_download,
            ftp::ftp_upload,
            shell::shell_open,
            shell::shell_write,
            shell::shell_resize,
            shell::shell_close,
            fs::local_home_dir,
            fs::local_list_dir,
            fs::local_mkdir,
            fs::local_remove,
            fs::local_remove_all,
            fs::local_rename,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running charon");
}