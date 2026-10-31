//! CLI integration tests (spec 7.1–7.5, FR-70..FR-76) against real Postgres and Redis.
//!
//! Gated by `SNIFFER_IT_DATABASE_URL` and `SNIFFER_IT_REDIS_URL`; without them the test
//! prints a note and passes. The database must be a dedicated test database: the test
//! empties the `sniffer` tables (spec 8.1) and refuses a database named `sniffer`. In
//! Redis it only touches the `sniffer:xml:*` keys it creates.
//!
//! The binary runs via `CARGO_BIN_EXE_sniffer` in a temporary working directory (so no
//! `.env` is picked up); all configuration is set on the child process only.

use std::path::PathBuf;
use std::process::{Command, Output};

use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::PgPool;

use sniffer::address;
use sniffer::hashing::{self, HmacKey};
use sniffer::jobs;
use sniffer::normalize::LegalForms;
use sniffer::sanctions::{self, wallet_hash_of};
use sniffer::store::postgres::{self, BlockSource, SubjectStatus, SubjectType};
use sniffer::store::redis as rstore;

const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TOKEN: &str = "it-token-0123456789abcdef0123456789abcdef";
const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
const W3: &str = "addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9";
const W4: &str = "addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww";
const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";
const W1_BAD: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q";
const SUPPLIER_A: &str = "hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060";
const WALLET_W1: &str = "hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090";
const PAIR_A_W1: &str = "hmac:d0323c2f6d8cb2ac79d4051e884ae7693c08022489b933ddd84695829ec9f7fb";

/// Every variable of spec 6.1 / 12.3; removed from the child env before setting test values.
const SPEC_VARS: [&str; 34] = [
    "SNIFFER_BIND_ADDR",
    "SNIFFER_API_TOKEN",
    "SNIFFER_HMAC_KEY",
    "DATABASE_URL",
    "REDIS_URL",
    "EXPECTED_NETWORK",
    "BLOCKFROST_MODE",
    "BLOCKFROST_PROJECT_ID",
    "BLOCKFROST_BASE_URL",
    "VIES_MODE",
    "VIES_BASE_URL",
    "CHAINABUSE_MODE",
    "CHAINABUSE_API_KEY",
    "CHAINABUSE_BASE_URL",
    "MUSTANG_MODE",
    "JAVA_BIN",
    "MUSTANG_JAR",
    "MUSTANG_RULE_WHITELIST",
    "MUSTANG_TIMEOUT_MS",
    "MUSTANG_MAX_PARALLEL",
    "HTTP_TIMEOUT_MS",
    "XML_TTL_SECONDS",
    "MAX_XML_BYTES",
    "OFAC_SDN_URL",
    "OFAC_AUTO_UPDATE",
    "LISTS_REFRESH_HOURS",
    "LISTS_MAX_AGE_HOURS",
    "ALLOW_CHECKED_AT",
    "RETENTION_DAYS",
    "CONFIG_DIR",
    "DATA_DIR",
    "ADA_PER_EUR",
    "PAYOUT_MAX_ADA_PER_INVOICE",
    "PAYOUT_MAX_ADA_PER_DAY",
];

fn env_var(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => {
            println!("skipping: {name} not set");
            None
        }
    }
}

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn key() -> HmacKey {
    HmacKey::from_hex(KEY).unwrap()
}

fn lf() -> LegalForms {
    jobs::load_legal_forms(&manifest().join("data")).unwrap()
}

fn wallet(addr: &str) -> String {
    wallet_hash_of(&key(), &address::check_without_network(addr).unwrap())
}

fn d(s: &str) -> Decimal {
    s.parse().unwrap()
}

struct Cli {
    db: String,
    redis: String,
    cwd: tempfile::TempDir,
}

/// Result of one binary run: exit success, parsed stdout JSON (if any), raw stderr.
struct Run {
    ok: bool,
    json: Option<Value>,
    stdout: String,
    stderr: String,
}

