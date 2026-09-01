use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::sftp::{get_connection, ConnectionHold, ConnectionPool};

// ---------- État ----------
//
// Édition distante : on télécharge le fichier dans un dossier temporaire, on
// l'ouvre avec l'éditeur système par défaut, puis on surveille le fichier ;
// à chaque sauvegarde on ré-envoie le contenu vers le serveur.

/// Un handle d'édition : garder le watcher vivant maintient la surveillance ;
/// le drop du watcher arrête la tâche (le sender de son callback disparaît).
pub(crate) struct EditHandle {
    _watcher: RecommendedWatcher,
    temp_dir: PathBuf,
}

#[derive(Default)]
pub struct EditRegistry(pub(crate) StdMutex<HashMap<String, EditHandle>>);

static EDIT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditEvent {
    id: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSession {
    id: String,
    local_path: String,
}

fn basename(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("fichier")
}

/// Ré-envoie le contenu du fichier temporaire vers le serveur.
async fn push(
    app: &AppHandle,
    connection_id: &str,
    local: &std::path::Path,
    remote: &str,
) -> Result<u64, String> {
    let pool = app.state::<ConnectionPool>();
    let conn = get_connection(&pool, connection_id).await?;
    let bytes = tokio::fs::read(local)
        .await
        .map_err(|e| format!("Relecture du fichier local impossible : {e}"))?;
    conn.write_file(remote, &bytes).await?;
    Ok(bytes.len() as u64)
}

// ---------- Commands ----------

/// Ouvre un fichier distant en édition : téléchargement dans un dossier
/// temporaire, ouverture avec l'éditeur système, puis re-upload automatique
/// à chaque sauvegarde. SFTP uniquement.
#[tauri::command]
pub async fn edit_open(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    edits: State<'_, EditRegistry>,
    connection_id: String,
    remote_path: String,
    // Application avec laquelle ouvrir (nom d'app macOS) ; None = défaut système.
    opener: Option<String>,
) -> Result<EditSession, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    // Édition externe en cours = connexion maintenue (le re-upload d'une
    // sauvegarde tardive doit toujours trouver la session ouverte).
    let hold = ConnectionHold::new(conn.clone());
    let bytes = conn.read_file(&remote_path).await?;

    let id = format!("edit-{}", EDIT_COUNTER.fetch_add(1, Ordering::Relaxed));
    let temp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Dossier cache introuvable : {e}"))?
        .join("edits")
        .join(&id);
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Création du dossier temporaire impossible : {e}"))?;
    let temp_file = temp_dir.join(basename(&remote_path));
    tokio::fs::write(&temp_file, &bytes)
        .await
        .map_err(|e| format!("Écriture temporaire impossible : {e}"))?;

    // Canal watcher → tâche de re-upload (debounce).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watched_file = temp_file.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.kind.is_modify() || event.kind.is_create() {
                if event.paths.iter().any(|p| p == &watched_file) {
                    let _ = tx.send(());
                }
            }
        }
    })
    .map_err(|e| format!("Surveillance impossible : {e}"))?;
    // Surveiller le dossier (les éditeurs remplacent souvent le fichier).
    watcher
        .watch(&temp_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Surveillance impossible : {e}"))?;

    let task_app = app.clone();
    let task_id = id.clone();
    let task_conn_id = connection_id.clone();
    let task_remote = remote_path.clone();
    let task_local = temp_file.clone();
    tauri::async_runtime::spawn(async move {
        // Vit tant que la surveillance existe : relâché par edit_stop
        // (drop du watcher → fin de la boucle).
        let _hold = hold;
        while rx.recv().await.is_some() {
            // Debounce : laisser l'éditeur finir d'écrire, puis vider la file.
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            while rx.try_recv().is_ok() {}
            match push(&task_app, &task_conn_id, &task_local, &task_remote).await {
                Ok(bytes) => {
                    let _ = task_app.emit(
                        "edit:synced",
                        EditEvent {
                            id: task_id.clone(),
                            message: format!("{bytes}"),
                        },
                    );
                }
                Err(e) => {
                    let _ = task_app.emit(
                        "edit:error",
                        EditEvent {
                            id: task_id.clone(),
                            message: e,
                        },
                    );
                }
            }
        }
    });

    // Ouvrir avec l'app choisie (ou l'éditeur système par défaut).
    let with = opener
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    app.opener()
        .open_path(temp_file.to_string_lossy().to_string(), with)
        .map_err(|e| format!("Ouverture dans l'éditeur impossible : {e}"))?;

    edits.inner().0.lock().unwrap().insert(
        id.clone(),
        EditHandle {
            _watcher: watcher,
            temp_dir,
        },
    );

    Ok(EditSession {
        id,
        local_path: temp_file.to_string_lossy().into_owned(),
    })
}

/// Efface les copies de travail des éditions distantes.
///
/// Chaque édition externe télécharge le fichier dans `app_cache_dir/edits/`,
/// et `edit_stop` fait le ménage quand l'utilisateur referme sa session
/// d'édition. Mais quitter l'application n'appelle jamais `edit_stop` : les
/// dossiers restaient, avec le contenu de fichiers serveur en clair sur le
/// disque, sans que rien ne vienne jamais les reprendre.
///
/// Appelée aux DEUX bouts, et c'est le point : à la fermeture pour le cas
/// normal, et au démarrage pour tout ce qu'une fermeture brutale (plantage,
/// forçage à quitter, coupure de courant) a pu laisser derrière, cas où
/// aucun gestionnaire de sortie ne s'est exécuté. On efface le dossier
/// entier : au démarrage il n'y a par construction aucune édition en cours,
/// et à la fermeture elles se terminent toutes.
pub fn purge_temp_dir(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(cache.join("edits"));
    }
}

/// Arrête une session d'édition (fin de la surveillance + nettoyage temporaire).
#[tauri::command]
pub async fn edit_stop(edits: State<'_, EditRegistry>, edit_id: String) -> Result<(), String> {
    let handle = edits.inner().0.lock().unwrap().remove(&edit_id);
    if let Some(handle) = handle {
        // Le drop du watcher arrête la tâche ; on retire le dossier temporaire.
        let _ = tokio::fs::remove_dir_all(&handle.temp_dir).await;
    }
    Ok(())
}
