//! `db-seed` (spec 7.4, 7.5). Owner: Task 18.
//!
//! Loads demo and test history from a JSON file: invoices with their final decision
//! (counters via the 5.4 upserts), blocklist entries, sanction names and, optionally,
//! a fresh `list_updates` row for OFAC. Repeatable: invoices whose `invoice_hash`
//! already exists are skipped, blocks and names are upserts.

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Deserialize;
use sqlx::PgPool;

use crate::address;
use crate::hashing::{self, HmacKey};
use crate::normalize::{self, LegalForms};
use crate::sanctions::wallet_hash_of;
use crate::store::postgres::{self, BlockSource, SubjectType};

/// `seed/seed.json` (7.5).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedFile {
    #[serde(default)]
    invoices: Vec<SeedInvoice>,
    #[serde(default)]
    blocklist: Vec<SeedBlock>,
    #[serde(default)]
    sanction_names: Vec<SeedSanctionName>,
    #[serde(default)]
    ofac_list_fresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedInvoice {
    seller_vat_id: String,
    seller_name: String,
    seller_email: Option<String>,
    seller_phone: Option<String>,
    seller_street: Option<String>,
    seller_postcode: Option<String>,
    seller_city: Option<String>,
    seller_country: String,
    wallet_address: String,
    invoice_number: String,
    amount: String,
    currency: String,
    issue_date: NaiveDate,
    type_code: String,
    final_decision: FinalDecision,
    final_reason_type: Option<FinalReasonType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FinalDecision {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FinalReasonType {
    Risk,
    Formal,
}

/// Blocklist entry type, shared with the `blocklist-*` commands (7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockType {
    Wallet,
    Supplier,
}

impl BlockType {
    pub fn subject_type(self) -> SubjectType {
        match self {
            BlockType::Wallet => SubjectType::Wallet,
            BlockType::Supplier => SubjectType::Supplier,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedBlock {
    #[serde(rename = "type")]
    kind: BlockType,
    value: String,
    source: SeedBlockSource,
    reason: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum SeedBlockSource {
    #[serde(rename = "internal")]
    Internal,
    #[serde(rename = "OFAC")]
    Ofac,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedSanctionName {
    name: String,
    sdn_uid: String,
}

/// Block reason code, `^[A-Z0-9_]{1,40}$` (7.1).
pub fn is_valid_reason_code(code: &str) -> bool {
    (1..=40).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// BT-31 format after `vat()` (3.1): `^[A-Z]{2}[A-Z0-9]{2,14}$`.
pub fn is_valid_vat(v: &str) -> bool {
    let b = v.as_bytes();
    (4..=16).contains(&b.len())
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// Hash of a blocklist value without storing or echoing it (7.1): wallet → address
/// check 3.4 steps 1–3 → `wallet_hash`; supplier → `vat()` → `supplier_hash`.
/// Errors carry only a code, never the raw value.
pub fn block_subject_hash(key: &HmacKey, kind: BlockType, value: &str) -> anyhow::Result<String> {
    match kind {
        BlockType::Wallet => {
            let checked = address::check_without_network(value)
                .map_err(|e| anyhow::anyhow!("invalid wallet address ({})", e.code()))?;
            Ok(wallet_hash_of(key, &checked))
        }
        BlockType::Supplier => {
            let v = normalize::vat(value);
            if !is_valid_vat(&v) {
                anyhow::bail!("invalid supplier VAT ID (expected ^[A-Z]{{2}}[A-Z0-9]{{2,14}}$ after normalization)");
            }
            Ok(hashing::supplier_hash(key, &v))
        }
    }
}

/// All hashes of one seed invoice (3.3).
struct InvoiceHashes {
    invoice_hash: String,
    supplier_hash: String,
    wallet_hash: String,
    pair_hash: String,
    name_hash: String,
    email_domain_hash: Option<String>,
    phone_hash: Option<String>,
    postal_hash: Option<String>,
}

fn invoice_hashes(
    key: &HmacKey,
    lf: &LegalForms,
    inv: &SeedInvoice,
    amount: &Decimal,
) -> anyhow::Result<InvoiceHashes> {
    let vat = normalize::vat(&inv.seller_vat_id);
    if !is_valid_vat(&vat) {
        anyhow::bail!("invalid seller_vat_id");
    }
    let checked = address::check_without_network(&inv.wallet_address)
        .map_err(|e| anyhow::anyhow!("invalid wallet_address ({})", e.code()))?;
    let supplier_hash = hashing::supplier_hash(key, &vat);
    let wallet_hash = wallet_hash_of(key, &checked);
    let pair_hash = hashing::pair_hash(key, &supplier_hash, &wallet_hash);
    let email = normalize::email_domain(inv.seller_email.as_deref(), None);
    let phone = inv.seller_phone.as_deref().and_then(normalize::phone);
    let postal = normalize::postal(
        inv.seller_street.as_deref(),
        inv.seller_postcode.as_deref(),
        inv.seller_city.as_deref(),
        Some(inv.seller_country.as_str()),
    );
    Ok(InvoiceHashes {
        invoice_hash: hashing::invoice_hash(
            key,
            &vat,
            &normalize::invoice_no(&inv.invoice_number),
            &normalize::amount(amount),
            &inv.issue_date.format("%Y-%m-%d").to_string(),
            inv.type_code.trim(),
        ),
        name_hash: hashing::name_hash(key, &normalize::name(&inv.seller_name, lf)),
        email_domain_hash: email.map(|d| hashing::email_domain_hash(key, &d)),
        phone_hash: phone.map(|p| hashing::phone_hash(key, &p)),
        postal_hash: postal.map(|p| hashing::postal_hash(key, &p)),
        supplier_hash,
        wallet_hash,
        pair_hash,
    })
}

const NEXT_SEED_NUMBER_SQL: &str = "\
SELECT COALESCE(MAX(substring(check_id FROM 6)::bigint), 0) + 1
FROM invoices WHERE check_id ~ '^seed_[0-9]+$'";

const INSERT_INVOICE_SQL: &str = "\
INSERT INTO invoices (
  invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash, name_hash,
  email_domain_hash, phone_hash, postal_hash, amount, currency, issue_date, type_code,
  initial_band, initial_score, final_decision, final_reason_type, final_block_wallet,
  final_decline_reasons, decided_by, decided_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
  'low', 0, $14, $15, false, NULL, 'seed', ($12::date)::timestamp AT TIME ZONE 'UTC')
ON CONFLICT (invoice_hash) DO NOTHING";

const INSERT_SANCTION_NAME_SQL: &str = "\
INSERT INTO sanction_names (name_normalized, source, sdn_uid) VALUES ($1, 'OFAC', $2)
ON CONFLICT DO NOTHING";

const OFAC_FRESH_SQL: &str = "\
INSERT INTO list_updates (source, last_success_at, entries, cardano_addresses)
VALUES ('OFAC', now(), $1, $2)
ON CONFLICT (source) DO UPDATE SET last_success_at = now()";

/// Loads a seed file. Repeatable: existing invoice hashes are skipped. Returns the number of inserted invoices.
pub async fn seed_file(
    pool: &PgPool,
    key: &HmacKey,
    legal_forms: &LegalForms,
    json: &str,
) -> anyhow::Result<usize> {
    let seed: SeedFile =
        serde_json::from_str(json).map_err(|e| anyhow::anyhow!("seed file: {e}"))?;

    // Validate and hash everything before touching the database.
    let mut rows = Vec::with_capacity(seed.invoices.len());
    for (i, inv) in seed.invoices.iter().enumerate() {
        let ctx = |m: String| anyhow::anyhow!("seed invoice #{}: {m}", i + 1);
        let amount = Decimal::from_str_exact(inv.amount.trim())
            .ok()
            .filter(|d| *d > Decimal::ZERO && d.scale() <= 2)
            .ok_or_else(|| ctx("amount must be a positive decimal with at most 2 places".into()))?;
        let currency = inv.currency.trim();
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(ctx("currency must match ^[A-Z]{3}$".into()));
        }
        match (inv.final_decision, inv.final_reason_type) {
            (FinalDecision::Approved, None) | (FinalDecision::Rejected, Some(_)) => {}
            (FinalDecision::Approved, Some(_)) => {
                return Err(ctx("final_reason_type must be null for approved".into()))
            }
            (FinalDecision::Rejected, None) => {
                return Err(ctx("final_reason_type is required for rejected".into()))
            }
        }
        let hashes =
            invoice_hashes(key, legal_forms, inv, &amount).map_err(|e| ctx(e.to_string()))?;
        rows.push((inv, amount, currency, hashes));
    }
    let mut blocks = Vec::with_capacity(seed.blocklist.len());
    for (i, b) in seed.blocklist.iter().enumerate() {
        if !is_valid_reason_code(&b.reason) {
            anyhow::bail!(
                "seed blocklist #{}: reason must match ^[A-Z0-9_]{{1,40}}$",
                i + 1
            );
        }
        let hash = block_subject_hash(key, b.kind, &b.value)
            .map_err(|e| anyhow::anyhow!("seed blocklist #{}: {e}", i + 1))?;
        let source = match b.source {
            SeedBlockSource::Internal => BlockSource::Internal,
            SeedBlockSource::Ofac => BlockSource::Ofac,
        };
        blocks.push((hash, b.kind.subject_type(), source, b.reason.as_str()));
    }

    let mut tx = pool.begin().await?;
    let mut next: i64 = sqlx::query_scalar(NEXT_SEED_NUMBER_SQL)
        .fetch_one(&mut *tx)
        .await?;
    let mut inserted = 0usize;
    for (inv, amount, currency, h) in &rows {
        let decision = match inv.final_decision {
            FinalDecision::Approved => "approved",
            FinalDecision::Rejected => "rejected",
        };
        let reason = inv.final_reason_type.map(|r| match r {
            FinalReasonType::Risk => "risk",
            FinalReasonType::Formal => "formal",
        });
        let done = sqlx::query(INSERT_INVOICE_SQL)
            .bind(&h.invoice_hash)
            .bind(format!("seed_{next}"))
            .bind(&h.supplier_hash)
            .bind(&h.wallet_hash)
            .bind(&h.pair_hash)
            .bind(&h.name_hash)
            .bind(&h.email_domain_hash)
            .bind(&h.phone_hash)
            .bind(&h.postal_hash)
            .bind(amount)
            .bind(currency)
            .bind(inv.issue_date)
            .bind(inv.type_code.trim())
            .bind(decision)
            .bind(reason)
            .execute(&mut *tx)
            .await?;
        if done.rows_affected() == 0 {
            continue; // invoice_hash exists: skipped (repeatable)
        }
        next += 1;
        inserted += 1;
        // Counters per 5.4.
        match (inv.final_decision, inv.final_reason_type) {
            (FinalDecision::Approved, _) => {
                postgres::approve_subject(&mut *tx, &h.wallet_hash, SubjectType::Wallet).await?;
                postgres::approve_subject(&mut *tx, &h.pair_hash, SubjectType::Pair).await?;
                postgres::approve_subject(&mut *tx, &h.supplier_hash, SubjectType::Supplier)
                    .await?;
            }
            (FinalDecision::Rejected, Some(FinalReasonType::Risk)) => {
                postgres::reject_risk_subject(&mut *tx, &h.wallet_hash, SubjectType::Wallet)
                    .await?;
                postgres::reject_risk_subject(&mut *tx, &h.pair_hash, SubjectType::Pair).await?;
            }
            (FinalDecision::Rejected, _) => {}
        }
    }

    for (hash, subject_type, source, reason) in &blocks {
        postgres::block_subject(&mut *tx, hash, *subject_type, *source, reason).await?;
    }

    for n in &seed.sanction_names {
        let normalized = normalize::name(&n.name, legal_forms);
        if normalized.is_empty() || n.sdn_uid.trim().is_empty() {
            anyhow::bail!("seed sanction_names: name and sdn_uid must not be empty");
        }
        sqlx::query(INSERT_SANCTION_NAME_SQL)
            .bind(&normalized)
            .bind(n.sdn_uid.trim())
            .execute(&mut *tx)
            .await?;
    }

    if seed.ofac_list_fresh {
        let ofac_blocks = blocks
            .iter()
            .filter(|(_, t, s, _)| *s == BlockSource::Ofac && *t == SubjectType::Wallet)
            .count();
        sqlx::query(OFAC_FRESH_SQL)
            .bind(i32::try_from(seed.sanction_names.len())?)
            .bind(i32::try_from(ofac_blocks)?)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const SEED: &str = include_str!("../seed/seed.json");
    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const W4: &str = "addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww";
    const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";

    fn key() -> HmacKey {
        HmacKey::from_hex(KEY).unwrap()
    }

    fn lf() -> LegalForms {
        LegalForms::from_json(include_str!("../data/legal-forms.json")).unwrap()
    }

    #[test]
    fn shipped_seed_matches_spec_7_5() {
        let s: SeedFile = serde_json::from_str(SEED).unwrap();
        let expected = [
            ("RE-2026-0101", "1190.00", "2026-04-15"),
            ("RE-2026-0102", "1250.00", "2026-05-15"),
            ("RE-2026-0103", "980.00", "2026-06-15"),
            ("RE-2026-0104", "1100.00", "2026-07-15"),
            ("RE-2026-0105", "1300.00", "2026-08-15"),
            ("RE-2026-0106", "1050.00", "2026-09-15"),
        ];
        assert_eq!(s.invoices.len(), 6);
        for (inv, (no, amount, date)) in s.invoices.iter().zip(expected) {
            assert_eq!(inv.invoice_number, no);
            assert_eq!(inv.amount, amount);
            assert_eq!(inv.issue_date.to_string(), date);
            assert_eq!(inv.seller_vat_id, "DE111111111");
            assert_eq!(inv.seller_name, "Alpha Consulting GmbH");
            assert_eq!(inv.wallet_address, W1);
            assert_eq!(inv.currency, "EUR");
            assert_eq!(inv.type_code, "380");
            assert_eq!(inv.final_decision, FinalDecision::Approved);
            assert_eq!(inv.final_reason_type, None);
        }
        assert_eq!(s.blocklist.len(), 2);
        assert_eq!(s.blocklist[0].value, W4);
        assert_eq!(s.blocklist[0].reason, "TEST_INTERNAL");
        assert!(matches!(s.blocklist[0].source, SeedBlockSource::Internal));
        assert_eq!(s.blocklist[1].value, W5);
        assert_eq!(s.blocklist[1].reason, "TEST_OFAC");
        assert!(matches!(s.blocklist[1].source, SeedBlockSource::Ofac));
        assert_eq!(s.sanction_names.len(), 1);
        assert_eq!(s.sanction_names[0].name, "Delta Trading LLC");
        assert_eq!(s.sanction_names[0].sdn_uid, "TEST-1");
        assert!(s.ofac_list_fresh);
    }

    /// The seed hashes for supplier A / W1 equal the 3.3 test vectors.
    #[test]
    fn seed_invoice_hashes_match_spec_vectors() {
        let s: SeedFile = serde_json::from_str(SEED).unwrap();
        let inv = &s.invoices[0];
        let amount = Decimal::from_str("1190.00").unwrap();
        let h = invoice_hashes(&key(), &lf(), inv, &amount).unwrap();
        assert_eq!(
            h.supplier_hash,
            "hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060"
        );
        assert_eq!(
            h.wallet_hash,
            "hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090"
        );
        assert_eq!(
            h.pair_hash,
            "hmac:d0323c2f6d8cb2ac79d4051e884ae7693c08022489b933ddd84695829ec9f7fb"
        );
        assert_eq!(
            h.name_hash,
            "hmac:ae9f9068ecda382921db60e08d7b63fddcb71b8cc6d7873b5f0144620728283e"
        );
        assert_eq!(
            h.email_domain_hash.as_deref(),
            Some("hmac:e207dd8824dfc54c7f5e06c303bf8c75dcb27b34a79da1d36bf3a6d578ce2605")
        );
        assert_eq!(
            h.phone_hash.as_deref(),
            Some("hmac:0ec970e7ac952f9036af04d68f06a3eba01c1ba5af84190f62c8bb8146e65faf")
        );
        assert_eq!(
            h.postal_hash.as_deref(),
            Some("hmac:047e5c67e89c1fb3fbc09c001dd7fb73cedb6bbf8475270bac86aedfb40ca4fc")
        );
        assert_eq!(
            h.invoice_hash,
            hashing::invoice_hash(
                &key(),
                "DE111111111",
                "RE-2026-0101",
                "1190.00",
                "2026-04-15",
                "380"
            )
        );
    }

    #[test]
    fn reason_code_rule() {
        for ok in ["TEST_INTERNAL", "A", "AGENT_DECISION", &"X".repeat(40)] {
            assert!(is_valid_reason_code(ok), "{ok}");
        }
        for bad in [
            "",
            "test",
            "WITH SPACE",
            "DASH-ED",
            &"X".repeat(41),
            "ÄRGER",
        ] {
            assert!(!is_valid_reason_code(bad), "{bad}");
        }
    }

    #[test]
    fn block_hash_never_echoes_value() {
        let k = key();
        assert_eq!(
            block_subject_hash(&k, BlockType::Supplier, "de 111 111 111").unwrap(),
            "hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060"
        );
        assert_eq!(
            block_subject_hash(&k, BlockType::Wallet, W1).unwrap(),
            "hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090"
        );
        let bad = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q";
        let e = block_subject_hash(&k, BlockType::Wallet, bad)
            .unwrap_err()
            .to_string();
        assert!(e.contains("BECH32_INVALID") && !e.contains(bad), "{e}");
        let e = block_subject_hash(&k, BlockType::Supplier, "x")
            .unwrap_err()
            .to_string();
        assert!(!e.contains("\"x\""), "{e}");
    }
}
