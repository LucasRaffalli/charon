import { Injectable, computed, inject, signal } from '@angular/core';

import { fr } from './fr';
import { SettingsService } from '@app/services/system/settings.service';

/**
 * La forme du dictionnaire, dictée par le français (voir `fr.ts`).
 *
 * Les feuilles sont ÉLARGIES à `string` : `fr` est déclaré `as const`, donc
 * ses valeurs sont des types littéraux (« Créer » et non `string`). Sans cet
 * élargissement, l'anglais devrait écrire les mots français pour compiler.
 * L'arborescence, elle, reste imposée au détail près : c'est ce qu'on veut
 * vérifier.
 */
export type Dictionary = Widen<typeof fr>;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

/** Les langues servies. Le français est la source, jamais une traduction. */
export type Lang = 'fr' | 'en';

/**
 * Tous les chemins de clés en notation pointée : `files.delete.dir.title`,
 * `common.buttons.create`…
 *
 * C'est ce qui rend `t()` vérifiable à la compilation : une clé mal tapée ne
 * compile pas, et renommer une branche fait apparaître tous ses appelants au
 * lieu de laisser des trous à l'écran.
 */
export type TranslationKey = Leaves<typeof fr>;

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

/** Les valeurs injectées dans les jetons `{nom}`. */
export type Vars = Record<string, string | number>;

/**
 * La traduction de l'interface.
 *
 * L'anglais est chargé **à la demande** : tant que personne ne change de
 * langue, son dictionnaire ne pèse rien dans le paquet initial. La langue
 * courante vit dans les réglages, donc elle est persistée, exportée et
 * synchronisée entre fenêtres sans une ligne de plus.
 *
 * Rien ici ne touche aux messages venus du serveur : ils arrivent dans la
 * langue du serveur, et les traduire serait mentir sur ce qu'il a répondu.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly settings = inject(SettingsService);

  /**
   * Le dictionnaire anglais une fois arrivé. Un SIGNAL, pas un champ : c'est
   * son arrivée qui doit redessiner l'écran, et un champ ordinaire ne
   * réveillerait rien.
   */
  private readonly loaded = signal<Dictionary | null>(null);

  readonly lang = computed<Lang>(() => this.settings.lang());

  private readonly dict = computed<Dictionary>(() => {
    const loaded = this.loaded();
    return this.lang() === 'en' && loaded ? loaded : fr;
  });

  constructor() {
    // Au démarrage en anglais, le dictionnaire est chargé sans attendre un
    // geste. Le temps qu'il arrive, `dict` rend le français : un écran dans
    // la mauvaise langue vaut mieux qu'un écran vide ou constellé de clés.
    if (this.settings.lang() === 'en') {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    if (!this.loaded()) {
      this.loaded.set((await import('./en')).en);
    }
  }

  /** Change la langue, et charge son dictionnaire si besoin. */
  async use(lang: Lang): Promise<void> {
    if (lang === 'en') {
      await this.load();
    }
    this.settings.update({ lang });
  }


  /**
   * La chaîne d'une clé dont le nom vient d'AILLEURS (le backend), donc non
   * vérifiable à la compilation. Rend `null` si la clé n'existe pas, pour que
   * l'appelant décide du repli : afficher « errors.machin » à l'écran serait
   * pire que le message d'origine.
   */
  readonly lookup = (key: string): string | null => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], this.dict());
    return typeof value === 'string' ? value : null;
  };

  /**
   * La chaîne d'une clé, jetons remplis.
   *
   * Rend la clé elle-même si le chemin ne mène nulle part : à l'écran, une
   * clé visible se remarque et se corrige, là où une chaîne vide passe
   * inaperçue jusqu'à ce qu'un utilisateur la signale.
   */
  readonly t = (key: TranslationKey, vars?: Vars): string => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], this.dict());
    if (typeof value !== 'string') {
      return key;
    }
    return vars
      ? value.replace(/\{(\w+)\}/g, (whole, name: string) =>
          name in vars ? String(vars[name]) : whole,
        )
      : value;
  };
}

/**
 * `protected readonly t = injectT();` dans un composant, puis `{{ t('clé') }}`
 * dans son gabarit.
 *
 * Une fonction et non un pipe : `t` lit le signal de langue, donc un composant
 * qui l'appelle se redessine quand la langue change, ce qu'un pipe pur ne
 * ferait pas, et ce qu'un pipe impur ferait à chaque cycle de détection.
 */
export function injectT(): I18nService['t'] {
  return inject(I18nService).t;
}

/**
 * Traduit une erreur venue du backend.
 *
 * Rust ne renvoie pas de phrase mais `CHARON_ERR:<code>` suivi du détail brut
 * (voir `src-tauri/src/errors.rs`). On traduit le code et on garde le détail
 * tel quel : un chemin ne se traduit pas, et le message du système est dans
 * SA langue, le réécrire serait prétendre qu'il a dit autre chose.
 *
 * Tout ce qui n'est pas codé ressort inchangé : les messages non encore
 * convertis continuent de s'afficher comme avant, la migration peut se faire
 * message par message sans jamais casser l'affichage.
 */
export function injectErrorText(): (raw: unknown) => string {
  const i18n = inject(I18nService);
  return (raw: unknown) => {
    const text =
      typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw);
    const match = /^CHARON_ERR:([a-z_]+)(?:\u001f([\s\S]*))?$/.exec(text);
    if (!match) {
      return text;
    }
    const translated = i18n.lookup(`errors.${match[1]}`);
    if (!translated) {
      // Code inconnu de ce dictionnaire (backend plus récent que le front) :
      // le détail seul reste plus utile qu'un nom de clé.
      return match[2] || text;
    }
    return match[2] ? `${translated} : ${match[2]}` : translated;
  };
}
