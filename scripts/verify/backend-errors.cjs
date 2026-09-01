// L'aiguillage des erreurs venues du backend.
//
// Rust renvoie un CODE, le front le traduit et garde le détail brut. Ce qui
// se vérifie mal à la lecture : qu'un code inconnu ne fasse pas apparaître un
// nom de clé à l'écran, qu'un ancien message non converti passe intact, et
// surtout que le message SYSTÈME survive — `escalateOnDenied` reconnaît
// « permission denied » dedans pour proposer l'escalade sudo.
'use strict';
const path = require('path');
const REPO = process.env.REPO ?? path.join(__dirname, '..', '..');
const esbuild = require(path.join(REPO, 'node_modules', 'esbuild'));
let pass = 0, fail = 0;
const check = (l, ok, x) => { ok ? pass++ : (fail++, console.log('ÉCHEC', l, x ?? '')); };
const stubs = {
  '@angular/core': {
    Injectable: () => (t) => t,
    inject: () => ({ lookup: (k) => ({ 'errors.read_dir': 'Lecture du dossier impossible' })[k] ?? null }),
    computed: (f) => f,
    signal: (v) => { const s = () => v; s.set = (x) => { v = x; }; s.asReadonly = () => s; return s; },
  },
  '@app/services/system/settings.service': { SettingsService: class {} },
};
const built = esbuild.buildSync({
  entryPoints: [path.join(REPO, 'src/app/lang/i18n.service.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: Object.keys(stubs), absWorkingDir: REPO,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', built)(mod, mod.exports, (id) => stubs[id] ?? require(id));
const T = mod.exports.injectErrorText();
const SEP = String.fromCharCode(31);
check('code connu + détail',
  T('CHARON_ERR:read_dir' + SEP + '/var/www : Permission denied')
    === 'Lecture du dossier impossible — /var/www : Permission denied');
check('code connu sans détail', T('CHARON_ERR:read_dir') === 'Lecture du dossier impossible');
check('code inconnu : le détail reste', T('CHARON_ERR:futur_code' + SEP + '/x : boom') === '/x : boom');
check('message non codé : inchangé', T('Connexion impossible : timeout') === 'Connexion impossible : timeout');
check('marqueur existant préservé', T('CHARON_CANCELLED') === 'CHARON_CANCELLED');
check('Error natif', T(new Error('boom')) === 'boom');
check('le détail système survit pour l’escalade sudo',
  T('CHARON_ERR:remove' + SEP + '/etc/x : permission denied').includes('permission denied'));
console.log('\n' + pass + ' vérifications passées, ' + fail + ' échec(s).');
process.exit(fail ? 1 : 0);
