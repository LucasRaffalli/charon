import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { injectTauriListen } from '@app/services/system/scoped-listen';

import { FileEntry, StatInfo } from '@app/interfaces';
import { SftpService } from '@app/services/connection/sftp.service';
import { lineDiff } from '@app/services/files/diff';
import { OverwriteService, PASTE_SIDES } from '@app/services/files/overwrite.service';
import { TransfersService } from '@app/services/files/transfers.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { windowLabel } from '@app/services/system/window-scope';

/** Au-delà, on ne compare pas : lire deux fichiers entiers pour un diff que
 *  personne ne lira coûterait deux transferts. */
const DIFF_MAX_BYTES = 256 * 1024;

/** Ce que le conflit a décidé, et sous quel nom le cas échéant. */
interface ConflictVerdict {
  action: 'go' | 'skip' | 'overwrite-all' | 'skip-all';
  /** Nom de rechange, quand on garde les deux. */
  as?: string;
}

/** Ce qu'on fera au collage : dupliquer, ou déplacer. */
export type ClipboardMode = 'copy' | 'cut';

/** Un lot déposé par glissé depuis une autre fenêtre. */
export interface ForeignDrop {
  connectionId: string;
  host: string;
  fromDir: string;
  /** ⌥ pendant le dépôt : copier au lieu de déplacer. */
  copy: boolean;
  entries: { name: string; isDir: boolean }[];
}

/** Le presse-papiers tel que le backend le tient, commun à toutes les fenêtres. */
interface Clipped {
  mode: ClipboardMode;
  /** La session d'origine : c'est elle qui décide, au collage, entre la copie
   *  locale au serveur et le pont. */
  connectionId: string;
  /** L'hôte d'origine, pour les libellés (« vps-prod → backup »). */
  host: string;
  fromDir: string;
  entries: { name: string; isDir: boolean }[];
}

/**
 * Le presse-papiers de l'explorateur serveur : copier, couper, coller.
 *
 * Les deux opérations se font **sur le serveur**, sans traverser le réseau :
 * un `cp -a` sur le canal exec pour la copie (idée 03), un `rename` SFTP pour
 * le déplacement : un `mv` ne bouge que des métadonnées quand la source et la
 * cible sont sur le même système de fichiers.
 *
 * C'est un presse-papiers d'application, distinct de celui du système : y
 * mettre des chemins distants n'aurait aucun sens ailleurs, et on ne veut pas
 * écraser ce que l'utilisateur y a mis.
 */
@Injectable({ providedIn: 'root' })
export class FileClipboardService {
  private readonly tauriListen = injectTauriListen();
  private readonly sftp = inject(SftpService);
  private readonly toasts = inject(ToastService);
  private readonly activity = injectSessionActivity();
  private readonly overwrite = inject(OverwriteService);
  private readonly dialog = inject(DialogService);
  private readonly transfers = inject(TransfersService);

  private readonly _clipped = signal<Clipped | null>(null);
  readonly clipped = this._clipped.asReadonly();

  constructor() {
    // Le presse-papiers vit dans le backend : copier dans la fenêtre A doit
    // se voir dans la fenêtre B. Chaque fenêtre en tient un miroir, rafraîchi
    // par l'événement.
    void this.refresh();
    this.tauriListen('clipboard:changed', () => void this.refresh());
  }

  private async refresh(): Promise<void> {
    const clip = await invoke<Clipped | null>('clip_get').catch(() => null);
    this._clipped.set(clip);
  }

  readonly hasContent = computed(() => this._clipped() !== null);
  readonly count = computed(() => this._clipped()?.entries.length ?? 0);
  readonly mode = computed(() => this._clipped()?.mode ?? null);

  /** Les noms coupés, pour les afficher en attente dans la liste d'origine :
   *  la bonne session ET le bon dossier. */
  readonly cutNames = computed<ReadonlySet<string>>(() => {
    const clipped = this._clipped();
    if (
      !clipped ||
      clipped.mode !== 'cut' ||
      clipped.connectionId !== this.sftp.connectionId() ||
      clipped.fromDir !== this.sftp.currentPath()
    ) {
      return new Set();
    }
    return new Set(clipped.entries.map((entry) => entry.name));
  });

