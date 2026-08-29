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
    #[serde(default)]
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
    /// Point d'entrée JS (relatif au dossier) — nécessaire au chargement.
    main: String,
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

// ---------- Modules fournis avec l'application ----------
//
// Charon embarque quelques modules, installés au premier lancement et
// DÉSACTIVÉS : un module fourni est une proposition, pas un supplément qu'on
// s'ajoute sans l'avoir demandé (le store `enabled` n'a pas d'entrée pour eux,
// et l'absence d'entrée vaut « éteint »).
//
// Ils s'installent comme n'importe quel module, dans le même dossier et avec
// le même manifeste : rien ne les distingue une fois posés, et l'utilisateur
// peut les modifier ou les supprimer. C'est ce qui permettra de les mettre à
// jour indépendamment de l'application.
struct BundledModule {
    slug: &'static str,
    manifest: &'static str,
    main: &'static str,
}

const BUNDLED: &[BundledModule] = &[BundledModule {
    slug: "monitor",
    manifest: include_str!("../../modules/monitor/manifest.json"),
    main: include_str!("../../modules/monitor/main.js"),
}];

/// Modules fournis qui ont changé de dossier : l'ancien est retiré pour ne pas
/// laisser un doublon mort dans la liste. Le retrait ne se fait QUE si le
/// manifeste présent porte bien l'identifiant attendu : un dossier du même nom
/// posé par l'utilisateur ne doit jamais être emporté par ce ménage.
const SUPERSEDED: &[(&str, &str)] = &[("vps-monitor", "com.charon.moniteur-vps")];

/// Compare deux versions segment par segment (`1.10.0` est après `1.9.0`, ce
/// qu'une comparaison de chaînes rendrait faux).
fn version_is_newer(candidate: &str, installed: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.')
            .map(|part| part.trim().parse::<u32>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(candidate), parse(installed));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// La version déclarée par un `manifest.json` déjà posé sur le disque.
fn installed_version(dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(parsed.get("version")?.as_str()?.to_string())
}

/// Pose les modules fournis. Silencieux : un module qui ne s'installe pas ne
/// doit pas empêcher l'application de démarrer.
///
/// Un module déjà présent n'est réécrit que si la version embarquée est plus
/// RÉCENTE. Une version installée plus récente est laissée intacte : c'est
/// elle qui compte, et c'est ce qui rend une mise à jour hors de l'application
/// possible sans qu'un lancement la piétine.
pub fn install_bundled_modules(app: &AppHandle) {
    let Ok(root) = modules_dir(app) else {
        return;
    };

    for (slug, expected_id) in SUPERSEDED {
        let dir = root.join(slug);
        let same_module = std::fs::read_to_string(dir.join("manifest.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("id").and_then(|v| v.as_str()).map(String::from))
            .is_some_and(|id| id == *expected_id);
        if same_module {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    for module in BUNDLED {
        let dir = root.join(module.slug);
        let embedded = serde_json::from_str::<serde_json::Value>(module.manifest)
            .ok()
            .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_default();

        if dir.exists() {
            match installed_version(&dir) {
                Some(current) if !version_is_newer(&embedded, &current) => continue,
                _ => {}
            }
        }
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let _ = std::fs::write(dir.join("manifest.json"), module.manifest);
        let _ = std::fs::write(dir.join("main.js"), module.main);
    }
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
                main: if m.main.is_empty() { "main.js".into() } else { m.main },
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
                main: String::new(),
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

/// Lit un fichier texte d'un module (borné), pour charger son code côté front.
/// Refuse toute traversée hors du dossier du module.
#[tauri::command]
pub fn module_read_file(app: AppHandle, slug: String, file: String) -> Result<String, String> {
    ensure_slug(&slug)?;
    if file.contains("..") || file.starts_with('/') || file.starts_with('\\') {
        return Err("Chemin de fichier refusé.".into());
    }
    let base = modules_dir(&app)?.join(&slug);
    let path = base.join(&file);
    // Le chemin résolu doit rester dans le dossier du module.
    let canon_base = std::fs::canonicalize(&base).map_err(|e| format!("Module introuvable : {e}"))?;
    let canon_path =
        std::fs::canonicalize(&path).map_err(|e| format!("Fichier introuvable : {e}"))?;
    if !canon_path.starts_with(&canon_base) {
        return Err("Chemin de fichier refusé.".into());
    }
    let bytes = std::fs::read(&canon_path).map_err(|e| format!("Lecture impossible : {e}"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Fichier de module trop volumineux (max 2 Mio).".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
