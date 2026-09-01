/**
 * Le dictionnaire FRANÇAIS : la source de vérité.
 *
 * C'est lui qui définit les clés — `en.ts` est typé sur sa forme, donc une
 * entrée ajoutée ici et oubliée là-bas ne compile pas. C'est la seule façon
 * de tenir plusieurs centaines de chaînes sans qu'un écran se retrouve à
 * moitié traduit devant un utilisateur.
 *
 * Un seul fichier par langue, mais RANGÉ : un niveau par domaine, qui suit le
 * découpage de `services/` et `components/`. On cherche une chaîne là où on
 * chercherait le code qui l'affiche.
 *
 * Les jetons `{nom}` sont remplacés à l'appel : `t('files.rename.title',
 * { name })`. Ils portent un nom et pas un rang, pour qu'une traduction
 * puisse les remettre dans un autre ordre.
 */
export const fr = {
  // ---------------------------------------------------------------- commun --
  // N'entre ici que ce qui sert à PLUSIEURS endroits. Une chaîne d'un seul
  // écran reste dans son domaine, où on peut la changer sans se demander qui
  // d'autre la lit.
  common: {
    buttons: {
      create: 'Créer',
      rename: 'Renommer',
      delete: 'Supprimer',
      deleteAll: 'Tout supprimer',
      download: 'Télécharger',
      send: 'Envoyer',
      copy: 'Copier',
      open: 'Ouvrir',
    },
    errors: {
      clipboard: 'Le presse-papier n’est pas accessible',
    },
    toasts: {
      pathCopied: 'Chemin copié',
    },
  },

  // --------------------------------------------------------------- fichiers --
  // Les confirmations renforcées gardent leur formulation au mot près :
  // « Tape « x » pour confirmer » est un garde-fou, pas une tournure.
  files: {
    rename: {
      title: 'Renommer « {name} »',
    },
    delete: {
      definitive: 'Cette action est définitive.',
      file: { title: 'Supprimer « {name} » ?' },
      dir: {
        title: 'Supprimer « {name} » et tout son contenu ?',
        message:
          'Le dossier et tout ce qu’il contient seront supprimés définitivement. Tape « {name} » pour confirmer.',
      },
      guarded: {
        title: 'Serveur protégé : supprimer « {name} » ?',
        dirLead: 'Le dossier et tout son contenu seront supprimés définitivement. ',
        fileLead: 'Cette action est définitive. ',
        type: 'Tape « {host} » pour confirmer.',
      },
      batch: {
        guardedTitle: 'Serveur protégé : supprimer {count} éléments ?',
        guardedMessage: '{detail} Tape « {host} » pour confirmer.',
        dirsTitle: 'Supprimer {count} éléments, dont {dirs} dossier(s) ?',
        dirsMessage: '{detail} Tape « supprimer » pour confirmer.',
        filesTitle: 'Supprimer {count} fichiers ?',
        filesMessage: '{detail} Cette action est définitive.',
        detailDirs: '{count} éléments, dont {dirs} dossier(s) et tout leur contenu.',
        detailFiles: '{count} fichiers.',
        typed: 'supprimer',
      },
    },
    create: {
      dirPlaceholder: 'nom-du-dossier',
      filePlaceholder: 'nom-du-fichier.txt',
      fileHint: 'Sans extension, le fichier sera créé en .txt.',
    },
  },

  // ----------------------------------------------------------------- menus --
  // Les entrées de clic droit. `{n}` est un compte, `{what}` un suffixe déjà
  // formé (« (3) ») : les menus disent le nombre pour qu'on sache sur quoi on
  // agit avant de cliquer.
  menu: {
    open: 'Ouvrir',
    sendToServer: 'Envoyer vers le serveur',
    copyName: 'Copier le nom',
    copyPath: 'Copier le chemin',
    copyPaths: 'Copier les chemins',
    copyCurrentPath: 'Copier le chemin courant',
    rename: 'Renommer…',
    deleteForever: 'Supprimer définitivement',
    deleteCount: 'Supprimer {count} éléments définitivement',
    trash: 'Mettre à la corbeille',
    trashCount: 'Mettre {count} éléments à la corbeille',
    anchorSet: 'Ancrer ce dossier au démarrage',
    anchorClear: "Retirer l'ancre du panneau local",
    newDir: 'Nouveau dossier…',
    newFile: 'Nouveau fichier…',
    newDirLocal: 'Nouveau dossier local',
    newFileLocal: 'Nouveau fichier local',
    newDirServer: 'Nouveau dossier sur le serveur',
    newFileServer: 'Nouveau fichier sur le serveur',
    refresh: 'Actualiser',
    copyWith: 'Copier{what}',
    cutWith: 'Couper{what}',
    pasteHere: 'Coller ici ({count})',
    moveHere: 'Déplacer ici ({count})',
    sendHere: 'Envoyer ici ({count})',
    downloadHere: 'Télécharger ici ({count})',
    downloadCount: 'Télécharger {count} fichiers',
  },

  // ------------------------------------------------------------ raccourcis --
  // Les libellés de la liste ⌘/ et de l'onglet Raccourcis. Le `group` sert
  // aussi de titre de section : il est traduit avec le reste.
  shortcuts: {
    groups: {
      selection: 'Sélection',
      files: 'Fichiers',
      navigate: 'Naviguer',
      transfer: 'Transférer',
      panels: 'Panneaux',
      app: 'Application',
    },
    selectAll: 'Tout sélectionner (entrées visibles)',
    clearSelection: 'Vider la sélection',
    copySelection: 'Copier la sélection',
    cutSelection: 'Couper la sélection',
    pasteInto: 'Coller dans ce dossier',
    prevDir: 'Dossier précédent',
    nextDir: 'Dossier suivant',
    parentDir: 'Dossier parent',
    refreshDir: 'Actualiser le dossier',
    hidden: 'Afficher les fichiers cachés',
    find: 'Filtrer le dossier, ou chercher dans le fichier ouvert',
    deepSearch: 'Chercher récursivement sur le serveur',
    goToPath: 'Aller à un chemin',
    rename: 'Renommer',
    renameAlt: 'Renommer (variante)',
    trashOrDelete: 'Mettre à la corbeille (supprimer, côté local)',
    deleteForever: 'Supprimer définitivement',
    newDir: 'Nouveau dossier',
    save: 'Enregistrer le fichier ouvert',
    downloadSelection: 'Télécharger la sélection',
    uploadSelection: 'Envoyer la sélection locale',
    cancelTransfers: 'Annuler les transferts en cours',
    openTerminal: 'Ouvrir le terminal',
    toggleTree: 'Afficher ou masquer l’arborescence',
    closeTab: 'Fermer l’onglet',
    panel: 'Panneau {name}',
  },

  // ------------------------------------------------------------- transferts --
  transfer: {
    readonlyDrop: 'Serveur en lecture seule : dépôt refusé.',
    readonlyServer: 'Serveur en lecture seule',
    readonlySession: 'Cette session est en lecture seule.',
    needSftp: 'Le dépôt entre fenêtres demande une session SFTP.',
    foldersNotSent: 'Les dossiers ne sont pas envoyés',
    foldersNotSentHint: 'L’envoi ne prend que des fichiers.',
    foldersNotDownloaded: 'Les dossiers ne se téléchargent pas',
    pickFiles: 'Sélectionne des fichiers.',
  },

  // ---------------------------------------------------------- panneau serveur --
  server: {
    noPrevDir: 'Aucun dossier précédent',
    noNextDir: 'Aucun dossier suivant',
    filterCount: '{shown} sur {total}',
    filterThis: 'Filtrer ce dossier',
    filterServer: 'Filtrer le dossier serveur',
    currentPath: 'Chemin courant sur le serveur',
    downloadHint: 'Télécharger dans le dossier local courant',
    dropHere: 'Déposer pour envoyer vers',
    previewFtp: "L'aperçu n'est pas disponible en FTP",
    previewFtpHint: 'Le clic droit propose « Télécharger ».',
    dragItems: '{count} éléments',
    preview: 'Aperçu',
    editExternal: 'Éditer (éditeur système)',
    follow: 'Suivre en direct',
    permissions: 'Permissions…',
    openTerminalHere: 'Ouvrir le terminal ici',
    searchHere: 'Chercher dans ce dossier',
    searchDeep: 'Rechercher en profondeur…',
    favoriteAdd: 'Ajouter aux favoris',
    favoriteRemove: 'Retirer des favoris',
    anchorSet: 'Ancrer pour la connexion',
    anchorClear: "Retirer l'ancre de connexion",
  },

  // ------------------------------------------------------------- palette --
  palette: {
    filters: {
      files: 'fichiers',
      regexHint: 'le motif est une expression régulière',
      caseHint: 'respecter les majuscules',
      dirsHint: 'ignorer les fichiers',
    },
    hints: { connection: 'connexion', panel: 'panneau', open: 'ouvrir', app: 'app' },
    connectTo: 'Se connecter à {name}',
    connectKeywords: 'connexion serveur profil',
    refresh: 'Actualiser le dossier',
    parent: 'Dossier parent',
    newDir: 'Nouveau dossier sur le serveur…',
    newDirKeywords: 'créer mkdir dossier',
    anchorSet: 'Ancrer ce dossier pour la connexion',
    anchorSetKeywords: 'ancre arrivée départ démarrage point de chute dossier par défaut',
    anchorClear: "Retirer l'ancre de connexion",
    anchorClearKeywords: 'ancre arrivée départ démarrage enlever supprimer',
    search: 'Rechercher sur le serveur…',
    terminal: 'Ouvrir le terminal',
    transfers: 'Voir les transferts',
    journal: 'Voir le journal',
    disconnect: 'Se déconnecter',
    whatsNew: 'Nouveautés de cette version',
    reportBug: 'Signaler un problème…',
    reportIdea: 'Proposer une idée…',
    settings: 'Ouvrir les réglages',
    revealDir: "Afficher ce dossier dans l'explorateur",
    revealKeywords: 'aller naviguer ouvrir dossier',
    pathNotFound: 'chemin introuvable',
  },

  // ------------------------------------------------------- presse-papiers --
  clipboard: {
    items: '{count} éléments',
    toCopy: '{what} à copier',
    toMove: '{what} à déplacer',
    pasteHint: 'Coller dans le dossier de destination',
    ftpRefused: 'Dépôt impossible sur une connexion FTP',
    ftpRefusedHint: 'La copie entre serveurs passe par SFTP.',
    sameDirCut: 'Ces éléments sont déjà dans ce dossier.',
    sameDirCopy: 'Copier dans le dossier d’origine créerait un doublon du même nom.',
    seeJournal: 'Voir le journal pour le détail',
    seeTransfers: 'Voir le panneau Transferts pour le détail',
    bridgeFilesOnly: 'Le pont entre serveurs ne copie que des fichiers pour l’instant',
    copiedNotRemoved: '« {name} » copié mais pas retiré de la source',
    mergeQuestion:
      'Un dossier ne peut pas être remplacé sans être fusionné, ce que Charon ne fait pas. Le copier sous le nom « {name} » ?',
    keepBoth: 'Garder les deux',
    failed: '{count} élément(s) sur {total} n’ont pas pu être traités',
    skipped: '{count} élément(s) ignoré(s)',
    nothingOverwritten: 'Rien n’a été écrasé',
    copied: '{count} élément(s) copié(s)',
    moved: '{count} élément(s) déplacé(s)',
  },

  // -------------------------------------------------------------- corbeille --
  trash: {
    toTrash: '{what} à la corbeille',
    items: '{count} éléments',
    seeJournal: 'Voir le journal pour le détail',
    restoreFailed: '« {name} » n’a pas pu être restauré',
    restoreHint: 'Un élément du même nom a peut-être repris sa place',
    originGone: 'Le dossier d’origine a peut-être disparu',
    emptied: 'Corbeille vidée',
    undo: 'Annuler',
  },

  // ------------------------------------------------------------ connexion --
  connection: {
    readonly: 'Serveur en lecture seule : action refusée.',
    lost: 'La connexion au serveur a été perdue : serveur arrêté, réseau coupé ou session fermée à distance.',
    idle: 'Session fermée pour inactivité.',
    none: 'Aucune connexion active',
    createFileSftpOnly: 'Création de fichier disponible en SFTP uniquement.',
    writeFileSftpOnly: 'Écriture de fichier disponible en SFTP uniquement.',
  },

  // ------------------------------------------------------------ application --
  app: {
    updateReady: 'Charon {version} est prête',
    updateReadyPlain: 'Une mise à jour est prête',
    updateTitle: 'Mise à jour',
    updateDetail: 'Installation signée, redémarre en quelques secondes',
    install: 'Installer',
    shortcutsList: 'Liste des raccourcis',
    newWindow: 'Nouvelle fenêtre',
    newTab: 'Nouvel onglet',
    nextTab: 'Onglet suivant',
    prevTab: 'Onglet précédent',
    palette: 'Palette de commandes',
    whatsNew: 'Nouveautés de cette version',
    settings: 'Ouvrir les réglages',
  },

  // -------------------------------------------------------------- réglages --
  settingsPanel: {
    title: 'Réglages',
    hidden: { name: 'Fichiers cachés', desc: 'Afficher les fichiers commençant par un point.' },
    verify: {
      name: 'Vérifier les transferts',
      desc: 'Comparer les empreintes sha256 après chaque transfert. Coûte une lecture complète des deux côtés. SFTP uniquement.',
      aria: "Vérifier l'intégrité des transferts",
    },
    format: {
      name: "Formater à l'enregistrement",
      desc: "Prettier repasse sur le fichier quand tu enregistres depuis l'aperçu (JS/TS, JSON, CSS, HTML, Markdown, YAML). Une erreur de syntaxe n'empêche jamais d'enregistrer.",
      aria: "Formater avec Prettier à l'enregistrement",
    },
    trash: {
      name: 'Corbeille distante',
      desc: "Supprimer déplace vers un dossier .charon-trash au lieu d'effacer. Purgée à la connexion au-delà de ce nombre de jours. 0 = ne jamais purger.",
      aria: 'Jours de rétention de la corbeille',
    },
    localHome: {
      name: 'Dossier local au démarrage',
      desc: "Là où le panneau « Cet ordinateur » s'ouvre au lancement. Vide = ton dossier personnel. Plus simple que de taper un chemin : navigue jusqu'au dossier, clic droit, « Ancrer ce dossier au démarrage ».",
      missing: "Ce dossier n'existe pas : le panneau s'ouvrira sur le dossier personnel.",
    },
    editor: {
      name: 'Éditeur externe',
      desc: 'Application pour « Éditer (éditeur système) ». Vide = défaut du système.',
    },
    idle: {
      name: 'Fermeture après inactivité',
      desc: "Minutes avant fermeture d'une session inutilisée. 0 = jamais.",
      aria: "Minutes d'inactivité avant fermeture",
    },
    shortcuts: { desc: 'Tout ce que Charon écoute au clavier. Accessible aussi par ⌘/.' },
    about: {
      desc: 'Client SFTP/FTP privé pour macOS et Windows. Tu es sur {os}.',
      report: 'Signaler un problème',
      reportDesc:
        "Ouvre le formulaire d'issue sur GitHub, version et système déjà remplis. Rien n'est envoyé en l'ouvrant : tu relis et tu décides. Le journal n'y est jamais joint — il contient des chemins et des noms d'hôtes, c'est à toi de choisir ce que tu y colles.",
      bug: 'Un bug',
      idea: 'Une idée',
      repo: 'Le dépôt',
      author: "L'auteur",
      open: 'Ouvrir',
    },
    data: {
      export: 'Exporter la configuration',
      exportDesc:
        'Un fichier JSON dans ton dossier Téléchargements : apparence, disposition des panneaux, réglages et coordonnées de tes serveurs.',
      exportAction: 'Exporter',
      exportedIn: 'Exporté dans',
      absent: "Ce qui n'y est pas",
      absentDesc:
        "Aucun mot de passe, aucune passphrase. Ils vivent dans le trousseau du système et ne sont jamais lisibles depuis l'application. Un profil exporté indique seulement qu'un secret existe, pour savoir lesquels le redemanderont.",
    },
    modules: {
      folder: 'Dossier des modules',
      folderDesc: 'Installe un module en déposant son dossier ici, puis actualise.',
      empty: 'Aucun module installé. Dépose un dossier de module dans le dossier ci-dessus.',
      remove: 'Supprimer ce module',
    },
    updates: {
      installed: 'Version installée',
      checking: 'Vérification en cours…',
      upToDate: 'Charon est à jour.',
      available: 'Version {version} disponible :',
      signed: "l'installation vérifie la signature avant d'appliquer quoi que ce soit.",
      news: 'Nouveautés',
      installRestart: 'Installer et redémarrer',
      installing: 'Installée, redémarrage…',
      check: 'Vérifier les mises à jour',
      history: 'Historique des versions',
      installedBadge: 'installée',
      availableBadge: 'Mise à jour disponible',
    },
  },

  // ------------------------------------------------------------- connexion --
  connect: {
    tagline: 'Le passeur de fichiers',
    editServer: 'Modifier ce serveur',
    server: 'Serveur',
    preferSftp: ': préfère SFTP dès que possible.',
    boarding: 'Traversée en cours…',
    board: 'Embarquer',
    clickToBoard: 'Un clic embarque directement.',
    noProfile: 'Aucun serveur enregistré',
    noProfileHint: "Donne un nom à un serveur lors d'une connexion pour le retrouver ici.",
    host: 'Hôte',
    authMethod: "Méthode d'authentification",
    keyPassphrase: 'Passphrase de la clé',
    accountPassword: 'Mot de passe du compte',
    password: 'Mot de passe',
    profileName: 'Nom du profil',
    editProfile: 'Modifier ce profil',
    deleteProfile: 'Supprimer ce profil',
    seeNews: 'Voir les nouveautés',
  },

  // --------------------------------------------------------------- aperçu --
  preview: {
    pickFile: "Clique le fichier à comparer, dans n'importe quel panneau serveur.",
    pickAnother: 'Désigner un autre fichier…',
    identical: 'Les deux versions sont identiques.',
    unreadable: '« {path} » n’a pas pu être lu sur « {session} ».',
    absentOn: 'absent sur « {session} »',
    truncated:
      'Fichier volumineux : aperçu tronqué, édition désactivée pour ne pas écraser le reste.',
    readonly: 'Serveur en lecture seule : édition désactivée.',
    binary: "Fichier binaire : pas d'aperçu texte.",
    unsaved: 'Modifications non enregistrées',
    markdownView: 'Affichage du markdown',
    systemEditor: 'Éditeur système',
    closePreview: "Fermer l'aperçu",
    findInFile: 'Rechercher dans le fichier',
    prevMatch: 'Occurrence précédente',
    nextMatch: 'Occurrence suivante',
    closeFind: 'Fermer la recherche',
    otherFile: 'Autre fichier',
    exitDiff: 'Quitter le diff',
    zoomOut: 'Zoom arrière',
    zoomIn: 'Zoom avant',
    compare: 'Comparer',
  },

  // ------------------------------------------------------------ écrasement --
  overwrite: {
    exists: '« {name} » existe déjà',
    newerLead: 'La version de destination est',
    newerWord: 'plus récente',
    newerTail:
      "que celle qui arrive : vous risquez d'écraser des changements faits ailleurs.",
    keepBothLead: 'Un fichier de ce nom est déjà là. Vous pouvez le',
    keepBothWord: 'garder les deux',
    keepBothTail: '(une copie sera créée à côté), ou comparer les deux versions avant de choisir.',
    replaceLead: 'remplacer la version du serveur par ta version locale',
    modifiedOn: 'modifié le {date}',
    unknownDate: 'date inconnue',
    seeDiff: 'Voir les différences',
    computing: 'Calcul des différences…',
    diffUnavailable: 'Aperçu indisponible (fichier binaire ou trop volumineux).',
    removed: '−{count} retirées',
    added: '+{count} ajoutées',
    sideBySide: 'Côte à côte',
    unified: 'Unifié',
    overwrite: 'Écraser',
    overwriteAll: 'Écraser tout',
    skipAll: 'Ignorer tout',
    keepBoth: 'Garder les deux',
  },

  // ---------------------------------------------------------- mode design --
  design: {
    presets: 'Thèmes tout faits',
    theme: 'Thème',
    radius: 'Rayon des angles',
    radiusDesc: "Les marges intérieures suivent, pour que le contenu ne touche jamais l'arc.",
    textSize: 'Taille du texte',
    watermark: 'Filigrane du logo',
    dirty: 'Non enregistré',
    clean: 'Aucun changement',
    done: 'Terminé',
    gradient: 'Motif du dégradé',
    intensity: 'Intensité',
    intensityAria: 'Intensité du dégradé, en pourcentage',
    marked: 'Marqué',
    gutterHint:
      'Les gouttières ne font que 4 px : passe les panneaux en translucides pour voir le dégradé.',
    contrastHint: 'En contraste élevé, la lisibilité prime : les panneaux restent opaques.',
    layout: 'Disposition des panneaux',
    reset: 'Réinitialiser les panneaux',
    resetHint:
      "Un panneau absent d'une disposition n'est pas perdu : il se rouvre depuis la barre de statut.",
    saveTitle: 'Enregistrer ce thème ?',
    firstColor: 'Première couleur',
    secondColor: 'Seconde couleur',
    colorPresets: 'Préréglages de couleurs',
    panelOpacity: 'Opacité des panneaux',
  },

  // ------------------------------------------------------- longue traîne --
  misc: {
    preview: {
      unsavedLost: 'Les modifications non enregistrées seront perdues.',
      cannotPreview: 'Aperçu impossible.',
      guardedSave: 'Serveur protégé : enregistrer « {name} » ?',
      savedUnformatted: 'Enregistré sans formatage',
      prettierFailed: 'Prettier n’a pas réussi à lire ce fichier (erreur de syntaxe ?)',
      saved: 'Enregistré sur le serveur',
    },
    layouts: {
      classic: 'Local et arborescence à gauche, serveur au centre, aperçu à droite.',
      twoColumns: 'Local et serveur côte à côte, comme un client FTP classique.',
      server: 'Le distant en grand, sans zone basse.',
      terminal: 'Serveur à gauche, terminal en grand à droite.',
      bare: "Local et serveur, rien d'autre.",
      bareName: 'Épuré',
    },
    anchor: {
      localSet: 'Ancre posée, le panneau local s’ouvrira ici',
      localRemoved: 'Ancre retirée',
      localHome: 'Ouverture au dossier personnel',
      remoteSet: 'Ancre posée, vous arriverez ici',
      remoteHome: 'Arrivée au dossier personnel',
      failed: "L'ancre n'a pas pu être enregistrée",
    },
    transfers: {
      readonly: 'Serveur en lecture seule : envoi refusé.',
      tooBig: 'Fichier trop volumineux pour une vérification rapide',
      mismatch: '{name} : les empreintes diffèrent',
      mismatchHint: 'Le fichier transféré n’est pas identique à la source',
    },
    tabs: {
      splitWith: 'Côte à côte avec « {name} »',
      unsplit: 'Séparer les onglets',
    },
    permissions: {
      owner: 'Propriétaire',
      group: 'Groupe',
      others: 'Autres',
      read: 'Lire',
      write: 'Écrire',
      exec: 'Exéc.',
      recursive: ' (récursif)',
      preset644: 'Fichier ordinaire : lisible par tous, modifiable par le propriétaire',
      preset755: 'Exécutable ou dossier : parcourable par tous',
      preset600: 'Privé : le propriétaire seul, pour une clé ou un .env',
      preset775: 'Dossier partagé avec le groupe',
    },
    settingsTabs: { data: 'Données', updates: 'Mises à jour', about: 'À propos' },
    changeKinds: {
      newOne: 'nouveauté',
      newMany: 'nouveautés',
      betterOne: 'amélioration',
      betterMany: 'améliorations',
      fixedOne: 'correctif',
      fixedMany: 'correctifs',
    },
    moduleDelete: {
      title: 'Supprimer le module « {name} » ?',
      message: 'Le dossier du module sera supprimé définitivement. Tape « {name} » pour confirmer.',
    },
    connect: {
      welcome: 'Bienvenue à bord.',
      sshKey: 'Clé SSH',
      password: 'Mot de passe',
      openInWindow: 'Ouvrir dans une nouvelle fenêtre',
      openInTab: 'Ouvrir dans un onglet',
    },
  },

  // -------------------------------------------------------------- favoris --
  favorites: {
    icon: 'Icône',
    name: 'Nom',
    namePlaceholder: 'Nom du raccourci',
    editTitle: 'Modifier le favori',
    edit: 'Modifier ce favori',
    connectFirst: 'Connecte-toi pour retrouver tes raccourcis.',
    addCurrent: 'Ajouter ce dossier',
    noProfile:
      "Cette connexion n'a pas de profil : les favoris se rangent dans un profil, enregistre-la pour en garder.",
    empty:
      "Aucun favori. « Ajouter ce dossier » garde l'endroit où tu es, le crayon permet de le renommer.",
    hint: "Le nom et l'icône ne servent qu'ici : le dossier du serveur n'est pas touché.",
  },

  // ----------------------------------------------------------------- logs --
  logs: {
    filter: 'Filtrer…',
    stop: 'Arrêter le suivi',
    resume: 'Reprendre le suivi',
    empty: 'En attente de contenu…',
    noMatch: 'Aucune ligne ne correspond au filtre.',
    hint: 'Clic droit sur un fichier du serveur → « Suivre en direct » pour voir son contenu défiler ici (session SSH requise).',
  },

  // ------------------------------------------------- erreurs du backend --
  // Les clés ici portent le nom des CODES renvoyés par Rust
  // (`errors::user_err`). Elles ne sont donc pas vérifiées à la compilation :
  // le nom vient d'ailleurs. Le détail brut — chemin, message système — est
  // ajouté après, tel quel.
  errors: {
    read_dir: 'Lecture du dossier impossible',
    mkdir: 'Création impossible',
    remove: 'Suppression impossible',
    rename: 'Renommage impossible',
    copy: 'Copie impossible',
    connect: 'Connexion impossible',
    auth: 'Authentification refusée',
    key_missing: 'Clé introuvable',
    no_key: 'Aucune clé SSH trouvée dans ~/.ssh',
    key_unreadable: 'Clé illisible (chiffrée sans passphrase ?)',
    auth_password: 'Authentification refusée (mot de passe)',
    auth_both: 'Authentification refusée (clé et mot de passe)',
    sftp_session: 'Session SFTP impossible',
  },

  // -------------------------------------------------------- noms de panneaux --
  panels: {
    local: 'Local',
    tree: 'Arborescence',
    server: 'Serveur',
    server2: 'Serveur 2',
    preview: 'Aperçu',
    transfers: 'Transferts',
    journal: 'Journal',
    logs: 'Logs',
    terminal: 'Terminal',
    terminal2: 'Terminal 2',
    favorites: 'Favoris',
    modules: 'Modules',
    search: 'Recherche',
    trash: 'Corbeille',
    close: 'Fermer « {name} »',
    reopen: 'Rouvrir : {name}',
    reopenAria: 'Rouvrir le panneau {name}',
  },

  // ------------------------------------------------------ options avancées --
  advanced: {
    title: 'Options avancées',
    checking: 'Vérification en cours…',
    upToDate: 'Charon est à jour.',
    downloading: 'Téléchargement…',
    installing: 'Installée, redémarrage…',
    checkFailed: 'Vérification impossible',
    update: "Mise à jour de l'application",
    signed: "La signature est vérifiée avant l'installation",
    check: 'Vérifier',
    sshKey: 'Clé SSH',
    none: 'Aucun',
  },

  // --------------------------------------------------------------- terminal --
  terminal: {
    sftpOnly: "Le terminal n'est disponible qu'en SFTP (session SSH).",
    ended: 'Session du terminal terminée.',
    restart: 'Relancer',
    followDir: 'Suivre le dossier',
    followHint:
      "Le terminal se place dans le dossier affiché à chaque navigation. Rien n'est envoyé pendant qu'une commande tourne.",
  },

  // ------------------------------------------------------- thèmes du design --
  themes: {
    sober: "Le Charon d'origine, sans dégradé.",
    jade: 'Écharpe verte en travers.',
    ember: 'Une montée de rouge depuis le bas.',
    readable: 'Contraste élevé, angles nets, texte grand.',
    soberName: 'Sobre',
    dayName: 'Clair de jour',
    day: 'Fond clair, halo discret.',
    auroraName: 'Aurore',
    emberName: 'Braise',
    readableName: 'Lisible',
    hidden: 'Masqué',
    shown: 'Affiché',
    none: 'Aucun',
    vault: 'Voûte',
    neon: 'Néon',
    forest: 'Forêt',
    resetTitle: 'Réinitialiser la disposition ?',
    resetMessage:
      "Les panneaux reprennent leur agencement d'origine. Les tailles et les onglets déplacés sont perdus.",
    reset: 'Réinitialiser',
  },

  // ------------------------------------------------------- corbeille (vues) --
  trashPane: {
    deleteTitle: 'Supprimer « {name} » définitivement ?',
    deleteMessage: 'Il ne sera plus récupérable.',
    emptyTitle: 'Vider la corbeille de ce dossier ?',
  },

  // ------------------------------------------------------- petits panneaux --
  panelsText: {
    trashRestore: 'Remettre à sa place',
    trashDeleteForever: 'Supprimer définitivement',
    trashSftpOnly: "La corbeille n'existe qu'en SFTP.",
    trashReading: 'Lecture de la corbeille…',
    trashEmpty: 'Rien dans la corbeille de ce dossier.',
    trashEmptyAll: 'Vider',
    noTransfers: "Aucun transfert pour l'instant.",
    clearDone: 'Effacer les terminés',
    cancelTransfer: 'Annuler ce transfert',
    remoteEditTitle: 'Édition distante',
    remoteEditStop: "Arrêter l'édition",
    remoteEditPending: 'en attente de sauvegarde',
    remoteEditsOngoing: 'Éditions en cours',
    permsRecursive: 'Appliquer à tout le contenu',
    permsRecursiveAria: 'Appliquer récursivement',
    permsRecursiveHint:
      "Les mêmes droits s'appliqueront aux fichiers comme aux dossiers : les fichiers deviendront exécutables si le bit l'est.",
    unknownOwner: 'propriétaire inconnu',
  },

  // --------------------------------------------------------------- panneaux --
  panes: {
    header: {
      parent: 'Dossier parent',
      anchorSet: 'Ouvrir ce dossier au démarrage',
      anchorClear: 'Ce dossier est celui d’ouverture. Cliquer pour retirer l’ancre.',
    },
    filter: {
      placeholder: 'Filtrer',
      ariaOf: 'Filtrer : {title}',
    },
    empty: {
      dir: 'Dossier vide',
      filtered: 'Rien ne correspond',
    },
    selection: {
      one: '{count} sélectionné',
      many: '{count} sélectionnés',
      filesSuffix: ' les fichiers',
      copyPaths: 'Copier les chemins',
      deselect: 'Désélectionner',
    },
  },

  // --------------------------------------------------------------- réglages --
  settings: {
    language: {
      name: 'Langue',
      desc: 'La langue de l’interface. Les messages venus du serveur restent tels qu’il les envoie.',
    },
  },
} as const;
