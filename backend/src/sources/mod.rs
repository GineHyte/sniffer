//! External sources (spec 3.7.2-3.7.4, 3.7.6).
//!
//! The clients are pure: they take explicit settings and never read the environment.
//! Every HTTP call uses one timeout (`HTTP_TIMEOUT_MS`) and no automatic retry (3.7).
//! In `api` mode successful answers are cached in Redis (3.9); `mock` mode reads
//! `data/*-mock.json`, makes no network calls and caches nothing (3.7.6).

pub mod blockfrost;
pub mod chainabuse;
pub mod mock;
pub mod vies;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use redis::aio::ConnectionLike;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::store::redis as rstore;

pub use blockfrost::BlockfrostClient;
pub use chainabuse::ChainabuseClient;
pub use mock::{BlockfrostMock, ChainabuseMock, MockLoadError, ViesMock};
pub use vies::ViesClient;

/// A source call failed. Carries no raw request or response data (FR-32, FR-33);
/// the caller maps it to `BLOCKFROST_UNAVAILABLE` etc. (FR-44).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    #[error("source unavailable")]
    Unavailable,
}

/// HTTP settings shared by all source clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpSettings {
    /// `HTTP_TIMEOUT_MS`
    pub timeout_ms: u64,
}

impl Default for HttpSettings {
    fn default() -> Self {
        Self { timeout_ms: 5000 }
    }
}

/// Builds the shared HTTP client: total timeout, default redirect policy, no retry.
pub fn http_client(settings: &HttpSettings) -> Result<reqwest::Client, SourceError> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(settings.timeout_ms))
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| SourceError::Unavailable)
}

/// Joins a base URL (with or without trailing slash) and path segments, percent-encoding
/// each segment.
pub(crate) fn build_url(base: &str, segments: &[&str]) -> Result<reqwest::Url, SourceError> {
    let mut url = reqwest::Url::parse(base).map_err(|_| SourceError::Unavailable)?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| SourceError::Unavailable)?;
        path.pop_if_empty();
        path.extend(segments);
    }
    Ok(url)
}

/// Blockfrost cache value: `{"first_tx_time": <unix>|null}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockfrostValue {
    pub first_tx_time: Option<i64>,
}

/// VIES cache value: `{"valid": true|false}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViesValue {
    pub valid: bool,
}

/// Chainabuse cache value: `{"reports": <n>, "trusted_or_checked": <m>}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainabuseValue {
    pub reports: u64,
    pub trusted_or_checked: u64,
}

/// Read-through cache: returns the cached value for `key` if present, otherwise runs
/// `fetch` and stores its result with `ttl_secs`, only on success (3.9).
/// Redis errors never fail the check: a failed read counts as a miss, a failed write
/// is logged (key only, no raw data) and ignored. `conn = None` disables caching.
pub async fn cached<C, T, F, Fut>(
    conn: Option<&mut C>,
    key: &str,
    ttl_secs: u64,
    fetch: F,
) -> Result<T, SourceError>
where
    C: ConnectionLike + Send,
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, SourceError>>,
{
    let Some(conn) = conn else {
        return fetch().await;
    };
    match rstore::cache_get_json::<C, T>(conn, key).await {
        Ok(Some(hit)) => return Ok(hit),
        Ok(None) => {}
        Err(e) => tracing::warn!(key, error_kind = ?e.kind(), "cache read failed"),
    }
    let value = fetch().await?;
    if let Err(e) = rstore::cache_put_json(conn, key, &value, ttl_secs).await {
        tracing::warn!(key, error_kind = ?e.kind(), "cache write failed");
    }
    Ok(value)
}

/// Blockfrost in `api` or `mock` mode (`BLOCKFROST_MODE`).
#[derive(Debug, Clone)]
pub enum Blockfrost {
    Api(BlockfrostClient),
    Mock(Arc<BlockfrostMock>),
}

impl Blockfrost {
    /// First transaction time (UNIX seconds) of `address`, `None` if it has none.
    /// In `api` mode the result is cached under `sniffer:cache:bf:<address_hash>`.
    pub async fn first_tx_time<C: ConnectionLike + Send>(
        &self,
        cache: Option<&mut C>,
        address: &str,
        address_hash: &str,
    ) -> Result<Option<i64>, SourceError> {
        match self {
            Self::Mock(m) => m.first_tx_time(address),
            Self::Api(client) => cached(
                cache,
                &rstore::bf_cache_key(address_hash),
                rstore::BF_CACHE_TTL_SECS,
                || async {
                    client
                        .first_tx_time(address)
                        .await
                        .map(|first_tx_time| BlockfrostValue { first_tx_time })
                },
            )
            .await
            .map(|v| v.first_tx_time),
        }
    }
}

/// VIES in `api` or `mock` mode (`VIES_MODE`).
#[derive(Debug, Clone)]
pub enum Vies {
    Api(ViesClient),
    Mock(Arc<ViesMock>),
}

