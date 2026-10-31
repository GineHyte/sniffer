//! Initial check pipeline (spec 3.5). Owner: Task 16.
//!
//! [`run_check`] follows the steps of 3.5 exactly: IDs, parse, Mustang, address,
//! hashes + invoice lock, database reads and K.O. criteria, either the K.O. short cut
//! or the parallel source calls and point criteria, scoring, the result JSON and one
//! storage transaction (FR-63). Logs carry only `check_id`, hashes, band, score,
//! criterion IDs, error codes and durations (FR-33).

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

use chrono::{DateTime, NaiveDate, Utc};
use regex::Regex;
use rust_decimal::Decimal;
use sqlx::{PgPool, Row};

use crate::address::{self, CheckedAddress, Network};
use crate::app::AppState;
use crate::config::{Criteria, Kind, ReasonType};
use crate::criteria::wallet::age_days;
use crate::criteria::{self, CheckContext, Hashes, LastApproved, SourceResult};
use crate::model::{
    self, Amount, ChainabuseOut, CheckResult, DecidedBy, Engine, FinalDecision, InvoiceOut,
    OpenOrderOut, PairOut, PaymentOut, Signature, SkipReason, SkippedCheck, SkippedSource, Summary,
    SupplierOut, ValidationOut, WalletOut,
};
use crate::mustang::Validation;
use crate::normalize;
use crate::parse::{self, Invoice};
use crate::scoring::{self, Fired, InvoiceRow, ScoreOutcome};
use crate::sources::ChainabuseValue;
use crate::store::postgres::{self, Subject, SubjectStatus, SubjectType};
use crate::store::redis as rstore;

/// `checks_incomplete` codes produced by the pipeline itself (3.7, 3.6.4, FR-72).
pub const MUSTANG_UNAVAILABLE: &str = "MUSTANG_UNAVAILABLE";
pub const BLOCKFROST_UNAVAILABLE: &str = "BLOCKFROST_UNAVAILABLE";
pub const VIES_UNAVAILABLE: &str = "VIES_UNAVAILABLE";
pub const CHAINABUSE_UNAVAILABLE: &str = "CHAINABUSE_UNAVAILABLE";
pub const SANCTIONS_LIST_STALE: &str = "SANCTIONS_LIST_STALE";
pub const CURRENCY_NOT_EUR: &str = "CURRENCY_NOT_EUR";

/// `list_updates.source` of the OFAC import.
const OFAC_SOURCE: &str = "OFAC";

/// A check that ends without a 200 answer; nothing is stored (3.5 step 0/6, FR-63).
#[derive(Debug, thiserror::Error)]
pub enum CheckError {
    /// FR-45: another check holds the lock for this `invoice_hash` (409).
    #[error("check_in_progress")]
    CheckInProgress,
    /// Postgres or Redis unreachable, or the commit failed (503).
    #[error("dependency_unavailable")]
    DependencyUnavailable,
}

impl From<sqlx::Error> for CheckError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(
            error_kind = db_error_kind(&e),
            "postgres error during check"
        );
        CheckError::DependencyUnavailable
    }
}

impl From<redis::RedisError> for CheckError {
    fn from(e: redis::RedisError) -> Self {
        tracing::error!(error_kind = ?e.kind(), "redis error during check");
        CheckError::DependencyUnavailable
    }
}

/// Error class without the message text, which can quote bound values.
fn db_error_kind(e: &sqlx::Error) -> &'static str {
    match e {
        sqlx::Error::Database(_) => "database",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::PoolTimedOut => "pool_timed_out",
        sqlx::Error::PoolClosed => "pool_closed",
        sqlx::Error::RowNotFound => "row_not_found",
        sqlx::Error::ColumnDecode { .. } => "column_decode",
        _ => "other",
    }
}

/// `chk_` + ULID (26 Crockford base32 characters, uppercase), 3.5 step 1.
pub fn new_check_id() -> String {
    format!("chk_{}", ulid::Ulid::generate())
}

