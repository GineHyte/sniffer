//! CII XML parsing and field checks (spec 3.1, FR-11..14).
//!
//! [`parse_invoice`] strips a leading BOM, parses with `roxmltree` (no DTD,
//! node limit), checks the root element and reads every field of the 3.1
//! table by child steps (namespace + local name). All KO-1 codes are collected
//! in table order. A field that is missing or fails its check is `None` (or
//! empty) in [`Invoice`]; the reason is in [`ParseOutcome::ko1_codes`].
//! BT-84 is kept as the raw trimmed value; its address check is 3.4 (KO-2).

use std::str::FromStr;
use std::sync::LazyLock;

use chrono::NaiveDate;
use regex::Regex;
use roxmltree::{Document, Node, ParsingOptions};
use rust_decimal::Decimal;

use crate::normalize;

pub const NS_RSM: &str = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";
pub const NS_RAM: &str =
    "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100";
pub const NS_UDT: &str = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100";

/// `roxmltree` node limit (FR-12).
pub const NODES_LIMIT: u32 = 200_000;
/// Reserved BT-22 prefix for wallet-signature entries (3.2, section 11).
pub const SIGNATURE_PREFIX: &str = "cardano-sig-";
/// Accepted BT-3 values (3.1).
pub const SUPPORTED_TYPE_CODES: [&str; 6] = ["326", "380", "384", "875", "876", "877"];

pub const XML_MALFORMED: &str = "XML_MALFORMED";
pub const DTD_NOT_ALLOWED: &str = "DTD_NOT_ALLOWED";
pub const UNSUPPORTED_SYNTAX: &str = "UNSUPPORTED_SYNTAX";
pub const UNSUPPORTED_TYPE_CODE: &str = "UNSUPPORTED_TYPE_CODE";
pub const AMBIGUOUS_PAYMENT: &str = "AMBIGUOUS_PAYMENT";
pub const IBAN_NOT_SUPPORTED: &str = "IBAN_NOT_SUPPORTED";

const MAX_INVOICE_NUMBER_CHARS: usize = 200;

static VAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z]{2}[A-Z0-9]{2,14}$").expect("VAT regex"));
static COUNTRY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z]{2}$").expect("country regex"));
static CURRENCY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z]{3}$").expect("currency regex"));
static AMOUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+(\.[0-9]{1,2})?$").expect("amount regex"));

/// BT-34 electronic address with its `schemeID`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElectronicAddress {
    pub scheme: String,
    pub value: String,
}

/// Fields of the 3.1 table. Strings are trimmed raw values (not normalized);
/// `None` means missing, duplicated or failing its 3.1 check.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Invoice {
    /// BT-24
    pub profile: Option<String>,
    /// BT-1
    pub invoice_number: Option<String>,
    /// BT-3 (one of [`SUPPORTED_TYPE_CODES`])
    pub type_code: Option<String>,
    /// BT-2
    pub issue_date: Option<NaiveDate>,
    /// BT-22 without signature entries (I-5 texts).
    pub notes: Vec<String>,
    /// BT-22 entries starting with [`SIGNATURE_PREFIX`] (not verified in v1.0).
    pub signature_notes: Vec<String>,
    /// BT-13
    pub order_reference: Option<String>,
    /// BT-27
    pub seller_name: Option<String>,
    /// BT-31 (raw; matches the VAT pattern after `normalize::vat`)
    pub seller_vat_id: Option<String>,
    /// BT-35
    pub seller_street: Option<String>,
    /// BT-37
    pub seller_city: Option<String>,
    /// BT-38
    pub seller_postcode: Option<String>,
    /// BT-40
    pub seller_country: Option<String>,
    /// BT-42 (first contact)
    pub seller_phone: Option<String>,
    /// BT-43 (first contact)
    pub seller_email: Option<String>,
    /// BT-34
    pub seller_electronic_address: Option<ElectronicAddress>,
    /// BT-44
    pub buyer_name: Option<String>,
    /// BT-48
    pub buyer_vat_id: Option<String>,
    /// BT-53
    pub buyer_postcode: Option<String>,
    /// BT-5
    pub currency: Option<String>,
    /// BT-81
    pub payment_means_code: Option<String>,
    /// BT-82
    pub payment_info: Option<String>,
    /// BT-84 (raw trimmed; checked in 3.4)
    pub payment_address: Option<String>,
    /// BT-83
    pub payment_reference: Option<String>,
    /// BT-20 (all payment terms)
    pub payment_terms: Vec<String>,
    /// BT-9 (earliest)
    pub due_date: Option<NaiveDate>,
    /// BT-112
    pub grand_total: Option<Decimal>,
    /// BT-115
    pub due_payable: Option<Decimal>,
}