impl Vies {
    /// Validity of the normalized VAT ID. `None` = not applicable (no EU prefix,
    /// `checks_skipped` with `not_applicable`). In `api` mode the result is cached under
    /// `sniffer:cache:vies:<supplier_hash>`.
    pub async fn check<C: ConnectionLike + Send>(
        &self,
        cache: Option<&mut C>,
        vat_normalized: &str,
        supplier_hash: &str,
    ) -> Option<Result<bool, SourceError>> {
        let (cc, rest) = vies::applicable(vat_normalized)?;
        Some(match self {
            Self::Mock(m) => m.valid(vat_normalized),
            Self::Api(client) => cached(
                cache,
                &rstore::vies_cache_key(supplier_hash),
                rstore::VIES_CACHE_TTL_SECS,
                || async {
                    client
                        .check(cc, rest)
                        .await
                        .map(|valid| ViesValue { valid })
                },
            )
            .await
            .map(|v| v.valid),
        })
    }
}

/// Chainabuse in `api` or `mock` mode (`CHAINABUSE_MODE`).
#[derive(Debug, Clone)]
pub enum Chainabuse {
    Api(ChainabuseClient),
    Mock(Arc<ChainabuseMock>),
}

impl Chainabuse {
    /// Report counts for `address`. In `api` mode the result is cached under
    /// `sniffer:cache:ca:<address_hash>`.
    pub async fn reports<C: ConnectionLike + Send>(
        &self,
        cache: Option<&mut C>,
        address: &str,
        address_hash: &str,
    ) -> Result<ChainabuseValue, SourceError> {
        match self {
            Self::Mock(m) => m.reports(address),
            Self::Api(client) => {
                cached(
                    cache,
                    &rstore::ca_cache_key(address_hash),
                    rstore::CA_CACHE_TTL_SECS,
                    || client.reports(address),
                )
                .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";

    fn settings() -> HttpSettings {
        HttpSettings { timeout_ms: 2000 }
    }

    #[test]
    fn build_url_handles_trailing_slash_and_encodes() {
        let a = build_url("http://h/api/v0", &["addresses", "x y"]).unwrap();
        let b = build_url("http://h/api/v0/", &["addresses", "x y"]).unwrap();
        assert_eq!(a.as_str(), "http://h/api/v0/addresses/x%20y");
        assert_eq!(a, b);
    }

    #[test]
    fn cache_values_serialize_per_spec() {
        let v = serde_json::to_value(BlockfrostValue {
            first_tx_time: None,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"first_tx_time": null}));
        let v = serde_json::to_value(ViesValue { valid: true }).unwrap();
        assert_eq!(v, serde_json::json!({"valid": true}));
        let v = serde_json::to_value(ChainabuseValue {
            reports: 2,
            trusted_or_checked: 1,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"reports": 2, "trusted_or_checked": 1})
        );
    }

    #[test]
    fn source_error_message_has_no_data() {
        assert_eq!(SourceError::Unavailable.to_string(), "source unavailable");
    }

    #[tokio::test]
    async fn no_cache_conn_calls_fetch_each_time() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/addresses/{W1}/transactions")))
            .respond_with(ResponseTemplate::new(404))
            .expect(2)
            .mount(&server)
            .await;
        let client = BlockfrostClient::new(&server.uri(), "pid", &settings()).unwrap();
        let bf = Blockfrost::Api(client);
        for _ in 0..2 {
            let got = bf
                .first_tx_time::<redis::aio::MultiplexedConnection>(None, W1, "hmac:x")
                .await;
            assert_eq!(got, Ok(None));
        }
    }

