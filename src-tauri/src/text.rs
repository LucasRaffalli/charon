//! Aller-retour texte sans perte entre le disque (des octets) et l'éditeur
//! (une chaîne), avec conversion quand elle est sûre.
//!
//! Trois régimes, choisis à la lecture et conservés jusqu'à l'écriture :
//!
//! - **Utf8** : le fichier est de l'UTF-8 valide. Aucune transformation, dans
//!   aucun sens. Surtout pas le dés-échappement de la zone privée : un
//!   fichier UTF-8 peut légitimement contenir des caractères U+E000-U+E0FF
//!   (les glyphes powerline des configs starship/oh-my-zsh vivent là), et la
//!   première version de ce module les corrompait en octets bruts.
//! - **Windows1252** : le fichier n'est pas de l'UTF-8 mais tout s'explique
//!   en Windows-1252 (le latin-1 du monde réel : ce que produit un vieux
//!   Windows, un export d'outil français, un `.conf` d'un autre âge). On le
//!   DÉCODE : « é » s'affiche « é », pas en carré. La table est injective,
//!   donc l'aller-retour est exact à l'octet près sur ce qui n'est pas
//!   modifié. Si une édition introduit un caractère hors de cette table (un
//!   emoji), l'écriture bascule tout le fichier en UTF-8 et le dit.
//! - **Escaped** : le repli qui ne perd jamais rien. Utilisé quand le fichier
//!   MÉLANGE de l'UTF-8 valide et des octets inexplicables (un fichier abîmé
//!   par une fusion, par exemple) : le décoder en 1252 transformerait les
//!   parties valides en mojibake (« é » → « Ã© »), on préfère montrer un
//!   carré et rendre les octets intacts. Chaque octet invalide est rangé en
//!   zone privée à `ESCAPE_BASE + octet`, l'écriture fait l'inverse exact.
//!
//! Le choix entre 1252 et Escaped tient en une question : y a-t-il au moins
//! une séquence UTF-8 multioctets valide dans le fichier ? Si oui, c'est un
//! fichier UTF-8 abîmé, pas un fichier 1252. Si non, et qu'aucun octet ne
//! tombe sur les cinq trous de la table 1252, la conversion est sûre.

use serde::Serialize;

/// Début de la plage d'échappement, dans la zone à usage privé.
/// `ESCAPE_BASE + n` représente l'octet `n` qu'UTF-8 n'expliquait pas.
const ESCAPE_BASE: u32 = 0xE000;

/// Le régime d'un texte, décidé à la lecture, rendu au front, et exigé à
/// l'écriture : c'est lui qui dit comment refabriquer les octets.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TextEncoding {
    Utf8,
    Windows1252,
    Escaped,
}

impl TextEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "utf8",
            TextEncoding::Windows1252 => "windows1252",
            TextEncoding::Escaped => "escaped",
        }
    }

    /// Depuis le front. Un inconnu vaut UTF-8 : l'écriture la plus neutre.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "windows1252" => TextEncoding::Windows1252,
            "escaped" => TextEncoding::Escaped,
            _ => TextEncoding::Utf8,
        }
    }
}

/// Un texte lu, avec le régime qui permettra de le réécrire à l'identique.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRead {
    pub text: String,
    pub encoding: &'static str,
}

/// Windows-1252, plage 0x80..0xA0 : la seule qui diffère du latin-1.
/// Zéro = octet non défini (les cinq trous de la table).
const CP1252_HIGH: [u32; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, //
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0, //
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, //
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

// ---------- Lecture ----------

/// Des octets vers une chaîne affichable, et le régime qui va avec.
pub fn decode_smart(bytes: &[u8]) -> (String, TextEncoding) {
    // Le cas courant, et de loin : UTF-8 valide, une validation et rien d'autre.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_owned(), TextEncoding::Utf8);
    }
    // Pas d'UTF-8 multioctets dedans : c'est un fichier mono-octet, la
    // conversion 1252 est sûre si aucun octet ne tombe dans les trous.
    if !has_valid_multibyte(bytes) {
        if let Some(text) = decode_1252(bytes) {
            return (text, TextEncoding::Windows1252);
        }
    }
    (decode_escaped(bytes), TextEncoding::Escaped)
}

/// Y a-t-il au moins UNE séquence UTF-8 multioctets valide ? Si oui, décoder
/// en 1252 fabriquerait du mojibake sur les parties saines du fichier.
fn has_valid_multibyte(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(tail) => return tail.bytes().any(|byte| byte >= 0x80),
            Err(error) => {
                let good = error.valid_up_to();
                if rest[..good].iter().any(|byte| *byte >= 0x80) {
                    return true;
                }
                let bad = error.error_len().unwrap_or(rest.len() - good);
                rest = &rest[good + bad..];
                if rest.is_empty() {
                    return false;
                }
            }
        }
    }
}

