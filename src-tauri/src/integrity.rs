//! Vérification d'intégrité après transfert (idée 04 des sept idées).
//!
//! Comparer un sha256 local et distant transforme « le fichier est parti » en
//! « le fichier est identique », ce qui n'est pas la même promesse quand on
//! pousse en production.
//!
//! Le côté serveur passe par le canal exec, comme `tail` et la recherche :
//! `sha256sum` sur Linux, `shasum -a 256` sur macOS et les BSD. Les deux sont
//! tentés dans cet ordre, et un serveur qui n'a ni l'un ni l'autre le dit
//! plutôt que de laisser croire à une vérification qui n'a pas eu lieu.

use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::sftp::{get_connection, ConnectionPool};
use crate::shell::shell_quote;

/// Lecture par blocs : un hachage ne doit pas charger un DVD en mémoire.
const CHUNK: usize = 1024 * 1024;

/// Empreinte sha256 d'un fichier local, calculée en flux.
#[tauri::command]
pub async fn local_sha256(path: String) -> Result<String, String> {
    if path.split('/').any(|c| c == "..") {
        return Err("Chemin local refusé.".into());
    }
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Lecture de {path} impossible : {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Empreinte sha256 d'un fichier distant, calculée PAR LE SERVEUR.
///
/// C'est tout l'intérêt : re-télécharger le fichier pour le hacher localement
/// ne vérifierait que le second téléchargement.
#[tauri::command]
pub async fn sftp_sha256(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    if !path.starts_with('/') || path.split('/').any(|c| c == "..") {
        return Err("Chemin distant refusé.".into());
    }
    let conn = get_connection(&pool, &connection_id).await?;
    let quoted = shell_quote(&path);
    // `command -v` évite le message d'erreur du shell quand le binaire manque.
    let command = format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {quoted}; \
         elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {quoted}; \
         else echo CHARON_NO_SHA >&2; exit 127; fi"
    );
    let (code, output) = conn.exec_capture(command, &[]).await?;
    if code == 127 || output.contains("CHARON_NO_SHA") {
        return Err("Le serveur n'a ni sha256sum ni shasum : vérification impossible.".into());
    }
    if code != 0 {
        let detail = output.trim();
        return Err(if detail.is_empty() {
            format!("Empreinte de {path} impossible (code {code}).")
        } else {
            format!("Empreinte impossible : {detail}")
        });
    }
    // Les deux outils répondent « <empreinte>  <chemin> ».
    output
        .split_whitespace()
        .next()
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| h.to_lowercase())
        .ok_or_else(|| "Réponse d'empreinte illisible.".to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
