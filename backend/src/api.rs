//! axum routes and HTTP error mapping (spec 5, FR-01..FR-10). Owner: Task 16.
//!
//! Every endpoint except `/health` requires `Authorization: Bearer <SNIFFER_API_TOKEN>`
//! (constant-time comparison, FR-08). Error bodies are always
//! `{"error": "<code>", "message": "<text>"}` and never quote invoice data (FR-09).

use std::future::IntoFuture as _;
use std::time::Duration;

use anyhow::Context as _;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use subtle::ConstantTimeEq as _;

use crate::app::{self, AppState};
use crate::check::{self, CheckError};
use crate::config::EnvConfig;
use crate::decisions::{self, DecisionError};
use crate::jobs;
use crate::model::{
    CheckView, DecidedBy, DecisionRequest, DecisionState, DeclineReason, FinalDecision,
    InitialCheckRequest, ReasonType,
};
use crate::store::redis as rstore;

/// FR-81: in-flight requests get at most this long after SIGINT/SIGTERM.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

/// An HTTP error of table 5.1.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        )
    }

    fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "unknown check_id")
    }

    fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "dependency_unavailable",
            "a storage dependency is unavailable; nothing was stored",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        tracing::error!("postgres error in request handler");
        ApiError::unavailable()
    }
}

impl From<redis::RedisError> for ApiError {
    fn from(e: redis::RedisError) -> Self {
        tracing::error!(error_kind = ?e.kind(), "redis error in request handler");
        ApiError::unavailable()
    }
}

impl From<CheckError> for ApiError {
    fn from(e: CheckError) -> Self {
        match e {
            CheckError::CheckInProgress => ApiError::new(
                StatusCode::CONFLICT,
                "check_in_progress",
                "a check for this invoice is already running",
            ),
            CheckError::DependencyUnavailable => ApiError::unavailable(),
        }
    }
}

impl From<DecisionError> for ApiError {
    fn from(e: DecisionError) -> Self {
        match e {
            DecisionError::Invalid(m) => ApiError::invalid_request(m),
            DecisionError::ForbiddenWording => ApiError::new(
                StatusCode::BAD_REQUEST,
                "forbidden_wording",
                "decline_reasons[].text must not contain forbidden wording",
            ),
            DecisionError::NotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "unknown check_id or no invoice row for this check",
            ),
            DecisionError::NotPending => ApiError::new(
                StatusCode::CONFLICT,
                "not_pending",
                "the check is not a pending medium case",
            ),
            DecisionError::AlreadyDecided => ApiError::new(
                StatusCode::CONFLICT,
                "already_decided",
                "a different decision is already stored",
            ),
            DecisionError::Db(e) => e.into(),
        }
    }
}

/// The HTTP API. Exposed for tests; [`serve`] binds it.
pub fn router(state: AppState) -> Router {
    let body_limit = 6 * state.env.max_xml_bytes + 4096;
    Router::new()
        .route("/v1/initial-check", post(initial_check))
        .route("/v1/checks/{check_id}", get(get_check))
        .route("/v1/checks/{check_id}/xml", get(get_check_xml))
        .route("/v1/decisions", post(post_decision))
        .route("/health", get(health))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "unknown route") })
        .layer(DefaultBodyLimit::max(body_limit))
        .with_state(state)
}

/// FR-08: `Authorization: Bearer <token>`, compared in constant time.
fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    let ok: bool = presented
        .as_bytes()
        .ct_eq(state.env.api_token.as_bytes())
        .into();
    if ok {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

/// 415 unless the media type is `application/json` (parameters such as charset allowed).
fn require_json(headers: &HeaderMap) -> Result<(), ApiError> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|m| m.trim().eq_ignore_ascii_case("application/json"));
    if is_json {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Content-Type must be application/json",
        ))
    }
}

