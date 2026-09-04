import { inject } from '@angular/core';
import { openUrl } from '@tauri-apps/plugin-opener';

import { UpdaterService } from '@app/services/system/updater.service';

/** Le dépôt et son auteur, nommés une fois. */
export const GITHUB_USER = 'https://github.com/LucasRaffalli';
export const GITHUB_REPO = 'https://github.com/LucasRaffalli/charon';

/**
 * Le système, en gros : « macOS », « Windows », sans numéro de build.
 *
 * Tiré de la chaîne du navigateur plutôt que d'un plugin Tauri de plus : un
 * rapport de bug a besoin de savoir de quelle plateforme il vient, pas de
 * l'empreinte de la machine. Ce qui est envoyé doit rester le minimum utile.
 */
export function osLabel(): string {
  const ua = navigator.userAgent;
  const mac = /Mac OS X (\d+[._]\d+)/.exec(ua);
  if (mac) {
    return `macOS ${mac[1].replace('_', '.')}`;
  }
  if (ua.includes('Windows NT 10')) {
    return 'Windows 10/11';
  }
  return /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Inconnu';
}

/**
 * Ouvre GitHub sur le formulaire d'issue, version et système déjà remplis.
 *
 * Les formulaires GitHub acceptent des valeurs par l'URL, une clé par
 * identifiant de champ (voir `.github/ISSUE_TEMPLATE/bug.yml`). Rien n'est
 * publié en ouvrant la page : c'est un formulaire, l'utilisateur relit et
 * décide d'envoyer.
 *
 * Ce qui part d'ici se limite au strict nécessaire : **jamais le journal, ni
 * un chemin, ni un nom d'hôte**. Ces choses-là sont dans le panneau Journal,
 * avec son bouton « copier » : les coller reste un geste que l'utilisateur
 * fait sciemment, après avoir lu ce qu'elles contiennent.
 */
export function injectIssueReporter(): (kind?: 'bug' | 'idea') => void {
  const updater = inject(UpdaterService);
  return (kind = 'bug') => {
    const template = kind === 'bug' ? 'bug.yml' : 'idea.yml';
    const params = new URLSearchParams({ template });
    if (kind === 'bug') {
      const version = updater.currentVersion();
      if (version && version !== '…') {
        params.set('version', version);
      }
      params.set('os', osLabel());
    }
    void openUrl(`${GITHUB_REPO}/issues/new?${params.toString()}`).catch(() => undefined);
  };
}
