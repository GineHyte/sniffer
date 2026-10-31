//! Environment, criteria.json and data/ loading and start-up checks (spec 6.1-6.3, FR-80, 12.3).
//!
//! Error messages name the variable or file but never echo a value, so secrets cannot
//! leak through start-up logs (FR-33).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};

use crate::address::Network;
use crate::hashing::{sha256_hex, HmacKey};
use crate::normalize::{self, LegalForms};

/// Start-up configuration error (FR-80: the process exits with code 1).
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("environment variable {0} is required")]
    Missing(&'static str),
    #[error("environment variable {var} is required when {condition}")]
    MissingFor {
        var: &'static str,
        condition: &'static str,
    },
    #[error("environment variable {var} is invalid: {reason}")]
    Invalid { var: &'static str, reason: String },
    #[error(".env: {0}")]
    DotEnv(String),
    #[error("criteria.json: {0}")]
    Criteria(String),
    #[error("data/{file}: {reason}")]
    DataFile { file: &'static str, reason: String },
}

// ---------------------------------------------------------------------------
// 6.1 / 12.3 environment
// ---------------------------------------------------------------------------

/// `BLOCKFROST_MODE`, `VIES_MODE`, `CHAINABUSE_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceMode {
    Api,
    Mock,
}

/// `MUSTANG_MODE` (3.7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MustangMode {
    Cli,
    Off,
    MockValid,
}

pub const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
pub const MIN_API_TOKEN_LEN: usize = 32;
pub const BLOCKFROST_PREPROD_URL: &str = "https://cardano-preprod.blockfrost.io/api/v0";
pub const BLOCKFROST_MAINNET_URL: &str = "https://cardano-mainnet.blockfrost.io/api/v0";
pub const DEFAULT_VIES_BASE_URL: &str = "https://ec.europa.eu/taxation_customs/vies/rest-api";
pub const DEFAULT_CHAINABUSE_BASE_URL: &str = "https://api.chainabuse.com/v0";
pub const DEFAULT_MUSTANG_JAR: &str = "/opt/mustang/Mustang-CLI-2.26.0.jar";
pub const DEFAULT_OFAC_SDN_URL: &str =
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";

/// All variables of spec 6.1 plus the payout additions of 12.3.
/// `Debug` redacts the token, HMAC key, API keys and the database/redis password.
#[derive(Clone)]
pub struct EnvConfig {
    pub bind_addr: SocketAddr,
    pub api_token: String,
    pub hmac_key: HmacKey,
    pub database_url: String,
    pub redis_url: String,
    pub expected_network: Network,
    pub blockfrost_mode: SourceMode,
    pub blockfrost_project_id: Option<String>,
    pub blockfrost_base_url: String,
    pub vies_mode: SourceMode,
    pub vies_base_url: String,
    pub chainabuse_mode: SourceMode,
    pub chainabuse_api_key: Option<String>,
    pub chainabuse_base_url: String,
    pub mustang_mode: MustangMode,
    pub java_bin: String,
    pub mustang_jar: PathBuf,
    pub mustang_rule_whitelist: Vec<String>,
    pub mustang_timeout_ms: u64,
    pub mustang_max_parallel: usize,
    pub http_timeout_ms: u64,
    pub xml_ttl_seconds: u64,
    pub max_xml_bytes: usize,
    pub ofac_sdn_url: String,
    pub ofac_auto_update: bool,
    pub lists_refresh_hours: u64,
    pub lists_max_age_hours: u64,
    pub allow_checked_at: bool,
    pub retention_days: u32,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub rust_log: String,
    /// `None` → payouts disabled (`POST /v1/payouts/authorize` → 409 `payouts_disabled`).
    pub ada_per_eur: Option<Decimal>,
    pub payout_max_ada_per_invoice: u64,
    pub payout_max_ada_per_day: u64,
}

