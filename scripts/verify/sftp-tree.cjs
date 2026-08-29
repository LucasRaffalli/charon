// Invariants de l'arborescence serveur, vérifiés sur le code COMPILÉ.
//
// Le bug fondateur de cette batterie (29/08/2026) : au démarrage, l'arbre se
// déplie AVANT que le listing de la vue principale soit arrivé. L'ancienne
// version figeait alors le dossier sur une liste vide, et plus rien ne la
// corrigeait : l'utilisateur voyait un « / » vide jusqu'à ce qu'il clique
// dedans à la main.
'use strict';
const fs = require('fs');
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

/** Le service chargé avec des primitives Angular minimales mais vraies. */
function makeTree(fsTable) {
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
    inject: () => sftp,
    Injectable: () => (t) => t,
  };

  const state = { connected: true, path: '/', entries: [], ready: true };
  const sftp = {
    connected: () => state.connected,
    currentPath: () => state.path,
    entries: () => state.entries,
    connectionId: () => (state.ready ? 'user@host:22#1' : null),
    commandFor: (base) => `sftp_${base}`,
  };

  const invoke = async (_cmd, args) => {
    if (!state.ready) {
      throw new Error('connexion pas encore prête');
    }
    return fsTable[args.path] ?? [];
  };

  const src = fs.readFileSync(
    path.join(REPO, 'src/app/services/connection/sftp-tree.service.ts'),
    'utf8',
  );
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const module = { exports: {} };
  const stub = new Proxy(function () {}, { get: () => stub, construct: () => ({}) });
  new Function('require', 'module', 'exports', code)(
    (spec) => {
      if (spec === '@angular/core') return NG;
      if (spec.includes('@tauri-apps/api/core')) return { invoke };
      return stub;
    },
    module,
    module.exports,
  );

  const tree = new module.exports.SftpTreeService();
  return {
    tree,
    state,
    flush: () => effects.forEach((fn) => fn()),
    settle: () => new Promise((r) => setTimeout(r, 30)),
  };
}

const FS = {
  '/': [
    { name: 'home', is_dir: true },
    { name: 'etc', is_dir: true },
  ],
  '/home': [{ name: 'lucas', is_dir: true }],
  '/home/lucas': [
    { name: 'projet', is_dir: true },
    { name: 'notes.txt', is_dir: false },
  ],
};

/** Retrouve un nœud par son chemin dans l'arbre rendu. */
function find(node, target) {
  if (node.path === target) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = find(child, target);
    if (found) {
      return found;
    }
  }
  return null;
}

const names = (node) => (node?.children ?? []).map((c) => c.name);

(async () => {
  // --- 1. Démarrage : l'arbre se déplie avant que la connexion soit prête ---
  {
    const { tree, state, flush, settle } = makeTree(FS);
    state.ready = false;
    state.path = '/home/lucas';
    state.entries = [];
    flush();
    await settle();

    check(
      'démarrage : pas de dossier faussement vide',
      tree.root().children === null,
      JSON.stringify(tree.root().children),
    );
    check('démarrage : la racine reste repliable', tree.root().expanded === false);

    // La connexion s'établit, le premier listing arrive.
    state.ready = true;
    state.entries = [
      { name: 'projet', isDir: true },
      { name: 'notes.txt', isDir: false },
    ];
    flush();
    await settle();
    await settle();

    check('rattrapage : la racine se déplie', tree.root().expanded === true);
    check('rattrapage : la racine a ses enfants', names(tree.root()).includes('home'));
    const cible = find(tree.root(), '/home/lucas');
    check('rattrapage : le dossier courant est dans l\'arbre', !!cible);
    check(
      'rattrapage : son contenu vient du listing',
      JSON.stringify(names(cible)) === '["projet","notes.txt"]',
      JSON.stringify(names(cible)),
    );
  }

  // --- 2. Navigation ordinaire, connexion déjà prête ---
  {
    const { tree, state, flush, settle } = makeTree(FS);
    await settle(); // l'amorce du constructeur (dossier « / ») se termine
    state.path = '/home';
    state.entries = [{ name: 'lucas', isDir: true }];
    flush();
    await settle();
    await settle();
    const node = find(tree.root(), '/home');
    check('navigation : le dossier visé est révélé', !!node && node.expanded === true);
    check('navigation : son contenu est celui du listing', JSON.stringify(names(node)) === '["lucas"]');
  }

  // --- 3. Une entrée apparaît sans changer de dossier (mkdir au terminal) ---
  {
    const { tree, state, flush, settle } = makeTree(FS);
    await settle(); // l'amorce du constructeur se termine
    state.path = '/home/lucas';
    state.entries = [{ name: 'projet', isDir: true }];
    flush();
    await settle();
    await settle();
    const avant = tree.root();

    state.entries = [
      { name: 'projet', isDir: true },
      { name: 'nouveau', isDir: true },
    ];
    flush();
    await settle();

    const cible = find(tree.root(), '/home/lucas');
    check('ajout : la nouvelle entrée apparaît', names(cible).includes('nouveau'));
    check('ajout : la racine change de référence (la vue est notifiée)', avant !== tree.root());
  }

  // --- 4. Déconnexion : l'arbre repart de zéro ---
  {
    const { tree, state, flush, settle } = makeTree(FS);
    await settle(); // l'amorce du constructeur se termine
    state.path = '/home';
    state.entries = [{ name: 'lucas', isDir: true }];
    flush();
    await settle();
    await settle();
    check('avant déconnexion : arbre peuplé', (tree.root().children ?? []).length > 0);

    state.connected = false;
    flush();
    check('déconnexion : arbre remis à zéro', tree.root().children === null);
    check('déconnexion : racine repliée', tree.root().expanded === false);
  }

  console.log(`\n${pass} vérifications passées, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
})();
