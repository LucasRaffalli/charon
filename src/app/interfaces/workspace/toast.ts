/** Nature d'un toast : décide de la couleur, de l'icône et de la durée. */
export type ToastKind = 'success' | 'error' | 'info';

/** Un bouton porté par le toast, quand il y a quelque chose à faire. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/**
 * Une confirmation éphémère d'un geste.
 *
 * À ne pas confondre avec l'alerte inline d'un écran (l'erreur de connexion,
 * celle du panneau serveur) : celle-là explique un état qui dure et doit rester
 * sous les yeux. Un toast dit qu'une action vient d'aboutir, ce qui n'a de sens
 * qu'un instant.
 */
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Précision en seconde ligne : un chemin, le détail d'un échec. */
  detail?: string | null;
  /**
   * Le mot porté par l'en-tête. Par défaut celui de la nature ; un toast qui
   * annonce autre chose qu'un simple succès dit quoi (« Mise à jour »).
   */
  title?: string | null;
  /**
   * Durée de vie en millisecondes, portée par le toast lui-même : c'est elle
   * qui cale la ligne de temps, sans que la vue ait à connaître le barème.
   * Zéro pour un toast collant.
   */
  life: number;
  /**
   * Un toast collant ne s'efface pas tout seul : il décrit un état qui dure
   * (une mise à jour disponible) et non un geste qui vient d'aboutir. Il part
   * quand l'état change, ou quand on le referme.
   */
  sticky?: boolean;
  action?: ToastAction | null;
  /**
   * Identité stable, pour remplacer ou retirer un toast qu'on a déjà posé.
   * Un état qui change ne doit pas empiler trois annonces du même sujet.
   */
  key?: string | null;
}
