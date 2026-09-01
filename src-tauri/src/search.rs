//! Recherche récursive sur le serveur (portée C de docs/search.md).
//!
//! Deux voies, parce qu'aucune ne suffit seule. **L'exec** (`find` pour les
//! noms, `grep -rE` pour le contenu) fait le travail sur le serveur : c'est le
//! seul moyen viable sur une grosse arborescence, aucun aller-retour par
//! fichier. **Le walk** parcourt en SFTP depuis Rust : plus lent, incapable de
//! lire le contenu sans télécharger, mais il ne dépend d'aucun binaire distant
//! et fonctionne en FTP. Exec d'abord, walk en repli quand la commande manque
//! (exit 127) ; en FTP, walk et noms uniquement.
//!
//! Les résultats arrivent au fil de l'eau, sur le modèle de `tail_open` :
//! `search:hit` par lots, `search:done` avec la raison d'arrêt (jamais de
//! troncature silencieuse), `search:error`. Le point critique de sécurité est
//! que la requête de l'utilisateur devient un argument de commande distante :
//! chemin ET motif passent par `shell_quote`, un `--` précède toujours le
//! motif et le chemin, et la commande est construite ici, jamais fournie.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use russh::client;
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ftp::{self, FtpPool};
use crate::sftp::{get_connection, is_safe_entry_name, ConnectionHold, ConnectionPool};
use crate::shell::shell_quote;

// ---------- Garde-fous ----------

/// Plafond de résultats : atteint, la recherche s'arrête en le disant.
pub(crate) const MAX_HITS: usize = 1000;

/// Délai maximal d'une recherche, annoncé de la même façon.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(60);

/// Une ligne de contenu interminable (fichier minifié) est coupée : c'est un
/// aperçu, le fichier complet est à un clic.
const MAX_LINE_CHARS: usize = 400;

/// Profondeur maximale du walk de repli.
pub(crate) const MAX_WALK_DEPTH: usize = 16;

/// Dossiers exclus d'office : personne ne cherche là volontairement, et c'est
/// là que vivent les arborescences à cent mille entrées.
pub(crate) const EXCLUDED_DIRS: [&str; 4] = [".git", "node_modules", "vendor", ".svn"];

static SEARCH_COUNTER: AtomicU64 = AtomicU64::new(1);

// ---------- État ----------

/// Une recherche en cours : le canal exec à fermer, ou le drapeau du walk.
pub enum SearchTask {
    Exec(ChannelWriteHalf<client::Msg>),
    Walk(Arc<AtomicBool>),
}

/// Recherches en cours, par identifiant.
#[derive(Default)]
pub struct SearchRegistry(pub StdMutex<HashMap<String, SearchTask>>);

// ---------- Événements ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    pub path: String,
    /// Numéro de ligne, pour une recherche de contenu.
    pub line: Option<u64>,
    /// La ligne trouvée, tronquée, pour une recherche de contenu.
    pub text: Option<String>,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
struct HitBatch<'a> {
    id: &'a str,
    hits: &'a [SearchHit],
}

#[derive(Serialize, Clone)]
struct DoneEvent<'a> {
    id: &'a str,
    total: usize,
    /// `complete`, `cap`, `timeout` ou `cancelled`.
    reason: &'a str,
}

#[derive(Serialize, Clone)]
struct ErrorEvent<'a> {
    id: &'a str,
    message: &'a str,
}

pub(crate) fn emit_hits(app: &AppHandle, id: &str, hits: &[SearchHit]) {
    if !hits.is_empty() {
        let _ = app.emit("search:hit", HitBatch { id, hits });
    }
}

pub(crate) fn emit_done(app: &AppHandle, id: &str, total: usize, reason: &str) {
    app.state::<SearchRegistry>().0.lock().unwrap().remove(id);
    let _ = app.emit("search:done", DoneEvent { id, total, reason });
}

