//! axum routes and HTTP error mapping (spec 5, FR-01..FR-10). Owner: Task 16.

use crate::config::EnvConfig;

/// Runs FR-80 start-up, the HTTP server with graceful shutdown (FR-81) and `jobs::spawn_all`.
pub async fn serve(env: EnvConfig) -> anyhow::Result<()> {
    let _ = env;
    anyhow::bail!("not implemented")
}
