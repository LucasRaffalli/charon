/*
 * Moniteur : ce que le serveur est en train de faire, pendant qu'on travaille
 * dessus.
 *
 * Le module ne lance aucune commande : il demande `charon.sys.stats()`, qui
 * exécute côté Rust une liste fixe de commandes en lecture seule et rend leurs
 * sorties brutes. Tout le travail ici est du parsing et de la mise en forme,
 * ce qui est exactement ce qu'un module doit être : aucune capacité nouvelle,
 * seulement une lecture de ce que l'hôte accepte déjà de donner.
 */

/** Les cadences proposées, en secondes. Le cycle passe de l'une à l'autre. */
var INTERVALS = [5, 10, 30, 60];

/*
 * Panneau fermé, le moniteur ne s'arrête pas : il SURVEILLE, plus lentement.
 * Une alerte n'a de valeur que si elle arrive sans qu'on regarde, mais relever
 * toutes les cinq secondes pour un panneau que personne n'a sous les yeux
 * serait du gaspillage. Deux minutes suffisent à voir un disque se remplir.
 */
var WATCH_SECONDS = 120;

/** Les seuils d'alerte disque proposés, en pourcentage. */
var DISK_LEVELS = [80, 85, 90, 95];

/*
 * La mémoire n'a pas de seuil réglable : l'utilisé est calculé sur
 * « available », cache exclu, donc 95 % veut vraiment dire que la machine
 * n'a plus de quoi respirer. Un serveur sain n'y arrive jamais.
 */
var MEMORY_ALERT = 95;

/*
 * Une alerte franchie ne se répète pas à chaque relevé : elle se rearme quand
 * la valeur redescend nettement sous le seuil. Sans cette marge, une valeur
 * qui oscille autour de 90 % enverrait une notification toutes les dix
 * secondes, ce qui apprend à les ignorer.
 */
var ALERT_HYSTERESIS = 3;

/** Les huit hauteurs du tracé de tendance. */
var SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Combien de relevés le tracé garde en mémoire. */
var HISTORY_MAX = 24;

/*
 * Amplitude minimale du tracé, en points de pourcentage. Normalisé sur ses
 * seules valeurs, un disque qui varie de 0,1 % dessinerait des montagnes et
 * ferait croire à un emballement ; sur 0 à 100, plus rien ne bougerait jamais.
 */
var SPARK_MIN_RANGE = 5;

/*
 * En dessous de cette amplitude, le tracé est rendu RIGOUREUSEMENT plat.
 * Élargir la fenêtre ne suffit pas : deux valeurs séparées de 0,1 point
 * peuvent tomber de part et d'autre d'une frontière d'arrondi et dessiner un
 * « ▄▅▄▅ » qui donne à voir une oscillation là où il ne s'est rien passé.
 */
var SPARK_FLAT_RANGE = 1;

var state = {
  seconds: 10,
  timer: null,
  connected: false,
  /*
   * Le panneau est-il sous les yeux de quelqu'un ? Relever des mesures pour un
   * panneau fermé serait du travail réseau pour personne, et du bruit dans les
   * journaux du serveur. L'hôte le dit, le module ne voit rien de l'interface.
   */
  visible: false,
  /** Seuil d'alerte des disques, en pourcentage (retenu entre deux sessions). */
  diskAlert: 90,
  /** Une lecture est en cours : on n'en empile pas une seconde par-dessus. */
  busy: false,
  lastError: null,
};

/*
 * L'historique des relevés, par métrique (`mem`, `load`, `disk:/var`…). Il vit
 * en mémoire seulement, et repart de zéro à chaque connexion : les mesures
 * d'un serveur ne disent rien du suivant.
 */
var history = {};

/** Les métriques déjà signalées, pour ne pas notifier deux fois la même. */
var alerted = {};

// ---------- Petits utilitaires de format ----------

function human(kb) {
  var units = ['Kio', 'Mio', 'Gio', 'Tio'];
  var value = kb;
  var i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[i];
}

function percent(ratio) {
  return Math.round(ratio * 100) + ' %';
}

