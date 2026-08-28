import { Injectable, inject, signal } from '@angular/core';

import changelogData from '../../../assets/changelog.json';
import { ChangelogEntry } from '@app/interfaces';
import { UpdaterService } from '@app/services/system/updater.service';

/** La dernière version dont on a montré les nouveautés. */
const SEEN_KEY = 'charon:seen-version';

/**
 * Les nouveautés (« quoi de neuf »), en modale.
 *
 * Le même journal que Réglages → Mises à jour, mais **présenté quand il sert** :
 * au premier lancement après une mise à jour. Un changelog qu'il faut aller
 * chercher dans un onglet de réglages n'est lu par personne, et c'est
 * précisément au moment où l'application vient de changer qu'on veut savoir ce
 * qui a changé.
 */
@Injectable({ providedIn: 'root' })
export class WhatsNewService {
  private readonly updater = inject(UpdaterService);

  readonly open = signal(false);
  readonly entries = changelogData as ChangelogEntry[];

  /** Ce qui est mis en avant à l'ouverture : la version installée, ou la dernière connue. */
  readonly highlighted = signal<string | null>(null);

  show(version?: string): void {
    this.highlighted.set(version ?? this.updater.currentVersion());
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.remember();
  }

  /**
   * Montre les nouveautés si l'application vient d'être mise à jour.
   *
   * Silencieux à la toute première installation : quelqu'un qui découvre
   * Charon n'a pas besoin qu'on lui raconte ce qui a changé depuis une version
   * qu'il n'a jamais eue.
   */
  showIfUpdated(): void {
    const current = this.updater.currentVersion();
    if (!current || current === '…') {
      return;
    }
    const seen = this.read();
    if (seen === current) {
      return;
    }
    if (!seen) {
      // Première installation : on note et on se tait.
      this.remember();
      return;
    }
    // Rien à montrer si cette version n'a pas d'entrée rédigée.
    if (this.entries.some((entry) => entry.version === current)) {
      this.show(current);
    } else {
      this.remember();
    }
  }

  private read(): string | null {
    try {
      return localStorage.getItem(SEEN_KEY);
    } catch {
      return null;
    }
  }

  private remember(): void {
    try {
      const current = this.updater.currentVersion();
      if (current && current !== '…') {
        localStorage.setItem(SEEN_KEY, current);
      }
    } catch {
      // Stockage indisponible : au pire la modale reviendra une fois.
    }
  }
}