/// Auth, Content-Type, body limit and JSON shape (3.5 step 0, in this order).
fn json_body<T: DeserializeOwned>(
    state: &AppState,
    headers: &HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<T, ApiError> {
    authorize(state, headers)?;
    require_json(headers)?;
    let body = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "request body exceeds the server limit",
            )
        } else {
            ApiError::invalid_request("request body could not be read")
        }
    })?;
    // Only the error category: serde messages can quote parts of the input (FR-09).
    serde_json::from_slice(&body).map_err(|e| {
        use serde_json::error::Category;
        ApiError::invalid_request(match e.classify() {
            Category::Io | Category::Syntax | Category::Eof => "body is not valid JSON",
            Category::Data => "wrong field types, missing or unknown fields",
        })
    })
}

/// `POST /v1/initial-check` (FR-01..FR-03, FR-10).
async fn initial_check(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let req: InitialCheckRequest = json_body(&state, &headers, body)?;
    if req.xml.len() > state.env.max_xml_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "xml_too_large",
            "xml exceeds MAX_XML_BYTES",
        ));
    }
    let checked_at = match req.checked_at_utc() {
        Ok(Some(_)) if !state.env.allow_checked_at => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "checked_at_not_allowed",
                "checked_at is not allowed on this server",
            ))
        }
        Ok(Some(t)) => t,
        Ok(None) => now_secs(),
        Err(()) if !state.env.allow_checked_at => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "checked_at_not_allowed",
                "checked_at is not allowed on this server",
            ))
        }
        Err(()) => return Err(ApiError::invalid_request("checked_at must be RFC 3339")),
    };
    let result = check::run_check(&state, &req.xml, checked_at).await?;
    Ok(Json(result).into_response())
}

/// Current UTC time truncated to whole seconds (FR-03).
fn now_secs() -> DateTime<Utc> {
    let now = Utc::now();
    DateTime::from_timestamp(now.timestamp(), 0).unwrap_or(now)
}

/// `GET /v1/checks/{check_id}` (5.2).
async fn get_check(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(check_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT result::text FROM checks WHERE check_id = $1")
            .bind(&check_id)
            .fetch_optional(&state.pool)
            .await?;
    let stored = stored.ok_or_else(ApiError::not_found)?;
    let result: Value = serde_json::from_str(&stored).map_err(|_| {
        tracing::error!(%check_id, "stored result is not valid JSON");
        ApiError::unavailable()
    })?;
    let decision_state = read_decision_state(&state, &check_id).await?;
    Ok(Json(CheckView {
        result,
        decision_state,
    })
    .into_response())
}

/// Decision columns of the `invoices` row; `None` without a row.
async fn read_decision_state(
    state: &AppState,
    check_id: &str,
) -> Result<Option<DecisionState>, ApiError> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<bool>,
        Option<String>,
        Option<String>,
        Option<DateTime<Utc>>,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT final_decision, final_reason_type, final_block_wallet,
                final_decline_reasons::text, decided_by, decided_at
         FROM invoices WHERE check_id = $1",
    )
    .bind(check_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((decision, reason_type, block_wallet, reasons, decided_by, decided_at)) = row else {
        return Ok(None);
    };
    let corrupt = |_| {
        tracing::error!(%check_id, "invoices row holds an unexpected decision value");
        ApiError::unavailable()
    };
    let enum_of = |s: Option<String>| s.map(Value::String);
    Ok(Some(DecisionState {
        final_decision: enum_of(decision)
            .map(serde_json::from_value::<FinalDecision>)
            .transpose()
            .map_err(corrupt)?,
        final_reason_type: enum_of(reason_type)
            .map(serde_json::from_value::<ReasonType>)
            .transpose()
            .map_err(corrupt)?,
        final_block_wallet: block_wallet,
        final_decline_reasons: reasons
            .map(|r| serde_json::from_str::<Vec<DeclineReason>>(&r))
            .transpose()
            .map_err(corrupt)?,
        decided_by: enum_of(decided_by)
            .map(serde_json::from_value::<DecidedBy>)
            .transpose()
            .map_err(corrupt)?,
        decided_at: decided_at.and_then(|t| DateTime::from_timestamp(t.timestamp(), 0)),
    }))
}

