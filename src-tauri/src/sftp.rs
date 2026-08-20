use async_trait::async_trait;
use russh::client;
use russh_keys::load_secret_key;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

// ---------- État partagé ----------

/// Une connexion active : on garde le handle SSH (sinon la connexion
/// se ferme quand il est drop) + la session SFTP par-dessus.
pub struct ActiveConnection {
    _handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

/// L'état global de l'app : toutes les connexions ouvertes, par identifiant.
/// Mutex de tokio (pas std) car on lock dans du code async.
#[derive(Default)]
pub struct ConnectionPool(pub Mutex<HashMap<String, ActiveConnection>>);

// ---------- Types ----------

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

struct ClientHandler;

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: TOFU
        Ok(true)
    }
}

// ---------- Helpers ----------

fn resolve_key_path(explicit: Option<String>) -> Result<std::path::PathBuf, String> {
    if let Some(p) = explicit {
        let path = std::path::PathBuf::from(shellexpand_tilde(&p));
        return path
            .exists()
            .then_some(path)
            .ok_or_else(|| format!("Clé introuvable : {p}"));
    }
    let home = dirs::home_dir().ok_or("Impossible de trouver le dossier home")?;
    for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
        let candidate = home.join(".ssh").join(name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Aucune clé SSH trouvée dans ~/.ssh".into())
}

fn shellexpand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_string()
}

// ---------- Commands ----------

/// Ouvre une connexion et la stocke. Renvoie l'identifiant à utiliser
/// pour toutes les opérations suivantes.
#[tauri::command]
pub async fn sftp_connect(
    pool: State<'_, ConnectionPool>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
) -> Result<String, String> {
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), ClientHandler)
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;

    // Auth : clé d'abord, mot de passe en fallback
    let mut authenticated = false;

    if let Ok(key_file) = resolve_key_path(key_path) {
        let key = load_secret_key(&key_file, key_passphrase.as_deref())
            .map_err(|e| format!("Lecture de la clé {} impossible : {e}", key_file.display()))?;
        authenticated = session
            .authenticate_publickey(&user, Arc::new(key))
            .await
            .map_err(|e| format!("Erreur d'authentification par clé : {e}"))?;
    }

    if !authenticated {
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            authenticated = session
                .authenticate_password(&user, &pw)
                .await
                .map_err(|e| format!("Erreur d'authentification : {e}"))?;
        }
    }

    if !authenticated {
        return Err("Authentification refusée (clé et mot de passe)".into());
    }

    // Session SFTP
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Ouverture du canal impossible : {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP non disponible : {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Session SFTP impossible : {e}"))?;

    // Stockage dans le pool
    let connection_id = format!("{user}@{host}:{port}");
    pool.0.lock().await.insert(
        connection_id.clone(),
        ActiveConnection {
            _handle: session,
            sftp,
        },
    );

    Ok(connection_id)
}

/// Liste un dossier sur une connexion déjà ouverte. Instantané.
#[tauri::command]
pub async fn sftp_list_dir(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}. Reconnecte-toi."))?;

    let entries = conn
        .sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;

    let mut files: Vec<FileEntry> = entries
        .map(|entry| {
            let meta = entry.metadata();
            FileEntry {
                name: entry.file_name(),
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
            }
        })
        .collect();

    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Ferme et retire une connexion du pool.
#[tauri::command]
pub async fn sftp_disconnect(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
) -> Result<(), String> {
    pool.0.lock().await.remove(&connection_id);
    // Le drop du handle ferme proprement la connexion SSH
    Ok(())
}

/// Liste les connexions actuellement ouvertes.
#[tauri::command]
pub async fn sftp_active_connections(
    pool: State<'_, ConnectionPool>,
) -> Result<Vec<String>, String> {
    Ok(pool.0.lock().await.keys().cloned().collect())
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Télécharge un fichier distant vers un chemin local.
#[tauri::command]
pub async fn sftp_download(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}"))?;

    let mut remote_file = conn
        .sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("Ouverture de {remote_path} impossible : {e}"))?;

    let mut buffer = Vec::new();
    remote_file
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| format!("Lecture de {remote_path} impossible : {e}"))?;

    let local = shellexpand_tilde(&local_path);
    tokio::fs::write(&local, &buffer)
        .await
        .map_err(|e| format!("Écriture de {local} impossible : {e}"))?;

    Ok(buffer.len() as u64)
}

/// Envoie un fichier local vers un chemin distant.
#[tauri::command]
pub async fn sftp_upload(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let local = shellexpand_tilde(&local_path);
    let buffer = tokio::fs::read(&local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;

    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}"))?;

    let mut remote_file = conn
        .sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("Création de {remote_path} impossible : {e}"))?;

    remote_file
        .write_all(&buffer)
        .await
        .map_err(|e| format!("Écriture de {remote_path} impossible : {e}"))?;

    remote_file
        .sync_all()
        .await
        .map_err(|e| format!("Finalisation de {remote_path} impossible : {e}"))?;

    Ok(buffer.len() as u64)
}