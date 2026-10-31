//! Registry checks and context-level mirrors of the 8.3 acceptance tests: real
//! fixtures parsed with `parse_invoice`, the 7.5 seed history held in memory, and
//! the 8.1 standard stubs. Scoring (reducer blocking, cap, band) is not applied here;
//! the tests assert which criteria and reducers fire and with which points.

use std::collections::HashMap;
use std::path::Path;

use super::testutil::*;
use super::*;
use crate::address;
use crate::config::{Criteria, Kind};
use crate::parse::parse_invoice;
use crate::store::postgres::{trust_value, BlockSource, SubjectType};

const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
const W3: &str = "addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9";
const W4: &str = "addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww";
const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";
const M: &str = "addr_test1qqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxva24242424242424242424242424242424242424242424qdm5upe";

/// 7.5 seed invoices of supplier A (all approved, EUR).
const SEED_AMOUNTS: [&str; 6] = [
    "1190.00", "1250.00", "980.00", "1100.00", "1300.00", "1050.00",
];

#[test]
fn registry_order_matches_catalog() {
    let ids = registry_ids();
    let config_ids: Vec<&str> = CRITERIA.criteria.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, config_ids);
    assert_eq!(ids.len(), 30);
}

#[test]
fn registry_validates_against_shipped_config() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/criteria.json");
    let (criteria, _) = Criteria::load_file(&path).unwrap();
    criteria.validate(&registry_ids()).unwrap();
}

#[test]
fn empty_context_fires_nothing() {
    let c = ctx();
    for crit in registry() {
        assert_eq!(eval(crit.as_ref(), &c), None, "{}", crit.id());
    }
}

// --- in-memory seed (7.5) ------------------------------------------------------

fn key() -> HmacKey {
    HmacKey::from_hex(KEY).unwrap()
}

fn wallet_hash_of(addr: &str) -> String {
    let a = address::check_without_network(addr).unwrap();
    Hashes::compute(&key(), &DATA.legal_forms, None, Some(&a))
        .wallet
        .unwrap()
}

struct Seed {
    subjects: HashMap<String, Subject>,
    supplier_a: String,
    last_approved_a: LastApproved,
    sanction_names: Vec<String>,
}

fn seed() -> Seed {
    let k = key();
    let lf = &DATA.legal_forms;
    let supplier_a = hashing::supplier_hash(&k, "DE111111111");
    let w1 = wallet_hash_of(W1);
    let pair = hashing::pair_hash(&k, &supplier_a, &w1);
    let trust = trust_value(6, 0);
    assert_eq!(fmt_trust(trust), "0.545");
    let approved = |ty| Subject {
        trust,
        ..subject(ty, 6, "0")
    };
    let mut subjects = HashMap::from([
        (supplier_a.clone(), approved(SubjectType::Supplier)),
        (w1, approved(SubjectType::Wallet)),
        (pair, approved(SubjectType::Pair)),
    ]);
    subjects.insert(
        wallet_hash_of(W4),
        blocked(SubjectType::Wallet, BlockSource::Internal, "TEST_INTERNAL"),
    );
    subjects.insert(
        wallet_hash_of(W5),
        blocked(SubjectType::Wallet, BlockSource::Ofac, "TEST_OFAC"),
    );
    // Seller fields of the seed invoices (identical to F1).
    let last_approved_a = LastApproved {
        name_hash: Some(hashing::name_hash(
            &k,
            &normalize::name("Alpha Consulting GmbH", lf),
        )),
        email_domain_hash: Some(hashing::email_domain_hash(&k, "alpha-consulting.example")),
        phone_hash: Some(hashing::phone_hash(&k, "+49891234567")),
        postal_hash: Some(hashing::postal_hash(
            &k,
            &normalize::postal(
                Some("Musterstraße 1"),
                Some("80333"),
                Some("München"),
                Some("DE"),
            )
            .unwrap(),
        )),
    };
    Seed {
        subjects,
        supplier_a,
        last_approved_a,
        sanction_names: vec![normalize::name("Delta Trading LLC", lf)],
    }
}