/// `GET /v1/checks/{check_id}/xml` (5.3): 404 unknown, 410 expired.
async fn get_check_xml(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(check_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&state, &headers)?;
    let mut conn = state.redis.clone();
    if let Some(xml) = rstore::get_xml(&mut conn, &check_id).await? {
        return Ok((
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            xml,
        )
            .into_response());
    }
    let known: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM checks WHERE check_id = $1)")
            .bind(&check_id)
            .fetch_one(&state.pool)
            .await?;
    if known {
        Err(ApiError::new(
            StatusCode::GONE,
            "xml_expired",
            "the original XML is no longer stored",
        ))
    } else {
        Err(ApiError::not_found())
    }
}

/// `POST /v1/decisions` (5.4).
async fn post_decision(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let req: DecisionRequest = json_body(&state, &headers, body)?;
    let resp = decisions::decide(&state.pool, &req).await?;
    tracing::info!(
        check_id = %resp.check_id,
        final_decision = resp.final_decision.as_str(),
        "decision stored"
    );
    Ok(Json(resp).into_response())
}

/// `GET /health` (5.5), no authentication.
async fn health(State(state): State<AppState>) -> Response {
    let pg: Result<Option<DateTime<Utc>>, sqlx::Error> = async {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&state.pool)
            .await?;
        sqlx::query_scalar("SELECT last_success_at FROM list_updates WHERE source = 'OFAC'")
            .fetch_optional(&state.pool)
            .await
    }
    .await;
    let mut conn = state.redis.clone();
    let redis_ok = rstore::ping(&mut conn).await.is_ok();

    let (postgres, age) = match pg {
        Ok(t) => ("ok", t.map(|t| (Utc::now() - t).num_hours())),
        Err(_) => ("error", None),
    };
    let healthy = postgres == "ok" && redis_ok;
    let body = json!({
        "status": if healthy { "ok" } else { "degraded" },
        "postgres": postgres,
        "redis": if redis_ok { "ok" } else { "error" },
        "sanctions_list_age_hours": age,
    });
    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body)).into_response()
}

/// Runs FR-80 start-up, the HTTP server with graceful shutdown (FR-81) and `jobs::spawn_all`.
pub async fn serve(env: EnvConfig) -> anyhow::Result<()> {
    let bind_addr = env.bind_addr;
    let state = app::startup(env).await?;
    jobs::spawn_all(state.pool.clone(), state.redis.clone(), state.env.clone());

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("cannot bind {bind_addr}"))?;
    tracing::info!(addr = %bind_addr, "listening");

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let server = axum::serve(listener, router(state)).with_graceful_shutdown(async move {
        let _ = stop_rx.changed().await;
    });
    let mut server = tokio::spawn(server.into_future());

    tokio::select! {
        res = &mut server => {
            res.context("server task failed")?.context("server error")?;
            return Ok(());
        }
        _ = shutdown_signal() => {}
    }

    tracing::info!(
        grace_secs = SHUTDOWN_GRACE.as_secs(),
        "shutdown signal received, draining requests"
    );
    let _ = stop_tx.send(true);
    match tokio::time::timeout(SHUTDOWN_GRACE, &mut server).await {
        Ok(res) => res.context("server task failed")?.context("server error")?,
        Err(_) => {
            tracing::warn!("grace period over, aborting remaining requests");
            server.abort();
        }
    }
    Ok(())
}

/// SIGINT or SIGTERM (Ctrl-C only on non-Unix platforms).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "cannot listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = ctrl_c => {}
                    _ = term.recv() => {}
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "cannot listen for SIGTERM");
                ctrl_c.await;
            }
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
}
