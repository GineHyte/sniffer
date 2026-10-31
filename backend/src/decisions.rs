//! Agent-stage decisions (spec 5.4). Owner: Task 17.

use sqlx::PgPool;

use crate::model::{DecisionRequest, DecisionResponse};

#[derive(Debug, thiserror::Error)]
pub enum DecisionError {
    #[error("invalid_request: {0}")]
    Invalid(String),
    #[error("forbidden_wording")]
    ForbiddenWording,
    #[error("not_found")]
    NotFound,
    #[error("not_pending")]
    NotPending,
    #[error("already_decided")]
    AlreadyDecided,
    #[error("dependency_unavailable")]
    Db(#[from] sqlx::Error),
}

/// Validates and applies one decision in a single transaction (5.4 steps 1-6).
pub async fn decide(
    pool: &PgPool,
    req: &DecisionRequest,
) -> Result<DecisionResponse, DecisionError> {
    let _ = (pool, req);
    Err(DecisionError::Invalid("not implemented".into()))
}
