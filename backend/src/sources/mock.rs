//! Mock mode (spec 3.7.6, file formats 6.3). Reads `data/*-mock.json`; no network,
//! no cache. Answers are treated as if they came from the API.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{ChainabuseValue, SourceError};

/// `data/blockfrost-mock.json`
pub const BLOCKFROST_MOCK_FILE: &str = "blockfrost-mock.json";
/// `data/vies-mock.json`
pub const VIES_MOCK_FILE: &str = "vies-mock.json";
/// `data/chainabuse-mock.json`
pub const CHAINABUSE_MOCK_FILE: &str = "chainabuse-mock.json";

/// A mock file could not be read or does not match the 6.3 format.
#[derive(Debug, thiserror::Error)]
pub enum MockLoadError {
    #[error("cannot read mock file {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid mock file {file}: {msg}")]
    Invalid { file: String, msg: String },
}

fn invalid(file: &str, msg: impl ToString) -> MockLoadError {
    MockLoadError::Invalid {
        file: file.to_string(),
        msg: msg.to_string(),
    }
}

fn read(dir: &Path, file: &str) -> Result<String, MockLoadError> {
    let path = dir.join(file);
    std::fs::read_to_string(&path).map_err(|source| MockLoadError::Io { path, source })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ErrorOr<T> {
    Error { error: bool },
    Value(T),
}

fn resolve<T>(
    file: &str,
    key: &str,
    e: ErrorOr<T>,
) -> Result<Result<T, SourceError>, MockLoadError> {
    match e {
        ErrorOr::Error { error: true } => Ok(Err(SourceError::Unavailable)),
        ErrorOr::Error { error: false } => {
            Err(invalid(file, format!("{key}: \"error\" must be true")))
        }
        ErrorOr::Value(v) => Ok(Ok(v)),
    }
}

/// Blockfrost mock: `{"addresses": {"<addr>": {"first_tx_time": "<RFC 3339>"|null} | {"error": true}}}`.
#[derive(Debug, Clone, Default)]
pub struct BlockfrostMock {
    addresses: HashMap<String, Result<Option<i64>, SourceError>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BfFile {
    addresses: HashMap<String, ErrorOr<BfTx>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BfTx {
    first_tx_time: Option<String>,
}

impl BlockfrostMock {
    pub fn from_json(json: &str) -> Result<Self, MockLoadError> {
        let f = BLOCKFROST_MOCK_FILE;
        let file: BfFile = serde_json::from_str(json).map_err(|e| invalid(f, e))?;
        let mut addresses = HashMap::with_capacity(file.addresses.len());
        for (addr, entry) in file.addresses {
            let value = match resolve(f, &addr, entry)? {
                Err(e) => Err(e),
                Ok(BfTx {
                    first_tx_time: None,
                }) => Ok(None),
                Ok(BfTx {
                    first_tx_time: Some(ts),
                }) => {
                    let t = chrono::DateTime::parse_from_rfc3339(&ts)
                        .map_err(|e| invalid(f, format!("{addr}: first_tx_time: {e}")))?;
                    Ok(Some(t.timestamp()))
                }
            };
            addresses.insert(addr, value);
        }
        Ok(Self { addresses })
    }

    pub fn load(data_dir: &Path) -> Result<Self, MockLoadError> {
        Self::from_json(&read(data_dir, BLOCKFROST_MOCK_FILE)?)
    }

    /// Unknown address = no transaction.
    pub fn first_tx_time(&self, address: &str) -> Result<Option<i64>, SourceError> {
        self.addresses.get(address).copied().unwrap_or(Ok(None))
    }
}

/// VIES mock: `{"<vat normalized>": true | false | "error"}`.
#[derive(Debug, Clone, Default)]
pub struct ViesMock {
    vats: HashMap<String, Result<bool, SourceError>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ViesEntry {
    Bool(bool),
    Str(String),
}

impl ViesMock {
    pub fn from_json(json: &str) -> Result<Self, MockLoadError> {
        let f = VIES_MOCK_FILE;
        let file: HashMap<String, ViesEntry> =
            serde_json::from_str(json).map_err(|e| invalid(f, e))?;
        let mut vats = HashMap::with_capacity(file.len());
        for (vat, entry) in file {
            let value = match entry {
                ViesEntry::Bool(b) => Ok(b),
                ViesEntry::Str(s) if s == "error" => Err(SourceError::Unavailable),
                ViesEntry::Str(_) => {
                    return Err(invalid(
                        f,
                        format!("{vat}: expected true, false or \"error\""),
                    ))
                }
            };
            vats.insert(vat, value);
        }
        Ok(Self { vats })
    }

    pub fn load(data_dir: &Path) -> Result<Self, MockLoadError> {
        Self::from_json(&read(data_dir, VIES_MOCK_FILE)?)
    }

    /// Unknown VAT ID = invalid (`false`).
    pub fn valid(&self, vat_normalized: &str) -> Result<bool, SourceError> {
        self.vats.get(vat_normalized).copied().unwrap_or(Ok(false))
    }
}

/// Chainabuse mock: `{"<addr>": {"reports": <n>, "trusted_or_checked": <m>} | {"error": true}}`.
#[derive(Debug, Clone, Default)]
pub struct ChainabuseMock {
    addresses: HashMap<String, Result<ChainabuseValue, SourceError>>,
}

impl ChainabuseMock {
    pub fn from_json(json: &str) -> Result<Self, MockLoadError> {
        let f = CHAINABUSE_MOCK_FILE;
        let file: HashMap<String, ErrorOr<ChainabuseValue>> =
            serde_json::from_str(json).map_err(|e| invalid(f, e))?;
        let mut addresses = HashMap::with_capacity(file.len());
        for (addr, entry) in file {
            let value = resolve(f, &addr, entry)?;
            if let Ok(v) = &value {
                if v.trusted_or_checked > v.reports {
                    return Err(invalid(f, format!("{addr}: trusted_or_checked > reports")));
                }
            }
            addresses.insert(addr, value);
        }
        Ok(Self { addresses })
    }

    pub fn load(data_dir: &Path) -> Result<Self, MockLoadError> {
        Self::from_json(&read(data_dir, CHAINABUSE_MOCK_FILE)?)
    }

    /// Unknown address = 0 reports.
    pub fn reports(&self, address: &str) -> Result<ChainabuseValue, SourceError> {
        self.addresses
            .get(address)
            .copied()
            .unwrap_or(Ok(ChainabuseValue {
                reports: 0,
                trusted_or_checked: 0,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
    const M: &str = "addr_test1qqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxva24242424242424242424242424242424242424242424qdm5upe";

    fn data_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("data")
    }

    #[test]
    fn shipped_blockfrost_mock() {
        let m = BlockfrostMock::load(&data_dir()).unwrap();
        // Same instants as the 8.1 standard stubs.
        assert_eq!(m.first_tx_time(W1), Ok(Some(1_768_035_600)));
        assert_eq!(m.first_tx_time(W2), Ok(Some(1_793_102_400)));
        assert_eq!(m.first_tx_time(M), Ok(None), "unknown address = no tx");
    }

    #[test]
    fn shipped_vies_mock() {
        let m = ViesMock::load(&data_dir()).unwrap();
        for vat in ["DE111111111", "DE222222222", "DE333333333", "DE555555555"] {
            assert_eq!(m.valid(vat), Ok(true), "{vat}");
        }
        assert_eq!(m.valid("DE444444444"), Ok(false));
        assert_eq!(m.valid("DE999999999"), Ok(false), "unknown = false");
    }

    #[test]
    fn shipped_chainabuse_mock() {
        let m = ChainabuseMock::load(&data_dir()).unwrap();
        let zero = ChainabuseValue {
            reports: 0,
            trusted_or_checked: 0,
        };
        assert_eq!(m.reports(W1), Ok(zero));
        assert_eq!(m.reports(W2), Ok(zero));
    }

    #[test]
    fn blockfrost_null_error_and_offsets() {
        let m = BlockfrostMock::from_json(
            r#"{"addresses": {
                "a": {"first_tx_time": null},
                "b": {"error": true},
                "c": {"first_tx_time": "2026-01-10T10:00:00+01:00"}
            }}"#,
        )
        .unwrap();
        assert_eq!(m.first_tx_time("a"), Ok(None));
        assert_eq!(m.first_tx_time("b"), Err(SourceError::Unavailable));
        assert_eq!(m.first_tx_time("c"), Ok(Some(1_768_035_600)));
    }

    #[test]
    fn blockfrost_rejects_bad_files() {
        for bad in [
            r#"{"addresses": {"a": {"first_tx_time": "yesterday"}}}"#,
            r#"{"addresses": {"a": {"error": false}}}"#,
            r#"{"addresses": {"a": {"first_tx_time": 1768035600}}}"#,
            r#"{"a": {"first_tx_time": null}}"#,
            "[]",
        ] {
            assert!(BlockfrostMock::from_json(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn vies_error_and_bad_values() {
        let m = ViesMock::from_json(r#"{"DE1": true, "DE2": false, "DE3": "error"}"#).unwrap();
        assert_eq!(m.valid("DE1"), Ok(true));
        assert_eq!(m.valid("DE2"), Ok(false));
        assert_eq!(m.valid("DE3"), Err(SourceError::Unavailable));
        assert!(ViesMock::from_json(r#"{"DE1": "valid"}"#).is_err());
        assert!(ViesMock::from_json(r#"{"DE1": 1}"#).is_err());
    }

    #[test]
    fn chainabuse_values_and_error() {
        let m = ChainabuseMock::from_json(
            r#"{"a": {"reports": 3, "trusted_or_checked": 1}, "b": {"error": true}}"#,
        )
        .unwrap();
        assert_eq!(
            m.reports("a"),
            Ok(ChainabuseValue {
                reports: 3,
                trusted_or_checked: 1
            })
        );
        assert_eq!(m.reports("b"), Err(SourceError::Unavailable));
        assert!(
            ChainabuseMock::from_json(r#"{"a": {"reports": 1, "trusted_or_checked": 2}}"#).is_err()
        );
        assert!(ChainabuseMock::from_json(r#"{"a": {"reports": 1}}"#).is_err());
    }

    #[test]
    fn missing_file_is_io_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            ViesMock::load(dir.path()),
            Err(MockLoadError::Io { .. })
        ));
    }
}
