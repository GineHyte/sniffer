//! Background jobs: OFAC refresh (FR-71) and retention (FR-76). Owner: Task 18.
//!
//! Each job is one tokio task that awaits its run before scheduling the next, so a job
//! never overlaps itself (7.6). Errors are logged without raw data and never stop the
//! server.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use redis::aio::{ConnectionLike, MultiplexedConnection};
use sqlx::PgPool;
use tokio::time::MissedTickBehavior;

use crate::config::EnvConfig;
use crate::normalize::LegalForms;
use crate::sanctions;
use crate::store::redis::xml_key;

/// Retention job period (FR-76).
pub const RETENTION_PERIOD: Duration = Duration::from_secs(24 * 3600);

/// Spawns all background jobs on the current tokio runtime. Errors are logged, never fatal.
pub fn spawn_all(pool: PgPool, redis: MultiplexedConnection, env: Arc<EnvConfig>) {
    if env.ofac_auto_update {
        tokio::spawn(ofac_job(pool.clone(), env.clone()));
    } else {
        tracing::info!("OFAC auto update disabled (OFAC_AUTO_UPDATE=false)");
    }
    tokio::spawn(crate::payouts::unknown_job(pool.clone()));
    tokio::spawn(retention_job(pool, redis, env));
}

/// `data/legal-forms.json` from `DATA_DIR`.
pub fn load_legal_forms(data_dir: &Path) -> anyhow::Result<LegalForms> {
    let path = data_dir.join("legal-forms.json");
    let json = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
    LegalForms::from_json(&json).map_err(|e| anyhow::anyhow!("legal-forms.json: {e}"))
}

/// Age of the last successful OFAC import, `None` if there was none.
pub async fn ofac_list_age(pool: &PgPool) -> anyhow::Result<Option<Duration>> {
    let secs: Option<f64> = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM (now() - last_success_at))::float8
         FROM list_updates WHERE source = 'OFAC'",
    )
    .fetch_optional(pool)
    .await?;
    Ok(secs.map(|s| Duration::from_secs_f64(s.max(0.0))))
}

/// FR-71: import at start if the list is missing or older than `LISTS_REFRESH_HOURS`,
/// then every `LISTS_REFRESH_HOURS`. A failed import keeps the old state.
async fn ofac_job(pool: PgPool, env: Arc<EnvConfig>) {
    // A zero period would spin; one hour is the smallest meaningful refresh.
    let refresh = Duration::from_secs(env.lists_refresh_hours.max(1) * 3600);
    loop {
        let wait = match ofac_list_age(&pool).await {
            Ok(Some(age)) if age < refresh => refresh - age,
            Ok(_) => {
                run_ofac_import(&pool, &env).await;
                refresh
            }
            Err(e) => {
                tracing::error!(error = %e, "OFAC job: cannot read list age");
                refresh
            }
        };
        tokio::time::sleep(wait).await;
    }
}

async fn run_ofac_import(pool: &PgPool, env: &EnvConfig) {
    let lf = match load_legal_forms(&env.data_dir) {
        Ok(lf) => lf,
        Err(e) => {
            tracing::error!(error = %e, "OFAC update skipped");
            return;
        }
    };
    tracing::info!("OFAC update started");
    match sanctions::import(
        pool,
        &env.hmac_key,
        &lf,
        &env.ofac_sdn_url,
        sanctions::DOWNLOAD_TIMEOUT,
    )
    .await
    {
        Ok(s) => tracing::info!(
            entries = s.entries,
            names = s.names,
            cardano_addresses = s.cardano_addresses,
            unblocked_wallets = s.unblocked_wallets,
            "OFAC update finished"
        ),
        Err(e) => tracing::error!(error = %e, "OFAC update failed; previous list kept"),
    }
}

/// Rows removed by one retention run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetentionStats {
    pub deleted_checks: u64,
    pub deleted_invoices: u64,
    pub deleted_payout_intents: u64,
    /// `check_id`s of deleted `checks` and `invoices` rows (for the Redis XML keys).
    pub check_ids: Vec<String>,
}

/// `payout_intents` exists only once migration `0002_payouts.sql` (12.2) is applied.
pub const PAYOUT_INTENTS_EXISTS_SQL: &str =
    "SELECT to_regclass('sniffer.payout_intents') IS NOT NULL";

/// FR-76 (+ 12.8): in one transaction delete `checks` and `invoices` rows whose
/// `created_at` is older than `retention_days`, and before that the invoices'
/// `payout_intents` if that table exists.
pub async fn run_retention(pool: &PgPool, retention_days: u32) -> anyhow::Result<RetentionStats> {
    let days = i32::try_from(retention_days)?;
    let mut tx = pool.begin().await?;
    let cutoff: DateTime<Utc> = sqlx::query_scalar("SELECT now() - make_interval(days => $1)")
        .bind(days)
        .fetch_one(&mut *tx)
        .await?;

    let mut stats = RetentionStats::default();
    let payouts: bool = sqlx::query_scalar(PAYOUT_INTENTS_EXISTS_SQL)
        .fetch_one(&mut *tx)
        .await?;
    if payouts {
        stats.deleted_payout_intents = sqlx::query(
            "DELETE FROM payout_intents WHERE invoice_hash IN
               (SELECT invoice_hash FROM invoices WHERE created_at < $1)",
        )
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    let checks: Vec<String> =
        sqlx::query_scalar("DELETE FROM checks WHERE created_at < $1 RETURNING check_id")
            .bind(cutoff)
            .fetch_all(&mut *tx)
            .await?;
    let invoices: Vec<String> =
        sqlx::query_scalar("DELETE FROM invoices WHERE created_at < $1 RETURNING check_id")
            .bind(cutoff)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;

    stats.deleted_checks = checks.len() as u64;
    stats.deleted_invoices = invoices.len() as u64;
    let mut ids = checks;
    ids.extend(invoices);
    ids.sort();
    ids.dedup();
    stats.check_ids = ids;
    Ok(stats)
}

/// Deletes `sniffer:xml:<check_id>` for every id; returns the number of removed keys.
pub async fn delete_xml_keys<C: ConnectionLike + Send>(
    conn: &mut C,
    check_ids: &[String],
) -> redis::RedisResult<u64> {
    let mut removed = 0;
    for chunk in check_ids.chunks(500) {
        let mut cmd = redis::cmd("DEL");
        for id in chunk {
            cmd.arg(xml_key(id));
        }
        let n: u64 = cmd.query_async(conn).await?;
        removed += n;
    }
    Ok(removed)
}

/// FR-76: at start and every 24 h.
async fn retention_job(pool: PgPool, mut redis: MultiplexedConnection, env: Arc<EnvConfig>) {
    let mut tick = tokio::time::interval(RETENTION_PERIOD);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        match run_retention(&pool, env.retention_days).await {
            Ok(s) => {
                tracing::info!(
                    deleted_checks = s.deleted_checks,
                    deleted_invoices = s.deleted_invoices,
                    deleted_payout_intents = s.deleted_payout_intents,
                    "retention run finished"
                );
                if let Err(e) = delete_xml_keys(&mut redis, &s.check_ids).await {
                    tracing::warn!(error = %e, "retention: deleting stored XML failed");
                }
            }
            Err(e) => tracing::error!(error = %e, "retention run failed"),
        }
    }
}
