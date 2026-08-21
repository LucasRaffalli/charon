# Charon

Client SFTP privé pour macOS — Tauri v2 (backend Rust) + Angular 20 (WebView).
Pensé pour un usage personnel puis professionnel : la sécurité est un objectif
de conception, pas une couche ajoutée après coup.

## Démarrage

```bash
npm install
npm run dev      # dev : console de debug activée (overlay tauri.dev.conf.json)
npm run tauri build   # binaire de production
```

## Architecture

```
┌────────────────────────── WebView (Angular) ──────────────────────────┐
│  UI uniquement : aucune connexion réseau, aucun accès disque,         │
│  aucun secret. CSP stricte, pas d'API Tauri globale en production.    │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ IPC Tauri : 16 commandes enregistrées,
                               │ rien d'autre n'est invocable
┌──────────────────────────────┴────────────────────────────────────────┐
│  Backend Rust                                                          │
│  ├── sftp.rs      SSH/SFTP (russh), pool de connexions, TOFU          │
│  ├── ftp.rs       FTP/FTPS (suppaftp), pool séparé, mêmes garanties   │
│  ├── fs.rs        disque local (dossiers de l'utilisateur)            │
│  └── profiles.rs  profils (store JSON) + secrets (Keychain macOS)     │
└────────────────────────────────────────────────────────────────────────┘
```

Tout ce qui touche le réseau, le disque ou les secrets vit côté Rust.
La WebView ne manipule que de l'état d'affichage.

## Sécurité

### Modèle de menace

Charon se défend contre :

- **un serveur SFTP malveillant ou compromis** (noms de fichiers piégés,
  réponses protocolaires hostiles) ;
- **une usurpation de serveur** (MITM), y compris au premier contact ;
- **une compromission de la WebView** (XSS / injection) : elle ne doit donner
  accès ni aux secrets ni à des primitives dangereuses ;
- **la chaîne d'approvisionnement** (dépendances vulnérables ou abandonnées).

Hors périmètre : un poste macOS déjà compromis (keylogger, session ouverte) —
aucune application ne peut s'en protéger.

### Authentification et vérification du serveur

- **Clés SSH d'abord** : auto-détection dans `~/.ssh` (ed25519 en priorité,
  RSA et ECDSA en repli) ou chemin explicite ; passphrase supportée.
  Le mot de passe n'est qu'un repli et n'est jamais enregistré en clair.
- **TOFU explicite** : à la première connexion vers un hôte inconnu, la clé
  n'est **jamais** acceptée silencieusement. Le backend renvoie l'empreinte
  SHA256 ; l'UI l'affiche et demande une confirmation ; la clé n'est apprise
  dans `~/.ssh/known_hosts` qu'après accord, et seulement si l'empreinte
  confirmée correspond à celle revue à la reconnexion. Si l'empreinte change
  entre la confirmation et la relance, la connexion est abandonnée.
- **Clé changée = refus** : si la clé d'un hôte connu ne correspond plus à
  `known_hosts`, la connexion est refusée avec un message explicite —
  l'utilisateur doit vérifier le serveur avant d'aller plus loin.
- **FTP/FTPS** : FTPS explicite (AUTH TLS) avec validation des certificats
  par le magasin système ; le FTP en clair reste disponible pour les
  serveurs legacy mais l'interface affiche un avertissement permanent
  (« identifiants et fichiers en clair »). Mêmes garanties de transfert
  (streaming, annulation, nettoyage des partiels) et mêmes gardes
  anti-traversée que SFTP.
- **Keepalive** (30 s, 3 tentatives) : une connexion morte est détectée et
  fermée plutôt que de rester en zombie dans le pool.
