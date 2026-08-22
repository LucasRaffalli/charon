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
  | 'module'
  | 'error';

/** Une opération horodatée du journal d'activité. */
export interface ActivityEntry {
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
}
