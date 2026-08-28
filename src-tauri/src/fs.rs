use crate::sftp::{ensure_no_parent_dir, is_safe_entry_name, FileEntry, StatInfo};

// ---------- Commands : système de fichiers local ----------

/// Renvoie le dossier personnel de l'utilisateur local.
#[tauri::command]
pub fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Impossible de trouver le dossier home".into())
}

/// Écrit un export de configuration dans le dossier Téléchargements.
///
/// Le nom de fichier vient du front mais il est assaini ici : pas de
/// séparateur, pas de `..`, extension `.json` imposée. Le contenu, lui, est
/// déjà purgé côté front, aucun secret ne transite (les mots de passe et
/// passphrases vivent dans le trousseau et ne sont jamais exposés à la WebView).
#[tauri::command]
pub fn local_export_config(file_name: String, contents: String) -> Result<String, String> {
    if !is_safe_entry_name(&file_name) || !file_name.ends_with(".json") {
        return Err("Nom de fichier invalide".into());
    }
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Impossible de trouver le dossier Téléchargements".to_string())?;
    let path = dir.join(&file_name);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Liste un dossier du disque local, dossiers d'abord puis ordre alphabétique.
#[tauri::command]
pub fn local_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    ensure_no_parent_dir(&path)?;
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;

    let mut files: Vec<FileEntry> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            is_safe_entry_name(&name).then(|| FileEntry {
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
                mode: {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        Some(meta.permissions().mode() & 0o7777)
                    }
                    #[cfg(not(unix))]
                    {
                        None
                    }
                },
                owner: None,
                group: None,
            })
        })
        .collect();

    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Métadonnées d'un fichier local (`exists: false` s'il n'existe pas).
#[tauri::command]
pub fn local_stat(path: String) -> Result<StatInfo, String> {
    ensure_no_parent_dir(&path)?;
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Ok(StatInfo {
                exists: true,
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime,
            })
        }
        Err(_) => Ok(StatInfo {
            exists: false,
            is_dir: false,
            size: 0,
            mtime: 0,
        }),
    }
}

/// Lit le début d'un fichier local en texte (borné), pour l'aperçu de diff.
#[tauri::command]
pub fn local_read_text(path: String, max_bytes: u64) -> Result<String, String> {
    ensure_no_parent_dir(&path)?;
    use std::io::Read;
    let mut file =
        std::fs::File::open(&path).map_err(|e| format!("Ouverture de {path} impossible : {e}"))?;
    let mut buffer = vec![0u8; max_bytes.min(4 * 1024 * 1024) as usize];
    let mut filled = 0usize;
    while filled < buffer.len() {
        let read = file
            .read(&mut buffer[filled..])
            .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Crée un dossier local.
#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    ensure_no_parent_dir(&path)?;
    std::fs::create_dir(&path).map_err(|e| format!("Création de {path} impossible : {e}"))
}

/// Crée un fichier vide localement. `create_new` échoue si l'entrée existe
/// déjà (atomique, pas d'écrasement).
#[tauri::command]
pub fn local_create_file(path: String) -> Result<(), String> {
    ensure_no_parent_dir(&path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| format!("Création de {path} impossible : {e}"))
}

/// Supprime un fichier local, ou un dossier vide.
#[tauri::command]
pub fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    ensure_no_parent_dir(&path)?;
    if is_dir {
        std::fs::remove_dir(&path)
            .map_err(|e| format!("Suppression de {path} impossible (dossier non vide ?) : {e}"))
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("Suppression de {path} impossible : {e}"))
    }
}

/// Supprime récursivement un dossier local (les liens symboliques sont
/// déliés, pas suivis — comportement de `remove_dir_all`).
#[tauri::command]
pub fn local_remove_all(path: String) -> Result<(), String> {
    ensure_no_parent_dir(&path)?;
    std::fs::remove_dir_all(&path).map_err(|e| format!("Suppression de {path} impossible : {e}"))
}

/// Renomme (ou déplace) une entrée locale.
#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    ensure_no_parent_dir(&from)?;
    ensure_no_parent_dir(&to)?;
    std::fs::rename(&from, &to).map_err(|e| format!("Renommage de {from} impossible : {e}"))
}