  copy(entries: FileEntry[]): void {
    this.put('copy', entries);
  }

  cut(entries: FileEntry[]): void {
    this.put('cut', entries);
  }

  clear(): void {
    this._clipped.set(null);
    void invoke('clip_clear').catch(() => undefined);
  }

  private put(mode: ClipboardMode, entries: FileEntry[]): void {
    const connectionId = this.sftp.connectionId();
    if (!entries.length || !connectionId) {
      return;
    }
    const clip: Clipped = {
      mode,
      connectionId,
      host: this.sftp.host(),
      fromDir: this.sftp.currentPath(),
      entries: entries.map((entry) => ({ name: entry.name, isDir: entry.isDir })),
    };
    this._clipped.set(clip);
    void invoke('clip_set', { clip }).catch(() => undefined);
    const what = entries.length === 1 ? entries[0].name : `${entries.length} éléments`;
    this.toasts.success(mode === 'copy' ? `${what} à copier` : `${what} à déplacer`, {
      detail: 'Coller dans le dossier de destination',
      key: 'clipboard',
    });
  }

  /**
   * Colle dans le dossier courant. Rend le nombre d'éléments traités.
   *
   * Un collage dans le dossier d'origine est refusé plutôt que de fabriquer
   * des « copie de copie » : c'est presque toujours un collage par mégarde.
   */
  async pasteHere(): Promise<number> {
    const clipped = this._clipped();
    if (!clipped) {
      return 0;
    }
    return this.pasteInto(clipped, this.sftp.currentPath(), true);
  }

  /**
   * Le dépôt venu d'une autre fenêtre : même machinerie que le collage, sans
   * passer par le presse-papiers : un glissé ne doit ni l'écraser ni le vider.
   */
  async receiveDrop(payload: ForeignDrop, targetDir: string): Promise<number> {
    return this.pasteInto(
      {
        mode: payload.copy ? 'copy' : 'cut',
        connectionId: payload.connectionId,
        host: payload.host,
        fromDir: payload.fromDir,
        entries: payload.entries,
      },
      targetDir,
      false,
    );
  }

  /** `a` et `b` désignent-ils le même serveur ? La partie avant `#` est la
   *  clé stable du serveur, le nonce ne distingue que les sessions. */
  private sameServer(a: string, b: string | null): boolean {
    return !!b && a.split('#')[0] === b.split('#')[0];
  }

  private joinDir(dir: string, name: string): string {
    return dir === '/' ? `/${name}` : `${dir}/${name}`;
  }

  /**
   * Route un lot vers sa destination. Même serveur (la même session ou une
   * autre fenêtre posée dessus) : cp/mv local au serveur, un seul système de
   * fichiers, aucun octet ne traverse le réseau. Serveur différent : le pont,
   * fichier par fichier.
   */
  private async pasteInto(
    clipped: Clipped,
    targetDir: string,
    fromClipboard: boolean,
  ): Promise<number> {
    const sameServer = this.sameServer(clipped.connectionId, this.sftp.connectionId());
    if (sameServer && clipped.fromDir === targetDir) {
      this.toasts.error(
        clipped.mode === 'cut'
          ? 'Ces éléments sont déjà dans ce dossier.'
          : 'Copier dans le dossier d’origine créerait un doublon du même nom.',
      );
      return 0;
    }
    const done = sameServer
      ? await this.pasteLocal(clipped, targetDir, fromClipboard)
      : await this.pasteBridge(clipped, targetDir, fromClipboard);

    // Les autres fenêtres posées sur les dossiers touchés doivent le voir :
    // celle d'où viennent des éléments coupés, celles qui montrent l'arrivée.
    if (done) {
      this.announceDirChanged(this.sftp.connectionId(), targetDir);
      if (clipped.mode === 'cut') {
        this.announceDirChanged(clipped.connectionId, clipped.fromDir);
      }
    }
    return done;
  }

  /** Prévient les autres fenêtres qu'un dossier de ce serveur a changé. */
  private announceDirChanged(connectionId: string | null, dir: string): void {
    if (!connectionId) {
      return;
    }
    void emit('flotte:dir-changed', {
      server: connectionId.split('#')[0],
      dir,
      origin: windowLabel(),
    }).catch(() => undefined);
  }

