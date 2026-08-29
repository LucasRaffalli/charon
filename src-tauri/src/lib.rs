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
mod bridge;
mod window;

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
                use tauri::Manager;
                let mut tick: u32 = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    // Aucune connexion nulle part : rien à surveiller, on
                    // dort plus longtemps (moins de réveils = App Nap et
                    // batterie contents). Au pire, la surveillance reprend
                    // 30 s après la première connexion — le keepalive et les
                    // sondes à la demande couvrent largement cette fenêtre.
                    let idle = {
                        let sftp_empty =
                            handle.state::<sftp::ConnectionPool>().0.lock().await.is_empty();
                        let ftp_empty =
                            handle.state::<ftp::FtpPool>().0.lock().await.is_empty();
                        sftp_empty && ftp_empty
                    };
                    if idle {
                        tokio::time::sleep(std::time::Duration::from_secs(25)).await;
                        continue;
                    }
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
        .on_window_event(|window, event| {
            use tauri::Manager;
            match event {
                // L'ordre de focus sert d'ordre de premier plan au glissé
                // entre fenêtres : deux fenêtres qui se chevauchent sous le
                // curseur, c'est la plus récemment active qui reçoit.
                tauri::WindowEvent::Focused(true) => {
                    let order = window.app_handle().state::<bridge::FocusOrder>();
                    bridge::note_focus(&order, window.label());
                }
                _ => {}
            }
        })
        .manage(ConnectionPool::default())
        .manage(FtpPool::default())
        .manage(TransferRegistry::default())
        .manage(sftp::ConnectRegistry::default())
        .manage(IdleConfig::default())
        .manage(ShellRegistry::default())
        .manage(TailRegistry::default())
        .manage(SearchRegistry::default())
        .manage(window::WindowBoot::default())
        .manage(bridge::RemoteClipboard::default())
        .manage(bridge::DragBroker::default())
        .manage(bridge::FocusOrder::default())
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
            bridge::clip_set,
            bridge::drag_feed,
            bridge::clip_get,
            bridge::clip_clear,
            bridge::sftp_transfer_remote,
            window::window_open,
            window::window_boot_profile,
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