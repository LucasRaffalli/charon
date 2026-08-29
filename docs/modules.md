# Modules — système d'extensions de Charon

> Statut : **implémenté** (chantiers ① + ②). Décidé le 23/08/2026 :
> exécution **JS sandboxé** en **Web Worker**, nom **Modules**.
>
> Pour écrire un module, voir le guide pratique
> [module-development.md](module-development.md). Ce document-ci décrit
> l'architecture et le modèle de sécurité.

## Vision

Permettre à **d'autres développeurs** d'ajouter de la **vraie fonctionnalité**
à Charon — panneaux, commandes, actions sur les fichiers, réactions aux
événements — pas seulement du cosmétique. Un module est du code tiers exécuté
en **bac à sable**, qui ne parle au reste de l'app que via une **API hôte à
permissions déclarées**.

Contrainte non négociable : **rien dans le modèle de sécurité de Charon ne doit
régresser.** Un module, même malveillant, ne doit jamais pouvoir lire un secret,
appeler `sftp_sudo`, exécuter du shell arbitraire, atteindre l'IPC directement,
ni exfiltrer des données. L'hôte est le seul point de médiation.

## Principe d'exécution : Web Worker sandboxé + pont à permissions

```
┌─ App Charon (Angular, WebView de confiance) ──────────────────────┐
│                                                                   │
│   ModuleHostService ── permission gate ── API hôte (surface sûre) │
│        │  postMessage (requête/réponse + événements)              │
│        ▼                                                          │
│   ┌─ new Worker(blob:) ─────────────────────────────────────┐    │
│   │   SDK injecté  +  main.js du module                      │    │
│   │   Contexte Worker : pas de DOM, pas de `window`,         │    │
│   │   pas de `invoke` ; CSP `worker-src blob:` ; pas de      │    │
│   │   réseau (connect-src verrouillé)                        │    │
│   └────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

Pourquoi un **Web Worker** plutôt qu'une iframe :

- Un Worker n'a **ni DOM, ni `window`, ni `document`, ni `parent`** : il ne peut
  pas toucher l'UI de l'app, ni le `localStorage`/les cookies de l'hôte, ni
  appeler l'IPC Tauri (`invoke` n'existe pas dans son scope). Le seul canal est
  `postMessage`.
- Le code est chargé via un **Blob URL** (`worker-src blob:` dans la CSP) ; la
  CSP de l'app interdit tout réseau sortant → **aucune exfiltration** possible.
- Pas d'UI arbitraire : un module ne dessine **jamais** de HTML (voir Panneaux).
- L'API hôte est une **sous-surface curée** : elle n'expose que des opérations
  sûres et médiées, jamais `invoke` brut ni les secrets.

## Manifeste (`manifest.json`)

```jsonc
{
  "id": "com.exemple.compteur", // identifiant unique (reverse-DNS)
  "name": "Compteur de fichiers",
  "version": "1.0.0",
  "description": "Compte les fichiers du dossier courant.",
  "author": "Jane Dev",
  "main": "main.js", // point d'entrée (dans le dossier module)
  "engine": "^1", // version d'API Modules requise
  "permissions": [
    // capabilities demandées (voir plus bas)
    "remote:read",
    "ui:command",
  ],
}
```

- `permissions` est **la** liste montrée à l'utilisateur à l'activation. Rien
  hors de cette liste n'est accordé.
- Les commandes et les vues de panneau sont enregistrées **à l'exécution**
  (`charon.commands.register`, `charon.ui.render`) — pas besoin de les déclarer
  dans le manifeste.

## Permissions (capabilities)

| Permission     | Accorde                                                          | Garde-fous                                                                                        |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `remote:read`  | Lister des fichiers du serveur via l'API hôte                    | Chemins médiés ; jamais le secret de connexion                                                    |
| `remote:write` | mkdir / création / écriture / rename / suppression côté serveur  | Passe par les **mêmes** garde-fous que l'utilisateur (lecture seule, confirmation par nom d'hôte) |
| `local:read`   | Lister/lire des fichiers locaux                                  | Anti path-traversal hôte appliqué                                                                 |
| `local:write`  | Créer/écrire/supprimer localement                                | idem (réservé, non exposé en v1)                                                                  |
| `system:read`  | Instantané système du serveur (df, mémoire, charge, top process) | Commandes shell **fixes read-only** ; SFTP uniquement ; aucune entrée du module dans la commande  |
| `ui:command`   | Enregistrer des commandes (palette)                              | —                                                                                                 |
| `ui:panel`     | Rendre un **panneau déclaratif** (tableau de bord)               | Structure rendue nativement par l'hôte ; le module ne produit pas de HTML                         |
| `ui:menu`      | Ajouter des entrées de menu contextuel                           | Réservé, non exposé en v1                                                                         |
| `events`       | S'abonner aux événements app (connexion, transfert…)             | Événements filtrés (pas de données sensibles)                                                     |
| `storage`      | Store clé-valeur **isolé par module**                            | Namespacé par slug ; jamais le store de l'app                                                     |

**Jamais accordable** (aucune permission ne les débloque) : secrets/trousseau,
`sudo`, IPC arbitraire, shell/exec, réseau externe, système de fichiers hors API
médiée, données d'un **autre** module.

## API hôte (côté module, via le SDK injecté)

```ts
// Promesses au-dessus de postMessage ; chaque appel est permission-gated côté hôte.
charon.fs.remote.currentPath(): Promise<string>        // remote:read
charon.fs.remote.currentEntries(): Promise<Entry[]>    // remote:read
charon.fs.remote.list(path): Promise<Entry[]>          // remote:read
charon.fs.remote.mkdir(path): Promise<void>            // remote:write
charon.fs.remote.createFile(path): Promise<void>       // remote:write
charon.fs.remote.writeText(path, content): Promise<void> // remote:write
charon.fs.remote.rename(from, to): Promise<void>       // remote:write
charon.fs.remote.remove(path, isDir): Promise<void>    // remote:write
charon.fs.local.list(path): Promise<Entry[]>           // local:read
charon.fs.local.readText(path, maxBytes): Promise<string> // local:read

