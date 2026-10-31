//! Shared application state and FR-80 start-up checks. Owner: Task 16.
//!
//! [`startup`] performs every check of FR-80 in order and returns the state the HTTP
//! layer and the check pipeline share. Any error is fatal for `serve` (exit code 1);
//! messages name the failing step but never echo secrets (FR-33).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use redis::aio::MultiplexedConnection;
use sqlx::PgPool;

use crate::config::{Criteria, DataFiles, EnvConfig, MustangMode as EnvMustangMode, SourceMode};
use crate::criteria;
use crate::mustang::{Mustang, MustangMode, MustangSettings};
use crate::sources::{
    Blockfrost, BlockfrostClient, BlockfrostMock, Chainabuse, ChainabuseClient, ChainabuseMock,
    HttpSettings, Vies, ViesClient, ViesMock,
};
use crate::store::{postgres, redis as rstore};

/// Everything a request handler needs. Cheap to clone (pools, connections and `Arc`s).
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub redis: MultiplexedConnection,
    pub env: Arc<EnvConfig>,
    pub criteria: Arc<Criteria>,
    /// `engine.config_sha256`: SHA-256 of the `criteria.json` bytes.
    pub config_sha256: Arc<str>,
    pub data: Arc<DataFiles>,
    pub mustang: Arc<Mustang>,
    pub blockfrost: Blockfrost,
    pub vies: Vies,
    pub chainabuse: Chainabuse,
}

/// FR-80 start-up: the environment is already parsed (6.1). Checks, in order:
/// `criteria.json` + registry ↔ config bijection, data files (mock files only for a
/// source in `mock` mode), schema `sniffer` + migrations, Redis `PING`, and with
/// `MUSTANG_MODE=cli` the existence of `MUSTANG_JAR`.
pub async fn startup(env: EnvConfig) -> anyhow::Result<AppState> {
    let (criteria, config_sha256) = Criteria::load_file(&env.criteria_path())?;
    criteria.validate(&criteria::registry_ids())?;

    let data = DataFiles::load(&env.data_dir)?;
    let http = HttpSettings {
        timeout_ms: env.http_timeout_ms,
    };
    let (blockfrost, vies, chainabuse) = sources(&env, &http)?;

    env.check_mustang_jar()?;

    let pool = postgres::connect(&env.database_url)
        .await
        .context("postgres: connect or create schema sniffer failed")?;
    postgres::migrate(&pool)
        .await
        .context("postgres: migrations failed")?;

    let mut redis = rstore::connect(&env.redis_url)
        .await
        .context("redis: connect failed")?;
    rstore::ping(&mut redis)
        .await
        .context("redis: PING failed")?;

    let mustang = Mustang::new(MustangSettings {
        mode: match env.mustang_mode {
            EnvMustangMode::Cli => MustangMode::Cli,
            EnvMustangMode::Off => MustangMode::Off,
            EnvMustangMode::MockValid => MustangMode::MockValid,
            EnvMustangMode::Daemon => MustangMode::Daemon,
        },
        java_bin: PathBuf::from(&env.java_bin),
        jar: env.mustang_jar.clone(),
        whitelist: env.mustang_rule_whitelist.clone(),
        timeout_ms: env.mustang_timeout_ms,
        max_parallel: env.mustang_max_parallel,
    })
    .await;

    Ok(AppState {
        pool,
        redis,
        env: Arc::new(env),
        criteria: Arc::new(criteria),
        config_sha256: config_sha256.into(),
        data: Arc::new(data),
        mustang: Arc::new(mustang),
        blockfrost,
        vies,
        chainabuse,
    })
}

/// Source facades in `api` or `mock` mode (3.7.6). Mock files are read only for a
/// source that runs in `mock` mode.
fn sources(env: &EnvConfig, http: &HttpSettings) -> anyhow::Result<(Blockfrost, Vies, Chainabuse)> {
    let unavailable = |name: &str| anyhow::anyhow!("{name}: HTTP client could not be built");

    let blockfrost = match env.blockfrost_mode {
        SourceMode::Mock => Blockfrost::Mock(Arc::new(BlockfrostMock::load(&env.data_dir)?)),
        SourceMode::Api => {
            let project_id = env
                .blockfrost_project_id
                .as_deref()
                .context("BLOCKFROST_PROJECT_ID is required when BLOCKFROST_MODE=api")?;
            Blockfrost::Api(
                BlockfrostClient::new(&env.blockfrost_base_url, project_id, http)
                    .map_err(|_| unavailable("blockfrost"))?,
            )
        }
    };
    let vies = match env.vies_mode {
        SourceMode::Mock => Vies::Mock(Arc::new(ViesMock::load(&env.data_dir)?)),
        SourceMode::Api => {
            Vies::Api(ViesClient::new(&env.vies_base_url, http).map_err(|_| unavailable("vies"))?)
        }
    };
    let chainabuse = match env.chainabuse_mode {
        SourceMode::Mock => Chainabuse::Mock(Arc::new(ChainabuseMock::load(&env.data_dir)?)),
        SourceMode::Api => {
            let key = env
                .chainabuse_api_key
                .as_deref()
                .context("CHAINABUSE_API_KEY is required when CHAINABUSE_MODE=api")?;
            Chainabuse::Api(
                ChainabuseClient::new(&env.chainabuse_base_url, key, http)
                    .map_err(|_| unavailable("chainabuse"))?,
            )
        }
    };
    Ok((blockfrost, vies, chainabuse))
}