pub(crate) fn emit_error(app: &AppHandle, id: &str, message: &str) {
    app.state::<SearchRegistry>().0.lock().unwrap().remove(id);
    let _ = app.emit("search:error", ErrorEvent { id, message });
}

// ---------- Validation ----------

/// Racine de recherche : absolue, sans remontée, et sans caractère de contrôle.
///
/// Le refus des contrôles n'est pas décoratif : en FTP cette racine part dans
/// un `LIST` sur le canal de contrôle, où un retour à la ligne permettrait
/// d'injecter une commande (RUSTSEC-2026-0271). Les entrées de listing sont
/// filtrées par `is_safe_entry_name`, mais la racine, elle, vient du front,
/// où l'on peut coller un chemin à la main.
fn ensure_search_root(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err("Chemin de recherche invalide.".into());
    }
    if path.chars().any(char::is_control) {
        return Err("Chemin de recherche invalide (caractère de contrôle).".into());
    }
    Ok(())
}

/// Un chemin renvoyé par le serveur : mêmes exigences, on filtre au retour
/// comme les listings filtrent les leurs.
fn is_safe_result_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains('\u{0}')
        && path
            .split('/')
            .all(|c| c.is_empty() || c != ".." && c != ".")
}

// ---------- Commandes ----------

/// Lance une recherche. `pattern` est le motif POSIX ERE (déjà échappé côté
/// front en mode texte) ; `plain` porte la saisie brute quand elle existe,
/// c'est elle qui alimente le walk de repli, incapable de regex.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_start(
    app: AppHandle,
    pool: State<'_, ConnectionPool>,
    ftp_pool: State<'_, FtpPool>,
    registry: State<'_, SearchRegistry>,
    connection_id: String,
    root: String,
    pattern: String,
    content: bool,
    case_sensitive: bool,
    plain: Option<String>,
) -> Result<String, String> {
    ensure_search_root(&root)?;
    if pattern.is_empty() {
        return Err("Motif vide.".into());
    }

    let search_id = format!("search-{}", SEARCH_COUNTER.fetch_add(1, Ordering::Relaxed));

    // FTP : pas de canal exec, donc walk, donc noms uniquement et texte
    // uniquement. L'interface l'annonce avant, ici on refuse net.
    //
    // Le schéma fait foi, pas le préfixe nu : un id SFTP est `user@host:port`,
    // et un utilisateur nommé `ftpadmin` ne doit pas partir vers le pool FTP.
    if connection_id.starts_with("ftp://") || connection_id.starts_with("ftps://") {
        if content {
            return Err("La recherche de contenu demande une session SSH (SFTP).".into());
        }
        let Some(needle) = plain else {
            return Err(
                "La recherche par expression régulière demande une session SSH (SFTP).".into(),
            );
        };
        let conn = ftp::get_ftp_connection(&ftp_pool, &connection_id).await?;
        let cancel = Arc::new(AtomicBool::new(false));
        registry
            .0
            .lock()
            .unwrap()
            .insert(search_id.clone(), SearchTask::Walk(cancel.clone()));
        let id = search_id.clone();
        tauri::async_runtime::spawn(async move {
            ftp::search_walk(app, conn, id, root, needle, case_sensitive, cancel).await;
        });
        return Ok(search_id);
    }

    let conn = get_connection(&pool, &connection_id).await?;
    // Une recherche longue ne doit pas être coupée par la fermeture d'inactivité.
    let hold = ConnectionHold::new(conn.clone());

    let channel = conn
        .open_channel()
        .await
        .map_err(|e| format!("Ouverture du canal impossible : {e}"))?;

    let ci = if case_sensitive { "" } else { "i" };
    let quoted_pattern = shell_quote(&pattern);
    let quoted_root = shell_quote(&root);
    let command = if content {
        // -I ignore les binaires, -n donne la ligne, head plafonne côté
        // serveur : le tube fermé arrête grep de lui-même.
        let excludes = EXCLUDED_DIRS
            .iter()
            .map(|d| format!("--exclude-dir={}", shell_quote(d)))
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "nice grep -rInE{ci} {excludes} -- {quoted_pattern} {quoted_root} 2>/dev/null | head -n {MAX_HITS}"
        )
    } else {
        // find énumère (dossiers exclus élagués), grep filtre le chemin
        // complet : un seul binaire à connaître de plus que le contenu.
        let prune = EXCLUDED_DIRS
            .iter()
            .map(|d| format!("-name {}", shell_quote(d)))
            .collect::<Vec<_>>()
            .join(" -o ");
        format!(
            "nice find {quoted_root} \\( {prune} \\) -prune -o -print 2>/dev/null | grep -E{ci} -- {quoted_pattern} | head -n {MAX_HITS}"
        )
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("Lancement de la recherche impossible : {e}"))?;

    let (mut read, write) = channel.split();
    registry
        .0
        .lock()
        .unwrap()
        .insert(search_id.clone(), SearchTask::Exec(write));

    let id = search_id.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        let mut pending = String::new();
        let mut total = 0usize;
        let mut exit_code: Option<u32> = None;

        loop {
            let msg = tokio::select! {
                msg = read.wait() => msg,
                _ = tokio::time::sleep_until(deadline) => {
                    close_exec(&app, &id).await;
                    emit_done(&app, &id, total, "timeout");
                    return;
                }
            };
            match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    pending.push_str(&String::from_utf8_lossy(&data));
                    let mut hits = Vec::new();
                    // La dernière ligne peut être coupée en plein milieu :
                    // elle reste dans le tampon jusqu'au prochain paquet.
                    while let Some(nl) = pending.find('\n') {
                        let line: String = pending.drain(..=nl).collect();
                        if let Some(hit) = parse_line(line.trim_end_matches(['\n', '\r']), content)
                        {
                            hits.push(hit);
                            total += 1;
                        }
                    }
                    emit_hits(&app, &id, &hits);
                    if total >= MAX_HITS {
                        close_exec(&app, &id).await;
                        emit_done(&app, &id, total, "cap");
                        return;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }

        // Arrêté par search_stop : l'entrée du registre a déjà disparu.
        let cancelled = !app
            .state::<SearchRegistry>()
            .0
            .lock()
            .unwrap()
            .contains_key(&id);
        if cancelled {
            let _ = app.emit(
                "search:done",
                DoneEvent {
                    id: &id,
                    total,
                    reason: "cancelled",
                },
            );
            return;
        }

        // Binaire absent (127) : le walk prend le relais pour les noms, en
        // texte seulement. Le contenu, lui, n'a pas de repli honnête.
        if exit_code == Some(127) {
            if !content {
                if let Some(needle) = plain {
                    let cancel = Arc::new(AtomicBool::new(false));
                    app.state::<SearchRegistry>()
                        .0
                        .lock()
                        .unwrap()
                        .insert(id.clone(), SearchTask::Walk(cancel.clone()));
                    sftp_walk(&app, &conn, &id, &root, &needle, case_sensitive, &cancel).await;
                    drop(hold);
                    return;
                }
                emit_error(
                    &app,
                    &id,
                    "find/grep sont absents du serveur ; la recherche par expression régulière demande l'un des deux.",
                );
                return;
            }
            emit_error(
                &app,
                &id,
                "grep est absent du serveur : recherche de contenu impossible.",
            );
            return;
        }
        // grep sort en 1 quand rien ne correspond : ce n'est pas une erreur.
        if let Some(code) = exit_code {
            if code > 1 && total == 0 {
                emit_error(&app, &id, "La recherche a échoué sur le serveur.");
                return;
            }
        }

        drop(hold);
        emit_done(&app, &id, total, "complete");
    });

    Ok(search_id)
}

