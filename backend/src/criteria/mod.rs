//! Criterion trait, CheckContext and registry (spec 3.6.0, FR-53).
//!
//! [`CheckContext`] is plain data: the pipeline fills it (parse, address check, hashes,
//! database reads, external sources) and every criterion evaluates it without I/O.
//! Criteria return their configured points; the KO cap, reducer budget and band logic
//! live in scoring (3.8).

pub mod invoice;
pub mod ko;
pub mod reducers;
pub mod supplier;
pub mod wallet;

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;

use crate::address::{AddressError, CheckedAddress, CredentialType, Network};
use crate::config::{CriterionCfg, DataFiles, OpenOrder, Params};
use crate::hashing::{self, CredentialKind, HmacKey};
use crate::normalize::{self, LegalForms};
use crate::parse::Invoice;
use crate::sources::ChainabuseValue;
use crate::store::postgres::{Subject, SubjectStatus};

/// One evaluated criterion (spec 3.6.0).
pub trait Criterion: Send + Sync {
    /// ID as in `config/criteria.json`, e.g. `"S-3"`.
    fn id(&self) -> &'static str;
    /// `Some(Finding)` when the criterion fires.
    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding>;
}

/// A fired criterion: points from the config (W-2: from its tiers; KO: `ko_points`)
/// and the evidence string of the 3.6 tables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub points: i32,
    pub evidence: String,
}

/// Outcome of one external source (3.7.2-3.7.4) as seen by the criteria.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceResult<T> {
    /// Successful answer.
    Ok(T),
    /// Call failed (`*_UNAVAILABLE`); dependent criteria do not fire (FR-44).
    Unavailable,
    /// Not called because a K.O. fired (`checks_skipped` reason `ko`), or no input.
    Skipped,
    /// Not applicable (VIES without EU prefix, `checks_skipped` reason `not_applicable`).
    NotApplicable,
}

impl<T> SourceResult<T> {
    pub fn ok(&self) -> Option<&T> {
        match self {
            SourceResult::Ok(v) => Some(v),
            _ => None,
        }
    }
}

/// Where `email_domain` came from (S-8 evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailSource {
    Bt43,
    Bt34,
}

impl EmailSource {
    pub fn as_str(self) -> &'static str {
        match self {
            EmailSource::Bt43 => "BT-43",
            EmailSource::Bt34 => "BT-34",
        }
    }
}

/// Hashes of spec 3.3; `None` when an input is missing or invalid (3.5 step 6).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hashes {
    pub address: Option<String>,
    pub wallet: Option<String>,
    pub supplier: Option<String>,
    pub name: Option<String>,
    pub email_domain: Option<String>,
    pub phone: Option<String>,
    pub postal: Option<String>,
    pub invoice: Option<String>,
    pub pair: Option<String>,
}

impl Hashes {
    /// Spec 3.5 step 6: every hash whose inputs are present and valid. Pure.
    pub fn compute(
        key: &HmacKey,
        legal_forms: &LegalForms,
        invoice: Option<&Invoice>,
        address: Option<&CheckedAddress>,
    ) -> Self {
        let mut h = Hashes {
            address: address.map(|a| hashing::address_hash(key, &a.address)),
            wallet: address.map(|a| {
                let kind = match a.credential_type {
                    CredentialType::Key => CredentialKind::Key,
                    CredentialType::Script => CredentialKind::Script,
                };
                hashing::wallet_hash(key, kind, &a.credential_hex)
            }),
            ..Hashes::default()
        };
        if let Some(inv) = invoice {
            let vat = inv.seller_vat_id.as_deref().map(normalize::vat);
            h.supplier = vat.as_deref().map(|v| hashing::supplier_hash(key, v));
            h.name = inv
                .seller_name
                .as_deref()
                .map(|n| hashing::name_hash(key, &normalize::name(n, legal_forms)));
            h.email_domain = email_domain_of(inv).map(|(d, _)| hashing::email_domain_hash(key, &d));
            h.phone = inv
                .seller_phone
                .as_deref()
                .and_then(normalize::phone)
                .map(|p| hashing::phone_hash(key, &p));
            h.postal = normalize::postal(
                inv.seller_street.as_deref(),
                inv.seller_postcode.as_deref(),
                inv.seller_city.as_deref(),
                inv.seller_country.as_deref(),
            )
            .map(|p| hashing::postal_hash(key, &p));
            if let (Some(vat), Some(no), Some(total), Some(date), Some(tc)) = (
                vat.as_deref(),
                inv.invoice_number.as_deref(),
                inv.grand_total.as_ref(),
                inv.issue_date,
                inv.type_code.as_deref(),
            ) {
                h.invoice = Some(hashing::invoice_hash(
                    key,
                    vat,
                    &normalize::invoice_no(no),
                    &normalize::amount(total),
                    &date.format("%Y-%m-%d").to_string(),
                    tc,
                ));
            }
        }
        if let (Some(s), Some(w)) = (&h.supplier, &h.wallet) {
            h.pair = Some(hashing::pair_hash(key, s, w));
        }
        h
    }
}

