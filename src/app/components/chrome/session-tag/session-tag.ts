import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { ProfilesService } from '@app/services/connection/profiles.service';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';

/**
 * L'identité d'une session dans le coin haut droit d'un panneau : le voile de
 * sa couleur fondu vers rien, une pastille, et son nom en pleine couleur de
 * texte : la couleur identifie, le texte reste lisible.
 *
 * Posé par explorer-page sur les panneaux uniques (aperçu, recherche,
 * corbeille, logs) en vue double : ils suivent la session focalisée, le voile
 * dit laquelle à l'instant même.
 */
@Component({
  selector: 'app-session-tag',
  template: `
    <span class="dot" [style.background]="toneColor()" aria-hidden="true"></span>
    <span class="name">{{ title() }}</span>
  `,
  styles: `
    :host {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 6;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px 12px 34px;
      pointer-events: none;
      animation: tag-in 0.25s ease;
    }

    .dot {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 2px;
    }

    .name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
      font-size: calc(10.5px * var(--text-scale));
      font-weight: 800;
      letter-spacing: 0.04em;
    }

    @keyframes tag-in {
      from {
        opacity: 0;
        transform: translateY(-3px);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }
    }
  `,
  host: {
    '[style.background]': 'wash()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionTag {
  readonly session = input.required<Session>();

  private readonly registry = inject(SessionRegistry);
  private readonly profiles = inject(ProfilesService);

  protected readonly title = computed(() => {
    const sftp = this.session().sftp;
    const profile = this.profiles
      .profiles()
      .find((candidate) => candidate.id === sftp.profileId());
    return profile?.name ?? (sftp.host() || 'Connexion');
  });

  protected toneColor(): string {
    return `var(--session-${this.registry.toneOf(this.session())})`;
  }

  protected wash(): string {
    const tone = this.registry.toneOf(this.session());
    return `linear-gradient(225deg, color-mix(in srgb, var(--session-${tone}) 30%, transparent), transparent 74%)`;
  }
}
