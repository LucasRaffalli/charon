// Le déclenchement des nouveautés, vérifié sur le code COMPILÉ.
//
// Cette logique ne s'exécute qu'UNE fois par version et par machine, au
// premier lancement : elle ne se voit pas en développement, et une régression
// y passerait inaperçue jusqu'à ce qu'une release entière ne s'annonce plus.
// C'est déjà arrivé deux fois (le silence à la première installation attrapait
// toute mise à jour venue d'avant le marqueur ; l'annonce partait avant la
// réponse du vérificateur).
//
// Le module est RÉÉVALUÉ à chaque cas, avec son `localStorage` posé d'avance.
'use strict';
const path = require('path');

const REPO = process.env.REPO ?? path.join(__dirname, '..', '..');
const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`ÉCHEC  ${label}${extra ? ' :: ' + extra : ''}`);
  }
}

// Les dépendances Angular restent externes : un `require` maison les fournit à
// l'exécution, l'API synchrone d'esbuild n'acceptant pas de plugin.
const stubs = {
  '@angular/core': {
    Injectable: () => (t) => t,
    inject: () => globalThis.__updater,
    signal: (v) => {
      const s = () => v;
      s.set = (x) => {
        v = x;
      };
      s.asReadonly = () => s;
      return s;
    },
  },
  '@app/interfaces': {},
  '@app/services/system/updater.service': { UpdaterService: class {} },
};
const fakeRequire = (id) => (id in stubs ? stubs[id] : require(id));

const built = esbuild.buildSync({
  entryPoints: [path.join(REPO, 'src/app/services/system/whats-new.service.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: Object.keys(stubs),
  loader: { '.json': 'json' },
  absWorkingDir: REPO,
}).outputFiles[0].text;

/** Rejoue un premier lancement : stockage donné, version installée donnée. */
function launch(initial, currentVersion) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
  globalThis.__updater = { currentVersion: () => currentVersion };

  const mod = { exports: {} };
  new Function('module', 'exports', 'require', built)(mod, mod.exports, fakeRequire);
  const service = new mod.exports.WhatsNewService();
  service.showIfUpdated();
  return { service, open: service.open(), seen: () => map.get('charon:seen-version') };
}

// La version installée par le lot de tests : celle du changelog, pour ne pas
// dépendre d'un numéro écrit en dur ici.
const CHANGELOG = require(path.join(REPO, 'src/assets/changelog.json'));
const LATEST = CHANGELOG[0].version;
const PREVIOUS = CHANGELOG[1] ? CHANGELOG[1].version : '0.0.1';

// 1. Première installation (DMG téléchargé) : on annonce quand même. Qui
//    découvre l'application est justement celui qui ne sait pas ce qu'elle fait.
let r = launch({}, LATEST);
check('première installation : les nouveautés s’ouvrent', r.open === true);

// 2. Mise à jour venue d'une version ANTÉRIEURE au marqueur (≤ 1.1.1) : rien
//    dans `charon:seen-version`, mais l'installation a déjà servi.
r = launch({ 'charon:settings': '{}', 'charon:theme': 'dark' }, LATEST);
check('mise à jour d’avant le marqueur : les nouveautés s’ouvrent', r.open === true);

// 3. Mise à jour ordinaire, marqueur présent.
r = launch({ 'charon:seen-version': PREVIOUS, 'charon:settings': '{}' }, LATEST);
check('mise à jour ordinaire : les nouveautés s’ouvrent', r.open === true);

// 4. Version déjà annoncée : plus jamais.
r = launch({ 'charon:seen-version': LATEST, 'charon:settings': '{}' }, LATEST);
check('version déjà annoncée : rien', r.open === false);

// 5. Version sans entrée rédigée : rien à raconter, mais on note pour ne pas
//    y revenir à chaque lancement.
r = launch({ 'charon:settings': '{}' }, '99.99.99');
check('version sans entrée : rien', r.open === false);
check('version sans entrée : notée quand même', r.seen() === '99.99.99', r.seen());

// 6. La version n'est pas encore connue du backend : on ne décide rien.
r = launch({}, '…');
check('version pas encore lue : rien', r.open === false);
check('version pas encore lue : rien de noté', r.seen() === undefined, r.seen());

// 7. Fermer la carte marque la version comme vue.
r = launch({ 'charon:settings': '{}' }, LATEST);
r.service.close();
check('fermer la carte note la version', r.seen() === LATEST, r.seen());
check('fermer la carte referme', r.service.open() === false);

console.log(`\n${pass} vérifications passées, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
