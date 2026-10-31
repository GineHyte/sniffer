//! Spec 12.4-12.9 / tests P1-P10: payout policy, intents ledger, state machine and the
//! Blockfrost confirmation against the real router, Postgres and Redis. Harness and
//! environment: see `common/mod.rs` (gated by `SNIFFER_IT_DATABASE_URL`; this file is
//! meant to run with Redis index 10).

mod common;

use reqwest::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

use common::*;
use sniffer::store::postgres::{self, BlockSource, SubjectType};
use sniffer::store::redis as rstore;

const RATE: &str = "0.040000";
/// `floor(1190.00 * 0.040000 * 1_000_000)` (12.9).
const F1_LOVELACE: i64 = 47_600_000;
const AUTHORIZE: &str = "/v1/payouts/authorize";

fn tx(c: char) -> String {
    c.to_string().repeat(64)
}

/// Harness with `ADA_PER_EUR=0.040000`, default caps and the extra variables.
async fn payout_harness(extra: &[(&'static str, &str)]) -> Option<Harness> {
    let mut env = vec![("ADA_PER_EUR", RATE.to_string())];
    env.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    harness_with(Options {
        env,
        ..Options::default()
    })
    .await
}

/// Runs a check that must end Low (auto-approved) and returns its `check_id`.
async fn low_check(h: &Harness, xml: &str) -> String {
    let r = h.check_ok(xml).await;
    assert_eq!(band(&r), "low", "{r}");
    check_id(&r)
}

async fn authorize(h: &Harness, check_id: &str) -> Resp {
    h.post(AUTHORIZE, &json!({ "check_id": check_id })).await
}

async fn authorize_ok(h: &Harness, check_id: &str) -> Value {
    let r = authorize(h, check_id).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    r.body
}

async fn step(h: &Harness, payout_id: &str, action: &str) -> Resp {
    h.post(&format!("/v1/payouts/{payout_id}/{action}"), &json!({}))
        .await
}

async fn submitted(h: &Harness, payout_id: &str, tx_hash: &str) -> Resp {
    h.post(
        &format!("/v1/payouts/{payout_id}/submitted"),
        &json!({ "tx_hash": tx_hash }),
    )
    .await
}

#[track_caller]
fn assert_error(r: &Resp, status: StatusCode, code: &str) {
    assert_eq!(r.status, status, "{}", r.text);
    assert_eq!(r.body["error"], code, "{}", r.text);
    assert!(r.body["message"].is_string());
}

#[track_caller]
fn assert_conflict(r: &Resp, code: &str) {
    assert_error(r, StatusCode::CONFLICT, code);
}

#[track_caller]
fn assert_state(r: &Resp, state: &str) {
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["state"], state, "{}", r.text);
}

fn payout_id(v: &Value) -> String {
    v["payout_id"].as_str().unwrap().to_string()
}

async fn intents(h: &Harness) -> i64 {
    h.count("SELECT count(*) FROM payout_intents").await
}

async fn db_state(h: &Harness, payout_id: &str) -> String {
    sqlx::query_scalar("SELECT state FROM payout_intents WHERE payout_id = $1")
        .bind(payout_id)
        .fetch_one(&h.pool)
        .await
        .unwrap()
}

/// `sniffer blocklist-add --type wallet --value <addr> --reason <reason>` (7.1).
async fn block_wallet(h: &Harness, address: &str, reason: &str) {
    postgres::block_subject(
        &h.pool,
        &wallet_hash(address),
        SubjectType::Wallet,
        BlockSource::Internal,
        reason,
    )
    .await
    .unwrap();
}

/// F1 as a second, different invoice (BT-1 changed; Low per 12.9 P7).
fn f1_numbered(number: &str) -> String {
    sub(&f1(), "RE-2026-0412", number)
}

/// Blockfrost `/txs/{hash}/utxos` body with one output.
fn utxos(tx_hash: &str, address: &str, quantity: &str) -> Value {
    json!({
        "hash": tx_hash,
        "inputs": [],
        "outputs": [
            { "address": W3, "amount": [{ "unit": "lovelace", "quantity": "999999999" }],
              "output_index": 0, "data_hash": null },
            { "address": address,
              "amount": [
                  { "unit": "lovelace", "quantity": quantity },
                  { "unit": "abcd", "quantity": "1" }
              ],
              "output_index": 1, "data_hash": null }
        ]
    })
}

fn utxo_stub(tx_hash: &str, resp: ResponseTemplate) -> Mock {
    Mock::given(method("GET"))
        .and(path(format!("/bf/txs/{tx_hash}/utxos")))
        .and(header("project_id", "preprodTEST"))
        .respond_with(resp)
}

/// Authorize -> submitting -> submitted(tx_hash) for a fresh Low F1 variant.
async fn submitted_intent(h: &Harness, xml: &str, tx_hash: &str) -> String {
    let id = low_check(h, xml).await;
    let p = payout_id(&authorize_ok(h, &id).await);
    assert_state(&step(h, &p, "submitting").await, "submitting");
    assert_state(&submitted(h, &p, tx_hash).await, "submitted");
    p
}

// ---------------------------------------------------------------------------
// Rule 1-8
// ---------------------------------------------------------------------------

/// P1 (rule 1): open Medium and rejected High checks, and an unknown check_id.
#[tokio::test]
async fn p1_not_approved() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let medium = h.check_ok(&fixture("f9.xml")).await;
    assert_eq!(band(&medium), "medium");
    let high = h.check_ok(&fixture("f10.xml")).await;
    assert_eq!(band(&high), "high");
    for id in [
        check_id(&medium),
        check_id(&high),
        "chk_01UNKNOWN000000000000000000".to_string(),
    ] {
        assert_conflict(&authorize(&h, &id).await, "not_approved");
    }
    assert_eq!(intents(&h).await, 0);
}

