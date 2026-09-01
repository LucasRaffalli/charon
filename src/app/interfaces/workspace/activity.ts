/** Nature d'une entrée du journal d'activité. */
export type ActivityKind =
  | 'connect'
  | 'disconnect'
  | 'mkdir'
  | 'rename'
  | 'remove'
  | 'download'
  | 'upload'
  | 'resume'
  | 'cancel'
  | 'edit'
  | 'anchor'
  | 'favorite'
  | 'module'
  | 'error';

/** Une opération horodatée du journal d'activité. */
export interface ActivityEntry {
  /** Identité stable pour le rendu (le journal se PRÉFIXE : un track par
   *  index réécrivait les 500 lignes du DOM à chaque action). */
  id: number;
  /** Epoch en millisecondes. */
  at: number;
  kind: ActivityKind;
  /** Côté concerné : serveur distant ou disque local. */
  scope: 'remote' | 'local';
  /** Chemin ou identifiant de connexion. */
  target: string;
  /** Précision optionnelle (nouveau nom, taille, message d'erreur…). */
  detail: string | null;
  ok: boolean;
  /** Session à l'origine du geste (s1, s2…) ; nul pour le local et l'app. */
  session?: string | null;
}
