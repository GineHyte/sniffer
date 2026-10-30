//! VIES: EU VAT ID validity (spec 3.7.3).
//! Failure code `VIES_UNAVAILABLE`; affects S-2, T-4.

use serde::Deserialize;

use super::{build_url, http_client, HttpSettings, SourceError};

/// Country prefixes VIES answers for (3.7.3), including `EL` (Greece) and `XI`
/// (Northern Ireland).
pub const VIES_PREFIXES: [&str; 28] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
];

/// Splits a normalized VAT ID (`normalize::vat`) into `(country prefix, rest)` when the
/// first two characters are a VIES prefix; `None` = not applicable (`checks_skipped`).
pub fn applicable(vat_normalized: &str) -> Option<(&str, &str)> {
    let cc = vat_normalized.get(..2)?;
    VIES_PREFIXES
        .contains(&cc)
        .then(|| (cc, &vat_normalized[2..]))
}

/// VIES REST client (`VIES_BASE_URL`).
#[derive(Debug, Clone)]
pub struct ViesClient {
    http: reqwest::Client,
    base_url: String,
}

#[derive(Deserialize)]
struct Answer {
    #[serde(rename = "userError")]
    user_error: Option<String>,
}

impl ViesClient {
    pub fn new(base_url: &str, settings: &HttpSettings) -> Result<Self, SourceError> {
        Ok(Self {
            http: http_client(settings)?,
            base_url: base_url.to_string(),
        })
    }

    /// `GET <base>/ms/<cc>/vat/<rest>`. HTTP 200 with `userError` `VALID` → `true`;
    /// `INVALID` or `INVALID_INPUT` → `false`; any other `userError`, status, timeout
    /// or invalid JSON → [`SourceError::Unavailable`].
    pub async fn check(&self, cc: &str, rest: &str) -> Result<bool, SourceError> {
        let url = build_url(&self.base_url, &["ms", cc, "vat", rest])?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| SourceError::Unavailable)?;
        if resp.status().as_u16() != 200 {
            return Err(SourceError::Unavailable);
        }
        let body = resp.bytes().await.map_err(|_| SourceError::Unavailable)?;
        let answer: Answer = serde_json::from_slice(&body).map_err(|_| SourceError::Unavailable)?;
        match answer.user_error.as_deref() {
            Some("VALID") => Ok(true),
            Some("INVALID") | Some("INVALID_INPUT") => Ok(false),
            _ => Err(SourceError::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn applicable_splits_eu_prefixes() {
        assert_eq!(applicable("DE111111111"), Some(("DE", "111111111")));
        assert_eq!(applicable("EL123456789"), Some(("EL", "123456789")));
        assert_eq!(applicable("XI123456789"), Some(("XI", "123456789")));
        assert_eq!(applicable("ATU12345678"), Some(("AT", "U12345678")));
    }

    #[test]
    fn applicable_rejects_others() {
        assert_eq!(
            applicable("GR123456789"),
            None,
            "GR is normalized to EL first"
        );
        assert_eq!(applicable("GB123456789"), None);
        assert_eq!(applicable("CHE123456789"), None);
        assert_eq!(applicable("D"), None);
        assert_eq!(applicable(""), None);
    }

    #[test]
    fn all_28_prefixes_are_listed() {
        assert_eq!(VIES_PREFIXES.len(), 28);
        for p in VIES_PREFIXES {
            assert_eq!(applicable(&format!("{p}1")), Some((p, "1")));
        }
    }

    async fn run_with(resp: ResponseTemplate, timeout_ms: u64) -> Result<bool, SourceError> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ms/DE/vat/111111111"))
            .respond_with(resp)
            .expect(1)
            .mount(&server)
            .await;
        ViesClient::new(&server.uri(), &HttpSettings { timeout_ms })
            .unwrap()
            .check("DE", "111111111")
            .await
    }

    async fn run(resp: ResponseTemplate) -> Result<bool, SourceError> {
        run_with(resp, 2000).await
    }

    fn user_error(v: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({"isValid": v == "VALID", "userError": v}))
    }

    #[tokio::test]
    async fn valid() {
        assert_eq!(run(user_error("VALID")).await, Ok(true));
    }

    #[tokio::test]
    async fn invalid() {
        let body = json!({"isValid": false, "requestDate": "2026-10-30T12:00:00.000Z",
                          "userError": "INVALID", "name": "---", "address": "---"});
        assert_eq!(
            run(ResponseTemplate::new(200).set_body_json(body)).await,
            Ok(false)
        );
    }

    #[tokio::test]
    async fn invalid_input() {
        assert_eq!(run(user_error("INVALID_INPUT")).await, Ok(false));
    }

    #[tokio::test]
    async fn other_user_errors_are_unavailable() {
        for e in [
            "MS_UNAVAILABLE",
            "TIMEOUT",
            "SERVICE_UNAVAILABLE",
            "MS_MAX_CONCURRENT_REQ",
            "GLOBAL_MAX_CONCURRENT_REQ",
        ] {
            assert_eq!(
                run(user_error(e)).await,
                Err(SourceError::Unavailable),
                "{e}"
            );
        }
    }

    #[tokio::test]
    async fn missing_user_error_is_unavailable() {
        let resp = ResponseTemplate::new(200).set_body_json(json!({"isValid": true}));
        assert_eq!(run(resp).await, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn non_200_is_unavailable() {
        for status in [400, 404, 500, 503] {
            assert_eq!(
                run(ResponseTemplate::new(status)).await,
                Err(SourceError::Unavailable),
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_json_is_unavailable() {
        let resp = ResponseTemplate::new(200).set_body_string("<html>");
        assert_eq!(run(resp).await, Err(SourceError::Unavailable));
    }

    #[tokio::test]
    async fn timeout_is_unavailable() {
        let resp = user_error("VALID").set_delay(Duration::from_millis(1000));
        assert_eq!(run_with(resp, 200).await, Err(SourceError::Unavailable));
    }
}
