/*
 * Vérifie le module « Moniteur » sur son VRAI fichier, avec des sorties de
 * commandes réelles.
 *
 * Un module de monitoring ne plante pas quand il se trompe : il affiche un
 * chiffre faux. C'est précisément ce qui se vérifie mal à la lecture, d'où
 * cette batterie sur des sorties de `df`, `free`, `uptime` et `ps` prises
 * telles quelles sur des machines différentes (Ubuntu, Debian sans `free`,
 * macOS), plus les cas tordus : point de montage avec espace, disque plein,
 * ligne tronquée.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(`${label}\n    attendu : ${e}\n    obtenu  : ${a}`);
  }
}

function ok(label, condition) {
  check(label, !!condition, true);
}

// ---------- Chargement du module dans un hôte factice ----------

const rendered = [];
const notified = [];
const registered = [];
const subscribed = [];
const stored = {};
let statsResponse = null;
let statsError = null;
let timerDelay = null;

const charon = {
  commands: {
    register: (id, title, handler) => {
      registered.push({ id, title, handler });
      return Promise.resolve(null);
    },
  },
  events: {
    on: (event, cb) => {
      subscribed.push({ event, cb });
      return Promise.resolve(null);
    },
  },
  sys: {
    stats: () => (statsError ? Promise.reject(new Error(statsError)) : Promise.resolve(statsResponse)),
    diskUsage: () => Promise.resolve(''),
  },
  storage: {
    get: (key) => Promise.resolve(stored[key]),
    set: (key, value) => {
      stored[key] = value;
      return Promise.resolve(null);
    },
    keys: () => Promise.resolve(Object.keys(stored)),
  },
  ui: {
    render: (view, title) => {
      rendered.push({ view, title });
      return Promise.resolve(null);
    },
  },
  notify: (message, level) => {
    notified.push({ message, level });
    return Promise.resolve(null);
  },
};

const sandbox = {
  charon,
  setInterval: (fn, delay) => {
    timerDelay = delay;
    return 1;
  },
  clearInterval: () => {
    timerDelay = null;
  },
  console,
  Math,
  JSON,
  parseInt,
  parseFloat,
  isNaN,
  String,
  Number,
};

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'modules', 'monitor', 'main.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'main.js' });

// ---------- Sorties réelles ----------

// Ubuntu 22.04 sur un VPS : un vrai disque, plusieurs tmpfs, un /boot.
const DF_UBUNTU = `Filesystem     1024-blocks     Used Available Capacity Mounted on
tmpfs               812344     1252    811092       1% /run
/dev/vda1         50633164 41284376   6742356      86% /
tmpfs              4061716        0   4061716       0% /dev/shm
tmpfs                 5120        0      5120       0% /run/lock
/dev/vda15          106858     6182    100676       6% /boot/efi
/dev/vdb1        103081248  8402340  89413276       9% /var/lib/data
tmpfs               812340        4    812336       1% /run/user/1000`;

// Un point de montage qui contient une espace : df ne l'échappe pas, et un
// split naïf sur les espaces le couperait en deux.
const DF_SPACE = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sdb1         10485760  5242880   5242880      50% /mnt/mon disque`;

// Disque plein : c'est le cas qui doit lever l'alerte.
const DF_FULL = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/vda1         50633164 49620500   1012664      98% /`;

const FREE_KB = `               total        used        free      shared  buff/cache   available
Mem:        16246864     4821232     1204512      312044    10221120    10812304
Swap:        4194304           0     4194304`;

// Machine sans `free` : la commande retombe sur /proc/meminfo.
const MEMINFO = `MemTotal:        8167848 kB
MemFree:          204512 kB
MemAvailable:    3812304 kB
Buffers:          112233 kB`;

const UPTIME_LINUX = ' 14:23:07 up 42 days,  3:11,  2 users,  load average: 0.42, 0.65, 0.71';
const UPTIME_MAC = '14:23  up 3 days, 22:04, 3 users, load averages: 1.85 2.10 2.44';

const PS_OUT = `    PID %CPU %MEM COMMAND
   1234  2.1 18.4 postgres
   5678  0.9  9.2 node
    910  0.4  4.1 nginx: worker process`;

const STATS = {
  df: DF_UBUNTU,
  mem: FREE_KB,
  uptime: UPTIME_LINUX,
  processes: PS_OUT,
  os: 'Linux 5.15.0-91-generic',
};

// ---------- Disques ----------

const disks = sandbox.parseDisks(DF_UBUNTU);
check(
  'df : seuls les vrais disques sont gardés',
  disks.map((d) => d.mount),
  ['/', '/var/lib/data'],
);
check('df : le plus rempli en premier', disks[0].mount, '/');
// Le taux se calcule comme `df` le fait, sur utilisé + disponible : le total
// inclut les blocs réservés à root. Ici df annonce 86 %, et c'est ce chiffre
// que le module doit afficher, pas 82 % calculés sur le total.
ok(
  'df : le taux est celui que df affiche (base utilisé + disponible)',
  Math.abs(disks[0].ratio - 41284376 / (41284376 + 6742356)) < 1e-9,
);
// df arrondit AU PLAFOND : c'est son chiffre qu'on doit afficher, sinon le
// module annonce 94 % là où `df -h` affiche 95 % sur le même disque.
check('df : le pourcentage entier est celui de la colonne Capacity', disks[0].percent, 86);
check(
  'df : arrondi au plafond, comme df',
  sandbox.parseDisks(
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
      '/dev/vda1 50633164 44284376 2742356 95% /',
  )[0].percent,
  95,
);
check('df : l\'espace libre est le disponible, pas total - utilisé', disks[0].free, 6742356);
check(
  "df : /boot/efi est écarté (une partition de démarrage n'apprend rien)",
  disks.some((d) => d.mount === '/boot/efi'),
  false,
);

const spaced = sandbox.parseDisks(DF_SPACE);
check('df : un point de montage avec espace reste entier', spaced[0].mount, '/mnt/mon disque');

const full = sandbox.parseDisks(DF_FULL);
ok("df : disque à 98 % dépasse le seuil d'alerte", full[0].ratio >= 0.9);

check('df : sortie vide ne casse rien', sandbox.parseDisks(''), []);
check('df : ligne tronquée ignorée', sandbox.parseDisks('Filesystem 1024-blocks\n/dev/sda1 123'), []);

// ---------- Mémoire ----------

const mem = sandbox.parseMemory(FREE_KB);
check('free : total lu', mem.total, 16246864);
check("free : l'utilisé se calcule sur « available », pas sur « free »", mem.used, 16246864 - 10812304);
ok("free : le cache n'est pas compté comme utilisé", mem.used < 6000000);

const meminfo = sandbox.parseMemory(MEMINFO);
check('meminfo : repli quand `free` est absent', meminfo.total, 8167848);
check('meminfo : utilisé = total - disponible', meminfo.used, 8167848 - 3812304);

check('mémoire : sortie illisible rend null', sandbox.parseMemory('bash: free: command not found'), null);

// ---------- Uptime et charge ----------

const up = sandbox.parseUptime(UPTIME_LINUX);
check('uptime : les trois charges', up.load, ['0.42', '0.65', '0.71']);
check('uptime : depuis quand', up.since, '42 days,  3:11');

const upMac = sandbox.parseUptime(UPTIME_MAC);
check('uptime : macOS écrit « load averages » sans virgules', upMac.load, ['1.85', '2.10', '2.44']);

check('uptime : sortie vide ne casse rien', sandbox.parseUptime('').load, null);

// ---------- Processus ----------

const procs = sandbox.parseProcesses(PS_OUT);
check('ps : trois lignes, en-tête retiré', procs.length, 3);
check('ps : colonnes', procs[0], ['1234', '2.1 %', '18.4 %', 'postgres']);
check('ps : une commande avec espaces reste entière', procs[2][3], 'nginx: worker process');

// ---------- Format humain ----------

check('taille : pas de décimale inutile au-delà de 10', sandbox.human(512), '512 Kio');
check('taille : une décimale en dessous de 10', sandbox.human(4), '4.0 Kio');
check('taille : Mio', sandbox.human(2048), '2.0 Mio');
check('taille : Gio arrondi au-delà de 10', sandbox.human(50633164), '48 Gio');

// ---------- Tracé de tendance ----------

sandbox.history = {};
check('tracé : rien tant qu\'il n\'y a qu\'un point', sandbox.spark('t'), '');

[10, 20, 30, 40].forEach((v) => sandbox.remember('t', v));
const drawing = sandbox.spark('t');
check('tracé : un caractère par relevé', drawing.length, 4);
check('tracé : il monte', drawing, '▁▃▆█');

// Une série presque plate doit le RESTER : normalisée sur ses seules valeurs,
// une variation de 0,1 point dessinerait des montagnes.
sandbox.history = {};
[50, 50.1, 50, 50.1].forEach((v) => sandbox.remember('flat', v));
check('tracé : une série plate reste plate', sandbox.spark('flat'), '▄▄▄▄');

check('tendance : rien avant trois points', sandbox.trend('flat'), '');
sandbox.history = {};
[40, 41, 42, 60].forEach((v) => sandbox.remember('up', v));
check('tendance : la montée se voit', sandbox.trend('up'), ' ↑');
[60, 59, 58, 30].forEach((v) => sandbox.remember('down', v));
check('tendance : la descente aussi', sandbox.trend('down'), ' ↓');
sandbox.history = {};
[50, 50.2, 49.9, 50.1].forEach((v) => sandbox.remember('same', v));
check('tendance : le bruit n\'est pas une tendance', sandbox.trend('same'), '');

// ---------- Alertes ----------

sandbox.history = {};
sandbox.alerted = {};
notified.length = 0;

// Un disque à 86 % sous un seuil à 90 : rien.
sandbox.measure({ df: DF_UBUNTU, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
check('alerte : sous le seuil, rien', notified.length, 0);

// Le même disque à 98 % : une alerte, et UNE SEULE malgré les relevés suivants.
sandbox.measure({ df: DF_FULL, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
check('alerte : le franchissement notifie', notified.length, 1);
ok('alerte : elle nomme le disque', notified[0].message.indexOf('Disque /') === 0);
check('alerte : de niveau erreur', notified[0].level, 'error');

sandbox.measure({ df: DF_FULL, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
sandbox.measure({ df: DF_FULL, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
check('alerte : elle ne se répète pas à chaque relevé', notified.length, 1);

// Juste sous le seuil mais dans la marge : toujours pas de réarmement.
const DF_88 = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/vda1          1000000   880000    120000      88% /`;
sandbox.measure({ df: DF_88, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
sandbox.measure({ df: DF_FULL, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
check('alerte : la marge évite le clignotement autour du seuil', notified.length, 1);

// Nettement redescendu, puis de nouveau plein : cette fois on re-signale.
sandbox.measure({ df: DF_UBUNTU, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
sandbox.measure({ df: DF_FULL, mem: FREE_KB, uptime: UPTIME_LINUX, processes: PS_OUT, os: '' });
check('alerte : une fois redescendu, le seuil se réarme', notified.length, 2);

notified.length = 0;
sandbox.history = {};
sandbox.alerted = {};

// ---------- Le cycle de vie ----------

statsResponse = STATS;
sandbox.activate({ connected: true });

// L'activation enchaîne des promesses : on laisse tourner la micro-file.
setTimeout(() => {
  ok(
    'activation : les deux événements de session sont écoutés',
    subscribed.some((s) => s.event === 'connected') && subscribed.some((s) => s.event === 'disconnected'),
  );
  check('activation : trois commandes de palette', registered.length, 3);
  ok('activation : une vue est rendue', rendered.length > 0);

  const last = rendered[rendered.length - 1].view;
  const titles = last.sections.map((s) => s.title).filter(Boolean);
  check('vue : les quatre sections', titles, ['Serveur', 'Mémoire', 'Disques', 'Processus (par mémoire)']);

  const disksSection = last.sections.find((s) => s.title === 'Disques');
  ok(
    'vue : chaque disque porte sa jauge',
    disksSection.stats.every((s) => typeof s.ratio === 'number'),
  );
  ok("vue : le disque à 86 % n'est pas encore en alerte", disksSection.stats[0].warn === false);

  const table = last.sections.find((s) => s.table);
  check('vue : le tableau des processus a ses quatre colonnes', table.table.headers.length, 4);

  ok('boucle : un rafraîchissement est programmé', timerDelay === 10000);

  // Déconnexion : la boucle s'arrête et la vue le dit.
  const off = subscribed.find((s) => s.event === 'disconnected');
  off.cb({});
  check('déconnexion : plus aucun rafraîchissement', timerDelay, null);
  ok('déconnexion : la vue explique au lieu de rester figée', rendered[rendered.length - 1].view.sections[0].text.indexOf('Aucune session') === 0);

  // Une lecture qui échoue ne vide pas le panneau et ne notifie pas en boucle.
  const on = subscribed.find((s) => s.event === 'connected');
  statsError = 'Délai dépassé pour les stats système.';
  on.cb({});
  setTimeout(() => {
    const notice = rendered[rendered.length - 1].view.sections[0];
    check('erreur : elle se dit dans le panneau', notice.title, 'Lecture impossible');
    check('erreur : aucune notification (elle reviendrait à chaque tick)', notified.length, 0);

    // La cadence se change et se retient.
    statsError = null;
    registered.find((c) => c.id === 'interval').handler();
    check('cadence : elle passe au palier suivant', stored.seconds, '30');
    ok('cadence : la boucle suit', timerDelay === 30000);

    // ---------- Visibilité du panneau ----------
    //
    // Un relevé qui continue derrière un panneau fermé, c'est du réseau pour
    // personne : la minuterie doit s'arrêter et repartir avec le panneau.
    const visibility = subscribed.find((s) => s.event === 'panel-visibility');
    ok("visibilité : le module écoute l'événement", !!visibility);

    visibility.cb({ visible: false });
    // La surveillance ne s'arrête pas : elle s'espace. Une alerte n'a de
    // valeur que si elle arrive sans qu'on regarde.
    check('panneau fermé : la surveillance continue, espacée', timerDelay, 120000);

    // Le compteur se lit une fois la file vidée : le rafraîchissement lancé
    // par le changement de cadence, juste au-dessus, est encore en vol.
    let before = 0;
    setTimeout(() => {
      before = rendered.length;
      sandbox.refresh();
      setTimeout(() => {
        check('panneau fermé : le relevé ne rend rien à personne', rendered.length, before);

        // Une demande explicite passe outre : elle ouvre justement le panneau.
        sandbox.refresh(true);
        setTimeout(() => {
          ok('panneau fermé : « rafraîchir » force quand même', rendered.length > before);

          visibility.cb({ visible: true });
          setTimeout(() => {
            ok('panneau rouvert : la minuterie repart', timerDelay === 30000);

            if (failures.length) {
              console.error(`\n${failures.length} ÉCHEC(S) :\n`);
              failures.forEach((f) => console.error(`  ✗ ${f}\n`));
              process.exit(1);
            }
            console.log(`${passed} vérifications passées, 0 échec(s).`);
          }, 0);
        }, 0);
      }, 0);
    }, 0);
    return;

    // eslint-disable-next-line no-unreachable
    if (failures.length) {
      console.error(`\n${failures.length} ÉCHEC(S) :\n`);
      failures.forEach((f) => console.error(`  ✗ ${f}\n`));
      process.exit(1);
    }
    console.log(`${passed} vérifications passées, 0 échec(s).`);
  }, 0);
}, 0);
