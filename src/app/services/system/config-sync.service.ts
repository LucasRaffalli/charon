import { Injectable, effect, inject } from '@angular/core';
import { emit, listen } from '@tauri-apps/api/event';

import { AppearanceService } from '@app/services/appearance/appearance.service';
import { CustomThemeService } from '@app/services/appearance/custom-theme.service';
import { DesignService } from '@app/services/appearance/design.service';
import { ThemeService } from '@app/services/appearance/theme.service';
import { SettingsService } from '@app/services/system/settings.service';
import { windowLabel } from '@app/services/system/window-scope';

const EVENT = 'flotte:config-changed';

/** Le temps de laisser l'effet de persistance écrire dans localStorage avant
 *  de dire aux autres fenêtres de relire : l'ordre entre effets d'un même
 *  cycle n'est pas garanti, un envoi immédiat pourrait précéder l'écriture. */
const ANNOUNCE_DELAY_MS = 80;

/**
 * La configuration est une, les fenêtres sont plusieurs.
 *
 * localStorage est partagé entre toutes les webviews Tauri, mais chaque
 * fenêtre ne le lit qu'à son démarrage : changer le thème dans l'une laissait
 * les autres dans l'ancien, jusqu'au prochain lancement (l'événement
 * `storage` du DOM ne traverse pas les webviews WKWebView). Ce service fait
 * le facteur : quand le thème, l'accent, le fond ou les réglages changent
 * ici, il prévient les autres fenêtres, qui relisent le stockage.
 *
 * L'événement ne transporte AUCUNE valeur, seulement « relis » : le stockage
 * partagé est l'unique source de vérité, impossible de diverger. Et pas de
 * boucle possible : appliquer compare avant de poser, des valeurs égales ne
 * notifient personne, l'écho s'éteint de lui-même.
 */
@Injectable({ providedIn: 'root' })
export class ConfigSyncService {
  private readonly theme = inject(ThemeService);
  private readonly appearance = inject(AppearanceService);
  private readonly customTheme = inject(CustomThemeService);
  private readonly settings = inject(SettingsService);
  private readonly design = inject(DesignService);

  private timer = 0;

  constructor() {
    void listen<{ origin: string }>(EVENT, ({ payload }) => {
      if (payload.origin === windowLabel()) {
        return;
      }
      // En plein mode design, la vue porte un brouillon : le laisser écraser
      // par une autre fenêtre en pleine retouche serait pire que d'attendre.
      if (this.design.open()) {
        return;
      }
      this.theme.reloadFromStorage();
      this.appearance.reloadFromStorage();
      this.customTheme.reloadFromStorage();
      this.settings.reloadFromStorage();
    });

    // Premier passage = la restauration du démarrage, rien à annoncer.
    let first = true;
    effect(() => {
      this.theme.theme();
      this.theme.accent();
      this.settings.settings();
      this.appearance.appearance();
      this.customTheme.custom();
      const drafting = this.design.open();
      if (first) {
        first = false;
        return;
      }
      // Un brouillon du mode design ne se diffuse pas ; à la fermeture du
      // mode, l'effet retombe ici et diffuse ce qui a été retenu.
      if (drafting) {
        return;
      }
      this.announce();
    });
  }

  private announce(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      void emit(EVENT, { origin: windowLabel() }).catch(() => undefined);
    }, ANNOUNCE_DELAY_MS);
  }
}
