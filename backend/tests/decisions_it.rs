//! `POST /v1/decisions` logic (spec 5.4) against real Postgres.
//!
//! Gated by `SNIFFER_IT_DATABASE_URL`; each test prints a note and passes when it is
//! unset. Every test drops schema `sniffer`, so the URL must point at a database used
//! only by these tests. Tests share that database and run one at a time.

use rust_decimal::Decimal;
use sniffer::decisions::{decide, DecisionError};
use sniffer::model::{DecidedBy, DecisionRequest, DeclineReasonInput, FinalDecision, ReasonType};
use sniffer::store::postgres::{self, BlockSource, SubjectType};
use sqlx::{Connection, PgConnection, PgPool, Row};
use tokio::sync::{Mutex, MutexGuard};

const A: &str = "hmac:supplier-A";
const W1: &str = "hmac:wallet-W1";
const W2: &str = "hmac:wallet-W2";
const PAIR_A_W1: &str = "hmac:pair-A-W1";
const PAIR_A_W2: &str = "hmac:pair-A-W2";

/// Check from test 9 (Medium, A with new wallet W2).
const MEDIUM: &str = "chk_01MEDIUM0000000000000000000";
/// Check from test 1 (Low, approved automatically).
const LOW: &str = "chk_01LOW000000000000000000000";

static DB_LOCK: Mutex<()> = Mutex::const_new(());

struct Db {
    pool: PgPool,
    _guard: MutexGuard<'static, ()>,
}

/// Fresh schema plus the subjects of seed 7.5 that matter here (A, W1, A/W1 approved 6)
/// and two `invoices` rows: Medium pending (A/W2) and Low approved (A/W1).
async fn setup() -> Option<Db> {
    let url = match std::env::var("SNIFFER_IT_DATABASE_URL") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            println!("skipping: SNIFFER_IT_DATABASE_URL not set");
            return None;
        }
    };
    let guard = DB_LOCK.lock().await;

    let mut conn = PgConnection::connect(&url).await.expect("plain connect");
    sqlx::raw_sql("DROP SCHEMA IF EXISTS sniffer CASCADE")
        .execute(&mut conn)
        .await
        .expect("drop schema");
    conn.close().await.expect("close");

    let pool = postgres::connect(&url).await.expect("connect");
    postgres::migrate(&pool).await.expect("migrate");

    for (hash, t) in [
        (A, SubjectType::Supplier),
        (W1, SubjectType::Wallet),
        (PAIR_A_W1, SubjectType::Pair),
    ] {
        for _ in 0..6 {
            postgres::approve_subject(&pool, hash, t).await.unwrap();
        }
    }
    insert_invoice(&pool, "inv-medium", MEDIUM, W2, PAIR_A_W2, "medium").await;
    insert_invoice(&pool, "inv-low", LOW, W1, PAIR_A_W1, "low").await;
    sqlx::query(
        "UPDATE invoices SET final_decision = 'approved', final_block_wallet = false,
                decided_by = 'initial_check', decided_at = now()
         WHERE check_id = $1",
    )
    .bind(LOW)
    .execute(&pool)
    .await
    .unwrap();

    Some(Db {
        pool,
        _guard: guard,
    })
}

async fn insert_invoice(
    pool: &PgPool,
    invoice_hash: &str,
    check_id: &str,
    wallet: &str,
    pair: &str,
    band: &str,
) {
    sqlx::query(
        "INSERT INTO invoices (invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash,
                               name_hash, amount, currency, issue_date, type_code,
                               initial_band, initial_score)
         VALUES ($1, $2, $3, $4, $5, 'hmac:name-A', 1250.00, 'EUR', DATE '2026-10-28', '380',
                 $6, $7)",
    )
    .bind(invoice_hash)
    .bind(check_id)
    .bind(A)
    .bind(wallet)
    .bind(pair)
    .bind(band)
    .bind(if band == "medium" { 58 } else { 0 })
    .execute(pool)
    .await
    .unwrap();
}

fn reason(id: &str, text: &str, evidence: &str) -> DeclineReasonInput {
    DeclineReasonInput {
        id: id.into(),
        text: text.into(),
        evidence: evidence.into(),
    }
}