  /** Copie ou déplacement local au serveur, sur la connexion de CETTE
   *  fenêtre : même venu d'une autre session, le chemin source est sur le
   *  même système de fichiers. Les dossiers passent (cp -aT, rename). */
  private async pasteLocal(
    clipped: Clipped,
    targetDir: string,
    fromClipboard: boolean,
  ): Promise<number> {
    let done = 0;
    let failed = 0;
    let skipped = 0;
    // La décision « tout écraser » ou « tout ignorer » vaut pour le reste du
    // lot : dix fichiers en conflit ne doivent pas poser dix fois la question.
    let blanket: 'overwrite-all' | 'skip-all' | null = null;

    for (const entry of clipped.entries) {
      const from = this.joinDir(clipped.fromDir, entry.name);
      const to = this.joinDir(targetDir, entry.name);

      const verdict = await this.resolveConflict(
        from,
        to,
        entry,
        clipped.entries.length > 1,
        blanket,
        targetDir,
      );
      if (verdict.action === 'overwrite-all' || verdict.action === 'skip-all') {
        blanket = verdict.action;
      }
      if (verdict.action === 'skip' || verdict.action === 'skip-all') {
        skipped++;
        continue;
      }
      // « Garder les deux » : la destination change, la source ne bouge pas.
      const destination = verdict.as ? this.joinDir(targetDir, verdict.as) : to;

      try {
        if (clipped.mode === 'copy') {
          await invoke('sftp_copy', {
            connectionId: this.sftp.connectionId(),
            from,
            to: destination,
          });
          this.activity.log('upload', 'remote', destination, `copié depuis ${from}`);
        } else {
          await this.sftp.moveTo(from, destination);
          this.activity.log('rename', 'remote', from, `déplacé vers ${destination}`);
        }
        done++;
      } catch (error) {
        failed++;
        this.activity.log(
          clipped.mode === 'copy' ? 'upload' : 'rename',
          'remote',
          from,
          String(error),
          false,
        );
      }
    }

    // Un déplacement vide le presse-papiers, une copie le garde : coller la
    // même chose dans trois dossiers est un usage courant, déplacer deux fois
    // les mêmes éléments n'a pas de sens.
    if (clipped.mode === 'cut' && fromClipboard) {
      this.clear();
    }

    await this.sftp.refresh();

    if (failed) {
      this.toasts.error(
        `${failed} élément${failed > 1 ? 's' : ''} sur ${clipped.entries.length} n’${failed > 1 ? 'ont' : 'a'} pas pu être traité${failed > 1 ? 's' : ''}`,
        { detail: 'Voir le journal pour le détail' },
      );
    } else if (skipped && !done) {
      this.toasts.info(`${skipped} élément${skipped > 1 ? 's' : ''} ignoré${skipped > 1 ? 's' : ''}`, {
        detail: 'Rien n’a été écrasé',
      });
    } else if (done) {
      this.toasts.success(
        clipped.mode === 'copy'
          ? `${done} élément${done > 1 ? 's' : ''} copié${done > 1 ? 's' : ''}`
          : `${done} élément${done > 1 ? 's' : ''} déplacé${done > 1 ? 's' : ''}`,
        { detail: targetDir },
      );
    }
    return done;
  }

