import { Injectable, inject, signal } from '@angular/core';

import { IconName } from '@app/components/ui/icon/icon';
import { ActivityLogService } from '@app/services/activity-log.service';
import { ConnectionFlowService } from '@app/services/connection-flow.service';
import { DialogService } from '@app/services/dialog.service';
import { DockService } from '@app/services/dock.service';
import { ModuleHostService } from '@app/services/module-host.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';
import { ACCENT_OPTIONS, THEME_OPTIONS, ThemeService } from '@app/services/theme.service';

export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  /** Petite étiquette de catégorie affichée à droite. */
  hint: string;
  /** Termes supplémentaires pour la recherche. */
  keywords?: string;
  run: () => void | Promise<void>;
}

/** Nom d'entrée valide pour un nouveau dossier (même règle que l'explorateur). */
const isValidEntryName = (name: string): boolean =>
  !/[/\\]/.test(name) && name !== '.' && name !== '..';

/**
 * Command palette (Cmd+K) : tout Charon au clavier, connexion aux profils,
 * actions de session, navigation, panneau inférieur, thèmes, réglages.
 */
@Injectable({ providedIn: 'root' })
export class CommandPaletteService {
  private readonly sftp = inject(SftpService);
  private readonly profiles = inject(ProfilesService);
  private readonly flow = inject(ConnectionFlowService);
  private readonly settings = inject(SettingsService);
  private readonly dock = inject(DockService);
  private readonly moduleHost = inject(ModuleHostService);
  private readonly theme = inject(ThemeService);
  private readonly dialog = inject(DialogService);
  private readonly activity = inject(ActivityLogService);

  private readonly _open = signal(false);
  readonly open = this._open.asReadonly();

  toggle(): void {
    this._open.update((open) => !open);
  }

  close(): void {
    this._open.set(false);
  }


  /** Les commandes disponibles dans le contexte actuel (signaux lus dedans). */
  commands(): PaletteCommand[] {
    const connected = this.sftp.connected();
    const list: PaletteCommand[] = [];

    if (!connected) {
      for (const profile of this.profiles.profiles()) {
        list.push({
          id: `connect:${profile.id}`,
          label: `Se connecter à ${profile.name}`,
          icon: 'server',
          hint: profile.environment ?? 'connexion',
          keywords: 'connexion serveur profil',
          run: () => void this.flow.connectProfile(profile),
        });
      }
    } else {
      list.push(
        {
          id: 'refresh',
          label: 'Actualiser le dossier',
          icon: 'refresh',
          hint: 'navigation',
          keywords: 'recharger refresh',
          run: () => void this.sftp.refresh(),
        },
        {
          id: 'up',
          label: 'Dossier parent',
          icon: 'arrow-up',
          hint: 'navigation',
          keywords: 'remonter parent',
          run: () => void this.sftp.navigateUp(),
        },
      );
      if (this.sftp.protection() !== 'readonly') {
        list.push({
          id: 'mkdir',
          label: 'Nouveau dossier sur le serveur…',
          icon: 'folder-plus',
          hint: 'action',
          keywords: 'créer mkdir dossier',
          run: async () => {
            const name = (
              await this.dialog.prompt({
                title: 'Nouveau dossier sur le serveur',
                placeholder: 'nom-du-dossier',
                confirmLabel: 'Créer',
              })
            )?.trim();
            if (name && isValidEntryName(name)) {
              await this.sftp.mkdir(name);
            }
          },
        });
      }
      list.push(
        {
          id: 'panel:terminal',
          label: 'Ouvrir le terminal',
          icon: 'terminal',
          hint: 'panneau',
          keywords: 'shell ssh console',
          run: () => this.dock.openPanel('terminal'),
        },
        {
          id: 'panel:transfers',
          label: 'Voir les transferts',
          icon: 'arrow-down-up',
          hint: 'panneau',
          keywords: 'file téléchargements uploads',
          run: () => this.dock.openPanel('transfers'),
        },
        {
          id: 'panel:journal',
          label: 'Voir le journal',
          icon: 'info',
          hint: 'panneau',
          keywords: 'activité historique audit',
          run: () => this.dock.openPanel('journal'),
        },
        {
          id: 'disconnect',
          label: 'Se déconnecter',
          icon: 'log-out',
          hint: 'session',
          keywords: 'débarquer quitter',
          run: () => void this.sftp.disconnect(),
        },
      );
    }

    for (const option of THEME_OPTIONS) {
      list.push({
        id: `theme:${option.value}`,
        label: `Thème ${option.label}`,
        icon: option.icon,
        hint: 'apparence',
        keywords: 'thème couleur apparence',
        run: () => this.theme.select(option.value),
      });
    }

    // Les accents secrets restent hors de la liste même une fois déverrouillés :
    // on ne les change que depuis les réglages.
    for (const option of ACCENT_OPTIONS) {
      if (option.secret) {
        continue;
      }
      list.push({
        id: `accent:${option.value}`,
        label: `Accent ${option.label}`,
        icon: 'palette',
        hint: 'apparence',
        keywords: 'accent couleur teinte apparence',
        run: () => this.theme.selectAccent(option.value),
      });
    }

    list.push({
      id: 'settings',
      label: 'Ouvrir les réglages',
      icon: 'settings',
      hint: 'app',
      keywords: 'préférences paramètres options',
      run: () => this.settings.openPanel(),
    });

    // Commandes contribuées par les modules actifs.
    list.push(...this.moduleHost.commands());

    return list;
  }

  /** Commande synthétique « aller à » quand la requête est un chemin absolu. */
  gotoCommand(query: string): PaletteCommand | null {
    if (!this.sftp.connected() || !query.startsWith('/')) {
      return null;
    }
    const path = query.trim();
    return {
      id: `goto:${path}`,
      label: `Aller à ${path}`,
      icon: 'folder',
      hint: 'navigation',
      run: async () => {
        if (!(await this.sftp.listDir(path))) {
          this.activity.log('error', 'remote', path, 'chemin introuvable', false);
        }
      },
    };
  }
}
