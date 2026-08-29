import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Le label de la fenêtre courante. `main` est la fenêtre principale, celle de
 * la configuration Tauri ; les fenêtres ouvertes ensuite portent le label que
 * `window_open` leur donnera.
 */
export function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    // Hors Tauri (tests, build ssr) : il n'y a qu'une fenêtre.
    return 'main';
  }
}

/**
 * Une clé de stockage propre à CETTE fenêtre.
 *
 * `localStorage` est partagé entre toutes les webviews d'une app Tauri : sans
 * scoping, deux fenêtres écriraient la même disposition de dock ou la même
 * liste de transferts et s'écraseraient mutuellement à chaque frappe.
 *
 * La fenêtre principale garde la clé nue : c'est la compatibilité avec tout ce
 * qui a été enregistré avant le multi-fenêtres, et le cas à une seule fenêtre
 * reste strictement identique à avant.
 */
export function scopedKey(base: string): string {
  const label = windowLabel();
  return label === 'main' ? base : `${base}::${label}`;
}