fn approved(check_id: &str) -> DecisionRequest {
    DecisionRequest {
        check_id: check_id.into(),
        decision: FinalDecision::Approved,
        reason_type: None,
        block_wallet: false,
        decline_reasons: vec![],
    }
}

fn rejected(check_id: &str, reason_type: ReasonType, block_wallet: bool) -> DecisionRequest {
    DecisionRequest {
        check_id: check_id.into(),
        decision: FinalDecision::Rejected,
        reason_type: Some(reason_type),
        block_wallet,
        decline_reasons: vec![reason(
            "S-3",
            "Die Zahlungsadresse weicht von allen bisherigen Rechnungen dieses Rechnungsstellers ab.",
            "supplier approved 6x, never with this wallet",
        )],
    }
}

#[derive(Debug, PartialEq)]
struct SubjectRow {
    approved: i32,
    rejected_risk: i32,
    trust: Decimal,
    status: String,
    block_source: Option<String>,
    block_reason: Option<String>,
}

async fn subject(pool: &PgPool, hash: &str) -> Option<SubjectRow> {
    sqlx::query(
        "SELECT approved, rejected_risk, trust, status, block_source, block_reason
         FROM subjects WHERE hash = $1",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|r| SubjectRow {
        approved: r.get("approved"),
        rejected_risk: r.get("rejected_risk"),
        trust: r.get("trust"),
        status: r.get("status"),
        block_source: r.get("block_source"),
        block_reason: r.get("block_reason"),
    })
}

async fn counts(pool: &PgPool, hash: &str) -> Option<(i32, i32)> {
    subject(pool, hash)
        .await
        .map(|s| (s.approved, s.rejected_risk))
}

async fn all_subjects(pool: &PgPool) -> Vec<(String, i32, i32, String)> {
    sqlx::query_as("SELECT hash, approved, rejected_risk, status FROM subjects ORDER BY hash")
        .fetch_all(pool)
        .await
        .unwrap()
}

type DecisionCols = (
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<serde_json::Value>,
    Option<String>,
    bool,
);

