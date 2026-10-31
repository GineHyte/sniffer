//! Acceptance-test harness (spec 8.1): fresh schema `sniffer`, flushed Redis test
//! database, 7.5 seed, wiremock stubs for Blockfrost, VIES and Chainabuse, and the
//! real router served on an ephemeral local port.
//!
//! Environment:
//! - `SNIFFER_IT_DATABASE_URL` (required; tests print a note and pass when unset).
//!   The schema `sniffer` of that database is dropped before every test.
//! - `SNIFFER_ACCEPTANCE_REDIS_URL` (default `redis://127.0.0.1:6380/13`); must name a
//!   database index other than 0 because it is flushed before every test.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

use redis::aio::MultiplexedConnection;
use reqwest::StatusCode;
use serde_json::{json, Value};
use sqlx::{Connection, PgConnection, PgPool};
use tokio::sync::{Mutex, MutexGuard};
use wiremock::matchers::{method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use sniffer::address;
use sniffer::api;
use sniffer::app::{self, AppState};
use sniffer::config::EnvConfig;
use sniffer::criteria::Hashes;
use sniffer::hashing::{self, CredentialKind, HmacKey};
use sniffer::normalize;
use sniffer::parse::Invoice;
use sniffer::store::postgres::{self, BlockSource, SubjectType};

// ---------------------------------------------------------------------------
// Seed switch
// ---------------------------------------------------------------------------

/// SEED SWITCH. `false`: the harness writes the 7.5 seed rows itself
/// ([`seed_inline`]). `true`: it loads `seed/seed.json` through `sniffer::seed::seed_file`
/// (Task 18), which is the 8.1 procedure. Set `false` to test without `seed_file`.
pub const USE_SEED_FILE: bool = true;

// ---------------------------------------------------------------------------
// Constants (3.3, 7.5, 8.1)
// ---------------------------------------------------------------------------

pub const TOKEN: &str = "acceptance-token-0123456789abcdef0123";
pub const HMAC_KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
pub const CHECKED_AT: &str = "2026-10-30T12:00:00Z";
pub const DEFAULT_REDIS_URL: &str = "redis://127.0.0.1:6380/13";

pub const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
pub const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
pub const W3: &str = "addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9";
pub const W4: &str = "addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww";
pub const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";
pub const M: &str = "addr_test1qqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxva24242424242424242424242424242424242424242424qdm5upe";
pub const W1_MAIN: &str = "addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qc5hee8";
pub const W1_BAD: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q";

/// 7.5: six approved invoices of supplier A (number, amount, date).
pub const SEED_INVOICES: [(&str, &str, &str); 6] = [
    ("RE-2026-0101", "1190.00", "2026-04-15"),
    ("RE-2026-0102", "1250.00", "2026-05-15"),
    ("RE-2026-0103", "980.00", "2026-06-15"),
    ("RE-2026-0104", "1100.00", "2026-07-15"),
    ("RE-2026-0105", "1300.00", "2026-08-15"),
    ("RE-2026-0106", "1050.00", "2026-09-15"),
];

/// 8.1 Blockfrost stub times.
pub const W1_FIRST_TX: i64 = 1_768_035_600;
pub const W2_FIRST_TX: i64 = 1_793_102_400;

/// `HTTP_TIMEOUT_MS` used by the harness.
pub const HTTP_TIMEOUT_MS: u64 = 2000;

/// Acceptance tests share one database and Redis index, so they run one at a time.
/// An async mutex: the guard lives across awaits and each test has its own runtime.
static SERIAL: Mutex<()> = Mutex::const_new(());

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn key() -> HmacKey {
    HmacKey::from_hex(HMAC_KEY_HEX).unwrap()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

pub fn fixture(name: &str) -> String {
    std::fs::read_to_string(manifest_dir().join("tests/fixtures").join(name)).expect("fixture")
}

pub fn f1() -> String {
    fixture("f1.xml")
}

/// Replaces every occurrence of `from`; panics if there is none (keeps variants honest).
pub fn sub(xml: &str, from: &str, to: &str) -> String {
    assert!(xml.contains(from), "fixture does not contain {from:?}");
    xml.replace(from, to)
}

/// The element from `open` through `close` (inclusive), first occurrence.
pub fn element<'a>(xml: &'a str, open: &str, close: &str) -> &'a str {
    let start = xml.find(open).expect("open tag");
    let end = xml[start..].find(close).expect("close tag") + start + close.len();
    &xml[start..end]
}

