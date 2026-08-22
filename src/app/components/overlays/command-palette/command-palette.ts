import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { CommandPaletteService, PaletteCommand } from '@app/services/command-palette.service';

/** Score de correspondance : préfixe > mot > inclusion > rien. */
const score = (command: PaletteCommand, query: string): number => {
  const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase();
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) {
    return 3;
  }
  if (haystack.split(/\s+/).some((word) => word.startsWith(query))) {
    return 2;
  }
  if (haystack.includes(query)) {
    return 1;
  }
  return 0;
};

@Component({
  selector: 'app-command-palette',
  imports: [Icon],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.meta.k)': 'toggle($event)',
    '(document:keydown.control.k)': 'toggle($event)',
  },
})
export class CommandPalette {
  protected readonly palette = inject(CommandPaletteService);

  protected readonly query = signal('');
  protected readonly selected = signal(0);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  protected readonly results = computed<PaletteCommand[]>(() => {
    const raw = this.query().trim().toLowerCase();
    const goto = this.palette.gotoCommand(raw);
    if (goto) {
      return [goto];
    }
    const commands = this.palette.commands();
    if (!raw) {
      return commands;
    }
    return commands
      .map((command) => ({ command, rank: score(command, raw) }))
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .map((entry) => entry.command);
  });

  constructor() {
    // Ouverture : reset + focus. Changement de requête : re-sélection du 1er.
    effect(() => {
      if (this.palette.open()) {
        this.query.set('');
        this.selected.set(0);
        requestAnimationFrame(() => this.input()?.nativeElement.focus());
      }
    });
    effect(() => {
      this.query();
      this.selected.set(0);
    });
  }

  protected toggle(event: Event): void {
    event.preventDefault();
    this.palette.toggle();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const results = this.results();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selected.update((index) => Math.min(index + 1, results.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selected.update((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        this.run(results[this.selected()]);
        break;
      case 'Escape':
        event.preventDefault();
        this.palette.close();
        break;
    }
  }

  protected run(command: PaletteCommand | undefined): void {
    if (!command) {
      return;
    }
    this.palette.close();
    void command.run();
  }
}
