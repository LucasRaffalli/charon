use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use russh::client;
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::sftp::{get_connection, ConnectionHold, ConnectionPool};

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

/// Suivis de logs (`tail -F`) ouverts, par identifiant de tail.
#[derive(Default)]
pub struct TailRegistry(pub StdMutex<HashMap<String, ChannelWriteHalf<client::Msg>>>);

/// Compteur d'identifiants de tails.
static TAIL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Échappement shell strict : le chemin est enfermé dans des quotes simples,
/// les quotes simples internes deviennent la séquence `'\''`. Aucun autre
/// caractère (backticks, $, ;…) ne peut s'échapper d'une quote simple POSIX.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// Erreur balisée : l'utilisateur a annulé l'invite de mot de passe.
const SUDO_CANCELLED: &str = "CHARON_SUDO_CANCELLED";

/// Demande le mot de passe administrateur via une invite macOS **native**
/// (osascript). Le mot de passe est saisi hors WebView (hors de portée d'un
/// XSS), renvoyé uniquement au backend. `detail` décrit l'opération pour que
/// l'utilisateur puisse refuser toute action inattendue.
async fn prompt_admin_password(detail: &str) -> Result<String, String> {
    let message = format!(
        "Cette action nécessite des droits administrateur (sudo) sur le serveur.\n\n{detail}\n\nMot de passe :"
    );
    // Échappement de chaîne AppleScript (les arguments -e ne passent pas par
    // un shell : pas d'injection possible). Backslash d'abord, puis guillemets,
    // puis les retours à la ligne — une chaîne AppleScript n'accepte pas de
    // saut de ligne brut, il faut la séquence littérale `\n` (interprétée).
    let esc = message
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    let script = format!(
        "set r to display dialog \"{esc}\" with title \"Charon\" \
         default answer \"\" with hidden answer with icon caution \
         buttons {{\"Annuler\", \"Autoriser\"}} default button \"Autoriser\" \
         cancel button \"Annuler\"\ntext returned of r"
    );
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
    })
    .await
    .map_err(|e| format!("Invite système impossible : {e}"))?
    .map_err(|e| format!("Invite système impossible : {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let low = stderr.to_lowercase();
        // Annulation utilisateur (bouton Annuler / Échap) → erreur -128.
        if stderr.contains("-128") || low.contains("canceled") || low.contains("cancelled") {
            return Err(SUDO_CANCELLED.to_string());
        }
        // Toute autre défaillance osascript remonte (plus de silence).
        return Err(format!("Invite système impossible : {}", stderr.trim()));
    }
    let mut password = String::from_utf8_lossy(&output.stdout).into_owned();
    while password.ends_with('\n') || password.ends_with('\r') {
        password.pop();
    }
    Ok(password)
}

