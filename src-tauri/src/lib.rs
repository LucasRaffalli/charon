mod edit;
mod fs;
mod ftp;
mod integrity;
mod modules;
mod profiles;
mod search;
mod sftp;
mod shell;
mod trash;

use ftp::FtpPool;
use sftp::{ConnectionPool, IdleConfig, TransferRegistry};
use edit::EditRegistry;
use search::SearchRegistry;
use shell::{ShellRegistry, TailRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Les devtools ne s'ouvrent PAS d'office : ouverture manuelle en
            // dev (clic droit → Inspecter, ou Cmd+Option+I) ; verrouillés en
            // build release de toute façon.

            // Fermeture des connexions inactives (vérification toutes les 30 s
            // — les sessions interactives (terminal, tail, édition) posent un
            // « hold » qui suspend la fermeture).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u32 = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    // Toutes les 5 s : lire l'état local des sessions SSH
                    // (gratuit). Toutes les 30 s : sonde FTP + inactivité.
                    sftp::watch_lost_connections(&handle).await;
                    tick = tick.wrapping_add(1);
                    if tick % 6 == 0 {
                        ftp::watch_lost_connections(&handle).await;
                        sftp::reap_idle_connections(&handle).await;
                        ftp::reap_idle_connections(&handle).await;
                    }
                }
            });

            Ok(())
        })
        .manage(ConnectionPool::default())
        .manage(FtpPool::default())
        .manage(TransferRegistry::default())
        .manage(sftp::ConnectRegistry::default())
        .manage(IdleConfig::default())
        .manage(ShellRegistry::default())
        .manage(TailRegistry::default())
        .manage(SearchRegistry::default())
        .manage(EditRegistry::default())
        .invoke_handler(tauri::generate_handler![
            sftp::sftp_connect,
            sftp::sftp_list_dir,
            sftp::sftp_stat,
            sftp::sftp_read_text,
            sftp::sftp_read_base64,
            sftp::sftp_write_text,
            sftp::sftp_disconnect,
            sftp::sftp_active_connections,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_transfer_cancel,
            sftp::set_idle_timeout,
            sftp::sftp_mkdir,
            sftp::sftp_create_file,
            sftp::sftp_remove,
            sftp::sftp_remove_all,
            sftp::sftp_rename,
            sftp::sftp_system_stats,
            sftp::sftp_disk_usage,
            ftp::ftp_connect,
            ftp::ftp_list_dir,
            ftp::ftp_disconnect,
            ftp::ftp_mkdir,
            ftp::ftp_remove,
            ftp::ftp_remove_all,
            ftp::ftp_rename,
            ftp::ftp_download,
            ftp::ftp_upload,
            shell::sftp_sudo,
            shell::shell_open,
            shell::shell_write,
            shell::shell_resize,
            shell::shell_close,
            integrity::local_sha256,
            integrity::sftp_sha256,
            trash::sftp_trash,
            trash::sftp_trash_list,
            trash::sftp_trash_size,
            sftp::sftp_chmod,
            sftp::sftp_copy,
            sftp::sftp_probe,
            search::search_start,
            search::search_stop,
            shell::tail_open,
            shell::tail_close,
            edit::edit_open,
            edit::edit_stop,
            sftp::connect_cancel,
            fs::local_home_dir,
            fs::local_export_config,
            fs::local_list_dir,
            fs::local_stat,
            fs::local_read_text,
            fs::local_mkdir,
            fs::local_create_file,
            fs::local_remove,
            fs::local_remove_all,
            fs::local_rename,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            modules::modules_list,
            modules::module_set_enabled,
            modules::modules_open_folder,
            modules::module_delete,
            modules::module_read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running charon");
}