//! `sniffer` binary: clap subcommands (spec 7.1).
//!
//! Every command except `serve` prints exactly one JSON line on stdout; errors go to
//! stderr as one JSON line and the exit code is 1 (7.2). Raw blocklist values are
//! never stored or printed, only their hashes.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use tracing_subscriber::EnvFilter;

use sniffer::config::EnvConfig;
use sniffer::jobs::{self, PAYOUT_INTENTS_EXISTS_SQL};
use sniffer::sanctions;
use sniffer::seed::{self, BlockType};
use sniffer::store::postgres::{self, BlockSource};
use sniffer::store::redis as rstore;

/// Invoice Scam Sniffer – Initial Check (spec v1.0).
#[derive(Debug, Parser)]
#[command(name = "sniffer", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

/// CLI commands per spec §7.1.
#[derive(Debug, Subcommand)]
enum Command {
    /// Start the HTTP server and background jobs (FR-80, §7.6)
    Serve,
    /// Create the schema and run migrations only
    Migrate,
    /// Import the OFAC SDN list (§3.7.5)
    ListsUpdate,
    /// Block a wallet or supplier (stores only the hash)
    BlocklistAdd {
        /// Entry type
        #[arg(long = "type", value_enum)]
        kind: BlockKind,
        /// Raw value (wallet address or VAT ID); never stored or printed
        #[arg(long)]
        value: String,
        /// Reason code, ^[A-Z0-9_]{1,40}$
        #[arg(long)]
        reason: String,
    },
    /// Remove an internal block for a wallet or supplier
    BlocklistRemove {
        /// Entry type
        #[arg(long = "type", value_enum)]
        kind: BlockKind,
        /// Raw value (wallet address or VAT ID); never stored or printed
        #[arg(long)]
        value: String,
    },
    /// Delete all data for a subject hash (GDPR, §7.3)
    SubjectDelete {
        /// Subject hash, format hmac:…
        #[arg(long)]
        hash: String,
    },
    /// Load a seed file (§7.4, §7.5)
    DbSeed {
        /// Path to the seed JSON file
        #[arg(long)]
        file: PathBuf,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BlockKind {
    Wallet,
    Supplier,
}

impl BlockKind {
    fn block_type(self) -> BlockType {
        match self {
            BlockKind::Wallet => BlockType::Wallet,
            BlockKind::Supplier => BlockType::Supplier,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            BlockKind::Wallet => "wallet",
            BlockKind::Supplier => "supplier",
        }
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    // Load .env before tracing so RUST_LOG from .env applies; errors are reported
    // by EnvConfig::from_env.
    let _ = dotenvy::dotenv();
    init_tracing();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return fail(&anyhow::anyhow!("cannot start runtime: {e}")),
    };
    match runtime.block_on(run(cli.command)) {
        Ok(Some(out)) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::SUCCESS,
        Err(e) => fail(&e),
    }
}

fn fail(e: &anyhow::Error) -> ExitCode {
    eprintln!("{}", json!({ "ok": false, "error": format!("{e:#}") }));
    ExitCode::FAILURE
}

fn env() -> anyhow::Result<EnvConfig> {
    Ok(EnvConfig::from_env()?)
}

/// Pool with schema `sniffer` and all migrations applied (idempotent).
async fn open_db(env: &EnvConfig) -> anyhow::Result<PgPool> {
    let pool = postgres::connect(&env.database_url)
        .await
        .map_err(|e| anyhow::anyhow!("postgres: {e}"))?;
    postgres::migrate(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("migrations: {e}"))?;
    Ok(pool)
}

async fn run(command: Command) -> anyhow::Result<Option<Value>> {
    match command {
        Command::Serve => {
            sniffer::api::serve(env()?).await?;
            Ok(None)
        }
        Command::Migrate => {
            let env = env()?;
            open_db(&env).await?;
            Ok(Some(json!({ "ok": true, "migrated": true })))
        }
        Command::ListsUpdate => lists_update(&env()?).await.map(Some),
        Command::BlocklistAdd {
            kind,
            value,
            reason,
        } => blocklist_add(&env()?, kind, &value, &reason)
            .await
            .map(Some),
        Command::BlocklistRemove { kind, value } => {
            blocklist_remove(&env()?, kind, &value).await.map(Some)
        }
        Command::SubjectDelete { hash } => subject_delete(&env()?, &hash).await.map(Some),
        Command::DbSeed { file } => db_seed(&env()?, &file).await.map(Some),
    }
}

async fn lists_update(env: &EnvConfig) -> anyhow::Result<Value> {
    let lf = jobs::load_legal_forms(&env.data_dir)?;
    let pool = open_db(env).await?;
    let stats = sanctions::import(
        &pool,
        &env.hmac_key,
        &lf,
        &env.ofac_sdn_url,
        sanctions::DOWNLOAD_TIMEOUT,
    )
    .await?;
    Ok(json!({
        "ok": true,
        "entries": stats.entries,
        "names": stats.names,
        "cardano_addresses": stats.cardano_addresses,
        "unblocked_wallets": stats.unblocked_wallets,
    }))
}

async fn blocklist_add(
    env: &EnvConfig,
    kind: BlockKind,
    value: &str,
    reason: &str,
) -> anyhow::Result<Value> {
    if !seed::is_valid_reason_code(reason) {
        anyhow::bail!("reason must match ^[A-Z0-9_]{{1,40}}$");
    }
    let hash = seed::block_subject_hash(&env.hmac_key, kind.block_type(), value)?;
    let pool = open_db(env).await?;
    let subject_type = kind.block_type().subject_type();
    postgres::block_subject(&pool, &hash, subject_type, BlockSource::Internal, reason).await?;
    let subjects = postgres::get_subjects(&pool, &[&hash]).await?;
    let source = subjects
        .get(&hash)
        .and_then(|s| s.block_source)
        .map(BlockSource::as_str);
    Ok(json!({
        "ok": true,
        "type": kind.as_str(),
        "hash": hash,
        "status": "blocked",
        "block_source": source,
    }))
}

async fn blocklist_remove(env: &EnvConfig, kind: BlockKind, value: &str) -> anyhow::Result<Value> {
    let hash = seed::block_subject_hash(&env.hmac_key, kind.block_type(), value)?;
    let pool = open_db(env).await?;
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT status, block_source FROM subjects WHERE hash = $1 FOR UPDATE")
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await?;
    let (status, source): (String, Option<String>) = match row {
        Some(r) => (r.try_get("status")?, r.try_get("block_source")?),
        None => anyhow::bail!("{} is not blocked", kind.as_str()),
    };
    match (status.as_str(), source.as_deref()) {
        ("blocked", Some("internal")) => {}
        ("blocked", Some("OFAC")) => anyhow::bail!(
            "{} is blocked by OFAC; only internal blocks can be removed",
            kind.as_str()
        ),
        _ => anyhow::bail!("{} is not blocked", kind.as_str()),
    }
    sqlx::query(
        "UPDATE subjects SET status = 'normal', block_source = NULL, block_reason = NULL,
           updated_at = now()
         WHERE hash = $1 AND block_source = 'internal'",
    )
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({
        "ok": true,
        "type": kind.as_str(),
        "hash": hash,
        "status": "normal",
    }))
}

/// `hmac:` + 64 lowercase hex characters (3.3).
fn is_subject_hash(h: &str) -> bool {
    h.strip_prefix("hmac:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// 7.3 (+ 12.8): one transaction, then the Redis XML keys after the commit.
async fn subject_delete(env: &EnvConfig, h: &str) -> anyhow::Result<Value> {
    if !is_subject_hash(h) {
        anyhow::bail!("hash must match ^hmac:[0-9a-f]{{64}}$");
    }
    // Connect Redis first so an unreachable Redis aborts before anything is deleted.
    let mut redis = rstore::connect(&env.redis_url)
        .await
        .map_err(|e| anyhow::anyhow!("redis: {e}"))?;
    let pool = open_db(env).await?;
    let mut tx = pool.begin().await?;

    // 1. Invoices of the subject.
    let rows = sqlx::query(
        "SELECT invoice_hash, check_id, pair_hash FROM invoices
         WHERE supplier_hash = $1 OR wallet_hash = $1 FOR UPDATE",
    )
    .bind(h)
    .fetch_all(&mut *tx)
    .await?;
    let mut invoice_hashes = Vec::with_capacity(rows.len());
    let mut check_ids = Vec::with_capacity(rows.len());
    let mut pair_hashes = Vec::with_capacity(rows.len());
    for r in &rows {
        invoice_hashes.push(r.try_get::<String, _>("invoice_hash")?);
        check_ids.push(r.try_get::<String, _>("check_id")?);
        pair_hashes.push(r.try_get::<String, _>("pair_hash")?);
    }
    pair_hashes.sort();
    pair_hashes.dedup();

    // 2. Pair subjects.
    let deleted_pairs = sqlx::query("DELETE FROM subjects WHERE hash = ANY($1)")
        .bind(&pair_hashes)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // 3. Checks of these invoices and every check whose result mentions the hash.
    let deleted_checks: Vec<String> = sqlx::query_scalar(
        "DELETE FROM checks
         WHERE check_id = ANY($1) OR result::text LIKE '%' || $2 || '%'
         RETURNING check_id",
    )
    .bind(&check_ids)
    .bind(h)
    .fetch_all(&mut *tx)
    .await?;

    // 12.8: payout intents before the invoices (foreign key), only if the table exists.
    let payouts: bool = sqlx::query_scalar(PAYOUT_INTENTS_EXISTS_SQL)
        .fetch_one(&mut *tx)
        .await?;
    let deleted_payout_intents = if payouts {
        sqlx::query("DELETE FROM payout_intents WHERE invoice_hash = ANY($1) OR wallet_hash = $2")
            .bind(&invoice_hashes)
            .bind(h)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    } else {
        0
    };

    // 4. Invoices.
    let deleted_invoices = sqlx::query("DELETE FROM invoices WHERE invoice_hash = ANY($1)")
        .bind(&invoice_hashes)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    // 5. The subject itself.
    let deleted_subject = sqlx::query("DELETE FROM subjects WHERE hash = $1")
        .bind(h)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;

    // 6. Redis XML keys of the deleted checks (and of the deleted invoices' checks).
    let mut xml_ids = check_ids;
    xml_ids.extend(deleted_checks.iter().cloned());
    xml_ids.sort();
    xml_ids.dedup();
    let deleted_xml = jobs::delete_xml_keys(&mut redis, &xml_ids)
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "database rows deleted, but deleting {} stored XML keys failed: {e}",
                xml_ids.len()
            )
        })?;