pub fn with_address(xml: &str, address: &str) -> String {
    sub(xml, W1, address)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// Overrides for one test.
#[derive(Default)]
pub struct Options {
    /// Extra or replaced environment variables (6.1).
    pub env: Vec<(&'static str, String)>,
    /// Extra wiremock stubs, mounted with priority 1 (before the standard stubs).
    pub stubs: Vec<Mock>,
    /// Skip the 7.5 seed.
    pub no_seed: bool,
}

pub struct Harness {
    pub base: String,
    pub http: reqwest::Client,
    pub pool: PgPool,
    pub redis: MultiplexedConnection,
    pub mock: MockServer,
    pub state: AppState,
    pub key: HmacKey,
    server: tokio::task::JoinHandle<()>,
    _serial: MutexGuard<'static, ()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Redis URL for the tests; `None` (with a note) if it would flush database 0.
fn redis_url() -> Option<String> {
    let url = env_var("SNIFFER_ACCEPTANCE_REDIS_URL").unwrap_or_else(|| DEFAULT_REDIS_URL.into());
    let db = url
        .rsplit_once('/')
        .and_then(|(_, db)| db.parse::<u32>().ok());
    match db {
        Some(n) if n != 0 => Some(url),
        _ => {
            println!(
                "skipping: SNIFFER_ACCEPTANCE_REDIS_URL must name a database index other than 0"
            );
            None
        }
    }
}

/// Standard harness (8.1). `None` when `SNIFFER_IT_DATABASE_URL` is unset.
pub async fn harness() -> Option<Harness> {
    harness_with(Options::default()).await
}

pub async fn harness_with(opts: Options) -> Option<Harness> {
    let Some(db_url) = env_var("SNIFFER_IT_DATABASE_URL") else {
        println!("skipping acceptance test: SNIFFER_IT_DATABASE_URL not set");
        return None;
    };
    let redis_url = redis_url()?;
    let serial = SERIAL.lock().await;

    // Empty schema and Redis test database.
    let mut conn = PgConnection::connect(&db_url).await.expect("postgres");
    sqlx::raw_sql("DROP SCHEMA IF EXISTS sniffer CASCADE")
        .execute(&mut conn)
        .await
        .expect("drop schema");
    conn.close().await.ok();
    let mut redis = sniffer::store::redis::connect(&redis_url)
        .await
        .expect("redis");
    let _: () = redis::cmd("FLUSHDB")
        .query_async(&mut redis)
        .await
        .expect("flushdb");

    let mock = MockServer::start().await;
    for stub in opts.stubs {
        stub.with_priority(1).mount(&mock).await;
    }
    mount_standard_stubs(&mock).await;

    let mut vars: HashMap<&'static str, String> = HashMap::from([
        ("SNIFFER_BIND_ADDR", "127.0.0.1:0".to_string()),
        ("SNIFFER_API_TOKEN", TOKEN.to_string()),
        ("SNIFFER_HMAC_KEY", HMAC_KEY_HEX.to_string()),
        ("DATABASE_URL", db_url),
        ("REDIS_URL", redis_url),
        ("EXPECTED_NETWORK", "preprod".to_string()),
        ("BLOCKFROST_MODE", "api".to_string()),
        ("BLOCKFROST_PROJECT_ID", "preprodTEST".to_string()),
        ("BLOCKFROST_BASE_URL", format!("{}/bf", mock.uri())),
        ("VIES_MODE", "api".to_string()),
        ("VIES_BASE_URL", format!("{}/vies", mock.uri())),
        ("CHAINABUSE_MODE", "api".to_string()),
        ("CHAINABUSE_API_KEY", "test-chainabuse-key".to_string()),
        ("CHAINABUSE_BASE_URL", format!("{}/ca", mock.uri())),
        ("MUSTANG_MODE", "mock_valid".to_string()),
        ("HTTP_TIMEOUT_MS", HTTP_TIMEOUT_MS.to_string()),
        ("OFAC_AUTO_UPDATE", "false".to_string()),
        ("ALLOW_CHECKED_AT", "true".to_string()),
        (
            "CONFIG_DIR",
            manifest_dir().join("config").display().to_string(),
        ),
        (
            "DATA_DIR",
            manifest_dir().join("data").display().to_string(),
        ),
    ]);
    for (k, v) in opts.env {
        vars.insert(k, v);
    }
    let env = EnvConfig::from_vars(|k| vars.get(k).cloned()).expect("test env");
    let state = app::startup(env).await.expect("startup (FR-80)");
    let pool = state.pool.clone();

    if !opts.no_seed {
        seed(&pool).await;
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = api::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("server");
    });

    Some(Harness {
        base,
        http: reqwest::Client::new(),
        pool,
        redis,
        mock,
        state,
        key: key(),
        server,
        _serial: serial,
    })
}