/// Arrête une recherche en cours.
#[tauri::command]
pub async fn search_stop(
    registry: State<'_, SearchRegistry>,
    search_id: String,
) -> Result<(), String> {
    let task = registry.0.lock().unwrap().remove(&search_id);
    match task {
        Some(SearchTask::Exec(write)) => {
            let _ = write.close().await;
        }
        Some(SearchTask::Walk(flag)) => flag.store(true, Ordering::Relaxed),
        None => {}
    }
    Ok(())
}

/// Ferme le canal d'une recherche exec depuis sa propre pompe (délai, plafond).
async fn close_exec(app: &AppHandle, id: &str) {
    let task = app.state::<SearchRegistry>().0.lock().unwrap().remove(id);
    if let Some(SearchTask::Exec(write)) = task {
        let _ = write.close().await;
    }
}

/// Une ligne de sortie devient un résultat, ou rien si elle est illisible.
fn parse_line(line: &str, content: bool) -> Option<SearchHit> {
    if line.is_empty() {
        return None;
    }
    if !content {
        if !is_safe_result_path(line) {
            return None;
        }
        return Some(SearchHit {
            path: line.to_string(),
            line: None,
            text: None,
            // find ne le dit pas ; le front tranchera à l'ouverture.
            is_dir: false,
        });
    }
    // Format grep -rn : `chemin:ligne:texte`. Le chemin d'un serveur Unix ne
    // contient pas de `:` interdit, mais au cas où, on lit de gauche à droite
    // et on exige un numéro : le premier `:nombre:` rencontré fait foi.
    let first = line.find(':')?;
    let rest = &line[first + 1..];
    let second = rest.find(':')?;
    let number: u64 = rest[..second].parse().ok()?;
    let path = &line[..first];
    if !is_safe_result_path(path) {
        return None;
    }
    let text: String = rest[second + 1..].chars().take(MAX_LINE_CHARS).collect();
    Some(SearchHit {
        path: path.to_string(),
        line: Some(number),
        text: Some(text),
        is_dir: false,
    })
}