/// Runs one initial check (spec 3.5 steps 1-12). `checked_at` is already UTC and
/// truncated to whole seconds (FR-03). The invoice lock is released on every path.
pub async fn run_check(
    state: &AppState,
    xml: &str,
    checked_at: DateTime<Utc>,
) -> Result<CheckResult, CheckError> {
    let started = Instant::now();
    // Step 1.
    let check_id = new_check_id();

    // Step 2-3.
    let parsed = parse::parse_invoice(xml);
    let invoice = parsed.invoice.as_ref();

    // Step 4: Mustang, also when step 3 collected codes; not for a step-2 K.O.
    let validation = match invoice {
        Some(_) => Some(state.mustang.validate(&parsed.bom_stripped_xml).await),
        None => None,
    };

    // Step 5.
    let network = state.env.expected_network;
    let checked_address = invoice
        .and_then(|i| i.payment_address.as_deref())
        .map(|a| address::check(a, network));

    // Step 6.
    let hashes = Hashes::compute(
        &state.env.hmac_key,
        &state.data.legal_forms,
        invoice,
        checked_address.as_ref().and_then(|r| r.as_ref().ok()),
    );

    let lock = hashes.invoice.clone();
    if let Some(invoice_hash) = &lock {
        let mut conn = state.redis.clone();
        if !rstore::try_lock_invoice(&mut conn, invoice_hash).await? {
            tracing::info!(%check_id, invoice_hash = %invoice_hash, error = "check_in_progress", "check rejected");
            return Err(CheckError::CheckInProgress);
        }
    }

    let input = Input {
        check_id,
        checked_at,
        stored_xml: &parsed.bom_stripped_xml,
        parse_codes: &parsed.ko1_codes,
        invoice,
        validation: validation.as_ref(),
        address: checked_address,
        hashes,
        network,
    };
    let result = evaluate_and_store(state, input).await;

    if let Some(invoice_hash) = &lock {
        let mut conn = state.redis.clone();
        if let Err(e) = rstore::unlock_invoice(&mut conn, invoice_hash).await {
            tracing::warn!(invoice_hash = %invoice_hash, error_kind = ?e.kind(), "invoice lock release failed");
        }
    }

    match &result {
        Ok(r) => tracing::info!(
            check_id = %r.check_id,
            invoice_hash = r.invoice.as_ref().and_then(|i| i.invoice_hash.as_deref()).unwrap_or("-"),
            band = r.summary.band.as_str(),
            risk_score = r.summary.risk_score,
            criteria = ?r.criteria.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            reducers = ?r.reducers.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            incomplete = ?r.summary.checks_incomplete,
            duration_ms = started.elapsed().as_millis() as u64,
            "check done"
        ),
        Err(e) => tracing::warn!(
            error = %e,
            duration_ms = started.elapsed().as_millis() as u64,
            "check failed"
        ),
    }
    result
}

/// Results of steps 1-6, input of steps 7-12.
struct Input<'a> {
    check_id: String,
    checked_at: DateTime<Utc>,
    stored_xml: &'a str,
    parse_codes: &'a [String],
    invoice: Option<&'a Invoice>,
    validation: Option<&'a Validation>,
    address: Option<Result<CheckedAddress, address::AddressError>>,
    hashes: Hashes,
    network: Network,
}

/// Database facts of step 7.
#[derive(Default)]
struct Step7 {
    subjects: HashMap<String, Subject>,
    existing_check_id: Option<String>,
    sanction_name_hit: bool,
    list_stale: bool,
}

/// Database history of step 9.
#[derive(Default)]
struct History {
    last_approved: Option<LastApproved>,
    previous_invoice_count: i64,
    approved_eur_amounts: Vec<Decimal>,
}

