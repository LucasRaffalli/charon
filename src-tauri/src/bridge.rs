//! Le pont entre deux serveurs, et le presse-papiers commun aux fenêtres.
//!
//! SFTP n'a pas de copie de tiers à tiers : le fichier transite par Charon,
//! en flux et par blocs, **sans jamais être écrit sur le disque local**. Tout
//! l'attirail des transferts existants s'applique : `.charonpart` côté
//! destination, progression, annulation par le même registre, un
//! `ConnectionHold` sur chaque session.
//!
//! Le presse-papiers de fichiers vit ici, et non dans chaque fenêtre : copier
//! dans la fenêtre A et coller dans la fenêtre B exige une mémoire commune, et
//! le backend est le seul endroit que toutes les fenêtres partagent.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sftp::{
    emit_progress, get_connection, register_transfer, unregister_transfer, ConnectionHold,
    ConnectionPool, TransferRegistry, CANCELLED_TAG, CHUNK_SIZE, PART_SUFFIX, PROGRESS_EVERY,
};

// ---------- Presse-papiers ----------

/// Une entrée mise au presse-papiers : son nom et sa nature suffisent, le
/// chemin complet se reconstruit depuis `from_dir`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Ce que le presse-papiers retient. `connection_id` dit d'où ça vient : c'est
/// lui qui décide, au collage, entre le chemin local au serveur et le pont.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// `copy` ou `cut`.
    pub mode: String,
    pub connection_id: String,
    /// L'hôte, pour l'afficher (« 2 éléments de vps-prod »).
    pub host: String,
    pub from_dir: String,
    pub entries: Vec<ClipEntry>,
}

/// Le presse-papiers de fichiers, un seul pour toute l'application.
#[derive(Default)]
pub struct RemoteClipboard(pub StdMutex<Option<Clip>>);

/// Pose le presse-papiers et prévient toutes les fenêtres.
#[tauri::command]
pub fn clip_set(
    app: AppHandle,
    clipboard: State<'_, RemoteClipboard>,
    clip: Clip,
) -> Result<(), String> {
    *clipboard.0.lock().unwrap() = Some(clip);
    let _ = app.emit("clipboard:changed", ());
    Ok(())
}

