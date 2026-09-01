//! Aller-retour texte sans perte entre le disque (des octets) et l'éditeur
//! (une chaîne).
//!
//! Le problème : tous les fichiers texte ne sont pas en UTF-8. Un vieux
//! `.conf`, un `.txt` écrit sous Windows ou un export d'outil français sont
//! souvent en latin-1, où « é » vaut l'octet 0xE9. `String::from_utf8_lossy`
//! remplace cet octet par le caractère de remplacement U+FFFD, et réécrire la
//! chaîne rend trois octets à la place d'un : le fichier est abîmé, sans que
//! rien ne le signale, et l'original est perdu.
//!
//! La parade est de rendre la conversion RÉVERSIBLE. Chaque octet invalide
//! est rangé dans la zone à usage privé d'Unicode, à `ESCAPE_BASE + octet`.
//! Ces points de code ne portent aucun sens par eux-mêmes, c'est justement ce
//! qui les rend disponibles : aucun fichier de configuration ni aucun code
//! source n'en contient. `decode` puis `encode` rend donc exactement les
//! octets de départ, octet par octet, sans avoir à comparer quoi que ce soit.
//!
//! Une autre voie aurait été de garder les octets d'origine de côté et de
//! fusionner ligne à ligne à l'enregistrement. Elle demande un alignement
//! (donc une comparaison, donc un cas où l'alignement se trompe) et ne
//! préserve qu'à la ligne près ; celle-ci préserve à l'octet près et n'a
//! aucun cas particulier.

/// Début de la plage d'échappement, dans la zone à usage privé.
/// `ESCAPE_BASE + n` représente l'octet `n` qu'UTF-8 n'expliquait pas.
const ESCAPE_BASE: u32 = 0xE000;

/// Des octets vers une chaîne affichable, réversiblement.
///
/// Rend aussi `true` quand au moins un octet a dû être échappé : l'appelant
/// sait alors que le fichier n'est pas en UTF-8, ce qui n'est pas une erreur
/// mais change ce qu'on s'autorise à en faire.
pub fn decode(bytes: &[u8]) -> (String, bool) {
    // Le cas courant, et de loin : le fichier est en UTF-8 valide. On ne
    // paie alors qu'une validation, sans recopie ni allocation en plus.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_owned(), false);
    }

    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(tail) => {
                out.push_str(tail);
                return (out, true);
            }
            Err(error) => {
                let good = error.valid_up_to();
                // Sûr : `valid_up_to` marque la fin d'une portion valide.
                out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or_default());
                // `error_len()` vide signifie une séquence coupée en fin de
                // tampon (le fichier a été lu jusqu'à une borne, pas jusqu'à
                // sa fin). Ses octets sont échappés comme les autres : ils
                // repartiront tels quels, et une lecture tronquée est de
                // toute façon en lecture seule côté interface.
                let bad = error.error_len().unwrap_or(rest.len() - good);
                for byte in &rest[good..good + bad] {
                    out.push(escape_of(*byte));
                }
                rest = &rest[good + bad..];
            }
        }
    }
}

/// D'une chaîne vers les octets à écrire : l'exact inverse de `decode`.
pub fn encode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        match unescape_of(ch) {
            Some(byte) => out.push(byte),
            None => {
                let mut buffer = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out
}

fn escape_of(byte: u8) -> char {
    // Sûr : la plage E000..E0FF est entièrement composée de points de code
    // valides (zone à usage privé, aucun substitut).
    char::from_u32(ESCAPE_BASE + byte as u32).unwrap_or(char::REPLACEMENT_CHARACTER)
}

fn unescape_of(ch: char) -> Option<u8> {
    let code = ch as u32;
    if (ESCAPE_BASE..ESCAPE_BASE + 256).contains(&code) {
        Some((code - ESCAPE_BASE) as u8)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// L'aller-retour rend les octets de départ, quoi qu'ils contiennent.
    fn round_trip(bytes: &[u8]) {
        let (text, _) = decode(bytes);
        assert_eq!(encode(&text), bytes, "aller-retour perdu sur {bytes:02X?}");
    }

    #[test]
    fn utf8_valide_intact() {
        let cases: &[&[u8]] = &[
            b"",
            b"bonjour",
            "caractère spécial".as_bytes(),
            "emoji \u{1F680} et CJK \u{4E2D}\u{6587}".as_bytes(),
            b"ligne 1\nligne 2\r\nligne 3\r",
            b"tabulation\tet nul\0dedans",
        ];
        for case in cases {
            round_trip(case);
            assert!(!decode(case).1, "signalé à tort comme non-UTF-8");
        }
    }

    #[test]
    fn latin1_conserve_ses_octets() {
        // « caractère spécial » en latin-1 : le cas qui détruisait le fichier.
        let disque = b"caract\xE9re sp\xE9cial\n";
        round_trip(disque);
        let (text, lossy) = decode(disque);
        assert!(lossy, "un fichier latin-1 doit être signalé");
        assert!(!text.contains(char::REPLACEMENT_CHARACTER), "aucun U+FFFD");
        // Le texte reste lisible autour des octets échappés.
        assert!(text.starts_with("caract"));
        assert!(text.ends_with("cial\n"));
    }

    #[test]
    fn octets_impossibles_conserves() {
        // 0xFF et 0xFE n'apparaissent jamais en UTF-8 valide ; 0xC0 0x80 est
        // un surlong interdit ; 0xED 0xA0 0x80 encoderait un substitut.
        for case in [
            &b"\xFF\xFE"[..],
            &b"\xC0\x80"[..],
            &b"\xED\xA0\x80"[..],
            &b"d\xE9but \xFF fin"[..],
        ] {
            round_trip(case);
            assert!(decode(case).1);
        }
    }

    #[test]
    fn sequence_coupee_en_fin_de_lecture() {
        // Une lecture bornée peut s'arrêter au milieu d'un caractère : les
        // octets orphelins doivent repartir tels quels, pas devenir un U+FFFD.
        let complet = "déjà".as_bytes();
        for coupe in 1..complet.len() {
            round_trip(&complet[..coupe]);
        }
    }

    #[test]
    fn edition_autour_des_octets_prives() {
        // Ce que fait l'utilisateur : il modifie une ligne, pas les autres.
        let disque = b"nom = valeur\ncomment\xE9 = oui\n";
        let (text, _) = decode(disque);
        let edite = text.replace("nom = valeur", "nom = autre");
        let ecrit = encode(&edite);
        // La ligne touchée est réécrite, la ligne intacte garde SON octet.
        assert!(ecrit.starts_with(b"nom = autre\n"));
        assert!(ecrit.ends_with(b"comment\xE9 = oui\n"));
        assert!(!ecrit.windows(3).any(|w| w == [0xEF, 0xBF, 0xBD]));
    }

    #[test]
    fn texte_ordinaire_jamais_reinterprete() {
        // Un texte qui n'a jamais été échappé ne doit rien perdre à l'écriture.
        let source = "const x = \"café\"; // 100 % ✓\n";
        assert_eq!(encode(source), source.as_bytes());
    }
}