/// 8.1 Blockfrost stubs.
fn blockfrost_stub(addr: &str) -> SourceResult<Option<i64>> {
    SourceResult::Ok(match addr {
        W1 => Some(1_768_035_600),
        W2 => Some(1_793_102_400),
        _ => None,
    })
}

/// 8.1 VIES stubs (3.7.3 applicability: EU prefix only).
fn vies_stub(vat: &str) -> SourceResult<bool> {
    match vat {
        "DE111111111" | "DE222222222" | "DE333333333" | "DE555555555" => SourceResult::Ok(true),
        "DE444444444" => SourceResult::Ok(false),
        v if v.starts_with("DE") => SourceResult::Unavailable,
        _ => SourceResult::NotApplicable,
    }
}

fn parse(xml: &str) -> Invoice {
    let out = parse_invoice(xml);
    assert!(out.ko1_codes.is_empty(), "{:?}", out.ko1_codes);
    out.invoice.unwrap()
}

/// Builds the context as the pipeline would (3.5 steps 5-9) from the in-memory seed.
fn scenario<'a>(inv: &'a Invoice, seed: &Seed) -> CheckContext<'a> {
    let k = key();
    let mut c = ctx().with_invoice(inv);
    c.address = inv
        .payment_address
        .as_deref()
        .map(|a| address::check(a, Network::Preprod));
    let addr = c.address.as_ref().and_then(|r| r.as_ref().ok());
    c.hashes = Hashes::compute(&k, &DATA.legal_forms, Some(inv), addr);
    let lookup = |h: &Option<String>| h.as_ref().and_then(|h| seed.subjects.get(h)).cloned();
    c.wallet = lookup(&c.hashes.wallet);
    c.supplier = lookup(&c.hashes.supplier);
    c.pair = lookup(&c.hashes.pair);
    c.sanction_name_hit = inv
        .seller_name
        .as_deref()
        .map(|n| normalize::name(n, &DATA.legal_forms))
        .is_some_and(|n| seed.sanction_names.contains(&n));
    if c.hashes.supplier.as_deref() == Some(seed.supplier_a.as_str()) {
        c.last_approved = Some(seed.last_approved_a.clone());
        c.previous_invoice_count = 6;
        c.approved_eur_amounts = SEED_AMOUNTS.map(d).to_vec();
    }
    if let Some(a) = addr {
        c.blockfrost = blockfrost_stub(&a.address);
        c.chainabuse = SourceResult::Ok(ChainabuseValue {
            reports: 0,
            trusted_or_checked: 0,
        });
    }
    if let Some(vat) = inv.seller_vat_id.as_deref() {
        c.vies = vies_stub(&normalize::vat(vat));
    }
    c
}

/// Fired entries `(id, points)` of one kind, in catalog order.
fn fired_of(c: &CheckContext, kinds: &[Kind]) -> Vec<(&'static str, i32)> {
    registry()
        .iter()
        .filter(|crit| kinds.contains(&cfg(crit.id()).kind))
        .filter_map(|crit| eval(crit.as_ref(), c).map(|f| (crit.id(), f.points)))
        .collect()
}

fn criteria_fired(c: &CheckContext) -> Vec<(&'static str, i32)> {
    fired_of(c, &[Kind::Ko, Kind::Score])
}

fn reducers_fired(c: &CheckContext) -> Vec<(&'static str, i32)> {
    fired_of(c, &[Kind::Reducer])
}

fn evidence(c: &CheckContext, id: &str) -> String {
    let crit = registry().into_iter().find(|x| x.id() == id).unwrap();
    eval(crit.as_ref(), c).unwrap().evidence
}

fn f1_with(replacements: &[(&str, &str)]) -> String {
    let mut xml = fixture("f1.xml");
    for (from, to) in replacements {
        assert!(xml.contains(from), "{from}");
        xml = xml.replace(from, to);
    }
    xml
}

