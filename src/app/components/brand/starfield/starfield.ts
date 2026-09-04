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

interface Star {
  x: number;
  y: number;
  radius: number;
  /** Où en est son scintillement, et à quelle vitesse il avance. */
  phase: number;
  speed: number;
  /** Éclat maximal : toutes les étoiles ne brillent pas pareil. */
  peak: number;
}

interface Shooting {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** De 1 à 0 : opacité et longueur de la traînée. */
  life: number;
  length: number;
}

/** Une étoile pour ~9 000 pixels, plafonnée : un ciel, pas une galaxie. */
const DENSITY = 9000;
const MAX_STARS = 220;

/**
 * Cadence VOLONTAIREMENT basse.
 *
 * Un scintillement est lent par nature : le dessiner soixante fois par
 * seconde ne se voit pas et chauffe la machine pour rien. À vingt images par
 * seconde, le rendu est identique à l'œil et la boucle coûte trois fois
 * moins.
 */
const FPS = 20;
const FRAME_MS = 1000 / FPS;

/** Une étoile filante toutes les 6 à 18 secondes : c'est leur rareté qui les
 *  rend jolies. Deux en même temps au plus. */
const SHOOT_MIN_MS = 6000;
const SHOOT_MAX_MS = 18000;
const MAX_SHOOTING = 2;

/**
 * Le ciel étoilé de l'accent Stars, et de lui seul.
 *
 * Il vit à la MÊME couche que le calque de dégradé (`z-index: 0`), c'est-à-dire
 * PAR-DESSUS l'interface et non derrière : le fond de l'application est
 * opaque, un ciel placé dessous ne se verrait jamais. C'est la règle déjà
 * posée pour le dégradé, on ne l'invente pas ici.
 *
 * D'où des opacités très basses, du même ordre que le filigrane : les étoiles
 * se lisent dans les zones sombres (gouttières du dock, fonds de panneaux,
 * écran de connexion) et se font oublier sur du texte. Une étoile à 60 %
 * par-dessus une liste de fichiers serait insupportable au bout d'une minute.
 *
 * Quatre garde-fous, l'effet étant permanent :
 * - `prefers-reduced-motion` : le ciel est dessiné UNE fois, immobile. Le
 *   supprimer serait dommage, il n'a rien d'agressif ; c'est le mouvement
 *   qui pose problème, pas les étoiles.
 * - la boucle s'arrête quand la fenêtre passe à l'arrière-plan et repart au
 *   retour : personne ne regarde, personne ne paie.
 * - cadence bornée à 20 images par seconde (voir `FPS`).
 * - canevas en `pointer-events: none`, pour ne jamais intercepter un clic,
 *   un glisser-déposer ni la saisie du terminal.
 */
