//! Postgres pool, schema and migrations (spec 3.9).
//!
//! All tables live in schema `sniffer`. [`connect`] creates the schema on a plain
//! connection first, then every pooled connection runs `SET search_path TO sniffer`
//! in `after_connect`, so unqualified table names (including the sqlx migrations
//! table) resolve to that schema.
//!
//! Subject upserts use the SQL from spec 5.4 verbatim. Queries are runtime queries;
//! nothing here needs `DATABASE_URL` at build time.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use rust_decimal::{Decimal, RoundingStrategy};
use sqlx::postgres::{PgConnection, PgPool, PgPoolOptions, PgRow};
use sqlx::{Connection, PgExecutor, Row};

/// Schema that holds every Sniffer table.
pub const SCHEMA: &str = "sniffer";

const CREATE_SCHEMA_SQL: &str = "CREATE SCHEMA IF NOT EXISTS sniffer";
const SET_SEARCH_PATH_SQL: &str = "SET search_path TO sniffer";

/// Migrations embedded from `backend/migrations` at build time.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Opens the pool: creates schema `sniffer` on a plain connection, then builds a pool
/// whose connections all run `SET search_path TO sniffer` (spec 3.9, FR-80).
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let mut conn = PgConnection::connect(database_url).await?;
    sqlx::raw_sql(CREATE_SCHEMA_SQL).execute(&mut conn).await?;
    conn.close().await?;

    PgPoolOptions::new()
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::raw_sql(SET_SEARCH_PATH_SQL).execute(conn).await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await
}

/// Runs the embedded migrations. Idempotent; the `_sqlx_migrations` table lands in
/// schema `sniffer` because of the pool's search_path.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

/// Error for a column value outside the documented domain (spec 3.9 CHECK constraints).
#[derive(Debug, thiserror::Error)]
#[error("unexpected {column} value: {value}")]
pub struct UnknownValue {
    column: &'static str,
    value: String,
}

/// `subjects.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubjectType {
    Wallet,
    Supplier,
    Pair,
}

impl SubjectType {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectType::Wallet => "wallet",
            SubjectType::Supplier => "supplier",
            SubjectType::Pair => "pair",
        }
    }
}

impl fmt::Display for SubjectType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SubjectType {
    type Err = UnknownValue;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "wallet" => Ok(SubjectType::Wallet),
            "supplier" => Ok(SubjectType::Supplier),
            "pair" => Ok(SubjectType::Pair),
            other => Err(UnknownValue {
                column: "subjects.type",
                value: other.to_owned(),
            }),
        }
    }
}

/// `subjects.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectStatus {
    Normal,
    Blocked,
}

impl SubjectStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectStatus::Normal => "normal",
            SubjectStatus::Blocked => "blocked",
        }
    }
}

impl FromStr for SubjectStatus {
    type Err = UnknownValue;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "normal" => Ok(SubjectStatus::Normal),
            "blocked" => Ok(SubjectStatus::Blocked),
            other => Err(UnknownValue {
                column: "subjects.status",
                value: other.to_owned(),
            }),
        }
    }
}

/// `subjects.block_source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockSource {
    Internal,
    Ofac,
}

impl BlockSource {
    /// Column value: `'internal'` or `'OFAC'`.
    pub fn as_str(self) -> &'static str {
        match self {
            BlockSource::Internal => "internal",
            BlockSource::Ofac => "OFAC",
        }
    }
}

impl FromStr for BlockSource {
    type Err = UnknownValue;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "internal" => Ok(BlockSource::Internal),
            "OFAC" => Ok(BlockSource::Ofac),
            other => Err(UnknownValue {
                column: "subjects.block_source",
                value: other.to_owned(),
            }),
        }
    }
}

/// One `subjects` row (without `hash`, which is the map key in [`get_subjects`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Subject {
    pub subject_type: SubjectType,
    pub approved: i32,
    pub rejected_risk: i32,
    pub trust: Decimal,
    pub status: SubjectStatus,
    pub block_source: Option<BlockSource>,
    pub block_reason: Option<String>,
}

impl Subject {
    pub fn is_blocked(&self) -> bool {
        self.status == SubjectStatus::Blocked
    }
}

fn decode<T: FromStr<Err = UnknownValue>>(column: &str, value: &str) -> Result<T, sqlx::Error> {
    value
        .parse()
        .map_err(|e: UnknownValue| sqlx::Error::ColumnDecode {
            index: column.to_owned(),
            source: Box::new(e),
        })
}

