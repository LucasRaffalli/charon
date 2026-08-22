# Modules — système d'extensions de Charon

> Statut : conception (chantier ①). Décidé le 23/08/2026 :
> exécution **JS sandboxé**, nom **Modules**.

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

## Principe d'exécution : iframe sandboxé + pont à permissions

```
┌─ App Charon (Angular, WebView de confiance) ──────────────────────┐
│                                                                   │
│   ModulesService ── permission gate ── API hôte (surface sûre)    │
│        │  postMessage (requête/réponse + événements)              │
│        ▼                                                          │
│   ┌─ <iframe sandbox="allow-scripts"> (origine opaque) ───────┐   │
│   │   SDK injecté  +  main.js du module                       │   │
│   │   CSP : default-src 'none'  (aucun réseau, aucun asset     │   │
│   │   externe) ; pas d'accès au DOM parent, pas de `invoke`    │   │
│   └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Pourquoi ce choix :

- **`sandbox="allow-scripts"` sans `allow-same-origin`** → l'iframe a une
  **origine opaque (null)** : impossible d'accéder à `window.parent`, au DOM de
  l'app, au `localStorage`/cookies de l'hôte, ni d'appeler l'IPC Tauri. Le seul
  canal est `postMessage`.
- **CSP du module** : `default-src 'none'` + `script-src` pour le code injecté
  uniquement. `connect-src 'none'` → **aucun réseau** (pas d'exfiltration).
  Aucune ressource externe.
- L'API hôte est une **sous-surface curée** : elle n'expose que des opérations
  sûres et médiées, jamais `invoke` brut ni les secrets.

C'est le modèle des extensions VS Code (webview) et des plugins Figma — éprouvé.

## Manifeste (`manifest.json`)

```jsonc
{
  "id": "com.exemple.compteur",        // identifiant unique (reverse-DNS)
  "name": "Compteur de fichiers",
  "version": "1.0.0",
  "description": "Compte les fichiers du dossier courant.",
  "author": "Jane Dev",
  "main": "main.js",                    // point d'entrée (dans le dossier module)
  "engine": "^1",                       // version d'API Modules requise
  "permissions": [                      // capabilities demandées (voir plus bas)
    "remote:read",
    "ui:command"
  ],
  "contributes": {                      // déclaratif : ce que l'hôte pré-enregistre
    "commands": [
      { "id": "compter", "title": "Compter les fichiers du dossier" }
    ],
    "panels": [
      { "id": "stats", "title": "Statistiques", "icon": "info" }
    ]
  }
}
```

- `permissions` est **la** liste montrée à l'utilisateur à l'activation. Rien
  hors de cette liste n'est accordé.
- `contributes` permet à l'hôte d'afficher commandes/panneaux **avant** même de
  charger le code (palette, dock) ; le code est activé à la demande.

## Permissions (capabilities)

| Permission | Accorde | Garde-fous |
|---|---|---|
| `remote:read` | Lister/lire des fichiers du serveur via l'API hôte | Chemins médiés ; jamais le secret de connexion |
| `remote:write` | mkdir/upload/rename/suppression côté serveur | Respecte le garde-fou « lecture seule » ; confirmations hôte conservées |
| `local:read` | Lister/lire des fichiers locaux | Anti path-traversal hôte appliqué |
| `local:write` | Créer/écrire/supprimer localement | idem |
| `ui:command` | Enregistrer des commandes (palette) | — |
| `ui:panel` | Contribuer un panneau dockable (rendu dans l'iframe) | — |
| `ui:menu` | Ajouter des entrées de menu contextuel | — |
| `events` | S'abonner aux événements app (connexion, transfert…) | Événements filtrés (pas de données sensibles) |
| `storage` | Store clé-valeur **isolé par module** | Quota ; jamais le store de l'app |

**Jamais accordable** (aucune permission ne les débloque) : secrets/trousseau,
`sudo`, IPC arbitraire, shell/exec, réseau externe, système de fichiers hors API
médiée, données d'un **autre** module.

## API hôte (côté module, via le SDK injecté)

```ts
// Promesses au-dessus de postMessage ; chaque appel est permission-gated côté hôte.
charon.fs.remote.list(path): Promise<Entry[]>          // remote:read
charon.fs.remote.readText(path, maxBytes): Promise<string>
charon.fs.remote.mkdir(path): Promise<void>            // remote:write
charon.fs.local.list(path): Promise<Entry[]>           // local:read
// …

