//! Text normalization (spec 3.3).
//!
//! Pure functions only; no I/O. Legal forms are passed in as [`LegalForms`].

use rust_decimal::Decimal;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Legal-form token sequences from `data/legal-forms.json`, pre-tokenized and
/// sorted by token count descending, then alphabetically.
#[derive(Debug, Clone)]
pub struct LegalForms {
    forms: Vec<Vec<String>>,
}

impl LegalForms {
    /// Parses a JSON array of strings; each entry is tokenized with [`tokens`].
    /// Entries that tokenize to nothing are dropped.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let raw: Vec<String> = serde_json::from_str(json)?;
        let mut forms: Vec<Vec<String>> = raw
            .iter()
            .map(|f| tokens(f))
            .filter(|t| !t.is_empty())
            .collect();
        forms.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        forms.dedup();
        Ok(Self { forms })
    }
}

/// Whitespace as defined in spec 3.1: space, tab, CR, LF.
fn trim(s: &str) -> &str {
    s.trim_matches([' ', '\t', '\r', '\n'])
}

/// `Some` only for a value that is non-blank after trimming.
fn present(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !trim(s).is_empty())
}

/// Base function: NFKD, drop marks, lowercase, `ß` → `ss`, non `[a-z0-9]` → space, split.
pub fn tokens(s: &str) -> Vec<String> {
    let lowered: String = s
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
        .replace('ß', "ss");
    let spaced: String = lowered
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                ' '
            }
        })
        .collect();
    spaced
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

/// `tokens(s)` joined without separator.
pub fn compact(s: &str) -> String {
    tokens(s).concat()
}

/// Company name with legal forms removed; falls back to `compact(s)` if nothing remains.
pub fn name(s: &str, legal_forms: &LegalForms) -> String {
    let mut toks = tokens(s);
    loop {
        let mut changed = false;
        for form in &legal_forms.forms {
            let n = form.len();
            let mut i = 0;
            while i + n <= toks.len() {
                if toks[i..i + n] == form[..] {
                    toks.drain(i..i + n);
                    changed = true;
                } else {
                    i += 1;
                }
            }
        }
        if !changed {
            break;
        }
    }
    if toks.is_empty() {
        compact(s)
    } else {
        toks.concat()
    }
}

/// VAT ID: uppercase, keep only `A-Z0-9`, prefix `GR` → `EL`.
pub fn vat(s: &str) -> String {
    let v: String = s
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .collect();
    match v.strip_prefix("GR") {
        Some(rest) => format!("EL{rest}"),
        None => v,
    }
}

/// `compact(s)` with every `strasse` replaced by `str`.
pub fn street(s: &str) -> String {
    compact(s).replace("strasse", "str")
}

/// `street(BT-35)|compact(BT-38)|compact(BT-37)|compact(BT-40)`;
/// `None` when BT-35, BT-38 and BT-37 are all missing (absent or blank).
pub fn postal(
    street_line: Option<&str>,
    postcode: Option<&str>,
    city: Option<&str>,
    country: Option<&str>,
) -> Option<String> {
    let (street_line, postcode, city) = (present(street_line), present(postcode), present(city));
    if street_line.is_none() && postcode.is_none() && city.is_none() {
        return None;
    }
    Some(format!(
        "{}|{}|{}|{}",
        street_line.map(street).unwrap_or_default(),
        postcode.map(compact).unwrap_or_default(),
        city.map(compact).unwrap_or_default(),
        country.map(compact).unwrap_or_default(),
    ))
}

/// Email domain from BT-43; if BT-43 is absent, from BT-34 only when its scheme is `EM`.
/// Trimmed, lowercase, part after the last `@`, one trailing `.` removed.
/// No `@` or empty result → `None`.
pub fn email_domain(bt43: Option<&str>, bt34: Option<(&str, &str)>) -> Option<String> {
    let raw = match bt43 {
        Some(v) => v,
        None => match bt34 {
            Some(("EM", v)) => v,
            _ => return None,
        },
    };
    let lowered = trim(raw).to_lowercase();
    let (_, domain) = lowered.rsplit_once('@')?;
    let domain = domain.strip_suffix('.').unwrap_or(domain);
    if domain.is_empty() {
        None
    } else {
        Some(domain.to_string())
    }
}

/// Phone number: digits only, `+` kept (or derived from a leading `00`);
/// fewer than 3 digits → `None`.
pub fn phone(s: &str) -> Option<String> {
    let s = trim(s);
    let mut plus = s.starts_with('+');
    let mut digits: String = s.chars().filter(char::is_ascii_digit).collect();
    if !plus && digits.starts_with("00") {
        plus = true;
        digits.drain(..2);
    }
    if digits.len() < 3 {
        return None;
    }
    Some(if plus { format!("+{digits}") } else { digits })
}

/// Invoice number: trimmed, uppercase.
pub fn invoice_no(s: &str) -> String {
    trim(s).to_uppercase()
}

/// Order ID: trimmed, uppercase (for comparison with `open-orders.json`).
pub fn order_id(s: &str) -> String {
    trim(s).to_uppercase()
}

/// Decimal with exactly two fraction digits, `.` separator, no grouping (`1190.00`).
pub fn amount(d: &Decimal) -> String {
    let mut d = *d;
    d.rescale(2);
    d.to_string()
}

