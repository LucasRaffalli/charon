import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { IconName } from '@app/components/ui/icon/icon';
import { FileEntry } from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { ConnectionFlowService } from '@app/services/connection/connection-flow.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { DockService } from '@app/services/workspace/dock.service';
import { ModuleHostService } from '@app/services/modules/module-host.service';
import { PreviewService } from '@app/services/files/preview.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { SearchService } from '@app/services/connection/search.service';
import { WhatsNewService } from '@app/services/system/whats-new.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { ACCENT_OPTIONS, THEME_OPTIONS, ThemeService } from '@app/services/appearance/theme.service';

/**
 * Où la recherche a lieu. Les résultats sont groupés par catégorie, et choisir
 * une catégorie la fait descendre dans le champ comme filtre : dès lors tout se
 * cherche dedans et rien en dehors.
 */
export type PaletteCategory = 'profils' | 'commandes' | 'chemins' | 'fichiers' | 'filtres';

export const CATEGORY_LABELS: Record<PaletteCategory, string> = {
  profils: 'Profils',
  commandes: 'Commandes',
  chemins: 'Chemins',
  fichiers: 'Fichiers',
  filtres: 'Filtres',
};

/**
 * Un filtre posé dans le champ. Le filtre de **portée** dit où l'on cherche
 * (une seule à la fois), les filtres d'**option** ne font qu'affiner.
 */
export interface PaletteFilter {
  kind: 'scope' | 'option';
  key: string;
  label: string;
}

/** Les options proposées par la catégorie Filtres. */
export const FILTER_OPTIONS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'regex', label: 'regex', hint: 'le motif est une expression régulière' },
  { key: 'casse', label: 'casse', hint: 'respecter les majuscules' },
  { key: 'dossiers', label: 'dossiers', hint: 'ignorer les fichiers' },
];

/**
 * Six cases au maximum. Au-delà la saisie devient trop étroite pour rester
 * lisible ; le septième est refusé plutôt que d'en retirer un dans le dos de
 * l'utilisateur.
 */
export const MAX_FILTERS = 6;