charon.commands.register(id, handler)                  // ui:command
charon.ui.panel(id, render)                            // ui:panel (rend dans l'iframe)
charon.contextMenu.register(target, item)              // ui:menu

charon.events.on('connected' | 'disconnected'
  | 'path-changed' | 'transfer-done', cb)              // events

charon.storage.get(key) / set(key, value)              // storage
charon.notify(message, level)                          // toast hôte (toujours permis)
```

Tout appel non couvert par une permission déclarée est **rejeté par l'hôte**
(erreur), jamais exécuté.

## Panneaux de module

Un panneau contribué est **rendu dans l'iframe du module** (isolation totale de
son UI). L'hôte insère l'iframe dans un slot du dock quand le panneau est actif ;
il devient un panneau dockable de première classe (drag, onglets, fermeture)
comme les panneaux natifs, mais son contenu est cloisonné.

## Cycle de vie

1. **Découverte** — l'hôte lit les manifestes du dossier des modules
   (`app_data_dir/modules/<id>/`), commande backend dédiée (lecture seule,
   pas d'exécution).
2. **Activation** — l'utilisateur active un module → **écran de consentement**
   listant les permissions → l'hôte crée l'iframe, injecte le SDK + `main.js`,
   envoie `activate` avec les permissions accordées + contexte initial.
3. **Contributions** — le module enregistre commandes/panneaux/handlers.
4. **Exécution** — l'hôte route les contributions (palette, dock, menus) et
   médie chaque appel d'API.
5. **Désactivation** — l'hôte détruit l'iframe et retire toutes les
   contributions (aucun résidu).

## Distribution & confiance

- Un module = dossier `manifest.json` + `main.js` (+ assets), installable depuis
  Réglages → Modules (choisir un dossier / une archive).
- **Consentement explicite** aux permissions à l'activation.
- v1 : modules locaux, de confiance (installés par l'utilisateur).
- Plus tard : **signature** des modules, **registre interne** d'entreprise,
  liste blanche.

## Périmètre v1 (chantier ①)

Livrer le socle, pas toute la surface :

1. Types du contrat (manifeste, permissions, messages du pont).
2. Backend : commandes de découverte/lecture des modules (aucune exécution).
3. Hôte sandbox : iframe + pont postMessage + **permission gate**.
4. SDK injecté (promesses au-dessus du pont).
5. Deux points de contribution pour démarrer : **commandes** + **événements**
   (les plus simples), puis **panneaux**.
6. Onglet Réglages → Modules (liste, activer/désactiver, consentement).
7. Un **module d'exemple** (ex. « Compteur de fichiers » : commande qui compte
   les entrées du dossier serveur courant et affiche un toast).

Non-v1 : panneaux (chantier ②), signature/registre (chantier ③), `remote:write`
(après durcissement du consentement), WASM.

## Invariants de sécurité (à ne jamais casser)

- Le module n'a **jamais** `invoke`, le DOM de l'app, ni le réseau.
- Chaque appel d'API est **vérifié contre les permissions déclarées** avant
  exécution — refus par défaut.
- Aucun secret, aucun mot de passe, aucun `sudo`, aucun shell n'est atteignable.
- Un module ne voit **que** ses propres contributions et son propre `storage`.
- Désactiver un module ne laisse **aucun** résidu (contributions ni iframe).
