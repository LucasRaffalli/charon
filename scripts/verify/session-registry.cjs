// Invariants du SessionRegistry, vérifiés sur le code COMPILÉ : focus,
// création/fermeture, vue double, previewOwner, restore après reload,
// persistance des onglets et dissolution du split. Les primitives Angular
// sont remplacées par des implémentations minimales RÉELLES (signaux à
// relecture, effects rejoués à la main) : la logique testée est bien celle
// du fichier source, pas une copie.
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require(path.join(process.env.REPO ?? path.join(__dirname, '..', '..'), 'node_modules', 'esbuild'));

const REPO = process.env.REPO ?? path.join(__dirname, '..', '..');

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

// --- sessionStorage factice -------------------------------------------------
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

// --- Fabrique un module registre FRAIS (compteur de sessions remis à 1) -----
function freshWorld() {
  const effects = [];
  const NG = {
    signal(v) {
      const s = () => v;
      s.set = (x) => {
        v = x;
      };
      s.update = (f) => {
        v = f(v);
      };
      s.asReadonly = () => () => v;
      return s;
    },
    computed: (fn) => fn,
    effect: (fn) => {
      effects.push(fn);
      fn();
      return { destroy() {} };
    },
    untracked: (fn) => fn(),
    inject: () => ({}),
    Injectable: () => (target) => target,
    EnvironmentInjector: class {},
    createEnvironmentInjector: (providers) => {
      const services = new Map();
      const inj = {
        destroyed: false,
        get(token) {
          if (!services.has(token)) {
            if (token === TOK.sftp) {
              services.set(token, {
                _settled: true,
                settled() {
                  return this._settled;
                },
                connected() {
                  return this._settled;
                },
              });
            } else if (token === TOK.preview) {
              services.set(token, {
                _open: false,
                _at: 0,
                open() {
                  return this._open;
                },
                openedAt() {
                  return this._at;
                },
              });
            } else {
              services.set(token, {});
            }
          }
          return services.get(token);
        },
        destroy() {
          inj.destroyed = true;
        },
      };
      return inj;
    },
  };

  const TOK = { sftp: { tok: 'sftp' }, preview: { tok: 'preview' }, sid: { tok: 'sid' } };
  const storage = makeStorage();
  global.sessionStorage = storage;
  global.localStorage = makeStorage();

  const cache = new Map();
  function stubFor(spec) {
    if (!cache.has(spec)) {
      const stub = new Proxy(function () {}, {
        get: (t, p) => (p === Symbol.toPrimitive ? () => spec : stub),
        construct: () => ({}),
      });
      cache.set(spec, stub);
    }
    return cache.get(spec);
  }

  const src = fs.readFileSync(
    path.join(REPO, 'src/app/services/connection/session-registry.ts'),
    'utf8',
  );
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const module = { exports: {} };
  const req = (spec) => {
    if (spec === '@angular/core') {
      return NG;
    }
    if (spec.endsWith('sftp.service')) {
      return { SftpService: TOK.sftp };
    }
    if (spec.endsWith('preview.service')) {
      return { PreviewService: TOK.preview };
    }
    if (spec.endsWith('session-token')) {
      return { SESSION_ID: TOK.sid };
    }
    return stubFor(spec);
  };
  new Function('require', 'module', 'exports', code)(req, module, module.exports);

  const registry = new module.exports.SessionRegistry();
  const flush = () => effects.forEach((fn) => fn());
  return { registry, flush, storage };
}

// --- 1. ensure/focused/create ----------------------------------------------
{
  const { registry } = freshWorld();
  let threw = false;
  try {
    registry.focused();
  } catch {
    threw = true;
  }
  check('focused() sans session lève', threw);

  const s1 = registry.ensure();
  check('ensure crée s1', s1.id === 's1' && registry.sessions().length === 1);
  check('ensure idempotent', registry.ensure() === s1 && registry.sessions().length === 1);
  check('focused = s1', registry.focused() === s1);

  const s2 = registry.create();
  check('create focalise la nouvelle', registry.focused() === s2);
  check('deux sessions', registry.sessions().length === 2);

  registry.focus('s1');
  check('focus s1', registry.focused() === s1);
  registry.focus('szz');
  check('focus inconnu ignoré', registry.focused() === s1);
}

