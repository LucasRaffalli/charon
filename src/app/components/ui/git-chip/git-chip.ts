import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { GitStatus } from '@app/interfaces';

/**
 * L'état d'un dépôt Git en une pastille.
 *
 * Composant et non morceau de gabarit : la même information sert au terminal
 * et à l'en-tête du panneau serveur, et elle en servira d'autres. Elle est
 * volontairement muette quand il n'y a rien à dire (hors dépôt), plutôt que
 * d'afficher une case vide qui occuperait la place sans rien apprendre.
 *
 * Ce qui est montré, dans cet ordre : la branche, l'écart avec la branche de
 * suivi, puis ce qui n'est pas committé. Chaque nombre est muet quand il vaut
 * zéro : un dépôt propre affiche son seul nom de branche, ce qui est
 * exactement l'information utile à ce moment-là.
 */
@Component({
  selector: 'app-git-chip',
  template: `
    @if (status(); as git) {
      <button type="button" class="chip" [class.chip--dirty]="dirty() > 0" [title]="hint()" (click)="opened.emit($event)">
        <span class="chip__branch">{{ git.branch }}</span>
        @if (git.ahead) {
          <span class="chip__n chip__n--ahead">↑{{ git.ahead }}</span>
        }
        @if (git.behind) {
          <span class="chip__n chip__n--behind">↓{{ git.behind }}</span>
        }
        @if (git.staged) {
          <span class="chip__n chip__n--staged">●{{ git.staged }}</span>
        }
        @if (git.modified) {
          <span class="chip__n chip__n--modified">●{{ git.modified }}</span>
        }
        @if (git.untracked) {
          <span class="chip__n chip__n--untracked">●{{ git.untracked }}</span>
        }
        @if (git.conflicted) {
          <span class="chip__n chip__n--conflicted">✕{{ git.conflicted }}</span>
        }
      </button>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex: none;
      min-width: 0;
      max-width: 260px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: none;
      color: var(--text-muted);
      font-size: calc(11px * var(--text-scale));
      font-family: inherit;
      cursor: pointer;
    }

    .chip:hover {
      background: var(--state-hover);
      color: var(--text);
    }

    /* Un dépôt qui a des choses en cours se distingue d'un dépôt propre : la
       bordure suffit, il ne s'agit pas d'alerter mais de faire une différence
       qu'on lit sans lire. */
    .chip--dirty {
      border-color: var(--border-strong);
      color: var(--text);
    }

    .chip__branch {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .chip__n {
      flex: none;
      font-variant-numeric: tabular-nums;
    }

    /* Les couleurs disent la nature, pas la gravité : rien ici n'est un
       problème, ce sont des états normaux d'un dépôt au travail. */
    .chip__n--ahead,
    .chip__n--staged {
      color: var(--success);
    }

    .chip__n--behind,
    .chip__n--modified {
      color: var(--accent);
    }

    .chip__n--untracked {
      color: var(--text-faint);
    }

    .chip__n--conflicted {
      color: var(--danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitChip {
  readonly status = input<GitStatus | null>(null);
  /** Le clic ouvre le détail ; l'événement porte la position pour l'ancrage. */
  readonly opened = output<MouseEvent>();

  protected readonly dirty = computed(() => {
    const git = this.status();
    return git ? git.staged + git.modified + git.untracked + git.conflicted : 0;
  });

  /**
   * L'infobulle dit en toutes lettres ce que les pastilles disent en chiffres.
   * Des symboles seuls s'apprennent, mais seulement si quelque chose les
   * explique une première fois.
   */
  protected readonly hint = computed(() => {
    const git = this.status();
    if (!git) {
      return '';
    }
    const parts: string[] = [git.upstream ? `${git.branch} → ${git.upstream}` : git.branch];
    if (git.unborn) {
      parts.push('aucun commit');
    }
    if (git.ahead) {
      parts.push(`${git.ahead} commit${git.ahead > 1 ? 's' : ''} d'avance`);
    }
    if (git.behind) {
      parts.push(`${git.behind} commit${git.behind > 1 ? 's' : ''} de retard`);
    }
    if (git.staged) {
      parts.push(`${git.staged} indexé${git.staged > 1 ? 's' : ''}`);
    }
    if (git.modified) {
      parts.push(`${git.modified} modifié${git.modified > 1 ? 's' : ''}`);
    }
    if (git.untracked) {
      parts.push(`${git.untracked} non suivi${git.untracked > 1 ? 's' : ''}`);
    }
    if (git.conflicted) {
      parts.push(`${git.conflicted} en conflit`);
    }
    if (git.lastCommit) {
      parts.push(`dernier : ${git.lastCommit}`);
    }
    return parts.join(' · ');
  });
}
