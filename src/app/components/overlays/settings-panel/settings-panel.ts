import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { ShortcutsList } from '@app/components/panels/shortcuts-list/shortcuts-list';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { SegmentedControl } from '@app/components/ui/segmented-control/segmented-control';
import { TextField } from '@app/components/ui/text-field/text-field';
import { Toggle } from '@app/components/ui/toggle/toggle';
import { openUrl } from '@tauri-apps/plugin-opener';

import changelogData from '../../../../assets/changelog.json';

import { ChangeKind, ChangelogEntry } from '@app/interfaces';
import { ConfigExportService } from '@app/services/system/config-export.service';
import { formatReleaseDate } from '@app/services/system/date-format';
import { DesignService } from '@app/services/appearance/design.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { DockService } from '@app/services/workspace/dock.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { GITHUB_REPO, GITHUB_USER, injectIssueReporter, osLabel } from '@app/services/system/links';
import { I18nService, Lang, injectT } from '@app/lang/i18n.service';
import { ModulesService } from '@app/services/modules/modules.service';
import { SettingsService } from '@app/services/system/settings.service';
import { THEME_OPTIONS, ThemeService } from '@app/services/appearance/theme.service';
import { UpdaterService } from '@app/services/system/updater.service';

/** Titre d'un groupe, au pluriel : c'est un compte qu'on annonce. */
const GROUP_LABELS: Record<ChangeKind, [string, string]> = {
  new: ['nouveauté', 'nouveautés'],
  better: ['amélioration', 'améliorations'],
  fixed: ['correctif', 'correctifs'],
};

/** L'ordre de lecture : ce qui est nouveau d'abord, ce qui est réparé ensuite. */
const KIND_ORDER: ChangeKind[] = ['new', 'better', 'fixed'];

type SettingsTab =
  | 'design'
  | 'files'
  | 'connection'
  | 'shortcuts'
  | 'data'
  | 'modules'
  | 'updates'
  | 'about';

interface TabOption {
  id: SettingsTab;
  icon: IconName;
  label: string;
}

