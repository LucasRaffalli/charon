use russh::client;
use russh::ChannelMsg;
use russh::keys::known_hosts::learn_known_hosts;
use russh::keys::{check_known_hosts, load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Préfixe d'erreur balisée pour le front : hôte inconnu, empreinte à confirmer.
const UNKNOWN_KEY_TAG: &str = "CHARON_UNKNOWN_KEY:";
/// Erreur balisée pour le front : transfert annulé par l'utilisateur.
pub(crate) const CANCELLED_TAG: &str = "CHARON_CANCELLED";
/// Taille des chunks de streaming (download et upload).
pub(crate) const CHUNK_SIZE: usize = 1024 * 1024;
/// Émettre un event de progression au plus tous les N octets transférés.
pub(crate) const PROGRESS_STEP: u64 = 512 * 1024;

// ---------- État partagé ----------

/// Une connexion active : on garde le handle SSH (sinon la connexion
/// se ferme quand il est drop) + la session SFTP par-dessus.
pub struct ActiveConnection {
    _handle: client::Handle<ClientHandler>,
    sftp: SftpSession,
    /// Dernier usage : sert à la fermeture d'inactivité.
    last_used: StdMutex<std::time::Instant>,
    /// Sessions interactives ouvertes (terminal, tail -F, édition externe) :
    /// tant qu'il y en a au moins une, la fermeture d'inactivité est suspendue.
    holds: AtomicUsize,
}

impl ActiveConnection {
    fn touch(&self) {
        *self.last_used.lock().unwrap() = std::time::Instant::now();
    }

    fn idle_for(&self) -> std::time::Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    fn hold_count(&self) -> usize {
        self.holds.load(Ordering::Relaxed)
    }

    /// Ouvre un canal supplémentaire sur la session SSH (terminal intégré).
    pub(crate) async fn open_channel(
        &self,
    ) -> Result<russh::Channel<client::Msg>, russh::Error> {
        self.touch();
        self._handle.channel_open_session().await
    }

    /// Exécute une commande via un canal exec, injecte `stdin` puis EOF, et
    /// capture `(code de sortie, sortie fusionnée stdout+stderr)`. Support du
    /// sudo : le mot de passe est écrit sur stdin (`sudo -S`), consommé par la
    /// commande distante, et n'est jamais conservé côté Charon.
    pub(crate) async fn exec_capture(
        &self,
        command: String,
        stdin: &[u8],
    ) -> Result<(u32, String), String> {
        self.touch();
        let channel = self
            ._handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Ouverture du canal impossible : {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Exécution impossible : {e}"))?;

        let (mut read, write) = channel.split();
        if !stdin.is_empty() {
            write
                .data_bytes(stdin.to_vec())
                .await
                .map_err(|e| format!("Écriture stdin impossible : {e}"))?;
        }
        let _ = write.eof().await;

        let mut output = Vec::new();
        let mut code: u32 = 0;
        loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    output.extend_from_slice(&data);
                    // Garde-fou mémoire : une sortie hostile ne gonfle pas sans fin.
                    if output.len() > 64 * 1024 {
                        output.truncate(64 * 1024);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status,
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok((code, String::from_utf8_lossy(&output).into_owned()))
    }

    /// Lit un fichier distant en entier (édition distante — fichiers texte).
    pub(crate) async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        self.touch();
        let mut file = self
            .sftp
            .open(path)
            .await
            .map_err(|e| format!("Ouverture de {path} impossible : {e}"))?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
        Ok(buffer)
    }

    /// Écrit (crée/remplace) un fichier distant depuis des octets bruts.
    pub(crate) async fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.touch();
        let mut file = self
            .sftp
            .create(path)
            .await
            .map_err(|e| format!("Création de {path} impossible : {e}"))?;
        file.write_all(bytes)
            .await
            .map_err(|e| format!("Écriture de {path} impossible : {e}"))?;
        file.sync_all()
            .await
            .map_err(|e| format!("Finalisation de {path} impossible : {e}"))
    }
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

/// Métadonnées d'une entrée (pour détecter conflits / écrasements).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    /// Date de modification (epoch secondes) ; 0 si inconnue.
    pub mtime: u64,
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

/// Guard RAII d'une session interactive (terminal, tail, édition externe) :
/// tant qu'il vit, la connexion est à l'abri de la fermeture d'inactivité ;
/// son drop relâche la connexion et fait repartir le chrono de zéro.
pub(crate) struct ConnectionHold {
    conn: Arc<ActiveConnection>,
}

impl ConnectionHold {
    pub(crate) fn new(conn: Arc<ActiveConnection>) -> Self {
        conn.holds.fetch_add(1, Ordering::Relaxed);
        Self { conn }
    }
}

impl Drop for ConnectionHold {
    fn drop(&mut self) {
        self.conn.holds.fetch_sub(1, Ordering::Relaxed);
        self.conn.touch();
    }
}

/// Récupère une connexion du pool sans garder le verrou : un transfert long
/// ne bloque ni les listages ni les autres transferts.
pub(crate) async fn get_connection(
    pool: &State<'_, ConnectionPool>,
    connection_id: &str,
) -> Result<Arc<ActiveConnection>, String> {
    // `.inner()` explicite : rust-analyzer bute sur le deref de State à
    // travers son champ tuple privé (rustc, lui, l'accepte).
    let conn = pool
        .inner()
        .0
        .lock()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("Connexion inconnue : {connection_id}. Reconnecte-toi."))?;
    conn.touch();
    Ok(conn)
}

/// Délai d'inactivité (en secondes) avant fermeture d'une connexion,
/// réglable depuis les paramètres de l'app. 0 = jamais.
pub struct IdleConfig(pub AtomicU64);

impl Default for IdleConfig {
    fn default() -> Self {
        Self(AtomicU64::new(15 * 60))
    }
}

/// Applique le délai d'inactivité choisi dans les réglages (0 = jamais).
#[tauri::command]
pub fn set_idle_timeout(config: State<'_, IdleConfig>, minutes: u64) -> Result<(), String> {
    config
        .inner()
        .0
        .store(minutes.saturating_mul(60), Ordering::Relaxed);
    Ok(())
}

/// Ferme les connexions inutilisées depuis plus que le délai configuré et
/// prévient le front (`connection:idle-closed`). Appelé périodiquement
/// par la tâche de fond de `lib.rs`.
pub async fn reap_idle_connections(app: &AppHandle) {
    use tauri::Manager;
    let idle_secs = app.state::<IdleConfig>().inner().0.load(Ordering::Relaxed);
    if idle_secs == 0 {
        return;
    }
    let timeout = std::time::Duration::from_secs(idle_secs);

    let pool = app.state::<ConnectionPool>();
    let mut map = pool.inner().0.lock().await;
    let expired: Vec<String> = map
        .iter()
        .filter(|(_, conn)| conn.idle_for() > timeout && conn.hold_count() == 0)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        map.remove(&id);
        eprintln!("[charon] connexion fermée pour inactivité : {id}");
        let _ = app.emit("connection:idle-closed", &id);
    }
}