fn subject_from_row(row: &PgRow) -> Result<(String, Subject), sqlx::Error> {
    let hash: String = row.try_get("hash")?;
    let subject_type: String = row.try_get("type")?;
    let status: String = row.try_get("status")?;
    let block_source: Option<String> = row.try_get("block_source")?;
    let subject = Subject {
        subject_type: decode("type", &subject_type)?,
        approved: row.try_get("approved")?,
        rejected_risk: row.try_get("rejected_risk")?,
        trust: row.try_get("trust")?,
        status: decode("status", &status)?,
        block_source: block_source
            .as_deref()
            .map(|s| decode("block_source", s))
            .transpose()?,
        block_reason: row.try_get("block_reason")?,
    };
    Ok((hash, subject))
}

/// Trust value as defined in spec 3.9:
/// `clamp(round((approved − 3 × rejected_risk) / (approved + rejected_risk + 5), 3), −1, 1)`,
/// rounding half away from zero like Postgres `round(numeric, 3)`.
/// The database computes this in SQL; this is the reference for tests and callers.
pub fn trust_value(approved: i64, rejected_risk: i64) -> Decimal {
    let numerator = Decimal::from(approved - 3 * rejected_risk);
    let denominator = Decimal::from(approved + rejected_risk + 5);
    (numerator / denominator)
        .round_dp_with_strategy(3, RoundingStrategy::MidpointAwayFromZero)
        .clamp(Decimal::NEGATIVE_ONE, Decimal::ONE)
}

/// Spec 5.4 "approved + 1", verbatim.
pub const APPROVE_SUBJECT_SQL: &str = "\
INSERT INTO subjects (hash, type, approved, rejected_risk, trust, updated_at)
VALUES ($1, $2, 1, 0, round(1::numeric / 6, 3), now())
ON CONFLICT (hash) DO UPDATE SET
  approved   = subjects.approved + 1,
  trust      = greatest(-1, least(1, round(((subjects.approved + 1) - 3 * subjects.rejected_risk)::numeric
                 / ((subjects.approved + 1) + subjects.rejected_risk + 5), 3))),
  updated_at = now()";

/// Spec 5.4 "rejected_risk + 1", verbatim.
pub const REJECT_RISK_SUBJECT_SQL: &str = "\
INSERT INTO subjects (hash, type, approved, rejected_risk, trust, updated_at)
VALUES ($1, $2, 0, 1, round(-3::numeric / 6, 3), now())
ON CONFLICT (hash) DO UPDATE SET
  rejected_risk = subjects.rejected_risk + 1,
  trust         = greatest(-1, least(1, round((subjects.approved - 3 * (subjects.rejected_risk + 1))::numeric
                    / (subjects.approved + (subjects.rejected_risk + 1) + 5), 3))),
  updated_at    = now()";

/// Spec 5.4 block upsert, verbatim. An existing OFAC block stays OFAC.
pub const BLOCK_SUBJECT_INTERNAL_SQL: &str = "\
INSERT INTO subjects (hash, type, status, block_source, block_reason, updated_at)
VALUES ($1, $2, 'blocked', 'internal', $3, now())
ON CONFLICT (hash) DO UPDATE SET
  status       = 'blocked',
  block_source = CASE WHEN subjects.block_source = 'OFAC' THEN 'OFAC' ELSE 'internal' END,
  block_reason = CASE WHEN subjects.block_source = 'OFAC' THEN subjects.block_reason ELSE $3 END,
  updated_at   = now()";

/// The same statement with `'OFAC'` instead of `'internal'` (spec 7.4).
pub const BLOCK_SUBJECT_OFAC_SQL: &str = "\
INSERT INTO subjects (hash, type, status, block_source, block_reason, updated_at)
VALUES ($1, $2, 'blocked', 'OFAC', $3, now())
ON CONFLICT (hash) DO UPDATE SET
  status       = 'blocked',
  block_source = CASE WHEN subjects.block_source = 'OFAC' THEN 'OFAC' ELSE 'OFAC' END,
  block_reason = CASE WHEN subjects.block_source = 'OFAC' THEN subjects.block_reason ELSE $3 END,
  updated_at   = now()";

const GET_SUBJECTS_SQL: &str = "\
SELECT hash, type, approved, rejected_risk, trust, status, block_source, block_reason
FROM subjects
WHERE hash = ANY($1)";