function lines(text) {
  return String(text || '')
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
}

// ---------- Historique : le tracé et la tendance ----------

function remember(key, value) {
  var serie = history[key] || (history[key] = []);
  serie.push(value);
  if (serie.length > HISTORY_MAX) {
    serie.shift();
  }
  return serie;
}

/** Le tracé d'une métrique, ou une chaîne vide tant qu'il n'y a rien à tracer. */
/*
 * `minRange` et `flatRange` s'expriment dans l'UNITÉ de la métrique. Les
 * défauts valent pour des pourcentages ; une charge système, qui vit entre 0
 * et quelques unités, a besoin d'une échelle bien plus fine, sans quoi tout
 * lui paraît plat.
 */
function spark(key, minRange, flatRange) {
  var serie = history[key] || [];
  var span = minRange || SPARK_MIN_RANGE;
  var flat = flatRange || SPARK_FLAT_RANGE;
  if (serie.length < 2) {
    return '';
  }
  var min = Math.min.apply(null, serie);
  var max = Math.max.apply(null, serie);
  var middle = (min + max) / 2;
  if (max - min < flat) {
    return serie
      .map(function () {
        return SPARK[3];
      })
      .join('');
  }
  // La fenêtre s'élargit au minimum requis, centrée sur la série : une série
  // presque plate le reste, au lieu d'être amplifiée jusqu'au dramatique.
  if (max - min < span) {
    min = middle - span / 2;
    max = middle + span / 2;
  }
  return serie
    .map(function (value) {
      var position = (value - min) / (max - min);
      var index = Math.round(position * (SPARK.length - 1));
      return SPARK[Math.max(0, Math.min(SPARK.length - 1, index))];
    })
    .join('');
}

/**
 * Où va la métrique. La comparaison se fait entre le dernier relevé et la
 * moyenne des précédents, pas avec le relevé d'avant : deux mesures
 * consécutives se ressemblent trop pour dire quoi que ce soit.
 */
function trend(key, noise) {
  var serie = history[key] || [];
  var threshold = noise || 1;
  if (serie.length < 3) {
    return '';
  }
  var last = serie[serie.length - 1];
  var previous = serie.slice(0, -1);
  var average =
    previous.reduce(function (sum, value) {
      return sum + value;
    }, 0) / previous.length;
  if (last - average >= threshold) {
    return ' ↑';
  }
  if (average - last >= threshold) {
    return ' ↓';
  }
  return '';
}

/** Ce qui s'affiche à droite d'une jauge : le tracé, la valeur, la tendance. */
function readout(key, value) {
  var drawing = spark(key);
  return (drawing ? drawing + '  ' : '') + Math.round(value) + ' %' + trend(key);
}

// ---------- Alertes ----------

/*
 * Une alerte part au franchissement, jamais à chaque relevé. Elle se réarme
 * quand la valeur est redescendue sous le seuil moins la marge.
 */
function alertIfCrossed(key, label, value, threshold) {
  if (value >= threshold && !alerted[key]) {
    alerted[key] = true;
    charon.notify(label + ' : ' + Math.round(value) + ' %', 'error');
  } else if (alerted[key] && value < threshold - ALERT_HYSTERESIS) {
    alerted[key] = false;
  }
}

// ---------- Lecture des sorties ----------

/*
 * Les systèmes de fichiers qui ne disent rien de l'état du serveur : ils sont
 * en mémoire, ou montés par le système pour lui-même. Les afficher noierait
 * les vrais disques sous une dizaine de lignes à 0 %.
 */
var PSEUDO_FS = /^(tmpfs|devtmpfs|udev|overlay|squashfs|none|shm|efivarfs)$/;

