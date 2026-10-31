//! Background jobs: OFAC refresh (FR-71) and retention (FR-76). Owner: Task 18.

use std::sync::Arc;

use redis::aio::MultiplexedConnection;
use sqlx::PgPool;

use crate::config::EnvConfig;

/// Spawns all background jobs on the current tokio runtime. Errors are logged, never fatal.
pub fn spawn_all(pool: PgPool, redis: MultiplexedConnection, env: Arc<EnvConfig>) {
    let _ = (pool, redis, env);
}