// --- 2. toneOf : cycle 1..4, stable ------------------------------------------
{
  const { registry } = freshWorld();
  const ids = [registry.create(), registry.create(), registry.create(), registry.create(), registry.create()];
  const tones = ids.map((session) => registry.toneOf(session));
  check('tons s1..s5 = 1,2,3,4,1', JSON.stringify(tones) === '[1,2,3,4,1]', JSON.stringify(tones));
}

// --- 3. split / unsplit / displayed ------------------------------------------
{
  const { registry } = freshWorld();
  const s1 = registry.ensure();
  const s2 = registry.create();
  const s3 = registry.create();

  registry.split('s1', 's2');
  check('split posé', JSON.stringify(registry.pair()) === '["s1","s2"]');
  check('split au premier plan', registry.showingPair() === true);
  check('focus hors paire -> droite', registry.focused() === s2);
  check(
    'displayed = [gauche, droite]',
    registry.displayed().length === 2 &&
      registry.displayed()[0] === s1 &&
      registry.displayed()[1] === s2,
  );

  registry.focus('s3');
  check('focaliser un simple range la paire', registry.showingPair() === false);
  check('la paire survit', JSON.stringify(registry.pair()) === '["s1","s2"]');
  check('displayed = [s3]', registry.displayed().length === 1 && registry.displayed()[0] === s3);

  registry.focus('s1');
  check('focaliser un membre ramène la vue double', registry.showingPair() === true);
  check('displayed re-double', registry.displayed().length === 2);

  registry.unsplit();
  check('unsplit', registry.pair() === null && registry.showingPair() === false);

  // Refus : même session, session inconnue, membre pas settled.
  registry.split('s1', 's1');
  check('split s1/s1 refusé', registry.pair() === null);
  registry.split('s1', 'szz');
  check('split inconnu refusé', registry.pair() === null);
  s2.sftp._settled = false;
  registry.split('s1', 's2');
  check('split membre non settled refusé', registry.pair() === null);
}

// --- 4. close : garde-fous et focus ------------------------------------------
{
  const { registry } = freshWorld();
  const s1 = registry.ensure();
  registry.close('s1');
  check('la dernière session ne se ferme pas', registry.sessions().length === 1);

  const s2 = registry.create();
  const s3 = registry.create();
  registry.close('szz');
  check('close inconnu ignoré', registry.sessions().length === 3);

  // Fermer un membre de la paire : dissolution + focus au partenaire.
  registry.split('s2', 's3');
  registry.close('s3');
  check('membre fermé -> paire dissoute', registry.pair() === null);
  check('focus au partenaire', registry.focused() === s2);
  check('injecteur détruit', s3.injector.destroyed === true);

  // Fermer la focalisée hors paire : la dernière restante prend le focus.
  registry.close('s2');
  check('focus retombe sur la survivante', registry.focused() === s1);

  // Fermer une non-focalisée ne bouge pas le focus.
  const s4 = registry.create();
  registry.focus('s1');
  registry.close(s4.id);
  check('close non focalisée : focus intact', registry.focused() === s1);
}

// --- 5. previewOwner : guidé par l'usage -------------------------------------
{
  const { registry } = freshWorld();
  const s1 = registry.ensure();
  const s2 = registry.create();
  registry.focus('s1');
  check('aucun aperçu -> focalisée', registry.previewOwner() === s1);
  s1.preview._open = true;
  s1.preview._at = 5;
  check('un aperçu -> son propriétaire', registry.previewOwner() === s1);
  s2.preview._open = true;
  s2.preview._at = 9;
  check('le plus récent gagne', registry.previewOwner() === s2);
  check('même si le focus est ailleurs', registry.focused() === s1);
  s2.preview._open = false;
  check('fermé -> le précédent revient', registry.previewOwner() === s1);
}