  /**
   * Le collage croisé : la source est un AUTRE serveur, chaque fichier passe
   * par le pont. Les dossiers sont annoncés comme non couverts plutôt que
   * copiés à moitié : le pont ne prend que des fichiers en v1.
   */
  private async pasteBridge(
    clipped: Clipped,
    targetDir: string,
    fromClipboard: boolean,
  ): Promise<number> {
    const route = `${clipped.host} → ${this.sftp.host()}`;
    const files = clipped.entries.filter((entry) => !entry.isDir);
    const dirs = clipped.entries.length - files.length;
    if (dirs > 0) {
      this.toasts.info(
        `${dirs} dossier${dirs > 1 ? 's' : ''} ignoré${dirs > 1 ? 's' : ''}`,
        { detail: 'Le pont entre serveurs ne copie que des fichiers pour l’instant' },
      );
    }

    let done = 0;
    let failed = 0;
    let skipped = 0;
    let blanket: 'overwrite-all' | 'skip-all' | null = null;

    for (const entry of files) {
      const from = this.joinDir(clipped.fromDir, entry.name);
      const to = this.joinDir(targetDir, entry.name);

      const verdict = await this.resolveConflict(
        from,
        to,
        entry,
        files.length > 1,
        blanket,
        targetDir,
        clipped.connectionId,
      );
      if (verdict.action === 'overwrite-all' || verdict.action === 'skip-all') {
        blanket = verdict.action;
      }
      if (verdict.action === 'skip' || verdict.action === 'skip-all') {
        skipped++;
        continue;
      }
      const destination = verdict.as ? this.joinDir(targetDir, verdict.as) : to;

      const ok = await this.transfers.bridge(
        clipped.connectionId,
        from,
        destination,
        entry.name,
        route,
      );
      if (!ok) {
        failed++;
        continue;
      }
      done++;

      // Couper entre serveurs = copier puis retirer la source, une fois
      // l'écriture FINIE et complète (le pont vérifie le compte d'octets).
      if (clipped.mode === 'cut') {
        await invoke('sftp_remove', {
          connectionId: clipped.connectionId,
          path: from,
          isDir: false,
        }).catch(() => {
          this.toasts.error(`« ${entry.name} » copié mais pas retiré de la source`, {
            detail: clipped.host,
          });
        });
      }
    }

    if (clipped.mode === 'cut' && done && fromClipboard) {
      this.clear();
    }
    await this.sftp.refresh();

    if (failed) {
      this.toasts.error(
        `${failed} fichier${failed > 1 ? 's' : ''} sur ${files.length} n’${failed > 1 ? 'ont' : 'a'} pas traversé`,
        { detail: 'Voir le panneau Transferts pour le détail' },
      );
    } else if (done) {
      this.toasts.success(
        `${done} fichier${done > 1 ? 's' : ''} ${clipped.mode === 'cut' ? 'déplacé' : 'copié'}${done > 1 ? 's' : ''} de ${clipped.host}`,
        { detail: targetDir },
      );
    } else if (skipped) {
      this.toasts.info(`${skipped} fichier${skipped > 1 ? 's' : ''} ignoré${skipped > 1 ? 's' : ''}`);
    }
    return done;
  }

  /**
   * La cible existe-t-elle déjà, et que faire ?
   *
   * Écraser sans prévenir est la faute qu'on ne rattrape pas : le même
   * dialogue que l'envoi depuis le disque local sert ici, avec son aperçu de
   * diff et son alerte quand la version de destination est plus récente. Un
   * dossier existant n'est pas comparable ligne à ligne : il est refusé, pas
   * fusionné en silence.
   */
  private async resolveConflict(
    from: string,
    to: string,
    entry: { name: string; isDir: boolean },
    batch: boolean,
    blanket: 'overwrite-all' | 'skip-all' | null,
    targetDir: string,
    sourceConnectionId?: string,
  ): Promise<ConflictVerdict> {
    const target = await this.sftp.stat(to);
    if (!target?.exists) {
      return { action: 'go' };
    }
    if (blanket) {
      return { action: blanket === 'overwrite-all' ? 'go' : 'skip' };
    }
    if (target.isDir || entry.isDir) {
      // Fusionner deux arborescences demande des règles qu'on n'a pas ;
      // écraser un dossier entier par surprise serait pire. Mais garder les
      // deux reste possible : ça ne détruit rien.
      const free = await this.freeName(entry.name, targetDir);
      const keep = await this.dialog.confirm({
        title: `« ${entry.name} » existe déjà`,
        message: `Un dossier ne peut pas être remplacé sans être fusionné, ce que Charon ne fait pas. Le copier sous le nom « ${free} » ?`,
        confirmLabel: 'Garder les deux',
      });
      return keep ? { action: 'go', as: free } : { action: 'skip' };
    }

    const sourceConn = sourceConnectionId ?? this.sftp.connectionId();
    const source = (await invoke<StatInfo>('sftp_stat', {
      connectionId: sourceConn,
      path: from,
    }).catch(() => null)) ?? {
      exists: true,
      isDir: false,
      size: 0,
      mtime: 0,
    };
    const decision = await this.overwrite.request({
      name: entry.name,
      sides: PASTE_SIDES,
      batch,
      canKeepBoth: true,
      // « Plus récent » se lit dans le même sens que pour un envoi : la
      // destination a-t-elle bougé après la source ?
      remoteNewer: target.mtime > 0 && source.mtime > 0 && target.mtime > source.mtime,
      local: source,
      remote: target,
      loadDiff: async () => {
        const read = (connectionId: string | null, path: string) =>
          invoke<string>('sftp_read_text', {
            connectionId,
            path,
            maxBytes: DIFF_MAX_BYTES,
          }).catch(() => undefined);
        const [targetText, sourceText] = await Promise.all([
          read(this.sftp.connectionId(), to),
          read(sourceConn, from),
        ]);
        if (targetText === undefined || sourceText === undefined) {
          return null;
        }
        if (targetText.includes('\u0000') || sourceText.includes('\u0000')) {
          return null; // binaire
        }
        return lineDiff(targetText, sourceText);
      },
    });

    if (decision === 'overwrite') {
      return { action: 'go' };
    }
    if (decision === 'keep-both') {
      return { action: 'go', as: await this.freeName(entry.name, targetDir) };
    }
    if (decision === 'overwrite-all') {
      return { action: 'overwrite-all' };
    }
    if (decision === 'skip-all') {
      return { action: 'skip-all' };
    }
    return { action: 'skip' };
  }