/// Réessaie une opération de fichier **échouée pour permission** en l'exécutant
/// avec `sudo` sur la session SSH. SFTP uniquement.
///
/// Sécurité :
/// - l'`op` est **whitelistée** (mkdir / rm fichier / rm -rf dossier / mv) —
///   jamais une commande brute venue de la WebView ;
/// - les chemins sont échappés en quotes simples POSIX (`shell_quote`) ;
/// - `sudo -S -k` lit le mot de passe sur stdin et **réinvalide** le cache sudo
///   (chaque escalade re-demande le mot de passe) ;
/// - le mot de passe transite par stdin, n'est ni stocké ni journalisé.
/// Garde-fou de chemin pour une opération sudo : chemin absolu, jamais la
/// racine seule, aucun composant `..`. Défense en profondeur — `sftp_sudo`
/// est invocable directement depuis la WebView, on ne se repose pas sur l'UI
/// pour empêcher un `rm -rf /` en root.
fn ensure_sudo_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path == "/"
        || path.split('/').any(|component| component == "..")
    {
        return Err(format!("Chemin refusé pour une opération privilégiée : {path}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_sudo(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    op: String,
    path: String,
    path2: Option<String>,
) -> Result<(), String> {
    ensure_sudo_path(&path)?;
    // Commande à exécuter + description humaine affichée dans l'invite native.
    let (target, detail) = match op.as_str() {
        "mkdir" => (
            format!("mkdir -p -- {}", shell_quote(&path)),
            format!("Créer le dossier :\n{path}"),
        ),
        "touch" => (
            format!("touch -- {}", shell_quote(&path)),
            format!("Créer le fichier :\n{path}"),
        ),
        "rm_file" => (
            format!("rm -f -- {}", shell_quote(&path)),
            format!("Supprimer le fichier :\n{path}"),
        ),
        "rm_dir" => (
            format!("rm -rf -- {}", shell_quote(&path)),
            format!("Supprimer le dossier et tout son contenu :\n{path}"),
        ),
        "rename" => {
            let to = path2.ok_or("Chemin de destination manquant.")?;
            ensure_sudo_path(&to)?;
            (
                format!("mv -f -- {} {}", shell_quote(&path), shell_quote(&to)),
                format!("Renommer :\n{path}\n→ {to}"),
            )
        }
        _ => return Err("Opération non autorisée.".into()),
    };

    let conn = get_connection(&pool, &connection_id).await?;
    // Mot de passe saisi hors WebView (invite native), jamais transmis par l'IPC.
    let password = prompt_admin_password(&detail).await?;

    // -S : mot de passe sur stdin ; -k : ignore le cache (re-demande à chaque
    // fois) ; -p '' : pas d'invite parasite dans la sortie capturée.
    let command = format!("sudo -S -k -p '' -- {target}");
    let stdin = format!("{password}\n");
    // Timeout : un serveur qui garde le canal ouvert ne bloque pas une tâche.
    let (code, output) = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        conn.exec_capture(command, stdin.as_bytes()),
    )
    .await
    .map_err(|_| "Délai dépassé pour l'opération privilégiée.".to_string())??;
    if code == 0 {
        return Ok(());
    }
    let message = output.trim();
    Err(if message.is_empty() {
        format!("Échec de l'opération sudo (code {code}).")
    } else {
        message.to_string()
    })
}

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
    // Terminal ouvert = connexion maintenue (pas de fermeture d'inactivité).
    let hold = ConnectionHold::new(conn.clone());

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
        // Vit aussi longtemps que la pompe : relâché à la fermeture du shell.
        let _hold = hold;
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

/// Suit un fichier distant en direct (`tail -n N -F`) via un canal exec sur
/// la session SSH existante. SFTP uniquement. Les lignes arrivent au front
/// par l'event `tail:data` (base64), la fin par `tail:closed`.
#[tauri::command]
pub async fn tail_open(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    tails: State<'_, TailRegistry>,
    connection_id: String,
    path: String,
    lines: u32,
) -> Result<String, String> {
    let conn = get_connection(&pool, &connection_id).await?;
    // Suivi de log actif = connexion maintenue (pas de fermeture d'inactivité).
    let hold = ConnectionHold::new(conn.clone());

    let channel = conn
        .open_channel()
        .await
        .map_err(|e| format!("Ouverture du canal impossible : {e}"))?;
    let command = format!(
        "tail -n {} -F -- {} 2>&1",
        lines.min(1000),
        shell_quote(&path)
    );
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("Lancement du suivi impossible : {e}"))?;

    let tail_id = format!(
        "tail-{}",
        TAIL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (mut read, write) = channel.split();
    tails
        .inner()
        .0
        .lock()
        .unwrap()
        .insert(tail_id.clone(), write);

    let handle = app.clone();
    let id = tail_id.clone();
    tauri::async_runtime::spawn(async move {
        // Vit aussi longtemps que le suivi : relâché à l'arrêt du tail.
        let _hold = hold;
        loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let encoded = BASE64.encode(&data[..]);
                    let _ = handle.emit(
                        "tail:data",
                        TermEvent {
                            id: &id,
                            data: &encoded,
                        },
                    );
                }
                Some(ChannelMsg::Close) | None => {
                    handle
                        .state::<TailRegistry>()
                        .inner()
                        .0
                        .lock()
                        .unwrap()
                        .remove(&id);
                    let _ = handle.emit("tail:closed", TermEvent { id: &id, data: "" });
                    break;
                }
                Some(_) => {}
            }
        }
    });

    Ok(tail_id)
}

/// Arrête un suivi de log.
#[tauri::command]
pub async fn tail_close(tails: State<'_, TailRegistry>, tail_id: String) -> Result<(), String> {
    let write = {
        let mut map = tails.inner().0.lock().unwrap();
        map.remove(&tail_id)
    };
    if let Some(write) = write {
        let _ = write.eof().await;
        let _ = write.close().await;
    }
    Ok(())
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