/// Windows-1252, ou `None` si un octet tombe sur un trou de la table :
/// refuser vaut mieux que convertir faux.
fn decode_1252(bytes: &[u8]) -> Option<String> {
    let mut out = String::with_capacity(bytes.len());
    for byte in bytes {
        out.push(char_1252(*byte)?);
    }
    Some(out)
}

fn char_1252(byte: u8) -> Option<char> {
    if (0x80..0xA0).contains(&byte) {
        let code = CP1252_HIGH[(byte - 0x80) as usize];
        return if code == 0 { None } else { char::from_u32(code) };
    }
    // ASCII et 0xA0..0xFF : identiques au latin-1, donc au point de code.
    Some(byte as char)
}

/// Le repli sans perte : les octets inexplicables partent en zone privée.
fn decode_escaped(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(tail) => {
                out.push_str(tail);
                return out;
            }
            Err(error) => {
                let good = error.valid_up_to();
                out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or_default());
                // `error_len()` vide = séquence coupée en fin de tampon (une
                // lecture bornée s'est arrêtée au milieu d'un caractère). Ses
                // octets sont échappés comme les autres et repartiront intacts.
                let bad = error.error_len().unwrap_or(rest.len() - good);
                for byte in &rest[good..good + bad] {
                    out.push(escape_of(*byte));
                }
                rest = &rest[good + bad..];
            }
        }
    }
}

// ---------- Écriture ----------

/// D'une chaîne vers les octets à écrire, selon le régime de LECTURE du
/// document. Rend aussi le régime effectivement écrit : un document 1252
/// où l'édition a introduit un caractère hors table (un emoji) bascule en
/// UTF-8 entier plutôt que d'écrire faux, et l'appelant doit pouvoir le dire.
pub fn encode_for(text: &str, encoding: TextEncoding) -> (Vec<u8>, TextEncoding) {
    match encoding {
        // Aucune transformation : un caractère en zone privée dans un fichier
        // UTF-8 est un vrai caractère (glyphes powerline), pas un échappement.
        TextEncoding::Utf8 => (text.as_bytes().to_vec(), TextEncoding::Utf8),
        TextEncoding::Windows1252 => match encode_1252(text) {
            Some(bytes) => (bytes, TextEncoding::Windows1252),
            None => (text.as_bytes().to_vec(), TextEncoding::Utf8),
        },
        TextEncoding::Escaped => (encode_escaped(text), TextEncoding::Escaped),
    }
}

/// L'inverse exact de `decode_1252`, ou `None` dès qu'un caractère n'a pas
/// de place dans la table.
fn encode_1252(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        out.push(byte_1252(ch)?);
    }
    Some(out)
}

fn byte_1252(ch: char) -> Option<u8> {
    let code = ch as u32;
    if code < 0x80 {
        return Some(code as u8);
    }
    // 0xA0..0xFF : au point de code, SAUF la plage C1 (0x80..0x9F) que le
    // décodage ne produit jamais : la refuser force le repli UTF-8.
    if (0xA0..=0xFF).contains(&code) {
        return Some(code as u8);
    }
    CP1252_HIGH
        .iter()
        .position(|candidate| *candidate == code)
        .map(|at| 0x80 + at as u8)
}