@Component({
  selector: 'app-starfield',
  template: '<canvas #canvas class="starfield" aria-hidden="true"></canvas>',
  styleUrl: './starfield.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Starfield {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly reducedMotion =
    this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;

  private readonly enabled = computed(() => this.theme.accent() === 'stars');

  private context: CanvasRenderingContext2D | null = null;
  private stars: Star[] = [];
  private shooting: Shooting[] = [];
  private frame = 0;
  private width = 0;
  private height = 0;
  private lastDraw = 0;
  private nextShoot = 0;
  private running = false;

  constructor() {
    afterNextRender(() => {
      this.context = this.canvasRef().nativeElement.getContext('2d');
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
    if (!view || on === this.running) {
      return;
    }
    this.running = on;
    if (on) {
      this.resize();
      view.addEventListener('resize', this.onResize, { passive: true });
      this.document.addEventListener('visibilitychange', this.onVisibility);
      this.scheduleShoot();
      // Sans mouvement, un seul dessin suffit : le ciel est là, il ne bouge
      // simplement pas.
      if (this.reducedMotion) {
        this.draw(0);
        return;
      }
      this.loop(0);
      return;
    }
    view.removeEventListener('resize', this.onResize);
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.stop();
    this.stars = [];
    this.shooting = [];
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  private stop(): void {
    if (this.frame) {
      this.document.defaultView?.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  /** Fenêtre masquée : rien à dessiner pour personne. */
  private readonly onVisibility = (): void => {
    if (!this.running || this.reducedMotion) {
      return;
    }
    if (this.document.hidden) {
      this.stop();
    } else if (!this.frame) {
      this.lastDraw = 0;
      this.loop(0);
    }
  };

  private readonly onResize = (): void => {
    this.resize();
    if (this.reducedMotion) {
      this.draw(0);
    }
  };

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
    this.seed();
  }

  /** Sème les étoiles pour la surface courante. Elles ne bougent jamais :
   *  un ciel qui se réarrange à chaque image ne ressemble à rien. */
  private seed(): void {
    const count = Math.min(MAX_STARS, Math.round((this.width * this.height) / DENSITY));
    this.stars = Array.from({ length: count }, () => ({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      radius: 0.4 + Math.random() * 1.1,
      phase: Math.random() * Math.PI * 2,
      // Des vitesses toutes différentes : sinon le ciel clignote en cadence,
      // ce qui se remarque immédiatement et fait mécanique.
      speed: 0.4 + Math.random() * 1.1,
      peak: 0.05 + Math.random() * 0.13,
    }));
  }

  private scheduleShoot(): void {
    this.nextShoot =
      performance.now() + SHOOT_MIN_MS + Math.random() * (SHOOT_MAX_MS - SHOOT_MIN_MS);
  }

  private readonly loop = (now: number): void => {
    this.frame = this.document.defaultView?.requestAnimationFrame(this.loop) ?? 0;
    // La cadence est bornée : on rend la main sans rien dessiner entre deux
    // images utiles.
    if (now - this.lastDraw < FRAME_MS) {
      return;
    }
    const elapsed = this.lastDraw ? now - this.lastDraw : FRAME_MS;
    this.lastDraw = now;
    this.draw(elapsed);
  };

  private draw(elapsed: number): void {
    const context = this.context;
    if (!context) {
      return;
    }
    context.clearRect(0, 0, this.width, this.height);

    const step = elapsed / 1000;
    for (const star of this.stars) {
      star.phase += star.speed * step;
      // Le scintillement : une sinusoïde ramenée entre un quart et la
      // totalité de l'éclat. Aucune étoile ne s'éteint complètement, sinon le
      // ciel a des trous qui clignotent.
      const glow = star.peak * (0.55 + 0.45 * Math.sin(star.phase));
      context.beginPath();
      context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(226, 235, 255, ${glow.toFixed(3)})`;
      context.fill();
    }

    if (!this.reducedMotion) {
      this.drawShooting(context, step);
    }
  }

  private drawShooting(context: CanvasRenderingContext2D, step: number): void {
    const now = performance.now();
    if (now >= this.nextShoot && this.shooting.length < MAX_SHOOTING) {
      this.spawnShooting();
      this.scheduleShoot();
    }

    for (const shot of this.shooting) {
      shot.x += shot.vx * step;
      shot.y += shot.vy * step;
      shot.life -= step * 0.5;

      const tail = shot.length * shot.life;
      const angle = Math.atan2(shot.vy, shot.vx);
      const tailX = shot.x - Math.cos(angle) * tail;
      const tailY = shot.y - Math.sin(angle) * tail;

      // Un dégradé le long de la traînée : la tête est vive, la queue
      // s'éteint. Un trait d'opacité uniforme ferait une rayure, pas une
      // étoile filante.
      const gradient = context.createLinearGradient(shot.x, shot.y, tailX, tailY);
      const head = Math.max(0, Math.min(1, shot.life));
      // La filante s'autorise plus d'éclat que les fixes : elle passe en une
      // seconde, elle ne fatigue personne.
      gradient.addColorStop(0, `rgba(232, 240, 255, ${(head * 0.38).toFixed(3)})`);
      gradient.addColorStop(1, 'rgba(232, 240, 255, 0)');

      context.beginPath();
      context.moveTo(shot.x, shot.y);
      context.lineTo(tailX, tailY);
      context.strokeStyle = gradient;
      context.lineWidth = 1.6;
      context.lineCap = 'round';
      context.stroke();
    }

    // Le nettoyage borne les QUATRE côtés : la version d'avant ne prévoyait
    // pas qu'une filante puisse sortir par la gauche, elle y serait restée à
    // être dessinée dans le vide jusqu'à la fin de sa vie.
    this.shooting = this.shooting.filter(
      (shot) =>
        shot.life > 0 &&
        shot.x > -300 &&
        shot.x < this.width + 300 &&
        shot.y < this.height + 300,
    );
  }

  private spawnShooting(): void {
    // Toujours vers le bas (c'est le sens qu'on attend d'une filante), mais
    // à GAUCHE comme à DROITE, et depuis n'importe quel bord haut ou latéral.
    // Un ciel dont toutes les filantes tombent dans le même coin se remarque
    // en deux minutes et fait décor de théâtre.
    const speed = 380 + Math.random() * 340;
    const toLeft = Math.random() < 0.5;
    // 45° de descente, plus ou moins 15°, miroité quand ça part à gauche.
    const tilt = Math.PI / 4 + (Math.random() - 0.5) * 0.5;
    const angle = toLeft ? Math.PI - tilt : tilt;

    // Le point de départ suit la direction : une filante qui va à droite
    // entre par la gauche ou par le haut, jamais par le bord qu'elle vise.
    const fromSide = Math.random() < 0.35;
    const x = fromSide
      ? (toLeft ? this.width + 20 : -20)
      : Math.random() * this.width;
    const y = fromSide
      ? Math.random() * this.height * 0.5
      : -20 - Math.random() * this.height * 0.1;

    this.shooting.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      length: 90 + Math.random() * 120,
    });
  }
}
