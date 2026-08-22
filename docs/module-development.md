# Créer un module Charon

Guide pratique pour écrire une extension (« module ») de Charon. Pour
l'architecture et le modèle de sécurité, voir [modules.md](modules.md).

Un module est du **JavaScript tiers** exécuté dans un **Web Worker sandboxé** :
pas de DOM, pas de `window`, pas de réseau, pas d'accès direct à Tauri. Il ne
communique avec l'app que par l'objet global **`charon`** (le SDK), et seulement
dans les limites des **permissions** qu'il déclare. Tout le reste est refusé par
défaut.

---

## 1. Anatomie d'un module

Un module est un **dossier** contenant au minimum deux fichiers :

```
mon-module/
├── manifest.json   # identité + permissions
└── main.js         # le code (point d'entrée)
```

### `manifest.json`

```jsonc
{
  "id": "com.moi.mon-module",   // identifiant unique, reverse-DNS
  "name": "Mon module",          // nom affiché
  "version": "1.0.0",
  "description": "Ce que fait le module.",
  "author": "Ton nom",
  "main": "main.js",             // point d'entrée, relatif au dossier
  "engine": "^1",                // version d'API Modules requise
  "permissions": ["remote:read", "ui:command"]
}
```

`permissions` est la liste **exacte** de ce que le module peut faire. Elle est
montrée à l'utilisateur. Un appel à une API hors de cette liste est **rejeté**.

| Permission | Débloque |
|---|---|
| `remote:read` | Lire l'arborescence du serveur (`charon.fs.remote.list`, `currentEntries`, `currentPath`) |
| `remote:write` | Créer / écrire / renommer / supprimer côté serveur |
| `local:read` | Lister et lire des fichiers locaux |
| `system:read` | Instantané système du serveur (disque, mémoire, charge, process) — **SFTP uniquement** |
| `ui:command` | Ajouter des commandes à la palette (Cmd+K) |
| `ui:panel` | Afficher un panneau (tableau de bord déclaratif) |
| `events` | Réagir aux événements de l'app |
| `storage` | Stocker des données persistantes (isolées par module) |

### `main.js`

Le code s'exécute **immédiatement** au chargement. Il enregistre ses commandes,
s'abonne aux événements, et peut définir `self.activate` pour recevoir le
contexte initial :

```js
charon.commands.register('hello', 'Dire bonjour', function () {
  charon.notify('Bonjour depuis mon module !');
});

self.activate = function (context) {
  // context = { connected: boolean, protocol: 'sftp' | 'ftp' | 'ftps' | null }
  charon.notify(context.connected ? 'Prêt.' : 'Connecte-toi.');
};
```

---

## 2. Installer un module (pour le tester)

Les modules vivent dans le dossier de données de l'app :

```
<app_data>/modules/<slug>/manifest.json
                          main.js
```

Le plus simple :

1. Charon → **Réglages → Modules → Ouvrir le dossier des modules**.
2. Y créer un sous-dossier (le `slug`, ex. `mon-module`) avec `manifest.json`
   et `main.js`.
3. Revenir dans Réglages → Modules → **Actualiser**, puis **activer** le module.

> Modifié le code ? Désactive puis réactive le module (ou actualise) pour
> recharger le Worker. Il n'y a pas de rechargement à chaud.

---

## 3. Référence du SDK (`charon.*`)

Toutes les méthodes renvoient une **Promesse** (sauf `notify`, synchrone côté
appel). Utilise `async/await` ou `.then()`.

### Fichiers distants — `charon.fs.remote`

```js
await charon.fs.remote.currentPath();     // string — dossier serveur courant   [remote:read]
await charon.fs.remote.currentEntries();  // Entry[] — contenu du dossier courant [remote:read]
await charon.fs.remote.list(path);        // Entry[] — contenu de `path`          [remote:read]

await charon.fs.remote.mkdir(path);              // crée un dossier            [remote:write]
await charon.fs.remote.createFile(path);         // crée un fichier vide       [remote:write]
await charon.fs.remote.writeText(path, content); // écrit du texte (SFTP)      [remote:write]
await charon.fs.remote.rename(from, to);         // renomme / déplace          [remote:write]
await charon.fs.remote.remove(path, isDir);      // supprime (récursif si dir) [remote:write]
```

