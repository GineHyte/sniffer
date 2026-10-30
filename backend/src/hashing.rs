//! HMAC hashes with type prefixes (spec 3.3).
//!
//! All inputs are already-normalized strings (3.3 normalization, 3.4 address).
//! `H(x) = "hmac:" + hex_lowercase(HMAC-SHA256(key, UTF-8(x)))`.

use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// Minimum key length in hex characters (FR-31: 32 bytes).
pub const MIN_KEY_HEX_LEN: usize = 64;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("HMAC key must be at least {MIN_KEY_HEX_LEN} hex characters, got {0}")]
    TooShort(usize),
    #[error("HMAC key is not valid hex")]
    InvalidHex,
}

/// Decoded `SNIFFER_HMAC_KEY`. `Debug` never prints the key bytes.
#[derive(Clone)]
pub struct HmacKey(Vec<u8>);

impl HmacKey {
    /// Parses a hex key with at least 64 hex characters (FR-31).
    pub fn from_hex(s: &str) -> Result<Self, KeyError> {
        if s.len() < MIN_KEY_HEX_LEN {
            return Err(KeyError::TooShort(s.len()));
        }
        hex::decode(s).map(Self).map_err(|_| KeyError::InvalidHex)
    }
}

impl fmt::Debug for HmacKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HmacKey(<redacted>)")
    }
}

/// Payment credential type of a Cardano address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialKind {
    Key,
    Script,
}

impl CredentialKind {
    fn as_str(self) -> &'static str {
        match self {
            CredentialKind::Key => "key",
            CredentialKind::Script => "script",
        }
    }
}

/// `"hmac:" + lowercase hex HMAC-SHA256(key, x)`.
pub fn h(key: &HmacKey, x: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&key.0).expect("HMAC accepts any key length");
    mac.update(x.as_bytes());
    format!("hmac:{}", hex::encode(mac.finalize().into_bytes()))
}

/// Lowercase hex SHA-256 (used for `config_sha256`, 4).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn address_hash(key: &HmacKey, address: &str) -> String {
    h(key, &format!("address:{address}"))
}

/// `credential_hex` is the 56-char lowercase payment credential.
pub fn wallet_hash(key: &HmacKey, kind: CredentialKind, credential_hex: &str) -> String {
    h(key, &format!("wallet:{}:{credential_hex}", kind.as_str()))
}

pub fn supplier_hash(key: &HmacKey, vat: &str) -> String {
    h(key, &format!("supplier:{vat}"))
}

pub fn name_hash(key: &HmacKey, name: &str) -> String {
    h(key, &format!("name:{name}"))
}

pub fn email_domain_hash(key: &HmacKey, domain: &str) -> String {
    h(key, &format!("email:{domain}"))
}

pub fn phone_hash(key: &HmacKey, phone: &str) -> String {
    h(key, &format!("phone:{phone}"))
}

pub fn postal_hash(key: &HmacKey, postal: &str) -> String {
    h(key, &format!("postal:{postal}"))
}

/// `amount` with exactly 2 decimals, `issue_date` as YYYY-MM-DD, `type_code` = BT-3.
pub fn invoice_hash(
    key: &HmacKey,
    vat: &str,
    invoice_no: &str,
    amount: &str,
    issue_date: &str,
    type_code: &str,
) -> String {
    h(
        key,
        &format!("invoice:{vat}|{invoice_no}|{amount}|{issue_date}|{type_code}"),
    )
}

