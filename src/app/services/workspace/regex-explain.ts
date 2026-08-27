/**
 * Lire un motif à voix haute.
 *
 * Une expression régulière est une chose qu'on écrit plus souvent qu'on ne la
 * relit : à la troisième parenthèse, personne ne sait plus très bien ce qu'il
 * vient de demander. Ce module traduit le motif en français et rappelle les
 * symboles qui s'y trouvent, pour qu'on voie ce qu'on cherche avant de le
 * chercher.
 *
 * La description est **dérivée mécaniquement** de la structure lue, jamais
 * devinée : mieux vaut une phrase plate et juste qu'une paraphrase élégante et
 * fausse, qui ferait chercher autre chose que ce qu'on croit.
 */

/** Un symbole présent dans le motif, et ce qu'il fait. */
export interface RegexSymbol {
  symbol: string;
  meaning: string;
}

export interface RegexExplanation {
  /** Ce que le motif cherche, en français. Vide si rien n'est lisible. */
  plain: string;
  /**
   * Des noms qui correspondent, fabriqués depuis le motif puis **vérifiés
   * contre lui**. Une paraphrase se discute, un exemple non : c'est ce qui
   * montre le plus vite qu'on a écrit autre chose que ce qu'on voulait.
   */
  samples: string[];
  /** Les symboles réellement utilisés, dans l'ordre où ils ont été rencontrés. */
  legend: RegexSymbol[];
  /** Ce qui empêche le motif de compiler, avec la position fautive. */
  error: { message: string; index: number } | null;
}

/** Sens des raccourcis de classe, tels qu'ils apparaissent dans la légende. */
const SHORTHAND_MEANING: Readonly<Record<string, string>> = {
  d: 'un chiffre',
  D: 'tout sauf un chiffre',
  w: 'une lettre, un chiffre ou _',
  W: 'tout sauf une lettre ou un chiffre',
  s: 'une espace',
  S: 'tout sauf une espace',
  b: 'un bord de mot',
};

/** Un morceau de motif reconnu, avec de quoi le décrire. */
interface Token {
  /** Ce que le morceau désigne, sans son quantificateur. */
  text: string;
  /** Le quantificateur qui le suit, tel qu'il est écrit. */
  quantifier: string;
  /** Un littéral se colle à son voisin, un groupe non. */
  literal: boolean;
}

/**
 * La fin d'une classe de caractères, échappements compris.
 *
 * Un `indexOf(']')` s'arrêtait sur un `]` échappé : `[\]]` était coupé au
 * mauvais crochet, la description parlait d'un antislash et l'exemple en
 * traînait un. Le seul crochet qui ferme est un crochet non échappé.
 */
function classEnd(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
    } else if (source[i] === ']') {
      return i;
    }
  }
  return -1;
}

/** Le corps d'une classe tel qu'on le montre : sans les antislashs de service. */
function unescapeClassBody(body: string): string {
  return body.replace(/\\(.)/g, '$1');
}

/**
 * Vérifie que le motif se referme.
 *
 * `new RegExp` dit qu'un motif est invalide mais pas où, et « Unterminated
 * group » sans position n'aide personne à corriger. Le parcours suit les
 * échappements et les classes, donc une parenthèse dans `[(]` ou après `\` ne
 * compte pas comme une ouverture.
 */
function findStructuralError(source: string): { message: string; index: number } | null {
  const open: number[] = [];
  let classStart = -1;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '\\') {
      if (i === source.length - 1) {
        return { message: "La barre oblique finale n'a rien à échapper.", index: i };
      }
      i++;
      continue;
    }

    if (classStart >= 0) {
      if (char === ']') {
        classStart = -1;
      }
      continue;
    }

    if (char === '[') {
      classStart = i;
    } else if (char === '(') {
      open.push(i);
    } else if (char === ')') {
      if (!open.length) {
        return { message: `La parenthèse fermée en position ${i + 1} n'a jamais été ouverte.`, index: i };
      }
      open.pop();
    } else if ((char === '*' || char === '+' || char === '?') && i === 0) {
      return { message: `Le quantificateur « ${char} » n'a rien à répéter.`, index: i };
    }
  }

  if (classStart >= 0) {
    return {
      message: `Le crochet ouvert en position ${classStart + 1} n'est jamais refermé.`,
      index: classStart,
    };
  }
  if (open.length) {
    const at = open[open.length - 1];
    return {
      message: `La parenthèse ouverte en position ${at + 1} n'est jamais refermée.`,
      index: at,
    };
  }
  return null;
}