/// P2 (rule 2): a USD invoice approved by `POST /v1/decisions`.
#[tokio::test]
async fn p2_currency_not_supported() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let xml = sub(
        &sub(
            &f1(),
            "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
            "<ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
        ),
        r#"currencyID="EUR""#,
        r#"currencyID="USD""#,
    );
    let r = h.check_ok(&xml).await;
    assert_eq!(band(&r), "medium", "{r}");
    let id = check_id(&r);
    let d = h
        .post(
            "/v1/decisions",
            &json!({ "check_id": id, "decision": "approved" }),
        )
        .await;
    assert_eq!(d.status, StatusCode::OK, "{}", d.text);
    assert_conflict(&authorize(&h, &id).await, "currency_not_supported");
    assert_eq!(intents(&h).await, 0);
}

/// P3 (rule 3) and P6 (a): the intent view, idempotency in every state.
#[tokio::test]
async fn p3_idempotent_on_invoice_hash() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    let first = authorize_ok(&h, &id).await;
    let p = payout_id(&first);
    assert!(p.starts_with("pay_") && p.len() == 30, "{p}");
    assert!(p[4..]
        .bytes()
        .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()));
    assert_eq!(
        first,
        json!({
            "payout_id": p, "check_id": id, "state": "authorized", "to_address": W1,
            "amount_eur": "1190.00", "ada_per_eur": "0.040000", "lovelace": F1_LOVELACE,
            "tx_hash": null
        })
    );
    assert_eq!(authorize_ok(&h, &id).await, first);

    assert_state(&step(&h, &p, "failed").await, "failed");
    let again = authorize_ok(&h, &id).await;
    assert_eq!(payout_id(&again), p);
    assert_eq!(again["state"], "failed");
    assert_eq!(intents(&h).await, 1);

    let row: (String, String, String, String, i64) = sqlx::query_as(
        "SELECT invoice_hash, wallet_hash, amount_eur::text, ada_per_eur::text, lovelace
         FROM payout_intents WHERE payout_id = $1",
    )
    .bind(&p)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let invoice_hash: String =
        sqlx::query_scalar("SELECT invoice_hash FROM invoices WHERE check_id = $1")
            .bind(&id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        row,
        (
            invoice_hash,
            wallet_hash(W1),
            "1190.00".into(),
            "0.040000".into(),
            F1_LOVELACE
        )
    );
}

