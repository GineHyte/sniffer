//! Supplier history read endpoint (spec 12.6). Owner: Task 20.

use axum::Router;

use crate::app::AppState;

/// Routes under `/v1/suppliers`. Every handler must call `crate::api::authorize` (FR-08).
pub fn routes() -> Router<AppState> {
    Router::new()
}
