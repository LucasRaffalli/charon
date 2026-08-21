use russh::client;
use russh::keys::known_hosts::learn_known_hosts;
use russh::keys::{check_known_hosts, load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::State;
use tokio::sync::Mutex;

/// Préfixe d'erreur balisée pour le front : hôte inconnu, empreinte à confirmer.
const UNKNOWN_KEY_TAG: &str = "CHARON_UNKNOWN_KEY:";

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

struct ClientHandler {
    host: String,
    port: u16,
    /// Empreinte explicitement acceptée par l'utilisateur (relance après confirmation).
    accepted_fingerprint: Option<String>,
    /// Slot partagé où `check_server_key` dépose l'empreinte d'un hôte inconnu,
    /// pour que `sftp_connect` puisse la renvoyer au front.
    seen_fingerprint: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// TOFU : hôte connu → la clé doit correspondre à ~/.ssh/known_hosts.
    /// Hôte inconnu → on n'apprend la clé que si l'utilisateur a confirmé
    /// son empreinte ; sinon on la dépose dans le slot et on refuse.
    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // Le Display de Fingerprint inclut déjà le préfixe « SHA256: ».
                let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
                *self.seen_fingerprint.lock().unwrap() = Some(fingerprint.clone());
                if self.accepted_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                    return Err(russh::Error::UnknownKey);
                }
                learn_known_hosts(&self.host, self.port, server_public_key)
                    .map_err(|_| russh::Error::UnknownKey)?;
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { line }) => Err(russh::Error::KeyChanged { line }),
            Err(_) => Err(russh::Error::UnknownKey),
        }
    }
}

// ---------- Helpers ----------

/// Refuse les noms d'entrée dangereux annoncés par un serveur (traversée de chemin) :
/// vide, `.`, `..`, ou contenant un séparateur.
pub fn is_safe_entry_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

/// Ceinture + bretelles : refuse tout chemin local contenant un composant `..`.
pub fn ensure_no_parent_dir(path: &str) -> Result<(), String> {
    use std::path::{Component, Path};
    if Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("Chemin refusé (composant « .. ») : {path}"));
    }
    Ok(())
}

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
    accept_new_key: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    // Keepalive : détecte les connexions mortes (~90 s sans réponse) au lieu
    // de laisser des sessions zombies dans le pool.
    let config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let seen_fingerprint = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        host: host.clone(),
        port,
        accepted_fingerprint: accept_new_key,
        seen_fingerprint: Arc::clone(&seen_fingerprint),
    };
    let mut session = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| match e {
            russh::Error::KeyChanged { line } => format!(
                "La clé du serveur a changé (ligne {line} de ~/.ssh/known_hosts). \
                 Risque d'usurpation : vérifie le serveur avant de supprimer cette ligne."
            ),
            russh::Error::UnknownKey => match seen_fingerprint.lock().unwrap().take() {
                Some(fp) => format!("{UNKNOWN_KEY_TAG}{fp}"),
                None => "Vérification de la clé du serveur impossible \
                         (~/.ssh/known_hosts illisible ?)"
                    .into(),
            },
            e => format!("Connexion impossible : {e}"),
        })?;

    // Passphrase : celle fournie explicitement, sinon celle du profil, lue
    // dans le trousseau côté Rust — le secret ne traverse jamais la WebView.
    let passphrase = match key_passphrase.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => match &profile_id {
            Some(id) => crate::profiles::keychain_secret(id)?,
            None => None,
        },
    };

    // Auth : clé d'abord, mot de passe en fallback
    let mut authenticated = false;

    if let Ok(key_file) = resolve_key_path(key_path) {
        let key = load_secret_key(&key_file, passphrase.as_deref())
            .map_err(|e| format!("Lecture de la clé {} impossible : {e}", key_file.display()))?;
        let hash_alg = session
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("Négociation d'algorithme impossible : {e}"))?
            .flatten();
        authenticated = session
            .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg))
            .await
            .map_err(|e| format!("Erreur d'authentification par clé : {e}"))?
            .success();
    }

    if !authenticated {
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            authenticated = session
                .authenticate_password(&user, &pw)
                .await
                .map_err(|e| format!("Erreur d'authentification : {e}"))?
                .success();
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
        .filter(|entry| is_safe_entry_name(&entry.file_name()))
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

/// Crée un dossier distant.
#[tauri::command]
pub async fn sftp_mkdir(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}"))?;
    conn.sftp
        .create_dir(&path)
        .await
        .map_err(|e| format!("Création de {path} impossible : {e}"))
}

/// Supprime un fichier, ou un dossier vide.
#[tauri::command]
pub async fn sftp_remove(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}"))?;
    if is_dir {
        conn.sftp
            .remove_dir(&path)
            .await
            .map_err(|e| format!("Suppression de {path} impossible (dossier non vide ?) : {e}"))
    } else {
        conn.sftp
            .remove_file(&path)
            .await
            .map_err(|e| format!("Suppression de {path} impossible : {e}"))
    }
}

/// Renomme (ou déplace) une entrée distante.
#[tauri::command]
pub async fn sftp_rename(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let pool = pool.0.lock().await;
    let conn = pool
        .get(&connection_id)
        .ok_or(format!("Connexion inconnue : {connection_id}"))?;
    conn.sftp
        .rename(&from, &to)
        .await
        .map_err(|e| format!("Renommage de {from} impossible : {e}"))
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
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;

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
    ensure_no_parent_dir(&local)?;
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