pub(crate) fn register_transfer(registry: &State<'_, TransferRegistry>, transfer_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    registry
        .inner()
        .0
        .lock()
        .unwrap()
        .insert(transfer_id.to_string(), Arc::clone(&flag));
    flag
}

pub(crate) fn unregister_transfer(registry: &State<'_, TransferRegistry>, transfer_id: &str) {
    registry.inner().0.lock().unwrap().remove(transfer_id);
}

pub(crate) fn emit_progress(app: &AppHandle, id: &str, transferred: u64, total: u64) {
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

pub(crate) fn shellexpand_tilde(p: &str) -> String {
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
            last_used: StdMutex::new(std::time::Instant::now()),
            holds: AtomicUsize::new(0),
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

/// Métadonnées d'un fichier distant (`exists: false` s'il n'existe pas).
#[tauri::command]
pub async fn sftp_stat(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<StatInfo, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    match conn.sftp.metadata(&path).await {
        Ok(meta) => Ok(StatInfo {
            exists: true,
            is_dir: meta.is_dir(),
            size: meta.size.unwrap_or(0),
            mtime: u64::from(meta.mtime.unwrap_or(0)),
        }),
        Err(_) => Ok(StatInfo {
            exists: false,
            is_dir: false,
            size: 0,
            mtime: 0,
        }),
    }
}

/// Lit le début d'un fichier distant en texte (borné), pour l'aperçu de diff.
#[tauri::command]
pub async fn sftp_read_text(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
    max_bytes: u64,
) -> Result<String, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    let mut file = conn
        .sftp
        .open(&path)
        .await
        .map_err(|e| format!("Ouverture de {path} impossible : {e}"))?;
    let mut buffer = vec![0u8; max_bytes.min(4 * 1024 * 1024) as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        let read = file
            .read(&mut buffer[filled..])
            .await
            .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Lit le début d'un fichier distant encodé en base64 (aperçu d'image).
#[tauri::command]
pub async fn sftp_read_base64(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
    max_bytes: u64,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let conn = get_connection(&pool, &connection_id).await?;
    let mut file = conn
        .sftp
        .open(&path)
        .await
        .map_err(|e| format!("Ouverture de {path} impossible : {e}"))?;
    let mut buffer = vec![0u8; max_bytes.min(8 * 1024 * 1024) as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        let read = file
            .read(&mut buffer[filled..])
            .await
            .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(STANDARD.encode(&buffer))
}

/// Écrit du texte dans un fichier distant (édition intégrée).
#[tauri::command]
pub async fn sftp_write_text(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let conn = get_connection(&pool, &connection_id).await?;
    conn.write_file(&path, content.as_bytes()).await
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

/// Crée un fichier vide sur le serveur. Refuse d'écraser une entrée existante.
#[tauri::command]
pub async fn sftp_create_file(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_connection(&pool, &connection_id).await?;
    if conn.sftp.metadata(&path).await.is_ok() {
        return Err(format!("« {path} » existe déjà."));
    }
    conn.write_file(&path, &[]).await
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
pub(crate) const MAX_RECURSIVE_ENTRIES: usize = 100_000;

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

/// Stats système du serveur : sorties brutes de commandes read-only
/// whitelistées (le parse est fait côté module). Aucune commande arbitraire.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    df: String,
    mem: String,
    uptime: String,
    processes: String,
    os: String,
}

/// Renvoie un instantané système (disque, mémoire, charge, top process).
/// SFTP uniquement — canal exec sur la session SSH, commandes fixes read-only.
#[tauri::command]
pub async fn sftp_system_stats(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
) -> Result<SystemStats, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    const SEP: &str = "@@@CHARON@@@";
    // Commandes read-only, séparées par un marqueur ; `LC_ALL=C` pour un
    // format stable. Aucune entrée utilisateur n'entre dans cette commande.
    let command = format!(
        "export LC_ALL=C; \
         df -P -k 2>/dev/null; echo '{SEP}'; \
         (free -k 2>/dev/null || cat /proc/meminfo 2>/dev/null); echo '{SEP}'; \
         uptime 2>/dev/null; echo '{SEP}'; \
         (ps -eo pid,pcpu,pmem,comm --sort=-pmem 2>/dev/null | head -n 15); echo '{SEP}'; \
         (uname -sr 2>/dev/null)"
    );
    let (_code, output) = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        conn.exec_capture(command, &[]),
    )
    .await
    .map_err(|_| "Délai dépassé pour les stats système.".to_string())??;

    let mut parts = output.split(SEP);
    let mut next = || parts.next().unwrap_or("").trim().to_string();
    Ok(SystemStats {
        df: next(),
        mem: next(),
        uptime: next(),
        processes: next(),
        os: next(),
    })
}

/// Usage disque des sous-dossiers d'un chemin (`du`), top entrées. Peut être
/// lent sur de grosses arborescences — appelé à la demande. SFTP uniquement.
#[tauri::command]
pub async fn sftp_disk_usage(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    // Chemin échappé (quotes simples POSIX) — même garantie que shell.rs.
    let quoted = format!("'{}'", path.replace('\'', r"'\''"));
    let command = format!(
        "export LC_ALL=C; du -sh {quoted}/* {quoted}/.[!.]* 2>/dev/null | sort -rh | head -n 20"
    );
    let (_code, output) = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        conn.exec_capture(command, &[]),
    )
    .await
    .map_err(|_| "Délai dépassé pour l'analyse disque.".to_string())??;
    Ok(output)
}

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Suffixe des fichiers en cours de transfert : renommés à la fin,
/// conservés en cas d'erreur pour permettre la reprise.
pub(crate) const PART_SUFFIX: &str = ".charonpart";

/// Télécharge un fichier distant vers un chemin local, en streaming par
/// chunks : mémoire bornée, progression via `transfer:progress`, annulation
/// via `sftp_transfer_cancel`. Écrit vers `<local>.charonpart` puis renomme ;
/// `resume` reprend à la taille du partiel existant.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<u64, String> {
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result =
        stream_download(&app, &conn, &remote_path, &local, &transfer_id, &cancel, resume).await;
    unregister_transfer(&registry, &transfer_id);

    // Annulation explicite : le partiel part à la corbeille.
    // Autre erreur : on le garde pour une reprise ultérieure.
    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let _ = tokio::fs::remove_file(format!("{local}{PART_SUFFIX}")).await;
        }
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
    resume: bool,
) -> Result<u64, String> {
    let part = format!("{local}{PART_SUFFIX}");
    let offset: u64 = if resume {
        tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

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
    let mut local_file = if offset > 0 {
        remote_file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Reprise de {remote_path} impossible : {e}"))?;
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(|e| format!("Reprise de {part} impossible : {e}"))?
    } else {
        tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?
    };

    let mut transferred: u64 = offset;
    let mut last_emitted: u64 = offset;
    emit_progress(app, transfer_id, transferred, total.max(transferred));

    let mut buffer = vec![0u8; CHUNK_SIZE];
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
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
        transferred += read as u64;
        if transferred - last_emitted >= PROGRESS_STEP {
            last_emitted = transferred;
            conn.touch(); // un transfert en cours n'est pas une connexion inactive
            emit_progress(app, transfer_id, transferred, total);
        }
    }

    local_file
        .flush()
        .await
        .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
    tokio::fs::rename(&part, local)
        .await
        .map_err(|e| format!("Finalisation de {local} impossible : {e}"))?;
    emit_progress(app, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Envoie un fichier local vers un chemin distant, en streaming par chunks
/// (mêmes garanties et même flux `.charonpart` que `sftp_download`).
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<u64, String> {
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result =
        stream_upload(&app, &conn, &local, &remote_path, &transfer_id, &cancel, resume).await;
    unregister_transfer(&registry, &transfer_id);

    // Annulation explicite : le partiel distant est retiré.
    // Autre erreur : on le garde pour une reprise ultérieure.
    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let _ = conn
                .sftp
                .remove_file(format!("{remote_path}{PART_SUFFIX}"))
                .await;
        }
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
    resume: bool,
) -> Result<u64, String> {
    use russh_sftp::protocol::OpenFlags;

    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;
    if meta.is_dir() {
        return Err(format!(
            "« {local} » est un dossier — l'envoi de dossiers n'est pas encore géré."
        ));
    }
    let total = meta.len();

    let part = format!("{remote_path}{PART_SUFFIX}");
    let offset: u64 = if resume {
        conn.sftp
            .metadata(&part)
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0)
            .min(total)
    } else {
        0
    };

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;

    let mut remote_file = if offset > 0 {
        local_file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Reprise de {local} impossible : {e}"))?;
        let mut file = conn
            .sftp
            .open_with_flags(&part, OpenFlags::WRITE | OpenFlags::CREATE)
            .await
            .map_err(|e| format!("Reprise de {part} impossible : {e}"))?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Reprise de {part} impossible : {e}"))?;
        file
    } else {
        conn.sftp
            .create(&part)
            .await
            .map_err(|e| format!("Création de {part} impossible : {e}"))?
    };

    let mut transferred: u64 = offset;
    let mut last_emitted: u64 = offset;
    emit_progress(app, transfer_id, transferred, total);

    let mut buffer = vec![0u8; CHUNK_SIZE];
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
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
        transferred += read as u64;
        if transferred - last_emitted >= PROGRESS_STEP {
            last_emitted = transferred;
            conn.touch(); // un transfert en cours n'est pas une connexion inactive
            emit_progress(app, transfer_id, transferred, total);
        }
    }

    remote_file
        .sync_all()
        .await
        .map_err(|e| format!("Finalisation de {part} impossible : {e}"))?;
    drop(remote_file);
    // Renommage final : certains serveurs refusent d'écraser la cible,
    // on la retire d'abord (sans erreur si absente).
    let _ = conn.sftp.remove_file(remote_path).await;
    conn.sftp
        .rename(&part, remote_path)
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