/// P4 (rule 4): the wallet is blocked after the approval; `/submitting` re-checks it.
#[tokio::test]
async fn p4_wallet_blocked() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    block_wallet(&h, W1, "TEST_PAYOUT").await;
    assert_conflict(&authorize(&h, &id).await, "wallet_blocked");
    assert_eq!(intents(&h).await, 0);
}

#[tokio::test]
async fn p4_submitting_rechecks_wallet_block() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    let p = payout_id(&authorize_ok(&h, &id).await);
    block_wallet(&h, W1, "TEST_PAYOUT").await;
    assert_conflict(&step(&h, &p, "submitting").await, "wallet_blocked");
    assert_eq!(db_state(&h, &p).await, "authorized");
    // Rule 3 still answers with the existing intent.
    assert_eq!(payout_id(&authorize_ok(&h, &id).await), p);
}

/// P5 (rule 5): (a) the XML is gone; (b) it names another wallet; unreadable XML.
#[tokio::test]
async fn p5_xml_expired_and_recipient_mismatch() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let mut redis = h.redis.clone();

    let id = low_check(&h, &f1()).await;
    rstore::del_xml(&mut redis, &id).await.unwrap();
    assert_conflict(&authorize(&h, &id).await, "xml_expired");

    let id = low_check(&h, &f1_numbered("RE-2026-0413")).await;
    rstore::put_xml(&mut redis, &id, &with_address(&f1(), W2), 600)
        .await
        .unwrap();
    assert_conflict(&authorize(&h, &id).await, "recipient_mismatch");
    // A recipient that fails 3.4 (bad checksum) or an XML that does not parse.
    rstore::put_xml(&mut redis, &id, &with_address(&f1(), W1_BAD), 600)
        .await
        .unwrap();
    assert_conflict(&authorize(&h, &id).await, "recipient_mismatch");
    rstore::put_xml(&mut redis, &id, "<broken", 600)
        .await
        .unwrap();
    assert_conflict(&authorize(&h, &id).await, "recipient_mismatch");
    assert_eq!(intents(&h).await, 0);
}

/// P6 (b) (rule 6): 59.5 ADA > 50 ADA.
#[tokio::test]
async fn p6_over_invoice_cap() {
    let Some(h) = payout_harness(&[("ADA_PER_EUR", "0.050000")]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    assert_conflict(&authorize(&h, &id).await, "over_invoice_cap");
    assert_eq!(intents(&h).await, 0);
}

/// Rule 6: `lovelace = 0` -> `amount_zero` (BT-115 of the stored XML is 0.00).
#[tokio::test]
async fn p6_amount_zero() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    let zero = sub(
        &f1(),
        "<ram:DuePayableAmount>1190.00</ram:DuePayableAmount>",
        "<ram:DuePayableAmount>0.00</ram:DuePayableAmount>",
    );
    let mut redis = h.redis.clone();
    rstore::put_xml(&mut redis, &id, &zero, 600).await.unwrap();
    assert_conflict(&authorize(&h, &id).await, "amount_zero");
    assert_eq!(intents(&h).await, 0);
}

/// 12.3: without `ADA_PER_EUR` the endpoint answers 409 `payouts_disabled`.
#[tokio::test]
async fn payouts_disabled_without_rate() {
    let Some(h) = harness().await else { return };
    let id = low_check(&h, &f1()).await;
    assert_conflict(&authorize(&h, &id).await, "payouts_disabled");
    assert_eq!(intents(&h).await, 0);
}

/// P7 (rule 7): 47.6 + 47.6 = 95.2 ADA > 90 ADA; a failed intent no longer counts.
#[tokio::test]
async fn p7_over_daily_cap() {
    let Some(h) = payout_harness(&[("PAYOUT_MAX_ADA_PER_DAY", "90")]).await else {
        return;
    };
    let first = low_check(&h, &f1()).await;
    let second = low_check(&h, &f1_numbered("RE-2026-0413")).await;
    let p1 = payout_id(&authorize_ok(&h, &first).await);
    assert_conflict(&authorize(&h, &second).await, "over_daily_cap");
    assert_state(&step(&h, &p1, "failed").await, "failed");
    let p2 = authorize_ok(&h, &second).await;
    assert_eq!(p2["state"], "authorized");
    assert_eq!(p2["lovelace"], F1_LOVELACE);
    assert_eq!(intents(&h).await, 2);

    // Intents of an earlier UTC day do not count.
    sqlx::query("UPDATE payout_intents SET created_at = now() - interval '1 day'")
        .execute(&h.pool)
        .await
        .unwrap();
    let third = low_check(&h, &f1_numbered("RE-2026-0414")).await;
    assert_eq!(authorize_ok(&h, &third).await["state"], "authorized");
}