/**
 * Le quantificateur débarrassé de sa paresse.
 *
 * `*?`, `+?` et `{n,m}?` ne cherchent pas autre chose que `*`, `+` et `{n,m}`,
 * seulement différemment : le `?` final ne compte pas ici. Mais `?` tout seul
 * EST un quantificateur, et le retirer sans regarder la longueur le réduisait à
 * une chaîne vide : `x?` se décrivait alors comme un `x` obligatoire, et la
 * légende annonçait « un nombre de fois » au lieu de « zéro ou une fois ».
 */
function bareQuantifier(quantifier: string): string {
  return quantifier.length > 1 && quantifier.endsWith('?')
    ? quantifier.slice(0, -1)
    : quantifier;
}

/** Lit le quantificateur qui suit la position donnée, s'il y en a un. */
function readQuantifier(source: string, at: number): string {
  const char = source[at];
  if (char === '*' || char === '+' || char === '?') {
    // Un quantificateur paresseux ne change pas ce qui est cherché, seulement
    // la façon de le trouver : inutile de l'expliquer ici.
    return source[at + 1] === '?' ? char + '?' : char;
  }
  if (char === '{') {
    const end = source.indexOf('}', at);
    const body = end > at ? source.slice(at + 1, end) : '';
    return end > at && /^\d+(,\d*)?$/.test(body) ? source.slice(at, end + 1) : '';
  }
  return '';
}

/** Met une description au pluriel de son quantificateur. */
function applyQuantifier(text: string, quantifier: string): string {
  const bare = bareQuantifier(quantifier);
  if (!bare) {
    return text;
  }
  if (bare === '?') {
    return `éventuellement ${text}`;
  }
  // Le quantificateur se place APRÈS : « un chiffre, une fois ou plus » plutôt
  // que « au moins un un chiffre ». Une description construite par morceaux ne
  // peut pas accorder ce qu'elle ne connaît pas.
  if (bare === '*') {
    return `${text}, zéro fois ou plus`;
  }
  if (bare === '+') {
    return `${text}, une fois ou plus`;
  }
  const body = bare.slice(1, -1);
  const [min, max] = body.split(',');
  if (max === undefined) {
    return `${text}, ${min} fois`;
  }
  return max === '' ? `${text}, au moins ${min} fois` : `${text}, de ${min} à ${max} fois`;
}

/** Découpe le motif en morceaux décrivables, du plus simple au plus imbriqué. */
function tokenize(source: string, seen: Map<string, string>): Token[] {
  const tokens: Token[] = [];
  let literal = '';

  const flushLiteral = (): void => {
    if (literal) {
      tokens.push({ text: `« ${literal} »`, quantifier: '', literal: true });
      literal = '';
    }
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '^' && i === 0) {
      seen.set('^ $', 'tout le nom');
      continue;
    }
    if (char === '$' && i === source.length - 1) {
      seen.set('^ $', 'tout le nom');
      continue;
    }

    if (char === '\\') {
      const next = source[i + 1] ?? '';
      const meaning = SHORTHAND_MEANING[next];
      if (meaning) {
        flushLiteral();
        seen.set(`\\${next}`, meaning);
        const quantifier = readQuantifier(source, i + 2);
        if (quantifier) {
          seen.set(legendKey(quantifier), quantifierMeaning(quantifier));
        }
        tokens.push({ text: meaning, quantifier, literal: false });
        i += 1 + quantifier.length;
      } else {
        // Un caractère échappé n'est plus un symbole : il se lit tel quel.
        seen.set(`\\${next}`, `le caractère ${next}`);
        literal += next;
        i++;
      }
      continue;
    }

    if (char === '[') {
      const end = classEnd(source, i);
      if (end === -1) {
        break;
      }
      flushLiteral();
      const body = source.slice(i + 1, end);
      const negated = body.startsWith('^');
      seen.set('[…]', negated ? 'aucun de ces caractères' : "l'un de ces caractères");
      const inner = unescapeClassBody(negated ? body.slice(1) : body);
      const text = negated ? `aucun de ${inner}` : `l'un de ${inner}`;
      const quantifier = readQuantifier(source, end + 1);
      tokens.push({ text, quantifier, literal: false });
      i = end + quantifier.length;
      continue;
    }

    if (char === '(') {
      // Trouver la parenthèse fermante qui va avec, échappements compris.
      let depth = 0;
      let end = -1;
      for (let j = i; j < source.length; j++) {
        if (source[j] === '\\') {
          j++;
        } else if (source[j] === '(') {
          depth++;
        } else if (source[j] === ')') {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) {
        break;
      }
      flushLiteral();
      let body = source.slice(i + 1, end);
      if (body.startsWith('?:')) {
        body = body.slice(2);
      }
      const branches = splitAlternatives(body);
      if (branches.length > 1) {
        seen.set('(a|b)', "l'un ou l'autre");
      }
      const text = branches.map((b) => describe(b, seen)).filter(Boolean).join(' ou ');
      const quantifier = readQuantifier(source, end + 1);
      if (quantifier) {
        seen.set(legendKey(quantifier), quantifierMeaning(quantifier));
      }
      if (quantifier) {
        seen.set(legendKey(quantifier), quantifierMeaning(quantifier));
      }
      // Sans parenthèses, « éventuellement a, puis b » laisse croire que seul
      // « a » est facultatif.
      const grouped = quantifier && text.includes(', puis ') ? `(${text})` : text;
      tokens.push({ text: grouped || 'un groupe', quantifier, literal: false });
      i = end + quantifier.length;
      continue;
    }

    if (char === '.') {
      flushLiteral();
      seen.set('.', "n'importe quel caractère");
      const quantifier = readQuantifier(source, i + 1);
      if (quantifier) {
        seen.set(legendKey(quantifier), quantifierMeaning(quantifier));
      }
      tokens.push({ text: "n'importe quel caractère", quantifier, literal: false });
      i += quantifier.length;
      continue;
    }

    const quantifier = readQuantifier(source, i + 1);
    if (quantifier) {
      // Le quantificateur ne porte que sur le caractère juste avant lui.
      flushLiteral();
      seen.set(legendKey(quantifier), quantifierMeaning(quantifier));
      tokens.push({ text: `« ${char} »`, quantifier, literal: false });
      i += quantifier.length;
      continue;
    }

    literal += char;
  }

  flushLiteral();
  return tokens;
}

