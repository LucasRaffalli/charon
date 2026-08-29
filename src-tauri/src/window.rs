//! Les fenêtres de la flotte : une fenêtre = une session.
//!
//! La création passe par une commande plutôt que par l'API webview côté
//! front : les permissions de la WebView n'ont pas à s'élargir.
//!
//! Au lancement, UNE seule fenêtre, toujours (tranché le 28/08/2026) : la
//! géographie mémorisée de la v1 rouvrait chaque fenêtre secondaire, y
//! compris les fenêtres cachées des onglets, en fenêtres séparées. ⌘N reste
//! le geste explicite pour en vouloir une deuxième.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Compteur de labels. Il repart à chaque lancement : les labels des fenêtres
/// mortes sont réutilisables, leurs clés de stockage scoppées aussi.
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(2);

/// Le profil que chaque fenêtre doit proposer à son démarrage, par label.
/// Rempli à la création, lu une fois par le front (`window_boot_profile`).
#[derive(Default)]
pub struct WindowBoot(pub StdMutex<HashMap<String, String>>);

/// Construit une fenêtre secondaire (label `w<n>` alloué ici). Toutes les
/// fenêtres partagent l'identifiant d'onglet natif « charon » : macOS sait
/// les fusionner à la main (Fenêtre > Fusionner toutes les fenêtres).
pub fn open_secondary(
    app: &AppHandle,
    position: Option<(f64, f64)>,
) -> Result<tauri::WebviewWindow, String> {
    let label = format!("w{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Charon")
        .inner_size(1200.0, 800.0);
    if let Some((x, y)) = position {
        builder = builder.position(x, y);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.tabbing_identifier("charon");
    }
    builder
        .build()
        .map_err(|e| format!("Ouverture de la fenêtre impossible : {e}"))
}

/// Ouvre une fenêtre de plus, optionnellement pointée sur un profil.
#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    boot: tauri::State<'_, WindowBoot>,
    profile_id: Option<String>,
) -> Result<String, String> {
    // Un décalage en cascade : une fenêtre qui s'ouvrirait exactement sur la
    // précédente semblerait ne pas s'être ouverte du tout.
    let offset = 28.0 * (WINDOW_COUNTER.load(Ordering::Relaxed) % 6) as f64;
    let win = open_secondary(&app, Some((120.0 + offset, 90.0 + offset)))?;
    let label = win.label().to_string();

    if let Some(profile) = &profile_id {
        boot.0.lock().unwrap().insert(label.clone(), profile.clone());
    }
    Ok(label)
}

/// Le profil sur lequel cette fenêtre doit démarrer, s'il y en a un.
/// Consommé : un reload de la fenêtre ne relancera pas la connexion, le
/// rattachement par sessionStorage prend le relais.
#[tauri::command]
pub fn window_boot_profile(
    boot: tauri::State<'_, WindowBoot>,
    label: String,
) -> Option<String> {
    boot.0.lock().unwrap().remove(&label)
}
