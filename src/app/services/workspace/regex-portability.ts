/**
 * Portabilité des motifs entre les moteurs que Charon fait cohabiter.
 *
 * La palette compile en **JavaScript**, la recherche récursive enverra le motif
 * à **`grep -E`** sur le serveur (POSIX ERE), et un serveur peut disposer de
 * **PCRE2** (`grep -P`). Python n'entre pas dans la chaîne mais partage le même
 * héritage que JavaScript et PCRE2 : ce que ces trois-là comprennent forme un
 * socle commun, et c'est POSIX ERE qui est l'exception.
 *
 * D'où la règle : on écrit dans le socle commun, et tout ce qui n'y est pas est
 * signalé avant de lancer une recherche, pas découvert après coup dans des
 * résultats qui ne correspondent pas.
 */

/**
 * Raccourcis de classe, compris par JS, Python et PCRE2, absents de POSIX ERE.
 * Ils ne se réécrivent qu'en dehors des classes de caractères : `[\d]` et `\d`
 * ne se traduisent pas pareil, et une substitution naïve à l'intérieur
 * produirait une classe imbriquée invalide.
 */
const SHORTHANDS: Readonly<Record<string, string>> = {
  '\\d': '[0-9]',
  '\\D': '[^0-9]',
  '\\w': '[_[:alnum:]]',
  '\\W': '[^_[:alnum:]]',
  '\\s': '[[:space:]]',
  '\\S': '[^[:space:]]',
};

/**
 * Constructions du socle commun que POSIX ERE ne sait pas rendre du tout.
 *
 * Ces règles ne regardent JAMAIS le motif brut : `\\A` est un antislash
 * littéral suivi d'un A, `\??` un point d'interrogation littéral optionnel, et
 * `[(?=]` une classe de trois caractères : aucun des trois n'est une
 * construction. Elles s'appliquent au **squelette** (voir `skeleton`), où les
 * paires échappées et les classes sont réduites à un caractère neutre.
 */
const NOT_IN_ERE: readonly { test: RegExp; label: string }[] = [
  { test: /\(\?=/, label: 'une anticipation (?=…)' },
  { test: /\(\?!/, label: 'une anticipation négative (?!…)' },
  { test: /\(\?<=/, label: 'un retour arrière (?<=…)' },
  { test: /\(\?<!/, label: 'un retour arrière négatif (?<!…)' },
  { test: /\(\?<[A-Za-z]/, label: 'un groupe nommé (?<nom>…)' },
  { test: /[*+?}]\?/, label: 'un quantificateur paresseux (*?, +?, {n,m}?)' },
];

/**
 * Le squelette du motif : chaque paire échappée et chaque classe deviennent le
 * caractère neutre `0`, tout le reste passe tel quel.
 *
 * Le neutre remplace au lieu de supprimer : effacer `\.` dans `a*\.?` collerait
 * le `*` au `?` et fabriquerait un quantificateur paresseux qui n'existe pas.
 * Au passage, les seules constructions PORTÉES par un échappement (référence
 * arrière `\1`, ancres `\A`/`\z`/`\Z`) sont relevées ici, puisqu'elles sont
 * précisément ce que le squelette efface.
 */
function skeleton(source: string): { bones: string; found: string[] } {
  let bones = '';
  const found: string[] = [];
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '\\' && i + 1 < source.length) {
      const next = source[i + 1];
      if (!inClass && next >= '1' && next <= '9') {
        found.push('une référence arrière (\\1)');
      } else if (!inClass && (next === 'A' || next === 'z' || next === 'Z')) {
        found.push(`une ancre \\A, \\z ou \\Z`);
      } else if (inClass && (next === 'D' || next === 'W' || next === 'S')) {
        found.push(`une classe contenant \\D, \\W ou \\S`);
      }
      if (!inClass) {
        bones += '0';
      }
      i++;
      continue;
    }

    if (inClass) {
      if (char === ']') {
        inClass = false;
        bones += '0';
      }
      continue;
    }

    if (char === '[') {
      inClass = true;
      continue;
    }

    bones += char;
  }

  return { bones, found };
}

export interface RegexReport {
  /** Le motif compile en JavaScript. */
  valid: boolean;
  /** Ce qui coince, en clair, quand il ne compile pas. */
  error: string | null;
  /**
   * Constructions qui marchent ici mais que la recherche sur le serveur ne
   * comprendra pas telles quelles.
   */
  notPortable: string[];
  /**
   * Le motif réécrit pour POSIX ERE, ou `null` si une construction
   * intraduisible s'y trouve. Sert de base à la commande distante.
   */
  posix: string | null;
}

/**
 * Traduit le corps d'une classe JavaScript vers une classe POSIX.
 *
 * Dans une classe POSIX, l'antislash n'échappe RIEN : `[\]]` y est lu comme
 * « un antislash, puis un crochet », alors que JavaScript y voit « un
 * crochet ». Recopier la classe telle quelle, ce que faisait la première
 * version, fabriquait donc un motif qui matchait autre chose, le pire des
 * résultats, silencieux. Les règles POSIX sont positionnelles : `]` se met en
 * tête, `-` en queue, `^` jamais en tête, et c'est tout ce qu'une classe sait
 * faire.
 *
 * Renvoie `null` quand le corps ne se traduit pas (un `\D` dans une classe n'a
 * pas d'équivalent) : l'appelant signale au lieu de traduire faux.
 */
function translateClass(body: string, negated: boolean): string | null {
  // Un intervalle dont une borne est échappée (`[\t-x]`, `[a-\]]`) n'a pas de
  // remontage sûr : mieux vaut refuser que traduire un ensemble différent.
  if (/\\.-/.test(body) || /-\\./.test(body)) {
    return null;
  }

  // Fragments qui doivent rester au milieu tels quels : intervalles et
  // classes nommées. `ranges` les garde dans l'ordre d'écriture.
  const ranges: string[] = [];
  const chars: string[] = [];

  const IN_CLASS_SHORTHANDS: Record<string, string> = {
    d: '0-9',
    w: '[:alnum:]_',
    s: '[:space:]',
  };
  const CONTROL: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };

  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (char === '\\') {
      const next = body[i + 1] ?? '';
      const shorthand = IN_CLASS_SHORTHANDS[next];
      if (shorthand) {
        ranges.push(shorthand);
      } else if (CONTROL[next]) {
        chars.push(CONTROL[next]);
      } else if ('DWSb'.includes(next)) {
        // \D, \W, \S n'ont pas de forme POSIX dans une classe ; \b y est un
        // caractère de contrôle (backspace) que personne n'a voulu taper.
        return null;
      } else {
        chars.push(next);
      }
      i++;
      continue;
    }

    // Un intervalle : deux caractères NON échappés autour d'un tiret.
    if (body[i + 1] === '-' && i + 2 < body.length && body[i + 2] !== '\\') {
      ranges.push(body.slice(i, i + 3));
      i += 2;
      continue;
    }

    chars.push(char);
  }

  // Remontage positionnel. Les doublons sont retirés au passage : `[\]-]`
  // et `[\]\-]` doivent produire la même classe.
  const members = [...new Set(chars)];
  const bracket = members.includes(']');
  const dash = members.includes('-');
  // Le `^` recule en fin de rang : en tête il nierait la classe, ailleurs il
  // est un caractère comme un autre. `[\^a]` devient ainsi `[a^]`.
  const middle = members
    .filter((c) => c !== ']' && c !== '-')
    .sort((a, b) => (a === '^' ? 1 : 0) - (b === '^' ? 1 : 0));

  // Une classe d'un seul caractère ordinaire se passe de classe : c'est aussi
  // ce qui règle `[\^]`, qu'une classe POSIX ne sait pas dire seul.
  const inner = (bracket ? ']' : '') + ranges.join('') + middle.join('') + (dash ? '-' : '');
  if (!negated && !ranges.length && members.length === 1) {
    const only = members[0];
    return /[a-zA-Z0-9]/.test(only) ? only : `\\${only}`;
  }
  if (!inner) {
    return null;
  }
  // `^` en tête d'une classe non niée la transformerait en négation : le
  // remontage ne l'y met jamais (les intervalles et `]` passent devant, et une
  // classe qui n'aurait QUE `^` est sortie de classe juste au-dessus).
  if (!negated && inner.startsWith('^')) {
    return null;
  }
  return `[${negated ? '^' : ''}${inner}]`;
}