/// Steps 7-12.
async fn evaluate_and_store(state: &AppState, input: Input<'_>) -> Result<CheckResult, CheckError> {
    let cfg: &Criteria = &state.criteria;
    let mut ctx = CheckContext::new(
        input.checked_at,
        input.network,
        cfg.ko_points,
        &cfg.params,
        &state.data,
    );
    if let Some(inv) = input.invoice {
        ctx = ctx.with_invoice(inv);
    }
    ctx.ko1_codes = input.parse_codes.to_vec();
    if let Some(v) = input.validation {
        ctx.ko1_codes.extend(v.ko1_codes());
    }
    ctx.address = input.address.clone();
    ctx.hashes = input.hashes.clone();

    let mut incomplete: Vec<String> = Vec::new();
    if input.validation.is_some_and(Validation::unavailable) {
        incomplete.push(MUSTANG_UNAVAILABLE.into());
    }
    let mut skipped: Vec<SkippedCheck> = Vec::new();

    // Step 7 (skipped after a step-2 K.O., which continues with step 10).
    if let Some(inv) = input.invoice {
        let facts = read_step7(state, inv, &ctx.hashes).await?;
        let get = |h: &Option<String>| h.as_ref().and_then(|h| facts.subjects.get(h)).cloned();
        ctx.wallet = get(&ctx.hashes.wallet);
        ctx.supplier = get(&ctx.hashes.supplier);
        ctx.pair = get(&ctx.hashes.pair);
        ctx.existing_invoice_check_id = facts.existing_check_id;
        ctx.sanction_name_hit = facts.sanction_name_hit;
        if facts.list_stale {
            incomplete.push(SANCTIONS_LIST_STALE.into());
        }
    } else {
        skipped.push(skip(SkippedSource::Mustang, SkipReason::Ko));
    }

    let registry = criteria::registry();
    let kind_of = |id: &str| cfg.get(id).map(|c| c.kind);
    let mut fired: Vec<Fired> = Vec::new();
    for crit in registry
        .iter()
        .filter(|c| kind_of(c.id()) == Some(Kind::Ko))
    {
        let c = cfg.get(crit.id()).expect("validated config");
        if let Some(f) = crit.evaluate(&ctx, c) {
            fired.push(Fired::new(crit.id(), f.points, f.evidence));
        }
    }
    let ko = !fired.is_empty();

    if ko {
        // Step 8.
        for source in [
            SkippedSource::Blockfrost,
            SkippedSource::Vies,
            SkippedSource::Chainabuse,
        ] {
            skipped.push(skip(source, SkipReason::Ko));
        }
    } else {
        // Step 9: without a K.O. the invoice, address and all hashes are present.
        load_step9(state, &mut ctx, &mut incomplete, &mut skipped).await?;
        for crit in registry
            .iter()
            .filter(|c| matches!(kind_of(c.id()), Some(Kind::Score | Kind::Reducer)))
        {
            let c = cfg.get(crit.id()).expect("validated config");
            if let Some(f) = crit.evaluate(&ctx, c) {
                fired.push(Fired::new(crit.id(), f.points, f.evidence));
            }
        }
        if criteria::currency_not_eur(&ctx) {
            incomplete.push(CURRENCY_NOT_EUR.into());
        }
    }

    // Step 10.
    let outcome = scoring::score(&fired, &incomplete, cfg);
    skipped.sort_by_key(|s| s.source);

    // Step 11.
    let result = build_result(state, &input, &ctx, &outcome, skipped);

    // Step 12.
    store(state, &input, &ctx, &outcome, &result).await?;
    Ok(result)
}

fn skip(source: SkippedSource, reason: SkipReason) -> SkippedCheck {
    SkippedCheck { source, reason }
}

/// Step 7: subjects, duplicate, sanction name, OFAC list freshness (FR-72, real clock).
async fn read_step7(state: &AppState, inv: &Invoice, hashes: &Hashes) -> Result<Step7, CheckError> {
    let pool = &state.pool;
    let subject_hashes: Vec<&str> = [&hashes.wallet, &hashes.supplier, &hashes.pair]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect();
    let subjects = postgres::get_subjects(pool, &subject_hashes).await?;

    let existing_check_id = match &hashes.invoice {
        Some(h) => {
            sqlx::query_scalar::<_, String>("SELECT check_id FROM invoices WHERE invoice_hash = $1")
                .bind(h)
                .fetch_optional(pool)
                .await?
        }
        None => None,
    };

    let sanction_name_hit = match inv.seller_name.as_deref() {
        Some(name) => {
            let normalized = normalize::name(name, &state.data.legal_forms);
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM sanction_names WHERE name_normalized = $1)",
            )
            .bind(normalized)
            .fetch_one(pool)
            .await?
        }
        None => false,
    };

    let last_success = sqlx::query_scalar::<_, DateTime<Utc>>(
        "SELECT last_success_at FROM list_updates WHERE source = $1",
    )
    .bind(OFAC_SOURCE)
    .fetch_optional(pool)
    .await?;
    let max_age = chrono::Duration::hours(state.env.lists_max_age_hours as i64);
    let list_stale = last_success.is_none_or(|t| Utc::now() - t > max_age);

    Ok(Step7 {
        subjects,
        existing_check_id,
        sanction_name_hit,
        list_stale,
    })
}