#[tauri::command]
pub fn clip_get(clipboard: State<'_, RemoteClipboard>) -> Option<Clip> {
    clipboard.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn clip_clear(app: AppHandle, clipboard: State<'_, RemoteClipboard>) -> Result<(), String> {
    *clipboard.0.lock().unwrap() = None;
    let _ = app.emit("clipboard:changed", ());
    Ok(())
}

// ---------- Le glissé entre fenêtres ----------

/// L'ordre de focus des fenêtres, la plus récente d'abord. Le z-order réel
/// n'est pas exposé par Tauri : quand deux fenêtres se chevauchent sous le
/// curseur, la plus récemment active est le meilleur témoin de qui est devant.
#[derive(Default)]
pub struct FocusOrder(pub StdMutex<Vec<String>>);

pub fn note_focus(order: &FocusOrder, label: &str) {
    let mut list = order.0.lock().unwrap();
    list.retain(|item| item != label);
    list.insert(0, label.to_string());
}

/// La fenêtre actuellement survolée par un glissé, pour lui envoyer le
/// `drag-leave` quand le curseur passe ailleurs.
#[derive(Default)]
pub struct DragBroker(pub StdMutex<Option<String>>);

/// Relaye un glissé de fichiers vers la fenêtre sous le curseur.
///
/// Les événements pointeur ne traversent pas les webviews : la fenêtre source
/// continue de les recevoir tant que le bouton est enfoncé, mais celle d'en
/// face ne voit rien. Elle nourrit donc le backend (seul à connaître la
/// géométrie des fenêtres à l'écran), qui trouve la fenêtre visée et lui
/// relaie le survol (`flotte:drag-over`), la sortie (`flotte:drag-leave`) et
/// le dépôt (`flotte:drop`). Rend le label de la fenêtre touchée.
#[tauri::command]
pub fn drag_feed(
    window: tauri::WebviewWindow,
    app: AppHandle,
    broker: State<'_, DragBroker>,
    focus: State<'_, FocusOrder>,
    cx: f64,
    cy: f64,
    phase: String,
    text: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<Option<String>, String> {
    // Le point à l'écran, en pixels physiques : position du contenu de la
    // fenêtre source + coordonnées client × son échelle.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.inner_position().map_err(|e| e.to_string())?;
    let px = pos.x as f64 + cx * scale;
    let py = pos.y as f64 + cy * scale;

    let target = if phase == "cancel" {
        None
    } else {
        window_under(&app, &focus, window.label(), px, py)
    };
    let target_label = target.as_ref().map(|(label, _, _)| label.clone());

    // La fenêtre qu'on survolait et qu'on ne survole plus éteint son accueil.
    let previous = broker.0.lock().unwrap().clone();
    if let Some(prev) = &previous {
        if previous != target_label {
            let _ = app.emit_to(prev.as_str(), "flotte:drag-leave", ());
        }
    }

    match phase.as_str() {
        "move" => {
            if let Some((label, tx, ty)) = &target {
                let _ = app.emit_to(
                    label.as_str(),
                    "flotte:drag-over",
                    serde_json::json!({ "x": tx, "y": ty, "text": text }),
                );
            }
            *broker.0.lock().unwrap() = target_label.clone();
        }
        "drop" => {
            if let Some((label, tx, ty)) = &target {
                // La fenêtre qui reçoit prend le premier plan : un éventuel
                // dialogue de conflit doit s'ouvrir sous les yeux, pas
                // derrière la fenêtre d'où l'on vient.
                if let Some(win) = app.webview_windows().get(label.as_str()) {
                    let _ = win.set_focus();
                }
                let _ = app.emit_to(
                    label.as_str(),
                    "flotte:drop",
                    serde_json::json!({ "x": tx, "y": ty, "payload": payload }),
                );
            }
            *broker.0.lock().unwrap() = None;
        }
        _ => {
            *broker.0.lock().unwrap() = None;
        }
    }
    Ok(target_label)
}

/// La fenêtre (autre que la source) dont le contenu contient ce point écran,
/// avec les coordonnées client logiques correspondantes.
fn window_under(
    app: &AppHandle,
    focus: &FocusOrder,
    exclude: &str,
    px: f64,
    py: f64,
) -> Option<(String, f64, f64)> {
    let order = focus.0.lock().unwrap().clone();
    let mut best: Option<(usize, String, f64, f64)> = None;
    for (label, win) in app.webview_windows() {
        if label == exclude {
            continue;
        }
        // Un onglet caché garde sa dernière géométrie, superposée à la
        // fenêtre visible : seul ce qui est à l'écran peut recevoir un dépôt.
        if !win.is_visible().unwrap_or(true) {
            continue;
        }
        let (Ok(pos), Ok(size), Ok(scale)) =
            (win.inner_position(), win.inner_size(), win.scale_factor())
        else {
            continue;
        };
        let inside = px >= pos.x as f64
            && py >= pos.y as f64
            && px < pos.x as f64 + size.width as f64
            && py < pos.y as f64 + size.height as f64;
        if !inside {
            continue;
        }
        let rank = order
            .iter()
            .position(|item| item == &label)
            .unwrap_or(usize::MAX);
        let tx = (px - pos.x as f64) / scale;
        let ty = (py - pos.y as f64) / scale;
        if best.as_ref().map(|(r, ..)| rank < *r).unwrap_or(true) {
            best = Some((rank, label, tx, ty));
        }
    }
    best.map(|(_, label, tx, ty)| (label, tx, ty))
}

// ---------- Le pont ----------

/// Crée les dossiers parents manquants côté destination, segment par
/// segment : sans ça, copier vers un serveur où le dossier n'existe pas
/// échoue sur un « No such file » qui ne dit rien.
async fn ensure_parent_dirs(
    conn: &crate::sftp::ActiveConnection,
    path: &str,
) -> Result<(), String> {
    let Some(parent) = path.rfind('/').map(|at| &path[..at]) else {
        return Ok(());
    };
    if parent.is_empty() || conn.sftp.metadata(parent).await.is_ok() {
        return Ok(());
    }
    let mut current = String::new();
    for segment in parent.split('/').filter(|segment| !segment.is_empty()) {
        current.push('/');
        current.push_str(segment);
        if conn.sftp.metadata(&current).await.is_err() {
            conn.sftp.create_dir(&current).await.map_err(|e| {
                format!("Création du dossier {current} impossible côté destination : {e}")
            })?;
        }
    }
    Ok(())
}

fn ensure_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err(format!("Chemin refusé : {path}"));
    }
    Ok(())
}

