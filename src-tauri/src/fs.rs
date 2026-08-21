use crate::sftp::{ensure_no_parent_dir, is_safe_entry_name, FileEntry};

// ---------- Commands : système de fichiers local ----------

/// Renvoie le dossier personnel de l'utilisateur local.
#[tauri::command]
pub fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Impossible de trouver le dossier home".into())
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
            })
        })
        .collect();

    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Crée un dossier local.
#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    ensure_no_parent_dir(&path)?;
    std::fs::create_dir(&path).map_err(|e| format!("Création de {path} impossible : {e}"))
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