`Entry` = `{ name: string, isDir: boolean, size: number }`.

Les écritures passent par **les mêmes garde-fous que l'utilisateur** : si la
connexion est en lecture seule, ou exige une confirmation par nom d'hôte, le
module est soumis aux mêmes règles (l'appel peut échouer/être refusé).

### Fichiers locaux — `charon.fs.local`

```js
await charon.fs.local.list(path);             // Entry[]              [local:read]
await charon.fs.local.readText(path, maxBytes); // string (borné)     [local:read]
```

### Système du serveur — `charon.sys`

```js
await charon.sys.stats();          // SystemStats (sorties brutes à parser)  [system:read]
await charon.sys.diskUsage(path);  // string — sortie de `du` triée          [system:read]
```

`SystemStats = { df, mem, uptime, processes, os }` — chaque champ est la **sortie
brute** d'une commande read-only (`df -P -k`, `free -k`/`meminfo`, `uptime`,
`ps`, `uname`). À toi de la parser (voir le module « Moniteur VPS »). SFTP
uniquement.

### Commandes de palette — `charon.commands`

```js
charon.commands.register(id, title, handler, opts?);   // [ui:command]
// opts = { keywords?: string }
```

La commande apparaît dans Cmd+K sous le nom du module. `handler` est appelé au
déclenchement.

### Panneau déclaratif — `charon.ui`

```js
await charon.ui.render(view, title?);   // [ui:panel]
```

Le module **ne dessine pas de HTML** : il fournit une **structure**, l'hôte la
rend nativement dans le panneau « Modules » (qui s'ouvre tout seul au premier
rendu). Rappeler `render` **remplace** la vue précédente du module.

```ts
view: {
  title?: string,
  sections: Array<{
    title?: string,
    text?: string,
    // Statistiques, avec jauge optionnelle (ratio 0–1) et teinte d'alerte :
    stats?: Array<{ label: string, value: string, ratio?: number, warn?: boolean }>,
    // Tableau simple :
    table?: { headers: string[], rows: string[][] },
  }>,
}
```

### Événements — `charon.events`

```js
charon.events.on('connected',     function (p) { /* p = { protocol } */ });   // [events]
charon.events.on('disconnected',  function (p) {});
charon.events.on('path-changed',  function (p) { /* p = { path } */ });
charon.events.on('transfer-done', function (p) { /* p = { name, direction, remotePath, localPath, size } */ });
```

### Stockage — `charon.storage`

```js
await charon.storage.set(key, value);   // value = JSON-sérialisable   [storage]
await charon.storage.get(key);          // valeur ou null
await charon.storage.keys();            // string[]
```

Isolé par module : un module ne voit jamais le stockage d'un autre, ni celui de
l'app.

### Notifications — `charon.notify`

```js
charon.notify(message, level?);   // level: 'info' (défaut) | 'error' — toujours permis
```

Écrit une ligne dans le **Journal** de Charon.

---

## 4. Exemple complet : « Compteur de fichiers »

Le plus petit module utile — une commande qui compte les entrées du dossier
serveur courant.

`manifest.json` :

```json
{
  "id": "com.exemple.compteur",
  "name": "Compteur de fichiers",
  "version": "1.0.0",
  "main": "main.js",
  "engine": "^1",
  "permissions": ["remote:read", "ui:command", "events"]
}
```

`main.js` :

```js
charon.commands.register('compter', 'Compter les fichiers du dossier', async function () {
  const entries = await charon.fs.remote.currentEntries();
  const files = entries.filter((e) => !e.isDir).length;
  const dirs = entries.filter((e) => e.isDir).length;
  charon.notify(`${files} fichier(s) et ${dirs} dossier(s) ici.`);
}, { keywords: 'compter statistiques fichiers' });

self.activate = function (context) {
  charon.notify(context.connected ? 'Compteur prêt (Cmd+K).' : 'Connecte-toi, puis Cmd+K.');
};
```

