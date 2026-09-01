import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { GitStatus } from '@app/interfaces';
import { SftpService } from '@app/services/connection/sftp.service';
import { injectSessionActivity } from '@app/services/workspace/activity-log.service';

/**
 * Attente avant de sonder, après un changement de dossier. Assez court pour
 * qu'on ne le remarque pas, assez long pour qu'une descente rapide dans
 * l'arborescence ne coûte qu'un seul relevé.
 */
const PROBE_DELAY_MS = 200;

/** Balise du backend : ce serveur n'a pas `git` (voir `git.rs`). */
const GIT_ABSENT = 'CHARON_NO_GIT';

/**
 * Ce que Charon sait dire du dépôt Git dans lequel on se trouve.
 *
 * Le terminal intégré est un vrai shell : impossible de savoir ce qui s'y
 * passe, et hors de question de réécrire l'invite du serveur pour y glisser un
 * nom de branche. On interroge donc le dépôt à côté, et on l'affiche AUTOUR du
 * terminal.
 *
 * Le service vit par session et non dans le terminal, ce qui est le point :
 * l'état sert au terminal, à l'en-tête du panneau serveur, et à ce qui
 * viendra. Une information rattachée au dossier affiché n'appartient pas au
 * composant qui l'a demandée en premier.
 */
@Injectable()
export class GitService {
  private readonly sftp = inject(SftpService);
  private readonly activity = injectSessionActivity();

  private readonly _status = signal<GitStatus | null>(null);
  private readonly _loading = signal(false);
  readonly status = this._status.asReadonly();
  readonly loading = this._loading.asReadonly();

  /** Dans un dépôt, et il a quelque chose à dire. */
  readonly inRepo = computed(() => this._status() !== null);

  /** Le compte de ce qui n'est pas committé, toutes natures confondues. */
  readonly dirty = computed(() => {
    const status = this._status();
    if (!status) {
      return 0;
    }
    return status.staged + status.modified + status.untracked + status.conflicted;
  });

  /**
   * Le chemin du dernier relevé lancé. Sert à écarter une réponse tardive :
   * on navigue plus vite que le réseau ne répond, et afficher la branche du
   * dossier précédent serait pire que ne rien afficher.
   */
  private asked = '';

  /**
   * Le serveur n'a pas `git`. C'est un fait qui vaut pour toute la session :
   * on cesse de sonder, sinon chaque changement de dossier paierait un canal
   * SSH pour se faire répondre la même chose.
   */
  private absent = false;

  /**
   * Le relevé est DIFFÉRÉ : descendre trois dossiers d'affilée ne doit pas
   * ouvrir trois canaux SSH pour deux réponses qu'on jettera. La leçon est
   * déjà payée ailleurs, un canal SSH n'est pas gratuit et le serveur en
   * limite le nombre (`MaxSessions` vaut 10 par défaut chez OpenSSH).
   */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const path = this.sftp.currentPath();
      const connected = this.sftp.connected();
      if (!connected) {
        // Nouvelle session, nouveau serveur : ce qu'on croyait savoir de lui
        // ne vaut plus rien.
        this.absent = false;
      }
      if (!connected || this.sftp.protocol() !== 'sftp' || !path) {
        this.clearTimer();
        this._status.set(null);
        this.asked = '';
        return;
      }
      this.schedule(path);
    });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(path: string): void {
    this.clearTimer();
    if (this.absent) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.probe(path);
    }, PROBE_DELAY_MS);
  }

  /**
   * Relance le relevé pour le dossier courant.
   *
   * Appelé par le terminal quand une commande vient de se terminer : c'est le
   * seul moment où le dépôt a pu changer sans que Charon en soit l'auteur, et
   * c'est exactement l'intérêt de la chose (on tape `git commit`, la pastille
   * suit). Le même signal sert déjà à relire le dossier affiché.
   */
  poke(): void {
    const path = this.sftp.currentPath();
    if (path && this.sftp.connected() && this.sftp.protocol() === 'sftp') {
      this.schedule(path);
    }
  }

  private async probe(path: string): Promise<void> {
    const id = this.sftp.connectionId();
    if (!id) {
      return;
    }
    this.asked = path;
    this._loading.set(true);
    try {
      const status = await invoke<GitStatus | null>('sftp_git_status', {
        connectionId: id,
        path,
      });
      // La réponse d'un dossier qu'on a déjà quitté ne s'affiche pas.
      if (this.asked === path) {
        this._status.set(status ?? null);
      }
    } catch (error) {
      // Silencieux, et c'est voulu : personne n'a demandé ce relevé, il suit
      // la navigation. Un dossier sans dépôt, un serveur qui refuse l'exec ou
      // un git absent ne sont pas des erreurs à annoncer, seulement une
      // pastille qui ne s'affiche pas.
      if (String(error).includes(GIT_ABSENT)) {
        this.absent = true;
      } else {
        // Au journal, et nulle part ailleurs : un relevé que personne n'a
        // demandé ne doit pas interrompre le travail par un toast, mais une
        // panne muette est indiagnosticable. Le journal est fait pour ça.
        // « Pas un dépôt » n'arrive pas ici, c'est une réponse valide.
        this.activity.log('error', 'remote', path, `Git : ${String(error)}`, false);
      }
      if (this.asked === path) {
        this._status.set(null);
      }
    } finally {
      if (this.asked === path) {
        this._loading.set(false);
      }
    }
  }

  /** Le contenu d'un fichier dans HEAD, pour le comparer à ce qu'il est devenu. */
  async headContent(relativePath: string): Promise<string | null> {
    const id = this.sftp.connectionId();
    const root = this._status()?.root;
    if (!id || !root) {
      return null;
    }
    return invoke<string | null>('sftp_git_show_head', {
      connectionId: id,
      root,
      path: relativePath,
    }).catch(() => null);
  }
}
