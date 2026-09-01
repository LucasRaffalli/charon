use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use suppaftp::async_native_tls::TlsConnector;
use suppaftp::tokio::{AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use suppaftp::types::FileType;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::sftp::{
    emit_progress, ensure_no_parent_dir, is_safe_entry_name, register_transfer, shellexpand_tilde,
    unregister_transfer, FileEntry, IdleConfig, TransferRegistry, CANCELLED_TAG, CHUNK_SIZE,
    MAX_RECURSIVE_ENTRIES, PART_SUFFIX, PROGRESS_EVERY,
};

// ---------- État ----------
//
// Le protocole FTP est séquentiel sur un canal de contrôle unique : chaque
// opération verrouille le stream (un transfert long bloque donc les autres
// opérations de CETTE connexion — nature du protocole, contrairement à SFTP).

pub struct FtpConnection {
    stream: Mutex<AsyncNativeTlsFtpStream>,
    /// Dernier usage : sert à la fermeture d'inactivité.
    last_used: StdMutex<std::time::Instant>,
}

impl FtpConnection {
    fn touch(&self) {
        *self.last_used.lock().unwrap() = std::time::Instant::now();
    }

    fn idle_for(&self) -> std::time::Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    /// Envoie QUIT et referme le canal de contrôle.
    ///
    /// L'ancienne version prenait le verrou par `try_lock` et abandonnait le
    /// QUIT si le stream était occupé, c'est-à-dire exactement quand un
    /// transfert tournait, c'est-à-dire le cas où le serveur a le plus de
    /// choses à ranger. Or un serveur FTP qui n'a pas vu son client partir
    /// garde la session ouverte jusqu'à SON propre délai d'inactivité, et
    /// cette session occupe une place dans les quotas par IP : quelques
    /// fermetures brutales suffisent à se voir refuser la connexion suivante.
    ///
    /// On attend donc le verrou, mais BORNÉ : si un transfert le tient encore
    /// au bout du délai, on renonce au QUIT et la socket tombera avec le
    /// processus. Mieux vaut une session mal fermée qu'une application qui
    /// refuse de quitter.
    async fn close(&self) {
        let locked = tokio::time::timeout(CLOSE_WAIT, self.stream.lock()).await;
        if let Ok(mut stream) = locked {
            let _ = tokio::time::timeout(CLOSE_WAIT, stream.quit()).await;
        }
    }
}

/// Temps laissé au QUIT : attendre le verrou du stream, puis la réponse du
/// serveur. Payé à la fermeture de l'application, donc court.
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_millis(400);

/// Pool des connexions FTP ouvertes, par identifiant `ftp(s)://user@host:port`.
#[derive(Default)]
pub struct FtpPool(pub Mutex<HashMap<String, Arc<FtpConnection>>>);

pub(crate) async fn get_ftp_connection(
    pool: &State<'_, FtpPool>,
    connection_id: &str,
) -> Result<Arc<FtpConnection>, String> {
    get_connection(pool, connection_id).await
}

async fn get_connection(
    pool: &State<'_, FtpPool>,
    connection_id: &str,
) -> Result<Arc<FtpConnection>, String> {
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

/// Pendant de `sftp::reap_idle_connections` pour le pool FTP.
pub async fn reap_idle_connections(app: &AppHandle) {
    use tauri::Manager;
    let idle_secs = app.state::<IdleConfig>().inner().0.load(Ordering::Relaxed);
    if idle_secs == 0 {
        return;
    }
    let timeout = std::time::Duration::from_secs(idle_secs);

    let pool = app.state::<FtpPool>();
    let mut map = pool.inner().0.lock().await;
    let expired: Vec<String> = map
        .iter()
        .filter(|(_, conn)| conn.idle_for() > timeout)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        map.remove(&id);
        eprintln!("[charon] connexion FTP fermée pour inactivité : {id}");
        let _ = app.emit("connection:idle-closed", &id);
    }
}

/// Refuse tout argument contenant un retour chariot ou un saut de ligne.
///
/// Le protocole FTP sépare ses commandes par CRLF : un chemin, un nom
/// d'utilisateur ou un mot de passe qui en contient permet d'INJECTER une
/// commande dans le canal de contrôle. C'était RUSTSEC-2026-0271, corrigé en
/// amont depuis (nous sommes montés de suppaftp 6 à 11).
///
/// La garde RESTE malgré la montée de version, et ce n'est pas de la
/// superstition : elle ne dépend d'aucune promesse d'une dépendance, elle
/// refuse une entrée qui n'a de toute façon aucune raison d'exister, et elle
/// survivra au jour où la crate changera encore de mainteneur ou d'API.
///
/// La garde vit ICI, au bord du protocole, plutôt que chez chaque appelant :
/// c'est le seul endroit par lequel tout passe forcément. Elle reste utile
/// après la montée de version : une entrée pareille n'a de toute façon aucune
/// raison d'exister.
fn ensure_no_crlf(label: &str, value: &str) -> Result<(), String> {
    if value.contains('\r') || value.contains('\n') {
        return Err(format!(
            "{label} refusé : un retour à la ligne dans un argument FTP permettrait d'injecter une commande."
        ));
    }
    Ok(())
}

// ---------- Commands ----------

/// Ouvre une connexion FTP (ou FTPS explicite si `secure`) et la stocke.
/// Le mot de passe vient du champ du formulaire ou, via `profile_id`,
/// du trousseau macOS — jamais de la WebView pour un profil enregistré.
#[tauri::command]
pub async fn ftp_connect(
    pool: State<'_, FtpPool>,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    secure: bool,
    profile_id: Option<String>,
) -> Result<String, String> {
    ensure_no_crlf("Hôte", &host)?;
    ensure_no_crlf("Utilisateur", &user)?;

    let mut stream = AsyncNativeTlsFtpStream::connect(format!("{host}:{port}"))
        .await
        .map_err(|e| crate::errors::user_err("connect", format!("{e}")))?;

    if secure {
        stream = stream
            .into_secure(AsyncNativeTlsConnector::from(TlsConnector::new()), &host)
            .await
            .map_err(|e| format!("Négociation TLS impossible : {e}"))?;
    }

    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => match &profile_id {
            Some(id) => crate::profiles::keychain_secret(id)?,
            None => None,
        },
    };

    if let Some(secret) = password.as_deref() {
        ensure_no_crlf("Mot de passe", secret)?;
    }

    stream
        .login(user.as_str(), password.as_deref().unwrap_or(""))
        .await
        .map_err(|e| crate::errors::user_err("auth", format!("{e}")))?;
    stream
        .transfer_type(FileType::Binary)
        .await
        .map_err(|e| format!("Passage en mode binaire impossible : {e}"))?;

    let scheme = if secure { "ftps" } else { "ftp" };
    // Même règle que SFTP : unique par session, stable avant le `#`.
    let connection_id = format!(
        "{scheme}://{user}@{host}:{port}#{}",
        crate::sftp::SESSION_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    pool.inner().0.lock().await.insert(
        connection_id.clone(),
        Arc::new(FtpConnection {
            stream: Mutex::new(stream),
            last_used: StdMutex::new(std::time::Instant::now()),
        }),
    );

    Ok(connection_id)
}

/// Liste un dossier distant (LIST + parseur suppaftp, formats UNIX/DOS).
#[tauri::command]
pub async fn ftp_list_dir(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    ensure_no_crlf("Chemin", &path)?;
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    let lines = stream
        .list(Some(&path))
        .await
        .map_err(|e| crate::errors::user_err("read_dir", format!("{path} : {e}")))?;
    drop(stream);

    let mut files: Vec<FileEntry> = lines
        .iter()
        .filter_map(|line| suppaftp::list::File::try_from(line.as_str()).ok())
        .filter(|file| is_safe_entry_name(file.name()))
        .map(|file| FileEntry {
            name: file.name().to_string(),
            is_dir: file.is_directory(),
            size: file.size() as u64,
            // Le parseur LIST reconstitue les droits depuis `drwxr-xr-x`.
            mode: Some(ftp_mode(&file)),
            owner: None,
            group: None,
        })
        .collect();

    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Ferme et retire une connexion du pool (QUIT gracieux si possible).
#[tauri::command]
pub async fn ftp_disconnect(pool: State<'_, FtpPool>, connection_id: String) -> Result<(), String> {
    let conn = pool.inner().0.lock().await.remove(&connection_id);
    // Retirée du pool d'abord : le QUIT attend le réseau, et le verrou du
    // pool ne doit pas être tenu pendant ce temps.
    if let Some(conn) = conn {
        conn.close().await;
    }
    Ok(())
}

/// Ferme toutes les connexions FTP, à la sortie de l'application. En
/// parallèle, comme le SSH : les délais ne doivent pas s'additionner.
pub async fn shutdown(pool: &FtpPool) {
    let connections: Vec<_> = pool.0.lock().await.drain().map(|(_, conn)| conn).collect();
    futures_util::future::join_all(connections.iter().map(|conn| conn.close())).await;
}

/// Crée un dossier distant.
#[tauri::command]
pub async fn ftp_mkdir(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    ensure_no_crlf("Chemin", &path)?;
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    stream
        .mkdir(&path)
        .await
        .map_err(|e| crate::errors::user_err("mkdir", format!("{path} : {e}")))
}

/// Supprime un fichier, ou un dossier vide.
#[tauri::command]
pub async fn ftp_remove(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    ensure_no_crlf("Chemin", &path)?;
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    if is_dir {
        stream
            .rmdir(&path)
            .await
            .map_err(|e| format!("Suppression de {path} impossible (dossier non vide ?) : {e}"))
    } else {
        stream
            .rm(&path)
            .await
            .map_err(|e| crate::errors::user_err("remove", format!("{path} : {e}")))
    }
}

/// Supprime récursivement un dossier distant (mêmes garanties que la
/// version SFTP : walk complet, symlinks déliés jamais suivis, garde-fou).
#[tauri::command]
pub async fn ftp_remove_all(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
) -> Result<u64, String> {
    ensure_no_crlf("Chemin", &path)?;
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;

    let mut to_visit = vec![path];
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();

    while let Some(dir) = to_visit.pop() {
        let lines = stream
            .list(Some(&dir))
            .await
            .map_err(|e| format!("Lecture de {dir} impossible : {e}"))?;
        for line in &lines {
            let Ok(entry) = suppaftp::list::File::try_from(line.as_str()) else {
                continue;
            };
            let name = entry.name();
            if !is_safe_entry_name(name) {
                continue;
            }
            let child = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            if entry.is_directory() {
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
        stream
            .rm(file)
            .await
            .map_err(|e| format!("Suppression de {file} impossible : {e}"))?;
    }
    for dir in dirs.iter().rev() {
        stream
            .rmdir(dir)
            .await
            .map_err(|e| format!("Suppression de {dir} impossible : {e}"))?;
    }

    Ok(total)
}

/// Renomme (ou déplace) une entrée distante.
#[tauri::command]
pub async fn ftp_rename(
    pool: State<'_, FtpPool>,
    connection_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    ensure_no_crlf("Chemin", &from)?;
    ensure_no_crlf("Chemin", &to)?;
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    stream
        .rename(&from, &to)
        .await
        .map_err(|e| crate::errors::user_err("rename", format!("{from} : {e}")))
}

/// Télécharge un fichier distant en streaming (mêmes garanties que SFTP :
/// mémoire bornée, progression, annulation, flux `.charonpart` + reprise
/// via la commande REST).
#[tauri::command]
pub async fn ftp_download(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pool: State<'_, FtpPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<u64, String> {
    ensure_no_crlf("Chemin distant", &remote_path)?;
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result = stream_download(
        &app,
        window.label(),
        &conn,
        &remote_path,
        &local,
        &transfer_id,
        &cancel,
        resume,
    )
    .await;
    unregister_transfer(&registry, &transfer_id);

    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let _ = tokio::fs::remove_file(format!("{local}{PART_SUFFIX}")).await;
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn stream_download(
    app: &AppHandle,
    label: &str,
    conn: &FtpConnection,
    remote_path: &str,
    local: &str,
    transfer_id: &str,
    cancel: &AtomicBool,
    resume: bool,
) -> Result<u64, String> {
    let part = format!("{local}{PART_SUFFIX}");
    let offset: u64 = if resume {
        tokio::fs::metadata(&part)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    let mut stream = conn.stream.lock().await;
    let total = stream
        .size(remote_path)
        .await
        .map(|s| s as u64)
        .unwrap_or(0);

    if offset > 0 {
        stream
            .resume_transfer(offset as usize)
            .await
            .map_err(|e| format!("Reprise de {remote_path} impossible (REST) : {e}"))?;
    }
    let mut data = stream
        .retr_as_stream(remote_path)
        .await
        .map_err(|e| format!("Ouverture de {remote_path} impossible : {e}"))?;
    let mut local_file = if offset > 0 {
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
    let mut last_emit = std::time::Instant::now();
    emit_progress(app, label, transfer_id, transferred, total.max(transferred));

    let mut buffer = vec![0u8; CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Relaxed) {
            // Consomme le canal de données pour laisser le canal de
            // contrôle dans un état propre avant d'abandonner.
            let _ = stream.finalize_retr_stream(data).await;
            return Err(CANCELLED_TAG.into());
        }
        let read = AsyncReadExt::read(&mut data, &mut buffer)
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
        if last_emit.elapsed() >= PROGRESS_EVERY {
            last_emit = std::time::Instant::now();
            conn.touch();
            emit_progress(app, label, transfer_id, transferred, total);
        }
    }

    local_file
        .flush()
        .await
        .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
    stream
        .finalize_retr_stream(data)
        .await
        .map_err(|e| format!("Finalisation de {remote_path} impossible : {e}"))?;
    tokio::fs::rename(&part, local)
        .await
        .map_err(|e| format!("Finalisation de {local} impossible : {e}"))?;
    emit_progress(app, label, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Envoie un fichier local en streaming (mêmes garanties que SFTP,
/// flux `.charonpart` + reprise via REST).
#[tauri::command]
pub async fn ftp_upload(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pool: State<'_, FtpPool>,
    registry: State<'_, TransferRegistry>,
    connection_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    resume: bool,
) -> Result<u64, String> {
    ensure_no_crlf("Chemin distant", &remote_path)?;
    let local = shellexpand_tilde(&local_path);
    ensure_no_parent_dir(&local)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let cancel = register_transfer(&registry, &transfer_id);
    let result = stream_upload(
        &app,
        window.label(),
        &conn,
        &local,
        &remote_path,
        &transfer_id,
        &cancel,
        resume,
    )
    .await;
    unregister_transfer(&registry, &transfer_id);

    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let mut stream = conn.stream.lock().await;
            let _ = stream.rm(&format!("{remote_path}{PART_SUFFIX}")).await;
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn stream_upload(
    app: &AppHandle,
    label: &str,
    conn: &FtpConnection,
    local: &str,
    remote_path: &str,
    transfer_id: &str,
    cancel: &AtomicBool,
    resume: bool,
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

    let part = format!("{remote_path}{PART_SUFFIX}");
    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;

    let mut stream = conn.stream.lock().await;
    let offset: u64 = if resume {
        stream
            .size(&part)
            .await
            .map(|s| s as u64)
            .unwrap_or(0)
            .min(total)
    } else {
        0
    };
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        local_file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("Reprise de {local} impossible : {e}"))?;
        stream
            .resume_transfer(offset as usize)
            .await
            .map_err(|e| format!("Reprise de {part} impossible (REST) : {e}"))?;
    }
    let mut data = stream
        .put_with_stream(&part)
        .await
        .map_err(|e| format!("Création de {part} impossible : {e}"))?;

    let mut transferred: u64 = offset;
    let mut last_emit = std::time::Instant::now();
    emit_progress(app, label, transfer_id, transferred, total);

    let mut buffer = vec![0u8; CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = stream.finalize_put_stream(data).await;
            return Err(CANCELLED_TAG.into());
        }
        let read = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {local} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        AsyncWriteExt::write_all(&mut data, &buffer[..read])
            .await
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
        transferred += read as u64;
        if last_emit.elapsed() >= PROGRESS_EVERY {
            last_emit = std::time::Instant::now();
            conn.touch();
            emit_progress(app, label, transfer_id, transferred, total);
        }
    }

    AsyncWriteExt::flush(&mut data)
        .await
        .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
    stream
        .finalize_put_stream(data)
        .await
        .map_err(|e| format!("Finalisation de {part} impossible : {e}"))?;
    // Renommage final : on retire une éventuelle cible existante d'abord.
    let _ = stream.rm(remote_path).await;
    stream
        .rename(part.as_str(), remote_path)
        .await
        .map_err(|e| format!("Finalisation de {remote_path} impossible : {e}"))?;
    emit_progress(app, label, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Sentinelle des connexions FTP mortes : un NOOP sondé quand le stream est
/// libre. Occupé = une opération est en cours = la connexion vit, inutile
/// d'attendre le verrou.
pub async fn watch_lost_connections(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let pool = app.state::<FtpPool>();
    let conns: Vec<(String, Arc<FtpConnection>)> = pool
        .inner()
        .0
        .lock()
        .await
        .iter()
        .map(|(id, conn)| (id.clone(), conn.clone()))
        .collect();

    for (id, conn) in conns {
        let Ok(mut stream) = conn.stream.try_lock() else {
            continue;
        };
        let alive = tokio::time::timeout(std::time::Duration::from_secs(10), stream.noop())
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
        drop(stream);
        if !alive {
            pool.inner().0.lock().await.remove(&id);
            eprintln!("[charon] connexion FTP perdue : {id}");
            let _ = app.emit("connection:lost", &id);
        }
    }
}

/// Les permissions telles que le parseur LIST les a lues, en bits POSIX.
fn ftp_mode(file: &suppaftp::list::File) -> u32 {
    let bit = |on: bool, weight: u32| if on { weight } else { 0 };
    bit(file.can_read(suppaftp::list::PosixPexQuery::Owner), 0o400)
        | bit(file.can_write(suppaftp::list::PosixPexQuery::Owner), 0o200)
        | bit(
            file.can_execute(suppaftp::list::PosixPexQuery::Owner),
            0o100,
        )
        | bit(file.can_read(suppaftp::list::PosixPexQuery::Group), 0o040)
        | bit(file.can_write(suppaftp::list::PosixPexQuery::Group), 0o020)
        | bit(
            file.can_execute(suppaftp::list::PosixPexQuery::Group),
            0o010,
        )
        | bit(file.can_read(suppaftp::list::PosixPexQuery::Others), 0o004)
        | bit(file.can_write(suppaftp::list::PosixPexQuery::Others), 0o002)
        | bit(
            file.can_execute(suppaftp::list::PosixPexQuery::Others),
            0o001,
        )
}

// ---------- Recherche récursive (voir search.rs) ----------

/// Recherche par nom en FTP : le protocole n'a pas de canal exec, le walk est
/// la seule voie, et il verrouille le stream comme toute op FTP (nature du
/// protocole : une recherche bloque les autres commandes de cette connexion).
pub(crate) async fn search_walk(
    app: tauri::AppHandle,
    conn: Arc<FtpConnection>,
    id: String,
    root: String,
    needle: String,
    case_sensitive: bool,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) {
    use crate::search::{
        emit_done, emit_hits, SearchHit, EXCLUDED_DIRS, MAX_HITS, MAX_WALK_DEPTH, TIMEOUT,
    };
    use std::sync::atomic::Ordering;

    let needle_folded = if case_sensitive {
        needle.clone()
    } else {
        needle.to_lowercase()
    };
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let mut to_visit: Vec<(String, usize)> = vec![(root, 0)];
    let mut total = 0usize;

    while let Some((dir, depth)) = to_visit.pop() {
        if cancel.load(Ordering::Relaxed) {
            emit_done(&app, &id, total, "cancelled");
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            emit_done(&app, &id, total, "timeout");
            return;
        }
        // Le verrou du stream est repris PAR dossier : tenu pour tout le
        // walk, une recherche de 60 s bloquait toute autre opération FTP de
        // cette connexion (listage, transfert) pendant une minute.
        let listing = {
            let mut stream = conn.stream.lock().await;
            stream.list(Some(&dir)).await
        };
        let Ok(lines) = listing else {
            continue; // dossier illisible : on passe
        };
        let mut hits = Vec::new();
        for line in &lines {
            let Ok(entry) = suppaftp::list::File::try_from(line.as_str()) else {
                continue;
            };
            let name = entry.name();
            if !is_safe_entry_name(name) || EXCLUDED_DIRS.contains(&name) {
                continue;
            }
            let child = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            let haystack = if case_sensitive {
                name.to_string()
            } else {
                name.to_lowercase()
            };
            if haystack.contains(&needle_folded) {
                hits.push(SearchHit {
                    path: child.clone(),
                    line: None,
                    text: None,
                    is_dir: entry.is_directory(),
                });
                total += 1;
                if total >= MAX_HITS {
                    emit_hits(&app, &id, &hits);
                    emit_done(&app, &id, total, "cap");
                    return;
                }
            }
            if entry.is_directory() && depth < MAX_WALK_DEPTH {
                to_visit.push((child, depth + 1));
            }
        }
        emit_hits(&app, &id, &hits);
    }

    emit_done(&app, &id, total, "complete");
}