fn sum(v: &[(&str, i32)]) -> i32 {
    v.iter().map(|(_, p)| p).sum()
}

// --- 8.3 mirrors ---------------------------------------------------------------

/// Test 1: F1 → no criteria; T-1, T-2, T-3, T-4 fire (cap applied in scoring).
#[test]
fn spec_test_1_f1() {
    let s = seed();
    let inv = f1();
    let c = scenario(&inv, &s);
    assert_eq!(criteria_fired(&c), []);
    assert_eq!(
        reducers_fired(&c),
        [("T-1", -15), ("T-2", -10), ("T-3", -10), ("T-4", -5)]
    );
    assert_eq!(evidence(&c, "T-1"), "wallet trust 0.545");
    assert_eq!(evidence(&c, "T-2"), "pair approved 6x");
}

/// Test 7: corrected invoice → only I-12 (0 points).
#[test]
fn spec_test_7_corrected_invoice() {
    let s = seed();
    let inv = parse(&f1_with(&[
        (
            "<ram:TypeCode>380</ram:TypeCode>",
            "<ram:TypeCode>384</ram:TypeCode>",
        ),
        (
            "<ram:ID>RE-2026-0412</ram:ID>",
            "<ram:ID>RE-2026-0412-K</ram:ID>",
        ),
    ]));
    let c = scenario(&inv, &s);
    assert_eq!(criteria_fired(&c), [("I-12", 0)]);
    assert_eq!(reducers_fired(&c).len(), 4);
}

/// Test 8: W4 → KO-6 `wallet blocked (TEST_INTERNAL)`.
#[test]
fn spec_test_8_internal_block() {
    let s = seed();
    let inv = parse(&f1_with(&[(W1, W4)]));
    let c = scenario(&inv, &s);
    let ko: Vec<_> = fired_of(&c, &[Kind::Ko]);
    assert_eq!(ko, [("KO-6", 100)]);
    assert_eq!(evidence(&c, "KO-6"), "wallet blocked (TEST_INTERNAL)");
}

/// Test 9: F9 → S-3 25 + W-2 15 + I-5 10 + I-7 8 = 58, evidence as in section 4.
/// T-3 and T-4 fire as reducers but scoring blocks them (S-3 ≥ 25).
#[test]
fn spec_test_9_f9() {
    let s = seed();
    let inv = parse(&fixture("f9.xml"));
    let c = scenario(&inv, &s);
    let fired = criteria_fired(&c);
    assert_eq!(fired, [("S-3", 25), ("W-2", 15), ("I-5", 10), ("I-7", 8)]);
    assert_eq!(sum(&fired), 58);
    assert_eq!(
        evidence(&c, "S-3"),
        "supplier approved 6x, never with this wallet"
    );
    assert_eq!(
        evidence(&c, "W-2"),
        "first transaction 2026-10-27, 3 days before check"
    );
    assert_eq!(
        evidence(&c, "I-5"),
        "pressure wording: dringend, neue wallet"
    );
    assert_eq!(
        evidence(&c, "I-7"),
        "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)"
    );
    assert_eq!(reducers_fired(&c), [("T-3", -10), ("T-4", -5)]);
}

/// Test 10: F10 → S-1 35 + S-9 5 + I-5 10 + I-7 8 + I-8 8 = 66.
#[test]
fn spec_test_10_f10() {
    let s = seed();
    let inv = parse(&fixture("f10.xml"));
    let c = scenario(&inv, &s);
    let fired = criteria_fired(&c);
    assert_eq!(
        fired,
        [("S-1", 35), ("S-9", 5), ("I-5", 10), ("I-7", 8), ("I-8", 8)]
    );
    assert_eq!(sum(&fired), 66);
    assert_eq!(
        evidence(&c, "S-1"),
        "wallet approved 6x, never for this supplier"
    );
    assert_eq!(evidence(&c, "I-5"), "pressure wording: dringend");
    assert_eq!(evidence(&c, "I-8"), "BT-13 empty");
    assert_eq!(reducers_fired(&c), [("T-1", -15), ("T-4", -5)]);
}

