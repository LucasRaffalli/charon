use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

// ---------- Modules (extensions tierces) ----------
//
// Ce module ne fait QUE gérer les fichiers (découverte, état activé,
// ouverture du dossier, suppression). Il n'EXÉCUTE aucun code de module —
// l'exécution se fait côté WebView dans un iframe sandboxé (voir docs/modules.md).

const STORE_FILE: &str = "modules.json";
const ENABLED_KEY: &str = "enabled";

/// Manifeste brut lu depuis `manifest.json` (validation légère au parse).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    // Lu au chargement du module (front), pas dans le résumé des réglages.
    #[serde(default)]
    #[allow(dead_code)]
    main: String,
    #[serde(default)]
    engine: String,
    #[serde(default)]
    permissions: Vec<String>,
}

/// Résumé d'un module pour la liste des réglages.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummary {
    /// Nom du dossier = identité fichier stable (clé pour activer/supprimer).
    slug: String,
    id: String,
    name: String,
    version: String,
    engine: String,
    description: Option<String>,
    author: Option<String>,
    permissions: Vec<String>,
    enabled: bool,
    dir: String,
    /// Renseigné si le manifeste est invalide (module non chargeable).
    error: Option<String>,
}

/// Slug valide : nom de dossier simple, jamais de traversée.
fn ensure_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug == ".." || slug == "." {
        return Err(format!("Identifiant de module invalide : {slug}"));
    }
    Ok(())
}

/// Dossier des modules (`<app_data>/modules`), créé au besoin.
fn modules_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Dossier de données introuvable : {e}"))?
        .join("modules");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Création du dossier des modules impossible : {e}"))?;
    Ok(dir)
}

fn read_enabled(app: &AppHandle) -> HashMap<String, bool> {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(ENABLED_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn write_enabled(app: &AppHandle, map: &HashMap<String, bool>) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Ouverture du store impossible : {e}"))?;
    store.set(ENABLED_KEY, json!(map));
    store
        .save()
        .map_err(|e| format!("Écriture du store impossible : {e}"))
}

// ---------- Commands ----------

/// Liste les modules découverts (lecture des manifestes, aucune exécution).
#[tauri::command]
pub fn modules_list(app: AppHandle) -> Result<Vec<ModuleSummary>, String> {
    let dir = modules_dir(&app)?;
    let enabled = read_enabled(&app);
    let mut out = Vec::new();

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Lecture du dossier des modules impossible : {e}"))?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().into_owned();
        if slug.starts_with('.') {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let is_enabled = enabled.get(&slug).copied().unwrap_or(false);
        let dir_str = path.to_string_lossy().into_owned();

        let summary = match std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("manifest.json illisible : {e}"))
            .and_then(|raw| {
                serde_json::from_str::<RawManifest>(&raw)
                    .map_err(|e| format!("manifest.json invalide : {e}"))
            }) {
            Ok(m) => ModuleSummary {
                slug: slug.clone(),
                id: if m.id.is_empty() { slug.clone() } else { m.id },
                name: if m.name.is_empty() { slug.clone() } else { m.name },
                version: m.version,
                engine: m.engine,
                description: m.description,
                author: m.author,
                permissions: m.permissions,
                enabled: is_enabled,
                dir: dir_str,
                error: None,
            },
            Err(error) => ModuleSummary {
                slug: slug.clone(),
                id: slug.clone(),
                name: slug.clone(),
                version: String::new(),
                engine: String::new(),
                description: None,
                author: None,
                permissions: Vec::new(),
                enabled: false,
                dir: dir_str,
                error: Some(error),
            },
        };
        out.push(summary);
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Active ou désactive un module (état persisté ; le chargement effectif est
/// géré côté WebView).
#[tauri::command]
pub fn module_set_enabled(app: AppHandle, slug: String, enabled: bool) -> Result<(), String> {
    ensure_slug(&slug)?;
    let mut map = read_enabled(&app);
    map.insert(slug, enabled);
    write_enabled(&app, &map)
}

/// Ouvre le dossier des modules dans le Finder.
#[tauri::command]
pub fn modules_open_folder(app: AppHandle) -> Result<(), String> {
    let dir = modules_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| format!("Ouverture du dossier impossible : {e}"))
}

/// Supprime définitivement un module (son dossier) et son état.
#[tauri::command]
pub fn module_delete(app: AppHandle, slug: String) -> Result<(), String> {
    ensure_slug(&slug)?;
    let dir = modules_dir(&app)?.join(&slug);
    // Garde-fou : le chemin résolu doit rester dans le dossier des modules.
    if !dir.starts_with(modules_dir(&app)?) {
        return Err("Chemin de module refusé.".into());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Suppression du module impossible : {e}"))?;
    let mut map = read_enabled(&app);
    map.remove(&slug);
    write_enabled(&app, &map)
}