/// L'inverse exact de `decode_escaped`.
fn encode_escaped(text: &str) -> Vec<u8> {
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

    /// L'aller-retour rend les octets de départ, quel que soit le régime élu.
    fn round_trip(bytes: &[u8]) -> TextEncoding {
        let (text, encoding) = decode_smart(bytes);
        let (back, used) = encode_for(&text, encoding);
        assert_eq!(back, bytes, "aller-retour perdu sur {bytes:02X?}");
        assert_eq!(used, encoding, "le régime a changé sans édition");
        encoding
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
            assert_eq!(round_trip(case), TextEncoding::Utf8);
        }
    }

    /// LA régression de la première version : un fichier UTF-8 valide qui
    /// contient des caractères en zone privée (glyphes powerline des configs
    /// starship/oh-my-zsh). Ils doivent repartir tels quels, jamais être
    /// pris pour des échappements.
    #[test]
    fn zone_privee_dans_un_utf8_valide() {
        let disque = "PS1='\u{e0b0}' # séparateur \u{e0b2}".as_bytes();
        assert_eq!(round_trip(disque), TextEncoding::Utf8);
    }

    #[test]
    fn latin1_devient_lisible() {
        // « caractère spécial » en latin-1 : le cas qui s'affichait en carrés.
        let disque = b"caract\xE8re sp\xE9cial\n";
        assert_eq!(round_trip(disque), TextEncoding::Windows1252);
        let (text, _) = decode_smart(disque);
        assert_eq!(text, "caractère spécial\n");
    }

    #[test]
    fn cp1252_typographique() {
        // Les guillemets et l'euro de Word, dans la plage 0x80..0xA0.
        let disque = b"prix\x80 \x93cit\xE9\x94 \x85";
        assert_eq!(round_trip(disque), TextEncoding::Windows1252);
        let (text, _) = decode_smart(disque);
        assert_eq!(text, "prix€ “cité” …");
    }

    /// Tous les octets définis de la table font l'aller-retour exact.
    #[test]
    fn table_1252_injective() {
        for byte in 0u8..=255 {
            if matches!(byte, 0x81 | 0x8D | 0x8F | 0x90 | 0x9D) {
                continue;
            }
            let ch = char_1252(byte).expect("octet défini");
            assert_eq!(byte_1252(ch), Some(byte), "octet {byte:02X}");
        }
    }

    /// Un octet des cinq trous de la table : la conversion refuse, le repli
    /// échappé prend le relais, rien n'est perdu.
    #[test]
    fn trou_de_table_refuse() {
        let disque = b"avant \x8D apr\xE8s";
        assert_eq!(round_trip(disque), TextEncoding::Escaped);
    }

    /// Un fichier qui MÉLANGE UTF-8 valide et octets latin-1 : le décoder en
    /// 1252 ferait du mojibake sur la partie saine, le repli échappé préserve.
    #[test]
    fn melange_utf8_et_latin1() {
        let mut disque = "début propre é ".as_bytes().to_vec();
        disque.extend_from_slice(b"cass\xE9 ensuite");
        assert_eq!(round_trip(&disque), TextEncoding::Escaped);
        let (text, _) = decode_smart(&disque);
        assert!(text.starts_with("début propre é "), "la partie saine reste lisible");
    }

    /// Édition d'un document 1252 : la ligne touchée est réécrite, l'octet de
    /// la ligne intacte est conservé, et le régime ne bouge pas.
    #[test]
    fn edition_dans_un_1252() {
        let disque = b"nom = valeur\ncomment\xE9 = oui\n";
        let (text, encoding) = decode_smart(disque);
        let edited = text.replace("nom = valeur", "nom = autre");
        let (bytes, used) = encode_for(&edited, encoding);
        assert_eq!(used, TextEncoding::Windows1252);
        assert!(bytes.starts_with(b"nom = autre\n"));
        assert!(bytes.ends_with(b"comment\xE9 = oui\n"));
    }

    /// Un emoji tapé dans un document 1252 : la table ne sait pas l'écrire,
    /// tout le fichier bascule en UTF-8 et l'appelant en est prévenu.
    #[test]
    fn emoji_dans_un_1252_bascule_en_utf8() {
        let (text, encoding) = decode_smart(b"caf\xE9\n");
        let edited = format!("{text}fusée \u{1F680}\n");
        let (bytes, used) = encode_for(&edited, encoding);
        assert_eq!(used, TextEncoding::Utf8);
        assert_eq!(bytes, "café\nfusée \u{1F680}\n".as_bytes());
    }

    #[test]
    fn octets_impossibles_conserves() {
        // 0xFF 0xFE et un surlong : jamais valides en UTF-8. 0x90 les envoie
        // au régime échappé (trou de table), les autres passent en 1252.
        for case in [&b"\x90\xFF\xFE"[..], &b"d\xE9but \x81 fin"[..]] {
            assert_eq!(round_trip(case), TextEncoding::Escaped);
        }
    }

    #[test]
    fn sequence_coupee_en_fin_de_lecture() {
        // Une lecture bornée peut s'arrêter au milieu d'un caractère : les
        // octets orphelins repartent tels quels.
        let complet = "déjà".as_bytes();
        for coupe in 1..complet.len() {
            round_trip(&complet[..coupe]);
        }
    }

    #[test]
    fn parse_et_as_str_alignes() {
        for encoding in [TextEncoding::Utf8, TextEncoding::Windows1252, TextEncoding::Escaped] {
            assert_eq!(TextEncoding::parse(encoding.as_str()), encoding);
        }
        assert_eq!(TextEncoding::parse("inconnu"), TextEncoding::Utf8);
    }
}