impl EnvConfig {
    /// Loads `.env` (if present) into the process environment, then reads it.
    pub fn from_env() -> Result<Self, ConfigError> {
        if let Err(e) = dotenvy::dotenv() {
            if !e.not_found() {
                return Err(ConfigError::DotEnv(e.to_string()));
            }
        }
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Builds the config from a variable lookup. Empty values count as unset.
    pub fn from_vars(vars: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |name: &'static str| vars(name).filter(|v| !v.is_empty());

        let bind_addr = parse_num(
            "SNIFFER_BIND_ADDR",
            get("SNIFFER_BIND_ADDR"),
            DEFAULT_BIND_ADDR
                .parse::<SocketAddr>()
                .expect("valid default"),
        )?;

        let api_token = required("SNIFFER_API_TOKEN", get("SNIFFER_API_TOKEN"))?;
        if api_token.chars().count() < MIN_API_TOKEN_LEN {
            return Err(invalid(
                "SNIFFER_API_TOKEN",
                format!("must be at least {MIN_API_TOKEN_LEN} characters"),
            ));
        }

        let hmac_key = HmacKey::from_hex(&required("SNIFFER_HMAC_KEY", get("SNIFFER_HMAC_KEY"))?)
            .map_err(|e| invalid("SNIFFER_HMAC_KEY", e.to_string()))?;

        let database_url = required("DATABASE_URL", get("DATABASE_URL"))?;
        let redis_url = required("REDIS_URL", get("REDIS_URL"))?;

        let expected_network = choice(
            "EXPECTED_NETWORK",
            get("EXPECTED_NETWORK"),
            Network::Preprod,
            &[("preprod", Network::Preprod), ("mainnet", Network::Mainnet)],
        )?;

        let blockfrost_mode =
            source_mode("BLOCKFROST_MODE", get("BLOCKFROST_MODE"), SourceMode::Api)?;
        let blockfrost_project_id = get("BLOCKFROST_PROJECT_ID");
        if blockfrost_mode == SourceMode::Api && blockfrost_project_id.is_none() {
            return Err(ConfigError::MissingFor {
                var: "BLOCKFROST_PROJECT_ID",
                condition: "BLOCKFROST_MODE=api",
            });
        }
        let blockfrost_base_url = get("BLOCKFROST_BASE_URL").unwrap_or_else(|| {
            match expected_network {
                Network::Preprod => BLOCKFROST_PREPROD_URL,
                Network::Mainnet => BLOCKFROST_MAINNET_URL,
            }
            .to_string()
        });

        let vies_mode = source_mode("VIES_MODE", get("VIES_MODE"), SourceMode::Api)?;
        let vies_base_url =
            get("VIES_BASE_URL").unwrap_or_else(|| DEFAULT_VIES_BASE_URL.to_string());

        let chainabuse_mode =
            source_mode("CHAINABUSE_MODE", get("CHAINABUSE_MODE"), SourceMode::Mock)?;
        let chainabuse_api_key = get("CHAINABUSE_API_KEY");
        if chainabuse_mode == SourceMode::Api && chainabuse_api_key.is_none() {
            return Err(ConfigError::MissingFor {
                var: "CHAINABUSE_API_KEY",
                condition: "CHAINABUSE_MODE=api",
            });
        }
        let chainabuse_base_url =
            get("CHAINABUSE_BASE_URL").unwrap_or_else(|| DEFAULT_CHAINABUSE_BASE_URL.to_string());

        let mustang_mode = choice(
            "MUSTANG_MODE",
            get("MUSTANG_MODE"),
            MustangMode::Cli,
            &[
                ("cli", MustangMode::Cli),
                ("off", MustangMode::Off),
                ("mock_valid", MustangMode::MockValid),
            ],
        )?;
        let java_bin = get("JAVA_BIN").unwrap_or_else(|| "java".to_string());
        let mustang_jar =
            PathBuf::from(get("MUSTANG_JAR").unwrap_or_else(|| DEFAULT_MUSTANG_JAR.to_string()));
        let mustang_rule_whitelist = get("MUSTANG_RULE_WHITELIST")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mustang_timeout_ms =
            parse_num("MUSTANG_TIMEOUT_MS", get("MUSTANG_TIMEOUT_MS"), 20_000)?;
        let mustang_max_parallel: usize =
            parse_num("MUSTANG_MAX_PARALLEL", get("MUSTANG_MAX_PARALLEL"), 2)?;
        if mustang_max_parallel < 1 {
            return Err(invalid("MUSTANG_MAX_PARALLEL", "must be at least 1".into()));
        }

        let http_timeout_ms = parse_num("HTTP_TIMEOUT_MS", get("HTTP_TIMEOUT_MS"), 5_000)?;
        let xml_ttl_seconds = parse_num("XML_TTL_SECONDS", get("XML_TTL_SECONDS"), 86_400)?;
        let max_xml_bytes = parse_num("MAX_XML_BYTES", get("MAX_XML_BYTES"), 500_000)?;
        let ofac_sdn_url = get("OFAC_SDN_URL").unwrap_or_else(|| DEFAULT_OFAC_SDN_URL.to_string());
        let ofac_auto_update = parse_bool("OFAC_AUTO_UPDATE", get("OFAC_AUTO_UPDATE"), true)?;
        let lists_refresh_hours = parse_num("LISTS_REFRESH_HOURS", get("LISTS_REFRESH_HOURS"), 12)?;
        let lists_max_age_hours = parse_num("LISTS_MAX_AGE_HOURS", get("LISTS_MAX_AGE_HOURS"), 48)?;
        let allow_checked_at = parse_bool("ALLOW_CHECKED_AT", get("ALLOW_CHECKED_AT"), false)?;
        let retention_days = parse_num("RETENTION_DAYS", get("RETENTION_DAYS"), 730)?;
        let config_dir = PathBuf::from(get("CONFIG_DIR").unwrap_or_else(|| "./config".into()));
        let data_dir = PathBuf::from(get("DATA_DIR").unwrap_or_else(|| "./data".into()));
        let rust_log = get("RUST_LOG").unwrap_or_else(|| "info".into());

        let ada_per_eur = get("ADA_PER_EUR")
            .map(|v| parse_ada_per_eur(&v))
            .transpose()?;
        let payout_max_ada_per_invoice = parse_positive(
            "PAYOUT_MAX_ADA_PER_INVOICE",
            get("PAYOUT_MAX_ADA_PER_INVOICE"),
            50,
        )?;
        let payout_max_ada_per_day =
            parse_positive("PAYOUT_MAX_ADA_PER_DAY", get("PAYOUT_MAX_ADA_PER_DAY"), 200)?;

        Ok(Self {
            bind_addr,
            api_token,
            hmac_key,
            database_url,
            redis_url,
            expected_network,
            blockfrost_mode,
            blockfrost_project_id,
            blockfrost_base_url,
            vies_mode,
            vies_base_url,
            chainabuse_mode,
            chainabuse_api_key,
            chainabuse_base_url,
            mustang_mode,
            java_bin,
            mustang_jar,
            mustang_rule_whitelist,
            mustang_timeout_ms,
            mustang_max_parallel,
            http_timeout_ms,
            xml_ttl_seconds,
            max_xml_bytes,
            ofac_sdn_url,
            ofac_auto_update,
            lists_refresh_hours,
            lists_max_age_hours,
            allow_checked_at,
            retention_days,
            config_dir,
            data_dir,
            rust_log,
            ada_per_eur,
            payout_max_ada_per_invoice,
            payout_max_ada_per_day,
        })
    }

    /// FR-80: with `MUSTANG_MODE=cli` the JAR must exist. Separate from
    /// [`EnvConfig::from_vars`] so parsing stays free of file-system access.
    pub fn check_mustang_jar(&self) -> Result<(), ConfigError> {
        if self.mustang_mode == MustangMode::Cli && !self.mustang_jar.is_file() {
            return Err(invalid(
                "MUSTANG_JAR",
                "file does not exist (required with MUSTANG_MODE=cli)".into(),
            ));
        }
        Ok(())
    }

    /// `CONFIG_DIR/criteria.json`.
    pub fn criteria_path(&self) -> PathBuf {
        self.config_dir.join("criteria.json")
    }
}

const REDACTED: &str = "<redacted>";

impl fmt::Debug for EnvConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let secret = |v: &Option<String>| v.as_ref().map(|_| REDACTED);
        f.debug_struct("EnvConfig")
            .field("bind_addr", &self.bind_addr)
            .field("api_token", &REDACTED)
            .field("hmac_key", &self.hmac_key)
            .field("database_url", &redact_url_password(&self.database_url))
            .field("redis_url", &redact_url_password(&self.redis_url))
            .field("expected_network", &self.expected_network)
            .field("blockfrost_mode", &self.blockfrost_mode)
            .field(
                "blockfrost_project_id",
                &secret(&self.blockfrost_project_id),
            )
            .field("blockfrost_base_url", &self.blockfrost_base_url)
            .field("vies_mode", &self.vies_mode)
            .field("vies_base_url", &self.vies_base_url)
            .field("chainabuse_mode", &self.chainabuse_mode)
            .field("chainabuse_api_key", &secret(&self.chainabuse_api_key))
            .field("chainabuse_base_url", &self.chainabuse_base_url)
            .field("mustang_mode", &self.mustang_mode)
            .field("java_bin", &self.java_bin)
            .field("mustang_jar", &self.mustang_jar)
            .field("mustang_rule_whitelist", &self.mustang_rule_whitelist)
            .field("mustang_timeout_ms", &self.mustang_timeout_ms)
            .field("mustang_max_parallel", &self.mustang_max_parallel)
            .field("http_timeout_ms", &self.http_timeout_ms)
            .field("xml_ttl_seconds", &self.xml_ttl_seconds)
            .field("max_xml_bytes", &self.max_xml_bytes)
            .field("ofac_sdn_url", &self.ofac_sdn_url)
            .field("ofac_auto_update", &self.ofac_auto_update)
            .field("lists_refresh_hours", &self.lists_refresh_hours)
            .field("lists_max_age_hours", &self.lists_max_age_hours)
            .field("allow_checked_at", &self.allow_checked_at)
            .field("retention_days", &self.retention_days)
            .field("config_dir", &self.config_dir)
            .field("data_dir", &self.data_dir)
            .field("rust_log", &self.rust_log)
            .field("ada_per_eur", &self.ada_per_eur)
            .field(
                "payout_max_ada_per_invoice",
                &self.payout_max_ada_per_invoice,
            )
            .field("payout_max_ada_per_day", &self.payout_max_ada_per_day)
            .finish()
    }
}