    Ok(json!({
        "ok": true,
        "deleted_invoices": deleted_invoices,
        "deleted_checks": deleted_checks.len(),
        "deleted_pairs": deleted_pairs,
        "deleted_subjects": deleted_subject + deleted_pairs,
        "deleted_payout_intents": deleted_payout_intents,
        "deleted_xml_keys": deleted_xml,
    }))
}

async fn db_seed(env: &EnvConfig, file: &std::path::Path) -> anyhow::Result<Value> {
    let json = std::fs::read_to_string(file)
        .map_err(|e| anyhow::anyhow!("cannot read seed file {}: {e}", file.display()))?;
    let lf = jobs::load_legal_forms(&env.data_dir)?;
    let pool = open_db(env).await?;
    let inserted = seed::seed_file(&pool, &env.hmac_key, &lf, &json).await?;
    Ok(json!({ "ok": true, "inserted_invoices": inserted }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_hash_format() {
        let ok = format!("hmac:{}", "a1".repeat(32));
        assert!(is_subject_hash(&ok));
        assert!(!is_subject_hash(&ok.to_uppercase()));
        assert!(!is_subject_hash(&ok[..ok.len() - 1]));
        assert!(!is_subject_hash(&format!("sha:{}", "a1".repeat(32))));
        assert!(!is_subject_hash("hmac:%' OR '1'='1"));
    }

    #[test]
    fn cli_parses_all_commands() {
        for args in [
            vec!["sniffer", "serve"],
            vec!["sniffer", "migrate"],
            vec!["sniffer", "lists-update"],
            vec![
                "sniffer",
                "blocklist-add",
                "--type",
                "wallet",
                "--value",
                "x",
                "--reason",
                "TEST",
            ],
            vec![
                "sniffer",
                "blocklist-remove",
                "--type",
                "supplier",
                "--value",
                "x",
            ],
            vec!["sniffer", "subject-delete", "--hash", "hmac:x"],
            vec!["sniffer", "db-seed", "--file", "seed/seed.json"],
        ] {
            Cli::try_parse_from(&args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
        }
        assert!(Cli::try_parse_from(["sniffer", "blocklist-add", "--type", "pair"]).is_err());
    }
}