/// Le repli : parcours SFTP en largeur, correspondance par sous-chaîne sur le
/// NOM. Il émet les mêmes événements que l'exec, l'appelant ne voit pas la
/// différence.
async fn sftp_walk(
    app: &AppHandle,
    conn: &Arc<crate::sftp::ActiveConnection>,
    id: &str,
    root: &str,
    needle: &str,
    case_sensitive: bool,
    cancel: &Arc<AtomicBool>,
) {
    let needle_folded = if case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let mut to_visit: Vec<(String, usize)> = vec![(root.to_string(), 0)];
    let mut total = 0usize;

    while let Some((dir, depth)) = to_visit.pop() {
        if cancel.load(Ordering::Relaxed) {
            emit_done(app, id, total, "cancelled");
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            emit_done(app, id, total, "timeout");
            return;
        }
        let Ok(entries) = conn.sftp.read_dir(&dir).await else {
            continue; // dossier illisible : on passe, comme find 2>/dev/null
        };
        let mut hits = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if !is_safe_entry_name(&name) || EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let child = if dir == "/" {
                format!("/{name}")
            } else {
                format!("{dir}/{name}")
            };
            let is_dir = entry.metadata().is_dir();
            let haystack = if case_sensitive {
                name.clone()
            } else {
                name.to_lowercase()
            };
            if haystack.contains(&needle_folded) {
                hits.push(SearchHit {
                    path: child.clone(),
                    line: None,
                    text: None,
                    is_dir,
                });
                total += 1;
                if total >= MAX_HITS {
                    emit_hits(app, id, &hits);
                    emit_done(app, id, total, "cap");
                    return;
                }
            }
            if is_dir && depth < MAX_WALK_DEPTH {
                to_visit.push((child, depth + 1));
            }
        }
        emit_hits(app, id, &hits);
    }

    emit_done(app, id, total, "complete");
}