/// Rule 7 under concurrency: the advisory lock lets exactly one of two parallel
/// requests through when both together exceed the daily cap.
#[tokio::test]
async fn p7_daily_cap_holds_for_parallel_requests() {
    let Some(h) = payout_harness(&[("PAYOUT_MAX_ADA_PER_DAY", "90")]).await else {
        return;
    };
    let a = low_check(&h, &f1()).await;
    let b = low_check(&h, &f1_numbered("RE-2026-0413")).await;
    let (ra, rb) = tokio::join!(authorize(&h, &a), authorize(&h, &b));
    let mut statuses = [ra.status.as_u16(), rb.status.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{} / {}", ra.text, rb.text);
    let rejected = if ra.status == StatusCode::CONFLICT {
        &ra
    } else {
        &rb
    };
    assert_eq!(rejected.body["error"], "over_daily_cap");
    assert_eq!(intents(&h).await, 1);
}

/// P8 (rule 8): `EXPECTED_NETWORK=mainnet`.
#[tokio::test]
async fn p8_network_not_allowed() {
    let Some(h) = payout_harness(&[("EXPECTED_NETWORK", "mainnet")]).await else {
        return;
    };
    let id = low_check(&h, &with_address(&f1(), W1_MAIN)).await;
    assert_conflict(&authorize(&h, &id).await, "network_not_allowed");
    assert_eq!(intents(&h).await, 0);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

#[tokio::test]
async fn requests_need_token_and_valid_bodies() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    let p = payout_id(&authorize_ok(&h, &id).await);

    // FR-08 on every route.
    for route in [
        AUTHORIZE.to_string(),
        format!("/v1/payouts/{p}/submitting"),
        format!("/v1/payouts/{p}/submitted"),
        format!("/v1/payouts/{p}/confirm"),
        format!("/v1/payouts/{p}/failed"),
    ] {
        let body = br#"{"check_id":"x"}"#.to_vec();
        for token in [None, Some("wrong-token")] {
            let r = h
                .post_raw(&route, token, Some("application/json"), body.clone())
                .await;
            assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
        }
    }

    // 12.4: unknown fields or wrong types.
    for body in [
        json!({ "check_id": id, "extra": 1 }),
        json!({ "check_id": 5 }),
        json!({}),
    ] {
        assert_error(
            &h.post(AUTHORIZE, &body).await,
            StatusCode::BAD_REQUEST,
            "invalid_request",
        );
    }
    let r = h
        .post_raw(
            AUTHORIZE,
            Some(TOKEN),
            Some("application/json"),
            b"{nope".to_vec(),
        )
        .await;
    assert_error(&r, StatusCode::BAD_REQUEST, "invalid_request");
    let r = h
        .post_raw(AUTHORIZE, Some(TOKEN), Some("text/plain"), b"{}".to_vec())
        .await;
    assert_error(
        &r,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_media_type",
    );

    // 12.5: tx_hash format, unknown payout_id.
    assert_state(&step(&h, &p, "submitting").await, "submitting");
    for bad in [
        "AB".repeat(32),
        "ab".repeat(31),
        format!("{}g", "a".repeat(63)),
    ] {
        assert_error(
            &submitted(&h, &p, &bad).await,
            StatusCode::BAD_REQUEST,
            "invalid_request",
        );
    }
    assert_eq!(db_state(&h, &p).await, "submitting");
    let unknown = "pay_01UNKNOWN00000000000000000";
    for action in ["submitting", "confirm", "failed"] {
        assert_error(
            &step(&h, unknown, action).await,
            StatusCode::NOT_FOUND,
            "not_found",
        );
    }
    assert_error(
        &submitted(&h, unknown, &tx('a')).await,
        StatusCode::NOT_FOUND,
        "not_found",
    );
}

// ---------------------------------------------------------------------------
// State machine (P9)
// ---------------------------------------------------------------------------

/// P9, first run.
#[tokio::test]
async fn p9_state_transitions() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let id = low_check(&h, &f1()).await;
    let p = payout_id(&authorize_ok(&h, &id).await);

    assert_conflict(&submitted(&h, &p, &tx('a')).await, "invalid_state");
    assert_conflict(&step(&h, &p, "confirm").await, "invalid_state");
    assert_state(&step(&h, &p, "submitting").await, "submitting");
    assert_state(&step(&h, &p, "submitting").await, "submitting");
    assert_conflict(&step(&h, &p, "failed").await, "invalid_state");
    let r = submitted(&h, &p, &tx('a')).await;
    assert_state(&r, "submitted");
    assert_eq!(r.body["tx_hash"], tx('a'));
    assert_conflict(&step(&h, &p, "failed").await, "invalid_state");

    // Same tx_hash again is idempotent; another one is not allowed.
    assert_state(&submitted(&h, &p, &tx('a')).await, "submitted");
    assert_conflict(&submitted(&h, &p, &tx('b')).await, "invalid_state");
    assert_conflict(&step(&h, &p, "submitting").await, "invalid_state");

    let updated: bool = sqlx::query_scalar(
        "SELECT updated_at > created_at FROM payout_intents WHERE payout_id = $1",
    )
    .bind(&p)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert!(updated, "updated_at moves on every state change");
}

