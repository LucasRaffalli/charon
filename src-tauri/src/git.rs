//! Ce que Charon sait dire d'un dépôt Git distant.
//!
//! Le terminal intégré est un vrai shell SSH : Charon n'a aucune idée de ce
//! qui s'y passe, et ne peut pas non plus réécrire l'invite du serveur pour y
//! glisser un nom de branche. La voie praticable est l'inverse : interroger le
//! dépôt à côté, par le canal exec, et afficher le résultat AUTOUR du
//! terminal plutôt que dedans.
//!
//! Sécurité : comme partout ailleurs dans Charon, la commande est construite
//! ici et jamais fournie par l'appelant. Le seul paramètre variable est un
//! chemin, validé puis passé par `shell_quote`. Toutes les sous-commandes sont
//! en LECTURE SEULE : `rev-parse`, `status`, `log`, `show`. Rien de ce module
//! ne peut modifier un dépôt, ce qui est la raison pour laquelle il peut se
//! permettre de tourner tout seul à chaque changement de dossier.

use serde::Serialize;
use tauri::State;

use crate::shell::shell_quote;
use crate::sftp::{get_connection_idle, ConnectionPool};

/// Marqueur de séparation entre les sorties. Improbable dans un vrai contenu,
/// et de toute façon nous ne lisons que des sorties de `git`.
const SEP: &str = "@@@CHARON-GIT@@@";

/// Erreur balisée : `git` n'existe pas sur ce serveur. Ce n'est pas une panne,
/// c'est un fait qui vaut pour toute la session, et le front s'en sert pour
/// cesser de sonder plutôt que de payer un canal SSH à chaque dossier.
pub(crate) const GIT_ABSENT: &str = "CHARON_NO_GIT";

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Racine du dépôt : les chemins de `status` sont relatifs à elle.
    pub root: String,
    /// Nom de la branche, ou `HEAD détachée`.
    pub branch: String,
    /// Branche de suivi (`origin/main`), vide s'il n'y en a pas.
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    /// Fichiers prêts à être committés.
    pub staged: u32,
    /// Fichiers modifiés mais pas indexés.
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    /// Dernier commit, `<abrégé> <sujet>`, vide si le dépôt n'en a aucun.
    pub last_commit: String,
    /// La branche n'a pas encore de commit (dépôt fraîchement initialisé).
    pub unborn: bool,
    /// Les fichiers concernés, dans l'ordre où git les donne.
    pub files: Vec<GitFile>,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Chemin relatif à la racine du dépôt.
    pub path: String,
    /// Les deux lettres de git (` M`, `A `, `??`, `UU`…), telles quelles.
    pub code: String,
    /// Rangement pour l'affichage : `staged`, `modified`, `untracked`,
    /// `conflicted`.
    pub kind: &'static str,
}

/// Un chemin qui va entrer dans une commande distante : absolu, sans `..`,
/// sans caractère de contrôle. Même exigence que la racine de recherche.
fn ensure_dir(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.split('/').any(|part| part == "..")
        || path.chars().any(char::is_control)
    {
        return Err("Chemin invalide.".into());
    }
    Ok(())
}