/// Copie un fichier d'un serveur à un autre, en flux.
///
/// Rend le nombre d'octets écrits. Pas de reprise en v1 : une coupure laisse
/// le `.charonpart` côté destination, mais le recommencement repart de zéro.
#[tauri::command]
pub async fn sftp_transfer_remote(
    app: AppHandle,
    window: tauri::WebviewWindow,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, TransferRegistry>,
    from_connection: String,
    from_path: String,
    to_connection: String,
    to_path: String,
    transfer_id: String,
) -> Result<u64, String> {
    ensure_remote_path(&from_path)?;
    ensure_remote_path(&to_path)?;
    if from_connection == to_connection {
        return Err("Même serveur : la copie locale au serveur fait déjà ce travail.".into());
    }

    let source = get_connection(&pool, &from_connection).await?;
    let target = get_connection(&pool, &to_connection).await?;
    // Les DEUX sessions sont maintenues le temps du pont : la fermeture
    // d'inactivité couperait le transfert en plein vol.
    let _hold_source = ConnectionHold::new(source.clone());
    let _hold_target = ConnectionHold::new(target.clone());

    let cancel = register_transfer(&registry, &transfer_id);
    let result = pump(
        &app,
        window.label(),
        &source,
        &target,
        &from_path,
        &to_path,
        &transfer_id,
        &cancel,
    )
    .await;
    unregister_transfer(&registry, &transfer_id);

    if let Err(e) = &result {
        if e == CANCELLED_TAG {
            let _ = target
                .sftp
                .remove_file(format!("{to_path}{PART_SUFFIX}"))
                .await;
        }
    }
    eprintln!("[charon] pont {from_path} -> {to_path} : {result:?}");
    result
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    app: &AppHandle,
    label: &str,
    source: &crate::sftp::ActiveConnection,
    target: &crate::sftp::ActiveConnection,
    from_path: &str,
    to_path: &str,
    transfer_id: &str,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let meta = source
        .sftp
        .metadata(from_path)
        .await
        .map_err(|e| format!("Lecture de {from_path} impossible : {e}"))?;
    if meta.is_dir() {
        return Err("Le pont ne copie que des fichiers pour l'instant.".into());
    }
    let total = meta.size.unwrap_or(0);

    let mut reader = source
        .sftp
        .open(from_path)
        .await
        .map_err(|e| format!("Ouverture de {from_path} impossible : {e}"))?;

    // Le chemin de destination peut ne pas exister chez l'autre (« Copier
    // vers X » vise le MÊME chemin, et /home/<user> diffère d'un serveur à
    // l'autre) : les dossiers parents manquants sont créés, comme mkdir -p.
    ensure_parent_dirs(target, to_path).await?;

    let part = format!("{to_path}{PART_SUFFIX}");
    let mut writer = target
        .sftp
        .create(&part)
        .await
        .map_err(|e| format!("Création de {part} impossible : {e}"))?;

    let mut buffer = vec![0_u8; CHUNK_SIZE];
    let mut transferred: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED_TAG.to_string());
        }
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {from_path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Écriture de {part} impossible : {e}"))?;
        transferred += read as u64;
        if last_emit.elapsed() >= PROGRESS_EVERY {
            last_emit = std::time::Instant::now();
            // Marquer l'activité au même rythme que la progression suffit
            // largement à tenir la fermeture d'inactivité à distance.
            source.touch_public();
            target.touch_public();
            emit_progress(app, label, transfer_id, transferred, total.max(transferred));
        }
    }

    writer
        .sync_all()
        .await
        .map_err(|e| format!("Finalisation de {part} impossible : {e}"))?;
    drop(writer);

    // Le compte doit tomber juste : écrire moins que la source annoncée, c'est
    // un fichier tronqué qu'il ne faut surtout pas mettre en place.
    if total > 0 && transferred != total {
        return Err(format!(
            "Transfert incomplet : {transferred} octets écrits sur {total} attendus."
        ));
    }

    let _ = target.sftp.remove_file(to_path).await;
    target
        .sftp
        .rename(&part, to_path)
        .await
        .map_err(|e| format!("Finalisation de {to_path} impossible : {e}"))?;

    emit_progress(app, label, transfer_id, transferred, total.max(transferred));
    Ok(transferred)
}
