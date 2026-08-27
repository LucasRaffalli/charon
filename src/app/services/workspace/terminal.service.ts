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
}