/// `email_domain` (3.3) with its source: BT-43, or BT-34 only with `schemeID="EM"`.
pub fn email_domain_of(inv: &Invoice) -> Option<(String, EmailSource)> {
    let bt34 = inv
        .seller_electronic_address
        .as_ref()
        .map(|e| (e.scheme.as_str(), e.value.as_str()));
    let source = if inv.seller_email.is_some() {
        EmailSource::Bt43
    } else {
        EmailSource::Bt34
    };
    normalize::email_domain(inv.seller_email.as_deref(), bt34).map(|d| (d, source))
}

/// Hashes of the supplier's last approved invoice (S-7; 3.6.2 ordering is the query's job).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LastApproved {
    pub name_hash: Option<String>,
    pub email_domain_hash: Option<String>,
    pub phone_hash: Option<String>,
    pub postal_hash: Option<String>,
}

/// Everything a criterion may read (3.6.0). No I/O.
#[derive(Debug, Clone)]
pub struct CheckContext<'a> {
    /// FR-03, whole seconds, UTC.
    pub checked_at: DateTime<Utc>,
    /// "Prüfdatum": date part of `checked_at` in UTC.
    pub check_date: NaiveDate,
    /// `EXPECTED_NETWORK` (I-11).
    pub expected_network: Network,
    /// `ko_points` from `criteria.json`.
    pub ko_points: i32,
    pub params: &'a Params,
    pub data: &'a DataFiles,
    /// `None` only for unparseable XML or a wrong root.
    pub invoice: Option<&'a Invoice>,
    /// KO-1 codes from steps 2-4 (parse + Mustang), in order.
    pub ko1_codes: Vec<String>,
    /// 3.4 result; `None` when BT-84 is missing.
    pub address: Option<Result<CheckedAddress, AddressError>>,
    pub hashes: Hashes,
    pub wallet: Option<Subject>,
    pub supplier: Option<Subject>,
    pub pair: Option<Subject>,
    /// `check_id` of the `invoices` row with the same `invoice_hash` (KO-3).
    pub existing_invoice_check_id: Option<String>,
    /// `name(BT-27)` is in `sanction_names` (KO-4).
    pub sanction_name_hit: bool,
    /// Last approved invoice of the supplier (S-7).
    pub last_approved: Option<LastApproved>,
    /// `invoices` rows with this `supplier_hash` (S-9).
    pub previous_invoice_count: i64,
    /// Amounts of the supplier's approved EUR invoices (I-4).
    pub approved_eur_amounts: Vec<Decimal>,
    /// First transaction time (UNIX seconds), `Ok(None)` = no transaction (W-2, W-4).
    pub blockfrost: SourceResult<Option<i64>>,
    /// VIES validity (S-2, T-4).
    pub vies: SourceResult<bool>,
    /// Chainabuse counts (W-1, W-6).
    pub chainabuse: SourceResult<ChainabuseValue>,
    /// `email_domain` (3.3) and where it came from (S-8).
    pub email_domain: Option<(String, EmailSource)>,
}