export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  /** Petite étiquette affichée à droite. */
  hint: string;
  /** Termes supplémentaires pour la recherche. */
  keywords?: string;
  category: PaletteCategory;
  /** Contexte affiché en gris à la suite du libellé (chemin, ligne…). */
  detail?: string;
  /**
   * Garde la palette ouverte après l'action. Vrai pour ce qui se poursuit :
   * entrer dans un dossier, poser un filtre. Sans ça, descendre de trois
   * dossiers demande de rouvrir la palette trois fois.
   */
  keepOpen?: boolean;
  run: () => void | Promise<void>;
  /**
   * Le geste d'engagement, sur Entrée, quand il diffère du clic. Le clic
   * explore sans conséquence, Entrée emmène l'application. Deux intentions
   * distinctes méritent deux gestes plutôt qu'une option cachée quelque part.
   */
  commit?: () => void | Promise<void>;
  /** Ce que fait Entrée, dit en un mot sur la ligne courante. */
  commitHint?: string;
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
  private readonly searchService = inject(SearchService);
  private readonly whatsNew = inject(WhatsNewService);
  private readonly flow = inject(ConnectionFlowService);
  private readonly settings = inject(SettingsService);
  private readonly dock = inject(DockService);
  private readonly moduleHost = inject(ModuleHostService);
  private readonly preview = inject(PreviewService);
  private readonly theme = inject(ThemeService);
  private readonly dialog = inject(DialogService);
  private readonly activity = inject(ActivityLogService);

  private readonly _open = signal(false);
  readonly open = this._open.asReadonly();

  private readonly _filters = signal<PaletteFilter[]>([]);
  readonly filters = this._filters.asReadonly();

  /** Vrai le temps de signaler qu'un septième filtre a été refusé. */
  private readonly _refused = signal(false);
  readonly refused = this._refused.asReadonly();

  /** La portée courante, s'il y en a une : tout se cherche dedans. */
  readonly scope = computed(
    () => (this._filters().find((f) => f.kind === 'scope')?.key ?? null) as PaletteCategory | null,
  );

  readonly hasOption = (key: string): boolean =>
    this._filters().some((f) => f.kind === 'option' && f.key === key);

  /**
   * La palette est un outil de session : hors connexion il n'y a ni dossier où
   * chercher, ni commande à lancer, et l'écran de connexion a son propre
   * vocabulaire. Le composant n'est même pas monté là-bas (c'est lui qui porte
   * le raccourci) ; cette garde couvre tout autre chemin d'ouverture.
   */
  private get available(): boolean {
    return this.sftp.settled();
  }

  constructor() {
    effect(() => {
      if (!this.available) {
        this._open.set(false);
      }
    });
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (!this._open()) {
    }
    this._open.update((open) => !open);
  }

  /**
   * Fermer ne jette pas la recherche : on rouvre souvent pour reprendre là où
   * on en était. Le champ est sélectionné à l'ouverture, donc taper l'écrase
   * comme si de rien n'était.
   */
  close(): void {
    this._open.set(false);
    this._refused.set(false);
    // Le point de navigation, lui, ne survit pas : l'explorateur a pu bouger
    // entre-temps, et rouvrir sur un dossier périmé serait déroutant.
    this.resetBrowse();
  }

  /**
   * Ouvre la palette sur le contenu d'un dossier.
   *
   * Le point de navigation de la palette sert exactement à ça : regarder
   * ailleurs sans déplacer l'explorateur. La saisie et les filtres repartent à
   * zéro, parce qu'on vient de désigner un dossier à la souris et qu'une
   * recherche précédente n'a plus rien à voir avec ce geste.
   */
  async searchIn(path: string | null): Promise<void> {
    if (!this.available) {
      return;
    }
    this._query.set('');
    this._filters.set([]);
    this._refused.set(false);
    if (path && path !== this.sftp.currentPath()) {
      await this.browseInto(path);
    } else {
      this.resetBrowse();
    }
    this.restrictTo('fichiers');
    this._open.set(true);
  }

  /** Repartir de zéro, quand on le demande vraiment. */
  reset(): void {
    this._query.set('');
    this._filters.set([]);
    this._refused.set(false);
  }

  // --- Là où la palette regarde ------------------------------------------
  // Regarder dans un dossier et y emmener l'application sont deux gestes
  // différents. La palette a donc son propre point de navigation : on descend
  // dedans pour voir, l'explorateur ne bouge que si on le demande.

  private readonly _browsePath = signal<string | null>(null);
  private readonly _browseEntries = signal<FileEntry[]>([]);

  /** Le dossier regardé : celui de l'explorateur tant qu'on n'a pas bougé. */
  readonly browsePath = computed(() => this._browsePath() ?? this.sftp.currentPath());

  /** Vrai quand la palette regarde ailleurs que l'explorateur. */
  readonly browsingElsewhere = computed(() => this._browsePath() !== null);

  private readonly _browseEntriesOrCurrent = computed(() =>
    this._browsePath() === null ? this.sftp.entries() : this._browseEntries(),
  );

  /** Descend dans un dossier, sans toucher à l'explorateur. */
  async browseInto(path: string): Promise<void> {
    const entries = await this.sftp.peekDir(path);
    this._browseEntries.set(entries);
    this._browsePath.set(path);
  }

  /** Revient sur le dossier de l'explorateur. */
  resetBrowse(): void {
    this._browsePath.set(null);
    this._browseEntries.set([]);
  }

  /** La saisie, gardée ici pour survivre à la fermeture du composant. */
  private readonly _query = signal('');
  readonly query = this._query.asReadonly();

  setQuery(value: string): void {
    this._query.set(value);
  }

  /** Ajoute un filtre, ou le refuse si le plafond est atteint. */
  addFilter(filter: PaletteFilter): void {
    const current = this._filters();
    if (current.some((f) => f.key === filter.key)) {
      return;
    }
    if (current.length >= MAX_FILTERS) {
      this._refused.set(true);
      return;
    }
    // La portée reste en tête : c'est elle qui décide où l'on cherche.
    this._filters.set(
      filter.kind === 'scope' ? [filter, ...current.filter((f) => f.kind !== 'scope')] : [...current, filter],
    );
    this._refused.set(false);
  }

  /** Retour arrière sur une saisie vide : le dernier filtre s'en va. */
  removeLastFilter(): void {
    this._filters.update((list) => list.slice(0, -1));
    this._refused.set(false);
  }

  removeFilter(key: string): void {
    this._filters.update((list) => list.filter((f) => f.key !== key));
    this._refused.set(false);
  }

  /**
   * Ce qu'affiche le chip d'un filtre.
   *
   * La portée « fichiers » dit *lesquels* : « fichiers » tout court laisse
   * chercher dans un dossier sans savoir lequel, alors que c'est justement ce
   * que le filtre vient de décider. Le libellé est dérivé et non figé à la
   * pose, pour suivre la navigation de la palette : descendre d'un dossier
   * change le lieu, donc doit changer le chip.
   */
  labelOf(filter: PaletteFilter): string {
    if (filter.kind !== 'scope' || filter.key !== 'fichiers') {
      return filter.label;
    }
    const name = this.browsePath().split('/').filter(Boolean).pop();
    return name ? `${name}/` : '/';
  }

  /** Fait descendre une catégorie dans le champ : on ne cherche plus qu'elle. */
  restrictTo(category: PaletteCategory): void {
    this.addFilter({ kind: 'scope', key: category, label: CATEGORY_LABELS[category].toLowerCase() });
  }


  /** Les commandes disponibles dans le contexte actuel (signaux lus dedans). */
  commands(): PaletteCommand[] {
    const connected = this.sftp.connected();
    const list: PaletteCommand[] = [];

    if (!connected) {
      for (const profile of this.profiles.profiles()) {
        list.push({
          id: `connect:${profile.id}`,
          category: 'profils',
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
          category: 'commandes',
          label: 'Actualiser le dossier',
          icon: 'refresh',
          hint: 'navigation',
          keywords: 'recharger refresh',
          run: () => void this.sftp.refresh(),
        },
        {
          id: 'up',
          category: 'commandes',
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
          category: 'commandes',
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
      // L'ancre de connexion : le dossier où ce profil dépose l'explorateur.
      // Elle n'a de sens qu'attachée à un profil, une connexion de passage
      // n'ayant rien où l'écrire.
      const profileId = this.sftp.profileId();
      if (profileId) {
        const anchor = this.profiles.anchorOf(profileId);
        const here = this.sftp.currentPath();
        if (anchor !== here) {
          list.push({
            id: 'anchor:set',
            category: 'commandes',
            label: 'Ancrer ce dossier pour la connexion',
            icon: 'anchor',
            hint: 'profil',
            detail: here,
            keywords: 'ancre arrivée départ démarrage point de chute dossier par défaut',
            run: () => void this.profiles.setAnchor(profileId, here),
          });
        }
        if (anchor) {
          list.push({
            id: 'anchor:clear',
            category: 'commandes',
            label: "Retirer l'ancre de connexion",
            icon: 'anchor',
            hint: 'profil',
            detail: anchor,
            keywords: 'ancre arrivée départ démarrage enlever supprimer',
            run: () => void this.profiles.setAnchor(profileId, null),
          });
        }
      }

      list.push({
        id: 'search:server',
        category: 'commandes',
        label: 'Rechercher sur le serveur…',
        icon: 'search',
        hint: 'panneau',
        keywords: 'recherche récursive contenu grep find profondeur',
        run: () => {
          // La saisie de la palette devient celle de la recherche : on tape,
          // puis on choisit où chercher, sans retaper.
          this.searchService.seed(this.query().trim());
          this.dock.openPanel('search');
        },
      });

      list.push(
        {
          id: 'panel:terminal',
          category: 'commandes',
          label: 'Ouvrir le terminal',
          icon: 'terminal',
          hint: 'panneau',
          keywords: 'shell ssh console',
          run: () => this.dock.openPanel('terminal'),
        },
        {
          id: 'panel:transfers',
          category: 'commandes',
          label: 'Voir les transferts',
          icon: 'arrow-down-up',
          hint: 'panneau',
          keywords: 'file téléchargements uploads',
          run: () => this.dock.openPanel('transfers'),
        },
        {
          id: 'panel:journal',
          category: 'commandes',
          label: 'Voir le journal',
          icon: 'info',
          hint: 'panneau',
          keywords: 'activité historique audit',
          run: () => this.dock.openPanel('journal'),
        },
        {
          id: 'disconnect',
          category: 'commandes',
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
        category: 'commandes',
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
        category: 'commandes',
        label: `Accent ${option.label}`,
        icon: 'palette',
        hint: 'apparence',
        keywords: 'accent couleur teinte apparence',
        run: () => this.theme.selectAccent(option.value),
      });
    }

    list.push({
      id: 'whats-new',
      category: 'commandes',
      label: 'Nouveautés de cette version',
      icon: 'info',
      hint: 'application',
      keywords: 'changelog journal versions quoi de neuf historique',
      run: () => this.whatsNew.show(),
    });

    list.push({
      id: 'settings',
      category: 'commandes',
      label: 'Ouvrir les réglages',
      icon: 'settings',
      hint: 'app',
      keywords: 'préférences paramètres options',
      run: () => this.settings.openPanel(),
    });

    // Le dossier serveur affiché : ses entrées sont cherchables telles quelles,
    // sans le moindre aller-retour réseau.
    if (connected) {
      const path = this.browsePath();
      const foldersOnly = this.hasOption('dossiers');
      const child = (name: string) => (path === '/' ? `/${name}` : `${path}/${name}`);

      // Remonter, quand on est descendu depuis l'explorateur.
      if (this.browsingElsewhere()) {
        const parent = path.replace(/\/[^/]*$/, '') || '/';
        list.push({
          id: 'browse:up',
          category: 'fichiers',
          label: '..',
          detail: parent,
          icon: 'corner-up',
          hint: 'remonter',
          keepOpen: true,
          run: () => void (parent === this.sftp.currentPath() ? this.resetBrowse() : this.browseInto(parent)),
        });
      }

      for (const entry of this._browseEntriesOrCurrent()) {
        if (foldersOnly && !entry.isDir) {
          continue;
        }
        list.push({
          id: `file:${entry.name}`,
          category: 'fichiers',
          label: entry.name,
          detail: path,
          icon: entry.isDir ? 'folder' : 'file',
          // Le libellé dit ce qui va se passer, pas ce que la chose est :
          // l'icône se charge déjà de dire que c'est un dossier.
          hint: entry.isDir ? 'ouvrir' : 'aperçu',
          keepOpen: entry.isDir,
          // Sur un dossier, Entrée y emmène l'explorateur pour de bon.
          commit: entry.isDir ? () => void this.sftp.listDir(child(entry.name)) : undefined,
          commitHint: entry.isDir ? 'y aller' : undefined,
          run: () => {
            if (entry.isDir) {
              // On regarde dedans. L'explorateur reste où il est.
              void this.browseInto(child(entry.name));
            } else {
              this.dock.focusPanel('preview');
              void this.preview.openFile(child(entry.name), entry.name);
            }
          },
        });
      }
    }

    // Y aller pour de bon, quand c'est ce qu'on veut : le geste est explicite
    // et se voit dans la liste, il n'est pas caché derrière un clic ordinaire.
    if (connected && this.browsingElsewhere()) {
      const target = this.browsePath();
      list.push({
        id: 'browse:goto',
        category: 'commandes',
        label: 'Afficher ce dossier dans l\'explorateur',
        detail: target,
        icon: 'folder',
        hint: 'navigation',
        keywords: 'aller naviguer ouvrir dossier',
        run: () => void this.sftp.listDir(target),
      });
    }

    // Les options, exposées comme le reste : personne n'est obligé de connaître
    // les préfixes pour s'en servir.
    for (const option of FILTER_OPTIONS) {
      if (this.hasOption(option.key)) {
        continue;
      }
      list.push({
        id: `filter:${option.key}`,
        category: 'filtres',
        label: option.label,
        detail: option.hint,
        icon: 'logs',
        hint: 'poser',
        keepOpen: true,
        run: () => this.addFilter({ kind: 'option', key: option.key, label: option.label }),
      });
    }

    // Commandes contribuées par les modules actifs.
    list.push(...this.moduleHost.commands());

    return list;
  }

  /**
   * L'ordre des groupes suit le contexte : ce qui est sous la main d'abord.
   * Connecté, le dossier affiché passe devant tout le reste ; déconnecté, il
   * n'y a rien d'autre que les profils et les commandes.
   */
  categoryOrder(): readonly PaletteCategory[] {
    return this.sftp.connected()
      ? (['fichiers', 'chemins', 'commandes', 'profils', 'filtres'] as const)
      : (['profils', 'commandes', 'filtres'] as const);
  }

  /** Commande synthétique « aller à » quand la requête est un chemin absolu. */
  gotoCommand(query: string): PaletteCommand | null {
    if (!this.sftp.connected() || !query.startsWith('/')) {
      return null;
    }
    const path = query.trim();
    return {
      id: `goto:${path}`,
      category: 'chemins',
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