async fn decision_cols(pool: &PgPool, check_id: &str) -> DecisionCols {
    sqlx::query_as(
        "SELECT final_decision, final_reason_type, final_block_wallet, final_decline_reasons,
                decided_by, decided_at IS NOT NULL
         FROM invoices WHERE check_id = $1",
    )
    .bind(check_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn d(s: &str) -> Decimal {
    s.parse().unwrap()
}

/// Spec 8.3 test 26 (a)–(g), in order on one database.
#[tokio::test]
async fn test26_decision_sequence() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;
    let a_before = subject(pool, A).await.unwrap();

    // (a) rejected without decline_reasons → 400, nothing changes.
    let mut req = rejected(MEDIUM, ReasonType::Risk, false);
    req.decline_reasons.clear();
    assert!(matches!(
        decide(pool, &req).await,
        Err(DecisionError::Invalid(_))
    ));
    assert_eq!(decision_cols(pool, MEDIUM).await.0, None);

    // (b) rejected/risk with block_wallet → 200.
    let req = rejected(MEDIUM, ReasonType::Risk, true);
    let first = decide(pool, &req).await.expect("decision b");
    assert_eq!(first.check_id, MEDIUM);
    assert_eq!(first.final_decision, FinalDecision::Rejected);
    assert_eq!(first.final_reason_type, Some(ReasonType::Risk));
    assert_eq!(first.decided_by, DecidedBy::Agents);
    assert_eq!(first.decided_at.timestamp_subsec_nanos(), 0);
    let json = serde_json::to_value(&first).unwrap();
    let at = json["decided_at"].as_str().unwrap();
    assert!(at.ends_with('Z') && at.len() == 20, "decided_at {at}");

    let w2 = subject(pool, W2).await.expect("W2 row");
    assert_eq!(w2.status, "blocked");
    assert_eq!(w2.block_source.as_deref(), Some("internal"));
    assert_eq!(w2.block_reason.as_deref(), Some("AGENT_DECISION"));
    assert_eq!((w2.approved, w2.rejected_risk), (0, 1));
    assert_eq!(w2.trust, d("-0.500"));
    assert_eq!(counts(pool, PAIR_A_W2).await, Some((0, 1)));
    assert_eq!(subject(pool, A).await.unwrap(), a_before, "A unchanged");

    let cols = decision_cols(pool, MEDIUM).await;
    assert_eq!(cols.0.as_deref(), Some("rejected"));
    assert_eq!(cols.1.as_deref(), Some("risk"));
    assert_eq!(cols.2, Some(true));
    assert_eq!(
        cols.3,
        Some(serde_json::json!([{
            "id": "S-3",
            "text": "Die Zahlungsadresse weicht von allen bisherigen Rechnungen dieses Rechnungsstellers ab.",
            "evidence": "supplier approved 6x, never with this wallet"
        }]))
    );
    assert_eq!(cols.4.as_deref(), Some("agents"));
    assert!(cols.5);
    let subjects_after_b = all_subjects(pool).await;

    // (c) b repeated → 200 with the same content, counters unchanged.
    let again = decide(pool, &req).await.expect("decision c");
    assert_eq!(again, first);
    assert_eq!(all_subjects(pool).await, subjects_after_b);

    // (d) approved afterwards → 409 already_decided.
    assert!(matches!(
        decide(pool, &approved(MEDIUM)).await,
        Err(DecisionError::AlreadyDecided)
    ));
    // Any other difference is a conflict too.
    let mut changed = req.clone();
    changed.block_wallet = false;
    assert!(matches!(
        decide(pool, &changed).await,
        Err(DecisionError::AlreadyDecided)
    ));
    let mut changed = req.clone();
    changed.decline_reasons[0].evidence = "other".into();
    assert!(matches!(
        decide(pool, &changed).await,
        Err(DecisionError::AlreadyDecided)
    ));
    assert_eq!(all_subjects(pool).await, subjects_after_b);

    // (e) the Low check from test 1 → 409 not_pending.
    assert!(matches!(
        decide(pool, &approved(LOW)).await,
        Err(DecisionError::NotPending)
    ));

    // (f) reason text with "Betrug" → 400 forbidden_wording.
    let mut req = rejected(MEDIUM, ReasonType::Risk, false);
    req.decline_reasons[0].text = "Verdacht auf Betrug".into();
    assert!(matches!(
        decide(pool, &req).await,
        Err(DecisionError::ForbiddenWording)
    ));

    // (g) unknown check_id → 404.
    assert!(matches!(
        decide(pool, &approved("chk_01UNKNOWN00000000000000000")).await,
        Err(DecisionError::NotFound)
    ));
    assert_eq!(all_subjects(pool).await, subjects_after_b);
}

/// Spec 8.3 test 13: approving the Medium check counts for wallet, pair and supplier.
#[tokio::test]
async fn test13_approval_increments_wallet_pair_supplier() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;

    let resp = decide(pool, &approved(MEDIUM)).await.expect("approve");
    assert_eq!(resp.final_decision, FinalDecision::Approved);
    assert_eq!(resp.final_reason_type, None);
    assert_eq!(resp.decided_by, DecidedBy::Agents);

    let a = subject(pool, A).await.unwrap();
    assert_eq!((a.approved, a.rejected_risk), (7, 0));
    assert_eq!(a.trust, postgres::trust_value(7, 0));
    let w2 = subject(pool, W2).await.unwrap();
    assert_eq!((w2.approved, w2.rejected_risk), (1, 0));
    assert_eq!(w2.trust, d("0.167"));
    assert_eq!(w2.status, "normal");
    assert_eq!(counts(pool, PAIR_A_W2).await, Some((1, 0)));
    // Unrelated subjects stay as they were.
    assert_eq!(counts(pool, W1).await, Some((6, 0)));
    assert_eq!(counts(pool, PAIR_A_W1).await, Some((6, 0)));

    let cols = decision_cols(pool, MEDIUM).await;
    assert_eq!(
        cols,
        (
            Some("approved".into()),
            None,
            Some(false),
            None,
            Some("agents".into()),
            true
        )
    );

    // Equal repeat (reason_type null, decline_reasons empty) is idempotent.
    let again = decide(pool, &approved(MEDIUM)).await.expect("repeat");
    assert_eq!(again, resp);
    assert_eq!(counts(pool, A).await, Some((7, 0)));
    assert_eq!(counts(pool, W2).await, Some((1, 0)));
    assert!(matches!(
        decide(pool, &rejected(MEDIUM, ReasonType::Formal, false)).await,
        Err(DecisionError::AlreadyDecided)
    ));
}

