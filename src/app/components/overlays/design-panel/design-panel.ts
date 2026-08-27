import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  computed,
  inject,
  input,
} from '@angular/core';

import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { Gradient, GradientColors } from '@app/interfaces';
import { AppearanceService } from '@app/services/appearance.service';
import { DesignPanelId, DesignService, DesignTemplate } from '@app/services/design.service';
import { DialogService } from '@app/services/dialog.service';
import { DockLayout } from '@app/services/dock-tree';
import { DockService } from '@app/services/dock.service';
import { ThemeService } from '@app/services/theme.service';

const MARGIN = 8;

interface GradientOption {
  value: Gradient;
  label: string;
}

/** Préréglages de couleurs, pour aller vite sans ouvrir deux sélecteurs. */
interface ColorPreset {
  label: string;
  from: string;
  to: string;
}

@Component({
  selector: 'app-design-panel',
  imports: [SegmentedControl],
  templateUrl: './design-panel.html',
  styleUrl: './design-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignPanel {
  /** Lequel des deux panneaux ce composant rend. */
  readonly side = input.required<DesignPanelId>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly dialog = inject(DialogService);
  protected readonly design = inject(DesignService);
  protected readonly appearance = inject(AppearanceService);
  protected readonly themeService = inject(ThemeService);
  protected readonly dock = inject(DockService);

  protected readonly themeOptions: readonly SegmentedOption[] = [
    { value: 'light', label: 'Clair' },
    { value: 'dark', label: 'Sombre' },
    { value: 'contrast', label: 'Contraste' },
  ];

  protected readonly panelOptions: readonly SegmentedOption[] = [
    { value: 'opaque', label: 'Opaques' },
    { value: 'translucide', label: 'Translucides' },
  ];

  protected readonly radiusOptions: readonly SegmentedOption[] = [
    { value: 'net', label: 'Net' },
    { value: 'doux', label: 'Doux' },
    { value: 'rond', label: 'Rond' },
  ];

  protected readonly textOptions: readonly SegmentedOption[] = [
    { value: 'petit', label: 'Petit' },
    { value: 'normal', label: 'Normal' },
    { value: 'grand', label: 'Grand' },
  ];

  protected readonly watermarkOptions: readonly SegmentedOption[] = [
    { value: 'off', label: 'Masqué' },
    { value: 'on', label: 'Affiché' },
  ];

  protected readonly gradientOptions: readonly GradientOption[] = [
    { value: 'none', label: 'Aucun' },
    { value: 'halo', label: 'Halo' },
    { value: 'aube', label: 'Aube' },
    { value: 'aurore', label: 'Aurore' },
    { value: 'maille', label: 'Maille' },
    { value: 'voute', label: 'Voûte' },
  ];

  protected readonly presets: readonly ColorPreset[] = [
    { label: 'Acier', from: '#5b7fa6', to: '#7da3cc' },
    { label: 'Néon', from: '#e0559f', to: '#c19bff' },
    { label: 'Coucher', from: '#f97316', to: '#facc15' },
    { label: 'Lagune', from: '#0ea5e9', to: '#22d3ee' },
    { label: 'Nuit', from: '#7c3aed', to: '#2563eb' },
    { label: 'Forêt', from: '#059669', to: '#a3e635' },
  ];

  /** Un dégradé choisi mais des panneaux opaques : l'effet ne se verra pas. */
  protected readonly hiddenByPanels = computed(
    () => this.appearance.gradient() !== 'none' && this.appearance.panels() === 'opaque',
  );

  /** En contraste élevé la lisibilité prime : la translucidité est ignorée. */
  protected readonly translucencyIgnored = computed(
    () => this.themeService.theme() === 'contrast' && this.appearance.panels() === 'translucide',
  );

  protected readonly followsAccent = computed(() => this.appearance.colors() === null);

  // --- Réglages ------------------------------------------------------------

  protected setTheme(value: string): void {
    this.themeService.select(value as never);
  }

  protected setGradient(value: Gradient): void {
    this.appearance.update({ gradient: value });
  }

  protected setIntensity(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.appearance.update({ intensity: value });
  }

  protected setPanels(value: string): void {
    this.appearance.update({ panels: value as never });
  }

  protected setRadius(value: string): void {
    this.appearance.update({ radius: value as never });
  }

  protected setText(value: string): void {
    this.appearance.update({ text: value as never });
  }

  protected setWatermark(value: string): void {
    this.appearance.update({ watermark: value === 'on' });
  }

  protected setColor(which: keyof GradientColors, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const current = this.appearance.effectiveColors();
    this.appearance.update({ colors: { ...current, [which]: value } });
  }

  protected applyPreset(preset: ColorPreset): void {
    this.appearance.update({ colors: { from: preset.from, to: preset.to } });
  }

  /** Revenir à la teinte de l'accent : les couleurs redeviennent liées. */
  protected followAccent(): void {
    this.appearance.update({ colors: null });
  }

  protected applyTemplate(template: DesignTemplate): void {
    this.design.applyTemplate(template);
  }

  protected applyLayout(layout: DockLayout): void {
    this.design.applyLayout(layout);
  }

  /**
   * Réagencer le dock demande du temps : on ne le défait pas sur un clic
   * malheureux, surtout dans un panneau où tout le reste est réversible.
   */
  // --- Déplacement -------------------------------------------------------
  // L'hôte du composant EST la carte : pas de viewChild à chercher.

  protected onDragStart(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const rect = this.host.nativeElement.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Fige la position courante avant le premier mouvement, sinon la carte
    // saute de son ancrage par défaut au premier pixel de glissement.
    this.design.moveTo(this.side(), { x: rect.left, y: rect.top });
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected onDragMove(event: PointerEvent): void {
    const offset = this.dragOffset;
    const view = this.document.defaultView;
    if (!offset || !view) {
      return;
    }
    const rect = this.host.nativeElement.getBoundingClientRect();
    this.design.moveTo(this.side(), {
      x: Math.max(MARGIN, Math.min(view.innerWidth - rect.width - MARGIN, event.clientX - offset.x)),
      y: Math.max(MARGIN, Math.min(view.innerHeight - rect.height - MARGIN, event.clientY - offset.y)),
    });
  }

  protected onDragEnd(event: PointerEvent): void {
    this.dragOffset = null;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  private dragOffset: { x: number; y: number } | null = null;

  // --- Disposition -------------------------------------------------------

  protected async resetDock(): Promise<void> {
    const confirmed = await this.dialog.confirm({
      title: 'Réinitialiser la disposition ?',
      message:
        'Les panneaux reprennent leur agencement d\'origine. Les tailles et les onglets déplacés seront perdus.',
      confirmLabel: 'Réinitialiser',
      danger: true,
    });
    if (confirmed) {
      this.dock.reset();
    }
  }
}
