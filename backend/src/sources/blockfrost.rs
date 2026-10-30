//! Blockfrost: first transaction time of an address (spec 3.7.2).
//! Failure code `BLOCKFROST_UNAVAILABLE`; affects W-2, W-4.

use serde::Deserialize;

use super::{build_url, http_client, HttpSettings, SourceError};

/// Blockfrost API client (`BLOCKFROST_BASE_URL`, `BLOCKFROST_PROJECT_ID`).
#[derive(Clone)]
pub struct BlockfrostClient {
    http: reqwest::Client,
    base_url: String,
    project_id: String,
}

impl std::fmt::Debug for BlockfrostClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlockfrostClient")
            .field("base_url", &self.base_url)
            .field("project_id", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
struct Tx {
    block_time: i64,
}

impl BlockfrostClient {
    pub fn new(
        base_url: &str,
        project_id: &str,
        settings: &HttpSettings,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            http: http_client(settings)?,
            base_url: base_url.to_string(),
            project_id: project_id.to_string(),
        })
    }

    /// `GET <base>/addresses/<addr>/transactions?order=asc&count=1&page=1`.
    /// `200 []` or `404` → `None`; `200 [tx]` → `Some(block_time)`; anything else,
    /// timeout or invalid JSON → [`SourceError::Unavailable`].
    pub async fn first_tx_time(&self, address: &str) -> Result<Option<i64>, SourceError> {
        let mut url = build_url(&self.base_url, &["addresses", address, "transactions"])?;
        url.query_pairs_mut()
            .append_pair("order", "asc")
            .append_pair("count", "1")
            .append_pair("page", "1");
        let resp = self
            .http
            .get(url)
            .header("project_id", &self.project_id)
            .send()
            .await
            .map_err(|_| SourceError::Unavailable)?;
        match resp.status().as_u16() {
            404 => Ok(None),
            200 => {
                let body = resp.bytes().await.map_err(|_| SourceError::Unavailable)?;
                let txs: Vec<Tx> =
                    serde_json::from_slice(&body).map_err(|_| SourceError::Unavailable)?;
                Ok(txs.first().map(|t| t.block_time))
            }
            _ => Err(SourceError::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const PID: &str = "preprodTestProjectId";

    async fn server_with(resp: ResponseTemplate) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/addresses/{W1}/transactions")))
            .and(query_param("order", "asc"))
            .and(query_param("count", "1"))
            .and(query_param("page", "1"))
            .and(header("project_id", PID))
            .respond_with(resp)
            .expect(1)
            .mount(&server)
            .await;
        server
    }

    fn client(server: &MockServer, timeout_ms: u64) -> BlockfrostClient {
        BlockfrostClient::new(&server.uri(), PID, &HttpSettings { timeout_ms }).unwrap()
    }

    async fn run(resp: ResponseTemplate) -> Result<Option<i64>, SourceError> {
        let server = server_with(resp).await;
        client(&server, 2000).first_tx_time(W1).await
    }

    #[tokio::test]
    async fn one_tx_returns_block_time() {
        let body = json!([{"tx_hash": "a".repeat(64), "tx_index": 0, "block_height": 100, "block_time": 1768035600}]);
        let got = run(ResponseTemplate::new(200).set_body_json(body)).await;
        assert_eq!(got, Ok(Some(1768035600)));
    }

    #[tokio::test]
    async fn empty_array_is_no_tx() {
        let got = run(ResponseTemplate::new(200).set_body_json(json!([]))).await;
        assert_eq!(got, Ok(None));
    }

    #[tokio::test]
    async fn not_found_is_no_tx() {
        let body = json!({"status_code": 404, "error": "Not Found", "message": "The requested component has not been found."});
        let got = run(ResponseTemplate::new(404).set_body_json(body)).await;
        assert_eq!(got, Ok(None));
    }

    #[tokio::test]
    async fn server_error_is_unavailable() {
        let got = run(ResponseTemplate::new(500)).await;
        assert_eq!(got, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn rate_limited_is_unavailable() {
        let got = run(ResponseTemplate::new(429)).await;
        assert_eq!(got, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn invalid_json_is_unavailable() {
        let got = run(ResponseTemplate::new(200).set_body_string("not json")).await;
        assert_eq!(got, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn missing_block_time_is_unavailable() {
        let got = run(ResponseTemplate::new(200).set_body_json(json!([{"tx_hash": "x"}]))).await;
        assert_eq!(got, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn timeout_is_unavailable() {
        let server = server_with(
            ResponseTemplate::new(200)
                .set_body_json(json!([]))
                .set_delay(Duration::from_millis(1000)),
        )
        .await;
        let got = client(&server, 200).first_tx_time(W1).await;
        assert_eq!(got, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn missing_project_id_header_does_not_match() {
        // Sanity check of the matcher: a client with another project id gets wiremock's 404,
        // which proves the header matcher is active (and 404 maps to "no tx").
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header("project_id", PID))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let c = BlockfrostClient::new(&server.uri(), "other", &HttpSettings { timeout_ms: 2000 })
            .unwrap();
        assert_eq!(c.first_tx_time(W1).await, Ok(None));
    }

    #[test]
    fn debug_redacts_project_id() {
        let c = BlockfrostClient::new("http://h", "secret-pid", &HttpSettings::default()).unwrap();
        assert!(!format!("{c:?}").contains("secret-pid"));
    }
}