#[tokio::test]
async fn formal_rejection_changes_no_counters() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;
    let before = all_subjects(pool).await;

    let resp = decide(pool, &rejected(MEDIUM, ReasonType::Formal, false))
        .await
        .expect("formal");
    assert_eq!(resp.final_decision, FinalDecision::Rejected);
    assert_eq!(resp.final_reason_type, Some(ReasonType::Formal));
    assert_eq!(all_subjects(pool).await, before);
    assert_eq!(subject(pool, W2).await, None);

    let cols = decision_cols(pool, MEDIUM).await;
    assert_eq!(cols.1.as_deref(), Some("formal"));
    assert_eq!(cols.2, Some(false));
    assert!(cols.3.is_some());

    // block_wallet with formal is invalid.
    assert!(matches!(
        decide(pool, &rejected(MEDIUM, ReasonType::Formal, true)).await,
        Err(DecisionError::Invalid(_))
    ));
}

#[tokio::test]
async fn risk_without_block_counts_but_does_not_block() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;

    decide(pool, &rejected(MEDIUM, ReasonType::Risk, false))
        .await
        .expect("risk");
    let w2 = subject(pool, W2).await.unwrap();
    assert_eq!((w2.approved, w2.rejected_risk), (0, 1));
    assert_eq!(w2.status, "normal");
    assert_eq!(w2.block_source, None);
    assert_eq!(counts(pool, PAIR_A_W2).await, Some((0, 1)));
    assert_eq!(counts(pool, A).await, Some((6, 0)));
}

#[tokio::test]
async fn ofac_block_is_kept_on_agent_block() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;
    postgres::block_subject(
        pool,
        W2,
        SubjectType::Wallet,
        BlockSource::Ofac,
        "SDN-12345",
    )
    .await
    .unwrap();

    decide(pool, &rejected(MEDIUM, ReasonType::Risk, true))
        .await
        .expect("risk + block");
    let w2 = subject(pool, W2).await.unwrap();
    assert_eq!(w2.status, "blocked");
    assert_eq!(w2.block_source.as_deref(), Some("OFAC"));
    assert_eq!(w2.block_reason.as_deref(), Some("SDN-12345"));
    assert_eq!(w2.rejected_risk, 1);
}

#[tokio::test]
async fn high_band_is_not_pending() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;
    insert_invoice(
        pool,
        "inv-high",
        "chk_01HIGH0000000000000000000",
        W2,
        PAIR_A_W2,
        "high",
    )
    .await;
    assert!(matches!(
        decide(
            pool,
            &rejected("chk_01HIGH0000000000000000000", ReasonType::Risk, false)
        )
        .await,
        Err(DecisionError::NotPending)
    ));
}

/// Concurrent decisions serialize on the row lock: an equal pair counts once, a
/// different pair yields one success and one `already_decided`.
#[tokio::test]
async fn concurrent_decisions_serialize_on_row_lock() {
    let Some(db) = setup().await else { return };
    let pool = &db.pool;

    let req = approved(MEDIUM);
    let (r1, r2) = tokio::join!(decide(pool, &req), decide(pool, &req));
    assert_eq!(r1.expect("first"), r2.expect("second"));
    assert_eq!(counts(pool, A).await, Some((7, 0)));
    assert_eq!(counts(pool, W2).await, Some((1, 0)));
    assert_eq!(counts(pool, PAIR_A_W2).await, Some((1, 0)));

    insert_invoice(
        pool,
        "inv-medium-2",
        "chk_01MEDIUM2000000000000000000",
        W1,
        PAIR_A_W1,
        "medium",
    )
    .await;
    let ok = approved("chk_01MEDIUM2000000000000000000");
    let conflict = rejected("chk_01MEDIUM2000000000000000000", ReasonType::Formal, false);
    let (r1, r2) = tokio::join!(decide(pool, &ok), decide(pool, &conflict));
    let oks = [r1.is_ok(), r2.is_ok()].iter().filter(|b| **b).count();
    assert_eq!(oks, 1, "exactly one decision wins: {r1:?} {r2:?}");
    assert!(
        matches!(r1, Err(DecisionError::AlreadyDecided))
            || matches!(r2, Err(DecisionError::AlreadyDecided))
    );
}