/// Step 9: database history, Blockfrost, VIES and Chainabuse in parallel (FR-43).
async fn load_step9(
    state: &AppState,
    ctx: &mut CheckContext<'_>,
    incomplete: &mut Vec<String>,
    skipped: &mut Vec<SkippedCheck>,
) -> Result<(), CheckError> {
    let inv = ctx.invoice.expect("no K.O. implies a parsed invoice");
    let addr = match &ctx.address {
        Some(Ok(a)) => a.address.clone(),
        _ => unreachable!("no K.O. implies a valid address"),
    };
    let address_hash = ctx.hashes.address.clone().unwrap_or_default();
    let supplier_hash = ctx.hashes.supplier.clone().unwrap_or_default();
    let vat = inv
        .seller_vat_id
        .as_deref()
        .map(normalize::vat)
        .unwrap_or_default();

    let mut bf_conn = state.redis.clone();
    let mut vies_conn = state.redis.clone();
    let mut ca_conn = state.redis.clone();
    let (history, bf, vies, ca) = tokio::join!(
        read_history(&state.pool, &supplier_hash),
        state
            .blockfrost
            .first_tx_time(Some(&mut bf_conn), &addr, &address_hash),
        state.vies.check(Some(&mut vies_conn), &vat, &supplier_hash),
        state
            .chainabuse
            .reports(Some(&mut ca_conn), &addr, &address_hash),
    );
    let history = history?;
    ctx.last_approved = history.last_approved;
    ctx.previous_invoice_count = history.previous_invoice_count;
    ctx.approved_eur_amounts = history.approved_eur_amounts;

    ctx.blockfrost = match bf {
        Ok(v) => SourceResult::Ok(v),
        Err(_) => {
            incomplete.push(BLOCKFROST_UNAVAILABLE.into());
            SourceResult::Unavailable
        }
    };
    ctx.vies = match vies {
        None => {
            skipped.push(skip(SkippedSource::Vies, SkipReason::NotApplicable));
            SourceResult::NotApplicable
        }
        Some(Ok(v)) => SourceResult::Ok(v),
        Some(Err(_)) => {
            incomplete.push(VIES_UNAVAILABLE.into());
            SourceResult::Unavailable
        }
    };
    ctx.chainabuse = match ca {
        Ok(v) => SourceResult::Ok(v),
        Err(_) => {
            incomplete.push(CHAINABUSE_UNAVAILABLE.into());
            SourceResult::Unavailable
        }
    };
    Ok(())
}

/// Last approved invoice (S-7), invoice count (S-9), approved EUR amounts (I-4).
async fn read_history(pool: &PgPool, supplier_hash: &str) -> Result<History, CheckError> {
    let last = sqlx::query(
        "SELECT name_hash, email_domain_hash, phone_hash, postal_hash FROM invoices
         WHERE supplier_hash = $1 AND final_decision = 'approved'
         ORDER BY issue_date DESC, created_at DESC LIMIT 1",
    )
    .bind(supplier_hash)
    .fetch_optional(pool)
    .await?;
    let last_approved = match last {
        Some(row) => Some(LastApproved {
            name_hash: row.try_get("name_hash")?,
            email_domain_hash: row.try_get("email_domain_hash")?,
            phone_hash: row.try_get("phone_hash")?,
            postal_hash: row.try_get("postal_hash")?,
        }),
        None => None,
    };
    let previous_invoice_count =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invoices WHERE supplier_hash = $1")
            .bind(supplier_hash)
            .fetch_one(pool)
            .await?;
    let approved_eur_amounts = sqlx::query_scalar::<_, Decimal>(
        "SELECT amount FROM invoices
         WHERE supplier_hash = $1 AND final_decision = 'approved' AND currency = 'EUR'",
    )
    .bind(supplier_hash)
    .fetch_all(pool)
    .await?;
    Ok(History {
        last_approved,
        previous_invoice_count,
        approved_eur_amounts,
    })
}