function parseDisks(df) {
  var rows = lines(df).slice(1); // l'en-tête de df
  var disks = [];
  rows.forEach(function (row) {
    // `Filesystem 1024-blocks Used Available Capacity Mounted-on`, le point de
    // montage pouvant contenir des espaces : on prend les cinq premiers
    // champs et tout le reste est le chemin.
    var parts = row.split(/\s+/);
    if (parts.length < 6) {
      return;
    }
    var device = parts[0];
    var total = parseInt(parts[1], 10);
    var used = parseInt(parts[2], 10);
    var available = parseInt(parts[3], 10);
    var mount = parts.slice(5).join(' ');
    if (PSEUDO_FS.test(device) || !total || isNaN(used)) {
      return;
    }
    // Les points de montage que le système se donne à lui-même n'apprennent
    // rien sur la place qui reste : partitions de démarrage, images de paquets
    // en lecture seule, pseudo-systèmes. Une partition EFI de 100 Mio à 6 %
    // ne ferait qu'allonger la liste des vrais disques.
    if (/^\/(snap|sys|dev|boot)(\/|$)/.test(mount)) {
      return;
    }
    // Le taux se calcule sur `utilisé + disponible`, comme le fait `df` : le
    // total inclut les blocs réservés à root, invisibles pour l'utilisateur.
    // Sur `used / total` le module afficherait 87 % là où `df -h` affiche
    // 88 %, et un moniteur qui contredit le terminal ne sert plus à rien.
    var base = used + (isNaN(available) ? 0 : available);
    var ratio = base > 0 ? used / base : 0;
    disks.push({
      mount: mount,
      total: total,
      used: used,
      // Ce qui reste vraiment disponible, et non `total - used`.
      free: isNaN(available) ? total - used : available,
      ratio: ratio,
      // `df` arrondit AU PLAFOND : 94,2 % s'y affiche « 95% ». C'est ce
      // chiffre entier qui s'affiche ET qui déclenche l'alerte, pour que le
      // seuil porte sur ce qu'on lit et non sur une décimale invisible.
      percent: Math.ceil(ratio * 100),
    });
  });
  // Le plus rempli d'abord : c'est celui qui va poser problème.
  disks.sort(function (a, b) {
    return b.ratio - a.ratio;
  });
  return disks.slice(0, 6);
}

function parseMemory(mem) {
  var text = String(mem || '');
  // `free -k` : la ligne Mem: porte total, utilisé, libre, partagé, cache,
  // disponible. C'est « disponible » qui compte, pas « libre » : le cache est
  // rendu à la demande, un serveur sain a peu de mémoire libre.
  var free = text.match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (free) {
    var total = parseInt(free[1], 10);
    var available = parseInt(free[6], 10);
    return { total: total, used: total - available, ratio: (total - available) / total };
  }
  // Repli /proc/meminfo, quand `free` n'est pas installé.
  var totalKb = text.match(/MemTotal:\s+(\d+)/);
  var availableKb = text.match(/MemAvailable:\s+(\d+)/);
  if (totalKb && availableKb) {
    var t = parseInt(totalKb[1], 10);
    var a = parseInt(availableKb[1], 10);
    return { total: t, used: t - a, ratio: (t - a) / t };
  }
  return null;
}

function parseUptime(uptime) {
  var text = String(uptime || '');
  // Un nombre, pas « des chiffres et de la ponctuation » : une classe
  // gourmande avale le séparateur de la liste (« 0.42, ») et la conversion
  // décimale d'en dessous le change en point, d'où une charge « 0.42. ».
  var NUM = '([0-9]+[.,][0-9]+|[0-9]+)';
  var load = text.match(new RegExp('load averages?:\\s*' + NUM + '[,\\s]+' + NUM + '[,\\s]+' + NUM));
  var up = text.match(/up\s+(.+?),\s+\d+\s+users?/);
  return {
    // La virgule décimale de certaines locales, malgré LC_ALL=C côté serveur.
    load: load ? [load[1], load[2], load[3]].map(function (v) {
      return v.replace(',', '.');
    }) : null,
    since: up ? up[1] : null,
  };
}

function parseProcesses(processes) {
  var rows = lines(processes).slice(1);
  var out = [];
  rows.forEach(function (row) {
    var parts = row.split(/\s+/);
    if (parts.length < 4) {
      return;
    }
    out.push([parts[0], parts[1] + ' %', parts[2] + ' %', parts.slice(3).join(' ')]);
  });
  return out.slice(0, 8);
}

