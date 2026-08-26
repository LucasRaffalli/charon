# Charon, fonctionnalités

Client SFTP/FTP privé. Tauri v2 (Rust) + Angular 20. v1.1.0, macOS et Windows.

## Connexion

- SFTP, FTPS (TLS) et FTP, port auto-ajusté 22/21 au changement de protocole
- Auth SFTP par clé SSH (auto-détection `~/.ssh` ed25519 > rsa > ecdsa, ou clé
  explicite) avec passphrase, repli mot de passe
- Auth FTP/FTPS par mot de passe, avertissement « en clair » pour FTP
- TOFU : hôte inconnu confirmé par empreinte SHA256, clé changée refusée
- Profils multi-serveurs (nom, hôte, port, user, clé, protocole, environnement,
  garde-fou), édition sans connexion, migration du secret au changement d'id
- Liste des profils affichant le nom seul, jamais l'hôte

## Connexions actives

- Pool persistant, transfert non bloquant pour les autres opérations
- Keepalive 30 s x3
- Fermeture après inactivité réglable (défaut 15 min, 0 = jamais)
- Terminal ouvert, `tail -F` actif ou édition externe suspendent la fermeture

## Explorateur

- Panneau local et panneau serveur côte à côte
- Arborescence serveur dépliable, dépliage paresseux, suivi du dossier courant
- Fil d'Ariane, tri dossiers d'abord, fichiers cachés optionnels
- Clic droit : ouvrir, télécharger, envoyer, renommer, supprimer, nouveau
  dossier, nouveau fichier, actualiser
- Suppression récursive : symlinks jamais suivis, garde-fou à 100 000 entrées

## Transferts

- Streaming par blocs de 1 Mio, mémoire bornée
- Progression en temps réel, annulation à tout moment
- Flux `.charonpart` : annulation = partiel supprimé, coupure = partiel conservé
- Reprise dans les deux sens (seek en SFTP, `REST` en FTP)
- File persistée, les transferts actifs à la fermeture reviennent « interrompus »
  et sont relançables sur la même connexion
- Envoi par bouton ou glisser-déposer sur la zone serveur, dossiers refusés

## Aperçu et édition

- Double-clic sur un fichier serveur : texte éditable, image, ou message binaire
- Au delà de 512 Kio : aperçu tronqué, édition désactivée
- Coloration syntaxique Prism, ~30 langages par extension et par nom
  (`Dockerfile`, `Makefile`, `.zshrc`), suit la frappe pendant l'édition
- Palettes GitHub Light, One Dark, GitHub Dark High Contrast, Dracula selon le
  thème ; repli en éditeur simple si le fichier est trop lourd
- Markdown rendu (tableaux, tâches, blocs colorisés), bascule Aperçu/Source,
  liens ouverts dans le navigateur système
- Édition dans un éditeur externe avec re-upload auto à chaque sauvegarde
- Écrasement protégé : diff côte à côte ou unifié, compteur +/-, alerte si la
  version serveur est plus récente que la copie locale

## Terminal et logs

- Terminal SSH intégré (xterm.js, vrai PTY, redimensionnement auto), un par
  connexion, SFTP uniquement
- Suivi de logs `tail -F` : filtre client, tampon 2000 lignes, auto-scroll
  suspendu si on remonte, stop et reprise

## Interface

- Docking libre : splits et onglets, drag d'onglet, resize, disposition
  persistée et réinitialisable ; le contenu des panneaux n'est jamais recréé
  (terminal et scroll survivent aux réagencements)
- Panneaux : local, arborescence, serveur, aperçu, transferts, journal, logs,
  terminal, modules
- Palette de commandes (Cmd+K) : profils, session, navigation, panneaux,
  thèmes, réglages ; `/` pour aller à un chemin
- Quatre thèmes : clair, sombre, contraste élevé, unicorn
- Journal d'activité horodaté, persisté, 500 entrées max, copiable
- Accessibilité : rôles ARIA, noms accessibles, `prefers-reduced-motion`

## Sécurité

- Secrets dans le Trousseau (macOS) ou le Gestionnaire d'identifiants (Windows)
  via `keyring`, jamais en clair, jamais exposés à la WebView
- Garde-fou « confirmation » : toute suppression distante exige de retaper le
  nom d'hôte
- Garde-fou « lecture seule » : refus central, envois bloqués, actions masquées
- Badge PROD rouge pulsant / STAGING ambré dans la barre de statut
- Anti path-traversal sur les listings et refus des chemins locaux avec `..`
- Escalade sudo (macOS seulement) : opérations whitelistées, chemins échappés,
  mot de passe saisi dans une invite système native hors WebView, jamais stocké
  ni journalisé, cache sudo invalidé à chaque appel

## Modules

- Extensions tierces exécutées en Web Worker : pas de DOM, pas de réseau, pas
  d'`invoke`
- Permissions déclarées au manifeste, vérifiées à chaque appel, refus par défaut
  (commandes de palette, panneaux, événements, lecture/écriture distante,
  lecture locale, stockage isolé, stats système read-only)
- L'écriture distante d'un module passe par les mêmes garde-fous que
  l'utilisateur
- Réglages > Modules : liste, activation, ouverture du dossier, suppression
- Deux modules d'exemple : compteur de fichiers, moniteur VPS

## Réglages

Fichiers cachés, délai d'inactivité (0 à 240 min), éditeur externe, filigrane,
thème, disposition du dock. Clés inconnues purgées au chargement.

## Mises à jour et distribution

- Mise à jour auto vérifiée et signée côté Rust, onglet dédié dans les réglages
- macOS : DMG signé ad hoc + tap Homebrew
  (`brew install --cask lucasraffalli/charon/charon`)
- Windows : installeur NSIS construit en CI, attaché à la release GitHub
- Publication en une commande : build macOS, tag, attente de la CI Windows,
  mise en ligne, régénération et push de la cask

## Non implémenté

Trois chantiers ont leur conception écrite :
**recherche** ([search.md](search.md)),
**dossier initial à la connexion** ([initial-folder.md](initial-folder.md)),
**système de design** ([design-system.md](design-system.md) : surfaces, accents,
dégradés, mode design).

Le reste n'est pas commencé :
synchronisation de dossiers, déploiement avec rollback,
transferts serveur à serveur (interface mono-connexion), recettes exec
prédéfinies, génération et copie de clés SSH, runbook par profil, export/import
de profils, notifications Slack/webhook, tâches planifiées, limite de bande
passante, export du journal en markdown/CSV, bandeau d'état serveur à la
connexion (données exposées, utilisées seulement par un module d'exemple).
