// Généré par scripts/make-changelog.sh — NE PAS ÉDITER À LA MAIN.
// Régénéré à chaque release (npm run release) depuis les tags git ;
// embarqué dans le bundle : l'historique survit aux mises à jour.

export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    "version": "1.0.0",
    "date": "2026-08-23",
    "notes": [
      "Modules : runtime d'exécution, capacités chantier 2, panneaux déclaratifs, moniteur VPS",
      "Modules : backend de gestion + onglet Réglages",
      "Modules : doc d'architecture + contrat de types",
      "Escalade sudo (hors WebView), création de fichiers, menus enrichis",
      "Dock librement réagençable, refonte explorateur, a11y, inactivité fiable, README",
      "Refonte login (cover + panneau), typo Satoshi/JetBrains Mono, réglages repensés, v1.0.0",
      "Pipeline de release/déploiement updater + fixes de warnings",
      "Logo, filigrane de fond, icônes + fix build prod sans styles",
      "Aperçu/édition intégré + édition distante configurable",
      "Garde-fous par serveur (idée n°12)",
      "Logs live (idée n°4) + correctifs panneau et terminal",
      "- Tabs : l'indicateur se re-mesure quand les libellés changent de largeur   (compteur de transferts) au lieu d'empiéter sur les onglets voisins",
      "Command palette Cmd+K (idée n°7)",
      "Environnements dev/staging/prod + badge PROD (idée n°11)",
      "Terminal SSH intégré (idée n°1) dans le panneau inférieur",
      "Journal d'activité (idée n°18) dans le panneau inférieur",
      "Panneau inférieur à onglets, les Transferts y migrent",
      "Transferts : fichiers .charonpart, file persistante et reprise",
      "Updater signé (tauri-plugin-updater)",
      "Support FTP/FTPS (roadmap n°1)",
      "Réglages : délai d'inactivité configurable, thème dans le panneau uniquement",
      "Tabs : indicateur glissant et hauteur animée",
      "Suppression récursive de dossiers avec confirmation renforcée",
      "Transferts en streaming, drag & drop, arborescence serveur",
      "Sécurité : russh 0.62, secrets hors WebView, TOFU explicite, CSP",
      "feat: add file explorer feature with SFTP and local file system support",
      "Download/upload SFTP fonctionnels",
      "Session SFTP persistante avec pool de connexions",
      "Charon: première connexion SFTP réussie"
    ]
  }
];
