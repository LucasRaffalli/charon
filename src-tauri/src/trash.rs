//! Corbeille distante (idée 02 des sept idées).
//!
//! Supprimer était définitif, alors que les garde-fous construits autour
//! (retaper le nom d'hôte, lecture seule) protègent l'instant d'avant. Le
//! filet qui manquait est celui d'après : **déplacer au lieu de supprimer**.
//!
//! Techniquement c'est un `rename`, donc quasi gratuit — mais un `rename` ne
//! franchit pas les systèmes de fichiers. Sur un serveur, `/var` et `/home`
//! sont souvent deux partitions : une corbeille unique dans le home échouerait
//! sur la moitié de l'arborescence. D'où **une corbeille par point de montage,
//! posée à côté de ce qu'on jette** : `<parent>/.charon-trash/`. Le
//! déplacement reste instantané où qu'on soit, et rien n'est jamais recopié.
//!
//! Le nom stocké porte l'instant de la mise à la corbeille
//! (`<epoch>-<nom d'origine>`) : c'est lui qui permet la purge par âge sans
//! tenir de registre à côté, qui pourrait se désynchroniser du contenu réel.

use serde::Serialize;
use tauri::State;

use crate::sftp::{get_connection, is_safe_entry_name, ConnectionPool};

/// Nom du dossier de corbeille. Caché, et préfixé pour qu'on sache qui l'a mis.
pub const TRASH_DIR: &str = ".charon-trash";

/// Ce qu'une mise à la corbeille rend, pour pouvoir l'annuler.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trashed {
    /// Où l'élément se trouve maintenant.
    pub path: String,
    /// D'où il vient : c'est ce chemin que l'annulation restaure.
    pub origin: String,
}

/// Une entrée de corbeille, telle que la purge et l'inventaire la voient.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub path: String,
    pub name: String,
    /// Epoch en secondes de la mise à la corbeille, 0 si le nom ne le dit pas.
    pub at: u64,
    pub is_dir: bool,
    pub size: u64,
}

fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(cut) => &path[..cut],
    }
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn ensure_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path == "/" || path.split('/').any(|c| c == "..") {
        return Err(format!("Chemin refusé : {path}"));
    }
    Ok(())
}

/// Met une entrée à la corbeille du point de montage où elle se trouve.
#[tauri::command]
pub async fn sftp_trash(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<Trashed, String> {
    ensure_path(&path)?;
    let conn = get_connection(&pool, &connection_id).await?;

    let parent = parent_of(&path).to_string();
    let name = name_of(&path).to_string();
    // Jeter la corbeille elle-même n'aurait aucun sens.
    if name == TRASH_DIR {
        return Err("La corbeille ne peut pas être mise à la corbeille.".into());
    }

    let trash = join(&parent, TRASH_DIR);
    // create_dir échoue si le dossier existe : c'est le cas courant, pas une
    // erreur. On ne regarde que le résultat du rename qui suit.
    let _ = conn.sftp.create_dir(&trash).await;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = join(&trash, &format!("{stamp}-{name}"));

    conn.sftp
        .rename(&path, &target)
        .await
        .map_err(|e| format!("Mise à la corbeille de {name} impossible : {e}"))?;

    Ok(Trashed {
        path: target,
        origin: path,
    })
}

/// Le contenu d'une corbeille donnée, pour l'inventaire et la purge.
#[tauri::command]
pub async fn sftp_trash_list(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    dir: String,
) -> Result<Vec<TrashEntry>, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    let trash = join(&dir, TRASH_DIR);
    let Ok(entries) = conn.sftp.read_dir(&trash).await else {
        // Pas de corbeille ici : ce n'est pas une erreur, il n'y a rien.
        return Ok(Vec::new());
    };

    Ok(entries
        .filter(|entry| is_safe_entry_name(&entry.file_name()))
        .map(|entry| {
            let name = entry.file_name();
            let meta = entry.metadata();
            // Le préfixe porte la date ; un fichier déposé là à la main n'en a
            // pas, et vaut 0 — donc il ne sera jamais purgé par âge.
            let (at, original) = match name.split_once('-') {
                Some((stamp, rest)) => (stamp.parse().unwrap_or(0), rest.to_string()),
                None => (0, name.clone()),
            };
            TrashEntry {
                path: join(&trash, &name),
                name: original,
                at,
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
            }
        })
        .collect())
}

/// Ce que la corbeille d'un dossier occupe, en octets (récursif).
#[tauri::command]
pub async fn sftp_trash_size(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    dir: String,
) -> Result<u64, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    let trash = join(&dir, TRASH_DIR);
    let command = format!(
        "du -sk -- {} 2>/dev/null | cut -f1",
        crate::shell::shell_quote(&trash)
    );
    let (_, output) = conn.exec_capture(command, &[]).await?;
    // `du -sk` compte en kibioctets ; l'absence de corbeille rend une sortie
    // vide, donc zéro.
    Ok(output.trim().parse::<u64>().unwrap_or(0) * 1024)
}