charon.sys.stats(): Promise<SystemStats>               // system:read
charon.sys.diskUsage(path): Promise<string>            // system:read

charon.commands.register(id, title, handler, opts?)    // ui:command
charon.ui.render(view, title?)                         // ui:panel (panneau déclaratif)

charon.events.on('connected' | 'disconnected'
  | 'path-changed' | 'transfer-done', cb)              // events

charon.storage.get(key) / set(key, value) / keys()     // storage
charon.notify(message, level?)                         // journal hôte (toujours permis)
```

Tout appel non couvert par une permission déclarée est **rejeté par l'hôte**
(erreur), jamais exécuté.

## Panneaux de module (déclaratifs)

Un module ne dessine **jamais de HTML** (pas d'iframe, pas d'injection possible).
Il appelle `charon.ui.render(view)` avec une **structure** — titre, sections,
statistiques (avec jauges), tableaux — que l'hôte rend **nativement** dans le
panneau « Modules » du dock. Ce panneau est un panneau dockable de première
classe (drag, onglets, fermeture) ; il s'ouvre automatiquement au premier
`render`. Les chaînes sont interpolées, jamais évaluées → aucune surface XSS.

Forme d'une vue (`ModuleView`) :

```ts
{
  title?: string,
  sections: Array<{
    title?: string,
    text?: string,
    stats?: Array<{ label: string, value: string, ratio?: number, warn?: boolean }>,
    table?: { headers: string[], rows: string[][] },
  }>,
}
```

## Cycle de vie

1. **Découverte** — l'hôte lit les manifestes du dossier des modules
   (`app_data_dir/modules/<id>/`), commande backend dédiée (lecture seule,
   pas d'exécution).
2. **Activation** — l'utilisateur active un module dans Réglages → Modules →
   l'hôte crée le **Worker** (Blob URL), injecte le SDK + `main.js`, envoie
   `activate` avec les permissions accordées + contexte initial.
3. **Contributions** — le module enregistre commandes / vues / handlers.
4. **Exécution** — l'hôte route les contributions (palette, panneau Modules) et
   médie chaque appel d'API contre les permissions.
5. **Désactivation** — l'hôte `terminate()` le Worker et retire toutes les
   contributions (commandes de palette + vues de panneau) : aucun résidu.

## Distribution & confiance

- Un module = dossier `manifest.json` + `main.js` (+ assets), installable depuis
  Réglages → Modules (choisir un dossier / une archive).
- **Consentement explicite** aux permissions à l'activation.
- v1 : modules locaux, de confiance (installés par l'utilisateur).
- Plus tard : **signature** des modules, **registre interne** d'entreprise,
  liste blanche.

## Ce qui est livré (chantiers ① + ②)

1. Types du contrat (manifeste, permissions, messages du pont, vues de panneau).
2. Backend : découverte/lecture des modules (aucune exécution) + instantané
   système read-only (`sftp_system_stats`, `sftp_disk_usage`).
3. Hôte sandbox : **Web Worker** + pont postMessage + **permission gate**.
4. SDK injecté (promesses au-dessus du pont).
5. Contributions : **commandes** (palette), **événements**, **écriture distante**
   médiée, **lecture locale**, **stockage** isolé, **système**, **panneaux
   déclaratifs**.
6. Onglet Réglages → Modules (liste, activer/désactiver, ouvrir le dossier,
   supprimer).
7. Deux modules d'exemple : « Compteur de fichiers » et « Moniteur VPS ».

Non-v1 : `ui:menu` (menu contextuel), `local:write`, signature/registre
(chantier ③), WASM.

## Invariants de sécurité (à ne jamais casser)

- Le module n'a **jamais** `invoke`, ni le DOM de l'app, ni `window`, ni le réseau
  (contexte Worker).
- Chaque appel d'API est **vérifié contre les permissions déclarées** avant
  exécution — refus par défaut.
- Aucun secret, aucun mot de passe, aucun `sudo`, aucun shell arbitraire n'est
  atteignable ; `system:read` n'exécute que des commandes **fixes read-only**.
- L'écriture distante (`remote:write`) passe par les **mêmes** garde-fous que
  l'utilisateur (lecture seule, confirmation par nom d'hôte) — un module ne peut
  pas les contourner.
- Un module ne voit **que** ses propres contributions et son propre `storage`
  (namespacé par slug).
- Désactiver un module ne laisse **aucun** résidu (Worker `terminate()`,
  commandes et vues retirées).