// ---------- La mesure ----------

/*
 * Enregistre le relevé et lève les alertes. Volontairement séparé du rendu :
 * cette partie tourne AUSSI quand le panneau est fermé, c'est elle qui donne
 * son sens à la surveillance de fond.
 */
function measure(stats) {
  var memory = parseMemory(stats.mem);
  if (memory) {
    remember('mem', memory.ratio * 100);
    alertIfCrossed('mem', 'Mémoire du serveur', memory.ratio * 100, MEMORY_ALERT);
  }

  var load = parseUptime(stats.uptime).load;
  if (load) {
    remember('load', parseFloat(load[0]));
  }

  parseDisks(stats.df).forEach(function (disk) {
    var key = 'disk:' + disk.mount;
    remember(key, disk.percent);
    alertIfCrossed(key, 'Disque ' + disk.mount, disk.percent, state.diskAlert);
  });
}

// ---------- La vue ----------

function render(stats) {
  var sections = [];

  if (!state.connected) {
    return charon.ui.render({
      sections: [{ text: 'Aucune session SFTP. Le moniteur reprend à la connexion.' }],
    });
  }

  if (state.lastError) {
    sections.push({
      title: 'Lecture impossible',
      text: state.lastError,
    });
  }

  if (stats) {
    var uptime = parseUptime(stats.uptime);
    var head = [];
    if (stats.os) {
      head.push({ label: 'Système', value: stats.os });
    }
    if (uptime.since) {
      head.push({ label: 'En marche depuis', value: uptime.since });
    }
    if (uptime.load) {
      // La charge se lit à trois échéances : l'instant, cinq minutes, quinze.
      // Une charge qui monte et une charge qui redescend ne se soignent pas
      // pareil, d'où les trois côte à côte plutôt qu'un seul chiffre.
      // Échelle propre à la charge : 0,5 d'amplitude est déjà une variation
      // qui se voit, là où 5 points de pourcentage ne sont rien.
      var drawing = spark('load', 0.5, 0.1);
      head.push({
        label: 'Charge (1 / 5 / 15 min)',
        value: (drawing ? drawing + '  ' : '') + uptime.load.join('  ·  ') + trend('load', 0.2),
        warn: parseFloat(uptime.load[0]) >= 4,
      });
    }
    if (head.length) {
      sections.push({ title: 'Serveur', stats: head });
    }

    var memory = parseMemory(stats.mem);
    if (memory) {
      sections.push({
        title: 'Mémoire',
        stats: [
          {
            label: human(memory.used) + ' sur ' + human(memory.total),
            value: readout('mem', memory.ratio * 100),
            ratio: memory.ratio,
            warn: memory.ratio * 100 >= MEMORY_ALERT,
          },
        ],
      });
    }

    var disks = parseDisks(stats.df);
    if (disks.length) {
      sections.push({
        title: 'Disques',
        stats: disks.map(function (disk) {
          return {
            label: disk.mount + '  ·  ' + human(disk.free) + ' libres',
            value: readout('disk:' + disk.mount, disk.percent),
            ratio: disk.ratio,
            warn: disk.percent >= state.diskAlert,
          };
        }),
      });
    }

    var processes = parseProcesses(stats.processes);
    if (processes.length) {
      sections.push({
        title: 'Processus (par mémoire)',
        table: { headers: ['PID', 'CPU', 'Mém.', 'Commande'], rows: processes },
      });
    }
  }

  sections.push({
    text:
      'Relevé toutes les ' +
      state.seconds +
      ' s. Alerte disque à ' +
      state.diskAlert +
      ' %.',
  });
  return charon.ui.render({ sections: sections }, 'Moniteur');
}

// ---------- Boucle de rafraîchissement ----------