Le code source est dans [`example-module/`](example-module/).

---

## 5. Exemple avancé : « Moniteur VPS »

Un tableau de bord serveur : espace disque, mémoire, charge, top process. Il
illustre `system:read`, les **panneaux déclaratifs**, et la réaction aux
événements.

Grandes lignes :

```js
async function refresh() {
  const stats = await charon.sys.stats();        // sorties brutes
  await charon.ui.render(buildView(stats));      // structure → panneau natif
}

charon.commands.register('refresh', 'Rafraîchir le moniteur VPS', refresh);
charon.events.on('connected', refresh);          // au branchement
charon.events.on('transfer-done', refresh);      // l'espace a pu bouger

self.activate = (ctx) => { if (ctx.connected && ctx.protocol === 'sftp') refresh(); };
```

`buildView` parse `stats.df` / `stats.mem` / `stats.uptime` / `stats.processes`
et renvoie un `ModuleView` (sections avec jauges pour le disque et la mémoire,
tableau pour les process). Le code complet — avec le parsing robuste des sorties
`df`/`free`/`meminfo`/`uptime`/`ps` — est dans
[`example-vps-monitor/`](example-vps-monitor/). C'est un bon point de départ à
copier.

---

## 6. Déboguer

- **`charon.notify(...)`** est ta trace la plus rapide (visible dans le Journal).
- Une **promesse rejetée** (permission manquante, connexion absente, erreur
  serveur) fait échouer ton `await` : entoure d'un `try/catch` et notifie
  l'erreur (`charon.notify(String(err.message || err), 'error')`).
- Une **exception au chargement** de `main.js` est reportée dans le Journal.
- Un appel à une méthode non déclarée dans `permissions` renvoie
  `Permission refusée : <perm>`.
- Pense à **réactiver** le module après avoir édité le code (pas de hot reload).

---

## 7. Erreurs courantes

| Symptôme | Cause probable |
|---|---|
| `Permission refusée : …` | La permission n'est pas dans le manifeste |
| `Aucune connexion active.` | Appel `fs.remote.*` / `sys.*` sans être connecté |
| `… disponible en SFTP uniquement.` | `sys.*` / `writeText` appelés en FTP(S) |
| Le panneau ne s'ouvre pas | `charon.ui.render` jamais appelé, ou `ui:panel` absent |
| Les modifs de code n'apparaissent pas | Module pas réactivé/rechargé |
| L'écriture échoue silencieusement | Connexion en **lecture seule** ou confirmation par nom d'hôte requise |

---

## 8. Bonnes pratiques

- **Demande le minimum de permissions.** L'utilisateur les voit ; n'ajoute
  `remote:write` que si tu écris vraiment.
- **Sois tolérant aux formats.** Les sorties système varient selon l'OS
  (Linux/macOS/BSD) : parse défensivement, prévois des replis.
- **Ne bloque pas.** Pas de boucle serrée ni de polling agressif ; réagis aux
  événements plutôt que de sonder en continu.
- **Idempotence de la vue.** `charon.ui.render` remplace la vue — reconstruis-la
  entièrement à chaque rafraîchissement, ne suppose pas d'état DOM.
- **Gère la déconnexion.** Écoute `disconnected` pour afficher un état d'attente
  plutôt que de laisser des données périmées.

---

## 9. Ce qu'un module ne peut pas faire

Par conception, aucune permission ne débloque : le réseau externe, le DOM de
l'app, l'IPC Tauri brut (`invoke`), un shell arbitraire, `sudo`, les
secrets/mots de passe/le trousseau, le système de fichiers hors API médiée, ou
les données d'un autre module. Voir [modules.md](modules.md) pour le détail du
modèle de sécurité.