/// Test 11: F11 → S-8 5 + S-9 5 + W-4 10 + I-8 8 + I-10 5 = 33; T-4 −5.
/// I-2 stays silent: the shipped new-wallet limit equals `max_invoice_eur` (10000).
#[test]
fn spec_test_11_f11() {
    let s = seed();
    let inv = parse(&fixture("f11.xml"));
    let c = scenario(&inv, &s);
    let fired = criteria_fired(&c);
    assert_eq!(
        fired,
        [("S-8", 5), ("S-9", 5), ("W-4", 10), ("I-8", 8), ("I-10", 5)]
    );
    assert_eq!(sum(&fired), 33);
    assert_eq!(evidence(&c, "S-8"), "free-mail domain in BT-43");
    assert_eq!(
        evidence(&c, "I-10"),
        "amount 2000.00 EUR is a multiple of 100.00 EUR"
    );
    assert_eq!(reducers_fired(&c), [("T-4", -5)]);
}

/// Test 12: Blockfrost unavailable → no W-2/W-4; nothing fires.
#[test]
fn spec_test_12_blockfrost_unavailable() {
    let s = seed();
    let inv = f1();
    let mut c = scenario(&inv, &s);
    c.blockfrost = SourceResult::Unavailable;
    assert_eq!(criteria_fired(&c), []);
}

/// Test 14: signature note → like test 1 (not an I-5 text).
#[test]
fn spec_test_14_signature_note() {
    let s = seed();
    let inv = parse(&f1_with(&[(
        "<ram:IncludedNote>",
        "<ram:IncludedNote>\n      <ram:Content>cardano-sig-v1:abcd;ef01</ram:Content>\n    </ram:IncludedNote>\n    <ram:IncludedNote>",
    )]));
    assert!(inv.has_signature());
    let c = scenario(&inv, &s);
    assert_eq!(criteria_fired(&c), []);
    assert_eq!(reducers_fired(&c).len(), 4);
}

/// Test 15: `Bitte heute noch zahlen` → I-5 only.
#[test]
fn spec_test_15_pressure_words() {
    let s = seed();
    let inv = parse(&f1_with(&[(
        "Vielen Dank für Ihren Auftrag.",
        "Bitte heute noch zahlen",
    )]));
    let c = scenario(&inv, &s);
    assert_eq!(criteria_fired(&c), [("I-5", 10)]);
    assert_eq!(evidence(&c, "I-5"), "pressure wording: heute noch");
}

/// Test 16 (FR-21): mangled address M has W1's stake part but W3's payment
/// credential → new wallet: S-3 25 + W-4 10 = 35 (no I-2: new-wallet limit equals the max).
#[test]
fn spec_test_16_mangled_address() {
    let s = seed();
    assert_eq!(wallet_hash_of(M), wallet_hash_of(W3));
    assert_ne!(wallet_hash_of(M), wallet_hash_of(W1));
    let inv = parse(&f1_with(&[(W1, M)]));
    let c = scenario(&inv, &s);
    assert_eq!(c.wallet, None);
    let fired = criteria_fired(&c);
    assert_eq!(fired, [("S-3", 25), ("W-4", 10)]);
    assert_eq!(sum(&fired), 35);
    assert_eq!(reducers_fired(&c), [("T-3", -10), ("T-4", -5)]);
}

/// Test 17: W5 → KO-4 `wallet on OFAC SDN list`.
#[test]
fn spec_test_17_ofac_wallet() {
    let s = seed();
    let inv = parse(&f1_with(&[(W1, W5)]));
    let c = scenario(&inv, &s);
    assert_eq!(fired_of(&c, &[Kind::Ko]), [("KO-4", 100)]);
    assert_eq!(evidence(&c, "KO-4"), "wallet on OFAC SDN list");
}

