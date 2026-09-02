mod bridge;
mod edit;
mod errors;
mod fs;
mod ftp;
mod git;
mod integrity;
mod modules;
mod profiles;
mod search;
mod sftp;
mod shell;
mod text;
mod trash;
mod window;

use edit::EditRegistry;
use ftp::FtpPool;
use search::SearchRegistry;
use sftp::{ConnectionPool, IdleConfig, TransferRegistry};
use shell::{ShellRegistry, TailRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Temps total accordé à la fermeture des connexions quand l'application
/// quitte. Au-delà, on part sans finir : une application qui refuse de
/// quitter est un défaut plus grave qu'une session mal raccrochée.
const SHUTDOWN_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

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

            // Les modules fournis avec l'application sont posés au premier
            // lancement, désactivés : ils s'installent comme n'importe quel
            // module et se mettent à jour indépendamment ensuite.
            modules::install_bundled_modules(app.handle());

            // Les copies de travail des éditions distantes que la session
            // précédente n'a pas pu ranger (plantage, forçage à quitter) :
            // c'est ici qu'on les ramasse, aucun gestionnaire de sortie ne
            // s'étant exécuté dans ce cas-là.
            edit::purge_temp_dir(app.handle());

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
                        let sftp_empty = handle
                            .state::<sftp::ConnectionPool>()
                            .0
                            .lock()
                            .await
                            .is_empty();
                        let ftp_empty = handle.state::<ftp::FtpPool>().0.lock().await.is_empty();
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
            git::sftp_git_status,
            git::sftp_git_show_head,
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
            shell::shell_login_shell,
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
            fs::local_copy,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            modules::modules_list,
            modules::module_set_enabled,
            modules::modules_open_folder,
            modules::module_delete,
            modules::module_read_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running charon")
        .run(|app, event| {
            // Quitter ferme les connexions, toujours.
            //
            // Le feu rouge et ⌘W passent par le front (bilan de session, puis
            // `sftp_disconnect`), mais ⌘Q ne passe par rien : macOS termine
            // l'application, le processus meurt, et les serveurs se retrouvent
            // avec des sessions dont le client s'est évaporé. SSH le constate
            // au bout de son keepalive, FTP au bout de son délai d'inactivité,
            // et pendant tout ce temps la session occupe une place dans les
            // quotas (`MaxStartups` chez sshd, connexions par IP chez la
            // plupart des serveurs FTP).
            //
            // `RunEvent::Exit` est le seul point commun à TOUS les départs :
            // sur macOS ⌘Q y arrive par `applicationWillTerminate`, la
            // fermeture de la dernière fenêtre par le chemin ordinaire. C'est
            // donc ici, et pas dans un gestionnaire de fenêtre, que le ménage
            // se fait.
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                let pool = app.state::<ConnectionPool>();
                let ftp_pool = app.state::<FtpPool>();
                // Bloquant, et c'est voulu : après cette fonction le processus
                // s'en va, une tâche de fond n'aurait pas le temps de vivre.
                // Le plafond global garantit que le pire des serveurs ne
                // retient pas la fermeture (chaque connexion a déjà le sien,
                // celui-ci couvre le cas où elles sont nombreuses).
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(SHUTDOWN_BUDGET, async {
                        tokio::join!(sftp::shutdown(&pool), ftp::shutdown(&ftp_pool))
                    })
                    .await;
                });
                // Et rien ne reste sur le disque : les copies de travail des
                // éditions distantes portent du contenu de fichiers serveur.
                edit::purge_temp_dir(app);
            }
        });
}
