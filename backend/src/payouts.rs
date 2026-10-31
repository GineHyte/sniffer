//! Payout policy extension (spec 12, FR-32a). Owner: Task 19.
//!
//! The service authorizes payouts for approved invoices under a fixed policy (12.4),
//! keeps the `payout_intents` journal (12.2) and confirms the payment on-chain itself
//! (12.5). It never signs or submits transactions. `to_address` is the only raw value
//! it stores (FR-32a); it is never logged and never quoted in an error body.

use std::str::FromStr;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use rust_decimal::{Decimal, RoundingStrategy};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use tokio::time::MissedTickBehavior;

use crate::address::{self, CredentialType, Network};
use crate::api::{authorize, ApiError};
use crate::app::AppState;
use crate::config::{EnvConfig, SourceMode};
use crate::hashing::{self, CredentialKind};
use crate::parse;
use crate::sources::{build_url, http_client, HttpSettings};
use crate::store::redis as rstore;

/// Key of the `pg_advisory_xact_lock` that serializes `authorize` (12.4, rule 7).
/// ASCII "snifpay1".
pub const PAYOUT_LOCK_KEY: i64 = 0x736E_6966_7061_7931;
/// A `submitting` intent older than this goes to `unknown` (12.5, 12.8).
pub const UNKNOWN_AFTER_SECS: i32 = 600;
/// Period of the `unknown` job (12.8).
pub const UNKNOWN_JOB_PERIOD: Duration = Duration::from_secs(60);

const LOVELACE_PER_ADA: i128 = 1_000_000;

/// Routes under `/v1/payouts`. Every handler calls `crate::api::authorize` (FR-08).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/payouts/authorize", post(authorize_payout))
        .route("/v1/payouts/{payout_id}/submitting", post(mark_submitting))
        .route("/v1/payouts/{payout_id}/submitted", post(mark_submitted))
        .route("/v1/payouts/{payout_id}/confirm", post(confirm))
        .route("/v1/payouts/{payout_id}/failed", post(mark_failed))
}

// ---------------------------------------------------------------------------
// States and rows
// ---------------------------------------------------------------------------

/// `payout_intents.state` (12.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayoutState {
    Authorized,
    Submitting,
    Submitted,
    Confirmed,
    Failed,
    Unknown,
}

impl PayoutState {
    pub fn as_str(self) -> &'static str {
        match self {
            PayoutState::Authorized => "authorized",
            PayoutState::Submitting => "submitting",
            PayoutState::Submitted => "submitted",
            PayoutState::Confirmed => "confirmed",
            PayoutState::Failed => "failed",
            PayoutState::Unknown => "unknown",
        }
    }
}

impl FromStr for PayoutState {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "authorized" => PayoutState::Authorized,
            "submitting" => PayoutState::Submitting,
            "submitted" => PayoutState::Submitted,
            "confirmed" => PayoutState::Confirmed,
            "failed" => PayoutState::Failed,
            "unknown" => PayoutState::Unknown,
            _ => return Err(()),
        })
    }
}

/// One `payout_intents` row. No `Debug`: it holds the raw `to_address`.
#[derive(sqlx::FromRow)]
struct IntentRow {
    payout_id: String,
    check_id: String,
    wallet_hash: String,
    to_address: String,
    amount_eur: Decimal,
    ada_per_eur: Decimal,
    lovelace: i64,
    state: String,
    tx_hash: Option<String>,
}

/// Column list of [`IntentRow`], as a literal for `concat!` (sqlx needs `&'static str`).
macro_rules! intent_columns {
    () => {
        "payout_id, check_id, wallet_hash, to_address, amount_eur, ada_per_eur, lovelace, state, tx_hash"
    };
}

impl IntentRow {
    fn state(&self) -> Result<PayoutState, ApiError> {
        self.state.parse().map_err(|_| {
            tracing::error!(payout_id = %self.payout_id, "payout_intents row has an unknown state");
            unavailable()
        })
    }

    /// The "intent view" of 12.4, the response of every payout endpoint.
    fn view(&self) -> IntentView {
        IntentView {
            payout_id: self.payout_id.clone(),
            check_id: self.check_id.clone(),
            state: self.state.clone(),
            to_address: self.to_address.clone(),
            amount_eur: fixed(self.amount_eur, 2),
            ada_per_eur: fixed(self.ada_per_eur, 6),
            lovelace: self.lovelace,
            tx_hash: self.tx_hash.clone(),
        }
    }