/// Test 18: F18 → KO-4 `seller name matches OFAC SDN entry`.
#[test]
fn spec_test_18_sanctioned_name() {
    let s = seed();
    let inv = parse(&f1_with(&[
        ("Alpha Consulting GmbH", "Delta Trading LLC"),
        ("schemeID=\"VA\">DE111111111", "schemeID=\"VA\">DE555555555"),
    ]));
    let c = scenario(&inv, &s);
    assert_eq!(fired_of(&c, &[Kind::Ko]), [("KO-4", 100)]);
    assert_eq!(evidence(&c, "KO-4"), "seller name matches OFAC SDN entry");
}

/// Test 19: F19 → S-1 35 + S-2 35 + S-9 5 + I-8 8 = 83.
#[test]
fn spec_test_19_vies_invalid() {
    let s = seed();
    let inv = parse(&f1_with(&[
        ("Alpha Consulting GmbH", "Epsilon GmbH"),
        ("schemeID=\"VA\">DE111111111", "schemeID=\"VA\">DE444444444"),
    ]));
    let c = scenario(&inv, &s);
    let fired = criteria_fired(&c);
    assert_eq!(fired, [("S-1", 35), ("S-2", 35), ("S-9", 5), ("I-8", 8)]);
    assert_eq!(sum(&fired), 83);
    assert_eq!(
        evidence(&c, "I-8"),
        "BT-13 not an open order of this supplier"
    );
    assert_eq!(reducers_fired(&c), [("T-1", -15)]);
}

/// Tests 20 and 21: Chainabuse report trusted → W-1 30; unverified → W-6 10.
#[test]
fn spec_tests_20_21_chainabuse() {
    let s = seed();
    let inv = f1();
    let mut c = scenario(&inv, &s);
    c.chainabuse = SourceResult::Ok(ChainabuseValue {
        reports: 1,
        trusted_or_checked: 1,
    });
    assert_eq!(criteria_fired(&c), [("W-1", 30)]);
    c.chainabuse = SourceResult::Ok(ChainabuseValue {
        reports: 1,
        trusted_or_checked: 0,
    });
    assert_eq!(criteria_fired(&c), [("W-6", 10)]);
    assert_eq!(evidence(&c, "W-6"), "chainabuse: 1 unverified report(s)");
}

/// Test 24: USD → EUR criteria skipped, `CURRENCY_NOT_EUR`, no criteria fire.
#[test]
fn spec_test_24_currency_not_eur() {
    let s = seed();
    let inv = parse(&f1_with(&[
        (
            "<ram:InvoiceCurrencyCode>EUR",
            "<ram:InvoiceCurrencyCode>USD",
        ),
        ("currencyID=\"EUR\"", "currencyID=\"USD\""),
    ]));
    let c = scenario(&inv, &s);
    assert!(currency_not_eur(&c));
    assert_eq!(criteria_fired(&c), []);
}

/// Test 3/4 at criterion level: KO-1 and KO-2 from the parse and address steps.
#[test]
fn spec_tests_3_4_ko1_ko2() {
    let s = seed();
    let xml = fixture("f1.xml");
    let start = xml
        .find("<ram:PayeePartyCreditorFinancialAccount>")
        .unwrap();
    let end = xml
        .find("</ram:PayeePartyCreditorFinancialAccount>")
        .unwrap()
        + "</ram:PayeePartyCreditorFinancialAccount>".len();
    let out = parse_invoice(&format!("{}{}", &xml[..start], &xml[end..]));
    let inv = out.invoice.unwrap();
    let mut c = scenario(&inv, &s);
    c.ko1_codes = out.ko1_codes;
    assert_eq!(fired_of(&c, &[Kind::Ko]), [("KO-1", 100)]);
    assert_eq!(evidence(&c, "KO-1"), "MISSING_FIELD:BT-84");

    let w1_main = "addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qc5hee8";
    let inv = parse(&f1_with(&[(W1, w1_main)]));
    let c = scenario(&inv, &s);
    assert_eq!(fired_of(&c, &[Kind::Ko]), [("KO-2", 100)]);
    assert_eq!(evidence(&c, "KO-2"), "NETWORK_MISMATCH");
}