/// P9, second run: a stale `submitting` intent goes to `unknown`; a later `/submitted`
/// from `unknown` is allowed (manual inspection found the transaction).
#[tokio::test]
async fn p9_stale_submitting_becomes_unknown() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let stale = low_check(&h, &f1()).await;
    let fresh = low_check(&h, &f1_numbered("RE-2026-0413")).await;
    let ps = payout_id(&authorize_ok(&h, &stale).await);
    let pf = payout_id(&authorize_ok(&h, &fresh).await);
    assert_state(&step(&h, &ps, "submitting").await, "submitting");
    assert_state(&step(&h, &pf, "submitting").await, "submitting");
    sqlx::query(
        "UPDATE payout_intents SET updated_at = updated_at - interval '601 seconds'
         WHERE payout_id = $1",
    )
    .bind(&ps)
    .execute(&h.pool)
    .await
    .unwrap();

    assert_eq!(
        sniffer::payouts::mark_stale_unknown(&h.pool).await.unwrap(),
        1
    );
    assert_eq!(db_state(&h, &ps).await, "unknown");
    assert_eq!(db_state(&h, &pf).await, "submitting");
    // Never retried automatically: a second run changes nothing.
    assert_eq!(
        sniffer::payouts::mark_stale_unknown(&h.pool).await.unwrap(),
        0
    );

    assert_conflict(&step(&h, &ps, "submitting").await, "invalid_state");
    assert_conflict(&step(&h, &ps, "failed").await, "invalid_state");
    assert_conflict(&step(&h, &ps, "confirm").await, "invalid_state");
    assert_eq!(authorize_ok(&h, &stale).await["state"], "unknown");
    assert_state(&submitted(&h, &ps, &tx('c')).await, "submitted");
}

// ---------------------------------------------------------------------------
// Confirmation (P10)
// ---------------------------------------------------------------------------