impl Invoice {
    /// `true` → `signature.status = "present_unverified"`, else `"absent"` (3.2).
    pub fn has_signature(&self) -> bool {
        !self.signature_notes.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseOutcome {
    /// Input with one leading `U+FEFF` removed (FR-11); otherwise unchanged.
    pub bom_stripped_xml: String,
    /// KO-1 codes from spec steps 2 and 3, in 3.1 table order, without duplicates.
    pub ko1_codes: Vec<String>,
    /// `None` for `XML_MALFORMED`, `DTD_NOT_ALLOWED` and `UNSUPPORTED_SYNTAX`.
    pub invoice: Option<Invoice>,
}

/// Spec 3.5 steps 2–3: BOM, parse, root check, fields of 3.1.
pub fn parse_invoice(xml: &str) -> ParseOutcome {
    let stripped = xml.strip_prefix('\u{FEFF}').unwrap_or(xml);
    let fail = |code: &str| ParseOutcome {
        bom_stripped_xml: stripped.to_string(),
        ko1_codes: vec![code.to_string()],
        invoice: None,
    };
    let options = ParsingOptions {
        allow_dtd: false,
        nodes_limit: NODES_LIMIT,
        ..ParsingOptions::default()
    };
    let doc = match Document::parse_with_options(stripped, options) {
        Ok(doc) => doc,
        Err(roxmltree::Error::DtdDetected) => return fail(DTD_NOT_ALLOWED),
        Err(_) => return fail(XML_MALFORMED),
    };
    let root = doc.root_element();
    if !is(&root, rsm("CrossIndustryInvoice")) {
        return fail(UNSUPPORTED_SYNTAX);
    }
    let mut codes = Codes::default();
    let invoice = read_fields(root, &mut codes);
    ParseOutcome {
        bom_stripped_xml: stripped.to_string(),
        ko1_codes: codes.0,
        invoice: Some(invoice),
    }
}

/// One child step: namespace + local name.
#[derive(Clone, Copy)]
struct Step {
    ns: &'static str,
    name: &'static str,
}

const fn rsm(name: &'static str) -> Step {
    Step { ns: NS_RSM, name }
}

const fn ram(name: &'static str) -> Step {
    Step { ns: NS_RAM, name }
}

const fn udt(name: &'static str) -> Step {
    Step { ns: NS_UDT, name }
}

fn is(node: &Node, step: Step) -> bool {
    node.is_element()
        && node.tag_name().name() == step.name
        && node.tag_name().namespace() == Some(step.ns)
}

/// All elements reached from `from` by the child steps, in document order.
fn select<'a, 'i>(from: &[Node<'a, 'i>], steps: &[Step]) -> Vec<Node<'a, 'i>> {
    let mut current = from.to_vec();
    for &step in steps {
        current = current
            .iter()
            .flat_map(|n| n.children().filter(move |c| is(c, step)))
            .collect();
    }
    current
}

/// Spec 3.1 whitespace: space, tab, CR, LF.
fn trim(s: &str) -> &str {
    s.trim_matches([' ', '\t', '\r', '\n'])
}

/// Elements with their trimmed text (direct text children joined); blank ones dropped.
fn present<'a, 'i>(nodes: &[Node<'a, 'i>]) -> Vec<(Node<'a, 'i>, String)> {
    nodes
        .iter()
        .filter_map(|n| {
            let text: String = n
                .children()
                .filter(|c| c.is_text())
                .filter_map(|c| c.text())
                .collect();
            let value = trim(&text);
            (!value.is_empty()).then(|| (*n, value.to_string()))
        })
        .collect()
}

fn values(nodes: &[Node]) -> Vec<String> {
    present(nodes).into_iter().map(|(_, v)| v).collect()
}

/// KO-1 codes in first-seen order, without duplicates.
#[derive(Default)]
struct Codes(Vec<String>);

impl Codes {
    fn push(&mut self, code: &str) {
        if !self.0.iter().any(|c| c == code) {
            self.0.push(code.to_string());
        }
    }

    fn missing(&mut self, bt: &str) {
        self.push(&format!("MISSING_FIELD:{bt}"));
    }

    fn invalid(&mut self, bt: &str) {
        self.push(&format!("INVALID_FIELD:{bt}"));
    }

    /// Single-valued field: 0 → `MISSING_FIELD` if required, > 1 → `INVALID_FIELD`.
    fn single_node<'a, 'i>(
        &mut self,
        bt: &str,
        required: bool,
        nodes: &[Node<'a, 'i>],
    ) -> Option<(Node<'a, 'i>, String)> {
        let mut found = present(nodes);
        match found.len() {
            0 => {
                if required {
                    self.missing(bt);
                }
                None
            }
            1 => found.pop(),
            _ => {
                self.invalid(bt);
                None
            }
        }
    }

    fn single(&mut self, bt: &str, required: bool, nodes: &[Node]) -> Option<String> {
        self.single_node(bt, required, nodes).map(|(_, v)| v)
    }

    /// Applies `check` to a present value; on failure records `code` and yields `None`.
    fn check<T>(
        &mut self,
        code: &str,
        value: Option<String>,
        check: impl FnOnce(&str) -> Option<T>,
    ) -> Option<T> {
        let value = value?;
        let checked = check(&value);
        if checked.is_none() {
            self.push(code);
        }
        checked
    }
}

fn matching(re: &Regex, v: &str) -> Option<String> {
    re.is_match(v).then(|| v.to_string())
}

/// `format="102"` and `YYYYMMDD` forming a valid calendar date.
fn date_102(node: &Node, value: &str) -> Option<NaiveDate> {
    if node.attribute("format") != Some("102") {
        return None;
    }
    if value.len() != 8 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year = value[0..4].parse().ok()?;
    let month = value[4..6].parse().ok()?;
    let day = value[6..8].parse().ok()?;
    NaiveDate::from_ymd_opt(year, month, day)
}

fn amount_value(v: &str) -> Option<Decimal> {
    if AMOUNT_RE.is_match(v) {
        Decimal::from_str(v).ok()
    } else {
        None
    }
}

/// Entries with the given `schemeID` (`None` = any `schemeID` attribute).
fn with_scheme<'a, 'i>(nodes: Vec<Node<'a, 'i>>, scheme: Option<&str>) -> Vec<Node<'a, 'i>> {
    nodes
        .into_iter()
        .filter(|n| match (n.attribute("schemeID"), scheme) {
            (Some(actual), Some(wanted)) => actual == wanted,
            (Some(_), None) => true,
            (None, _) => false,
        })
        .collect()
}

/// Reads and checks every 3.1 field in table order.
fn read_fields(root: Node, codes: &mut Codes) -> Invoice {
    let root = [root];
    let ctx = select(&root, &[rsm("ExchangedDocumentContext")]);
    let doc = select(&root, &[rsm("ExchangedDocument")]);
    let tx = select(&root, &[rsm("SupplyChainTradeTransaction")]);
    let agr = select(&tx, &[ram("ApplicableHeaderTradeAgreement")]);
    let sel = select(&agr, &[ram("SellerTradeParty")]);
    let buy = select(&agr, &[ram("BuyerTradeParty")]);
    let stl = select(&tx, &[ram("ApplicableHeaderTradeSettlement")]);
    let pm = select(&stl, &[ram("SpecifiedTradeSettlementPaymentMeans")]);
    let sel_addr = select(&sel, &[ram("PostalTradeAddress")]);
    let first_contact: Vec<Node> = select(&sel, &[ram("DefinedTradeContact")])
        .into_iter()
        .take(1)
        .collect();
    let terms = select(&stl, &[ram("SpecifiedTradePaymentTerms")]);
    let sums = select(
        &stl,
        &[ram("SpecifiedTradeSettlementHeaderMonetarySummation")],
    );

    // BT-24
    let profile = codes.single(
        "BT-24",
        true,
        &select(
            &ctx,
            &[ram("GuidelineSpecifiedDocumentContextParameter"), ram("ID")],
        ),
    );
    // BT-1
    let number = codes.single("BT-1", true, &select(&doc, &[ram("ID")]));
    let invoice_number = codes.check("INVALID_FIELD:BT-1", number, |v| {
        (v.chars().count() <= MAX_INVOICE_NUMBER_CHARS).then(|| v.to_string())
    });
    // BT-3
    let type_code = codes.single("BT-3", true, &select(&doc, &[ram("TypeCode")]));
    let type_code = codes.check(UNSUPPORTED_TYPE_CODE, type_code, |v| {
        SUPPORTED_TYPE_CODES.contains(&v).then(|| v.to_string())
    });
    // BT-2
    let issue = codes.single_node(
        "BT-2",
        true,
        &select(&doc, &[ram("IssueDateTime"), udt("DateTimeString")]),
    );
    let issue_date = issue.and_then(|(node, v)| {
        let date = date_102(&node, &v);
        if date.is_none() {
            codes.invalid("BT-2");
        }
        date
    });
    // BT-22
    let (signatures, notes): (Vec<String>, Vec<String>) =
        values(&select(&doc, &[ram("IncludedNote"), ram("Content")]))
            .into_iter()
            .partition(|v| v.starts_with(SIGNATURE_PREFIX));
    // BT-13
    let order_reference = codes.single(
        "BT-13",
        false,
        &select(
            &agr,
            &[ram("BuyerOrderReferencedDocument"), ram("IssuerAssignedID")],
        ),
    );
    // BT-27
    let seller_name = codes.single("BT-27", true, &select(&sel, &[ram("Name")]));
    // BT-31
    let seller_vat = codes.single(
        "BT-31",
        true,
        &with_scheme(
            select(&sel, &[ram("SpecifiedTaxRegistration"), ram("ID")]),
            Some("VA"),
        ),
    );
    let seller_vat_id = codes.check("INVALID_FIELD:BT-31", seller_vat, |v| {
        VAT_RE.is_match(&normalize::vat(v)).then(|| v.to_string())
    });
    // BT-35, BT-37, BT-38
    let seller_street = codes.single("BT-35", false, &select(&sel_addr, &[ram("LineOne")]));
    let seller_city = codes.single("BT-37", false, &select(&sel_addr, &[ram("CityName")]));
    let seller_postcode = codes.single("BT-38", false, &select(&sel_addr, &[ram("PostcodeCode")]));
    // BT-40
    let country = codes.single("BT-40", true, &select(&sel_addr, &[ram("CountryID")]));
    let seller_country = codes.check("INVALID_FIELD:BT-40", country, |v| matching(&COUNTRY_RE, v));
    // BT-42, BT-43 (first contact only)
    let seller_phone = codes.single(
        "BT-42",
        false,
        &select(
            &first_contact,
            &[
                ram("TelephoneUniversalCommunication"),
                ram("CompleteNumber"),
            ],
        ),
    );
    let seller_email = codes.single(
        "BT-43",
        false,
        &select(
            &first_contact,
            &[ram("EmailURIUniversalCommunication"), ram("URIID")],
        ),
    );
    // BT-34
    let seller_electronic_address = codes
        .single_node(
            "BT-34",
            false,
            &with_scheme(
                select(&sel, &[ram("URIUniversalCommunication"), ram("URIID")]),
                None,
            ),
        )
        .map(|(node, value)| ElectronicAddress {
            scheme: trim(node.attribute("schemeID").unwrap_or_default()).to_string(),
            value,
        });
    // BT-44
    let buyer_name = codes.single("BT-44", true, &select(&buy, &[ram("Name")]));
    // BT-48
    let buyer_vat_id = codes.single(
        "BT-48",
        false,
        &with_scheme(
            select(&buy, &[ram("SpecifiedTaxRegistration"), ram("ID")]),
            Some("VA"),
        ),
    );
    // BT-53
    let buyer_postcode = codes.single(
        "BT-53",
        false,
        &select(&buy, &[ram("PostalTradeAddress"), ram("PostcodeCode")]),
    );
    // BT-5
    let currency = codes.single("BT-5", true, &select(&stl, &[ram("InvoiceCurrencyCode")]));
    let currency = codes.check("INVALID_FIELD:BT-5", currency, |v| {
        matching(&CURRENCY_RE, v)
    });
    // BG-16 .. BT-84: only read inside exactly one payment-means element.
    let payment = match pm.len() {
        0 => {
            codes.missing("BT-81");
            Payment::default()
        }
        1 => read_payment_means(&pm, codes),
        _ => {
            codes.push(AMBIGUOUS_PAYMENT);
            Payment::default()
        }
    };
    // BT-83
    let payment_reference = codes.single("BT-83", false, &select(&stl, &[ram("PaymentReference")]));
    // BT-20
    let payment_terms = values(&select(&terms, &[ram("Description")]));
    // BT-9 (earliest; every entry must be valid)
    let due: Option<Vec<NaiveDate>> = present(&select(
        &terms,
        &[ram("DueDateDateTime"), udt("DateTimeString")],
    ))
    .iter()
    .map(|(node, v)| date_102(node, v))
    .collect();
    let due_date = match due {
        Some(dates) => dates.into_iter().min(),
        None => {
            codes.invalid("BT-9");
            None
        }
    };
    // BT-112
    let gross = codes.single("BT-112", true, &select(&sums, &[ram("GrandTotalAmount")]));
    let grand_total = codes.check("INVALID_FIELD:BT-112", gross, |v| {
        amount_value(v).filter(|d| *d > Decimal::ZERO)
    });
    // BT-115
    let due_payable = codes.single("BT-115", true, &select(&sums, &[ram("DuePayableAmount")]));
    let due_payable = codes.check("INVALID_FIELD:BT-115", due_payable, amount_value);

    Invoice {
        profile,
        invoice_number,
        type_code,
        issue_date,
        notes,
        signature_notes: signatures,
        order_reference,
        seller_name,
        seller_vat_id,
        seller_street,
        seller_city,
        seller_postcode,
        seller_country,
        seller_phone,
        seller_email,
        seller_electronic_address,
        buyer_name,
        buyer_vat_id,
        buyer_postcode,
        currency,
        payment_means_code: payment.means_code,
        payment_info: payment.info,
        payment_address: payment.address,
        payment_reference,
        payment_terms,
        due_date,
        grand_total,
        due_payable,
    }
}

/// BT-81, BT-82 and BT-84 of the single `PM` element.
#[derive(Default)]
struct Payment {
    means_code: Option<String>,
    info: Option<String>,
    address: Option<String>,
}

/// BT-81, BT-82, BG-17 and BT-84 inside the single `PM` element.
fn read_payment_means(pm: &[Node], codes: &mut Codes) -> Payment {
    // BT-81, BT-82
    let means_code = codes.single("BT-81", true, &select(pm, &[ram("TypeCode")]));
    let info = codes.single("BT-82", false, &select(pm, &[ram("Information")]));
    // BG-17
    let accounts = select(pm, &[ram("PayeePartyCreditorFinancialAccount")]);
    match accounts.len() {
        0 => codes.missing("BT-84"),
        1 => {}
        _ => codes.push(AMBIGUOUS_PAYMENT),
    }
    if !select(&accounts, &[ram("IBANID")]).is_empty() {
        codes.push(IBAN_NOT_SUPPORTED);
    }
    if !select(pm, &[ram("ApplicableTradeSettlementFinancialCard")]).is_empty()
        || !select(pm, &[ram("PayerPartyDebtorFinancialAccount")]).is_empty()
    {
        codes.push(AMBIGUOUS_PAYMENT);
    }
    // BT-84
    let address = if accounts.len() == 1 {
        codes.single("BT-84", true, &select(&accounts, &[ram("ProprietaryID")]))
    } else {
        None
    };
    Payment {
        means_code,
        info,
        address,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const F1: &str = include_str!("../tests/fixtures/f1.xml");
    const F9: &str = include_str!("../tests/fixtures/f9.xml");
    const F10: &str = include_str!("../tests/fixtures/f10.xml");
    const F11: &str = include_str!("../tests/fixtures/f11.xml");

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
    const W3: &str = "addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9";

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn date(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(y, m, d)
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    /// Replaces the first occurrence; panics if `from` is absent so a stale
    /// mutation never silently tests the unmodified fixture.
    fn with(xml: &str, from: &str, to: &str) -> String {
        assert!(xml.contains(from), "fixture lacks {from:?}");
        xml.replacen(from, to, 1)
    }

    /// The first element spanning `open` .. `close` (inclusive).
    fn element<'x>(xml: &'x str, open: &str, close: &str) -> &'x str {
        let start = xml.find(open).expect("open tag");
        let end = start + xml[start..].find(close).expect("close tag") + close.len();
        &xml[start..end]
    }

    fn codes(xml: &str) -> Vec<String> {
        parse_invoice(xml).ko1_codes
    }

    fn valid(xml: &str) -> Invoice {
        let out = parse_invoice(xml);
        assert_eq!(out.ko1_codes, Vec::<String>::new());
        out.invoice.expect("invoice")
    }

    #[test]
    fn f1_parses_with_expected_values() {
        let inv = valid(F1);
        assert_eq!(
            inv.profile,
            s("urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0")
        );
        assert_eq!(inv.invoice_number, s("RE-2026-0412"));
        assert_eq!(inv.type_code, s("380"));
        assert_eq!(inv.issue_date, date(2026, 10, 28));
        assert_eq!(inv.notes, ["Vielen Dank für Ihren Auftrag."]);
        assert!(inv.signature_notes.is_empty());
        assert!(!inv.has_signature());
        assert_eq!(inv.order_reference, s("PO-2026-001"));
        assert_eq!(inv.seller_name, s("Alpha Consulting GmbH"));
        assert_eq!(inv.seller_vat_id, s("DE111111111"));
        assert_eq!(inv.seller_street, s("Musterstraße 1"));
        assert_eq!(inv.seller_city, s("München"));
        assert_eq!(inv.seller_postcode, s("80333"));
        assert_eq!(inv.seller_country, s("DE"));
        assert_eq!(inv.seller_phone, s("+49 89 1234567"));
        assert_eq!(inv.seller_email, s("rechnung@alpha-consulting.example"));
        assert_eq!(
            inv.seller_electronic_address,
            Some(ElectronicAddress {
                scheme: "EM".into(),
                value: "rechnung@alpha-consulting.example".into()
            })
        );
        assert_eq!(inv.buyer_name, s("Käufer Handels AG"));
        assert_eq!(inv.buyer_vat_id, s("DE999999999"));
        assert_eq!(inv.buyer_postcode, s("10115"));
        assert_eq!(inv.currency, s("EUR"));
        assert_eq!(inv.payment_means_code, s("ZZZ"));
        assert_eq!(inv.payment_info, s("cardano:preprod:ADA"));
        assert_eq!(inv.payment_address, s(W1));
        assert_eq!(inv.payment_reference, s("RE-2026-0412"));
        assert_eq!(
            inv.payment_terms,
            ["Zahlbar innerhalb von 30 Tagen ohne Abzug."]
        );
        assert_eq!(inv.due_date, date(2026, 11, 27));
        assert_eq!(inv.grand_total, Some(dec("1190.00")));
        assert_eq!(inv.due_payable, Some(dec("1190.00")));
        assert_eq!(
            inv.grand_total.as_ref().map(crate::normalize::amount),
            s("1190.00")
        );
    }

    #[test]
    fn f1_bom_stripped_xml_is_unchanged_input() {
        assert_eq!(parse_invoice(F1).bom_stripped_xml, F1);
    }

    #[test]
    fn f9_values() {
        let inv = valid(F9);
        assert_eq!(inv.seller_name, s("Alpha Consulting GmbH"));
        assert_eq!(inv.payment_address, s(W2));
        assert_eq!(inv.grand_total, Some(dec("833.00")));
        assert_eq!(inv.due_payable, Some(dec("833.00")));
        assert_eq!(inv.due_date, date(2026, 10, 30));
        assert_eq!(inv.notes, ["Bitte dringend überweisen, neue Wallet."]);
        assert_eq!(inv.order_reference, s("PO-2026-001"));
    }

    #[test]
    fn f10_values() {
        let inv = valid(F10);
        assert_eq!(inv.seller_name, s("Beta Services GmbH"));
        assert_eq!(inv.seller_vat_id, s("DE222222222"));
        assert_eq!(inv.seller_email, s("info@beta-services.example"));
        assert_eq!(
            inv.seller_electronic_address,
            Some(ElectronicAddress {
                scheme: "EM".into(),
                value: "info@beta-services.example".into()
            })
        );
        assert_eq!(inv.seller_phone, s("+49 30 7654321"));
        assert_eq!(inv.seller_street, s("Hauptstraße 5"));
        assert_eq!(inv.seller_postcode, s("10117"));
        assert_eq!(inv.seller_city, s("Berlin"));
        assert_eq!(inv.payment_address, s(W1));
        assert_eq!(inv.order_reference, None);
        assert_eq!(inv.grand_total, Some(dec("1785.00")));
        assert_eq!(inv.due_payable, Some(dec("1785.00")));
        assert_eq!(inv.due_date, date(2026, 10, 30));
        assert_eq!(inv.notes, ["Bitte dringend zahlen."]);
    }

    #[test]
    fn f11_values() {
        let inv = valid(F11);
        assert_eq!(inv.seller_name, s("Gamma Handel GmbH"));
        assert_eq!(inv.seller_vat_id, s("DE333333333"));
        assert_eq!(inv.seller_email, s("gamma.handel@gmail.com"));
        assert_eq!(
            inv.seller_electronic_address,
            Some(ElectronicAddress {
                scheme: "EM".into(),
                value: "gamma.handel@gmail.com".into()
            })
        );
        assert_eq!(inv.seller_phone, s("+49 40 1111111"));
        assert_eq!(inv.seller_street, s("Hafenweg 3"));
        assert_eq!(inv.seller_postcode, s("20095"));
        assert_eq!(inv.seller_city, s("Hamburg"));
        assert_eq!(inv.payment_address, s(W3));
        assert_eq!(inv.order_reference, None);
        assert_eq!(inv.grand_total, Some(dec("2000.00")));
        assert_eq!(inv.due_payable, Some(dec("2000.00")));
        assert_eq!(inv.due_date, date(2026, 11, 27));
    }

    /// Spec test 2.
    #[test]
    fn test2_truncated_xml_is_malformed() {
        let out = parse_invoice("<x");
        assert_eq!(out.ko1_codes, ["XML_MALFORMED"]);
        assert_eq!(out.invoice, None);
    }

    /// Spec test 3.
    #[test]
    fn test3_missing_creditor_account() {
        let account = element(
            F1,
            "<ram:PayeePartyCreditorFinancialAccount>",
            "</ram:PayeePartyCreditorFinancialAccount>",
        );
        let out = parse_invoice(&with(F1, account, ""));
        assert_eq!(out.ko1_codes, ["MISSING_FIELD:BT-84"]);
        assert_eq!(out.invoice.expect("invoice").payment_address, None);
    }

    /// Spec test 29.
    #[test]
    fn test29_unsupported_type_code() {
        let xml = with(
            F1,
            "<ram:TypeCode>380</ram:TypeCode>",
            "<ram:TypeCode>381</ram:TypeCode>",
        );
        assert_eq!(codes(&xml), ["UNSUPPORTED_TYPE_CODE"]);
    }

    /// Spec test 30.
    #[test]
    fn test30_second_payment_means_is_ambiguous() {
        let pm = element(
            F1,
            "<ram:SpecifiedTradeSettlementPaymentMeans>",
            "</ram:SpecifiedTradeSettlementPaymentMeans>",
        );
        let xml = with(F1, pm, &format!("{pm}{pm}"));
        assert_eq!(codes(&xml), ["AMBIGUOUS_PAYMENT"]);
    }

    /// Spec test 31.
    #[test]
    fn test31_doctype_is_rejected() {
        let xml = with(
            F1,
            "?>",
            "?>\n<!DOCTYPE rsm:CrossIndustryInvoice [<!ENTITY x \"y\">]>",
        );
        let out = parse_invoice(&xml);
        assert_eq!(out.ko1_codes, ["DTD_NOT_ALLOWED"]);
        assert_eq!(out.invoice, None);
    }

    #[test]
    fn wrong_root_is_unsupported_syntax() {
        let out = parse_invoice(
            "<Invoice xmlns=\"urn:oasis:names:specification:ubl:schema:xsd:Invoice-2\"/>",
        );
        assert_eq!(out.ko1_codes, ["UNSUPPORTED_SYNTAX"]);
        assert_eq!(out.invoice, None);
        let wrong_ns = parse_invoice("<CrossIndustryInvoice xmlns=\"urn:example\"/>");
        assert_eq!(wrong_ns.ko1_codes, ["UNSUPPORTED_SYNTAX"]);
    }

    #[test]
    fn leading_bom_is_stripped() {
        let out = parse_invoice(&format!("\u{FEFF}{F1}"));
        assert_eq!(out.ko1_codes, Vec::<String>::new());
        assert_eq!(out.bom_stripped_xml, F1);
        assert_eq!(
            out.invoice.expect("invoice").seller_vat_id,
            s("DE111111111")
        );
    }

    #[test]
    fn iban_is_not_supported() {
        let xml = with(
            F1,
            "<ram:PayeePartyCreditorFinancialAccount>",
            "<ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02120300000000202051</ram:IBANID>",
        );
        assert_eq!(codes(&xml), ["IBAN_NOT_SUPPORTED"]);
    }

    #[test]
    fn financial_card_or_debtor_account_is_ambiguous() {
        for extra in [
            "<ram:ApplicableTradeSettlementFinancialCard><ram:ID>1234</ram:ID></ram:ApplicableTradeSettlementFinancialCard>",
            "<ram:PayerPartyDebtorFinancialAccount><ram:IBANID>DE02120300000000202051</ram:IBANID></ram:PayerPartyDebtorFinancialAccount>",
        ] {
            let xml = with(
                F1,
                "</ram:SpecifiedTradeSettlementPaymentMeans>",
                &format!("{extra}</ram:SpecifiedTradeSettlementPaymentMeans>"),
            );
            assert_eq!(codes(&xml), ["AMBIGUOUS_PAYMENT"], "{extra}");
        }
    }

    #[test]
    fn duplicate_invoice_number_is_invalid() {
        let xml = with(
            F1,
            "<ram:ID>RE-2026-0412</ram:ID>",
            "<ram:ID>RE-2026-0412</ram:ID><ram:ID>RE-2026-0413</ram:ID>",
        );
        let out = parse_invoice(&xml);
        assert_eq!(out.ko1_codes, ["INVALID_FIELD:BT-1"]);
        assert_eq!(out.invoice.expect("invoice").invoice_number, None);
    }

    #[test]
    fn invalid_calendar_date_is_invalid() {
        let xml = with(F1, ">20261028<", ">20261332<");
        let out = parse_invoice(&xml);
        assert_eq!(out.ko1_codes, ["INVALID_FIELD:BT-2"]);
        assert_eq!(out.invoice.expect("invoice").issue_date, None);
    }

    #[test]
    fn date_needs_format_102() {
        let xml = with(
            F1,
            "<udt:DateTimeString format=\"102\">20261028<",
            "<udt:DateTimeString format=\"203\">20261028<",
        );
        assert_eq!(codes(&xml), ["INVALID_FIELD:BT-2"]);
    }

    #[test]
    fn earliest_due_date_wins() {
        let terms = "<ram:SpecifiedTradePaymentTerms>";
        let xml = with(
            F1,
            terms,
            "<ram:SpecifiedTradePaymentTerms><ram:Description>Skonto</ram:Description><ram:DueDateDateTime><udt:DateTimeString format=\"102\">20261110</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms><ram:SpecifiedTradePaymentTerms>",
        );
        let inv = valid(&xml);
        assert_eq!(inv.due_date, date(2026, 11, 10));
        assert_eq!(
            inv.payment_terms,
            ["Skonto", "Zahlbar innerhalb von 30 Tagen ohne Abzug."]
        );
    }

    #[test]
    fn whitespace_only_value_is_missing_and_values_are_trimmed() {
        let xml = with(
            F1,
            "<ram:Name>Alpha Consulting GmbH</ram:Name>",
            "<ram:Name> \t\r\n </ram:Name>",
        );
        assert_eq!(codes(&xml), ["MISSING_FIELD:BT-27"]);
        let xml = with(
            F1,
            "<ram:ID>RE-2026-0412</ram:ID>",
            "<ram:ID>\t RE-2026-0412 \n</ram:ID>",
        );
        assert_eq!(valid(&xml).invoice_number, s("RE-2026-0412"));
    }

    #[test]
    fn seller_vat_needs_exactly_one_valid_va_entry() {
        let va = "<ram:ID schemeID=\"VA\">DE111111111</ram:ID>";
        assert_eq!(
            codes(&with(
                F1,
                va,
                "<ram:ID schemeID=\"FC\">123/456/789</ram:ID>"
            )),
            ["MISSING_FIELD:BT-31"]
        );
        assert_eq!(
            codes(&with(
                F1,
                va,
                &format!("{va}<ram:ID schemeID=\"VA\">DE222222222</ram:ID>")
            )),
            ["INVALID_FIELD:BT-31"]
        );
        assert_eq!(
            codes(&with(F1, va, "<ram:ID schemeID=\"VA\">D</ram:ID>")),
            ["INVALID_FIELD:BT-31"]
        );
        let spaced = with(F1, va, "<ram:ID schemeID=\"VA\">de 111 111 111</ram:ID>");
        assert_eq!(valid(&spaced).seller_vat_id, s("de 111 111 111"));
    }

    #[test]
    fn country_and_currency_are_case_sensitive() {
        assert_eq!(
            codes(&with(
                F1,
                "<ram:CountryID>DE</ram:CountryID>",
                "<ram:CountryID>de</ram:CountryID>"
            )),
            ["INVALID_FIELD:BT-40"]
        );
        assert_eq!(
            codes(&with(
                F1,
                ">EUR</ram:InvoiceCurrencyCode>",
                ">eur</ram:InvoiceCurrencyCode>"
            )),
            ["INVALID_FIELD:BT-5"]
        );
    }

    #[test]
    fn amounts_are_checked() {
        let gross = "<ram:GrandTotalAmount>1190.00</ram:GrandTotalAmount>";
        for bad in ["0.00", "1190.001", "1,190.00", "-1"] {
            let xml = with(
                F1,
                gross,
                &format!("<ram:GrandTotalAmount>{bad}</ram:GrandTotalAmount>"),
            );
            assert_eq!(codes(&xml), ["INVALID_FIELD:BT-112"], "{bad}");
        }
        let due = "<ram:DuePayableAmount>1190.00</ram:DuePayableAmount>";
        let zero_due = with(F1, due, "<ram:DuePayableAmount>0</ram:DuePayableAmount>");
        assert_eq!(valid(&zero_due).due_payable, Some(Decimal::ZERO));
        let bad_due = with(
            F1,
            due,
            "<ram:DuePayableAmount>1.5.0</ram:DuePayableAmount>",
        );
        assert_eq!(codes(&bad_due), ["INVALID_FIELD:BT-115"]);
    }

    #[test]
    fn invoice_number_longer_than_200_chars_is_invalid() {
        let long = "Ä".repeat(201);
        let xml = with(
            F1,
            "<ram:ID>RE-2026-0412</ram:ID>",
            &format!("<ram:ID>{long}</ram:ID>"),
        );
        assert_eq!(codes(&xml), ["INVALID_FIELD:BT-1"]);
        let ok = "Ä".repeat(200);
        let xml = with(
            F1,
            "<ram:ID>RE-2026-0412</ram:ID>",
            &format!("<ram:ID>{ok}</ram:ID>"),
        );
        assert_eq!(valid(&xml).invoice_number, Some(ok));
    }

    #[test]
    fn contact_fields_come_from_first_contact() {
        let xml = with(
            F1,
            "<ram:DefinedTradeContact>",
            "<ram:DefinedTradeContact><ram:PersonName>First</ram:PersonName></ram:DefinedTradeContact><ram:DefinedTradeContact>",
        );
        let inv = valid(&xml);
        assert_eq!(inv.seller_phone, None);
        assert_eq!(inv.seller_email, None);
    }

    #[test]
    fn missing_payment_means() {
        let pm = element(
            F1,
            "<ram:SpecifiedTradeSettlementPaymentMeans>",
            "</ram:SpecifiedTradeSettlementPaymentMeans>",
        );
        assert_eq!(codes(&with(F1, pm, "")), ["MISSING_FIELD:BT-81"]);
    }

    #[test]
    fn all_codes_collected_in_table_order() {
        // Mutations placed so that document order differs from table order.
        let mut xml = with(
            F1,
            "<ram:GrandTotalAmount>1190.00<",
            "<ram:GrandTotalAmount>0<",
        );
        xml = with(
            &xml,
            ">EUR</ram:InvoiceCurrencyCode>",
            ">E</ram:InvoiceCurrencyCode>",
        );
        xml = with(
            &xml,
            "<ram:CountryID>DE</ram:CountryID>",
            "<ram:CountryID>de</ram:CountryID>",
        );
        xml = with(&xml, "<ram:Name>Käufer Handels AG</ram:Name>", "");
        xml = with(
            &xml,
            "<ram:TypeCode>380</ram:TypeCode>",
            "<ram:TypeCode>381</ram:TypeCode>",
        );
        xml = with(
            &xml,
            "<ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>",
            "<ram:ID> </ram:ID>",
        );
        let out = parse_invoice(&xml);
        assert_eq!(
            out.ko1_codes,
            [
                "MISSING_FIELD:BT-24",
                "UNSUPPORTED_TYPE_CODE",
                "INVALID_FIELD:BT-40",
                "MISSING_FIELD:BT-44",
                "INVALID_FIELD:BT-5",
                "INVALID_FIELD:BT-112",
            ]
        );
        let inv = out.invoice.expect("invoice");
        assert_eq!(inv.type_code, None);
        assert_eq!(inv.seller_country, None);
        assert_eq!(inv.currency, None);
        assert_eq!(inv.grand_total, None);
        assert_eq!(inv.seller_vat_id, s("DE111111111"));
    }

    /// Spec 3.2 / test 14: signature notes are flagged and excluded from I-5 texts.
    #[test]
    fn cardano_sig_note_is_flagged_and_excluded() {
        let xml = with(
            F1,
            "</ram:IncludedNote>",
            "</ram:IncludedNote><ram:IncludedNote><ram:Content> \tcardano-sig-v1:abcd;ef01\n</ram:Content></ram:IncludedNote>",
        );
        let inv = valid(&xml);
        assert!(inv.has_signature());
        assert_eq!(inv.signature_notes, ["cardano-sig-v1:abcd;ef01"]);
        assert_eq!(inv.notes, ["Vielen Dank für Ihren Auftrag."]);
    }
}