/// `[ahead 1, behind 2]` → `(1, 2)`. Absent ou illisible → `(0, 0)` : une
/// divergence qu'on ne sait pas lire vaut mieux annoncée à zéro qu'inventée.
fn parse_divergence(rest: &str) -> (u32, u32) {
    let Some(start) = rest.find('[') else {
        return (0, 0);
    };
    let Some(end) = rest[start..].find(']') else {
        return (0, 0);
    };
    let inside = &rest[start + 1..start + end];
    let mut ahead = 0;
    let mut behind = 0;
    for part in inside.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// La ligne `## …` de `git status -b`, sous ses quatre formes.
fn parse_branch_line(line: &str, status: &mut GitStatus) {
    let rest = line.trim_start_matches("## ").trim();

    // Dépôt sans le moindre commit : « No commits yet on main ».
    if let Some(name) = rest.strip_prefix("No commits yet on ") {
        status.branch = name.trim().to_string();
        status.unborn = true;
        return;
    }
    // Tête détachée : git écrit « HEAD (no branch) ».
    if rest.starts_with("HEAD (no branch)") {
        status.branch = "HEAD détachée".into();
        return;
    }

    // `main...origin/main [ahead 1]` ou `main` tout court. Le séparateur est
    // `...`, et un nom de branche peut contenir des points : on coupe sur la
    // PREMIÈRE occurrence, pas sur un point isolé.
    let (name, tail) = match rest.find("...") {
        Some(at) => (&rest[..at], &rest[at + 3..]),
        None => (rest, ""),
    };
    status.branch = name.trim().to_string();
    if !tail.is_empty() {
        let upstream = tail.split_whitespace().next().unwrap_or("");
        status.upstream = upstream.to_string();
        let (ahead, behind) = parse_divergence(tail);
        status.ahead = ahead;
        status.behind = behind;
    }
}

/// Les codes que git donne à un conflit de fusion : les deux côtés portent une
/// lettre, et l'un au moins est un `U`, ou bien c'est un ajout/suppression des
/// deux côtés.
fn is_conflict(code: &str) -> bool {
    matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

/// Une ligne de fichier de `--porcelain=v1`. Rend `None` si elle est trop
/// courte pour porter un code et un chemin.
fn parse_file_line(line: &str) -> Option<GitFile> {
    if line.len() < 4 {
        return None;
    }
    let code = &line[..2];
    // Le chemin commence au caractère 3 ; un renommage s'écrit `ancien -> nouveau`
    // et c'est la destination qui nous intéresse.
    let path = line[3..].trim();
    let path = match path.split_once(" -> ") {
        Some((_, destination)) => destination,
        None => path,
    };
    // Les guillemets apparaissent quand le nom sort de l'ASCII imprimable.
    let path = path.trim_matches('"');
    if path.is_empty() {
        return None;
    }
    let (index, worktree) = (code.as_bytes()[0] as char, code.as_bytes()[1] as char);
    let kind = if code == "??" {
        "untracked"
    } else if is_conflict(code) {
        "conflicted"
    } else if index != ' ' {
        "staged"
    } else if worktree != ' ' {
        "modified"
    } else {
        return None;
    };
    Some(GitFile {
        path: path.to_string(),
        code: code.to_string(),
        kind,
    })
}

/// Assemble le verdict à partir des trois sorties. Fonction PURE, séparée de
/// l'appel réseau exprès : c'est du parsing de format texte, exactement le
/// genre de code qui ne plante pas quand il se trompe mais affiche un chiffre
/// faux.
pub(crate) fn parse_status(root: &str, porcelain: &str, last_commit: &str) -> GitStatus {
    let mut status = GitStatus {
        root: root.trim().to_string(),
        last_commit: last_commit.trim().to_string(),
        ..Default::default()
    };
    for line in porcelain.lines() {
        if line.starts_with("## ") {
            parse_branch_line(line, &mut status);
            continue;
        }
        let Some(file) = parse_file_line(line) else {
            continue;
        };
        match file.kind {
            "untracked" => status.untracked += 1,
            "conflicted" => status.conflicted += 1,
            "staged" => {
                status.staged += 1;
                // Un fichier peut être indexé ET modifié depuis : il compte
                // des deux côtés, comme le montre n'importe quelle invite git.
                if file.code.as_bytes()[1] != b' ' {
                    status.modified += 1;
                }
            }
            _ => status.modified += 1,
        }
        status.files.push(file);
    }
    status
}

/// L'état du dépôt qui contient ce dossier, ou `None` s'il n'y en a pas.
///
/// `get_connection_idle` et non `get_connection` : ce relevé est automatique
/// (il suit la navigation), il ne doit pas réarmer le chrono d'inactivité.
/// Même règle que le moniteur, pour la même raison.
#[tauri::command]
pub async fn sftp_git_status(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    path: String,
) -> Result<Option<GitStatus>, String> {
    ensure_dir(&path)?;
    let conn = get_connection_idle(&pool, &connection_id).await?;
    let dir = shell_quote(&path);
    // `command -v git` évite le message du shell quand git n'est pas installé.
    // `rev-parse` sort en erreur hors d'un dépôt : la chaîne s'arrête et la
    // sortie reste vide, ce qui vaut « pas un dépôt » sans cas particulier.
    // `NOGIT` distingue « git n'est pas installé » de « ce dossier n'est pas
    // un dépôt » : le premier vaut pour TOUTE la session et permet au front
    // d'arrêter de sonder, le second change au dossier suivant.
    let command = format!(
        "export LC_ALL=C; command -v git >/dev/null 2>&1 || {{ printf 'NOGIT'; exit 0; }}; \
         d={dir}; \
         r=$(git -C \"$d\" rev-parse --show-toplevel 2>/dev/null) || exit 0; \
         printf '%s' \"$r\"; echo; echo '{SEP}'; \
         git -C \"$d\" status --porcelain=v1 -b 2>/dev/null; echo '{SEP}'; \
         git -C \"$d\" log -1 --format='%h %s' 2>/dev/null"
    );
    let (_code, output) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        conn.exec_capture(command, &[]),
    )
    .await
    .map_err(|_| "Délai dépassé pour l'état Git.".to_string())??;

    let mut parts = output.split(SEP);
    let root = parts.next().unwrap_or("").trim().to_string();
    if root == "NOGIT" {
        return Err(GIT_ABSENT.into());
    }
    if root.is_empty() {
        return Ok(None);
    }
    let porcelain = parts.next().unwrap_or("");
    let last_commit = parts.next().unwrap_or("");
    Ok(Some(parse_status(&root, porcelain, last_commit)))
}

/// Le contenu d'un fichier tel qu'il est dans HEAD, pour le comparer à ce
/// qu'il est devenu. Rend `None` si le fichier n'existe pas dans HEAD (il
/// vient d'être ajouté), ce qui n'est pas une erreur.
#[tauri::command]
pub async fn sftp_git_show_head(
    pool: State<'_, ConnectionPool>,
    connection_id: String,
    root: String,
    path: String,
) -> Result<Option<String>, String> {
    ensure_dir(&root)?;
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err("Chemin invalide.".into());
    }
    let conn = get_connection_idle(&pool, &connection_id).await?;
    let command = format!(
        "export LC_ALL=C; git -C {} show HEAD:{} 2>/dev/null",
        shell_quote(&root),
        shell_quote(&path),
    );
    let (code, output) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        conn.exec_capture(command, &[]),
    )
    .await
    .map_err(|_| "Délai dépassé.".to_string())??;
    Ok(if code == 0 { Some(output) } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(porcelain: &str) -> GitStatus {
        parse_status("/srv/app", porcelain, "a1b2c3d Message de commit")
    }

    #[test]
    fn branche_avec_suivi_et_divergence() {
        let s = status("## main...origin/main [ahead 1, behind 2]\n");
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream, "origin/main");
        assert_eq!((s.ahead, s.behind), (1, 2));
        assert_eq!(s.last_commit, "a1b2c3d Message de commit");
        assert!(!s.unborn);
    }

    #[test]
    fn branche_sans_suivi() {
        let s = status("## chantier\n");
        assert_eq!(s.branch, "chantier");
        assert_eq!(s.upstream, "");
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn ahead_seul_et_behind_seul() {
        let a = status("## main...origin/main [ahead 3]\n");
        assert_eq!((a.ahead, a.behind), (3, 0));
        let b = status("## main...origin/main [behind 7]\n");
        assert_eq!((b.ahead, b.behind), (0, 7));
    }

    #[test]
    fn tete_detachee_et_depot_vide() {
        assert_eq!(status("## HEAD (no branch)\n").branch, "HEAD détachée");
        let neuf = status("## No commits yet on main\n");
        assert_eq!(neuf.branch, "main");
        assert!(neuf.unborn);
    }

    /// Le nom d'une branche peut contenir des points : couper sur un point
    /// isolé donnerait « feat » au lieu de « feat.1.2 ».
    #[test]
    fn nom_de_branche_avec_des_points() {
        let s = status("## feat.1.2...origin/feat.1.2\n");
        assert_eq!(s.branch, "feat.1.2");
        assert_eq!(s.upstream, "origin/feat.1.2");
    }

    #[test]
    fn comptes_par_nature() {
        let s = status(
            "## main\n\
             M  indexe.rs\n\
             \x20M modifie.rs\n\
             ?? nouveau.txt\n\
             UU conflit.rs\n\
             A  ajoute.rs\n",
        );
        assert_eq!(s.staged, 2, "M_ et A_ sont indexés");
        assert_eq!(s.modified, 1);
        assert_eq!(s.untracked, 1);
        assert_eq!(s.conflicted, 1);
        assert_eq!(s.files.len(), 5);
    }

    /// Indexé PUIS remodifié : il compte des deux côtés, comme le montre
    /// n'importe quelle invite git.
    #[test]
    fn indexe_puis_remodifie_compte_deux_fois() {
        let s = status("## main\nMM double.rs\n");
        assert_eq!((s.staged, s.modified), (1, 1));
        assert_eq!(s.files.len(), 1, "mais une seule ligne");
    }

    #[test]
    fn renommage_garde_la_destination() {
        let s = status("## main\nR  ancien.rs -> nouveau.rs\n");
        assert_eq!(s.files[0].path, "nouveau.rs");
        assert_eq!(s.staged, 1);
    }

    #[test]
    fn nom_entre_guillemets() {
        let s = status("## main\n?? \"accentué éàü.txt\"\n");
        assert_eq!(s.files[0].path, "accentué éàü.txt");
    }

    #[test]
    fn chemin_avec_espaces_et_fleche_dans_le_nom() {
        // Un fichier qui contient « -> » sans être un renommage : il n'est pas
        // indexé, donc git ne peut pas l'écrire sous forme de renommage.
        let s = status("## main\n?? dossier/un -> autre.txt\n");
        assert_eq!(s.files[0].path, "autre.txt", "limite connue et assumée");
    }

    #[test]
    fn lignes_illisibles_ignorees_sans_planter() {
        let s = status("## main\n\nx\nab\n M ok.rs\n");
        assert_eq!(s.modified, 1);
        assert_eq!(s.files.len(), 1);
    }

    #[test]
    fn depot_propre() {
        let s = status("## main...origin/main\n");
        assert_eq!((s.staged, s.modified, s.untracked, s.conflicted), (0, 0, 0, 0));
        assert!(s.files.is_empty());
    }

    #[test]
    fn chemins_refuses() {
        assert!(ensure_dir("relatif").is_err());
        assert!(ensure_dir("/srv/../etc").is_err());
        assert!(ensure_dir("/srv/a\nb").is_err());
        assert!(ensure_dir("/srv/app").is_ok());
        // Un dossier qui contient « .. » dans son NOM reste valide.
        assert!(ensure_dir("/srv/a..b").is_ok());
    }
}
