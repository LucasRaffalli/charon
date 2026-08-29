/**
 * Formatage Prettier à l'enregistrement (aperçu v2).
 *
 * Tout est chargé PARESSEUSEMENT par import dynamique : le cœur standalone et
 * les plugins par langage pèsent lourd, ils ne rejoignent le bundle qu'à la
 * première utilisation, jamais au démarrage.
 */

type PluginLoader = () => Promise<unknown[]>;

interface FormatSpec {
  parser: string;
  load: PluginLoader;
}

const babel: PluginLoader = async () =>
  await Promise.all([import('prettier/plugins/babel'), import('prettier/plugins/estree')]);

const typescript: PluginLoader = async () =>
  await Promise.all([import('prettier/plugins/typescript'), import('prettier/plugins/estree')]);

const postcss: PluginLoader = async () => [await import('prettier/plugins/postcss')];

// Le HTML embarque du script et du style : ses plugins viennent avec.
const html: PluginLoader = async () =>
  await Promise.all([
    import('prettier/plugins/html'),
    import('prettier/plugins/postcss'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ]);

const markdown: PluginLoader = async () => [await import('prettier/plugins/markdown')];

const yaml: PluginLoader = async () => [await import('prettier/plugins/yaml')];

/** Par extension (minuscule). Ce que Prettier ne couvre pas (php, rust,
 *  python, shell, conf…) n'est simplement pas formaté. */
const SPECS: Record<string, FormatSpec> = {
  js: { parser: 'babel', load: babel },
  mjs: { parser: 'babel', load: babel },
  cjs: { parser: 'babel', load: babel },
  jsx: { parser: 'babel', load: babel },
  ts: { parser: 'typescript', load: typescript },
  tsx: { parser: 'typescript', load: typescript },
  json: { parser: 'json', load: babel },
  css: { parser: 'css', load: postcss },
  scss: { parser: 'scss', load: postcss },
  less: { parser: 'less', load: postcss },
  html: { parser: 'html', load: html },
  htm: { parser: 'html', load: html },
  md: { parser: 'markdown', load: markdown },
  markdown: { parser: 'markdown', load: markdown },
  yml: { parser: 'yaml', load: yaml },
  yaml: { parser: 'yaml', load: yaml },
};

function specFor(name: string): FormatSpec | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  return SPECS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Un formateur existe-t-il pour ce nom de fichier ? */
export function canFormat(name: string): boolean {
  return specFor(name) !== null;
}

/**
 * Formate `source` selon le type de `name`. Rend `null` si aucun formateur ne
 * couvre ce type ; LÈVE si Prettier n'arrive pas à lire le fichier (syntaxe),
 * à l'appelant de décider quoi en faire, enregistrer tel quel par exemple.
 */
export async function formatCode(name: string, source: string): Promise<string | null> {
  const spec = specFor(name);
  if (!spec) {
    return null;
  }
  const [standalone, plugins] = await Promise.all([import('prettier/standalone'), spec.load()]);
  return standalone.format(source, { parser: spec.parser, plugins: plugins as never });
}