/// Replaces the password of `scheme://user:password@host/...` and any `password=`
/// query parameter. Strings without `://` are redacted entirely.
fn redact_url_password(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return REDACTED.to_string();
    };
    let rest_start = scheme_end + 3;
    let rest = &url[rest_start..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let mut out = match authority.rfind('@') {
        Some(at) => match authority[..at].find(':') {
            Some(colon) => format!(
                "{}{}:{REDACTED}{}",
                &url[..rest_start],
                &authority[..colon],
                &rest[at..]
            ),
            None => url.to_string(),
        },
        None => url.to_string(),
    };
    if let Some(q) = out.find('?') {
        let (head, query) = out.split_at(q + 1);
        let query: Vec<String> = query
            .split('&')
            .map(|kv| match kv.split_once('=') {
                Some((k, _)) if k.eq_ignore_ascii_case("password") => format!("{k}={REDACTED}"),
                _ => kv.to_string(),
            })
            .collect();
        out = format!("{head}{}", query.join("&"));
    }
    out
}

fn invalid(var: &'static str, reason: String) -> ConfigError {
    ConfigError::Invalid { var, reason }
}

fn required(var: &'static str, v: Option<String>) -> Result<String, ConfigError> {
    v.ok_or(ConfigError::Missing(var))
}

fn parse_num<T: FromStr>(
    var: &'static str,
    v: Option<String>,
    default: T,
) -> Result<T, ConfigError> {
    match v {
        None => Ok(default),
        Some(s) => s
            .parse()
            .map_err(|_| invalid(var, "not a valid value of the expected format".into())),
    }
}

fn parse_positive(var: &'static str, v: Option<String>, default: u64) -> Result<u64, ConfigError> {
    let n: u64 = parse_num(var, v, default)?;
    if n < 1 {
        return Err(invalid(var, "must be an integer >= 1".into()));
    }
    Ok(n)
}

/// Strictly `true` or `false`.
fn parse_bool(var: &'static str, v: Option<String>, default: bool) -> Result<bool, ConfigError> {
    choice(var, v, default, &[("true", true), ("false", false)])
}

fn source_mode(
    var: &'static str,
    v: Option<String>,
    default: SourceMode,
) -> Result<SourceMode, ConfigError> {
    choice(
        var,
        v,
        default,
        &[("api", SourceMode::Api), ("mock", SourceMode::Mock)],
    )
}

fn choice<T: Copy>(
    var: &'static str,
    v: Option<String>,
    default: T,
    options: &[(&str, T)],
) -> Result<T, ConfigError> {
    let Some(s) = v else { return Ok(default) };
    options
        .iter()
        .find(|(name, _)| *name == s)
        .map(|(_, t)| *t)
        .ok_or_else(|| {
            let names: Vec<&str> = options.iter().map(|(n, _)| *n).collect();
            invalid(var, format!("must be one of {}", names.join(" | ")))
        })
}

/// 12.3: `^[0-9]+(\.[0-9]{1,6})?$` and > 0.
fn parse_ada_per_eur(s: &str) -> Result<Decimal, ConfigError> {
    let err = || {
        invalid(
            "ADA_PER_EUR",
            "must match ^[0-9]+(\\.[0-9]{1,6})?$ and be > 0".into(),
        )
    };
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || frac.is_some_and(|f| !digits(f) || f.len() > 6) {
        return Err(err());
    }
    let d = Decimal::from_str_exact(s).map_err(|_| err())?;
    if d <= Decimal::ZERO {
        return Err(err());
    }
    Ok(d)
}

// ---------------------------------------------------------------------------
// 6.2 criteria.json
// ---------------------------------------------------------------------------

/// The six `checks_incomplete` codes; `incomplete_tasks` must have exactly these keys.
pub const INCOMPLETE_CODES: [&str; 6] = [
    "BLOCKFROST_UNAVAILABLE",
    "CHAINABUSE_UNAVAILABLE",
    "CURRENCY_NOT_EUR",
    "MUSTANG_UNAVAILABLE",
    "SANCTIONS_LIST_STALE",
    "VIES_UNAVAILABLE",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ko,
    Score,
    Reducer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Invoice,
    Wallet,
    Research,
}

impl Agent {
    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Invoice => "invoice",
            Agent::Wallet => "wallet",
            Agent::Research => "research",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasonType {
    Formal,
    Risk,
}

impl ReasonType {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasonType::Formal => "formal",
            ReasonType::Risk => "risk",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bands {
    pub medium_min: i32,
    pub high_min: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    #[serde(deserialize_with = "de_decimal")]
    pub new_wallet_limit_eur: Decimal,
    #[serde(deserialize_with = "de_decimal")]
    pub max_invoice_eur: Decimal,
    #[serde(deserialize_with = "de_decimal")]
    pub round_amount_multiple_eur: Decimal,
    #[serde(deserialize_with = "de_decimal_vec")]
    pub approval_thresholds_eur: Vec<Decimal>,
    pub threshold_margin_percent: i64,
    pub median_factor: i64,
    pub median_min_invoices: i64,
    pub issue_date_max_age_days: i64,
    pub due_min_days: i64,
    #[serde(deserialize_with = "de_decimal")]
    pub wallet_trust_reducer_min: Decimal,
    pub pair_reducer_min_approved: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointsTier {
    pub below_days: i64,
    pub points: i32,
}

/// One `criteria[]` entry.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CriterionCfg {
    pub id: String,
    pub kind: Kind,
    pub reason_type: Option<ReasonType>,
    pub points: Option<i32>,
    pub points_tiers: Option<Vec<PointsTier>>,
    pub name: String,
    pub agent: Option<Agent>,
    pub customer_text: Option<String>,
    pub agent_task: Option<String>,
}

/// Name used by the `Criterion` trait in spec 3.6.0.
pub type CriterionConfig = CriterionCfg;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncompleteTask {
    pub agent: Agent,
    pub task: String,
}

/// `config/criteria.json` (6.2). `criteria` keeps catalog order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Criteria {
    pub version: String,
    pub bands: Bands,
    pub ko_points: i32,
    pub reducer_cap: i32,
    pub reducers_blocked_by_points: i32,
    pub params: Params,
    pub criteria: Vec<CriterionCfg>,
    pub incomplete_tasks: BTreeMap<String, IncompleteTask>,
}

fn de_decimal<'de, D: Deserializer<'de>>(d: D) -> Result<Decimal, D::Error> {
    let s = String::deserialize(d)?;
    Decimal::from_str_exact(&s).map_err(serde::de::Error::custom)
}

fn de_decimal_vec<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Decimal>, D::Error> {
    Vec::<String>::deserialize(d)?
        .iter()
        .map(|s| Decimal::from_str_exact(s).map_err(serde::de::Error::custom))
        .collect()
}

fn has_forbidden_word(s: &str) -> bool {
    let l = s.to_lowercase();
    l.contains("betrug") || l.contains("fraud")
}

fn non_blank(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|t| !t.trim().is_empty())
}