/**
 * Réécrit vers POSIX ERE ce qui peut l'être.
 *
 * Le parcours est fait à la main plutôt qu'avec un remplacement global : savoir
 * si l'on se trouve dans un `[...]` demande de suivre les échappements, ce
 * qu'une expression régulière ne fait pas. Renvoie `null` si une classe ne se
 * traduit pas.
 */
function toPosix(source: string): string | null {
  let out = '';

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '\\' && i + 1 < source.length) {
      const pair = source.slice(i, i + 2);
      out += SHORTHANDS[pair] ?? pair;
      i++;
      continue;
    }

    // POSIX n'a pas de groupe non capturant, mais un groupe capturant fait le
    // même travail : grep ne se sert pas des captures.
    if (char === '(' && source.slice(i, i + 3) === '(?:') {
      out += '(';
      i += 2;
      continue;
    }

    if (char === '[') {
      // Fin de classe, échappements suivis : le même parcours que JavaScript.
      let end = -1;
      for (let j = i + 1; j < source.length; j++) {
        if (source[j] === '\\') {
          j++;
        } else if (source[j] === ']') {
          end = j;
          break;
        }
      }
      if (end === -1) {
        return null;
      }
      const raw = source.slice(i + 1, end);
      const negated = raw.startsWith('^');
      const translated = translateClass(negated ? raw.slice(1) : raw, negated);
      if (translated === null) {
        return null;
      }
      out += translated;
      i = end;
      continue;
    }

    out += char;
  }

  return out;
}

/** Analyse un motif : validité, portabilité, et sa forme POSIX si elle existe. */
export function analysePattern(source: string): RegexReport {
  if (!source) {
    return { valid: true, error: null, notPortable: [], posix: '' };
  }

  try {
    new RegExp(source);
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? cleanMessage(error.message) : 'motif invalide',
      notPortable: [],
      posix: null,
    };
  }

  const { bones, found } = skeleton(source);
  const notPortable = [
    ...NOT_IN_ERE.filter((rule) => rule.test.test(bones)).map((rule) => rule.label),
    ...new Set(found),
  ];

  const posix = notPortable.length ? null : toPosix(source);
  if (posix === null && !notPortable.length) {
    // Le squelette n'a rien vu mais la traduction a calé (une classe au
    // remontage impossible) : le refus doit se lire, pas se deviner.
    notPortable.push('une classe de caractères sans équivalent POSIX');
  }

  return {
    valid: true,
    error: null,
    notPortable,
    posix,
  };
}

/** Le message du moteur, débarrassé de son préfixe technique. */
function cleanMessage(message: string): string {
  return message
    .replace(/^Invalid regular expression:\s*\/.*\/[a-z]*:\s*/i, '')
    .replace(/^Invalid regular expression:\s*/i, '')
    .toLowerCase();
}