/// 8.1 standard stubs. Base URLs: Blockfrost `/bf`, VIES `/vies`, Chainabuse `/ca`.
async fn mount_standard_stubs(mock: &MockServer) {
    let tx = |time: i64| json!([{ "tx_hash": "ab".repeat(32), "tx_index": 0, "block_height": 100, "block_time": time }]);
    for (addr, time) in [(W1, W1_FIRST_TX), (W2, W2_FIRST_TX)] {
        Mock::given(method("GET"))
            .and(path(format!("/bf/addresses/{addr}/transactions")))
            .respond_with(ResponseTemplate::new(200).set_body_json(tx(time)))
            .with_priority(5)
            .mount(mock)
            .await;
    }
    Mock::given(method("GET"))
        .and(path_regex(r"^/bf/addresses/[^/]+/transactions$"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "status_code": 404, "error": "Not Found",
            "message": "The requested component has not been found."
        })))
        .with_priority(10)
        .mount(mock)
        .await;

    for nr in ["111111111", "222222222", "333333333", "555555555"] {
        Mock::given(method("GET"))
            .and(path(format!("/vies/ms/DE/vat/{nr}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "isValid": true, "userError": "VALID" })),
            )
            .with_priority(5)
            .mount(mock)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/vies/ms/DE/vat/444444444"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "isValid": false, "userError": "INVALID" })),
        )
        .with_priority(5)
        .mount(mock)
        .await;

    Mock::given(method("GET"))
        .and(path("/ca/reports"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "reports": [], "count": 0 })),
        )
        .with_priority(10)
        .mount(mock)
        .await;
}

/// Chainabuse stub for one address (tests 20, 21).
pub fn chainabuse_stub(address: &str, reports: Value) -> Mock {
    let count = reports.as_array().map_or(0, Vec::len);
    Mock::given(method("GET"))
        .and(path("/ca/reports"))
        .and(query_param("address", address))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "reports": reports, "count": count })),
        )
}

// ---------------------------------------------------------------------------
// Seed (7.4, 7.5)
// ---------------------------------------------------------------------------

async fn seed(pool: &PgPool) {
    if USE_SEED_FILE {
        let json =
            std::fs::read_to_string(manifest_dir().join("seed/seed.json")).expect("seed.json");
        let data = sniffer::config::DataFiles::load(&manifest_dir().join("data")).expect("data");
        let n = sniffer::seed::seed_file(pool, &key(), &data.legal_forms, &json)
            .await
            .expect("seed_file");
        assert_eq!(n, 6, "seed inserts six invoices");
    } else {
        seed_inline(pool).await;
    }
}

/// Supplier A of 7.5 as a parsed invoice, for [`Hashes::compute`].
fn seed_invoice(number: &str, amount: &str, date: &str) -> Invoice {
    Invoice {
        invoice_number: Some(number.into()),
        type_code: Some("380".into()),
        issue_date: Some(date.parse().unwrap()),
        seller_name: Some("Alpha Consulting GmbH".into()),
        seller_vat_id: Some("DE111111111".into()),
        seller_email: Some("rechnung@alpha-consulting.example".into()),
        seller_phone: Some("+49 89 1234567".into()),
        seller_street: Some("Musterstraße 1".into()),
        seller_postcode: Some("80333".into()),
        seller_city: Some("München".into()),
        seller_country: Some("DE".into()),
        currency: Some("EUR".into()),
        grand_total: Some(amount.parse().unwrap()),
        ..Invoice::default()
    }
}