/// `" " + tokens(s).join(" ") + " "` (for I-5 phrase matching).
pub fn phrase_text(s: &str) -> String {
    format!(" {} ", tokens(s).join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn legal_forms() -> LegalForms {
        LegalForms::from_json(include_str!("../data/legal-forms.json"))
            .expect("data/legal-forms.json parses")
    }

    /// Spec test 35: every row of the 3.3 "Funktion | Eingabe | Ergebnis" table.
    #[test]
    fn test35_name_vectors() {
        let lf = legal_forms();
        let cases = [
            ("Alpha Consulting GmbH", "alphaconsulting"),
            ("Müller & Söhne GmbH & Co. KG", "mullersohne"),
            ("ACME Ltd.", "acme"),
            ("AG", "ag"),
            ("E.K. Schmidt e.K.", "schmidt"),
            ("Bäckerei Groß UG (haftungsbeschränkt)", "backereigross"),
            ("Polski Handel Sp. z o.o.", "polskihandel"),
        ];
        for (input, expected) in cases {
            assert_eq!(name(input, &lf), expected, "name({input:?})");
        }
    }

    #[test]
    fn test35_vat_vectors() {
        let cases = [
            ("de 111 111 111", "DE111111111"),
            ("GR 123456789", "EL123456789"),
            ("DE-111.111.111", "DE111111111"),
        ];
        for (input, expected) in cases {
            assert_eq!(vat(input), expected, "vat({input:?})");
        }
    }

    #[test]
    fn test35_phone_vectors() {
        let cases = [
            ("+49 89 1234567", Some("+49891234567")),
            ("0049 (0)89 1234567", Some("+490891234567")),
            ("089/1234567", Some("0891234567")),
            ("12", None),
        ];
        for (input, expected) in cases {
            assert_eq!(phone(input).as_deref(), expected, "phone({input:?})");
        }
    }

    #[test]
    fn test35_postal_vector() {
        assert_eq!(
            postal(
                Some("Musterstraße 1"),
                Some("80333"),
                Some("München"),
                Some("DE")
            )
            .as_deref(),
            Some("musterstr1|80333|munchen|de")
        );
    }

    #[test]
    fn postal_none_when_street_postcode_city_missing() {
        assert_eq!(postal(None, None, None, Some("DE")), None);
        assert_eq!(
            postal(None, Some("80333"), None, Some("DE")).as_deref(),
            Some("|80333||de")
        );
    }

    #[test]
    fn tokens_and_compact() {
        assert_eq!(tokens("  Groß-Händler, 2 "), ["gross", "handler", "2"]);
        assert_eq!(compact("Groß-Händler, 2"), "grosshandler2");
        assert!(tokens(" -- ").is_empty());
    }

    #[test]
    fn legal_forms_sorted_by_token_count_then_alphabetical() {
        let lf = legal_forms();
        let joined: Vec<String> = lf.forms.iter().map(|f| f.join(" ")).collect();
        assert_eq!(joined[..2], ["sp z o o", "ug haftungsbeschrankt co kg"]);
        assert_eq!(joined.last().map(String::as_str), Some("vof"));
        for w in lf.forms.windows(2) {
            assert!(
                w[0].len() > w[1].len() || (w[0].len() == w[1].len() && w[0] <= w[1]),
                "{:?} before {:?}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn email_domain_prefers_bt43() {
        assert_eq!(
            email_domain(
                Some(" Billing@Alpha-Consulting.Example "),
                Some(("EM", "x@other.example"))
            )
            .as_deref(),
            Some("alpha-consulting.example")
        );
    }

    #[test]
    fn email_domain_bt34_only_with_scheme_em() {
        assert_eq!(
            email_domain(None, Some(("EM", "info@alpha.example"))).as_deref(),
            Some("alpha.example")
        );
        assert_eq!(
            email_domain(None, Some(("0088", "info@alpha.example"))),
            None
        );
        assert_eq!(email_domain(None, None), None);
    }

    #[test]
    fn email_domain_last_at_and_trailing_dot() {
        assert_eq!(
            email_domain(Some("a@b@Alpha.Example."), None).as_deref(),
            Some("alpha.example")
        );
    }

    #[test]
    fn email_domain_without_at_or_empty_is_none() {
        assert_eq!(email_domain(Some("alpha.example"), None), None);
        assert_eq!(email_domain(Some("user@"), None), None);
        assert_eq!(email_domain(Some("   "), None), None);
    }

    #[test]
    fn amount_has_exactly_two_decimals() {
        assert_eq!(amount(&Decimal::from_str("1190").unwrap()), "1190.00");
        assert_eq!(amount(&Decimal::from_str("1190.5").unwrap()), "1190.50");
        assert_eq!(amount(&Decimal::from_str("1190.00").unwrap()), "1190.00");
    }

    #[test]
    fn phrase_text_pads_with_spaces() {
        assert_eq!(
            phrase_text(" Bitte heute noch zahlen "),
            " bitte heute noch zahlen "
        );
    }

    #[test]
    fn invoice_no_and_order_id_trim_and_uppercase() {
        assert_eq!(invoice_no("\t re-2026-0412 \n"), "RE-2026-0412");
        assert_eq!(order_id(" po-2026-001 "), "PO-2026-001");
    }

    #[test]
    fn street_replaces_strasse() {
        assert_eq!(street("Haupt Straße 5"), "hauptstr5");
    }
}
