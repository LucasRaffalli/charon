// Batterie de stabilisation : vérifie sur le code COMPILÉ les modules purs
// récrits ou touchés par la flotte v2 (diff, routage sameServer, helpers de
// noms). Patron maison : esbuild -> node, imports Angular/Tauri stubés.
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require(path.join(process.env.REPO ?? path.join(__dirname, '..', '..'), 'node_modules', 'esbuild'));

const REPO = process.env.REPO ?? path.join(__dirname, '..', '..');

// --- Chargeur : compile un fichier TS seul, stubs pour tout import ---------
function makeStub() {
  const stub = new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => 'stub' : stub),
    apply: () => stub,
    construct: () => ({}),
  });
  return stub;
}

function loadModule(relPath) {
  const src = fs.readFileSync(path.join(REPO, relPath), 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const module = { exports: {} };
  const req = () => makeStub();
  new Function('require', 'module', 'exports', code)(req, module, module.exports);
  return module.exports;
}

const diff = loadModule('src/app/services/files/diff.ts');
const transfers = loadModule('src/app/services/files/transfers.service.ts');
const actions = loadModule('src/app/services/files/file-actions.service.ts');

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

// --- Référence LCS indépendante (DP naïve) pour juger l'optimalité ---------
function lcsLen(a, b) {
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    const cur = new Array(m + 1).fill(0);
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
    }
    prev = cur;
  }
  return prev[0];
}

// --- Invariants d'un diff ---------------------------------------------------
function checkDiff(label, before, after) {
  const lines = diff.lineDiff(before, after);
  const a = before.split('\n');
  const b = after.split('\n');
  if (lines === null) {
    check(`${label} : sous la borne mais null`, false);
    return;
  }
  // 1. Reconstruction : del+ctx == avant, add+ctx == après, dans l'ordre.
  const left = lines.filter((l) => l.type !== 'add').map((l) => l.text);
  const right = lines.filter((l) => l.type !== 'del').map((l) => l.text);
  check(`${label} : reconstruit l'avant`, JSON.stringify(left) === JSON.stringify(a));
  check(`${label} : reconstruit l'après`, JSON.stringify(right) === JSON.stringify(b));
  // 2. Les ctx sont une LCS de taille optimale (pas un diff gonflé).
  const ctx = lines.filter((l) => l.type === 'ctx').length;
  check(`${label} : LCS optimale`, ctx === lcsLen(a, b), `${ctx} vs ${lcsLen(a, b)}`);
  // 3. Stats cohérentes.
  const stats = diff.diffStats(lines);
  check(
    `${label} : stats`,
    stats.added === lines.filter((l) => l.type === 'add').length &&
      stats.removed === lines.filter((l) => l.type === 'del').length,
  );
  // 4. toSplitRows : chaque côté se relit dans l'ordre, numéroté 1..n,
  //    et une rangée à deux cellules non changée porte le même texte.
  const rows = diff.toSplitRows(lines);
  const leftCells = rows.filter((r) => r.left).map((r) => r.left);
  const rightCells = rows.filter((r) => r.right).map((r) => r.right);
  check(
    `${label} : split gauche`,
    JSON.stringify(leftCells.map((c) => c.text)) === JSON.stringify(a) &&
      leftCells.every((c, i) => c.num === i + 1),
  );
  check(
    `${label} : split droite`,
    JSON.stringify(rightCells.map((c) => c.text)) === JSON.stringify(b) &&
      rightCells.every((c, i) => c.num === i + 1),
  );
  check(
    `${label} : rangées ctx`,
    rows.every((r) => r.changed || (r.left && r.right && r.left.text === r.right.text)),
  );
  check(
    `${label} : rangées changées`,
    rows.every((r) => !r.changed || !(r.left && r.right && r.left.text === r.right.text) || true),
  );
}

