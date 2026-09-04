use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

// ---------- Profils de serveurs ----------
//
// Les profils (hôte, port, utilisateur, chemin de clé) vivent dans le store
// tauri-plugin-store. Les secrets (passphrase/mot de passe) vont dans le
// trousseau macOS via `keyring` — jamais en clair dans le store.

const STORE_FILE: &str = "profiles.json";
const STORE_KEY: &str = "profiles";
const KEYCHAIN_SERVICE: &str = "app.charon";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_secret: bool,
    /// « sftp » (défaut), « ftps » ou « ftp ».
    #[serde(default)]
    pub protocol: Option<String>,
    /// « dev », « staging » ou « prod » — pilote le badge côté UI.
    #[serde(default)]
    pub environment: Option<String>,
    /// « confirm » ou « readonly » — garde-fou côté UI.
    #[serde(default)]
    pub protection: Option<String>,
    /// « key » (défaut) ou « password » : dit ce qu'est le secret rangé au
    /// trousseau, une passphrase de clé ou un mot de passe de compte.
    #[serde(default)]
    pub auth_method: Option<String>,
    /// Dossier d'arrivée : où déposer l'explorateur à la connexion. Absent, on
    /// arrive au dossier personnel puis, à défaut, à la racine.
    #[serde(default)]
    pub anchor: Option<String>,
    /// Raccourcis vers les dossiers où l'on retourne sans cesse. Ils vivent
    /// dans le profil et non dans un stockage à part : ce sont des chemins
    /// DE CE SERVEUR, ils s'exportent avec lui et suivent les fenêtres.
    #[serde(default)]
    pub favorites: Vec<Favorite>,
}

/// Un raccourci vers un dossier du serveur.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Favorite {
    pub path: String,
    /// Nom affiché : le dernier segment du chemin par défaut, renommable.
    pub label: String,
    /// Nom d'icône du registre de l'app (`folder`, `server`, `logs`…).
    #[serde(default)]
    pub icon: Option<String>,
}

// ---------- Helpers ----------

fn read_profiles(app: &AppHandle) -> Result<Vec<Profile>, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Ouverture du store impossible : {e}"))?;
    match store.get(STORE_KEY) {
        Some(value) => {
            serde_json::from_value(value).map_err(|e| format!("Profils illisibles : {e}"))
        }
        None => Ok(Vec::new()),
    }
}

fn write_profiles(app: &AppHandle, profiles: &[Profile]) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("Ouverture du store impossible : {e}"))?;
    store.set(STORE_KEY, json!(profiles));
    store
        .save()
        .map_err(|e| format!("Écriture du store impossible : {e}"))
}

fn keychain_entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, profile_id)
        .map_err(|e| format!("Accès au trousseau impossible : {e}"))
}

/// Secret d'un profil depuis le trousseau (None si absent). Réservé au backend :
/// les secrets ne sont jamais exposés à la WebView via IPC.
pub fn keychain_secret(profile_id: &str) -> Result<Option<String>, String> {
    match keychain_entry(profile_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        // Le refus d'accès a une cause précise et un remède précis, et le
        // message brut de macOS envoie exactement dans le mauvais sens.
        //
        // Le trousseau lie chaque entrée à la SIGNATURE du binaire qui l'a
        // créée. Charon est signé ad hoc (pas de compte Apple Developer), et
        // une signature ad hoc change à chaque build : après une mise à jour
        // (ou un rebuild en dev), macOS ouvre sa boîte système et demande le
        // mot de passe DE LA SESSION MAC pour ré-autoriser. Le réflexe est d'y
        // taper le mot de passe du serveur : refus, et l'erreur « user name or
        // passphrase not correct » laisse croire que le profil est corrompu.
        Err(e) => {
            let raw = e.to_string();
            if raw.contains("not correct") || raw.contains("-25293") {
                Err("Le trousseau macOS a refusé l'accès. Après une mise à jour                      de Charon, macOS redemande l'autorisation : retente, et dans                      la boîte du trousseau tape le mot de passe de ta session Mac                      (pas celui du serveur), puis « Toujours autoriser »."
                    .to_string())
            } else {
                Err(format!("Lecture du trousseau impossible : {raw}"))
            }
        }
    }
}

// ---------- Commands ----------

#[tauri::command]
pub fn profiles_list(app: AppHandle) -> Result<Vec<Profile>, String> {
    read_profiles(&app)
}

/// Crée ou met à jour un profil. `secret` : Some("...") l'enregistre dans le
/// trousseau, Some("") l'efface, None laisse l'existant tel quel.
/// `migrate_secret_from` : id d'un ancien profil dont le secret doit être
/// recopié (édition avec changement d'identifiant) — la copie se fait
/// entièrement côté Rust, sans jamais transiter par la WebView.
#[tauri::command]
pub fn profile_save(
    app: AppHandle,
    mut profile: Profile,
    secret: Option<String>,
    migrate_secret_from: Option<String>,
) -> Result<Vec<Profile>, String> {
    match secret.as_deref() {
        Some(s) if !s.is_empty() => {
            keychain_entry(&profile.id)?
                .set_password(s)
                .map_err(|e| format!("Écriture dans le trousseau impossible : {e}"))?;
            profile.has_secret = true;
        }
        Some(_) => {
            let _ = keychain_entry(&profile.id)?.delete_credential();
            profile.has_secret = false;
        }
        None => {
            let migrated = migrate_secret_from
                .filter(|old| *old != profile.id)
                .and_then(|old| keychain_secret(&old).ok().flatten());
            if let Some(s) = migrated {
                keychain_entry(&profile.id)?
                    .set_password(&s)
                    .map_err(|e| format!("Écriture dans le trousseau impossible : {e}"))?;
                profile.has_secret = true;
            } else {
                profile.has_secret = read_profiles(&app)?
                    .iter()
                    .find(|p| p.id == profile.id)
                    .is_some_and(|p| p.has_secret);
            }
        }
    }

    let mut profiles = read_profiles(&app)?;
    profiles.retain(|p| p.id != profile.id);
    profiles.push(profile);
    profiles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    write_profiles(&app, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
pub fn profile_delete(app: AppHandle, id: String) -> Result<Vec<Profile>, String> {
    if let Ok(entry) = keychain_entry(&id) {
        let _ = entry.delete_credential();
    }
    let mut profiles = read_profiles(&app)?;
    profiles.retain(|p| p.id != id);
    write_profiles(&app, &profiles)?;
    Ok(profiles)
}
