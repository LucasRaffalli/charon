use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use futures_util::io::{AsyncReadExt as FtpRead, AsyncWriteExt as FtpWrite};
use suppaftp::async_native_tls::TlsConnector;
use suppaftp::types::FileType;
use suppaftp::{AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::sftp::{
    emit_progress, ensure_no_parent_dir, is_safe_entry_name, register_transfer,
    shellexpand_tilde, unregister_transfer, FileEntry, IdleConfig, TransferRegistry,
    CANCELLED_TAG, CHUNK_SIZE, MAX_RECURSIVE_ENTRIES, PART_SUFFIX, PROGRESS_STEP,
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
}

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
    let mut stream = AsyncNativeTlsFtpStream::connect(format!("{host}:{port}"))
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;

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

    stream
        .login(user.as_str(), password.as_deref().unwrap_or(""))
        .await
        .map_err(|e| format!("Authentification refusée : {e}"))?;
    stream
        .transfer_type(FileType::Binary)
        .await
        .map_err(|e| format!("Passage en mode binaire impossible : {e}"))?;

    let scheme = if secure { "ftps" } else { "ftp" };
    let connection_id = format!("{scheme}://{user}@{host}:{port}");
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
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    let lines = stream
        .list(Some(&path))
        .await
        .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
    drop(stream);

    let mut files: Vec<FileEntry> = lines
        .iter()
        .filter_map(|line| suppaftp::list::File::try_from(line.as_str()).ok())
        .filter(|file| is_safe_entry_name(file.name()))
        .map(|file| FileEntry {
            name: file.name().to_string(),
            is_dir: file.is_directory(),
            size: file.size() as u64,
        })
        .collect();

    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Ferme et retire une connexion du pool (QUIT gracieux si possible).
#[tauri::command]
pub async fn ftp_disconnect(
    pool: State<'_, FtpPool>,
    connection_id: String,
) -> Result<(), String> {
    if let Some(conn) = pool.inner().0.lock().await.remove(&connection_id) {
        if let Ok(mut stream) = conn.stream.try_lock() {
            let _ = stream.quit().await;
        }
    }
    Ok(())
}

/// Crée un dossier distant.
#[tauri::command]
pub async fn ftp_mkdir(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    stream
        .mkdir(&path)
        .await
        .map_err(|e| format!("Création de {path} impossible : {e}"))
}

/// Supprime un fichier, ou un dossier vide.
#[tauri::command]
pub async fn ftp_remove(
    pool: State<'_, FtpPool>,
    connection_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
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
            .map_err(|e| format!("Suppression de {path} impossible : {e}"))
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
    let conn = get_connection(&pool, &connection_id).await?;
    let mut stream = conn.stream.lock().await;
    stream
        .rename(&from, &to)
        .await
        .map_err(|e| format!("Renommage de {from} impossible : {e}"))
}

/// Télécharge un fichier distant en streaming (mêmes garanties que SFTP :
/// mémoire bornée, progression, annulation, flux `.charonpart` + reprise
/// via la commande REST).
#[tauri::command]
pub async fn ftp_download(
    app: AppHandle,
    pool: State<'_, FtpPool>,
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

    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let _ = tokio::fs::remove_file(format!("{local}{PART_SUFFIX}")).await;
        }
    }
    result
}

async fn stream_download(
    app: &AppHandle,
    conn: &FtpConnection,
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
    let mut last_emitted: u64 = offset;
    emit_progress(app, transfer_id, transferred, total.max(transferred));

    let mut buffer = vec![0u8; CHUNK_SIZE];
    loop {
        if cancel.load(Ordering::Relaxed) {
            // Consomme le canal de données pour laisser le canal de
            // contrôle dans un état propre avant d'abandonner.
            let _ = stream.finalize_retr_stream(data).await;
            return Err(CANCELLED_TAG.into());
        }
        let read = FtpRead::read(&mut data, &mut buffer)
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
            conn.touch();
            emit_progress(app, transfer_id, transferred, total);
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
    emit_progress(app, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}

/// Envoie un fichier local en streaming (mêmes garanties que SFTP,
/// flux `.charonpart` + reprise via REST).
#[tauri::command]
pub async fn ftp_upload(
    app: AppHandle,
    pool: State<'_, FtpPool>,
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

    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let mut stream = conn.stream.lock().await;
            let _ = stream.rm(&format!("{remote_path}{PART_SUFFIX}")).await;
        }
    }
    result
}

async fn stream_upload(
    app: &AppHandle,
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
        stream.size(&part).await.map(|s| s as u64).unwrap_or(0).min(total)
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
    let mut last_emitted: u64 = offset;
    emit_progress(app, transfer_id, transferred, total);

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
        FtpWrite::write_all(&mut data, &buffer[..read])
            .await
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
        transferred += read as u64;
        if transferred - last_emitted >= PROGRESS_STEP {
            last_emitted = transferred;
            conn.touch();
            emit_progress(app, transfer_id, transferred, total);
        }
    }

    FtpWrite::flush(&mut data)
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
    emit_progress(app, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
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
    use crate::search::{emit_done, emit_hits, SearchHit, EXCLUDED_DIRS, MAX_HITS, MAX_WALK_DEPTH, TIMEOUT};
    use std::sync::atomic::Ordering;

    let needle_folded = if case_sensitive {
        needle.clone()
    } else {
        needle.to_lowercase()
    };
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let mut stream = conn.stream.lock().await;
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
        let Ok(lines) = stream.list(Some(&dir)).await else {
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