    fn respond(&self) -> Response {
        Json(self.view()).into_response()
    }
}

#[derive(Serialize)]
struct IntentView {
    payout_id: String,
    check_id: String,
    state: String,
    to_address: String,
    amount_eur: String,
    ada_per_eur: String,
    lovelace: i64,
    tx_hash: Option<String>,
}

/// `d` rounded half away from zero to `dp` places, printed with exactly `dp` places.
fn fixed(d: Decimal, dp: u32) -> String {
    let mut d = d.round_dp_with_strategy(dp, RoundingStrategy::MidpointAwayFromZero);
    d.rescale(dp);
    d.to_string()
}

/// `floor(amount_eur * ada_per_eur * 1_000_000)`, computed exactly in decimal (12.2).
/// `None` on overflow.
pub fn lovelace_for(amount_eur: Decimal, ada_per_eur: Decimal) -> Option<i128> {
    let ada = amount_eur.checked_mul(ada_per_eur)?;
    let lovelace = ada.checked_mul(Decimal::from(LOVELACE_PER_ADA))?.floor();
    i128::try_from(lovelace).ok()
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message)
}

fn invalid_request(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "dependency_unavailable",
        "a dependency is unavailable; the payout was not changed",
    )
}

fn invalid_state() -> ApiError {
    conflict(
        "invalid_state",
        "this state transition is not allowed for the payout",
    )
}

fn wallet_blocked() -> ApiError {
    conflict("wallet_blocked", "the recipient wallet is blocked")
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorizeRequest {
    check_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmittedRequest {
    tx_hash: String,
}

/// Auth, `Content-Type: application/json` and JSON shape, like the 5.x endpoints.
/// Error messages never quote the body (FR-09).
fn json_request<T: DeserializeOwned>(
    state: &AppState,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<T, ApiError> {
    authorize(state, headers)?;
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"));
    if !is_json {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Content-Type must be application/json",
        ));
    }
    let body = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "request body exceeds the server limit",
            )
        } else {
            invalid_request("request body could not be read")
        }
    })?;
    serde_json::from_slice(&body).map_err(|e| {
        use serde_json::error::Category;
        invalid_request(match e.classify() {
            Category::Io | Category::Syntax | Category::Eof => "body is not valid JSON",
            Category::Data => "wrong field types, missing or unknown fields",
        })
    })
}

/// `^[0-9a-f]{64}$`.
fn is_tx_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ---------------------------------------------------------------------------
// POST /v1/payouts/authorize (12.4)
// ---------------------------------------------------------------------------

async fn authorize_payout(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let req: AuthorizeRequest = json_request(&state, &headers, body)?;
    let Some(rate) = state.env.ada_per_eur else {
        return Err(conflict(
            "payouts_disabled",
            "payouts are disabled (ADA_PER_EUR is not set)",
        ));
    };
    let check_id = req.check_id;

    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(PAYOUT_LOCK_KEY)
        .execute(&mut *tx)
        .await?;

    match policy(&state, &mut tx, &check_id, rate).await {
        Ok(Authorized::Existing(row)) => {
            tx.rollback().await?;
            tracing::info!(payout_id = %row.payout_id, state = %row.state, %check_id, "payout authorize: existing intent");
            Ok(row.respond())
        }
        Ok(Authorized::New(row)) => {
            tx.commit().await?;
            tracing::info!(payout_id = %row.payout_id, state = %row.state, %check_id, lovelace = row.lovelace, "payout authorized");
            Ok(row.respond())
        }
        Err(e) => {
            tx.rollback().await.ok();
            Err(e)
        }
    }
}

enum Authorized {
    Existing(IntentRow),
    New(IntentRow),
}