/// The 7.5 seed written directly (fallback when [`USE_SEED_FILE`] is `false`).
pub async fn seed_inline(pool: &PgPool) {
    let key = key();
    let legal = &data().legal_forms;
    let w1 = address::check_without_network(W1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for (i, (number, amount, date)) in SEED_INVOICES.iter().enumerate() {
        let inv = seed_invoice(number, amount, date);
        let h = Hashes::compute(&key, legal, Some(&inv), Some(&w1));
        let issue: chrono::NaiveDate = date.parse().unwrap();
        sqlx::query(
            "INSERT INTO invoices (invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash,
               name_hash, email_domain_hash, phone_hash, postal_hash, amount, currency, issue_date,
               type_code, initial_band, initial_score, final_decision, final_reason_type,
               decided_by, decided_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'EUR', $11, '380', 'low', 0,
               'approved', NULL, 'seed', $12)",
        )
        .bind(h.invoice.as_deref().unwrap())
        .bind(format!("seed_{}", i + 1))
        .bind(h.supplier.as_deref().unwrap())
        .bind(h.wallet.as_deref().unwrap())
        .bind(h.pair.as_deref().unwrap())
        .bind(h.name.as_deref().unwrap())
        .bind(h.email_domain.as_deref())
        .bind(h.phone.as_deref())
        .bind(h.postal.as_deref())
        .bind(inv.grand_total.unwrap())
        .bind(issue)
        .bind(issue.and_hms_opt(0, 0, 0).unwrap().and_utc())
        .execute(&mut *tx)
        .await
        .unwrap();
        for (hash, ty) in [
            (&h.wallet, SubjectType::Wallet),
            (&h.supplier, SubjectType::Supplier),
            (&h.pair, SubjectType::Pair),
        ] {
            postgres::approve_subject(&mut *tx, hash.as_deref().unwrap(), ty)
                .await
                .unwrap();
        }
    }
    for (addr, source, reason) in [
        (W4, BlockSource::Internal, "TEST_INTERNAL"),
        (W5, BlockSource::Ofac, "TEST_OFAC"),
    ] {
        postgres::block_subject(
            &mut *tx,
            &wallet_hash(addr),
            SubjectType::Wallet,
            source,
            reason,
        )
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO sanction_names (name_normalized, source, sdn_uid) VALUES ($1, 'OFAC', 'TEST-1')")
        .bind(normalize::name("Delta Trading LLC", legal))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO list_updates (source, last_success_at, entries, cardano_addresses)
         VALUES ('OFAC', now(), 0, 0)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

pub fn data() -> &'static sniffer::config::DataFiles {
    static DATA: std::sync::OnceLock<sniffer::config::DataFiles> = std::sync::OnceLock::new();
    DATA.get_or_init(|| sniffer::config::DataFiles::load(&manifest_dir().join("data")).unwrap())
}

// ---------------------------------------------------------------------------
// Hash helpers (3.3)
// ---------------------------------------------------------------------------

pub fn wallet_hash(address: &str) -> String {
    let a = address::check_without_network(address).unwrap();
    let kind = match a.credential_type {
        address::CredentialType::Key => CredentialKind::Key,
        address::CredentialType::Script => CredentialKind::Script,
    };
    hashing::wallet_hash(&key(), kind, &a.credential_hex)
}

pub fn supplier_hash(vat: &str) -> String {
    hashing::supplier_hash(&key(), vat)
}

pub fn pair_hash(vat: &str, address: &str) -> String {
    hashing::pair_hash(&key(), &supplier_hash(vat), &wallet_hash(address))
}

pub fn config_sha256() -> String {
    hashing::sha256_hex(&std::fs::read(manifest_dir().join("config/criteria.json")).unwrap())
}

// ---------------------------------------------------------------------------
// HTTP and database helpers
// ---------------------------------------------------------------------------

pub struct Resp {
    pub status: StatusCode,
    pub body: Value,
    pub text: String,
}

impl Harness {
    pub fn url(&self, p: &str) -> String {
        format!("{}{p}", self.base)
    }

    async fn finish(resp: reqwest::Response) -> Resp {
        let status = resp.status();
        let text = resp.text().await.unwrap();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Resp { status, body, text }
    }

    /// `POST /v1/initial-check` with `checked_at` = 8.1 test time.
    pub async fn check(&self, xml: &str) -> Resp {
        self.post(
            "/v1/initial-check",
            &json!({ "xml": xml, "checked_at": CHECKED_AT }),
        )
        .await
    }

    /// `check` that must answer 200; returns the result JSON.
    pub async fn check_ok(&self, xml: &str) -> Value {
        let r = self.check(xml).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        r.body
    }

    pub async fn post(&self, p: &str, body: &Value) -> Resp {
        let resp = self
            .http
            .post(self.url(p))
            .bearer_auth(TOKEN)
            .json(body)
            .send()
            .await
            .unwrap();
        Self::finish(resp).await
    }

    pub async fn post_raw(
        &self,
        p: &str,
        token: Option<&str>,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Resp {
        let mut req = self.http.post(self.url(p)).body(body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        Self::finish(req.send().await.unwrap()).await
    }

    pub async fn get(&self, p: &str) -> Resp {
        let resp = self
            .http
            .get(self.url(p))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        Self::finish(resp).await
    }

    pub async fn count(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }

    /// `(approved, rejected_risk, trust as text, status, block_reason)` of a subject.
    pub async fn subject(&self, hash: &str) -> Option<(i32, i32, String, String, Option<String>)> {
        sqlx::query_as(
            "SELECT approved, rejected_risk, trust::text, status, block_reason
             FROM subjects WHERE hash = $1",
        )
        .bind(hash)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }

    /// `(final_decision, final_reason_type, decided_by)` of the invoices row of a check.
    pub async fn invoice_row(
        &self,
        check_id: &str,
    ) -> Option<(Option<String>, Option<String>, Option<String>)> {
        sqlx::query_as(
            "SELECT final_decision, final_reason_type, decided_by FROM invoices WHERE check_id = $1",
        )
        .bind(check_id)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }

    /// Requests the stubs received so far.
    pub async fn stub_requests(&self) -> usize {
        self.mock.received_requests().await.map_or(0, |r| r.len())
    }
}

// ---------------------------------------------------------------------------
// Result accessors
// ---------------------------------------------------------------------------

pub fn band(r: &Value) -> &str {
    r["summary"]["band"].as_str().unwrap()
}

pub fn score(r: &Value) -> i64 {
    r["summary"]["risk_score"].as_i64().unwrap()
}

/// `(id, points)` of `criteria[]`.
pub fn criteria(r: &Value) -> Vec<(String, i64)> {
    list(r, "criteria")
}

/// `(id, points)` of `reducers[]`.
pub fn reducers(r: &Value) -> Vec<(String, i64)> {
    list(r, "reducers")
}

fn list(r: &Value, key: &str) -> Vec<(String, i64)> {
    r[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_string(),
                c["points"].as_i64().unwrap(),
            )
        })
        .collect()
}

pub fn ids(v: &[(&str, i64)]) -> Vec<(String, i64)> {
    v.iter().map(|(i, p)| (i.to_string(), *p)).collect()
}

pub fn evidence<'a>(r: &'a Value, id: &str) -> &'a str {
    r["criteria"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("criterion {id} not fired"))["evidence"]
        .as_str()
        .unwrap()
}

pub fn incomplete(r: &Value) -> Vec<String> {
    strings(&r["summary"]["checks_incomplete"])
}

pub fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

pub fn task_sources(r: &Value, agent: &str) -> Vec<String> {
    r["agent_tasks"][agent]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["source"].as_str().unwrap().to_string())
        .collect()
}

pub fn check_id(r: &Value) -> String {
    r["check_id"].as_str().unwrap().to_string()
}

/// Asserts a single K.O. criterion with this evidence and band High.
pub fn assert_single_ko(r: &Value, id: &str, evidence_text: &str) {
    assert_eq!(band(r), "high", "{r}");
    assert_eq!(score(r), 100);
    assert_eq!(r["summary"]["ko_triggered"], true);
    assert_eq!(criteria(r), ids(&[(id, 100)]), "{r}");
    assert_eq!(evidence(r, id), evidence_text);
    assert!(r["reducers"].as_array().unwrap().is_empty());
    assert_eq!(r["summary"]["decline_reasons"][0]["id"], id);
}

/// `checks_skipped` as `(source, reason)` pairs.
pub fn skipped(r: &Value) -> Vec<(String, String)> {
    r["summary"]["checks_skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["source"].as_str().unwrap().to_string(),
                s["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

pub fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
    v.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}
