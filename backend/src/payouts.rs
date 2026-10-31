//! Payout policy extension (spec 12, FR-32a). Owner: Task 19.

use axum::Router;

use crate::app::AppState;

/// Routes under `/v1/payouts`. Every handler must call `crate::api::authorize` (FR-08).
pub fn routes() -> Router<AppState> {
    Router::new()
}
