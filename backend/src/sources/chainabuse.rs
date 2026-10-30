//! Chainabuse: scam reports for an address (spec 3.7.4).
//! Failure code `CHAINABUSE_UNAVAILABLE`; affects W-1, W-6.

use serde::Deserialize;

use super::{build_url, http_client, ChainabuseValue, HttpSettings, SourceError};

/// Chainabuse API client (`CHAINABUSE_BASE_URL`, `CHAINABUSE_API_KEY`).
#[derive(Clone)]
pub struct ChainabuseClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl std::fmt::Debug for ChainabuseClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChainabuseClient")
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize)]
struct Page {
    reports: Vec<Report>,
    count: u64,
}

#[derive(Deserialize)]
struct Report {
    #[serde(default)]
    trusted: Option<bool>,
    #[serde(default)]
    checked: Option<bool>,
}

impl ChainabuseClient {
    pub fn new(
        base_url: &str,
        api_key: &str,
        settings: &HttpSettings,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            http: http_client(settings)?,
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
        })
    }

    /// `GET <base>/reports?address=<addr>&page=1&perPage=50` with Basic auth `key:key`.
    /// 200 → `reports = count`, `trusted_or_checked` = reports on the first page with
    /// `trusted == true || checked == true`. Anything else, timeout or invalid JSON →
    /// [`SourceError::Unavailable`].
    pub async fn reports(&self, address: &str) -> Result<ChainabuseValue, SourceError> {
        let mut url = build_url(&self.base_url, &["reports"])?;
        url.query_pairs_mut()
            .append_pair("address", address)
            .append_pair("page", "1")
            .append_pair("perPage", "50");
        let resp = self
            .http
            .get(url)
            .basic_auth(&self.api_key, Some(&self.api_key))
            .send()
            .await
            .map_err(|_| SourceError::Unavailable)?;
        if resp.status().as_u16() != 200 {
            return Err(SourceError::Unavailable);
        }
        let body = resp.bytes().await.map_err(|_| SourceError::Unavailable)?;
        let page: Page = serde_json::from_slice(&body).map_err(|_| SourceError::Unavailable)?;
        let trusted_or_checked = page
            .reports
            .iter()
            .filter(|r| r.trusted == Some(true) || r.checked == Some(true))
            .count() as u64;
        Ok(ChainabuseValue {
            reports: page.count,
            trusted_or_checked,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use wiremock::matchers::{basic_auth, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const KEY: &str = "ca-test-key";

    async fn run_with(
        resp: ResponseTemplate,
        timeout_ms: u64,
    ) -> Result<ChainabuseValue, SourceError> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/reports"))
            .and(query_param("address", W1))
            .and(query_param("page", "1"))
            .and(query_param("perPage", "50"))
            .and(basic_auth(KEY, KEY))
            .respond_with(resp)
            .expect(1)
            .mount(&server)
            .await;
        ChainabuseClient::new(&server.uri(), KEY, &HttpSettings { timeout_ms })
            .unwrap()
            .reports(W1)
            .await
    }

    async fn run(resp: ResponseTemplate) -> Result<ChainabuseValue, SourceError> {
        run_with(resp, 2000).await
    }

    fn ok(body: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(body)
    }

    fn value(reports: u64, trusted_or_checked: u64) -> ChainabuseValue {
        ChainabuseValue {
            reports,
            trusted_or_checked,
        }
    }

    #[tokio::test]
    async fn empty_page() {
        assert_eq!(
            run(ok(json!({"reports": [], "count": 0}))).await,
            Ok(value(0, 0))
        );
    }

    #[tokio::test]
    async fn one_trusted_one_unverified() {
        let body = json!({"reports": [
            {"id": "r1", "trusted": true, "checked": false},
            {"id": "r2", "trusted": false, "checked": false}
        ], "count": 2});
        assert_eq!(run(ok(body)).await, Ok(value(2, 1)));
    }

    #[tokio::test]
    async fn trusted_or_checked_counting() {
        let body = json!({"reports": [
            {"trusted": true, "checked": false},
            {"trusted": false, "checked": true},
            {"trusted": true, "checked": true},
            {"trusted": false, "checked": false},
            {"id": "no-flags"},
            {"trusted": null, "checked": null}
        ], "count": 6});
        assert_eq!(run(ok(body)).await, Ok(value(6, 3)));
    }

    #[tokio::test]
    async fn reports_uses_count_not_page_length() {
        let body = json!({"reports": [{"checked": true}], "count": 120});
        assert_eq!(run(ok(body)).await, Ok(value(120, 1)));
    }

    #[tokio::test]
    async fn missing_count_is_unavailable() {
        let body = json!({"reports": []});
        assert_eq!(run(ok(body)).await, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn non_200_is_unavailable() {
        for status in [401, 404, 429, 500] {
            assert_eq!(
                run(ResponseTemplate::new(status)).await,
                Err(SourceError::Unavailable),
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_json_is_unavailable() {
        let resp = ResponseTemplate::new(200).set_body_string("{");
        assert_eq!(run(resp).await, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn timeout_is_unavailable() {
        let resp = ok(json!({"reports": [], "count": 0})).set_delay(Duration::from_millis(1000));
        assert_eq!(run_with(resp, 200).await, Err(SourceError::Unavailable));
    }

    #[test]
    fn debug_redacts_api_key() {
        let c = ChainabuseClient::new("http://h", "secret-key", &HttpSettings::default()).unwrap();
        assert!(!format!("{c:?}").contains("secret-key"));
    }
}