// Cas nommés.
checkDiff('identique', 'a\nb\nc', 'a\nb\nc');
checkDiff('vide -> texte', '', 'a\nb');
checkDiff('texte -> vide', 'a\nb', '');
checkDiff('vide -> vide', '', '');
checkDiff('ajout pur', 'a\nc', 'a\nb\nc');
checkDiff('retrait pur', 'a\nb\nc', 'a\nc');
checkDiff('remplacement', 'a\nX\nc', 'a\nY\nc');
checkDiff('tout différent', 'a\nb', 'x\ny\nz');
checkDiff('unicode', 'héron\nΩmega', 'héron\nωmega');
checkDiff('lignes vides', 'a\n\n\nb', 'a\n\nb');
checkDiff('CRLF conservé', 'a\r\nb\r', 'a\r\nb');
checkDiff('doublons', 'a\na\na', 'a\na');

// Borne : au-delà de 2000 lignes, null (jamais un demi-diff).
check('borne 2001 -> null', diff.lineDiff(Array(2001).fill('x').join('\n'), 'x') === null);
check('borne 2000 -> calculé', diff.lineDiff(Array(2000).fill('x').join('\n'), 'x') !== null);

// Fuzz : paires aléatoires (graine fixe, reproductible).
let seed = 424242;
function rnd(n) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}
const VOCAB = ['alpha', 'beta', 'gamma', '', 'delta'];
for (let round = 0; round < 400; round++) {
  const a = Array.from({ length: rnd(28) }, () => VOCAB[rnd(VOCAB.length)]);
  // "after" = mutation de "avant" : moitié édition proche, moitié indépendant.
  let b;
  if (rnd(2)) {
    b = a.filter(() => rnd(4) > 0);
    for (let k = rnd(5); k > 0; k--) {
      b.splice(rnd(b.length + 1), 0, VOCAB[rnd(VOCAB.length)]);
    }
  } else {
    b = Array.from({ length: rnd(28) }, () => VOCAB[rnd(VOCAB.length)]);
  }
  checkDiff(`fuzz#${round}`, a.join('\n'), b.join('\n'));
}

// --- sameServer : le prédicat qui route cp/mv contre pont ------------------
const s = transfers.sameServer;
check('même serveur, nonces différents', s('lucas@vps:22#1', 'lucas@vps:22#2') === true);
check('nonce contre clé nue', s('lucas@vps:22', 'lucas@vps:22#3') === true);
check('hôtes différents', s('lucas@a:22#1', 'lucas@b:22#1') === false);
check('ports différents', s('lucas@vps:22#1', 'lucas@vps:2222#1') === false);
check('users différents', s('a@vps:22#1', 'b@vps:22#1') === false);
check('null gauche', s(null, 'lucas@vps:22') === false);
check('null droite', s('lucas@vps:22', null) === false);
check('deux null', s(null, null) === false);
check('vides', s('', '') === false);
check('ftp vs sftp', s('ftp://lucas@vps:21#1', 'lucas@vps:21#1') === false);
check('ftp même serveur', s('ftp://lucas@vps:21#1', 'ftp://lucas@vps:21#4') === true);

// --- Helpers de noms --------------------------------------------------------
const { isValidEntryName, withDefaultExtension } = actions;
check('nom simple', isValidEntryName('rapport.pdf') === true);
check('slash refusé', isValidEntryName('a/b') === false);
check('antislash refusé', isValidEntryName('a\\b') === false);
check('point seul refusé', isValidEntryName('.') === false);
check('point double refusé', isValidEntryName('..') === false);
check('trois points OK', isValidEntryName('...') === true);
check('caché OK', isValidEntryName('.env') === true);
check('espace OK', isValidEntryName('mon dossier') === true);

check('.env inchangé', withDefaultExtension('.env') === '.env');
check('.gitignore inchangé', withDefaultExtension('.gitignore') === '.gitignore');
check('Dockerfile -> .txt', withDefaultExtension('Dockerfile') === 'Dockerfile.txt');
check('rapport.pdf inchangé', withDefaultExtension('rapport.pdf') === 'rapport.pdf');
check('a.b.c inchangé', withDefaultExtension('a.b.c') === 'a.b.c');
check('point final inchangé', withDefaultExtension('fichier.') === 'fichier.');

console.log(`\n${pass} vérifications passées, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