impl<'a> CheckContext<'a> {
    /// Empty context: no invoice, no history, all sources skipped.
    pub fn new(
        checked_at: DateTime<Utc>,
        expected_network: Network,
        ko_points: i32,
        params: &'a Params,
        data: &'a DataFiles,
    ) -> Self {
        Self {
            checked_at,
            check_date: checked_at.date_naive(),
            expected_network,
            ko_points,
            params,
            data,
            invoice: None,
            ko1_codes: Vec::new(),
            address: None,
            hashes: Hashes::default(),
            wallet: None,
            supplier: None,
            pair: None,
            existing_invoice_check_id: None,
            sanction_name_hit: false,
            last_approved: None,
            previous_invoice_count: 0,
            approved_eur_amounts: Vec::new(),
            blockfrost: SourceResult::Skipped,
            vies: SourceResult::Skipped,
            chainabuse: SourceResult::Skipped,
            email_domain: None,
        }
    }

    /// Sets the invoice and derives `email_domain` from it.
    pub fn with_invoice(mut self, invoice: &'a Invoice) -> Self {
        self.email_domain = email_domain_of(invoice);
        self.invoice = Some(invoice);
        self
    }
}

/// All criteria in catalog order (6.2).
pub fn registry() -> Vec<Box<dyn Criterion>> {
    vec![
        Box::new(ko::Ko1),
        Box::new(ko::Ko2),
        Box::new(ko::Ko3),
        Box::new(ko::Ko4),
        Box::new(ko::Ko6),
        Box::new(supplier::S1),
        Box::new(supplier::S2),
        Box::new(supplier::S3),
        Box::new(supplier::S4),
        Box::new(supplier::S7),
        Box::new(supplier::S8),
        Box::new(supplier::S9),
        Box::new(wallet::W1),
        Box::new(wallet::W2),
        Box::new(wallet::W4),
        Box::new(wallet::W6),
        Box::new(invoice::I2),
        Box::new(invoice::I3),
        Box::new(invoice::I4),
        Box::new(invoice::I5),
        Box::new(invoice::I6),
        Box::new(invoice::I7),
        Box::new(invoice::I8),
        Box::new(invoice::I10),
        Box::new(invoice::I11),
        Box::new(invoice::I12),
        Box::new(reducers::T1),
        Box::new(reducers::T2),
        Box::new(reducers::T3),
        Box::new(reducers::T4),
    ]
}

/// Registry IDs for `Criteria::validate` (FR-53, FR-80).
pub fn registry_ids() -> Vec<&'static str> {
    registry().iter().map(|c| c.id()).collect()
}

/// BT-5 present and not `EUR`: I-2, I-4, I-10 are skipped and scoring adds
/// `CURRENCY_NOT_EUR` to `checks_incomplete` (3.6.4).
pub fn currency_not_eur(ctx: &CheckContext) -> bool {
    ctx.invoice
        .and_then(|i| i.currency.as_deref())
        .is_some_and(|c| c != "EUR")
}

// --- shared helpers (3.6.0 "Begriffe") ---------------------------------------

/// Configured points of a non-tiered criterion.
pub(crate) fn points(cfg: &CriterionCfg) -> i32 {
    cfg.points.unwrap_or(0)
}

pub(crate) fn finding(points: i32, evidence: impl Into<String>) -> Option<Finding> {
    Some(Finding {
        points,
        evidence: evidence.into(),
    })
}

/// "bekannt": entry with `approved >= 1`; returns that count.
pub(crate) fn known(subject: &Option<Subject>) -> Option<i32> {
    subject.as_ref().map(|s| s.approved).filter(|n| *n >= 1)
}

/// "Paar-Freigaben": `approved` of the pair entry, missing = 0.
pub(crate) fn pair_approved(ctx: &CheckContext) -> i32 {
    ctx.pair.as_ref().map_or(0, |p| p.approved)
}

/// "effektiver Vertrauenswert" of the wallet: -1 if blocked, else `trust`; missing = 0.
pub(crate) fn effective_wallet_trust(ctx: &CheckContext) -> Decimal {
    match &ctx.wallet {
        None => Decimal::ZERO,
        Some(s) if s.status == SubjectStatus::Blocked => Decimal::NEGATIVE_ONE,
        Some(s) => s.trust,
    }
}