/// Both inputs are full `hmac:`-prefixed values; supplier first.
pub fn pair_hash(key: &HmacKey, supplier_hash: &str, wallet_hash: &str) -> String {
    h(key, &format!("pair:{supplier_hash}|{wallet_hash}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const ADDR: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const WALLET: &str = "hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090";
    const SUPPLIER: &str = "hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060";

    fn key() -> HmacKey {
        HmacKey::from_hex(TEST_KEY).unwrap()
    }

    // Spec Test 34: HMAC test vectors from 3.3.
    #[test]
    fn vector_address_hash() {
        assert_eq!(
            address_hash(&key(), ADDR),
            "hmac:123a45eab166d61361f307bfed62f81b4d440ea78738ddeddb584827ff9ecddd"
        );
    }

    #[test]
    fn vector_wallet_hash() {
        let cred = "1".repeat(56);
        assert_eq!(wallet_hash(&key(), CredentialKind::Key, &cred), WALLET);
    }

    #[test]
    fn wallet_hash_script_differs_from_key() {
        let cred = "1".repeat(56);
        assert_eq!(
            wallet_hash(&key(), CredentialKind::Script, &cred),
            h(&key(), &format!("wallet:script:{cred}"))
        );
        assert_ne!(wallet_hash(&key(), CredentialKind::Script, &cred), WALLET);
    }

    #[test]
    fn vector_supplier_hash() {
        assert_eq!(supplier_hash(&key(), "DE111111111"), SUPPLIER);
    }

    #[test]
    fn vector_name_hash() {
        assert_eq!(
            name_hash(&key(), "alphaconsulting"),
            "hmac:ae9f9068ecda382921db60e08d7b63fddcb71b8cc6d7873b5f0144620728283e"
        );
    }

    #[test]
    fn vector_email_domain_hash() {
        assert_eq!(
            email_domain_hash(&key(), "alpha-consulting.example"),
            "hmac:e207dd8824dfc54c7f5e06c303bf8c75dcb27b34a79da1d36bf3a6d578ce2605"
        );
    }

    #[test]
    fn vector_phone_hash() {
        assert_eq!(
            phone_hash(&key(), "+49891234567"),
            "hmac:0ec970e7ac952f9036af04d68f06a3eba01c1ba5af84190f62c8bb8146e65faf"
        );
    }

    #[test]
    fn vector_postal_hash() {
        assert_eq!(
            postal_hash(&key(), "musterstr1|80333|munchen|de"),
            "hmac:047e5c67e89c1fb3fbc09c001dd7fb73cedb6bbf8475270bac86aedfb40ca4fc"
        );
    }

    #[test]
    fn vector_invoice_hash() {
        assert_eq!(
            invoice_hash(
                &key(),
                "DE111111111",
                "RE-2026-0412",
                "1190.00",
                "2026-10-28",
                "380"
            ),
            "hmac:9c51f2952f2525e6f1b99c6e045bb9798402e583495892b9cdf1225aaba45886"
        );
    }

    #[test]
    fn vector_pair_hash() {
        assert_eq!(
            pair_hash(&key(), SUPPLIER, WALLET),
            "hmac:d0323c2f6d8cb2ac79d4051e884ae7693c08022489b933ddd84695829ec9f7fb"
        );
    }

    #[test]
    fn raw_h_matches_prefixed_input() {
        assert_eq!(h(&key(), "supplier:DE111111111"), SUPPLIER);
    }

    #[test]
    fn sha256_hex_known_value() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn key_too_short_rejected() {
        assert_eq!(
            HmacKey::from_hex(&TEST_KEY[..62]).unwrap_err(),
            KeyError::TooShort(62)
        );
        assert_eq!(HmacKey::from_hex("").unwrap_err(), KeyError::TooShort(0));
    }

    #[test]
    fn key_odd_length_rejected() {
        let odd = format!("{TEST_KEY}a");
        assert_eq!(HmacKey::from_hex(&odd).unwrap_err(), KeyError::InvalidHex);
    }

    #[test]
    fn key_non_hex_rejected() {
        let bad = format!("{}zz", &TEST_KEY[..62]);
        assert_eq!(HmacKey::from_hex(&bad).unwrap_err(), KeyError::InvalidHex);
    }

    #[test]
    fn key_longer_than_minimum_accepted() {
        let long = format!("{TEST_KEY}{TEST_KEY}");
        assert!(HmacKey::from_hex(&long).is_ok());
    }

    #[test]
    fn key_debug_redacts_bytes() {
        let dbg = format!("{:?}", key());
        assert!(!dbg.contains("0001"), "{dbg}");
        assert!(!dbg.contains("[0, 1"), "{dbg}");
    }
}