@Component({
  selector: 'app-settings-panel',
  imports: [Button, Icon, SegmentedControl, ShortcutsList, TextField, Toggle],
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.scss',
  host: {
    '(document:keydown.escape)': 'close()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPanel {
  protected readonly settings = inject(SettingsService);
  protected readonly themeService = inject(ThemeService);
  protected readonly updater = inject(UpdaterService);
  protected readonly dock = inject(DockService);
  protected readonly modules = inject(ModulesService);
  protected readonly exporter = inject(ConfigExportService);
  private readonly dialog = inject(DialogService);
  private readonly design = inject(DesignService);
  private readonly localFs = inject(LocalFsService);

  protected readonly activeTab = signal<SettingsTab>('files');

  /** Changelog curaté (src/assets/changelog.json), rédigé à chaque feature. */
  // Le JSON importé donne `kind: string` : le cast dit ce que le fichier
  // contient vraiment. Il est dans le dépôt, donc vérifié à la relecture, et le
  // CSS a de toute façon une puce de repli si une nature inconnue s'y glissait.
  protected readonly changelog = changelogData as ChangelogEntry[];
  protected readonly formatDate = formatReleaseDate;

  /**
   * Le journal, prêt à afficher : une ligne par version, avec la répartition
   * par nature et les notes déjà groupées. Tout est calculé ici plutôt que
   * dans le gabarit, qui ne doit pas refaire ces boucles à chaque cycle.
   */
  protected readonly versions = computed(() => {
    const installed = this.updater.currentVersion();
    return this.changelog.map((entry) => {
      const groups = KIND_ORDER.map((kind) => {
        const notes = entry.notes.filter((note) => note.kind === kind);
        const [one, many] = GROUP_LABELS[kind];
        return { kind, title: `${notes.length} ${notes.length > 1 ? many : one}`, notes };
      }).filter((group) => group.notes.length > 0);
      return {
        version: entry.version,
        title: entry.title,
        date: entry.date,
        cover: entry.cover,
        installed: entry.version === installed,
        total: entry.notes.length,
        parts: groups.map((group) => ({ kind: group.kind, count: group.notes.length })),
        groups,
      };
    });
  });

  /**
   * Les versions dépliées. Plusieurs à la fois : comparer deux versions est un
   * usage courant, et un accordéon qui referme la précédente l'interdirait.
   */
  private readonly openVersions = signal<ReadonlySet<string>>(new Set());

  protected isVersionOpen(version: string): boolean {
    return this.openVersions().has(version);
  }

  protected toggleVersion(version: string): void {
    this.openVersions.update((current) => {
      const next = new Set(current);
      if (!next.delete(version)) {
        next.add(version);
      }
      return next;
    });
  }

  protected readonly tabs: readonly TabOption[] = [
    { id: 'design', icon: 'palette', label: 'Design' },
    { id: 'files', icon: 'folder', label: 'Fichiers' },
    { id: 'connection', icon: 'server', label: 'Connexion' },
    { id: 'shortcuts', icon: 'command', label: 'Raccourcis' },
    { id: 'data', icon: 'file', label: 'Données' },
    { id: 'modules', icon: 'layout-grid', label: 'Modules' },
    { id: 'updates', icon: 'refresh', label: 'Mises à jour' },
    { id: 'about', icon: 'info', label: 'À propos' },
  ];

  // Le dépôt, son auteur, et le formulaire d'issue pré-rempli.
  protected readonly repoUrl = GITHUB_REPO;
  protected readonly userUrl = GITHUB_USER;
  protected readonly os = osLabel();
  protected readonly reportIssue = injectIssueReporter();

  // La langue de l'interface. Elle vit dans les réglages, donc elle est
  // persistée, exportée et synchronisée entre fenêtres comme le reste.
  private readonly i18n = inject(I18nService);
  protected readonly t = injectT();
  protected readonly langOptions = [
    { value: 'fr', label: 'Français' },
    { value: 'en', label: 'English' },
  ];
  protected setLang(value: string): void {
    void this.i18n.use(value as Lang);
  }
  protected openLink(url: string): void {
    void openUrl(url).catch(() => undefined);
  }

  /** Titre de la section affichée (en-tête du contenu). */
  protected readonly activeLabel = computed(() => this.tabs.find((tab) => tab.id === this.activeTab())?.label ?? '');

  /**
   * Le dossier d'ouverture du panneau local a disparu. Un réglage qui ne fait
   * rien sans le dire est un piège : au démarrage on retombe silencieusement
   * sur le dossier personnel, donc c'est ICI qu'il faut l'annoncer.
   */
  protected readonly localHomeMissing = signal(false);

  constructor() {
    // (Re)scanne les modules à l'ouverture de leur onglet.
    effect(() => {
      if (this.settings.panelOpen() && this.activeTab() === 'modules') {
        void this.modules.refresh();
      }
    });

    // Le dossier ancré est vérifié à l'ouverture de l'onglet, pas seulement
    // quand on touche au champ : il a pu disparaître entre-temps.
    effect(() => {
      if (this.settings.panelOpen() && this.activeTab() === 'files') {
        void this.checkLocalHome(this.settings.localHome());
      }
    });
  }

  protected setLocalHome(value: string): void {
    const path = value.trim();
    this.settings.update({ localHome: path });
    void this.checkLocalHome(path);
  }

  private async checkLocalHome(path: string): Promise<void> {
    if (!path.trim()) {
      this.localHomeMissing.set(false);
      return;
    }
    const info = await this.localFs.stat(path.trim());
    // Le champ a pu changer pendant l'aller-retour : on ne pose le verdict que
    // s'il porte encore sur ce qui est affiché.
    if (this.settings.localHome().trim() === path.trim()) {
      this.localHomeMissing.set(!info?.exists || !info.isDir);
    }
  }

  protected async toggleModule(slug: string, enabled: boolean): Promise<void> {
    await this.modules.setEnabled(slug, enabled);
  }

  /** Supprime un module après confirmation renforcée (nom exact à retaper). */
  protected async deleteModule(slug: string, name: string): Promise<void> {
    const typed = (
      await this.dialog.prompt({
        title: this.t('misc.moduleDelete.title', { name }),
        message: this.t('misc.moduleDelete.message', { name }),
        placeholder: name,
        confirmLabel: 'Supprimer',
        danger: true,
      })
    )?.trim();
    if (typed === name) {
      await this.modules.delete(slug);
    }
  }

  protected readonly themeOptions = THEME_OPTIONS;

  /** Les accents listés. Un secret n'apparaît que tant qu'il est sélectionné. */
  protected readonly accentOptions = this.themeService.visibleAccents;

  /** Une opération de mise à jour est en cours : relancer n'aurait pas de sens. */
  protected readonly updateBusy = computed(() => {
    const kind = this.updater.status().kind;
    return kind === 'checking' || kind === 'downloading' || kind === 'ready';
  });

  /** Pourcentage du téléchargement de mise à jour (0 si taille inconnue). */
  protected downloadPercent(transferred: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  }

  /** Minutes d'inactivité avant fermeture, bornées à [0 ; 240] (0 = jamais). */
  /** Bornes du champ : le service borne aussi à la relecture du stockage. */
  protected setTrashDays(value: string): void {
    const days = Number.parseInt(value, 10);
    this.settings.update({ trashDays: Number.isFinite(days) ? Math.min(365, Math.max(0, days)) : 0 });
  }

  protected setIdleMinutes(raw: string): void {
    const minutes = Math.max(0, Math.min(240, Math.round(Number(raw)) || 0));
    this.settings.update({ idleMinutes: minutes });
  }

  /**
   * « Design » ne remplit pas la modale : il la referme et rend l'application
   * visible, pour qu'on règle en voyant le résultat sur la vraie interface.
   */
  protected selectTab(id: SettingsTab): void {
    if (id === 'design') {
      this.settings.closePanel();
      this.design.start();
      return;
    }
    this.activeTab.set(id);
  }

  protected close(): void {
    this.settings.closePanel();
  }
}
