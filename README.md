# Charon

**Le passeur de fichiers.** Client SFTP / FTPS / FTP privé pour macOS —
backend **Rust** (Tauri v2), interface **Angular 20** (signals, zoneless-ready,
OnPush). Pensé pour un usage personnel puis professionnel : la sécurité est un
objectif de conception, pas une couche ajoutée après coup.

Version : **1.0.0** · Plateforme : macOS · Mises à jour signées intégrées.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Démarrage](#démarrage)
- [Architecture](#architecture)
- [Sécurité](#sécurité)
- [Pourquoi ne pas écrire notre propre SSH ?](#pourquoi-ne-pas-écrire-notre-propre-ssh-)
- [Release et déploiement](#release-et-déploiement)
- [Stack](#stack)

---

## Fonctionnalités

### Connexions

| | |
|---|---|
| **Protocoles** | SFTP (principal), FTPS (AUTH TLS, certificats validés par le système), FTP legacy avec avertissement « en clair » permanent |
| **Authentification** | Clé SSH — auto-détection `~/.ssh` (ed25519 en priorité) ou chemin explicite, passphrase supportée ; mot de passe en repli |
| **Profils multi-serveurs** | Hôte/port/utilisateur/clé dans un store JSON ; **secrets exclusivement dans le trousseau macOS** ; la liste n'affiche que le nom du profil, jamais l'hôte |
| **Pool persistant** | Un transfert long ne bloque ni la navigation ni les autres transferts ; keepalive 30 s ×3 |
| **Fermeture d'inactivité** | Délai réglable (15 min par défaut, 0 = jamais) ; un transfert, un terminal, un suivi de log ou une édition en cours **suspendent** la fermeture |

### Explorateur — panneaux librement réagençables

Un dock façon éditeur de code : 8 panneaux à glisser, empiler en onglets,
redimensionner, fermer et rouvrir — disposition persistée. Dépôt au **centre**
d'un groupe = onglet ; sur un **bord** = split ; sur un **bord de la fenêtre**
= le panneau prend tout le côté. Le DOM n'est jamais recréé : terminal, logs
et positions de scroll **survivent aux réagencements**.

| Panneau | Contenu |
|---|---|
| **Serveur** | Fichiers distants, fil d'Ariane, drag & drop d'upload depuis le Finder |
| **Local** | Cet ordinateur (navigation, envoi vers le serveur) |
| **Arborescence** | Arbre complet du serveur (dossiers **et** fichiers, lignes de guidage, chargement paresseux) |
| **Aperçu** | Double-clic sur un fichier : texte éditable, image, détection binaire |
| **Transferts** | File persistée : progression, annulation, **reprise** après coupure |
| **Journal** | Historique local horodaté de toutes les actions |
| **Logs** | Suivi live `tail -F` d'un fichier distant (filtre, auto-scroll) |
| **Terminal** | Shell SSH intégré (xterm.js) sur la session déjà authentifiée |

### Transferts

| | |
|---|---|
| **Streaming** | Chunks de 1 Mio — mémoire bornée quel que soit le poids du fichier |
| **Reprise** | Écriture vers `*.charonpart` puis renommage atomique ; annulation = partiel supprimé, coupure = partiel conservé et transfert **repris là où il s'était arrêté** (seek SFTP, REST FTP) |
| **File persistée** | Les transferts actifs à la fermeture de l'app reviennent « interrompus », reprenables une fois reconnecté |
| **Écrasement protégé** | Si la cible existe (SFTP) : **détection de conflit** (alerte si la version serveur est plus récente) + **aperçu de diff** côte à côte façon GitHub |

### Productivité

| | |
|---|---|
| **Palette de commandes** | `Cmd+K` : connexion aux profils, navigation (« / » = aller à un chemin), panneaux, thèmes, réglages |
| **Édition externe** | Ouvre le fichier distant dans l'éditeur de ton choix et **re-uploade automatiquement à chaque sauvegarde** (watch + debounce 400 ms) |
| **Environnements** | Dev / Staging / **Prod** par serveur — badge PROD rouge pulsant impossible à rater |
| **Garde-fou « confirmation »** | Toute suppression distante exige de retaper le nom d'hôte (façon GitHub) |
| **Garde-fou « lecture seule »** | Tout chemin d'écriture refusé côté service : upload, drag & drop, mkdir, renommage, suppression, édition |
| **Clic droit complet** | Ouvrir, télécharger/envoyer, aperçu, éditer, suivre en direct, renommer, supprimer, nouveau dossier, copier le chemin |

### Interface

| | |
|---|---|
| **Thèmes** | Clair, sombre, contraste, licorne — custom properties CSS, changement à chaud |
| **Typographie** | **Satoshi** pour l'interface, **JetBrains Mono** pour les données (`0`/`O` et `1`/`l` dissociés) — polices embarquées, aucune ressource distante |
| **Accessibilité** | Rôles ARIA (onglets, alertes, arbre), noms accessibles sur tous les contrôles, focus visible, `prefers-reduced-motion` respecté partout |
| **Mises à jour** | Vérification et installation signées, intégrées aux réglages |

---

## Démarrage

Prérequis : Rust (stable), Node.js ≥ 20, Xcode Command Line Tools.

```bash
npm install
npm run dev          # développement (devtools + overlay tauri.dev.conf.json)
npm run tauri build  # binaire de production (ne signe rien, voir Release)
```

---

## Architecture

```mermaid
flowchart TB
    subgraph webview["WebView — Angular 20"]
        ui["UI uniquement : état d'affichage<br/>CSP stricte · pas d'API Tauri globale · aucun secret"]
    end

    ui =="IPC Tauri — 53 commandes explicitement<br/>enregistrées, rien d'autre n'est invocable"==> backend

    subgraph backend["Backend Rust — Tauri v2"]
        direction LR
        sftp["<b>sftp.rs</b><br/>SSH/SFTP (russh)<br/>pool · TOFU · reprise"]
        ftp["<b>ftp.rs</b><br/>FTP/FTPS (suppaftp)<br/>pool séparé, mêmes garanties"]
        shell["<b>shell.rs</b><br/>terminal SSH · tail -F"]
        edit["<b>edit.rs</b><br/>édition externe<br/>watch + re-upload"]
        fs["<b>fs.rs</b><br/>disque local"]
        profiles["<b>profiles.rs</b><br/>profils + secrets"]
    end

    shell -."canaux sur la session SSH".-> sftp
    edit -."lit et écrit via la session".-> sftp

    sftp ==> ssh[("Serveurs<br/>SSH/SFTP")]
    ftp ==> ftps[("Serveurs<br/>FTP/FTPS")]
    fs ==> disk[("Disque<br/>local")]
    profiles ==> keychain[("Trousseau<br/>macOS")]
```

Tout ce qui touche le réseau, le disque ou les secrets vit côté Rust.
La WebView ne manipule que de l'état d'affichage.

Côté front : `components/` est organisé par rôle — `ui/` (primitives du
design system), `overlays/` (surfaces pilotées par services), `panels/`
(contenus dockables), `dock/` (moteur de docking, logique d'arbre pure et
testée dans `dock-tree.ts`), `brand/`.

---

## Sécurité

### Modèle de menace

Charon se défend contre :

- **un serveur malveillant ou compromis** (noms de fichiers piégés, réponses
  protocolaires hostiles) ;
- **une usurpation de serveur** (MITM), y compris au premier contact ;
- **une compromission de la WebView** (XSS / injection) : elle ne doit donner
  accès ni aux secrets ni à des primitives dangereuses ;
- **la chaîne d'approvisionnement** (dépendances vulnérables ou abandonnées).

Hors périmètre : un poste macOS déjà compromis (keylogger, session ouverte) —
aucune application ne peut s'en protéger.

### Authentification et vérification du serveur

- **Clés SSH d'abord** : auto-détection `~/.ssh` (ed25519 en priorité), ou
  chemin explicite ; passphrase supportée. Le mot de passe n'est qu'un repli
  et n'est jamais enregistré en clair.
- **TOFU explicite** : à la première connexion vers un hôte inconnu, la clé
  n'est **jamais** acceptée silencieusement. Le backend renvoie l'empreinte
  SHA256 ; l'UI l'affiche et demande confirmation ; la clé n'est apprise dans
  `~/.ssh/known_hosts` qu'après accord, et seulement si l'empreinte revue à
  la reconnexion correspond à celle confirmée.
- **Clé changée = refus** avec message explicite — l'utilisateur doit
  vérifier le serveur avant d'aller plus loin.
- **FTPS** : certificats validés par le magasin système. **FTP** en clair
  disponible pour le legacy, avec avertissement permanent.
- **Keepalive** (30 s ×3) : une connexion morte est détectée et fermée
  plutôt que de rester en zombie dans le pool.
- **Fermeture d'inactivité** : tâche de fond (vérification toutes les 30 s),
  délai réglable ; les sessions interactives (terminal, tail, édition) posent
  un *hold* qui suspend la fermeture — jamais coupé en pleine utilisation.

### Secrets

- Passphrases et mots de passe vivent **exclusivement dans le trousseau
  macOS** (`keyring`, service `app.charon`) — jamais dans le store JSON,
  jamais sur disque en clair.
- **Aucun secret ne traverse le pont IPC vers la WebView.** La connexion par
  profil passe `profileId` ; le backend relit lui-même le secret dans le
  trousseau. La migration d'un secret à l'édition d'un profil se fait aussi
  entièrement côté Rust. Il n'existe aucune commande IPC qui renvoie un
  secret.
- La liste des serveurs n'affiche que le **nom du profil** (jamais l'hôte).

### Durcissement de la WebView

- **CSP stricte** en production (`default-src 'self'`, pas de script inline,
  aucune ressource externe — polices incluses, embarquées localement) ;
  variante dev limitée au strict nécessaire du HMR.
- **`withGlobalTauri: false` en production** : pas d'API Tauri globale
  offerte à un éventuel code injecté (réactivée en dev par un overlay).
- **Pas d'`innerHTML`** : interpolation Angular partout — un nom de fichier
  hostile s'affiche, il ne s'exécute pas.
- **Surface IPC minimale** : 53 commandes explicitement enregistrées, rien
  d'autre. Pas de shell arbitraire : le terminal intégré et le `tail -F`
  passent par des canaux SSH dédiés, les chemins sont échappés en quotes
  simples POSIX (`shell_quote`) — rien ne peut s'en échapper.
- **Escalade sudo hors WebView** : quand le serveur refuse une opération pour
  permission, Charon peut la rejouer en `sudo`. Le mot de passe admin est
  saisi dans une **invite macOS native** (jamais dans la WebView, jamais sur
  l'IPC — hors de portée d'un XSS), l'invite affiche l'opération exacte, et
  seules 4 opérations whitelistées (mkdir / rm / rm -rf / mv) sont possibles,
  sur un chemin absolu validé côté backend.

### Système de fichiers

- **Anti path-traversal, dans les deux sens** : les noms d'entrées renvoyés
  par le serveur (et le disque local) sont filtrés (ni vide, ni `.`/`..`, ni
  séparateur) — un serveur qui annonce `../../.zshenv` n'apparaît même pas.
  Toutes les commandes locales refusent en plus tout chemin contenant `..`.
- **Suppression récursive sous double garde** : nom exact à retaper, liens
  symboliques jamais suivis (déliés sans traverser leur cible), garde-fou à
  100 000 entrées.
- **Transferts en streaming, mémoire bornée** (chunks 1 Mio) : un fichier de
  10 Go ne consomme pas 10 Go de RAM.

### Chaîne d'approvisionnement

- Versions **verrouillées** (`Cargo.lock` / `package-lock.json`).
- **Audits** : `npm audit` et scan OSV de l'intégralité du `Cargo.lock`
  (même base que `cargo audit`) — à rejouer régulièrement.
- **russh maintenu à jour** (0.45 → 0.62.7 en août 2026 : la 0.45 cumulait
  13 avis, dont plusieurs exploitables côté *client*). Règle : la
  bibliothèque SSH ne prend jamais de retard sur ses correctifs.
- **Risques connus et assumés** (état août 2026) :
  - `rsa` (via russh) : RUSTSEC-2023-0071 (« Marvin », canal auxiliaire
    temporel) sans correctif d'écosystème — exploitabilité très faible dans
    un client interactif, ed25519 privilégié. À suivre.
  - `async-std` (runtime de suppaftp) : notice « discontinued », pas une
    vulnérabilité — migration de suppaftp surveillée.
  - Notices « unmaintained » sur l'outillage Tauri et avis GTK (builds Linux
    uniquement, absents du graphe macOS).

### Mises à jour signées

- Vérification et téléchargement **côté Rust** (`tauri-plugin-updater`) ;
  chaque archive est contrôlée contre la **clé publique embarquée** avant
  installation — un `latest.json` ou un binaire altéré sur le serveur est
  rejeté.
- La clé privée vit **hors du dépôt** (`~/.tauri/charon-updater.key`), son
  mot de passe dans le trousseau macOS.
- Un build normal ne signe rien et ne produit aucun artefact de mise à jour
  — la signature n'intervient qu'à la release.

### Limite connue

**Signature ad-hoc, pas de notarisation Apple** : choix assumé pour une
application privée — l'intégrité des mises à jour est garantie par la
signature de l'updater, pas par Gatekeeper.

---

## Pourquoi ne pas écrire notre propre SSH ?

La question s'est posée : pour être « sûr à 100 % », faut-il développer
nous-mêmes la couche de connexion ? **Non — et c'est précisément un choix de
sécurité.**

- La couche TCP est déjà la nôtre au sens utile : russh travaille sur les
  sockets asynchrones de tokio, donc ceux du système.
- Ce qui se joue au-dessus — machine à états SSH, échange de clés, crypto en
  temps constant, contre-mesures de protocole (Terrapin, strict-kex) —
  représente des années de travail spécialisé. Une réimplémentation maison
  aurait *plus* de failles, pas moins, et personne ne les chercherait pour
  nous. La liste d'avis corrigés par russh est un argument **pour** lui :
  ces bugs ont été trouvés puis corrigés en jours.
- Ce que nous possédons en propre — la vraie surface de décision : la
  **politique de confiance** (TOFU, refus de clé changée), la **politique de
  session** (keepalive, inactivité, pool), la **gestion des secrets**
  (trousseau, jamais dans la WebView), le **verrouillage et l'audit** des
  versions.

Alternatives évaluées : binaire OpenSSH du système (éprouvé, mais UX
passphrase/agent difficile et perte de contrôle sur les sessions) ; bindings
C `libssh2` (surface FFI, mémoire non sûre). russh — Rust memory-safe,
maintenu, async — reste le meilleur compromis ; la contrepartie est
l'obligation d'audit régulier décrite plus haut.

---

## Release et déploiement

Préconfiguration (une seule fois) — le mot de passe de la clé de signature
dans le trousseau, rien dans le dépôt :

```bash
security add-generic-password -a charon-updater -s charon-updater-password -w
```

Publication :

```bash
# 1. incrémenter "version" (tauri.conf.json, Cargo.toml, package.json)
npm run release      # build signé : clé + mot de passe lus localement
npm run deploy       # release + latest.json + upload scp vers le VPS
```

- `scripts/release.sh` exporte le **contenu** de la clé
  (`TAURI_SIGNING_PRIVATE_KEY`) et lit le mot de passe du trousseau — aucun
  secret en clair, rien à retaper.
- `scripts/deploy.sh` lit `scripts/deploy.env` (non versionné, voir
  `deploy.env.example`) : hôte VPS, port SSH, URL publique.
- L'endpoint de mise à jour est déclaré dans `tauri.conf.json`
  (`plugins.updater.endpoints`) ; l'app vérifie/installe depuis Réglages →
  Mises à jour.

---

## Stack

| Couche | Technologie |
|---|---|
| Shell applicatif | Tauri v2 (WebView WKWebView, IPC typée) |
| Backend | Rust — russh 0.62, russh-sftp 2, suppaftp 6, keyring 3 (trousseau), notify 8 |
| Frontend | Angular 20 — signals, standalone, OnPush |
| Terminal | xterm.js 6 + FitAddon |
| Icônes | lucide-angular |
| Typographie | Satoshi (UI) · JetBrains Mono (données) — embarquées |
| Mises à jour | tauri-plugin-updater (signature ed25519/minisign) |

---

Projet privé — © Lucas. Conçu, durci et audité en continu ; voir
`CLAUDE.md` pour l'état détaillé du chantier.