/**
 * Le quantificateur tel qu'il s'écrit en légende.
 *
 * Les chiffres sont gardés : maintenant que le sens donne les vraies bornes
 * (« entre 2 et 5 fois »), généraliser la clé en `{n,n}` ferait s'écraser deux
 * quantificateurs différents du même motif, et la légende annoncerait les
 * bornes de l'un pour la forme de l'autre. Seule la paresse tombe, elle ne
 * change pas ce qui est cherché.
 */
function legendKey(quantifier: string): string {
  return bareQuantifier(quantifier);
}

function quantifierMeaning(quantifier: string): string {
  const bare = bareQuantifier(quantifier);
  if (bare === '?') return 'zéro ou une fois';
  if (bare === '*') return 'zéro fois ou plus';
  if (bare === '+') return 'une fois ou plus';
  // Les accolades aussi méritent mieux qu'un « un nombre de fois » qui laisse
  // exactement le doute qu'une légende est censée lever.
  const body = bare.slice(1, -1);
  const [min, max] = body.split(',');
  if (max === undefined) return `exactement ${min} fois`;
  return max === '' ? `${min} fois ou plus` : `entre ${min} et ${max} fois`;
}

/** Coupe sur les `|` du premier niveau seulement. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\') {
      current += char + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      inClass = char !== ']';
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (char === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Assemble la description d'une suite de morceaux. */
function describe(source: string, seen: Map<string, string>): string {
  const tokens = tokenize(source, seen);
  if (!tokens.length) {
    return '';
  }
  return tokens
    .map((token) => applyQuantifier(token.text, token.quantifier))
    .join(', puis ');
}

/** De quoi remplir un raccourci de classe quand on fabrique un exemple. */
const SHORTHAND_SAMPLE: Readonly<Record<string, string>> = {
  d: '7',
  D: 'x',
  w: 'a',
  W: '-',
  s: ' ',
  S: 'a',
  b: '',
};

/**
 * Fabrique un nom qui suit le motif.
 *
 * `variant` fait tourner les choix : quelle branche d'une alternative prendre,
 * et si l'on garde ce qui est facultatif. Deux ou trois passes suffisent à
 * montrer ce que le motif accepte de plus différent.
 *
 * Rien de ce qui sort d'ici n'est affiché sans avoir été repassé au motif :
 * un exemple faux serait pire que pas d'exemple du tout.
 */