- **Fermeture d'inactivité** : une session inutilisée est fermée par une
  tâche de fond après un délai réglable dans les paramètres (15 minutes par
  défaut, 0 = jamais ; un transfert en cours compte comme de l'activité) ;
  l'interface revient à l'écran de connexion avec un message.

### Secrets

- Les passphrases vivent **exclusivement dans le trousseau macOS** (`keyring`,
  service `app.charon`), jamais dans le store JSON, jamais sur le disque en
  clair.
- **Aucun secret ne traverse le pont IPC vers la WebView.** La connexion via
  un profil passe `profileId` ; le backend relit lui-même la passphrase dans
  le trousseau. La migration d'un secret lors de l'édition d'un profil se fait
  aussi entièrement côté Rust (`migrate_secret_from`). Il n'existe aucune
  commande IPC qui renvoie un secret.
- La liste des serveurs affichée n'expose que le **nom du profil** (jamais
  l'hôte), pour qu'un regard par-dessus l'épaule n'apprenne rien.

### Durcissement de la WebView

- **CSP stricte** en production (`default-src 'self'`, pas de script inline,
  pas de ressource externe) ; variante dev avec le strict nécessaire au HMR
  (`unsafe-eval`, websocket local). Aucune ressource distante n'est chargée.
- **`withGlobalTauri: false` en production** : pas d'API Tauri globale offerte
  à un éventuel code injecté. Le mode dev la réactive via un overlay de
  configuration séparé (`tauri.dev.conf.json`).
- **Pas d'`innerHTML`** : interpolation Angular partout — un nom de fichier
  hostile s'affiche, il ne s'exécute pas.
- **Surface IPC minimale** : seules les commandes enregistrées dans
  `lib.rs` sont invocables ; pas de shell, pas d'`eval`, pas d'accès
  arbitraire au système de fichiers exposé au front.

### Système de fichiers

- **Anti path-traversal, dans les deux sens** : les noms d'entrées renvoyés
  par le serveur (et par le disque local) sont filtrés (`is_safe_entry_name` :
  ni vide, ni `.`/`..`, ni séparateur). Un serveur qui annonce
  `../../.zshenv` n'apparaît même pas dans la liste.
- **Ceinture + bretelles** : toutes les commandes locales (liste, création,
  suppression, renommage, download/upload) refusent tout chemin contenant un
  composant `..`, indépendamment du filtrage amont.
- **Suppression récursive sous double garde** : supprimer un dossier exige de
  retaper son nom exact (façon GitHub). Le parcours ne suit jamais les liens
  symboliques (ils sont déliés, leur cible n'est pas traversée), les noms
  d'entrées dangereux sont ignorés, et un garde-fou refuse les arbres de plus
  de 100 000 entrées.
- **Transferts en streaming, mémoire bornée** : download et upload avancent
  par chunks de 1 Mio — un fichier de 10 Go ne consomme pas 10 Go de RAM
  (déni de service local éliminé). Progression par events Tauri, annulation
  possible ; un transfert interrompu ou annulé ne laisse de fichier partiel
  ni en local ni sur le serveur.

### Chaîne d'approvisionnement

- **Versions verrouillées** par `Cargo.lock` / `package-lock.json`.
- **Audit** : `npm audit` (0 vulnérabilité) et scan OSV de l'intégralité du
  `Cargo.lock` (602 crates) — même base que `cargo audit`. À rejouer
  régulièrement, idéalement en CI.
- **russh migré de 0.45 à 0.62.7** (août 2026) : la 0.45 cumulait 13 avis de
  sécurité, dont plusieurs exploitables côté *client* par un serveur
  malveillant (panique pré-auth, allocations non bornées). Règle : ne jamais
  laisser la bibliothèque SSH prendre du retard sur ses correctifs.
- **Pas de dépendance dormante** : `suppaftp` (FTP) avait été retirée tant
  que la fonctionnalité n'existait pas ; elle a été réintroduite avec le
  support FTP, re-scan OSV à l'appui. Les features de `tokio` sont réduites
  au nécessaire.
- **Risques connus et assumés** (état août 2026) :
  - `rsa` (via russh) : RUSTSEC-2023-0071, canal auxiliaire temporel
    (« Marvin ») sans correctif publié dans l'écosystème. Exploitabilité très
    faible dans un client interactif ; atténuation : Charon privilégie
    ed25519 (détecté avant RSA). À suivre.
  - Notices « unmaintained » sur `unic-*` / `proc-macro-error` (tirées par
    l'outillage Tauri) et avis GTK — ces derniers ne concernent que les
    builds Linux, absents du graphe de dépendances macOS.
  - `async-std` (runtime de suppaftp) : notice « discontinued »
    (RUSTSEC-2025-0052), pas une vulnérabilité — migration de suppaftp
    suivie.

### Mises à jour signées

Les mises à jour passent par `tauri-plugin-updater` : la vérification et le
téléchargement se font **côté Rust** (pas dans la WebView), et chaque archive
est vérifiée contre la **clé publique embarquée** dans l'application avant
toute installation — un `latest.json` ou un binaire altéré sur le serveur est
rejeté. La clé privée vit hors du dépôt (`~/.tauri/charon-updater.key`).

Publication d'une version :

```bash
# 1. incrémenter "version" dans src-tauri/tauri.conf.json
# 2. build signé
TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/charon-updater.key npm run tauri build
# 3. générer le manifeste
scripts/make-latest-json.sh https://ton-vps.exemple/charon > latest.json
# 4. téléverser latest.json + l'archive .app.tar.gz sur le VPS
```

L'endpoint est déclaré dans `tauri.conf.json` (`plugins.updater.endpoints`).

### Limites connues (feuille de route sécurité)

1. **Signature ad-hoc, pas de notarisation Apple** : choix assumé pour une
   application privée — l'intégrité des mises à jour est assurée par la
   signature de l'updater ci-dessus, pas par Gatekeeper.

## Pourquoi ne pas écrire nos propres sockets / notre propre SSH ?

La question s'est posée : pour être « sûr à 100 % », faut-il développer
nous-mêmes la couche de connexion ?

**Non — et c'est précisément un choix de sécurité.**

- La couche TCP est déjà la nôtre au sens utile : russh travaille sur les
  sockets asynchrones de tokio (donc ceux du système). Il n'y a pas de
  « socket tiers » mystérieux à remplacer.
- Ce qui se joue au-dessus — machine à états SSH, échange de clés, crypto en
  temps constant, contre-mesures aux attaques de protocole (ex. Terrapin,
  strict-kex) — représente des années de travail spécialisé et d'historique
  de correctifs. Une réimplémentation maison aurait *plus* de failles, pas
  moins, et personne d'autre ne les chercherait pour nous.
- La liste d'avis corrigés par russh est un argument **pour** lui : ces bugs
  ont été trouvés (fuzzing, chercheurs) puis corrigés en jours. Un protocole
  maison n'aurait ni les chercheurs, ni les correctifs.

Ce que nous possédons en propre, et qui est la vraie surface de décision :

- la **politique de confiance** (TOFU avec empreinte, refus de clé changée) ;
- la **politique de session** (keepalive, timeouts, pool) ;
- la **gestion des secrets** (Keychain, jamais dans la WebView) ;
- le **verrouillage et l'audit** des versions de la bibliothèque.

Alternatives évaluées : déléguer au binaire OpenSSH du système (très éprouvé,
mais UX passphrase/agent difficile et perte de contrôle sur le cycle de vie
des sessions) ; bindings C `libssh2` (surface FFI et mémoire non sûre). russh
(Rust memory-safe, maintenu activement, API async) reste le meilleur
compromis — la contrepartie est l'obligation d'audit régulier décrite
ci-dessus.

## Feuille de route

1. Updater signé (`tauri-plugin-updater`, distribution privée)
2. File de transferts persistante + reprise des transferts interrompus
3. Panneau inférieur multi-features (transferts, logs…)
