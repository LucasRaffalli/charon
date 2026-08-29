// Invariants du dock : réouverture des panneaux et fermeture.
//
// Deux règles vérifiées ici (demandées le 29/08/2026) : un panneau rouvert
// rejoint EN ONGLET le groupe qui accueille déjà ses semblables au lieu de
// tailler un nouveau split à chaque fois, et le panneau serveur se ferme
// comme les autres, le service ne protégeant que le DERNIER panneau ouvert.
'use strict';
const fs = require('fs'), path = require('path');
const REPO = process.env.REPO ?? path.join(__dirname, '..', '..');
const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));

const NG = {
  signal(v) {
    const s = () => v;
    s.set = (x) => { v = x; };
    s.update = (f) => { v = f(v); };
    s.asReadonly = () => () => v;
    return s;
  },
  computed: (fn) => fn,
  effect: () => ({ destroy() {} }),
  untracked: (fn) => fn(),
  inject: () => ({}),
  Injectable: () => (t) => t,
};

function load(rel, extra = {}) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
  const mod = { exports: {} };
  const stub = new Proxy(function () {}, { get: () => stub, construct: () => ({}) });
  new Function('require', 'module', 'exports', code)((spec) => {
    if (spec === '@angular/core') return NG;
    for (const [k, v] of Object.entries(extra)) if (spec.includes(k)) return v;
    return stub;
  }, mod, mod.exports);
  return mod.exports;
}

const tree = load('src/app/services/workspace/dock-tree.ts');
const svc = load('src/app/services/workspace/dock.service.ts', { 'dock-tree': tree });
const dock = new svc.DockService();

const groups = () => tree.collectGroups(dock.tree()).map((g) => g.panels.join('+'));
let pass = 0, fail = 0;
const check = (l, ok, extra) => ok ? pass++ : (fail++, console.log('ÉCHEC ' + l + (extra ? ' :: ' + extra : '')));

const trace = process.env.VERBOSE ? console.log : () => {};
trace('disposition de départ :', JSON.stringify(groups()));

// 1. Fermer trois outils du bas, en rouvrir un : il rejoint les rescapés.
dock.closePanel('transfers');
dock.closePanel('journal');
const avant = groups().length;
dock.openPanel('journal');
const apres = groups();
trace('après réouverture     :', JSON.stringify(apres));
check('réouverture : aucun nouveau groupe', apres.length === avant, `${avant} -> ${apres.length}`);
check('réouverture : rangé en onglet avec ses semblables',
  apres.some((g) => g.includes('journal') && g.split('+').length > 1), JSON.stringify(apres));

// 2. Tout fermer en bas, puis rouvrir : il reprend son bord.
for (const p of ['journal', 'logs', 'terminal', 'trash', 'transfers']) dock.closePanel(p);
trace('bas entièrement fermé :', JSON.stringify(groups()));
dock.openPanel('journal');
check('bord naturel quand plus aucun semblable',
  groups().some((g) => g === 'journal'), JSON.stringify(groups()));

// 3. Le panneau serveur se ferme et se rouvre.
const avaitServeur = tree.collectPanels(dock.tree()).includes('server');
dock.closePanel('server');
check('le panneau serveur se ferme', avaitServeur && !tree.collectPanels(dock.tree()).includes('server'));
dock.openPanel('server');
check('et se rouvre', tree.collectPanels(dock.tree()).includes('server'));

// 4. Tirer une poignée jusqu'au bord ferme le panneau (au relâchement).
{
  dock.reset();
  const root = dock.tree();
  const split = root.kind === 'split' ? root : null;
  if (split) {
    const conteneur = 1200;
    // On pousse le premier enfant à presque rien, puis on relâche.
    dock.resizeSplit(split.id, 0, [...split.sizes], -1, conteneur);
    const annonces = dock.nearCollapse();
    check('glissé : le panneau condamné est annoncé', annonces.size > 0,
      JSON.stringify([...annonces]));
    const avant = tree.collectPanels(dock.tree()).length;
    dock.collapseIfTiny(split.id, conteneur);
    const apres = tree.collectPanels(dock.tree()).length;
    check('relâché au bord : le panneau se ferme', apres < avant, `${avant} -> ${apres}`);
    check('l\'annonce est retirée après coup', dock.nearCollapse().size === 0);
  }
}

// 5. Le dernier panneau ouvert est protégé.
for (const p of tree.ALL_PANELS) dock.closePanel(p);
check('il reste toujours au moins un panneau', tree.collectPanels(dock.tree()).length >= 1,
  JSON.stringify(groups()));

console.log(`\n${pass} vérifications passées, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
