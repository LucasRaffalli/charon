import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { CharonGlyph } from '@app/components/brand/charon-logo/charon-glyph';
import { ChangeKind, ChangeNote, ChangelogEntry } from '@app/interfaces';
import { formatReleaseDate } from '@app/services/system/date-format';
import { WhatsNewService } from '@app/services/system/whats-new.service';
import { injectT } from '@app/lang/i18n.service';

/**
 * Compare deux versions sémantiques. `localeCompare` dirait que 1.10 précède
 * 1.9, ce qui est faux dès qu'on dépasse la neuvième version mineure.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

const KIND_LABELS: Record<ChangeKind, string> = {
  new: 'Nouveau',
  better: 'Amélioré',
  fixed: 'Corrigé',
};

/**
 * Le titre d'un groupe, au pluriel : c'est un compte qu'on annonce, pas une
 * étiquette de ligne.
 */
const GROUP_LABELS: Record<ChangeKind, [string, string]> = {
  new: ['nouveauté', 'nouveautés'],
  better: ['amélioration', 'améliorations'],
  fixed: ['correctif', 'correctifs'],
};

/** L'ordre de lecture : ce qui est nouveau d'abord, ce qui est réparé ensuite. */
const KIND_ORDER: ChangeKind[] = ['new', 'better', 'fixed'];

/** Un paquet de notes de même nature, avec son titre déjà compté. */
export interface NoteGroup {
  kind: ChangeKind;
  title: string;
  notes: ChangeNote[];
}

/**
 * Les nouveautés en grand : le même carnet de bord que les réglages, mais
 * lisible d'un coup, et ouvert au moment où il sert.
 */
@Component({
  selector: 'app-whats-new',
  imports: [Button, CharonGlyph, NgTemplateOutlet],
  templateUrl: './whats-new.html',
  styleUrl: './whats-new.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WhatsNew {
  protected readonly t = injectT();
  protected readonly whatsNew = inject(WhatsNewService);
  protected readonly kindLabels = KIND_LABELS;
  protected readonly formatDate = formatReleaseDate;

  /**
   * Les covers introuvables. Le motif du conteneur tient déjà la place ; on
   * retire l'image parce que le navigateur dessinerait sinon sa propre icône
   * de fichier cassé par-dessus.
   */
  private readonly _broken = signal<ReadonlySet<string>>(new Set());
  protected readonly broken = this._broken.asReadonly();

  protected markBroken(cover: string): void {
    this._broken.update((set) => new Set(set).add(cover));
  }

  /**
   * L'ordre du journal, du plus récent au plus ancien — celui du fichier.
   *
   * La version installée est **marquée, pas remontée** : la faire passer en
   * tête mettait 1.1.1 au-dessus de 1.2.0, ce qui n'est plus un journal. Le
   * repère se déplace, l'ordre non.
   */
  protected readonly entries = computed(() => this.whatsNew.entries);

  /**
   * La version mise en avant : celle qui est installée si elle a une entrée,
   * sinon la plus récente du journal. C'est elle qui prend le héros et le
   * groupement par nature ; les autres se lisent en dessous, sobrement.
   */
  protected readonly featured = computed<ChangelogEntry | null>(() => {
    const list = this.whatsNew.entries;
    const installed = this.whatsNew.highlighted();
    return list.find((entry) => entry.version === installed) ?? list[0] ?? null;
  });

  /** Les versions précédentes, dans l'ordre du journal. */
  protected readonly previous = computed<ChangelogEntry[]>(() => {
    const featured = this.featured();
    return this.whatsNew.entries.filter((entry) => entry !== featured);
  });

  /**
   * Les notes de la version en avant, groupées par nature. Une version de
   * quarante lignes qui défilent à la suite ne dit pas par où commencer ;
   * groupées et comptées, elle se lit d'un regard.
   */
  protected readonly groups = computed<NoteGroup[]>(() => {
    const notes = this.featured()?.notes ?? [];
    return KIND_ORDER.map((kind) => {
      const of = notes.filter((note) => note.kind === kind);
      const [one, many] = GROUP_LABELS[kind];
      return { kind, title: `${of.length} ${of.length > 1 ? many : one}`, notes: of };
    }).filter((group) => group.notes.length > 0);
  });

  /** Ce que porte le badge d'une version, ou rien. */
  protected badge(version: string): string | null {
    const installed = this.whatsNew.highlighted();
    if (!installed) {
      return null;
    }
    if (version === installed) {
      return 'installée';
    }
    // Au-dessus de l'installée : livré, mais pas encore chez cet utilisateur.
    return compareVersions(version, installed) > 0 ? 'après mise à jour' : null;
  }

  protected isHighlighted(version: string): boolean {
    return version === this.whatsNew.highlighted();
  }

  /**
   * Le mode d'emploi déplié, par note.
   *
   * À la demande : une liste où chaque ligne porterait son paragraphe
   * d'explication ne se lirait plus comme un journal.
   */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  protected toggleHow(key: string): void {
    this.opened.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }
}
