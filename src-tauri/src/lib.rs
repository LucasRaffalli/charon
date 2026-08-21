mod fs;
mod profiles;
mod sftp;

use sftp::ConnectionPool;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(ConnectionPool::default())
        .invoke_handler(tauri::generate_handler![
            sftp::sftp_connect,
            sftp::sftp_list_dir,
            sftp::sftp_disconnect,
            sftp::sftp_active_connections,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            fs::local_home_dir,
            fs::local_list_dir,
            fs::local_mkdir,
            fs::local_remove,
            fs::local_rename,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            profiles::profile_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running charon");
}