    #[tokio::test]
    async fn vies_not_applicable_makes_no_call() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let vies = Vies::Api(ViesClient::new(&server.uri(), &settings()).unwrap());
        let got = vies
            .check::<redis::aio::MultiplexedConnection>(None, "CH123456789", "hmac:s")
            .await;
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn mock_mode_facades_use_mock_data() {
        type Conn = redis::aio::MultiplexedConnection;
        let bf = Blockfrost::Mock(Arc::new(
            BlockfrostMock::from_json(&format!(
                r#"{{"addresses": {{"{W1}": {{"first_tx_time": "2026-01-10T09:00:00Z"}}}}}}"#
            ))
            .unwrap(),
        ));
        assert_eq!(
            bf.first_tx_time::<Conn>(None, W1, "h").await,
            Ok(Some(1_768_035_600))
        );
        let vies = Vies::Mock(Arc::new(
            ViesMock::from_json(r#"{"DE1": "error"}"#).unwrap(),
        ));
        assert_eq!(
            vies.check::<Conn>(None, "DE1", "h").await,
            Some(Err(SourceError::Unavailable))
        );
        assert_eq!(vies.check::<Conn>(None, "US1", "h").await, None);
        let ca = Chainabuse::Mock(Arc::new(ChainabuseMock::from_json("{}").unwrap()));
        assert_eq!(
            ca.reports::<Conn>(None, W1, "h").await,
            Ok(ChainabuseValue {
                reports: 0,
                trusted_or_checked: 0
            })
        );
    }

    /// Redis-backed cache tests. They run only when `SNIFFER_IT_REDIS_URL` is set
    /// (e.g. `redis://127.0.0.1:6380/14`); otherwise they print a note and pass.
    mod redis_cache {
        use super::*;
        use wiremock::matchers::query_param;

        async fn conn() -> Option<redis::aio::MultiplexedConnection> {
            let Ok(url) = std::env::var("SNIFFER_IT_REDIS_URL") else {
                eprintln!("skipping redis cache test: SNIFFER_IT_REDIS_URL not set");
                return None;
            };
            Some(rstore::connect(&url).await.expect("redis connect"))
        }

        fn unique(tag: &str) -> String {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("hmac:test-{tag}-{nanos}")
        }

        async fn ttl(conn: &mut redis::aio::MultiplexedConnection, key: &str) -> i64 {
            redis::cmd("TTL").arg(key).query_async(conn).await.unwrap()
        }

        async fn del(conn: &mut redis::aio::MultiplexedConnection, key: &str) {
            let _: i64 = redis::cmd("DEL").arg(key).query_async(conn).await.unwrap();
        }

        #[tokio::test]
        async fn blockfrost_cache_hit_avoids_second_call() {
            let Some(mut conn) = conn().await else { return };
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path(format!("/addresses/{W1}/transactions")))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!([{"block_time": 1768035600}])),
                )
                .expect(1)
                .mount(&server)
                .await;
            let bf =
                Blockfrost::Api(BlockfrostClient::new(&server.uri(), "pid", &settings()).unwrap());
            let hash = unique("bf");
            for _ in 0..2 {
                let got = bf.first_tx_time(Some(&mut conn), W1, &hash).await;
                assert_eq!(got, Ok(Some(1768035600)));
            }
            let key = rstore::bf_cache_key(&hash);
            let raw: String = redis::cmd("GET")
                .arg(&key)
                .query_async(&mut conn)
                .await
                .unwrap();
            assert_eq!(raw, r#"{"first_tx_time":1768035600}"#);
            let t = ttl(&mut conn, &key).await;
            assert!(t > 590 && t <= 600, "ttl {t}");
            del(&mut conn, &key).await;
        }

        #[tokio::test]
        async fn blockfrost_failure_is_not_cached() {
            let Some(mut conn) = conn().await else { return };
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(500))
                .expect(2)
                .mount(&server)
                .await;
            let bf =
                Blockfrost::Api(BlockfrostClient::new(&server.uri(), "pid", &settings()).unwrap());
            let hash = unique("bf-fail");
            for _ in 0..2 {
                let got = bf.first_tx_time(Some(&mut conn), W1, &hash).await;
                assert_eq!(got, Err(SourceError::Unavailable));
            }
            let exists: i64 = redis::cmd("EXISTS")
                .arg(rstore::bf_cache_key(&hash))
                .query_async(&mut conn)
                .await
                .unwrap();
            assert_eq!(exists, 0);
        }

        #[tokio::test]
        async fn vies_cache_hit_avoids_second_call() {
            let Some(mut conn) = conn().await else { return };
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/ms/DE/vat/111111111"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"isValid": true, "userError": "VALID"})),
                )
                .expect(1)
                .mount(&server)
                .await;
            let vies = Vies::Api(ViesClient::new(&server.uri(), &settings()).unwrap());
            let hash = unique("vies");
            for _ in 0..2 {
                let got = vies.check(Some(&mut conn), "DE111111111", &hash).await;
                assert_eq!(got, Some(Ok(true)));
            }
            let key = rstore::vies_cache_key(&hash);
            let t = ttl(&mut conn, &key).await;
            assert!(t > 86_390 && t <= 86_400, "ttl {t}");
            del(&mut conn, &key).await;
        }

        #[tokio::test]
        async fn chainabuse_cache_hit_avoids_second_call() {
            let Some(mut conn) = conn().await else { return };
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/reports"))
                .and(query_param("address", W1))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"reports": [], "count": 0})),
                )
                .expect(1)
                .mount(&server)
                .await;
            let ca =
                Chainabuse::Api(ChainabuseClient::new(&server.uri(), "key", &settings()).unwrap());
            let hash = unique("ca");
            for _ in 0..2 {
                let got = ca.reports(Some(&mut conn), W1, &hash).await;
                assert_eq!(
                    got,
                    Ok(ChainabuseValue {
                        reports: 0,
                        trusted_or_checked: 0
                    })
                );
            }
            let key = rstore::ca_cache_key(&hash);
            let t = ttl(&mut conn, &key).await;
            assert!(t > 3_590 && t <= 3_600, "ttl {t}");
            del(&mut conn, &key).await;
        }
    }
}
