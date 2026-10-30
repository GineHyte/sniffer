//! Cardano payment address check and wallet identity (spec 3.4).
//!
//! The payment credential is the wallet identity, never the stake part: anyone can
//! combine their own payment part with a trusted wallet's stake part ("mangled
//! address", seed address M). Funds sent there are spendable only by the owner of the
//! payment part, so trust, history and blocklists key on the payment credential.
//!
//! Nothing in this module logs or echoes the address; errors carry only a code.

use std::fmt;

use pallas_addresses::{Address, Network as ChainNetwork, ShelleyAddress};
use serde::Serialize;

/// Network the deployment expects (`EXPECTED_NETWORK`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Preprod,
    Mainnet,
}

impl Network {
    fn matches(self, chain: ChainNetwork) -> bool {
        matches!(
            (self, chain),
            (Network::Preprod, ChainNetwork::Testnet) | (Network::Mainnet, ChainNetwork::Mainnet)
        )
    }
}

/// KO-2 failure codes (spec 3.4), in check order. Carries no input data by design.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressError {
    MixedCase,
    Bech32Invalid,
    NotPaymentAddress,
    PointerAddress,
    NetworkMismatch,
    NonCanonical,
}

impl AddressError {
    pub fn code(&self) -> &'static str {
        match self {
            AddressError::MixedCase => "MIXED_CASE",
            AddressError::Bech32Invalid => "BECH32_INVALID",
            AddressError::NotPaymentAddress => "NOT_PAYMENT_ADDRESS",
            AddressError::PointerAddress => "POINTER_ADDRESS",
            AddressError::NetworkMismatch => "NETWORK_MISMATCH",
            AddressError::NonCanonical => "NON_CANONICAL",
        }
    }
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for AddressError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressType {
    /// Shelley types 0–3.
    Base,
    /// Shelley types 6–7.
    Enterprise,
    /// Shelley types 4–5. Only `check_without_network` returns it; `check` rejects
    /// pointers with `POINTER_ADDRESS` (step 4).
    Pointer,
}

impl AddressType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AddressType::Base => "base",
            AddressType::Enterprise => "enterprise",
            AddressType::Pointer => "pointer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialType {
    Key,
    Script,
}

impl CredentialType {
    /// Value used in `wallet_hash` input (`"wallet:" + key|script + ":" + hex`, spec 3.3).
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialType::Key => "key",
            CredentialType::Script => "script",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CheckedAddress {
    /// Address after step 1 (trimmed, lowercased); input of `address_hash`.
    pub address: String,
    pub address_type: AddressType,
    pub credential_type: CredentialType,
    /// Payment credential, 56 lowercase hex chars; with `credential_type` the wallet identity.
    pub credential_hex: String,
}

/// Redacts the address so an accidental `{:?}` never leaks it into logs.
impl fmt::Debug for CheckedAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CheckedAddress")
            .field("address", &"<redacted>")
            .field("address_type", &self.address_type)
            .field("credential_type", &self.credential_type)
            .field("credential_hex", &"<redacted>")
            .finish()
    }
}

/// Full KO-2 check of BT-84, spec 3.4 steps 1–7 in order; first failure wins.
pub fn check(raw: &str, expected: Network) -> Result<CheckedAddress, AddressError> {
    let (a, shelley) = decode_payment_address(raw)?;
    // Step 4: pointer addresses (types 4, 5).
    if matches!(shelley.typeid(), 4 | 5) {
        return Err(AddressError::PointerAddress);
    }
    // Step 5.
    if !expected.matches(shelley.network()) {
        return Err(AddressError::NetworkMismatch);
    }
    // Step 6: re-encoding must reproduce the input exactly.
    if shelley.to_bech32().ok().as_deref() != Some(a.as_str()) {
        return Err(AddressError::NonCanonical);
    }
    Ok(identity(a, &shelley))
}

/// Spec 3.4 steps 1–3 only (OFAC import 3.7.5, `blocklist-add` 7.1): no pointer,
/// network or canonical-form check, but the payment credential is still derived.
pub fn check_without_network(raw: &str) -> Result<CheckedAddress, AddressError> {
    let (a, shelley) = decode_payment_address(raw)?;
    Ok(identity(a, &shelley))
}

/// Steps 1–3.
fn decode_payment_address(raw: &str) -> Result<(String, ShelleyAddress), AddressError> {
    // Step 1: trim (same whitespace set as 3.1), reject mixed case, lowercase.
    let a = raw.trim_matches([' ', '\t', '\r', '\n']);
    if a.chars().any(char::is_uppercase) && a.chars().any(char::is_lowercase) {
        return Err(AddressError::MixedCase);
    }
    let a = a.to_lowercase();
    // Step 2.
    let decoded = Address::from_bech32(&a).map_err(|_| AddressError::Bech32Invalid)?;
    // Step 3.
    match decoded {
        Address::Shelley(shelley) => Ok((a, shelley)),
        Address::Byron(_) | Address::Stake(_) => Err(AddressError::NotPaymentAddress),
    }
}