function refresh(force) {
  if (!state.connected || state.busy) {
    return;
  }
  state.busy = true;
  var showing = state.visible || force;
  return charon.sys
    .stats()
    .then(function (stats) {
      state.lastError = null;
      // La mesure d'abord : elle vaut aussi pour un panneau fermé, et c'est
      // elle qui peut lever une alerte. Le rendu n'a lieu que si quelqu'un
      // regarde (ou l'a demandé).
      measure(stats);
      if (showing) {
        return render(stats);
      }
      return null;
    })
    .catch(function (error) {
      // Une lecture qui échoue ne doit ni notifier en boucle, ni vider la vue :
      // elle se dit dans le panneau et la boucle continue.
      state.lastError = error && error.message ? error.message : String(error);
      return showing ? render(null) : null;
    })
    .then(function () {
      state.busy = false;
    });
}

function schedule() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  // La cadence suit ce qu'on attend du moniteur : celle qu'on a choisie quand
  // le panneau est là, une surveillance espacée quand il ne l'est pas.
  if (state.connected) {
    var seconds = state.visible ? state.seconds : WATCH_SECONDS;
    state.timer = setInterval(refresh, seconds * 1000);
  }
}

function setConnected(connected) {
  state.connected = connected;
  // Les mesures d'un serveur ne disent rien du suivant : un tracé qui
  // enjamberait deux machines serait un mensonge, et une alerte déjà levée
  // sur l'une masquerait la même sur l'autre.
  history = {};
  alerted = {};
  if (!connected) {
    state.lastError = null;
  }
  schedule();
  if (connected) {
    refresh();
  } else {
    render(null);
  }
}

function setVisible(visible) {
  if (state.visible === visible) {
    return;
  }
  state.visible = visible;
  schedule();
  if (visible) {
    refresh();
  }
}

// ---------- Activation ----------

function activate(context) {
  charon.storage.get('seconds').then(function (saved) {
    var value = parseInt(saved, 10);
    if (INTERVALS.indexOf(value) >= 0) {
      state.seconds = value;
      schedule();
    }
  });

  charon.storage.get('diskAlert').then(function (saved) {
    var value = parseInt(saved, 10);
    if (DISK_LEVELS.indexOf(value) >= 0) {
      state.diskAlert = value;
    }
  });

  charon.events.on('connected', function () {
    setConnected(true);
  });
  charon.events.on('disconnected', function () {
    setConnected(false);
  });
  charon.events.on('panel-visibility', function (payload) {
    setVisible(!!(payload && payload.visible));
  });

  charon.commands.register('refresh', 'Moniteur : rafraîchir', function () {
    // Forcé : la demande est explicite, et le rendu ouvre le panneau.
    refresh(true);
  });

  charon.commands.register('threshold', 'Moniteur : seuil d\'alerte disque', function () {
    var next = DISK_LEVELS[(DISK_LEVELS.indexOf(state.diskAlert) + 1) % DISK_LEVELS.length];
    state.diskAlert = next;
    // Remonter le seuil doit pouvoir re-signaler un disque déjà passé dessus,
    // et le baisser ne doit pas re-notifier ce qui l'était déjà : on repart
    // d'une ardoise vide, le prochain relevé tranche.
    alerted = {};
    charon.storage.set('diskAlert', String(next));
    charon.notify('Moniteur : alerte disque à ' + next + ' %.');
    refresh(true);
  });

  charon.commands.register('interval', 'Moniteur : changer la cadence', function () {
    var next = INTERVALS[(INTERVALS.indexOf(state.seconds) + 1) % INTERVALS.length];
    state.seconds = next;
    charon.storage.set('seconds', String(next));
    schedule();
    charon.notify('Moniteur : relevé toutes les ' + next + ' s.');
    refresh(true);
  });

  // Le module peut démarrer alors qu'une session est déjà ouverte (activation
  // depuis les réglages) : dans ce cas aucun événement `connected` ne viendra,
  // c'est le contexte d'activation qui le dit.
  // À l'activation depuis les réglages, aucun événement ne viendra dire l'état
  // courant : on part du principe que le panneau va s'ouvrir (le premier rendu
  // l'ouvre) pour que le moniteur démarre au lieu d'attendre un signal.
  state.visible = true;
  setConnected(!!(context && context.connected));
}
