import { Injectable, signal } from '@angular/core';

/** Une demande de déplacement, datée pour être rejouable. */
interface TerminalJump {
  path: string;
  /** Deux demandes du même dossier doivent rester deux demandes. */
  at: number;
}

/**
 * Le canal par lequel on envoie le terminal quelque part.
 *
 * Le panneau suit déjà le dossier de l'explorateur, mais ce suivi se coupe, et
 * « ouvrir le terminal ici » n'est pas la même chose : c'est une demande
 * explicite, qui doit aboutir que le suivi soit actif ou non, et sans déplacer
 * l'explorateur au passage.
 */
@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly _jump = signal<TerminalJump | null>(null);
  readonly jump = this._jump.asReadonly();

  goTo(path: string): void {
    this._jump.set({ path, at: Date.now() });
  }

  // --- L'intégration shell (Séraphin, marche 1) --------------------------
  //
  // Le shell distant se raconte par des marqueurs invisibles (OSC 7 : son
  // répertoire à chaque invite ; OSC 133 : début d'invite, départ de
  // commande, code de sortie). Le panneau les reçoit d'xterm et les dépose
  // ici : l'état appartient à la SESSION, pas au composant qui l'a lu, pour
  // que la pastille git, la barre et ce qui viendra puissent s'en servir.

  /** Les marqueurs arrivent : le shell est instrumenté. Faux tant que la
   *  première invite ne s'est pas annoncée (shell inconnu, injection ratée),
   *  et tout le monde retombe alors sur les heuristiques d'avant. */
  private readonly _integrated = signal(false);
  readonly integrated = this._integrated.asReadonly();

  /** Le VRAI répertoire du shell, dit par lui-même : il suit un `cd` tapé au
   *  clavier, là où l'explorateur ne peut que deviner. */
  private readonly _shellCwd = signal<string | null>(null);
  readonly shellCwd = this._shellCwd.asReadonly();

  /** Une commande tourne (entre le marqueur de départ et son verdict). */
  private readonly _running = signal(false);
  readonly running = this._running.asReadonly();

  /** Le verdict de la dernière commande : code de sortie et durée mesurée. */
  private readonly _lastExit = signal<{ code: number; ms: number } | null>(null);
  readonly lastExit = this._lastExit.asReadonly();

  /** Compteur de commandes TERMINÉES : ce qui veut réagir à « une commande
   *  vient de finir » (relire le dossier, resonder git) observe ce signal. */
  private readonly _commandDone = signal(0);
  readonly commandDone = this._commandDone.asReadonly();

  private startedAt = 0;

  notePrompt(): void {
    this._integrated.set(true);
    this._running.set(false);
  }

  noteCwd(path: string): void {
    this._shellCwd.set(path);
  }

  noteCommandStart(): void {
    this.startedAt = performance.now();
    this._running.set(true);
  }

  noteCommandEnd(code: number): void {
    // Un D sans C est le tout premier prompt du shell : aucune commande n'a
    // tourné, il n'y a pas de verdict à fabriquer.
    if (!this._running()) {
      return;
    }
    this._running.set(false);
    this._lastExit.set({ code, ms: performance.now() - this.startedAt });
    this._commandDone.update((count) => count + 1);
  }

  /** La session du terminal se referme : ce qu'on savait du shell meurt avec. */
  resetIntegration(): void {
    this._integrated.set(false);
    this._shellCwd.set(null);
    this._running.set(false);
    this._lastExit.set(null);
  }
}
