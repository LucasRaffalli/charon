//! Les erreurs destinées à l'utilisateur.
//!
//! Le backend ne renvoie pas une phrase, il renvoie un **code** que le front
//! traduit, plus le détail brut qui, lui, ne se traduit pas : un chemin, ou le
//! message du système (« No such file or directory » vient d'OpenSSH ou de
//! l'OS, dans leur langue à eux — le traduire serait mentir sur ce qui a été
//! répondu).
//!
//! Pourquoi ici et pas un dictionnaire en Rust : le vocabulaire du produit
//! existe déjà, côté front, typé et vérifié à la compilation. En tenir un
//! second dans un autre langage, c'est garantir qu'ils divergeront. Le
//! backend dit ce qui s'est passé, le front décide comment le dire.
//!
//! C'est aussi la convention déjà en place dans Charon pour les cas que le
//! front doit reconnaître (`CHARON_CANCELLED`, `CHARON_UNKNOWN_KEY`) : on ne
//! l'invente pas, on l'étend.

/// Le séparateur entre le code et le détail : un caractère de contrôle
/// (U+001F, « unit separator »), qui ne peut pas apparaître dans un message.
pub const SEP: char = '\u{1f}';

/// Erreur utilisateur : `CHARON_ERR:<code>` suivi du détail brut.
///
/// Le détail garde le message système TEL QUEL, et c'est important au-delà de
/// l'affichage : `SftpService.escalateOnDenied` reconnaît « permission denied »
/// dans le texte pour proposer l'escalade sudo. Le remplacer par un code
/// couperait cette chaîne.
pub fn user_err(code: &str, detail: impl std::fmt::Display) -> String {
    format!("CHARON_ERR:{code}{SEP}{detail}")
}

/// Erreur utilisateur sans détail à ajouter.
pub fn user_code(code: &str) -> String {
    format!("CHARON_ERR:{code}")
}