// --- 6. restore : à froid, avec slots, corrompu ------------------------------
{
  const { registry } = freshWorld();
  registry.restore();
  check('restore à froid : une session', registry.sessions().length === 1);
  check('restore à froid : focus s1', registry.focused().id === 's1');
}
{
  const { registry, storage } = freshWorld();
  storage.setItem('charon:session#s2', '{"path":"/tmp"}');
  storage.setItem('charon:session#s3', '{"path":"/var"}');
  storage.setItem(
    'charon:tabs',
    JSON.stringify({ focused: 's2', pair: ['s1', 's3'], showingPair: true }),
  );
  registry.restore();
  check('restore : trois sessions', registry.sessions().length === 3);
  check('restore : focus s2', registry.focused().id === 's2');
  check('restore : paire s1/s3', JSON.stringify(registry.pair()) === '["s1","s3"]');
  check('restore : vue double gardée', registry.showingPair() === true);
}
{
  const { registry, storage } = freshWorld();
  storage.setItem('charon:tabs', JSON.stringify({ focused: 's9', pair: null, showingPair: false }));
  registry.restore();
  check('restore : focus mort -> s1', registry.focused().id === 's1');
}
{
  const { registry, storage } = freshWorld();
  storage.setItem('charon:session#s2', 'x');
  storage.setItem('charon:tabs', '{pas du json');
  registry.restore();
  check('restore : tabs corrompu ne casse rien', registry.focused().id === 's1');
  check('restore : les slots comptent quand même', registry.sessions().length === 2);
}
{
  const { registry, storage } = freshWorld();
  storage.setItem('charon:tabs', JSON.stringify({ focused: 's1', pair: ['s1', 's9'], showingPair: true }));
  registry.restore();
  check('restore : paire avec un mort ignorée', registry.pair() === null);
}

// --- 7. persistance et dissolution (effects rejoués à la main) ---------------
{
  const { registry, flush, storage } = freshWorld();
  registry.ensure();
  const s2 = registry.create();
  registry.split('s1', 's2');
  flush();
  const saved = JSON.parse(storage.getItem('charon:tabs'));
  check(
    'la persistance écrit l\'état courant',
    saved.focused === 's2' && JSON.stringify(saved.pair) === '["s1","s2"]' && saved.showingPair === true,
  );

  // Un membre débarque : le split se dissout, le survivant prend le focus.
  s2.sftp._settled = false;
  flush();
  check('dissolution : paire défaite', registry.pair() === null);
  check('dissolution : focus au survivant', registry.focused().id === 's1');
}

// --- Réordonnancement des onglets ------------------------------------------
// L'ordre des sessions EST l'ordre de la barre, et `reorder` prend un rang
// exprimé dans cette liste. L'arithmétique se vérifie mal à la lecture : un
// élément retiré décale ce qui le suit, et un onglet fusionné vaut DEUX
// sessions qui doivent voyager ensemble.
{
  const order = (registry) => registry.sessions().map((s) => s.id).join(',');

  {
    const { registry } = freshWorld();
    registry.ensure();
    registry.create();
    registry.create();
    check('ordre initial', order(registry) === 's1,s2,s3');

    registry.reorder('s3', 0);
    check('déplacer le dernier en tête', order(registry) === 's3,s1,s2');

    registry.reorder('s3', 3);
    check('déplacer la tête en queue', order(registry) === 's1,s2,s3');

    registry.reorder('s2', 1);
    check('déposer à sa propre place ne change rien', order(registry) === 's1,s2,s3');

    registry.reorder('s1', 2);
    check('déplacer d\'un cran vers la droite', order(registry) === 's2,s1,s3');

    registry.reorder('inconnue', 0);
    check('session inconnue : sans effet', order(registry) === 's2,s1,s3');

    registry.reorder('s1', 99);
    check('rang hors bornes : ramené en queue', order(registry) === 's2,s3,s1');
  }

  {
    // Une paire se déplace d'un bloc : c'est une seule vignette à l'écran.
    const { registry } = freshWorld();
    registry.ensure();
    registry.create();
    registry.create();
    registry.split('s1', 's2');
    check('paire posée', JSON.stringify(registry.pair()) === '["s1","s2"]');

    registry.reorder('s1', 3);
    check('la paire part en queue, groupée', order(registry) === 's3,s1,s2');

    registry.reorder('s2', 0);
    check('saisir l\'autre membre déplace la paire aussi', order(registry) === 's1,s2,s3');
    check('la paire survit au déplacement', JSON.stringify(registry.pair()) === '["s1","s2"]');
  }
}

console.log(`\n${pass} vérifications passées, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