/// Rules 1-8 of 12.4 in order; the first violated rule decides the error code.
async fn policy(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    check_id: &str,
    rate: Decimal,
) -> Result<Authorized, ApiError> {
    let reject = |code: &'static str, message: &'static str| {
        tracing::info!(%check_id, error = code, "payout authorize rejected");
        conflict(code, message)
    };

    // Rule 1.
    let invoice: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT invoice_hash, wallet_hash, currency::text, final_decision
         FROM invoices WHERE check_id = $1",
    )
    .bind(check_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((invoice_hash, wallet_hash, currency, decision)) = invoice else {
        return Err(reject(
            "not_approved",
            "no approved invoice for this check_id",
        ));
    };
    if decision.as_deref() != Some("approved") {
        return Err(reject(
            "not_approved",
            "no approved invoice for this check_id",
        ));
    }

    // Rule 2.
    if currency.trim() != "EUR" {
        return Err(reject(
            "currency_not_supported",
            "only EUR invoices can be paid out",
        ));
    }

    // Rule 3: idempotent on invoice_hash, in every state.
    let existing: Option<IntentRow> = sqlx::query_as(concat!(
        "SELECT ",
        intent_columns!(),
        " FROM payout_intents WHERE invoice_hash = $1"
    ))
    .bind(&invoice_hash)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = existing {
        return Ok(Authorized::Existing(row));
    }

    // Rule 4: re-read now; the wallet may have been blocked after approval.
    if wallet_is_blocked(&mut **tx, &wallet_hash).await? {
        return Err(reject("wallet_blocked", "the recipient wallet is blocked"));
    }

    // Rule 5.
    let mut conn = state.redis.clone();
    let Some(xml) = rstore::get_xml(&mut conn, check_id).await? else {
        return Err(reject(
            "xml_expired",
            "the original XML is no longer stored",
        ));
    };
    let parsed = parse::parse_invoice(&xml);
    let invoice = parsed.invoice.as_ref();
    let recipient = invoice
        .and_then(|i| i.payment_address.as_deref())
        .and_then(|raw| address::check(raw, state.env.expected_network).ok());
    let Some(recipient) = recipient else {
        return Err(reject(
            "recipient_mismatch",
            "the stored XML does not name the approved recipient",
        ));
    };
    let kind = match recipient.credential_type {
        CredentialType::Key => CredentialKind::Key,
        CredentialType::Script => CredentialKind::Script,
    };
    if hashing::wallet_hash(&state.env.hmac_key, kind, &recipient.credential_hex) != wallet_hash {
        return Err(reject(
            "recipient_mismatch",
            "the stored XML does not name the approved recipient",
        ));
    }

    // Rule 6.
    let amount_eur = invoice.and_then(|i| i.due_payable);
    let lovelace = amount_eur.and_then(|a| lovelace_for(a, rate));
    let (Some(amount_eur), Some(lovelace)) = (amount_eur, lovelace) else {
        return Err(reject(
            "amount_zero",
            "no payable amount could be derived from the stored XML",
        ));
    };
    if lovelace <= 0 {
        return Err(reject("amount_zero", "the payable amount is zero"));
    }
    let invoice_cap = i128::from(state.env.payout_max_ada_per_invoice) * LOVELACE_PER_ADA;
    if lovelace > invoice_cap {
        return Err(reject(
            "over_invoice_cap",
            "the amount exceeds PAYOUT_MAX_ADA_PER_INVOICE",
        ));
    }
    let lovelace = i64::try_from(lovelace).map_err(|_| {
        reject(
            "over_invoice_cap",
            "the amount exceeds PAYOUT_MAX_ADA_PER_INVOICE",
        )
    })?;

    // Rule 7: today's (UTC, real clock) non-failed intents, under the advisory lock.
    let today: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(lovelace), 0)::bigint FROM payout_intents
         WHERE state <> 'failed'
           AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date",
    )
    .fetch_one(&mut **tx)
    .await?;
    let day_cap = i128::from(state.env.payout_max_ada_per_day) * LOVELACE_PER_ADA;
    if i128::from(today) + i128::from(lovelace) > day_cap {
        return Err(reject(
            "over_daily_cap",
            "the amount exceeds today's PAYOUT_MAX_ADA_PER_DAY",
        ));
    }

    // Rule 8.
    if state.env.expected_network != Network::Preprod {
        return Err(reject(
            "network_not_allowed",
            "payouts are only allowed on preprod",
        ));
    }

    let payout_id = format!("pay_{}", ulid::Ulid::generate());
    let row: IntentRow = sqlx::query_as(concat!(
        "INSERT INTO payout_intents (payout_id, invoice_hash, check_id, wallet_hash, to_address,
                                     amount_eur, ada_per_eur, lovelace, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'authorized')
         RETURNING ",
        intent_columns!()
    ))
    .bind(&payout_id)
    .bind(&invoice_hash)
    .bind(check_id)
    .bind(&wallet_hash)
    .bind(&recipient.address)
    .bind(amount_eur.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero))
    .bind(rate)
    .bind(lovelace)
    .fetch_one(&mut **tx)
    .await?;
    Ok(Authorized::New(row))
}

