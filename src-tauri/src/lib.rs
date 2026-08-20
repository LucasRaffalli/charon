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
        ])
        .run(tauri::generate_context!())
        .expect("error while running charon");
}