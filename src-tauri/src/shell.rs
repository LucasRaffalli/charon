use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use russh::client;
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sftp::{get_connection, ConnectionPool};

// ---------- État ----------

/// Un terminal ouvert : la moitié écriture du canal shell
/// (la moitié lecture vit dans la tâche de pompage des données).
pub struct ShellHandle {
    write: ChannelWriteHalf<client::Msg>,
}

/// Terminaux ouverts, par identifiant (= identifiant de connexion : un
/// terminal par connexion).
#[derive(Default)]
pub struct ShellRegistry(pub StdMutex<HashMap<String, Arc<ShellHandle>>>);

/// Payload des events `term:data` (sortie du shell, base64) et `term:closed`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermEvent<'a> {
    id: &'a str,
    data: &'a str,
}

fn get_shell(registry: &State<'_, ShellRegistry>, id: &str) -> Result<Arc<ShellHandle>, String> {
    registry
        .inner()
        .0
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Terminal inconnu : {id}"))
}

// ---------- Commands ----------

/// Ouvre un shell interactif (PTY xterm-256color) sur la session SSH déjà
/// authentifiée. SFTP uniquement — aucun canal shell n'existe en FTP.
/// La sortie arrive au front via l'event `term:data` (base64).
#[tauri::command]
pub async fn shell_open(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    registry: State<'_, ShellRegistry>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let conn = get_connection(&pool, &connection_id).await?;

    // Un seul terminal par connexion : remplace l'éventuel existant.
    if let Some(previous) = registry.inner().0.lock().unwrap().remove(&connection_id) {
        let _ = previous;
    }

    let channel = conn
        .open_channel()
        .await
        .map_err(|e| format!("Ouverture du canal impossible : {e}"))?;
    channel
        .request_pty(true, "xterm-256color", u32::from(cols), u32::from(rows), 0, 0, &[])
        .await
        .map_err(|e| format!("Allocation du terminal impossible : {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Ouverture du shell impossible : {e}"))?;

    let (mut read, write) = channel.split();
    registry
        .inner()
        .0
        .lock()
        .unwrap()
        .insert(connection_id.clone(), Arc::new(ShellHandle { write }));

    // Pompe de sortie : chaque paquet du shell part vers le front en base64.
    let handle = app.clone();
    let term_id = connection_id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    let encoded = BASE64.encode(&data[..]);
                    let _ = handle.emit(
                        "term:data",
                        TermEvent {
                            id: &term_id,
                            data: &encoded,
                        },
                    );
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let encoded = BASE64.encode(&data[..]);
                    let _ = handle.emit(
                        "term:data",
                        TermEvent {
                            id: &term_id,
                            data: &encoded,
                        },
                    );
                }
                Some(ChannelMsg::Close) | None => {
                    handle
                        .state::<ShellRegistry>()
                        .inner()
                        .0
                        .lock()
                        .unwrap()
                        .remove(&term_id);
                    let _ = handle.emit(
                        "term:closed",
                        TermEvent {
                            id: &term_id,
                            data: "",
                        },
                    );
                    break;
                }
                Some(_) => {}
            }
        }
    });

    Ok(connection_id)
}

/// Envoie la frappe clavier au shell.
#[tauri::command]
pub async fn shell_write(
    registry: State<'_, ShellRegistry>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let shell = get_shell(&registry, &terminal_id)?;
    shell
        .write
        .data_bytes(data.into_bytes())
        .await
        .map_err(|e| format!("Écriture dans le terminal impossible : {e}"))
}

/// Suit les redimensionnements du panneau côté serveur.
#[tauri::command]
pub async fn shell_resize(
    registry: State<'_, ShellRegistry>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shell = get_shell(&registry, &terminal_id)?;
    shell
        .write
        .window_change(u32::from(cols), u32::from(rows), 0, 0)
        .await
        .map_err(|e| format!("Redimensionnement impossible : {e}"))
}

/// Ferme le terminal (EOF + close, retiré du registre).
#[tauri::command]
pub async fn shell_close(
    registry: State<'_, ShellRegistry>,
    terminal_id: String,
) -> Result<(), String> {
    let shell = {
        let mut map = registry.inner().0.lock().unwrap();
        map.remove(&terminal_id)
    };
    if let Some(shell) = shell {
        let _ = shell.write.eof().await;
        let _ = shell.write.close().await;
    }
    Ok(())
}
