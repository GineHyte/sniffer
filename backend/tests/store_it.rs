//! Store integration tests against real Postgres and Redis.
//!
//! Gated by `SNIFFER_IT_DATABASE_URL` and `SNIFFER_IT_REDIS_URL`; each test prints a
//! note and passes when its variable is unset. Every run uses fresh time-based hashes,
//! so reruns against the same database do not collide.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rust_decimal::Decimal;
use sniffer::store::postgres::{self, BlockSource, SubjectStatus, SubjectType};
use sniffer::store::redis as rstore;

fn env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => {
            println!("skipping: {name} not set");
            None
        }
    }
}

fn unique() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{}-{n}", std::process::id())
}

fn fresh_hash(tag: &str) -> String {
    format!("hmac:it-{tag}-{}", unique())
}

fn d(s: &str) -> Decimal {
    s.parse().unwrap()
}

// One test function for Postgres: parallel `CREATE SCHEMA IF NOT EXISTS` from several
// test threads can race on pg_namespace, so the steps run in sequence.
#[tokio::test]
async fn postgres_store() {
    let Some(url) = env("SNIFFER_IT_DATABASE_URL") else {
        return;
    };

    // connect + migrate twice (idempotent).
    let pool = postgres::connect(&url).await.expect("connect");
    postgres::migrate(&pool).await.expect("first migrate");
    postgres::migrate(&pool).await.expect("second migrate");
    let pool2 = postgres::connect(&url).await.expect("second connect");
    postgres::migrate(&pool2)
        .await
        .expect("migrate on second pool");
    pool2.close().await;

    // search_path and placement of tables in schema sniffer.
    let search_path: String = sqlx::query_scalar("SHOW search_path")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(search_path, "sniffer");
    let placed: (bool, bool, bool) = sqlx::query_as(
        "SELECT to_regclass('sniffer._sqlx_migrations') IS NOT NULL,
                to_regclass('public._sqlx_migrations') IS NULL,
                to_regclass('sniffer.subjects') IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        placed,
        (true, true, true),
        "migrations table and tables in schema sniffer"
    );
    let applied: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sniffer._sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await
            .unwrap();
    let expected = sqlx::migrate!("./migrations").migrations.len() as i64;
    assert_eq!(
        applied, expected,
        "every migration applied once, no duplicate"
    );

    // approve x6 in one transaction -> approved 6, trust 0.545 (spec 7.5).
    let supplier = fresh_hash("supplier");
    let mut tx = pool.begin().await.unwrap();
    for _ in 0..6 {
        postgres::approve_subject(&mut *tx, &supplier, SubjectType::Supplier)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    // reject_risk once on a fresh subject -> trust -0.500.
    let wallet = fresh_hash("wallet");
    postgres::reject_risk_subject(&pool, &wallet, SubjectType::Wallet)
        .await
        .unwrap();

    // Half-away-from-zero rounding in SQL: 8 approved, 3 rejected -> -1/16 -> -0.063.
    let pair = fresh_hash("pair");
    for _ in 0..8 {
        postgres::approve_subject(&pool, &pair, SubjectType::Pair)
            .await
            .unwrap();
    }
    for _ in 0..3 {
        postgres::reject_risk_subject(&pool, &pair, SubjectType::Pair)
            .await
            .unwrap();
    }

    // OFAC block, then internal block: source and reason stay OFAC.
    let ofac_wallet = fresh_hash("ofac");
    postgres::block_subject(
        &pool,
        &ofac_wallet,
        SubjectType::Wallet,
        BlockSource::Ofac,
        "TEST_OFAC",
    )
    .await
    .unwrap();
    postgres::block_subject(
        &pool,
        &ofac_wallet,
        SubjectType::Wallet,
        BlockSource::Internal,
        "AGENT_DECISION",
    )
    .await
    .unwrap();

    // Internal block on a subject with counters keeps the counters; OFAC then overrides.
    let internal_wallet = fresh_hash("internal");
    postgres::approve_subject(&pool, &internal_wallet, SubjectType::Wallet)
        .await
        .unwrap();
    postgres::block_subject(
        &pool,
        &internal_wallet,
        SubjectType::Wallet,
        BlockSource::Internal,
        "TEST_INTERNAL",
    )
    .await
    .unwrap();

    let missing = fresh_hash("missing");
    let subjects = postgres::get_subjects(
        &pool,
        &[
            &supplier,
            &wallet,
            &pair,
            &ofac_wallet,
            &internal_wallet,
            &missing,
        ],
    )
    .await
    .unwrap();
    assert_eq!(subjects.len(), 5);
    assert!(!subjects.contains_key(&missing));

    let s = &subjects[&supplier];
    assert_eq!(s.subject_type, SubjectType::Supplier);
    assert_eq!((s.approved, s.rejected_risk), (6, 0));
    assert_eq!(s.trust, d("0.545"));
    assert_eq!(s.trust, postgres::trust_value(6, 0));
    assert_eq!(s.status, SubjectStatus::Normal);

    let w = &subjects[&wallet];
    assert_eq!((w.approved, w.rejected_risk), (0, 1));
    assert_eq!(w.trust, d("-0.500"));

    let p = &subjects[&pair];
    assert_eq!((p.approved, p.rejected_risk), (8, 3));
    assert_eq!(p.trust, d("-0.063"));
    assert_eq!(p.trust, postgres::trust_value(8, 3));

    let o = &subjects[&ofac_wallet];
    assert!(o.is_blocked());
    assert_eq!(o.block_source, Some(BlockSource::Ofac));
    assert_eq!(o.block_reason.as_deref(), Some("TEST_OFAC"));
    assert_eq!(o.trust, Decimal::ZERO);

    let i = &subjects[&internal_wallet];
    assert!(i.is_blocked());
    assert_eq!(i.block_source, Some(BlockSource::Internal));
    assert_eq!(i.block_reason.as_deref(), Some("TEST_INTERNAL"));
    assert_eq!((i.approved, i.trust), (1, d("0.167")));

    postgres::block_subject(
        &pool,
        &internal_wallet,
        SubjectType::Wallet,
        BlockSource::Ofac,
        "TEST_OFAC",
    )
    .await
    .unwrap();
    let after = postgres::get_subjects(&pool, &[&internal_wallet])
        .await
        .unwrap();
    assert_eq!(
        after[&internal_wallet].block_source,
        Some(BlockSource::Ofac)
    );
    assert_eq!(
        after[&internal_wallet].block_reason.as_deref(),
        Some("TEST_OFAC")
    );

    let empty: [&str; 0] = [];
    assert!(postgres::get_subjects(&pool, &empty)
        .await
        .unwrap()
        .is_empty());

    pool.close().await;
}

#[tokio::test]
async fn redis_store() {
    let Some(url) = env("SNIFFER_IT_REDIS_URL") else {
        return;
    };
    let mut conn = rstore::connect(&url).await.expect("connect");
    rstore::ping(&mut conn).await.unwrap();

    // Lock: NX, second attempt fails, PX ~120 s, release allows re-lock.
    let invoice = fresh_hash("invoice");
    assert!(rstore::try_lock_invoice(&mut conn, &invoice).await.unwrap());
    assert!(!rstore::try_lock_invoice(&mut conn, &invoice).await.unwrap());
    let pttl: i64 = redis::cmd("PTTL")
        .arg(rstore::invoice_lock_key(&invoice))
        .query_async(&mut conn)
        .await
        .unwrap();
    assert!(pttl > 0 && pttl <= 120_000, "pttl {pttl}");
    let value: String = redis::cmd("GET")
        .arg(rstore::invoice_lock_key(&invoice))
        .query_async(&mut conn)
        .await
        .unwrap();
    assert_eq!(value, "1");
    rstore::unlock_invoice(&mut conn, &invoice).await.unwrap();
    assert!(rstore::try_lock_invoice(&mut conn, &invoice).await.unwrap());
    rstore::unlock_invoice(&mut conn, &invoice).await.unwrap();

    // XML roundtrip with TTL, then delete.
    let check_id = format!("chk_it_{}", unique());
    let xml = "<?xml version=\"1.0\"?><rsm:CrossIndustryInvoice>Müller & Söhne</rsm:CrossIndustryInvoice>";
    rstore::put_xml(&mut conn, &check_id, xml, 300)
        .await
        .unwrap();
    assert_eq!(
        rstore::get_xml(&mut conn, &check_id)
            .await
            .unwrap()
            .as_deref(),
        Some(xml)
    );
    let ttl: i64 = redis::cmd("TTL")
        .arg(rstore::xml_key(&check_id))
        .query_async(&mut conn)
        .await
        .unwrap();
    assert!(ttl > 0 && ttl <= 300, "ttl {ttl}");
    rstore::del_xml(&mut conn, &check_id).await.unwrap();
    assert_eq!(rstore::get_xml(&mut conn, &check_id).await.unwrap(), None);

    // JSON cache roundtrip; undecodable value is a miss.
    let key = rstore::vies_cache_key(&fresh_hash("supplier"));
    let value = serde_json::json!({"valid": true, "name": "Alpha Consulting GmbH"});
    rstore::cache_put_json(&mut conn, &key, &value, rstore::VIES_CACHE_TTL_SECS)
        .await
        .unwrap();
    let got: Option<serde_json::Value> = rstore::cache_get_json(&mut conn, &key).await.unwrap();
    assert_eq!(got, Some(value));
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg("not json")
        .query_async(&mut conn)
        .await
        .unwrap();
    let got: Option<serde_json::Value> = rstore::cache_get_json(&mut conn, &key).await.unwrap();
    assert_eq!(got, None);
    let _: i64 = redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .unwrap();
}
