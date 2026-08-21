use russh::client;
use russh::keys::known_hosts::learn_known_hosts;
use russh::keys::{check_known_hosts, load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Préfixe d'erreur balisée pour le front : hôte inconnu, empreinte à confirmer.
const UNKNOWN_KEY_TAG: &str = "CHARON_UNKNOWN_KEY:";
/// Erreur balisée pour le front : transfert annulé par l'utilisateur.
const CANCELLED_TAG: &str = "CHARON_CANCELLED";
/// Taille des chunks de streaming (download et upload).
const CHUNK_SIZE: usize = 1024 * 1024;
/// Émettre un event de progression au plus tous les N octets transférés.
const PROGRESS_STEP: u64 = 512 * 1024;

// ---------- État partagé ----------

/// Une connexion active : on garde le handle SSH (sinon la connexion
/// se ferme quand il est drop) + la session SFTP par-dessus.
pub struct ActiveConnection {
    _handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
}

/// L'état global de l'app : toutes les connexions ouvertes, par identifiant.
/// Mutex de tokio (pas std) car on lock dans du code async. Les connexions
/// sont dans des `Arc` : on clone la référence puis on relâche le verrou,
/// pour qu'un transfert long ne bloque jamais les autres opérations.
#[derive(Default)]
pub struct ConnectionPool(pub Mutex<HashMap<String, Arc<ActiveConnection>>>);

/// Transferts en cours, par identifiant : le drapeau passe à `true`
/// quand l'utilisateur demande l'annulation.
#[derive(Default)]
pub struct TransferRegistry(pub StdMutex<HashMap<String, Arc<AtomicBool>>>);

// ---------- Types ----------

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Payload de l'event `transfer:progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress<'a> {
    id: &'a str,
    transferred: u64,
    total: u64,
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

/// Récupère une connexion du pool sans garder le verrou : un transfert long
/// ne bloque ni les listages ni les autres transferts.
async fn get_connection(
    pool: &State<'_, ConnectionPool>,
    connection_id: &str,
) -> Result<Arc<ActiveConnection>, String> {
    // `.inner()` explicite : rust-analyzer bute sur le deref de State à
    // travers son champ tuple privé (rustc, lui, l'accepte).
    pool.inner()
        .0
        .lock()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("Connexion inconnue : {connection_id}. Reconnecte-toi."))
}

fn register_transfer(registry: &State<'_, TransferRegistry>, transfer_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    registry
        .inner()
        .0
        .lock()
        .unwrap()
        .insert(transfer_id.to_string(), Arc::clone(&flag));
    flag
}

fn unregister_transfer(registry: &State<'_, TransferRegistry>, transfer_id: &str) {
    registry.inner().0.lock().unwrap().remove(transfer_id);
}

fn emit_progress(app: &AppHandle, id: &str, transferred: u64, total: u64) {
    let _ = app.emit(
        "transfer:progress",
        TransferProgress {
            id,
            transferred,
            total,
        },
    );
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
    pool.inner().0.lock().await.insert(
        connection_id.clone(),
        Arc::new(ActiveConnection {
            _handle: session,
            sftp,
        }),
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
    let conn = get_connection(&pool, &connection_id).await?;

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
    pool.inner().0.lock().await.remove(&connection_id);
    // Le drop du handle ferme proprement la connexion SSH
    Ok(())
}

/// Liste les connexions actuellement ouvertes.
#[tauri::command]
pub async fn sftp_active_connections(
    pool: State<'_, ConnectionPool>,
) -> Result<Vec<String>, String> {
    Ok(pool.inner().0.lock().await.keys().cloned().collect())
}

/// Crée un dossier distant.
#[tauri::command]
pub async fn sftp_mkdir(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_connection(&pool, &connection_id).await?;
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
    let conn = get_connection(&pool, &connection_id).await?;
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

/// Garde-fou de la suppression récursive : au-delà, on refuse (arbre suspect
/// ou boucle côté serveur).
const MAX_RECURSIVE_ENTRIES: usize = 100_000;

/// Supprime récursivement un dossier distant : walk complet d'abord
/// (fichiers puis dossiers en ordre inverse), suppression ensuite.
/// Les liens symboliques sont déliés sans être suivis (attrs lstat du
/// READDIR : un lien vers un dossier n'est pas `is_dir`).
#[tauri::command]
pub async fn sftp_remove_all(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<u64, String> {
    let conn = get_connection(&pool, &connection_id).await?;

    let mut to_visit = vec![path];
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();

    while let Some(dir) = to_visit.pop() {
        let entries = conn
            .sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("Lecture de {dir} impossible : {e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if !is_safe_entry_name(&name) {
                continue;
            }
            let child = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            if entry.metadata().is_dir() {
                to_visit.push(child);
            } else {
                files.push(child);
            }
        }
        dirs.push(dir);
        if dirs.len() + files.len() > MAX_RECURSIVE_ENTRIES {
            return Err(format!(
                "Plus de {MAX_RECURSIVE_ENTRIES} entrées — suppression refusée par prudence."
            ));
        }
    }

    let total = (dirs.len() + files.len()) as u64;
    for file in &files {
        conn.sftp
            .remove_file(file)
            .await
            .map_err(|e| format!("Suppression de {file} impossible : {e}"))?;
    }
    // Les dossiers en ordre inverse : les enfants avant leurs parents.
    for dir in dirs.iter().rev() {
        conn.sftp
            .remove_dir(dir)
            .await
            .map_err(|e| format!("Suppression de {dir} impossible : {e}"))?;
    }

    Ok(total)
}

/// Renomme (ou déplace) une entrée distante.
#[tauri::command]
pub async fn sftp_rename(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = get_connection(&pool, &connection_id).await?;
    conn.sftp
        .rename(&from, &to)
        .await
        .map_err(|e| format!("Renommage de {from} impossible : {e}"))
}

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Télécharge un fichier distant vers un chemin local, en streaming par
/// chunks : mémoire bornée quel que soit la taille du fichier, progression
/// via l'event `transfer:progress`, annulation via `sftp_transfer_cancel`.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    eprintln!("[charon] download {remote_path} -> {local_path} (début)");
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result = stream_download(&app, &conn, &remote_path, &local, &transfer_id, &cancel).await;
    unregister_transfer(&registry, &transfer_id);

    // Annulation ou erreur : pas de fichier partiel laissé derrière.
    if result.is_err() {
        let _ = tokio::fs::remove_file(&local).await;
    }
    eprintln!("[charon] download {remote_path} : {result:?}");
    result
}

async fn stream_download(
    app: &AppHandle,
    conn: &ActiveConnection,
    remote_path: &str,
    local: &str,
    transfer_id: &str,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let total = conn
        .sftp
        .metadata(remote_path)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);

    let mut remote_file = conn
        .sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Ouverture de {remote_path} impossible : {e}"))?;
    let mut local_file = tokio::fs::File::create(local)
        .await
        .map_err(|e| format!("Écriture de {local} impossible : {e}"))?;

    emit_progress(app, transfer_id, 0, total);

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut transferred: u64 = 0;
    let mut last_emitted: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED_TAG.into());
        }
        let read = remote_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {remote_path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Écriture de {local} impossible : {e}"))?;
        transferred += read as u64;
        if transferred - last_emitted >= PROGRESS_STEP {
            last_emitted = transferred;
            emit_progress(app, transfer_id, transferred, total);
        }
    }

    local_file
        .flush()
        .await
        .map_err(|e| format!("Écriture de {local} impossible : {e}"))?;
    emit_progress(app, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Envoie un fichier local vers un chemin distant, en streaming par chunks
/// (mêmes garanties que `sftp_download`).
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    eprintln!("[charon] upload {local_path} -> {remote_path} (début)");
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result = stream_upload(&app, &conn, &local, &remote_path, &transfer_id, &cancel).await;
    unregister_transfer(&registry, &transfer_id);

    // Annulation ou erreur : on retire le fichier distant partiel.
    if result.is_err() {
        let _ = conn.sftp.remove_file(&remote_path).await;
    }
    eprintln!("[charon] upload {remote_path} : {result:?}");
    result
}