fn network_str(n: Network) -> &'static str {
    match n {
        Network::Preprod => "preprod",
        Network::Mainnet => "mainnet",
    }
}

/// `<asset>` of BT-82 when it matches the I-11 pattern (spec 4 `payment.asset`).
fn bt82_asset(info: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^cardano:(preprod|mainnet):(ADA|[0-9a-f]{56}(\.[0-9a-f]{0,64})?)$")
            .expect("valid regex")
    });
    re.captures(info).map(|c| c[2].to_string())
}

fn amount(value: Option<Decimal>, currency: Option<&str>) -> Option<Amount> {
    Some(Amount {
        amount: value?,
        currency: currency?.to_string(),
    })
}

fn is_known(s: Option<&Subject>) -> bool {
    s.is_some_and(|s| s.approved >= 1)
}

fn is_blocked(s: Option<&Subject>) -> bool {
    s.is_some_and(|s| s.status == SubjectStatus::Blocked)
}

/// Step 11: result JSON (spec 4).
fn build_result(
    state: &AppState,
    input: &Input<'_>,
    ctx: &CheckContext<'_>,
    o: &ScoreOutcome,
    checks_skipped: Vec<SkippedCheck>,
) -> CheckResult {
    let h = &ctx.hashes;
    let valid_address = match &ctx.address {
        Some(Ok(a)) => Some(a),
        _ => None,
    };

    let invoice = input.invoice.map(|inv| InvoiceOut {
        invoice_hash: h.invoice.clone(),
        xml_ref: model::xml_ref(&input.check_id),
        profile: inv.profile.clone(),
        validation: ValidationOut::from(input.validation.expect("validated with invoice")),
        invoice_number: inv.invoice_number.clone(),
        type_code: inv.type_code.clone(),
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        total: amount(inv.grand_total, inv.currency.as_deref()),
        due_payable: amount(inv.due_payable, inv.currency.as_deref()),
        payment: PaymentOut {
            means_code: inv.payment_means_code.clone(),
            network: valid_address.map(|_| network_str(input.network).to_string()),
            asset: inv.payment_info.as_deref().and_then(bt82_asset),
            address_type: valid_address.map(|a| a.address_type.as_str().to_string()),
            credential_type: valid_address.map(|a| a.credential_type.as_str().to_string()),
            address_hash: h.address.clone(),
            wallet_hash: h.wallet.clone(),
        },
        order_reference: inv.order_reference.clone(),
        open_order: criteria::matched_open_order(ctx).map(OpenOrderOut::from),
    });

    let supplier = h.supplier.clone().map(|supplier_hash| {
        let s = ctx.supplier.as_ref();
        let vat = input
            .invoice
            .and_then(|i| i.seller_vat_id.as_deref())
            .map(normalize::vat)
            .unwrap_or_default();
        SupplierOut {
            supplier_hash,
            country: input.invoice.and_then(|i| i.seller_country.clone()),
            vat_country: vat.chars().take(2).collect(),
            vat_valid: ctx.vies.ok().copied(),
            known: is_known(s),
            approved: s.map_or(0, |s| s.approved),
            trust: s.map_or(Decimal::ZERO, |s| s.trust),
            blocked: is_blocked(s),
            first_invoice: (!o.ko_triggered).then_some(ctx.previous_invoice_count == 0),
        }
    });

    let wallet = h.wallet.clone().map(|wallet_hash| {
        let s = ctx.wallet.as_ref();
        let first = ctx.blockfrost.ok().copied();
        let first_tx = first.flatten();
        WalletOut {
            wallet_hash,
            known: is_known(s),
            approved: s.map_or(0, |s| s.approved),
            rejected_risk: s.map_or(0, |s| s.rejected_risk),
            trust: s.map_or(Decimal::ZERO, |s| s.trust),
            blocked: is_blocked(s),
            has_transactions: first.map(|f| f.is_some()),
            first_tx_at: first_tx.and_then(|t| DateTime::from_timestamp(t, 0)),
            age_days: first_tx.map(|t| age_days(input.checked_at.timestamp(), t)),
            chainabuse: ctx.chainabuse.ok().map(chainabuse_out),
        }
    });

    let pair = h.pair.clone().map(|pair_hash| {
        let s = ctx.pair.as_ref();
        PairOut {
            pair_hash,
            approved: s.map_or(0, |s| s.approved),
            rejected_risk: s.map_or(0, |s| s.rejected_risk),
        }
    });

    CheckResult {
        schema_version: model::SCHEMA_VERSION.to_string(),
        check_id: input.check_id.clone(),
        checked_at: input.checked_at,
        engine: Engine::new(state.config_sha256.as_ref()),
        summary: Summary {
            band: o.band,
            decision: o.decision,
            is_final: o.is_final,
            reason_type: o.reason_type,
            risk_score: o.risk_score,
            ko_triggered: o.ko_triggered,
            decline_reasons: o.decline_reasons.clone(),
            checks_incomplete: o.checks_incomplete.clone(),
            checks_skipped,
        },
        invoice,
        supplier,
        wallet,
        pair,
        signature: input
            .invoice
            .map(|inv| Signature::unverified(inv.has_signature())),
        criteria: o.criteria.clone(),
        reducers: o.reducers.clone(),
        agent_tasks: o.agent_tasks.clone(),
    }
}