async fn wallet_is_blocked<'c>(
    executor: impl sqlx::PgExecutor<'c>,
    wallet_hash: &str,
) -> Result<bool, sqlx::Error> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM subjects WHERE hash = $1 AND type = 'wallet'")
            .bind(wallet_hash)
            .fetch_optional(executor)
            .await?;
    Ok(status.as_deref() == Some("blocked"))
}

// ---------------------------------------------------------------------------
// State transitions (12.5)
// ---------------------------------------------------------------------------

/// Opens a transaction and locks the intent row (`SELECT ... FOR UPDATE`); 404 if unknown.
async fn lock_intent(
    pool: &PgPool,
    payout_id: &str,
) -> Result<(Transaction<'static, Postgres>, IntentRow), ApiError> {
    let mut tx = pool.begin().await?;
    let row: Option<IntentRow> = sqlx::query_as(concat!(
        "SELECT ",
        intent_columns!(),
        " FROM payout_intents WHERE payout_id = $1 FOR UPDATE"
    ))
    .bind(payout_id)
    .fetch_optional(&mut *tx)
    .await?;
    match row {
        Some(row) => Ok((tx, row)),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown payout_id",
        )),
    }
}

/// Sets `state` (and optionally `tx_hash`) and `updated_at = now()`.
async fn set_state(
    tx: &mut Transaction<'static, Postgres>,
    payout_id: &str,
    to: PayoutState,
    tx_hash: Option<&str>,
) -> Result<IntentRow, sqlx::Error> {
    sqlx::query_as(concat!(
        "UPDATE payout_intents
         SET state = $2, tx_hash = COALESCE($3, tx_hash), updated_at = now()
         WHERE payout_id = $1
         RETURNING ",
        intent_columns!()
    ))
    .bind(payout_id)
    .bind(to.as_str())
    .bind(tx_hash)
    .fetch_one(&mut **tx)
    .await
}

fn log_transition(row: &IntentRow, from: PayoutState) {
    tracing::info!(
        payout_id = %row.payout_id,
        check_id = %row.check_id,
        from = from.as_str(),
        state = %row.state,
        "payout state changed"
    );
}