impl Cli {
    fn run(&self, args: &[&str]) -> Run {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_sniffer"));
        cmd.args(args).current_dir(self.cwd.path());
        for v in SPEC_VARS {
            cmd.env_remove(v);
        }
        cmd.env("DATABASE_URL", &self.db)
            .env("REDIS_URL", &self.redis)
            .env("SNIFFER_API_TOKEN", TOKEN)
            .env("SNIFFER_HMAC_KEY", KEY)
            .env("BLOCKFROST_MODE", "mock")
            .env("VIES_MODE", "mock")
            .env("CHAINABUSE_MODE", "mock")
            .env("MUSTANG_MODE", "off")
            .env("OFAC_AUTO_UPDATE", "false")
            // Never reach the real OFAC service from tests.
            .env("OFAC_SDN_URL", "http://127.0.0.1:9/SDN.XML")
            .env("CONFIG_DIR", manifest().join("config"))
            .env("DATA_DIR", manifest().join("data"))
            .env("RUST_LOG", "warn");
        let Output {
            status,
            stdout,
            stderr,
        } = cmd.output().expect("run sniffer binary");
        let stdout = String::from_utf8(stdout).unwrap();
        let stderr = String::from_utf8(stderr).unwrap();
        let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
        assert!(lines.len() <= 1, "more than one stdout line: {stdout}");
        let json = lines
            .first()
            .map(|l| serde_json::from_str(l).expect("stdout is JSON"));
        if status.success() {
            assert!(
                json.is_some(),
                "success without JSON line; stderr: {stderr}"
            );
        } else {
            assert_eq!(status.code(), Some(1), "stderr: {stderr}");
            assert!(json.is_none(), "error with stdout output: {stdout}");
            let last = stderr.lines().last().unwrap_or_default();
            let err: Value = serde_json::from_str(last).expect("stderr ends with a JSON line");
            assert_eq!(err["ok"], false);
        }
        Run {
            ok: status.success(),
            json,
            stdout,
            stderr,
        }
    }

    fn ok(&self, args: &[&str]) -> Value {
        let r = self.run(args);
        assert!(r.ok, "{args:?} failed: {}", r.stderr);
        let v = r.json.unwrap();
        assert_eq!(v["ok"], true, "{v}");
        v
    }

    fn fails(&self, args: &[&str]) -> String {
        let r = self.run(args);
        assert!(!r.ok, "{args:?} should fail, stdout: {}", r.stdout);
        r.stderr
    }
}

async fn count(pool: &PgPool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

/// Row counts of all tables plus the sorted invoice check_ids.
async fn snapshot(pool: &PgPool) -> (i64, i64, i64, i64, i64, Vec<String>) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT check_id FROM invoices ORDER BY check_id")
        .fetch_all(pool)
        .await
        .unwrap();
    (
        count(pool, "SELECT count(*) FROM invoices").await,
        count(pool, "SELECT count(*) FROM subjects").await,
        count(pool, "SELECT count(*) FROM checks").await,
        count(pool, "SELECT count(*) FROM sanction_names").await,
        count(pool, "SELECT count(*) FROM list_updates").await,
        ids,
    )
}

async fn subject(pool: &PgPool, hash: &str) -> Option<postgres::Subject> {
    postgres::get_subjects(pool, &[hash])
        .await
        .unwrap()
        .remove(hash)
}

async fn insert_check(pool: &PgPool, check_id: &str, result: Value, age_days: i32) {
    sqlx::query(
        "INSERT INTO checks (check_id, band, result, created_at)
         VALUES ($1, 'medium', $2, now() - make_interval(days => $3))",
    )
    .bind(check_id)
    .bind(result)
    .bind(age_days)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_invoice(pool: &PgPool, tag: &str, age_days: i32) {
    let h = |p: &str| hashing::h(&key(), &format!("{p}:{tag}"));
    sqlx::query(
        "INSERT INTO invoices (invoice_hash, check_id, supplier_hash, wallet_hash, pair_hash,
           name_hash, amount, currency, issue_date, type_code, initial_band, initial_score,
           created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 100.00, 'EUR', '2024-01-01', '380', 'medium', 30,
           now() - make_interval(days => $7))",
    )
    .bind(h("invoice"))
    .bind(format!("chk_it_{tag}"))
    .bind(h("supplier"))
    .bind(h("wallet"))
    .bind(h("pair"))
    .bind(h("name"))
    .bind(age_days)
    .execute(pool)
    .await
    .unwrap();
}

fn database_name(url: &str) -> &str {
    let path = url.rsplit('/').next().unwrap_or_default();
    path.split('?').next().unwrap_or_default()
}

fn sdn_xml(entries: &[(&str, &str, &str, Option<&str>)]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
"#,
    );
    for (uid, sdn_type, last, addr) in entries {
        xml.push_str(&format!(
            "<sdnEntry><uid>{uid}</uid><lastName>{last}</lastName><sdnType>{sdn_type}</sdnType>"
        ));
        if let Some(a) = addr {
            xml.push_str(&format!(
                "<idList><id><uid>1</uid><idType>Digital Currency Address - ADA</idType><idNumber>{a}</idNumber></id></idList>"
            ));
        }
        xml.push_str("</sdnEntry>\n");
    }
    xml.push_str("</sdnList>\n");
    xml
}