fn chainabuse_out(v: &ChainabuseValue) -> ChainabuseOut {
    ChainabuseOut {
        reports: u32::try_from(v.reports).unwrap_or(u32::MAX),
        trusted_or_checked: u32::try_from(v.trusted_or_checked).unwrap_or(u32::MAX),
    }
}

/// Columns of a new `invoices` row (3.5 step 12).
struct InvoiceInsert<'a> {
    invoice_hash: &'a str,
    supplier_hash: &'a str,
    wallet_hash: &'a str,
    pair_hash: &'a str,
    name_hash: &'a str,
    amount: Decimal,
    currency: &'a str,
    issue_date: NaiveDate,
    type_code: &'a str,
}

impl<'a> InvoiceInsert<'a> {
    /// All NOT NULL columns; `None` if one is missing (then no row is written).
    fn from_ctx(ctx: &'a CheckContext<'_>) -> Option<Self> {
        let h = &ctx.hashes;
        let inv = ctx.invoice?;
        Some(Self {
            invoice_hash: h.invoice.as_deref()?,
            supplier_hash: h.supplier.as_deref()?,
            wallet_hash: h.wallet.as_deref()?,
            pair_hash: h.pair.as_deref()?,
            name_hash: h.name.as_deref()?,
            amount: inv.grand_total?,
            currency: inv.currency.as_deref()?,
            issue_date: inv.issue_date?,
            type_code: inv.type_code.as_deref()?,
        })
    }
}

const INSERT_CHECK_SQL: &str =
    "INSERT INTO checks (check_id, band, result) VALUES ($1, $2, $3::text::jsonb)";

const INSERT_INVOICE_SQL: &str = "\
INSERT INTO invoices (invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash, name_hash,
  email_domain_hash, phone_hash, postal_hash, amount, currency, issue_date, type_code,
  initial_band, initial_score, final_decision, final_reason_type, final_block_wallet,
  final_decline_reasons, decided_by, decided_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
  $19::text::jsonb, $20, $21)";