/// `POST /v1/payouts/{payout_id}/submitting`: `authorized` -> `submitting`, rule 4 again.
async fn mark_submitting(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(payout_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let (mut tx, row) = lock_intent(&state.pool, &payout_id).await?;
    match row.state()? {
        PayoutState::Submitting => Ok(row.respond()),
        PayoutState::Authorized => {
            if wallet_is_blocked(&mut *tx, &row.wallet_hash).await? {
                tracing::info!(%payout_id, state = %row.state, error = "wallet_blocked", "payout submitting rejected");
                return Err(wallet_blocked());
            }
            let new = set_state(&mut tx, &payout_id, PayoutState::Submitting, None).await?;
            tx.commit().await?;
            log_transition(&new, PayoutState::Authorized);
            Ok(new.respond())
        }
        _ => Err(invalid_state()),
    }
}

/// `POST /v1/payouts/{payout_id}/submitted {tx_hash}`: `submitting`|`unknown` -> `submitted`.
async fn mark_submitted(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(payout_id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let req: SubmittedRequest = json_request(&state, &headers, body)?;
    if !is_tx_hash(&req.tx_hash) {
        return Err(invalid_request(
            "tx_hash must be 64 lowercase hex characters",
        ));
    }
    let (mut tx, row) = lock_intent(&state.pool, &payout_id).await?;
    match row.state()? {
        PayoutState::Submitted if row.tx_hash.as_deref() == Some(req.tx_hash.as_str()) => {
            Ok(row.respond())
        }
        from @ (PayoutState::Submitting | PayoutState::Unknown) => {
            let new = set_state(
                &mut tx,
                &payout_id,
                PayoutState::Submitted,
                Some(&req.tx_hash),
            )
            .await?;
            tx.commit().await?;
            log_transition(&new, from);
            Ok(new.respond())
        }
        _ => Err(invalid_state()),
    }
}

/// `POST /v1/payouts/{payout_id}/failed`: only from `authorized`.
async fn mark_failed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(payout_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let (mut tx, row) = lock_intent(&state.pool, &payout_id).await?;
    match row.state()? {
        PayoutState::Failed => Ok(row.respond()),
        PayoutState::Authorized => {
            let new = set_state(&mut tx, &payout_id, PayoutState::Failed, None).await?;
            tx.commit().await?;
            log_transition(&new, PayoutState::Authorized);
            Ok(new.respond())
        }
        _ => Err(invalid_state()),
    }
}

/// `POST /v1/payouts/{payout_id}/confirm`: `submitted` -> `confirmed` after the server's
/// own Blockfrost check; a transaction without a matching output -> `unknown`.
async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(payout_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let (mut tx, row) = lock_intent(&state.pool, &payout_id).await?;
    match row.state()? {
        PayoutState::Confirmed => return Ok(row.respond()),
        PayoutState::Submitted => {}
        _ => return Err(invalid_state()),
    }
    if state.env.blockfrost_mode != SourceMode::Api {
        return Err(unavailable());
    }
    let Some(tx_hash) = row.tx_hash.as_deref() else {
        tracing::error!(%payout_id, "submitted payout without tx_hash");
        return Err(unavailable());
    };
    let outcome = check_tx(&state.env, tx_hash, &row.to_address, row.lovelace)
        .await
        .map_err(|()| {
            tracing::warn!(%payout_id, state = %row.state, error = "dependency_unavailable", "payout confirm: blockfrost unavailable");
            unavailable()
        })?;
    match outcome {
        TxCheck::Paid => {
            let new = set_state(&mut tx, &payout_id, PayoutState::Confirmed, None).await?;
            tx.commit().await?;
            log_transition(&new, PayoutState::Submitted);
            Ok(new.respond())
        }
        TxCheck::Mismatch => {
            let new = set_state(&mut tx, &payout_id, PayoutState::Unknown, None).await?;
            tx.commit().await?;
            log_transition(&new, PayoutState::Submitted);
            Err(conflict(
                "tx_mismatch",
                "the transaction has no output paying the authorized amount to the recipient",
            ))
        }
        TxCheck::NotFound => {
            tracing::info!(%payout_id, state = %row.state, error = "tx_not_found", "payout confirm: transaction not yet on chain");
            Err(conflict(
                "tx_not_found",
                "the transaction is not yet in a block",
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Blockfrost confirmation
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum TxCheck {
    Paid,
    Mismatch,
    NotFound,
}

#[derive(Deserialize)]
struct TxUtxos {
    outputs: Vec<TxOutput>,
}

#[derive(Deserialize)]
struct TxOutput {
    address: String,
    amount: Vec<TxAmount>,
}

#[derive(Deserialize)]
struct TxAmount {
    unit: String,
    quantity: String,
}

/// `GET <BLOCKFROST_BASE_URL>/txs/<tx_hash>/utxos`, no cache, no retry. `Err(())` for
/// any response other than 200 or 404, a timeout or an invalid body.
async fn check_tx(
    env: &EnvConfig,
    tx_hash: &str,
    to_address: &str,
    lovelace: i64,
) -> Result<TxCheck, ()> {
    let project_id = env.blockfrost_project_id.as_deref().ok_or(())?;
    let http = http_client(&HttpSettings {
        timeout_ms: env.http_timeout_ms,
    })
    .map_err(|_| ())?;
    let url = build_url(&env.blockfrost_base_url, &["txs", tx_hash, "utxos"]).map_err(|_| ())?;
    let resp = http
        .get(url)
        .header("project_id", project_id)
        .send()
        .await
        .map_err(|_| ())?;
    match resp.status().as_u16() {
        404 => Ok(TxCheck::NotFound),
        200 => {
            let body = resp.bytes().await.map_err(|_| ())?;
            let utxos: TxUtxos = serde_json::from_slice(&body).map_err(|_| ())?;
            Ok(if pays(&utxos.outputs, to_address, lovelace)? {
                TxCheck::Paid
            } else {
                TxCheck::Mismatch
            })
        }
        _ => Err(()),
    }
}

/// `true` if one output pays exactly `to_address` at least `lovelace` lovelace.
/// `Err(())` if a lovelace quantity is not a non-negative integer.
fn pays(outputs: &[TxOutput], to_address: &str, lovelace: i64) -> Result<bool, ()> {
    let min = u128::try_from(lovelace).map_err(|_| ())?;
    for output in outputs.iter().filter(|o| o.address == to_address) {
        for amount in output.amount.iter().filter(|a| a.unit == "lovelace") {
            if amount.quantity.parse::<u128>().map_err(|_| ())? >= min {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// Background job (12.8)
// ---------------------------------------------------------------------------

/// Moves every `submitting` intent whose `updated_at` is older than
/// [`UNKNOWN_AFTER_SECS`] to `unknown`. Returns the number of moved intents. Such an
/// intent is never retried automatically.
pub async fn mark_stale_unknown(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "UPDATE payout_intents SET state = 'unknown', updated_at = now()
         WHERE state = 'submitting' AND updated_at < now() - make_interval(secs => $1)
         RETURNING payout_id",
    )
    .bind(f64::from(UNKNOWN_AFTER_SECS))
    .fetch_all(pool)
    .await?;
    for payout_id in &ids {
        tracing::warn!(%payout_id, from = "submitting", state = "unknown", "payout outcome unknown; manual inspection needed");
    }
    Ok(ids.len() as u64)
}

/// The `unknown` job: every [`UNKNOWN_JOB_PERIOD`], never overlapping itself. Errors are
/// logged and never stop the server. Spawn it next to the other jobs.
pub async fn unknown_job(pool: PgPool) {
    let mut tick = tokio::time::interval(UNKNOWN_JOB_PERIOD);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = mark_stale_unknown(&pool).await {
            tracing::error!(error = %e, "payout unknown job failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    #[test]
    fn lovelace_matches_spec_examples() {
        // 12.9: F1 with 0.040000 -> 47600000; P6 (b) 59.5 ADA; P6 (c) 39666603.
        assert_eq!(lovelace_for(d("1190.00"), d("0.040000")), Some(47_600_000));
        assert_eq!(lovelace_for(d("1190.00"), d("0.050000")), Some(59_500_000));
        assert_eq!(lovelace_for(d("1190.01"), d("0.033333")), Some(39_666_603));
        assert_eq!(lovelace_for(d("0.01"), d("0.000001")), Some(0));
        assert_eq!(lovelace_for(d("-1.00"), d("0.04")), Some(-40_000));
    }

    #[test]
    fn fixed_places() {
        assert_eq!(fixed(d("0.04"), 6), "0.040000");
        assert_eq!(fixed(d("1190"), 2), "1190.00");
        assert_eq!(fixed(d("1.005"), 2), "1.01");
    }

    #[test]
    fn tx_hash_format() {
        assert!(is_tx_hash(&"ab".repeat(32)));
        assert!(!is_tx_hash(&"AB".repeat(32)));
        assert!(!is_tx_hash(&"ab".repeat(31)));
        assert!(!is_tx_hash(&format!("{}g", "a".repeat(63))));
    }

    #[test]
    fn states_roundtrip() {
        for s in [
            PayoutState::Authorized,
            PayoutState::Submitting,
            PayoutState::Submitted,
            PayoutState::Confirmed,
            PayoutState::Failed,
            PayoutState::Unknown,
        ] {
            assert_eq!(s.as_str().parse::<PayoutState>(), Ok(s));
        }
        assert!("AUTHORIZED".parse::<PayoutState>().is_err());
    }

    fn out(address: &str, amounts: &[(&str, &str)]) -> TxOutput {
        TxOutput {
            address: address.into(),
            amount: amounts
                .iter()
                .map(|(u, q)| TxAmount {
                    unit: (*u).into(),
                    quantity: (*q).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn pays_needs_exact_address_and_enough_lovelace() {
        let outputs = [
            out("addr_other", &[("lovelace", "99999999")]),
            out(
                "addr_to",
                &[("abc123", "47600000"), ("lovelace", "47600000")],
            ),
        ];
        assert_eq!(pays(&outputs, "addr_to", 47_600_000), Ok(true));
        assert_eq!(pays(&outputs, "addr_to", 47_600_001), Ok(false));
        assert_eq!(pays(&outputs, "ADDR_TO", 1), Ok(false));
        assert_eq!(pays(&outputs, "addr_none", 1), Ok(false));
        assert_eq!(
            pays(&[out("addr_to", &[("lovelace", "1.5")])], "addr_to", 1),
            Err(())
        );
    }
}
