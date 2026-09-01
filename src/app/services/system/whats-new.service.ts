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
 * au premier lancement d'une version qui n'a pas encore été annoncée ici. Un
 * changelog qu'il faut aller chercher dans un onglet de réglages n'est lu par
 * personne, et c'est précisément quand l'application vient de changer qu'on
 * veut savoir ce qui a changé.
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
   * Montre les nouveautés de la version installée, **au moins une fois**.
   *
   * La règle tient en une ligne : cette version n'a pas encore été annoncée
   * sur cette machine, on l'annonce. Peu importe par où l'on est arrivé :
   * mise à jour, téléchargement du DMG, réinstallation.
   *
   * Le silence à la première installation a été essayé puis retiré (31/08) :
   * il partait du principe qu'un nouveau venu se moque de ce qui a changé,
   * alors qu'il est justement celui qui ne sait pas ce que l'application
   * sait faire. Et il attrapait trop large : le marqueur `charon:seen-version`
   * n'existe que depuis la 1.2.0, donc TOUTE mise à jour venue d'avant
   * passait pour une première installation et n'annonçait rien.
   */
  showIfUpdated(): void {
    const current = this.updater.currentVersion();
    if (!current || current === '…') {
      return;
    }
    if (this.read() === current) {
      return;
    }
    // Rien à montrer si cette version n'a pas d'entrée rédigée : on note pour
    // ne pas y revenir à chaque lancement.
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