/// `approved + 1` for one subject (spec 5.4). Run inside the check/decision transaction:
/// pass `&mut *tx`.
pub async fn approve_subject<'c>(
    executor: impl PgExecutor<'c>,
    hash: &str,
    subject_type: SubjectType,
) -> Result<(), sqlx::Error> {
    sqlx::query(APPROVE_SUBJECT_SQL)
        .bind(hash)
        .bind(subject_type.as_str())
        .execute(executor)
        .await?;
    Ok(())
}

/// `rejected_risk + 1` for one subject (spec 5.4).
pub async fn reject_risk_subject<'c>(
    executor: impl PgExecutor<'c>,
    hash: &str,
    subject_type: SubjectType,
) -> Result<(), sqlx::Error> {
    sqlx::query(REJECT_RISK_SUBJECT_SQL)
        .bind(hash)
        .bind(subject_type.as_str())
        .execute(executor)
        .await?;
    Ok(())
}

/// Blocks a subject (spec 5.4, 7.4). An existing OFAC block keeps its source and reason.
pub async fn block_subject<'c>(
    executor: impl PgExecutor<'c>,
    hash: &str,
    subject_type: SubjectType,
    source: BlockSource,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let sql = match source {
        BlockSource::Internal => BLOCK_SUBJECT_INTERNAL_SQL,
        BlockSource::Ofac => BLOCK_SUBJECT_OFAC_SQL,
    };
    sqlx::query(sql)
        .bind(hash)
        .bind(subject_type.as_str())
        .bind(reason)
        .execute(executor)
        .await?;
    Ok(())
}

/// Reads the given subjects; hashes without a row are absent from the map.
pub async fn get_subjects<'c, S: AsRef<str>>(
    executor: impl PgExecutor<'c>,
    hashes: &[S],
) -> Result<HashMap<String, Subject>, sqlx::Error> {
    if hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let hashes: Vec<&str> = hashes.iter().map(AsRef::as_ref).collect();
    let rows = sqlx::query(GET_SUBJECTS_SQL)
        .bind(&hashes)
        .fetch_all(executor)
        .await?;
    rows.iter().map(subject_from_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    #[test]
    fn trust_after_six_approvals_is_0_545() {
        // Spec 7.5: supplier A, wallet W1 and pair A/W1 each approved = 6, trust = 0.545.
        assert_eq!(trust_value(6, 0), d("0.545"));
    }

    #[test]
    fn trust_first_insert_values_match_sql_literals() {
        // round(1::numeric / 6, 3) and round(-3::numeric / 6, 3).
        assert_eq!(trust_value(1, 0), d("0.167"));
        assert_eq!(trust_value(0, 1), d("-0.500"));
    }

    #[test]
    fn trust_rounds_half_away_from_zero() {
        // (8 - 9) / 16 = -0.0625: Postgres round gives -0.063 (banker's would give -0.062).
        assert_eq!(trust_value(8, 3), d("-0.063"));
        // 0.6875 -> 0.688.
        assert_eq!(trust_value(11, 0), d("0.688"));
    }

    #[test]
    fn trust_is_clamped() {
        // -30 / 15 = -2 -> -1.
        assert_eq!(trust_value(0, 10), Decimal::NEGATIVE_ONE);
        // 1e6 / (1e6 + 5) = 0.999995 rounds to 1.000 and never exceeds 1.
        assert_eq!(trust_value(1_000_000, 0), Decimal::ONE);
        assert_eq!(trust_value(0, 0), Decimal::ZERO);
    }

    #[test]
    fn ofac_block_sql_is_internal_sql_with_ofac() {
        assert_eq!(
            BLOCK_SUBJECT_INTERNAL_SQL.replace("'internal'", "'OFAC'"),
            BLOCK_SUBJECT_OFAC_SQL
        );
    }

    #[test]
    fn enums_roundtrip_column_values() {
        for t in [
            SubjectType::Wallet,
            SubjectType::Supplier,
            SubjectType::Pair,
        ] {
            assert_eq!(t.as_str().parse::<SubjectType>().unwrap(), t);
        }
        for s in [SubjectStatus::Normal, SubjectStatus::Blocked] {
            assert_eq!(s.as_str().parse::<SubjectStatus>().unwrap(), s);
        }
        assert_eq!(BlockSource::Ofac.as_str(), "OFAC");
        assert_eq!(BlockSource::Internal.as_str(), "internal");
        assert_eq!("OFAC".parse::<BlockSource>().unwrap(), BlockSource::Ofac);
        assert!("ofac".parse::<BlockSource>().is_err());
    }
}