impl Criteria {
    /// Parses the raw bytes and returns the config with `sha256_hex(bytes)`
    /// (`engine.config_sha256`). Does not run [`Criteria::validate`].
    pub fn load(bytes: &[u8]) -> Result<(Self, String), ConfigError> {
        let criteria: Self =
            serde_json::from_slice(bytes).map_err(|e| ConfigError::Criteria(e.to_string()))?;
        Ok((criteria, sha256_hex(bytes)))
    }

    /// Reads and parses `path`.
    pub fn load_file(path: &Path) -> Result<(Self, String), ConfigError> {
        let bytes = std::fs::read(path)
            .map_err(|e| ConfigError::Criteria(format!("cannot read {}: {e}", path.display())))?;
        Self::load(&bytes)
    }

    pub fn get(&self, id: &str) -> Option<&CriterionCfg> {
        self.criteria.iter().find(|c| c.id == id)
    }

    /// Start-up check (FR-80, 6.2) plus registry ↔ config bijection (FR-53).
    pub fn validate(&self, registry_ids: &[&str]) -> Result<(), ConfigError> {
        let err = |m: String| Err(ConfigError::Criteria(m));

        let mut seen = HashSet::new();
        for c in &self.criteria {
            let id = &c.id;
            if !seen.insert(id.as_str()) {
                return err(format!("duplicate criterion id {id}"));
            }
            match c.kind {
                Kind::Ko => {
                    if c.reason_type.is_none() {
                        return err(format!("{id}: kind ko requires reason_type"));
                    }
                }
                Kind::Score => {
                    match (c.points, &c.points_tiers) {
                        (Some(_), None) => {}
                        (None, Some(t)) if !t.is_empty() => {}
                        (None, Some(_)) => {
                            return err(format!("{id}: points_tiers must not be empty"))
                        }
                        (None, None) => {
                            return err(format!("{id}: kind score requires points or points_tiers"))
                        }
                        (Some(_), Some(_)) => {
                            return err(format!(
                                "{id}: kind score takes points or points_tiers, not both"
                            ))
                        }
                    }
                    if !non_blank(&c.agent_task) {
                        return err(format!("{id}: kind score requires agent_task"));
                    }
                }
                Kind::Reducer => {
                    if !c.points.is_some_and(|p| p < 0) {
                        return err(format!("{id}: kind reducer requires negative points"));
                    }
                }
            }
            if matches!(c.kind, Kind::Ko | Kind::Score) {
                if c.agent.is_none() {
                    return err(format!("{id}: kind {:?} requires agent", c.kind));
                }
                if !non_blank(&c.customer_text) {
                    return err(format!("{id}: kind {:?} requires customer_text", c.kind));
                }
            }
            let texts = [
                Some(&c.name),
                c.customer_text.as_ref(),
                c.agent_task.as_ref(),
            ];
            if texts.into_iter().flatten().any(|t| has_forbidden_word(t)) {
                return err(format!("{id}: texts must not contain Betrug or Fraud"));
            }
        }

        let keys: BTreeSet<&str> = self.incomplete_tasks.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = INCOMPLETE_CODES.into_iter().collect();
        if keys != expected {
            let missing: Vec<&str> = expected.difference(&keys).copied().collect();
            let extra: Vec<&str> = keys.difference(&expected).copied().collect();
            return err(format!(
                "incomplete_tasks keys must be exactly {expected:?} (missing {missing:?}, unexpected {extra:?})"
            ));
        }
        for (code, t) in &self.incomplete_tasks {
            if t.task.trim().is_empty() {
                return err(format!("incomplete_tasks.{code}: task must not be empty"));
            }
            if has_forbidden_word(&t.task) {
                return err(format!(
                    "incomplete_tasks.{code}: texts must not contain Betrug or Fraud"
                ));
            }
        }

        let mut registry = HashSet::new();
        for id in registry_ids {
            if !registry.insert(*id) {
                return err(format!("registry lists criterion {id} twice"));
            }
            if !seen.contains(id) {
                return err(format!(
                    "registry criterion {id} has no entry in criteria.json"
                ));
            }
        }
        if let Some(c) = self
            .criteria
            .iter()
            .find(|c| !registry.contains(c.id.as_str()))
        {
            return err(format!(
                "criterion {} has no implementation in the registry",
                c.id
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 6.3 data/
// ---------------------------------------------------------------------------

/// One `pressure-words.json` entry, pre-normalized for I-5.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PressureWord {
    /// Normalized form (`tokens(..).join(" ")`), used in the I-5 evidence.
    pub normalized: String,
    /// `phrase_text(entry)`, compared against `phrase_text` of invoice texts.
    pub phrase: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HighRiskCountries {
    pub as_of: NaiveDate,
    #[serde(default)]
    pub sources: Vec<String>,
    pub countries: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuyerMaster {
    pub name: String,
    pub vat_id: String,
    pub postcode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenOrder {
    pub order_id: String,
    pub supplier_vat_id: String,
    /// Optional ordered gross total (decimal string, comparable with BT-112).
    #[serde(default, with = "rust_decimal::serde::str_option")]
    pub ordered_total: Option<Decimal>,
    /// ISO 4217 code of `ordered_total`.
    #[serde(default)]
    pub currency: Option<String>,
    /// Optional free-text description of the ordered goods or services.
    #[serde(default)]
    pub description: Option<String>,
}

/// All non-mock files of `DATA_DIR` (6.3).
#[derive(Debug, Clone)]
pub struct DataFiles {
    pub legal_forms: LegalForms,
    pub pressure_words: Vec<PressureWord>,
    pub freemail_domains: HashSet<String>,
    pub high_risk_countries: HighRiskCountries,
    pub buyer_master: BuyerMaster,
    pub open_orders: Vec<OpenOrder>,
}

fn read_data(dir: &Path, file: &'static str) -> Result<String, ConfigError> {
    std::fs::read_to_string(dir.join(file)).map_err(|e| ConfigError::DataFile {
        file,
        reason: e.to_string(),
    })
}

fn parse_data<T: for<'de> Deserialize<'de>>(
    dir: &Path,
    file: &'static str,
) -> Result<T, ConfigError> {
    serde_json::from_str(&read_data(dir, file)?).map_err(|e| ConfigError::DataFile {
        file,
        reason: e.to_string(),
    })
}

impl DataFiles {
    pub fn load(dir: &Path) -> Result<Self, ConfigError> {
        const LEGAL: &str = "legal-forms.json";
        const PRESSURE: &str = "pressure-words.json";
        const HIGH_RISK: &str = "high-risk-countries.json";

        let legal_forms =
            LegalForms::from_json(&read_data(dir, LEGAL)?).map_err(|e| ConfigError::DataFile {
                file: LEGAL,
                reason: e.to_string(),
            })?;

        let raw: Vec<String> = parse_data(dir, PRESSURE)?;
        let mut pressure_words = Vec::with_capacity(raw.len());
        for w in &raw {
            let normalized = normalize::tokens(w).join(" ");
            if normalized.is_empty() {
                return Err(ConfigError::DataFile {
                    file: PRESSURE,
                    reason: "entry without letters or digits".into(),
                });
            }
            pressure_words.push(PressureWord {
                normalized,
                phrase: normalize::phrase_text(w),
            });
        }

        let freemail_domains: HashSet<String> = parse_data(dir, "freemail-domains.json")?;

        let high_risk_countries: HighRiskCountries = parse_data(dir, HIGH_RISK)?;
        if let Some(c) = high_risk_countries
            .countries
            .iter()
            .find(|c| c.len() != 2 || !c.bytes().all(|b| b.is_ascii_uppercase()))
        {
            return Err(ConfigError::DataFile {
                file: HIGH_RISK,
                reason: format!("country {c:?} is not an ISO 3166-1 alpha-2 code"),
            });
        }

        Ok(Self {
            legal_forms,
            pressure_words,
            freemail_domains,
            high_risk_countries,
            buyer_master: parse_data(dir, "buyer-master.json")?,
            open_orders: parse_data(dir, "open-orders.json")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const TOKEN: &str = "tok_0123456789abcdef0123456789abcdef";
    const SHIPPED: &[u8] = include_bytes!("../config/criteria.json");

    /// Spec 6.2 catalog order.
    const ALL_IDS: [&str; 30] = [
        "KO-1", "KO-2", "KO-3", "KO-4", "KO-6", "S-1", "S-2", "S-3", "S-4", "S-7", "S-8", "S-9",
        "W-1", "W-2", "W-4", "W-6", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7", "I-8", "I-10",
        "I-11", "I-12", "T-1", "T-2", "T-3", "T-4",
    ];

    fn base() -> HashMap<&'static str, String> {
        HashMap::from([
            ("SNIFFER_API_TOKEN", TOKEN.to_string()),
            ("SNIFFER_HMAC_KEY", KEY.to_string()),
            (
                "DATABASE_URL",
                "postgres://sniffer:pgsecret@localhost:5432/sniffer".to_string(),
            ),
            ("REDIS_URL", "redis://localhost:6380".to_string()),
            ("BLOCKFROST_PROJECT_ID", "preprodBFSECRET".to_string()),
        ])
    }

    fn env(vars: &HashMap<&'static str, String>) -> Result<EnvConfig, ConfigError> {
        EnvConfig::from_vars(|k| vars.get(k).cloned())
    }

    fn with(pairs: &[(&'static str, &str)]) -> Result<EnvConfig, ConfigError> {
        let mut v = base();
        for (k, val) in pairs {
            v.insert(k, val.to_string());
        }
        env(&v)
    }

    fn invalid_var(r: Result<EnvConfig, ConfigError>) -> &'static str {
        match r {
            Err(ConfigError::Invalid { var, .. }) => var,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn env_defaults() {
        let c = env(&base()).unwrap();
        assert_eq!(c.bind_addr, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.expected_network, Network::Preprod);
        assert_eq!(c.blockfrost_mode, SourceMode::Api);
        assert_eq!(c.blockfrost_base_url, BLOCKFROST_PREPROD_URL);
        assert_eq!(c.vies_mode, SourceMode::Api);
        assert_eq!(c.vies_base_url, DEFAULT_VIES_BASE_URL);
        assert_eq!(c.chainabuse_mode, SourceMode::Mock);
        assert_eq!(c.chainabuse_api_key, None);
        assert_eq!(c.chainabuse_base_url, DEFAULT_CHAINABUSE_BASE_URL);
        assert_eq!(c.mustang_mode, MustangMode::Cli);
        assert_eq!(c.java_bin, "java");
        assert_eq!(c.mustang_jar, PathBuf::from(DEFAULT_MUSTANG_JAR));
        assert!(c.mustang_rule_whitelist.is_empty());
        assert_eq!(c.mustang_timeout_ms, 20_000);
        assert_eq!(c.mustang_max_parallel, 2);
        assert_eq!(c.http_timeout_ms, 5_000);
        assert_eq!(c.xml_ttl_seconds, 86_400);
        assert_eq!(c.max_xml_bytes, 500_000);
        assert_eq!(c.ofac_sdn_url, DEFAULT_OFAC_SDN_URL);
        assert!(c.ofac_auto_update);
        assert_eq!(c.lists_refresh_hours, 12);
        assert_eq!(c.lists_max_age_hours, 48);
        assert!(!c.allow_checked_at);
        assert_eq!(c.retention_days, 730);
        assert_eq!(c.config_dir, PathBuf::from("./config"));
        assert_eq!(c.data_dir, PathBuf::from("./data"));
        assert_eq!(
            c.criteria_path(),
            PathBuf::from("./config").join("criteria.json")
        );
        assert_eq!(c.rust_log, "info");
        assert_eq!(c.ada_per_eur, None);
        assert_eq!(c.payout_max_ada_per_invoice, 50);
        assert_eq!(c.payout_max_ada_per_day, 200);
    }

    #[test]
    fn env_each_required_var_missing() {
        for var in [
            "SNIFFER_API_TOKEN",
            "SNIFFER_HMAC_KEY",
            "DATABASE_URL",
            "REDIS_URL",
        ] {
            let mut v = base();
            v.remove(var);
            let e = env(&v).unwrap_err();
            assert!(
                matches!(e, ConfigError::Missing(n) if n == var),
                "{var}: {e:?}"
            );
            assert!(e.to_string().contains(var));
            // Empty counts as missing.
            v.insert(var, String::new());
            assert!(matches!(env(&v), Err(ConfigError::Missing(n)) if n == var));
        }
    }

    #[test]
    fn env_blockfrost_project_id_required_only_in_api_mode() {
        let mut v = base();
        v.remove("BLOCKFROST_PROJECT_ID");
        let e = env(&v).unwrap_err();
        assert!(
            matches!(
                e,
                ConfigError::MissingFor {
                    var: "BLOCKFROST_PROJECT_ID",
                    ..
                }
            ),
            "{e:?}"
        );
        assert!(e.to_string().contains("BLOCKFROST_PROJECT_ID"));
        v.insert("BLOCKFROST_MODE", "mock".into());
        let c = env(&v).unwrap();
        assert_eq!(c.blockfrost_mode, SourceMode::Mock);
        assert_eq!(c.blockfrost_project_id, None);
    }

    #[test]
    fn env_chainabuse_key_required_only_in_api_mode() {
        let e = with(&[("CHAINABUSE_MODE", "api")]).unwrap_err();
        assert!(
            matches!(
                e,
                ConfigError::MissingFor {
                    var: "CHAINABUSE_API_KEY",
                    ..
                }
            ),
            "{e:?}"
        );
        let c = with(&[("CHAINABUSE_MODE", "api"), ("CHAINABUSE_API_KEY", "ca-key")]).unwrap();
        assert_eq!(c.chainabuse_mode, SourceMode::Api);
        assert_eq!(c.chainabuse_api_key.as_deref(), Some("ca-key"));
    }

    #[test]
    fn env_blockfrost_base_url_follows_network() {
        let c = with(&[("EXPECTED_NETWORK", "mainnet")]).unwrap();
        assert_eq!(c.expected_network, Network::Mainnet);
        assert_eq!(c.blockfrost_base_url, BLOCKFROST_MAINNET_URL);
        let c = with(&[
            ("EXPECTED_NETWORK", "mainnet"),
            ("BLOCKFROST_BASE_URL", "http://127.0.0.1:9999"),
        ])
        .unwrap();
        assert_eq!(c.blockfrost_base_url, "http://127.0.0.1:9999");
    }

    #[test]
    fn env_token_min_length() {
        let short = "x".repeat(31);
        assert_eq!(
            invalid_var(with(&[("SNIFFER_API_TOKEN", short.as_str())])),
            "SNIFFER_API_TOKEN"
        );
        assert!(with(&[("SNIFFER_API_TOKEN", "x".repeat(32).as_str())]).is_ok());
    }

    #[test]
    fn env_hmac_key_rules() {
        assert_eq!(
            invalid_var(with(&[("SNIFFER_HMAC_KEY", &KEY[..62])])),
            "SNIFFER_HMAC_KEY"
        );
        let bad = format!("{}zz", &KEY[..62]);
        let e = with(&[("SNIFFER_HMAC_KEY", bad.as_str())]).unwrap_err();
        assert!(!e.to_string().contains(&bad), "{e}");
        assert!(matches!(
            e,
            ConfigError::Invalid {
                var: "SNIFFER_HMAC_KEY",
                ..
            }
        ));
    }

    #[test]
    fn env_enums_reject_unknown_values() {
        for (var, bad) in [
            ("EXPECTED_NETWORK", "testnet"),
            ("BLOCKFROST_MODE", "API"),
            ("VIES_MODE", "off"),
            ("CHAINABUSE_MODE", "live"),
            ("MUSTANG_MODE", "mock"),
        ] {
            assert_eq!(invalid_var(with(&[(var, bad)])), var);
        }
        let c = with(&[("MUSTANG_MODE", "mock_valid"), ("VIES_MODE", "mock")]).unwrap();
        assert_eq!(c.mustang_mode, MustangMode::MockValid);
        assert_eq!(c.vies_mode, SourceMode::Mock);
        assert_eq!(
            with(&[("MUSTANG_MODE", "off")]).unwrap().mustang_mode,
            MustangMode::Off
        );
    }

    #[test]
    fn env_bools_strict() {
        for var in ["ALLOW_CHECKED_AT", "OFAC_AUTO_UPDATE"] {
            for bad in ["TRUE", "1", "yes", "False"] {
                assert_eq!(invalid_var(with(&[(var, bad)])), var, "{var}={bad}");
            }
        }
        let c = with(&[("ALLOW_CHECKED_AT", "true"), ("OFAC_AUTO_UPDATE", "false")]).unwrap();
        assert!(c.allow_checked_at);
        assert!(!c.ofac_auto_update);
    }

    #[test]
    fn env_mustang_parallel_and_whitelist() {
        assert_eq!(
            invalid_var(with(&[("MUSTANG_MAX_PARALLEL", "0")])),
            "MUSTANG_MAX_PARALLEL"
        );
        assert_eq!(
            invalid_var(with(&[("MUSTANG_MAX_PARALLEL", "-1")])),
            "MUSTANG_MAX_PARALLEL"
        );
        let c = with(&[
            ("MUSTANG_MAX_PARALLEL", "4"),
            (
                "MUSTANG_RULE_WHITELIST",
                " BR-DE-15 ,, PEPPOL-EN16931-R001 ,",
            ),
        ])
        .unwrap();
        assert_eq!(c.mustang_max_parallel, 4);
        assert_eq!(
            c.mustang_rule_whitelist,
            ["BR-DE-15", "PEPPOL-EN16931-R001"]
        );
    }

    #[test]
    fn env_numbers_and_bind_addr_invalid() {
        for var in [
            "SNIFFER_BIND_ADDR",
            "MUSTANG_TIMEOUT_MS",
            "HTTP_TIMEOUT_MS",
            "XML_TTL_SECONDS",
            "MAX_XML_BYTES",
            "LISTS_REFRESH_HOURS",
            "LISTS_MAX_AGE_HOURS",
            "RETENTION_DAYS",
        ] {
            assert_eq!(invalid_var(with(&[(var, "abc")])), var);
        }
    }

    #[test]
    fn env_ada_per_eur() {
        let c = with(&[("ADA_PER_EUR", "0.040000")]).unwrap();
        assert_eq!(c.ada_per_eur, Some(Decimal::from_str("0.04").unwrap()));
        assert_eq!(
            with(&[("ADA_PER_EUR", "25")]).unwrap().ada_per_eur,
            Some(Decimal::from(25))
        );
        for bad in [
            "0",
            "0.000000",
            "1.1234567",
            ".5",
            "1.",
            "-1",
            "1,5",
            "1e3",
            " 1",
        ] {
            assert_eq!(
                invalid_var(with(&[("ADA_PER_EUR", bad)])),
                "ADA_PER_EUR",
                "{bad}"
            );
        }
    }

    #[test]
    fn env_payout_limits() {
        let c = with(&[
            ("PAYOUT_MAX_ADA_PER_INVOICE", "10"),
            ("PAYOUT_MAX_ADA_PER_DAY", "30"),
        ])
        .unwrap();
        assert_eq!(
            (c.payout_max_ada_per_invoice, c.payout_max_ada_per_day),
            (10, 30)
        );
        for var in ["PAYOUT_MAX_ADA_PER_INVOICE", "PAYOUT_MAX_ADA_PER_DAY"] {
            assert_eq!(invalid_var(with(&[(var, "0")])), var);
            assert_eq!(invalid_var(with(&[(var, "1.5")])), var);
        }
    }

    #[test]
    fn env_debug_redacts_secrets() {
        let c = with(&[
            ("CHAINABUSE_MODE", "api"),
            ("CHAINABUSE_API_KEY", "CASECRETKEY"),
            ("REDIS_URL", "redis://:redissecret@localhost:6380/0"),
        ])
        .unwrap();
        let dbg = format!("{c:?}");
        for secret in [
            TOKEN,
            KEY,
            "000102",
            "preprodBFSECRET",
            "CASECRETKEY",
            "pgsecret",
            "redissecret",
        ] {
            assert!(!dbg.contains(secret), "{secret} leaked: {dbg}");
        }
        assert!(
            dbg.contains("postgres://sniffer:<redacted>@localhost:5432/sniffer"),
            "{dbg}"
        );
        assert!(
            dbg.contains("redis://:<redacted>@localhost:6380/0"),
            "{dbg}"
        );
        assert!(
            dbg.contains("blockfrost_project_id: Some(\"<redacted>\")"),
            "{dbg}"
        );
    }

    #[test]
    fn redact_url_variants() {
        assert_eq!(
            redact_url_password("postgres://u@h/db?sslmode=disable&password=pw"),
            "postgres://u@h/db?sslmode=disable&password=<redacted>"
        );
        assert_eq!(redact_url_password("postgres://h/db"), "postgres://h/db");
        assert_eq!(redact_url_password("host=h password=pw"), REDACTED);
        assert_eq!(
            redact_url_password("postgres://u:p%40ss@h:5432/db"),
            "postgres://u:<redacted>@h:5432/db"
        );
    }

    #[test]
    fn mustang_jar_check() {
        let mut c = with(&[("MUSTANG_JAR", "/definitely/not/here.jar")]).unwrap();
        assert!(matches!(
            c.check_mustang_jar(),
            Err(ConfigError::Invalid {
                var: "MUSTANG_JAR",
                ..
            })
        ));
        c.mustang_mode = MustangMode::Off;
        assert!(c.check_mustang_jar().is_ok());
        let jar = tempfile::NamedTempFile::new().unwrap();
        c.mustang_mode = MustangMode::Cli;
        c.mustang_jar = jar.path().to_path_buf();
        assert!(c.check_mustang_jar().is_ok());
    }

    // --- criteria.json -------------------------------------------------------

    #[test]
    fn shipped_criteria_load_and_validate() {
        let (c, sha) = Criteria::load(SHIPPED).unwrap();
        c.validate(&ALL_IDS).unwrap();
        let ids: Vec<&str> = c.criteria.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ALL_IDS);
        assert_eq!(c.version, "1.0.0");
        assert_eq!(
            c.bands,
            Bands {
                medium_min: 20,
                high_min: 60
            }
        );
        assert_eq!(
            (c.ko_points, c.reducer_cap, c.reducers_blocked_by_points),
            (100, 25, 25)
        );
        let d = |s: &str| Decimal::from_str(s).unwrap();
        assert_eq!(c.params.new_wallet_limit_eur, d("1000.00"));
        assert_eq!(c.params.max_invoice_eur, d("10000.00"));
        assert_eq!(c.params.round_amount_multiple_eur, d("100.00"));
        assert_eq!(
            c.params.approval_thresholds_eur,
            [d("1000.00"), d("5000.00"), d("10000.00")]
        );
        assert_eq!(c.params.wallet_trust_reducer_min, d("0.500"));
        assert_eq!(c.params.threshold_margin_percent, 5);
        assert_eq!(c.params.pair_reducer_min_approved, 3);
        let w2 = c.get("W-2").unwrap();
        assert_eq!(
            w2.points_tiers.as_deref(),
            Some(
                &[
                    PointsTier {
                        below_days: 7,
                        points: 15
                    },
                    PointsTier {
                        below_days: 30,
                        points: 8
                    }
                ][..]
            )
        );
        let s8 = c.get("S-8").unwrap();
        assert_eq!((s8.points, s8.agent), (Some(5), Some(Agent::Research)));
        let s9 = c.get("S-9").unwrap();
        assert_eq!((s9.points, s9.agent), (Some(5), Some(Agent::Research)));
        assert_eq!(c.get("KO-4").unwrap().reason_type, Some(ReasonType::Risk));
        assert_eq!(c.get("T-4").unwrap().points, Some(-5));
        assert_eq!(c.incomplete_tasks["CURRENCY_NOT_EUR"].agent, Agent::Invoice);
        assert_eq!(sha, sha256_hex(SHIPPED));
    }

    #[test]
    fn criteria_sha256_is_stable_and_byte_exact() {
        let (_, a) = Criteria::load(SHIPPED).unwrap();
        let (_, b) = Criteria::load(SHIPPED).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        let mut changed = SHIPPED.to_vec();
        changed.push(b'\n');
        let (_, c) = Criteria::load(&changed).unwrap();
        assert_ne!(a, c);
    }

    fn shipped_json() -> serde_json::Value {
        serde_json::from_slice(SHIPPED).unwrap()
    }

    fn entry<'a>(v: &'a mut serde_json::Value, id: &str) -> &'a mut serde_json::Value {
        v["criteria"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["id"] == id)
            .unwrap()
    }

    /// Loads and validates a mutated copy; returns the error message.
    fn broken(f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v = shipped_json();
        f(&mut v);
        let bytes = serde_json::to_vec(&v).unwrap();
        let ids: Vec<String> = v["criteria"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["id"].as_str().map(String::from))
            .collect();
        let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        match Criteria::load(&bytes).and_then(|(c, _)| c.validate(&ids)) {
            Err(ConfigError::Criteria(m)) => m,
            other => panic!("expected criteria error, got {other:?}"),
        }
    }

    #[test]
    fn rule_ids_unique() {
        let m = broken(|v| entry(v, "S-3")["id"] = "S-1".into());
        assert!(m.contains("duplicate criterion id S-1"), "{m}");
    }

    #[test]
    fn rule_kind_known() {
        let m = broken(|v| entry(v, "S-3")["kind"] = "bonus".into());
        assert!(m.contains("bonus"), "{m}");
    }

    #[test]
    fn rule_ko_needs_reason_type() {
        let m = broken(|v| entry(v, "KO-3")["reason_type"] = serde_json::Value::Null);
        assert!(m.contains("KO-3") && m.contains("reason_type"), "{m}");
    }

    #[test]
    fn rule_score_needs_points_or_tiers() {
        let m = broken(|v| {
            entry(v, "S-4").as_object_mut().unwrap().remove("points");
        });
        assert!(
            m.contains("S-4") && m.contains("points or points_tiers"),
            "{m}"
        );
        let m = broken(|v| entry(v, "W-2")["points_tiers"] = serde_json::json!([]));
        assert!(m.contains("W-2"), "{m}");
    }

    #[test]
    fn rule_reducer_needs_negative_points() {
        let m = broken(|v| entry(v, "T-2")["points"] = 10.into());
        assert!(m.contains("T-2") && m.contains("negative"), "{m}");
        let m = broken(|v| entry(v, "T-2")["points"] = 0.into());
        assert!(m.contains("T-2"), "{m}");
        let m = broken(|v| {
            entry(v, "T-2").as_object_mut().unwrap().remove("points");
        });
        assert!(m.contains("T-2"), "{m}");
    }

    #[test]
    fn rule_score_and_ko_need_agent_and_customer_text() {
        let m = broken(|v| entry(v, "S-8")["agent"] = serde_json::Value::Null);
        assert!(m.contains("S-8") && m.contains("agent"), "{m}");
        let m = broken(|v| entry(v, "KO-2")["agent"] = serde_json::Value::Null);
        assert!(m.contains("KO-2") && m.contains("agent"), "{m}");
        let m = broken(|v| entry(v, "KO-1")["customer_text"] = serde_json::Value::Null);
        assert!(m.contains("KO-1") && m.contains("customer_text"), "{m}");
        let m = broken(|v| entry(v, "I-5")["customer_text"] = " ".into());
        assert!(m.contains("I-5") && m.contains("customer_text"), "{m}");
    }

    #[test]
    fn rule_score_needs_agent_task() {
        let m = broken(|v| entry(v, "S-9")["agent_task"] = serde_json::Value::Null);
        assert!(m.contains("S-9") && m.contains("agent_task"), "{m}");
    }

    #[test]
    fn rule_no_betrug_or_fraud() {
        let m = broken(|v| entry(v, "I-3")["customer_text"] = "Verdacht auf BETRUG.".into());
        assert!(m.contains("I-3") && m.contains("Betrug"), "{m}");
        let m = broken(|v| entry(v, "T-1")["name"] = "Anti-fraud wallet".into());
        assert!(m.contains("T-1"), "{m}");
        let m = broken(|v| entry(v, "W-1")["agent_task"] = "Prüfe Fraud-Meldungen.".into());
        assert!(m.contains("W-1"), "{m}");
        let m =
            broken(|v| v["incomplete_tasks"]["VIES_UNAVAILABLE"]["task"] = "Betrugsprüfung".into());
        assert!(m.contains("VIES_UNAVAILABLE"), "{m}");
    }

    #[test]
    fn rule_incomplete_tasks_exactly_six_codes() {
        let m = broken(|v| {
            v["incomplete_tasks"]
                .as_object_mut()
                .unwrap()
                .remove("CURRENCY_NOT_EUR");
        });
        assert!(m.contains("CURRENCY_NOT_EUR"), "{m}");
        let m = broken(|v| {
            v["incomplete_tasks"]["EXTRA_CODE"] =
                serde_json::json!({ "agent": "wallet", "task": "x" });
        });
        assert!(m.contains("EXTRA_CODE"), "{m}");
    }

    #[test]
    fn params_amounts_must_be_strings() {
        let m = broken(|v| v["params"]["max_invoice_eur"] = 10000.into());
        assert!(m.contains("string"), "{m}");
        let m = broken(|v| v["params"]["approval_thresholds_eur"] = serde_json::json!([1000]));
        assert!(m.contains("string"), "{m}");
    }

    #[test]
    fn registry_config_bijection() {
        let (c, _) = Criteria::load(SHIPPED).unwrap();
        let missing_impl = &ALL_IDS[..29];
        let e = c.validate(missing_impl).unwrap_err().to_string();
        assert!(e.contains("T-4") && e.contains("registry"), "{e}");

        let mut extra = ALL_IDS.to_vec();
        extra.push("S-10");
        let e = c.validate(&extra).unwrap_err().to_string();
        assert!(e.contains("S-10"), "{e}");

        let mut dup = ALL_IDS.to_vec();
        dup.push("S-1");
        let e = c.validate(&dup).unwrap_err().to_string();
        assert!(e.contains("S-1") && e.contains("twice"), "{e}");

        // Registry order does not matter; the catalog order comes from the config.
        let mut reversed = ALL_IDS.to_vec();
        reversed.reverse();
        c.validate(&reversed).unwrap();
    }

    // --- data/ ---------------------------------------------------------------

    fn data_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("data")
    }

    #[test]
    fn data_dir_loads() {
        let d = DataFiles::load(&data_dir()).unwrap();
        assert_eq!(
            normalize::name("Käufer Handels AG", &d.legal_forms),
            "kauferhandels"
        );
        assert_eq!(d.pressure_words.len(), 52);
        let first = &d.pressure_words[0];
        assert_eq!(
            (first.normalized.as_str(), first.phrase.as_str()),
            ("dringend", " dringend ")
        );
        assert!(d
            .pressure_words
            .iter()
            .any(|p| p.phrase == " innerhalb von 24 stunden "));
        assert_eq!(d.freemail_domains.len(), 41);
        assert!(d.freemail_domains.contains("gmx.de"));
        assert_eq!(
            d.high_risk_countries.as_of,
            NaiveDate::from_ymd_opt(2026, 6, 19).unwrap()
        );
        assert_eq!(
            d.high_risk_countries
                .countries
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["CU", "IR", "KP", "MM"]
        );
        assert_eq!(
            d.buyer_master,
            BuyerMaster {
                name: "Käufer Handels AG".into(),
                vat_id: "DE999999999".into(),
                postcode: "10115".into()
            }
        );
        assert_eq!(d.open_orders.len(), 4);
        assert_eq!(d.open_orders[1].order_id, "PO-2026-002");
        assert_eq!(d.open_orders[1].supplier_vat_id, "DE222222222");
        assert_eq!(
            d.open_orders[0].ordered_total,
            Some(Decimal::new(119000, 2))
        );
        assert_eq!(d.open_orders[0].currency.as_deref(), Some("EUR"));
    }

    fn copy_data() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for f in [
            "legal-forms.json",
            "pressure-words.json",
            "freemail-domains.json",
            "high-risk-countries.json",
            "buyer-master.json",
            "open-orders.json",
        ] {
            std::fs::copy(data_dir().join(f), tmp.path().join(f)).unwrap();
        }
        tmp
    }

    #[test]
    fn data_errors_name_the_file() {
        let tmp = copy_data();
        std::fs::remove_file(tmp.path().join("open-orders.json")).unwrap();
        let e = DataFiles::load(tmp.path()).unwrap_err();
        assert!(
            matches!(
                e,
                ConfigError::DataFile {
                    file: "open-orders.json",
                    ..
                }
            ),
            "{e:?}"
        );
        assert!(e.to_string().contains("open-orders.json"));

        let tmp = copy_data();
        std::fs::write(
            tmp.path().join("pressure-words.json"),
            r#"["eilig", " - "]"#,
        )
        .unwrap();
        let e = DataFiles::load(tmp.path()).unwrap_err();
        assert!(matches!(
            e,
            ConfigError::DataFile {
                file: "pressure-words.json",
                ..
            }
        ));

        let tmp = copy_data();
        std::fs::write(
            tmp.path().join("high-risk-countries.json"),
            r#"{"as_of":"2026-06-19","countries":["iran"]}"#,
        )
        .unwrap();
        let e = DataFiles::load(tmp.path()).unwrap_err();
        assert!(matches!(
            e,
            ConfigError::DataFile {
                file: "high-risk-countries.json",
                ..
            }
        ));

        let tmp = copy_data();
        std::fs::write(tmp.path().join("buyer-master.json"), "{").unwrap();
        let e = DataFiles::load(tmp.path()).unwrap_err();
        assert!(matches!(
            e,
            ConfigError::DataFile {
                file: "buyer-master.json",
                ..
            }
        ));
    }

    #[test]
    fn open_order_details_are_optional() {
        let tmp = copy_data();
        std::fs::write(
            tmp.path().join("open-orders.json"),
            r#"[{"order_id":"PO-1","supplier_vat_id":"DE111111111"}]"#,
        )
        .unwrap();
        let d = DataFiles::load(tmp.path()).unwrap();
        assert_eq!(d.open_orders[0].ordered_total, None);
        assert_eq!(d.open_orders[0].currency, None);
        assert_eq!(d.open_orders[0].description, None);

        std::fs::write(
            tmp.path().join("open-orders.json"),
            r#"[{"order_id":"PO-1","supplier_vat_id":"DE111111111","ordered_total":"12x"}]"#,
        )
        .unwrap();
        let e = DataFiles::load(tmp.path()).unwrap_err();
        assert!(matches!(
            e,
            ConfigError::DataFile {
                file: "open-orders.json",
                ..
            }
        ));
    }
}