/// Trust with exactly 3 decimals (`0.545`, `0.000`, `-1.000`).
pub(crate) fn fmt_trust(t: Decimal) -> String {
    let mut t = t;
    t.rescale(3);
    t.to_string()
}

/// BT-112, only when BT-5 = `EUR` (I-2, I-4, I-10).
pub(crate) fn eur_total(ctx: &CheckContext) -> Option<Decimal> {
    let inv = ctx.invoice?;
    (inv.currency.as_deref() == Some("EUR"))
        .then_some(inv.grand_total)
        .flatten()
}

/// I-8 / T-3: `None` when BT-13 is missing, else whether an open order of this
/// supplier matches (`order_id()` and `vat()` on both sides).
pub(crate) fn open_order_match(ctx: &CheckContext) -> Option<bool> {
    ctx.invoice?.order_reference.as_deref()?;
    Some(matched_open_order(ctx).is_some())
}

/// The `open-orders.json` entry that BT-13 and BT-31 match (same rule as I-8 / T-3),
/// or `None` (no invoice, no BT-13, no BT-31 or no match).
pub fn matched_open_order<'a>(ctx: &CheckContext<'a>) -> Option<&'a OpenOrder> {
    let inv = ctx.invoice?;
    let order = normalize::order_id(inv.order_reference.as_deref()?);
    let vat = normalize::vat(inv.seller_vat_id.as_deref()?);
    ctx.data.open_orders.iter().find(|o| {
        normalize::order_id(&o.order_id) == order && normalize::vat(&o.supplier_vat_id) == vat
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    //! Shared fixtures: shipped config and data, F1 parsed, an empty context.

    use std::path::Path;
    use std::str::FromStr;
    use std::sync::LazyLock;

    use super::*;
    use crate::config::Criteria;
    use crate::store::postgres::{BlockSource, SubjectType};

    pub static CRITERIA: LazyLock<Criteria> = LazyLock::new(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/criteria.json");
        Criteria::load_file(&path).expect("shipped criteria.json").0
    });

    pub static DATA: LazyLock<DataFiles> = LazyLock::new(|| {
        DataFiles::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("data")).expect("data/")
    });

    pub fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read_to_string(path).expect("fixture")
    }

    /// F1 parsed (Anhang A); valid, no KO-1 codes.
    pub fn f1() -> Invoice {
        let out = crate::parse::parse_invoice(&fixture("f1.xml"));
        assert!(out.ko1_codes.is_empty(), "{:?}", out.ko1_codes);
        out.invoice.expect("F1 invoice")
    }

    pub fn cfg(id: &str) -> &'static CriterionCfg {
        CRITERIA.get(id).expect("criterion in config")
    }

    pub fn checked_at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// Empty context at the 8.1 test time.
    pub fn ctx<'a>() -> CheckContext<'a> {
        CheckContext::new(
            checked_at(),
            Network::Preprod,
            CRITERIA.ko_points,
            &CRITERIA.params,
            &DATA,
        )
    }

    pub fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    pub fn subject(ty: SubjectType, approved: i32, trust: &str) -> Subject {
        Subject {
            subject_type: ty,
            approved,
            rejected_risk: 0,
            trust: d(trust),
            status: SubjectStatus::Normal,
            block_source: None,
            block_reason: None,
        }
    }

    pub fn blocked(ty: SubjectType, source: BlockSource, reason: &str) -> Subject {
        Subject {
            status: SubjectStatus::Blocked,
            block_source: Some(source),
            block_reason: Some(reason.to_string()),
            ..subject(ty, 0, "0")
        }
    }

    /// Evaluates one criterion with its shipped config.
    pub fn eval(c: &dyn Criterion, ctx: &CheckContext) -> Option<Finding> {
        c.evaluate(ctx, cfg(c.id()))
    }

    pub fn fired(c: &dyn Criterion, ctx: &CheckContext, points: i32, evidence: &str) {
        assert_eq!(
            eval(c, ctx),
            Some(Finding {
                points,
                evidence: evidence.to_string()
            }),
            "{}",
            c.id()
        );
    }
}

#[cfg(test)]
mod tests;