// One test function: the steps share one database and must run in sequence.
#[tokio::test]
async fn cli_end_to_end() {
    let (Some(db), Some(redis_url)) = (
        env_var("SNIFFER_IT_DATABASE_URL"),
        env_var("SNIFFER_IT_REDIS_URL"),
    ) else {
        return;
    };
    assert_ne!(
        database_name(&db),
        "sniffer",
        "refusing to empty the main database; use a dedicated test database"
    );
    let cli = Cli {
        db: db.clone(),
        redis: redis_url.clone(),
        cwd: tempfile::tempdir().unwrap(),
    };
    let seed_path = manifest().join("seed").join("seed.json");
    let seed_arg = seed_path.to_str().unwrap();

    // --- migrate, then an empty schema (spec 8.1) -------------------------------
    assert_eq!(cli.ok(&["migrate"])["migrated"], true);
    let pool = postgres::connect(&db).await.unwrap();
    sqlx::raw_sql(
        "TRUNCATE subjects, invoices, checks, sanction_names, list_updates RESTART IDENTITY CASCADE",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut redis = rstore::connect(&redis_url).await.unwrap();

    // --- db-seed: repeatable, 7.5 result ----------------------------------------
    assert_eq!(
        cli.ok(&["db-seed", "--file", seed_arg])["inserted_invoices"],
        6
    );
    let first = snapshot(&pool).await;
    assert_eq!(
        cli.ok(&["db-seed", "--file", seed_arg])["inserted_invoices"],
        0
    );
    let second = snapshot(&pool).await;
    assert_eq!(first, second, "seed is repeatable");
    let ids: Vec<String> = (1..=6).map(|n| format!("seed_{n}")).collect();
    assert_eq!(first, (6, 5, 0, 1, 1, ids));
    assert_eq!(wallet(W1), WALLET_W1);

    for (hash, ty) in [
        (SUPPLIER_A, SubjectType::Supplier),
        (WALLET_W1, SubjectType::Wallet),
        (PAIR_A_W1, SubjectType::Pair),
    ] {
        let s = subject(&pool, hash).await.unwrap();
        assert_eq!(s.subject_type, ty);
        assert_eq!((s.approved, s.rejected_risk), (6, 0));
        assert_eq!(s.trust, d("0.545"));
        assert_eq!(s.status, SubjectStatus::Normal);
    }
    let w4 = subject(&pool, &wallet(W4)).await.unwrap();
    assert_eq!(
        (w4.status, w4.block_source, w4.block_reason.as_deref()),
        (
            SubjectStatus::Blocked,
            Some(BlockSource::Internal),
            Some("TEST_INTERNAL")
        )
    );
    let w5 = subject(&pool, &wallet(W5)).await.unwrap();
    assert_eq!(
        (w5.status, w5.block_source, w5.block_reason.as_deref()),
        (
            SubjectStatus::Blocked,
            Some(BlockSource::Ofac),
            Some("TEST_OFAC")
        )
    );
    let row: (String, String, String, i32, String, String, String) = sqlx::query_as(
        "SELECT initial_band, decided_by, final_decision, initial_score,
                to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                amount::text, wallet_hash
         FROM invoices WHERE check_id = 'seed_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "low".into(),
            "seed".into(),
            "approved".into(),
            0,
            "2026-04-15 00:00:00".into(),
            "1190.00".into(),
            WALLET_W1.into()
        )
    );
    let median: String = sqlx::query_scalar(
        "SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY amount))::numeric(14,2)::text
         FROM invoices WHERE supplier_hash = $1",
    )
    .bind(SUPPLIER_A)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(median, "1145.00");
    let names: Vec<(String, String)> =
        sqlx::query_as("SELECT name_normalized, sdn_uid FROM sanction_names WHERE source = 'OFAC'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(names, [("deltatrading".to_string(), "TEST-1".to_string())]);
    let fresh: bool = sqlx::query_scalar(
        "SELECT last_success_at > now() - interval '5 minutes' FROM list_updates WHERE source = 'OFAC'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(fresh);

    // --- blocklist add/remove ------------------------------------------------------
    let w2 = wallet(W2);
    let r = cli.run(&[
        "blocklist-add",
        "--type",
        "wallet",
        "--value",
        W2,
        "--reason",
        "TEST_CASE",
    ]);
    assert!(r.ok, "{}", r.stderr);
    assert!(
        !r.stdout.contains(W2) && !r.stderr.contains(W2),
        "raw value printed"
    );
    let v = r.json.unwrap();
    assert_eq!(
        (&v["type"], &v["hash"], &v["block_source"]),
        (&"wallet".into(), &w2.clone().into(), &"internal".into())
    );
    let s = subject(&pool, &w2).await.unwrap();
    assert_eq!(
        (s.status, s.block_reason.as_deref()),
        (SubjectStatus::Blocked, Some("TEST_CASE"))
    );
    assert_eq!(
        cli.ok(&["blocklist-remove", "--type", "wallet", "--value", W2])["status"],
        "normal"
    );
    let s = subject(&pool, &w2).await.unwrap();
    assert_eq!(
        (s.status, s.block_source, s.block_reason),
        (SubjectStatus::Normal, None, None)
    );
    let e = cli.fails(&["blocklist-remove", "--type", "wallet", "--value", W2]);
    assert!(e.contains("not blocked"), "{e}");

    // OFAC blocks cannot be removed and are not downgraded by an internal add.
    let e = cli.fails(&["blocklist-remove", "--type", "wallet", "--value", W5]);
    assert!(e.contains("OFAC") && !e.contains(W5), "{e}");
    let v = cli.ok(&[
        "blocklist-add",
        "--type",
        "wallet",
        "--value",
        W5,
        "--reason",
        "TEST_CASE",
    ]);
    assert_eq!(v["block_source"], "OFAC");
    let s = subject(&pool, &wallet(W5)).await.unwrap();
    assert_eq!(
        (s.block_source, s.block_reason.as_deref()),
        (Some(BlockSource::Ofac), Some("TEST_OFAC"))
    );

    // Supplier round trip: vat() normalization → supplier_hash.
    let b = hashing::supplier_hash(&key(), "DE222222222");
    let v = cli.ok(&[
        "blocklist-add",
        "--type",
        "supplier",
        "--value",
        "de 222 222 222",
        "--reason",
        "TEST_SUPPLIER",
    ]);
    assert_eq!(
        (&v["type"], &v["hash"]),
        (&"supplier".into(), &b.clone().into())
    );
    assert_eq!(
        subject(&pool, &b).await.unwrap().subject_type,
        SubjectType::Supplier
    );
    cli.ok(&[
        "blocklist-remove",
        "--type",
        "supplier",
        "--value",
        "DE-222.222.222",
    ]);
    assert_eq!(
        subject(&pool, &b).await.unwrap().status,
        SubjectStatus::Normal
    );

    // Invalid input: exit 1, nothing echoed.
    let e = cli.fails(&[
        "blocklist-add",
        "--type",
        "wallet",
        "--value",
        W1_BAD,
        "--reason",
        "TEST_CASE",
    ]);
    assert!(e.contains("BECH32_INVALID") && !e.contains(W1_BAD), "{e}");
    let e = cli.fails(&[
        "blocklist-add",
        "--type",
        "wallet",
        "--value",
        W2,
        "--reason",
        "lower-case",
    ]);
    assert!(e.contains("reason"), "{e}");
    assert_eq!(
        subject(&pool, &w2).await.unwrap().status,
        SubjectStatus::Normal
    );

    // --- OFAC import (3.7.5) from a synthetic list ------------------------------
    let lf = lf();
    let xml = sdn_xml(&[
        ("201", "Entity", "Omega Holdings Ltd.", Some(W3)),
        ("202", "Entity", "Sigma Shipping", Some(W4)),
        ("203", "Vessel", "XY", None),
    ]);
    let before = snapshot(&pool).await;
    let e =
        sanctions::import_from_reader(&pool, &key(), &lf, xml.as_bytes(), sanctions::MIN_ENTRIES)
            .await
            .unwrap_err();
    assert!(e.to_string().contains("plausibility"), "{e}");
    assert_eq!(
        snapshot(&pool).await,
        before,
        "implausible list changes nothing"
    );

    let stats = sanctions::import_from_reader(&pool, &key(), &lf, xml.as_bytes(), 3)
        .await
        .unwrap();
    assert_eq!(
        (
            stats.entries,
            stats.names,
            stats.cardano_addresses,
            stats.unblocked_wallets
        ),
        (3, 2, 2, 1)
    );
    let names: Vec<(String, String)> = sqlx::query_as(
        "SELECT name_normalized, sdn_uid FROM sanction_names WHERE source = 'OFAC' ORDER BY 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        names,
        [
            ("omegaholdings".to_string(), "201".to_string()),
            ("sigmashipping".to_string(), "202".to_string())
        ]
    );
    let w3 = subject(&pool, &wallet(W3)).await.unwrap();
    assert_eq!(
        (w3.status, w3.block_source, w3.block_reason.as_deref()),
        (
            SubjectStatus::Blocked,
            Some(BlockSource::Ofac),
            Some("OFAC_SDN_201")
        )
    );
    // Internal block stays internal; delisted OFAC wallet (seed W5) is unblocked.
    let w4 = subject(&pool, &wallet(W4)).await.unwrap();
    assert_eq!(
        (w4.block_source, w4.block_reason.as_deref()),
        (Some(BlockSource::Internal), Some("TEST_INTERNAL"))
    );
    let w5 = subject(&pool, &wallet(W5)).await.unwrap();
    assert_eq!(
        (w5.status, w5.block_source, w5.block_reason),
        (SubjectStatus::Normal, None, None)
    );
    let lu: (i32, i32) =
        sqlx::query_as("SELECT entries, cardano_addresses FROM list_updates WHERE source = 'OFAC'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(lu, (3, 2));
    // lists-update reports a failed download with exit 1 and keeps the list.
    let e = cli.fails(&["lists-update"]);
    assert!(e.contains("OFAC download failed"), "{e}");
    assert_eq!(count(&pool, "SELECT count(*) FROM sanction_names").await, 2);

    // --- subject-delete (7.3) -----------------------------------------------------
    insert_check(
        &pool,
        "seed_1",
        serde_json::json!({ "check_id": "seed_1" }),
        0,
    )
    .await;
    insert_check(
        &pool,
        "chk_it_mention",
        serde_json::json!({ "supplier": { "supplier_hash": SUPPLIER_A } }),
        0,
    )
    .await;
    insert_check(&pool, "chk_it_other", serde_json::json!({ "x": 1 }), 0).await;
    for id in ["seed_1", "chk_it_mention", "chk_it_other"] {
        rstore::put_xml(&mut redis, id, "<x/>", 300).await.unwrap();
    }

    let e = cli.fails(&["subject-delete", "--hash", "hmac:%"]);
    assert!(e.contains("hash must match"), "{e}");
    let v = cli.ok(&["subject-delete", "--hash", SUPPLIER_A]);
    assert_eq!(v["deleted_invoices"], 6, "{v}");
    assert_eq!(v["deleted_checks"], 2, "{v}");
    assert_eq!(v["deleted_pairs"], 1, "{v}");
    assert_eq!(v["deleted_xml_keys"], 2, "{v}");
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM invoices WHERE check_id LIKE 'seed_%'"
        )
        .await,
        0
    );
    assert!(subject(&pool, SUPPLIER_A).await.is_none());
    assert!(subject(&pool, PAIR_A_W1).await.is_none());
    assert!(
        subject(&pool, WALLET_W1).await.is_some(),
        "other subjects stay"
    );
    let remaining: Vec<String> = sqlx::query_scalar("SELECT check_id FROM checks")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, ["chk_it_other"]);
    assert_eq!(rstore::get_xml(&mut redis, "seed_1").await.unwrap(), None);
    assert_eq!(
        rstore::get_xml(&mut redis, "chk_it_mention").await.unwrap(),
        None
    );
    assert!(rstore::get_xml(&mut redis, "chk_it_other")
        .await
        .unwrap()
        .is_some());
    rstore::del_xml(&mut redis, "chk_it_other").await.unwrap();

    // Subject delete by wallet hash removes that wallet's subject too.
    let v = cli.ok(&["subject-delete", "--hash", WALLET_W1]);
    assert_eq!(v["deleted_subjects"], 1, "{v}");
    assert!(subject(&pool, WALLET_W1).await.is_none());

    // --- retention (FR-76) --------------------------------------------------------
    insert_invoice(&pool, "old", 800).await;
    insert_invoice(&pool, "new", 10).await;
    insert_check(&pool, "chk_it_old", serde_json::json!({}), 731).await;
    insert_check(&pool, "chk_it_new", serde_json::json!({}), 729).await;
    let stats = jobs::run_retention(&pool, 730).await.unwrap();
    assert_eq!((stats.deleted_invoices, stats.deleted_checks), (1, 1));
    assert_eq!(stats.check_ids, ["chk_it_old"]);
    let invoices: Vec<String> = sqlx::query_scalar("SELECT check_id FROM invoices")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(invoices, ["chk_it_new"]);
    let mut checks: Vec<String> = sqlx::query_scalar("SELECT check_id FROM checks")
        .fetch_all(&pool)
        .await
        .unwrap();
    checks.sort();
    assert_eq!(checks, ["chk_it_new", "chk_it_other"]);
    let again = jobs::run_retention(&pool, 730).await.unwrap();
    assert_eq!((again.deleted_invoices, again.deleted_checks), (0, 0));

    pool.close().await;
}