/// Step 12 (FR-60, FR-61, FR-62, FR-63): one transaction; XML into Redis before the
/// commit; on a Redis or commit failure nothing stays stored and the key is deleted.
async fn store(
    state: &AppState,
    input: &Input<'_>,
    ctx: &CheckContext<'_>,
    o: &ScoreOutcome,
    result: &CheckResult,
) -> Result<(), CheckError> {
    let result_json = serde_json::to_string(result).map_err(|_| {
        tracing::error!(check_id = %input.check_id, "result serialization failed");
        CheckError::DependencyUnavailable
    })?;

    let insert = InvoiceInsert::from_ctx(ctx);
    let row = o.invoice_row(insert.is_some());

    let mut tx = state.pool.begin().await?;
    sqlx::query(INSERT_CHECK_SQL)
        .bind(&input.check_id)
        .bind(o.band.as_str())
        .bind(&result_json)
        .execute(&mut *tx)
        .await?;

    if let (
        InvoiceRow::Insert {
            final_decision,
            final_reason_type,
        },
        Some(ins),
    ) = (row, insert)
    {
        let automatic = final_decision.is_some();
        let decline_reasons = match final_decision {
            Some(FinalDecision::Rejected) => Some(
                serde_json::to_string(&o.decline_reasons)
                    .map_err(|_| CheckError::DependencyUnavailable)?,
            ),
            _ => None,
        };
        let h = &ctx.hashes;
        sqlx::query(INSERT_INVOICE_SQL)
            .bind(ins.invoice_hash)
            .bind(&input.check_id)
            .bind(ins.supplier_hash)
            .bind(ins.wallet_hash)
            .bind(ins.pair_hash)
            .bind(ins.name_hash)
            .bind(h.email_domain.as_deref())
            .bind(h.phone.as_deref())
            .bind(h.postal.as_deref())
            .bind(ins.amount)
            .bind(ins.currency)
            .bind(ins.issue_date)
            .bind(ins.type_code)
            .bind(o.band.as_str())
            .bind(o.risk_score)
            .bind(final_decision.map(FinalDecision::as_str))
            .bind(final_reason_type.map(ReasonType::as_str))
            .bind(automatic.then_some(false))
            .bind(decline_reasons)
            .bind(automatic.then_some(DecidedBy::InitialCheck.as_str()))
            .bind(automatic.then_some(input.checked_at))
            .execute(&mut *tx)
            .await?;

        // Counters (5.4).
        match (final_decision, final_reason_type) {
            (Some(FinalDecision::Approved), _) => {
                postgres::approve_subject(&mut *tx, ins.wallet_hash, SubjectType::Wallet).await?;
                postgres::approve_subject(&mut *tx, ins.supplier_hash, SubjectType::Supplier)
                    .await?;
                postgres::approve_subject(&mut *tx, ins.pair_hash, SubjectType::Pair).await?;
            }
            (Some(FinalDecision::Rejected), Some(ReasonType::Risk)) => {
                postgres::reject_risk_subject(&mut *tx, ins.wallet_hash, SubjectType::Wallet)
                    .await?;
                postgres::reject_risk_subject(&mut *tx, ins.pair_hash, SubjectType::Pair).await?;
            }
            _ => {}
        }
    }

    let mut conn = state.redis.clone();
    if let Err(e) = rstore::put_xml(
        &mut conn,
        &input.check_id,
        input.stored_xml,
        state.env.xml_ttl_seconds,
    )
    .await
    {
        tracing::error!(check_id = %input.check_id, error_kind = ?e.kind(), "storing XML failed; rolling back");
        // Dropping `tx` rolls back; remove a key that may have been written anyway.
        drop(tx);
        let _ = rstore::del_xml(&mut conn, &input.check_id).await;
        return Err(CheckError::DependencyUnavailable);
    }

    if let Err(e) = tx.commit().await {
        tracing::error!(check_id = %input.check_id, error_kind = db_error_kind(&e), "commit failed");
        if let Err(e) = rstore::del_xml(&mut conn, &input.check_id).await {
            tracing::error!(check_id = %input.check_id, error_kind = ?e.kind(), "deleting XML after failed commit failed");
        }
        return Err(CheckError::DependencyUnavailable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_id_format() {
        let id = new_check_id();
        assert!(id.starts_with("chk_"));
        let ulid = &id[4..];
        assert_eq!(ulid.len(), 26);
        assert!(ulid
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()));
        assert!(!ulid.contains(['I', 'L', 'O', 'U']));
    }

    #[test]
    fn bt82_asset_pattern() {
        assert_eq!(bt82_asset("cardano:preprod:ADA").as_deref(), Some("ADA"));
        let policy = "a".repeat(56);
        assert_eq!(
            bt82_asset(&format!("cardano:mainnet:{policy}.0a")),
            Some(format!("{policy}.0a"))
        );
        assert_eq!(bt82_asset("cardano:preview:ADA"), None);
        assert_eq!(bt82_asset("cardano:preprod:ada"), None);
    }
}