  /**
   * Le premier nom libre à côté : « rapport.pdf » devient « rapport (2).pdf ».
   *
   * L'extension est préservée, sinon un « rapport.pdf (2) » ne s'ouvrirait plus. Le
   * point compte, pas sa position : un `.env` n'a pas d'extension à garder.
   */
  private async freeName(name: string, dir: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; n < 100; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await this.sftp.stat(this.joinDir(dir, candidate)))?.exists) {
        return candidate;
      }
    }
    // Cent voisins du même nom : l'horodatage tranche plutôt que d'échouer.
    return `${stem} (${Date.now()})${ext}`;
  }

  /**
   * Déplace ou copie une sélection dans un dossier (glissé, ⌥ pour copier).
   * Chemin direct, sans passer par le presse-papiers.
   */
  async moveInto(entries: FileEntry[], targetDir: string, copy = false): Promise<number> {
    let done = 0;
    let failed = 0;
    for (const entry of entries) {
      const from = this.sftp.pathTo(entry.name);
      if (from === targetDir || targetDir.startsWith(`${from}/`)) {
        // Un dossier ne se déplace pas dans lui-même ni dans sa descendance.
        failed++;
        continue;
      }
      const to = targetDir === '/' ? `/${entry.name}` : `${targetDir}/${entry.name}`;
      try {
        if (copy) {
          await invoke('sftp_copy', { connectionId: this.sftp.connectionId(), from, to });
          this.activity.log('upload', 'remote', to, `copié depuis ${from}`);
        } else {
          await this.sftp.moveTo(from, to);
          this.activity.log('rename', 'remote', from, `déplacé vers ${to}`);
        }
        done++;
      } catch (error) {
        failed++;
        this.activity.log('rename', 'remote', from, String(error), false);
      }
    }
    await this.sftp.refresh();
    if (done) {
      this.announceDirChanged(this.sftp.connectionId(), targetDir);
      if (!copy) {
        this.announceDirChanged(this.sftp.connectionId(), this.sftp.currentPath());
      }
    }

    const verb = copy ? 'copié' : 'déplacé';
    if (done) {
      this.toasts.success(`${done} élément${done > 1 ? 's' : ''} ${verb}${done > 1 ? 's' : ''}`, {
        detail: targetDir,
      });
    }
    if (failed) {
      this.toasts.error(
        `${failed} élément${failed > 1 ? 's' : ''} n’${failed > 1 ? 'ont' : 'a'} pas pu être ${verb}${failed > 1 ? 's' : ''}`,
        { detail: 'Voir le journal pour le détail' },
      );
    }
    return done;
  }
}
