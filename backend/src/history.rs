//! Supplier history read endpoint (spec 12.6). Owner: Task 20.
//!
//! `GET /v1/suppliers/{supplier_hash}/history` returns the approval history of one
//! supplier for the agent stage: only counts, EUR amounts and a date, never raw values.

use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Serialize;

use crate::api::{authorize, ApiError};
use crate::app::AppState;
use crate::criteria::invoice::median;
use crate::normalize::amount;

/// At most this many amounts in `last_amounts`.
const LAST_AMOUNTS: usize = 6;

/// Routes under `/v1/suppliers`. Every handler must call `crate::api::authorize` (FR-08).
pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/v1/suppliers/{supplier_hash}/history",
        get(supplier_history),
    )
}

/// Response body of 12.6.
#[derive(Debug, Serialize)]
struct SupplierHistory {
    supplier_hash: String,
    approved_count: usize,
    median_eur: Option<String>,
    last_amounts: Vec<String>,
    first_seen: Option<String>,
}

/// `hmac:` + 64 lowercase hex characters (3.3).
fn is_hash(s: &str) -> bool {
    s.strip_prefix("hmac:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn bad_hash() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "supplier_hash must be hmac: followed by 64 lowercase hex characters",
    )
}

/// Builds the response from the evaluated rows, ordered `issue_date` DESC, then
/// `created_at` DESC (newest first).
fn summarize(supplier_hash: String, rows: &[(Decimal, NaiveDate)]) -> SupplierHistory {
    let amounts: Vec<Decimal> = rows.iter().map(|(a, _)| *a).collect();
    SupplierHistory {
        supplier_hash,
        approved_count: rows.len(),
        median_eur: median(&amounts).map(|m| amount(&m)),
        last_amounts: amounts.iter().take(LAST_AMOUNTS).map(amount).collect(),
        first_seen: rows
            .iter()
            .map(|(_, d)| *d)
            .min()
            .map(|d| d.format("%Y-%m-%d").to_string()),
    }
}

/// `GET /v1/suppliers/{supplier_hash}/history` (12.6). The path parameter is
/// percent-decoded by axum, so `hmac%3A…` arrives as `hmac:…`.
async fn supplier_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    supplier_hash: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let Path(supplier_hash) = supplier_hash.map_err(|_| bad_hash())?;
    if !is_hash(&supplier_hash) {
        return Err(bad_hash());
    }

    let rows: Vec<(Decimal, NaiveDate)> = sqlx::query_as(
        "SELECT amount, issue_date FROM invoices
         WHERE supplier_hash = $1 AND final_decision = 'approved' AND currency = 'EUR'
         ORDER BY issue_date DESC, created_at DESC",
    )
    .bind(&supplier_hash)
    .fetch_all(&state.pool)
    .await?;
    if rows.is_empty() {
        let known: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM invoices WHERE supplier_hash = $1)")
                .bind(&supplier_hash)
                .fetch_one(&state.pool)
                .await?;
        if !known {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "no invoice for this supplier_hash",
            ));
        }
    }
    Ok(Json(summarize(supplier_hash, &rows)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn hash_format() {
        let hex = "d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060";
        assert!(is_hash(&format!("hmac:{hex}")));
        assert!(!is_hash(hex));
        assert!(!is_hash(&format!("hmac:{}", hex.to_uppercase())));
        assert!(!is_hash(&format!("hmac:{}", &hex[1..])));
        assert!(!is_hash(&format!("hmac:{hex}0")));
        assert!(!is_hash(&format!("hmac%3A{hex}")));
        assert!(!is_hash(&format!("HMAC:{hex}")));
    }

    #[test]
    fn empty_history_has_nulls() {
        let h = summarize("hmac:x".into(), &[]);
        assert_eq!(h.approved_count, 0);
        assert_eq!(h.median_eur, None);
        assert!(h.last_amounts.is_empty());
        assert_eq!(h.first_seen, None);
    }

    #[test]
    fn median_rounds_commercially_and_caps_last_amounts() {
        let rows: Vec<(Decimal, NaiveDate)> = [
            ("10.01", "2026-07-01"),
            ("10.00", "2026-06-01"),
            ("1", "2026-05-01"),
            ("2", "2026-04-01"),
            ("3", "2026-03-01"),
            ("4", "2026-02-01"),
            ("5", "2026-01-01"),
            ("6", "2025-12-01"),
        ]
        .iter()
        .map(|(a, t)| (d(a), day(t)))
        .collect();
        let h = summarize("hmac:x".into(), &rows);
        assert_eq!(h.approved_count, 8);
        // Sorted: 1 2 3 4 5 6 10.00 10.01; middle values 4 and 5 → 4.5.
        assert_eq!(h.median_eur.as_deref(), Some("4.50"));
        assert_eq!(
            h.last_amounts,
            ["10.01", "10.00", "1.00", "2.00", "3.00", "4.00"]
        );
        assert_eq!(h.first_seen.as_deref(), Some("2025-12-01"));
        // Mean of 10.00 and 10.01 = 10.005 → 10.01 (half away from zero).
        let h = summarize("hmac:x".into(), &rows[..2]);
        assert_eq!(h.median_eur.as_deref(), Some("10.01"));
    }
}
