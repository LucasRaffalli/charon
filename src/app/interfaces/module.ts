/**
 * Contrat du système de Modules (extensions tierces sandboxées).
 * Voir docs/modules.md pour l'architecture et le modèle de sécurité.
 */

/** Capabilities qu'un module peut demander. Refus par défaut de tout le reste. */
export type ModulePermission =
  | 'remote:read'
  | 'remote:write'
  | 'local:read'
  | 'local:write'
  | 'ui:command'
  | 'ui:panel'
  | 'ui:menu'
  | 'events'
  | 'storage';

/** Commande contribuée (affichée dans la palette). */
export interface ModuleCommandContribution {
  id: string;
  title: string;
  /** Mots-clés de recherche pour la palette. */
  keywords?: string;
}

/** Panneau dockable contribué (rendu dans l'iframe du module). */
export interface ModulePanelContribution {
  id: string;
  title: string;
  /** Nom d'icône lucide (validé contre le registre côté hôte). */
  icon?: string;
}

/** Contributions déclaratives, pré-enregistrées avant activation du code. */
export interface ModuleContributes {
  commands?: ModuleCommandContribution[];
  panels?: ModulePanelContribution[];
}

/** Manifeste d'un module (`manifest.json`). */
export interface ModuleManifest {
  /** Identifiant unique en reverse-DNS (ex. com.exemple.compteur). */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Point d'entrée JS, relatif au dossier du module. */
  main: string;
  /** Version d'API Modules requise (semver range, ex. "^1"). */
  engine: string;
  permissions: ModulePermission[];
  contributes?: ModuleContributes;
}

/** État d'un module découvert côté hôte. */
export interface ModuleRecord {
  manifest: ModuleManifest;
  /** Dossier du module sur le disque (géré par le backend, jamais par l'iframe). */
  dir: string;
  enabled: boolean;
  /** Renseigné si le manifeste est invalide (module non chargeable). */
  error?: string;
}

// ---------- Pont postMessage hôte ↔ module ----------
//
// Un seul canal : le module ne peut RIEN faire d'autre que d'envoyer ces
// messages. L'hôte vérifie chaque requête contre les permissions accordées.

/** Requête du module vers l'hôte (appel d'API). */
export interface ModuleRequest {
  kind: 'request';
  /** Corrélation requête/réponse. */
  id: number;
  /** Méthode de l'API hôte, ex. "fs.remote.list". */
  method: string;
  params?: unknown;
}

/** Réponse de l'hôte à une requête. */
export interface ModuleResponse {
  kind: 'response';
  id: number;
  result?: unknown;
  /** Présent si l'appel a échoué (permission refusée, erreur d'exécution…). */
  error?: string;
}

/** Enregistrement d'un callback (commande/menu) déclenché par l'hôte. */
export interface ModuleInvoke {
  kind: 'invoke';
  /** Cible : id de commande, id de panneau, nom d'événement… */
  target: string;
  payload?: unknown;
}

/** Message de cycle de vie hôte → module. */
export interface ModuleActivate {
  kind: 'activate';
  /** Permissions réellement accordées (peut être un sous-ensemble du manifeste). */
  granted: ModulePermission[];
  /** Contexte initial non sensible (protocole, connecté ou non…). */
  context: { connected: boolean; protocol: string | null };
}

/** Union des messages hôte → module. */
export type HostToModuleMessage = ModuleResponse | ModuleInvoke | ModuleActivate;

/** Union des messages module → hôte. */
export type ModuleToHostMessage = ModuleRequest;