/// P10 (a), (d), (e) plus a Blockfrost failure: 404 and 500 leave the intent in
/// `submitted`; a matching output confirms it; a repeated `/confirm` is idempotent.
#[tokio::test]
async fn p10_confirm_matching_output() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let hash = tx('a');
    let p = submitted_intent(&h, &f1(), &hash).await;

    utxo_stub(&hash, ResponseTemplate::new(404))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&h.mock)
        .await;
    utxo_stub(&hash, ResponseTemplate::new(500))
        .up_to_n_times(1)
        .with_priority(2)
        .mount(&h.mock)
        .await;
    utxo_stub(
        &hash,
        ResponseTemplate::new(200).set_body_string("not json"),
    )
    .up_to_n_times(1)
    .with_priority(3)
    .mount(&h.mock)
    .await;
    utxo_stub(
        &hash,
        ResponseTemplate::new(200).set_body_json(utxos(&hash, W1, "47600000")),
    )
    .with_priority(4)
    .mount(&h.mock)
    .await;

    assert_conflict(&step(&h, &p, "confirm").await, "tx_not_found");
    assert_eq!(db_state(&h, &p).await, "submitted");
    assert_error(
        &step(&h, &p, "confirm").await,
        StatusCode::SERVICE_UNAVAILABLE,
        "dependency_unavailable",
    );
    assert_eq!(db_state(&h, &p).await, "submitted");
    assert_error(
        &step(&h, &p, "confirm").await,
        StatusCode::SERVICE_UNAVAILABLE,
        "dependency_unavailable",
    );
    assert_eq!(db_state(&h, &p).await, "submitted");

    let r = step(&h, &p, "confirm").await;
    assert_state(&r, "confirmed");
    assert_eq!(r.body["tx_hash"], hash);
    assert_eq!(r.body["lovelace"], F1_LOVELACE);
    let calls = h.stub_requests().await;
    // (e) idempotent, without asking Blockfrost again.
    assert_state(&step(&h, &p, "confirm").await, "confirmed");
    assert_eq!(h.stub_requests().await, calls);
    assert_conflict(&step(&h, &p, "failed").await, "invalid_state");
    assert_conflict(&submitted(&h, &p, &hash).await, "invalid_state");
}

/// P10 (b) wrong address and (c) one lovelace too little: `tx_mismatch`, `unknown`.
#[tokio::test]
async fn p10_confirm_mismatch() {
    let Some(h) = payout_harness(&[]).await else {
        return;
    };
    let (wrong_address, too_little) = (tx('b'), tx('c'));
    utxo_stub(
        &wrong_address,
        ResponseTemplate::new(200).set_body_json(utxos(&wrong_address, W2, "47600000")),
    )
    .mount(&h.mock)
    .await;
    utxo_stub(
        &too_little,
        ResponseTemplate::new(200).set_body_json(utxos(&too_little, W1, "47599999")),
    )
    .mount(&h.mock)
    .await;

    let p = submitted_intent(&h, &f1(), &wrong_address).await;
    assert_conflict(&step(&h, &p, "confirm").await, "tx_mismatch");
    assert_eq!(db_state(&h, &p).await, "unknown");

    // After manual inspection the module may report another transaction.
    assert_state(&submitted(&h, &p, &too_little).await, "submitted");
    assert_conflict(&step(&h, &p, "confirm").await, "tx_mismatch");
    assert_eq!(db_state(&h, &p).await, "unknown");
}

/// `/confirm` needs `BLOCKFROST_MODE=api`; in `mock` mode it answers 503.
#[tokio::test]
async fn confirm_in_blockfrost_mock_mode_is_unavailable() {
    let Some(h) = payout_harness(&[("BLOCKFROST_MODE", "mock")]).await else {
        return;
    };
    let invoice_hash: String =
        sqlx::query_scalar("SELECT invoice_hash FROM invoices ORDER BY check_id LIMIT 1")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    let p = "pay_01MOCKMODE0000000000000000";
    sqlx::query(
        "INSERT INTO payout_intents (payout_id, invoice_hash, check_id, wallet_hash, to_address,
                                     amount_eur, ada_per_eur, lovelace, state, tx_hash)
         VALUES ($1, $2, 'seed_1', $3, $4, 1190.00, 0.040000, 47600000, 'submitted', $5)",
    )
    .bind(p)
    .bind(invoice_hash)
    .bind(wallet_hash(W1))
    .bind(W1)
    .bind(tx('d'))
    .execute(&h.pool)
    .await
    .unwrap();
    assert_error(
        &step(&h, p, "confirm").await,
        StatusCode::SERVICE_UNAVAILABLE,
        "dependency_unavailable",
    );
    assert_eq!(db_state(&h, p).await, "submitted");
}
