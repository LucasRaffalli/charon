import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';

import { ThemeService } from '@app/services/appearance/theme.service';

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  /** De 1 à 0 : sert à la fois d'opacité et de taille. */
  life: number;
  decay: number;
  angle: number;
  spin: number;
  color: string;
}

/** Densité volontairement basse : un effet permanent doit rester discret. */
const SPAWN_EVERY = 22;
const MAX_SPARKLES = 34;
const GRAVITY = 0.045;

const COLORS = ['#f480c1', '#e0559f', '#bd93f9', '#ff9fd6', '#c77dff'];

/**
 * La traînée de paillettes de l'accent Unicorn, et de lui seul.
 *
 * Trois garde-fous, l'effet étant permanent :
 * - `prefers-reduced-motion` respecté, l'effet ne démarre pas du tout ;
 * - la boucle s'éteint dès que la souris s'arrête et que les dernières
 *   paillettes ont disparu, sinon un requestAnimationFrame tourne en continu
 *   et chauffe la machine ;
 * - le canevas est en `pointer-events: none`, pour ne jamais intercepter un
 *   clic, un glisser-déposer ni la saisie du terminal.
 */
@Component({
  selector: 'app-sparkles',
  template: '<canvas #canvas class="sparkles" aria-hidden="true"></canvas>',
  styleUrl: './sparkles.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sparkles {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly reducedMotion =
    this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;

  private readonly enabled = computed(
    () => this.theme.accent() === 'unicorn' && !this.reducedMotion,
  );

  private context: CanvasRenderingContext2D | null = null;
  private sparkles: Sparkle[] = [];
  private frame = 0;
  private width = 0;
  private height = 0;
  private travelled = 0;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;
  private listening = false;

  constructor() {
    afterNextRender(() => {
      this.context = this.canvasRef().nativeElement.getContext('2d');
      this.resize();
      this.apply(this.enabled());
    });

    effect(() => {
      const on = this.enabled();
      if (this.context) {
        this.apply(on);
      }
    });

    this.destroyRef.onDestroy(() => this.apply(false));
  }

  private apply(on: boolean): void {
    const view = this.document.defaultView;
    if (!view || on === this.listening) {
      return;
    }
    this.listening = on;
    if (on) {
      view.addEventListener('pointermove', this.onMove, { passive: true });
      view.addEventListener('resize', this.onResize, { passive: true });
      return;
    }
    view.removeEventListener('pointermove', this.onMove);
    view.removeEventListener('resize', this.onResize);
    if (this.frame) {
      view.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.sparkles = [];
    this.hasLast = false;
    this.travelled = 0;
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  private readonly onResize = (): void => this.resize();

  private resize(): void {
    const view = this.document.defaultView;
    const canvas = this.canvasRef().nativeElement;
    if (!view || !this.context) {
      return;
    }
    const ratio = view.devicePixelRatio || 1;
    this.width = view.innerWidth;
    this.height = view.innerHeight;
    canvas.width = Math.round(this.width * ratio);
    canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private readonly onMove = (event: PointerEvent): void => {
    const { clientX: x, clientY: y } = event;

    if (this.hasLast) {
      this.travelled += Math.hypot(x - this.lastX, y - this.lastY);
    }
    this.lastX = x;
    this.lastY = y;
    this.hasLast = true;

    while (this.travelled >= SPAWN_EVERY && this.sparkles.length < MAX_SPARKLES) {
      this.travelled -= SPAWN_EVERY;
      this.sparkles.push(this.spawn(x, y));
    }
    this.travelled = Math.min(this.travelled, SPAWN_EVERY);

    // La boucle ne tourne que s'il y a quelque chose à animer.
    if (!this.frame && this.sparkles.length) {
      this.frame = this.document.defaultView!.requestAnimationFrame(this.tick);
    }
  };

  private spawn(x: number, y: number): Sparkle {
    return {
      x: x + (Math.random() - 0.5) * 12,
      y: y + (Math.random() - 0.5) * 12,
      vx: (Math.random() - 0.5) * 1.1,
      vy: (Math.random() - 0.5) * 0.8 - 0.3,
      size: 3.5 + Math.random() * 3.5,
      life: 1,
      decay: 0.012 + Math.random() * 0.012,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.09,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  }

  private readonly tick = (): void => {
    const context = this.context;
    const view = this.document.defaultView;
    if (!context || !view) {
      this.frame = 0;
      return;
    }

    context.clearRect(0, 0, this.width, this.height);

    for (const sparkle of this.sparkles) {
      sparkle.vy += GRAVITY;
      sparkle.vx *= 0.98;
      sparkle.x += sparkle.vx;
      sparkle.y += sparkle.vy;
      sparkle.angle += sparkle.spin;
      sparkle.life -= sparkle.decay;
    }
    this.sparkles = this.sparkles.filter((sparkle) => sparkle.life > 0);

    for (const sparkle of this.sparkles) {
      this.draw(context, sparkle);
    }

    // Plus rien à l'écran et la souris s'est arrêtée : on éteint la boucle.
    this.frame = this.sparkles.length ? view.requestAnimationFrame(this.tick) : 0;
  };

  /** Un éclat à quatre branches, tracé aux courbes plutôt qu'en étoile pointue. */
  private draw(context: CanvasRenderingContext2D, sparkle: Sparkle): void {
    const radius = sparkle.size * sparkle.life;
    context.save();
    context.translate(sparkle.x, sparkle.y);
    context.rotate(sparkle.angle);
    context.globalAlpha = Math.min(1, sparkle.life * 1.3);
    context.fillStyle = sparkle.color;
    context.beginPath();
    context.moveTo(0, -radius);
    context.quadraticCurveTo(0, 0, radius, 0);
    context.quadraticCurveTo(0, 0, 0, radius);
    context.quadraticCurveTo(0, 0, -radius, 0);
    context.quadraticCurveTo(0, 0, 0, -radius);
    context.fill();
    context.restore();
  }
}