/// Step 7.
fn identity(address: String, shelley: &ShelleyAddress) -> CheckedAddress {
    let address_type = match shelley.typeid() {
        0..=3 => AddressType::Base,
        4 | 5 => AddressType::Pointer,
        _ => AddressType::Enterprise,
    };
    let payment = shelley.payment();
    let credential_type = if payment.is_script() {
        CredentialType::Script
    } else {
        CredentialType::Key
    };
    CheckedAddress {
        address,
        address_type,
        credential_type,
        credential_hex: payment.to_hex(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pallas_addresses::{
        Address, ByronAddress, Network as ChainNetwork, Pointer, ShelleyAddress,
        ShelleyDelegationPart, ShelleyPaymentPart, StakeAddress,
    };

    const W1: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c";
    const W2: &str = "addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt";
    const W3: &str = "addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9";
    const W4: &str = "addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww";
    const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";
    const M: &str = "addr_test1qqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxva24242424242424242424242424242424242424242424qdm5upe";
    const W1_MAIN: &str = "addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qc5hee8";
    const W1_BAD: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q";
    /// Byron test vector from pallas-addresses 1.4.0 (`byron.rs` tests).
    const BYRON_B58: &str = "Ae2tdPwUPEZLs4HtbuNey7tK4hTKrwNwYtGqp7bDfCy2WdR3P6735W5Yfpe";

    fn rep(byte: &str) -> String {
        byte.repeat(28)
    }

    fn hash28(byte: u8) -> pallas_addresses::PaymentKeyHash {
        pallas_addresses::PaymentKeyHash::new([byte; 28])
    }

    fn shelley(raw: &str) -> ShelleyAddress {
        match Address::from_bech32(raw).expect("valid bech32") {
            Address::Shelley(s) => s,
            other => panic!("expected Shelley, got {other:?}"),
        }
    }

    // Test-only BIP-173 encoder, so we can wrap arbitrary bytes (Byron CBOR,
    // mismatched HRPs, trailing bytes) that pallas never emits itself.
    fn bech32_encode(hrp: &str, data: &[u8]) -> String {
        const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        fn polymod(values: &[u8]) -> u32 {
            const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
            let mut chk: u32 = 1;
            for v in values {
                let top = chk >> 25;
                chk = ((chk & 0x01ff_ffff) << 5) ^ u32::from(*v);
                for (i, g) in GEN.iter().enumerate() {
                    if (top >> i) & 1 == 1 {
                        chk ^= g;
                    }
                }
            }
            chk
        }
        let mut five = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for b in data {
            acc = (acc << 8) | u32::from(*b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                five.push(((acc >> bits) & 31) as u8);
            }
        }
        if bits > 0 {
            five.push(((acc << (5 - bits)) & 31) as u8);
        }
        let mut values: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
        values.push(0);
        values.extend(hrp.bytes().map(|c| c & 31));
        values.extend(&five);
        values.extend([0u8; 6]);
        let pm = polymod(&values) ^ 1;
        let mut out = format!("{hrp}1");
        for d in &five {
            out.push(CHARSET[*d as usize] as char);
        }
        for i in 0..6 {
            out.push(CHARSET[((pm >> (5 * (5 - i))) & 31) as usize] as char);
        }
        out
    }

    #[test]
    fn test_encoder_reproduces_seed_address() {
        assert_eq!(bech32_encode("addr_test", &shelley(W1).to_vec()), W1);
        assert_eq!(bech32_encode("addr", &shelley(W1_MAIN).to_vec()), W1_MAIN);
    }

    /// Acceptance Test 37: seed addresses from 7.5 decode as tabulated.
    #[test]
    fn seed_addresses_decode_as_specified() {
        let cases = [
            (W1, AddressType::Base, "11", Some("aa")),
            (W2, AddressType::Base, "22", Some("aa")),
            (W3, AddressType::Enterprise, "33", None),
            (W4, AddressType::Enterprise, "44", None),
            (W5, AddressType::Enterprise, "55", None),
            (M, AddressType::Base, "33", Some("aa")),
        ];
        for (addr, ty, cred, stake) in cases {
            let c = check(addr, Network::Preprod).unwrap_or_else(|e| panic!("{}", e.code()));
            assert_eq!(c.address, addr);
            assert_eq!(c.address_type, ty);
            assert_eq!(c.credential_type, CredentialType::Key);
            assert_eq!(c.credential_hex, rep(cred));
            assert_eq!(c.credential_hex.len(), 56);

            let s = shelley(addr);
            assert_eq!(s.network(), ChainNetwork::Testnet);
            match stake {
                Some(b) => assert_eq!(s.delegation().to_hex(), rep(b)),
                None => assert_eq!(s.delegation(), &ShelleyDelegationPart::Null),
            }
        }

        let main = check(W1_MAIN, Network::Mainnet).expect("W1-main on mainnet");
        assert_eq!(main.address_type, AddressType::Base);
        assert_eq!(main.credential_type, CredentialType::Key);
        assert_eq!(main.credential_hex, rep("11"));
        assert_eq!(shelley(W1_MAIN).network(), ChainNetwork::Mainnet);
    }

    /// Test 16 premise: M shares W3's payment credential and W1's stake part,
    /// so identity must follow the payment credential (W3), never the stake (W1).
    #[test]
    fn mangled_address_identity_is_payment_credential() {
        let m = check(M, Network::Preprod).unwrap();
        let w3 = check(W3, Network::Preprod).unwrap();
        let w1 = check(W1, Network::Preprod).unwrap();
        assert_eq!(m.credential_hex, w3.credential_hex);
        assert_eq!(m.credential_type, w3.credential_type);
        assert_ne!(m.address, w3.address);
        assert_eq!(m.address_type, AddressType::Base);
        assert_eq!(w3.address_type, AddressType::Enterprise);
        assert_eq!(shelley(M).delegation(), shelley(W1).delegation());
        assert_ne!(m.credential_hex, w1.credential_hex);
    }

    #[test]
    fn error_codes_are_exact() {
        let codes = [
            (AddressError::MixedCase, "MIXED_CASE"),
            (AddressError::Bech32Invalid, "BECH32_INVALID"),
            (AddressError::NotPaymentAddress, "NOT_PAYMENT_ADDRESS"),
            (AddressError::PointerAddress, "POINTER_ADDRESS"),
            (AddressError::NetworkMismatch, "NETWORK_MISMATCH"),
            (AddressError::NonCanonical, "NON_CANONICAL"),
        ];
        for (err, code) in codes {
            assert_eq!(err.code(), code);
            assert_eq!(err.to_string(), code);
        }
    }

    /// Acceptance Test 4 (address part).
    #[test]
    fn network_mismatch() {
        assert_eq!(
            check(W1_MAIN, Network::Preprod),
            Err(AddressError::NetworkMismatch)
        );
        assert_eq!(
            check(W1, Network::Mainnet),
            Err(AddressError::NetworkMismatch)
        );
        // Network id other than 0/1.
        let other = ShelleyAddress::new(
            ChainNetwork::Other(2),
            ShelleyPaymentPart::key_hash(hash28(0x11)),
            ShelleyDelegationPart::Null,
        );
        let raw = bech32_encode("addr", &other.to_vec());
        assert_eq!(
            check(&raw, Network::Mainnet),
            Err(AddressError::NetworkMismatch)
        );
        assert_eq!(
            check(&raw, Network::Preprod),
            Err(AddressError::NetworkMismatch)
        );
    }

    /// Acceptance Test 5 (address part).
    #[test]
    fn bad_checksum_is_bech32_invalid() {
        assert_eq!(
            check(W1_BAD, Network::Preprod),
            Err(AddressError::Bech32Invalid)
        );
        assert_eq!(
            check_without_network(W1_BAD),
            Err(AddressError::Bech32Invalid)
        );
        assert_eq!(
            check("", Network::Preprod),
            Err(AddressError::Bech32Invalid)
        );
        assert_eq!(
            check("not an address", Network::Preprod),
            Err(AddressError::Bech32Invalid)
        );
    }

    #[test]
    fn mixed_case_rejected_before_decoding() {
        let mixed = format!("A{}", &W1[1..]);
        assert_eq!(
            check(&mixed, Network::Preprod),
            Err(AddressError::MixedCase)
        );
        assert_eq!(check_without_network(&mixed), Err(AddressError::MixedCase));
        // Step 1 precedes step 2: mixed case wins over a bad checksum.
        let mixed_bad = format!("A{}", &W1_BAD[1..]);
        assert_eq!(
            check(&mixed_bad, Network::Preprod),
            Err(AddressError::MixedCase)
        );
    }

    #[test]
    fn uppercase_only_is_lowercased_and_canonical() {
        let c = check(&W1.to_uppercase(), Network::Preprod).expect("uppercase accepted");
        assert_eq!(c.address, W1);
        assert_eq!(c.credential_hex, rep("11"));
        assert_eq!(shelley(W1).to_bech32().unwrap(), c.address);
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        let c = check(&format!(" \t{W1}\r\n"), Network::Preprod).unwrap();
        assert_eq!(c.address, W1);
    }

    #[test]
    fn stake_address_is_not_payment_address() {
        let stake = StakeAddress::try_from(shelley(W1))
            .unwrap()
            .to_bech32()
            .unwrap();
        assert!(stake.starts_with("stake_test1"));
        assert!(matches!(
            Address::from_bech32(&stake),
            Ok(Address::Stake(_))
        ));
        assert_eq!(
            check(&stake, Network::Preprod),
            Err(AddressError::NotPaymentAddress)
        );
        // Step 3 precedes step 5.
        assert_eq!(
            check(&stake, Network::Mainnet),
            Err(AddressError::NotPaymentAddress)
        );
        assert_eq!(
            check_without_network(&stake),
            Err(AddressError::NotPaymentAddress)
        );
    }

    #[test]
    fn byron_address_is_not_payment_address() {
        let bytes = ByronAddress::from_base58(BYRON_B58).unwrap().to_vec();
        let raw = bech32_encode("addr", &bytes);
        assert!(matches!(Address::from_bech32(&raw), Ok(Address::Byron(_))));
        assert_eq!(
            check(&raw, Network::Mainnet),
            Err(AddressError::NotPaymentAddress)
        );
        assert_eq!(
            check_without_network(&raw),
            Err(AddressError::NotPaymentAddress)
        );
    }

    #[test]
    fn pointer_address_rejected_by_full_check() {
        let ptr = ShelleyAddress::new(
            ChainNetwork::Testnet,
            ShelleyPaymentPart::key_hash(hash28(0x11)),
            ShelleyDelegationPart::Pointer(Pointer::new(2498243, 27, 3)),
        );
        assert_eq!(ptr.typeid(), 4);
        let raw = ptr.to_bech32().unwrap();
        assert_eq!(
            check(&raw, Network::Preprod),
            Err(AddressError::PointerAddress)
        );
        // Step 4 precedes step 5.
        assert_eq!(
            check(&raw, Network::Mainnet),
            Err(AddressError::PointerAddress)
        );

        // Steps 1-3 only: a pointer address is still a Shelley payment address and
        // yields its payment credential (OFAC import, blocklist-add).
        let c = check_without_network(&raw).unwrap();
        assert_eq!(c.address_type, AddressType::Pointer);
        assert_eq!(c.credential_hex, rep("11"));
    }

    #[test]
    fn non_canonical_encodings_rejected() {
        // Testnet bytes under the mainnet HRP (and vice versa).
        let hrp_swap = bech32_encode("addr", &shelley(W1).to_vec());
        assert_eq!(
            check(&hrp_swap, Network::Preprod),
            Err(AddressError::NonCanonical)
        );
        let hrp_swap_main = bech32_encode("addr_test", &shelley(W1_MAIN).to_vec());
        assert_eq!(
            check(&hrp_swap_main, Network::Mainnet),
            Err(AddressError::NonCanonical)
        );

        // Trailing bytes that pallas silently drops.
        let mut long = shelley(W3).to_vec();
        long.push(0x00);
        let trailing = bech32_encode("addr_test", &long);
        assert_eq!(
            check(&trailing, Network::Preprod),
            Err(AddressError::NonCanonical)
        );

        // Steps 1-3 only: credential is still derived.
        let c = check_without_network(&hrp_swap).unwrap();
        assert_eq!(c.credential_hex, rep("11"));
    }

    #[test]
    fn script_credentials_detected() {
        let ent = ShelleyAddress::new(
            ChainNetwork::Testnet,
            ShelleyPaymentPart::script_hash(hash28(0x77)),
            ShelleyDelegationPart::Null,
        );
        let c = check(&ent.to_bech32().unwrap(), Network::Preprod).unwrap();
        assert_eq!(c.address_type, AddressType::Enterprise);
        assert_eq!(c.credential_type, CredentialType::Script);
        assert_eq!(c.credential_hex, rep("77"));

        let base = ShelleyAddress::new(
            ChainNetwork::Mainnet,
            ShelleyPaymentPart::script_hash(hash28(0x77)),
            ShelleyDelegationPart::script_hash(hash28(0xaa)),
        );
        assert_eq!(base.typeid(), 3);
        let c = check(&base.to_bech32().unwrap(), Network::Mainnet).unwrap();
        assert_eq!(c.address_type, AddressType::Base);
        assert_eq!(c.credential_type, CredentialType::Script);
    }

    #[test]
    fn check_without_network_skips_network_and_canonical_steps() {
        let c = check_without_network(W1_MAIN).unwrap();
        assert_eq!(c.address, W1_MAIN);
        assert_eq!(c.address_type, AddressType::Base);
        assert_eq!(c.credential_type, CredentialType::Key);
        assert_eq!(c.credential_hex, rep("11"));
        assert_eq!(check_without_network(W5).unwrap().credential_hex, rep("55"));
    }
}