function generate(source: string, variant: number): string {
  // Un `|` hors groupe coupe le motif en branches dont UNE seule doit sortir :
  // sans cette coupe, `a|b` produisait l'exemple « a|b », qui passait même le
  // filtre puisqu'il contient bien un a.
  const branches = splitAlternatives(source);
  if (branches.length > 1) {
    return generate(branches[variant % branches.length], variant);
  }

  let out = '';

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '^' || char === '$') {
      continue;
    }

    if (char === '\\') {
      const next = source[i + 1] ?? '';
      const quantifier = readQuantifier(source, i + 2);
      const unit = SHORTHAND_SAMPLE[next] ?? next;
      out += repeat(unit, quantifier, variant);
      i += 1 + quantifier.length;
      continue;
    }

    if (char === '[') {
      const end = classEnd(source, i);
      if (end === -1) {
        break;
      }
      const body = source.slice(i + 1, end);
      const quantifier = readQuantifier(source, end + 1);
      out += repeat(sampleFromClass(body), quantifier, variant);
      i = end + quantifier.length;
      continue;
    }

    if (char === '(') {
      const end = matchingParen(source, i);
      if (end === -1) {
        break;
      }
      let body = source.slice(i + 1, end);
      if (body.startsWith('?:')) {
        body = body.slice(2);
      }
      const branches = splitAlternatives(body);
      const branch = branches[variant % branches.length];
      const quantifier = readQuantifier(source, end + 1);
      out += repeat(generate(branch, variant), quantifier, variant);
      i = end + quantifier.length;
      continue;
    }

    if (char === '.') {
      const quantifier = readQuantifier(source, i + 1);
      out += repeat('x', quantifier, variant);
      i += quantifier.length;
      continue;
    }

    const quantifier = readQuantifier(source, i + 1);
    if (quantifier) {
      out += repeat(char, quantifier, variant);
      i += quantifier.length;
      continue;
    }

    out += char;
  }

  return out;
}

/** Applique un quantificateur à un morceau d'exemple. */
function repeat(unit: string, quantifier: string, variant: number): string {
  const bare = bareQuantifier(quantifier);
  if (!bare) {
    return unit;
  }
  // La première passe montre le motif dépouillé, les suivantes le remplissent.
  if (bare === '?') {
    return variant === 0 ? '' : unit;
  }
  if (bare === '*') {
    return variant === 0 ? '' : unit;
  }
  if (bare === '+') {
    return variant === 0 ? unit : unit + unit;
  }
  const body = bare.slice(1, -1);
  const min = Number.parseInt(body.split(',')[0] ?? '1', 10);
  return unit.repeat(Number.isFinite(min) ? Math.min(min, 8) : 1);
}

/** Un caractère plausible pour une classe, intervalles compris. */
function sampleFromClass(body: string): string {
  if (body.startsWith('^')) {
    // Le complément d'une classe : n'importe quoi qui n'y est pas.
    const excluded = body.slice(1);
    for (const candidate of 'axz0-_') {
      if (!excluded.includes(candidate)) {
        return candidate;
      }
    }
    return 'x';
  }
  const range = /^(.)-(.)/.exec(body);
  if (range) {
    return range[1];
  }
  const first = body.replace(/\\(.)/g, '$1')[0];
  return first ?? 'x';
}

/** La parenthèse fermante qui correspond, échappements compris. */
function matchingParen(source: string, start: number): number {
  let depth = 0;
  for (let j = start; j < source.length; j++) {
    if (source[j] === '\\') {
      j++;
    } else if (source[j] === '(') {
      depth++;
    } else if (source[j] === ')') {
      depth--;
      if (depth === 0) {
        return j;
      }
    }
  }
  return -1;
}

/**
 * Trois exemples au plus, tous repassés au motif avant d'être montrés.
 *
 * Le générateur est une approximation : il ne sait pas tout construire, et une
 * anticipation ou une référence arrière lui échappent. Le filtre règle la
 * question sans qu'on ait à énumérer ce qu'il gère : ce qui ne correspond pas
 * ne sort pas.
 */
function collectSamples(source: string): string[] {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (let variant = 0; variant < 3 && found.length < 3; variant++) {
    const candidate = generate(source, variant);
    if (candidate && !found.includes(candidate) && pattern.test(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * Explique un motif : ce qu'il cherche, avec quoi, et ce qui l'empêche de
 * compiler.
 */
export function explainPattern(source: string): RegexExplanation {
  if (!source) {
    return { plain: '', samples: [], legend: [], error: null };
  }

  const structural = findStructuralError(source);
  if (structural) {
    return { plain: '', samples: [], legend: [], error: structural };
  }

  try {
    new RegExp(source);
  } catch (error) {
    return {
      plain: '',
      samples: [],
      legend: [],
      // Sans position identifiable, le message du moteur reste ce qu'on a de
      // plus précis : le déguiser en phrase française n'ajouterait rien.
      error: {
        message: error instanceof Error ? error.message.replace(/^Invalid regular expression:.*?:\s*/, '') : 'motif invalide',
        index: -1,
      },
    };
  }

  const seen = new Map<string, string>();
  const branches = splitAlternatives(source);
  const anchored = source.startsWith('^') && source.endsWith('$');
  const body = branches.map((b) => describe(b, seen)).filter(Boolean).join(', ou bien ');

  if (branches.length > 1) {
    seen.set('(a|b)', "l'un ou l'autre");
  }

  const plain = body ? (anchored ? `exactement ${body}` : `un nom qui contient ${body}`) : '';

  return {
    plain,
    samples: collectSamples(source),
    legend: [...seen].map(([symbol, meaning]) => ({ symbol, meaning })),
    error: null,
  };
}
