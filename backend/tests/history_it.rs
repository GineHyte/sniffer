//! Spec 12.6 / test H1: `GET /v1/suppliers/{supplier_hash}/history` against the real
//! router, Postgres and Redis after the 7.5 seed. Harness and environment: see
//! `common/mod.rs` (gated by `SNIFFER_IT_DATABASE_URL`).

mod common;

use reqwest::StatusCode;
use serde_json::{json, Value};

use common::*;

const SUPPLIER_A_VAT: &str = "DE111111111";

fn history_path(hash: &str) -> String {
    format!("/v1/suppliers/{hash}/history")
}

fn expected_a(hash: &str) -> Value {
    json!({
        "supplier_hash": hash,
        "approved_count": 6,
        "median_eur": "1145.00",
        "last_amounts": ["1050.00", "1300.00", "1100.00", "980.00", "1250.00", "1190.00"],
        "first_seen": "2026-04-15",
    })
}

/// Inserts one `invoices` row for `supplier_hash` (fields not under test are fixed).
async fn insert_row(
    h: &Harness,
    n: u32,
    supplier_hash: &str,
    amount: &str,
    currency: &str,
    issue_date: &str,
    final_decision: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO invoices (invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash,
                               name_hash, amount, currency, issue_date, type_code,
                               initial_band, initial_score, final_decision)
         VALUES ($1, $2, $3, 'hmac:w', 'hmac:p', 'hmac:n', $4::numeric, $5, $6::date, '380',
                 'medium', 40, $7)",
    )
    .bind(format!("hmac:history-it-{n}"))
    .bind(format!("chk_history_it_{n}"))
    .bind(supplier_hash)
    .bind(amount)
    .bind(currency)
    .bind(issue_date)
    .bind(final_decision)
    .execute(&h.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn h1_supplier_history() {
    let Some(h) = harness().await else { return };
    let a = supplier_hash(SUPPLIER_A_VAT);
    assert_eq!(
        a, "hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060",
        "3.3 test vector"
    );

    let r = h.get(&history_path(&a)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body, expected_a(&a));

    // The colon may be percent-encoded (either case of the hex digits).
    for encoded in [a.replace(':', "%3A"), a.replace(':', "%3a")] {
        let r = h.get(&history_path(&encoded)).await;
        assert_eq!(r.status, StatusCode::OK, "{encoded}: {}", r.text);
        assert_eq!(r.body, expected_a(&a));
    }

    // Unknown but well-formed hash.
    let unknown = format!("hmac:{}", "0".repeat(64));
    let r = h.get(&history_path(&unknown)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    assert_eq!(r.body["error"], "not_found");
    assert!(r.body["message"].is_string());

    // Malformed hashes.
    let hex = a.strip_prefix("hmac:").unwrap();
    for bad in [
        hex.to_string(),
        format!("hmac:{}", &hex[1..]),
        format!("hmac:{hex}0"),
        format!("hmac:{}", hex.to_uppercase()),
        format!("sha:{hex}"),
        format!("hmac:{}g", &hex[1..]),
        "%FF".to_string(),
    ] {
        let r = h.get(&history_path(&bad)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}: {}", r.text);
        assert_eq!(r.body["error"], "invalid_request", "{bad}");
        assert!(!r.text.contains(hex), "error body must not echo the hash");
    }

    // FR-08: missing or wrong bearer token.
    let r = h.http.get(h.url(&history_path(&a))).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"], "unauthorized");
    let r = h
        .http
        .get(h.url(&history_path(&a)))
        .bearer_auth("wrong-token")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
}

/// Only approved EUR rows are evaluated; a supplier with rows but no approved EUR
/// row answers 200 with zero count and nulls.
#[tokio::test]
async fn history_filters_approved_eur_rows() {
    let Some(h) = harness().await else { return };
    let a = supplier_hash(SUPPLIER_A_VAT);
    insert_row(&h, 1, &a, "9999.00", "USD", "2026-10-01", Some("approved")).await;
    insert_row(&h, 2, &a, "8888.00", "EUR", "2026-10-02", Some("rejected")).await;
    insert_row(&h, 3, &a, "7777.00", "EUR", "2026-10-03", None).await;
    insert_row(&h, 4, &a, "10.00", "EUR", "2026-01-01", Some("rejected")).await;
    let r = h.get(&history_path(&a)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body, expected_a(&a));

    let b = supplier_hash("DE999999999");
    insert_row(&h, 5, &b, "500.00", "EUR", "2026-10-04", None).await;
    insert_row(&h, 6, &b, "600.00", "USD", "2026-10-05", Some("approved")).await;
    let r = h.get(&history_path(&b)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(
        r.body,
        json!({
            "supplier_hash": b,
            "approved_count": 0,
            "median_eur": null,
            "last_amounts": [],
            "first_seen": null,
        })
    );
}