async fn stream_upload(
    app: &AppHandle,
    conn: &ActiveConnection,
    local: &str,
    remote_path: &str,
    transfer_id: &str,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;
    if meta.is_dir() {
        return Err(format!(
            "« {local} » est un dossier — l'envoi de dossiers n'est pas encore géré."
        ));
    }
    let total = meta.len();

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;

    eprintln!("[charon]   création distante de {remote_path}…");
    let mut remote_file = conn
        .sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("Création de {remote_path} impossible : {e}"))?;
    eprintln!("[charon]   créé, envoi de {total} octets…");

    emit_progress(app, transfer_id, 0, total);

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut transferred: u64 = 0;
    let mut last_emitted: u64 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED_TAG.into());
        }
        let read = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Écriture de {remote_path} impossible : {e}"))?;
        transferred += read as u64;
        if transferred - last_emitted >= PROGRESS_STEP {
            last_emitted = transferred;
            emit_progress(app, transfer_id, transferred, total);
        }
    }

    remote_file
        .sync_all()
        .await
        .map_err(|e| format!("Finalisation de {remote_path} impossible : {e}"))?;
    emit_progress(app, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Demande l'annulation d'un transfert en cours (sans effet s'il est terminé).
#[tauri::command]
pub fn sftp_transfer_cancel(
    registry: State<'_, TransferRegistry>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(flag) = registry.inner().0.lock().unwrap().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}