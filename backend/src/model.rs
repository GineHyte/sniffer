//! Result JSON structs (spec 4) and the request/response bodies of 5.2 and 5.4.
//!
//! Result structs never use `deny_unknown_fields` (spec 4, Erweiterbarkeit); nullable
//! fields are `Option` and serialize as `null`. Request bodies reject unknown fields
//! (FR-01, 5.1 `invalid_request`).

use std::str::FromStr;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use crate::config::{Agent, ReasonType};
use crate::mustang;

/// `schema_version` of the result JSON.
pub const SCHEMA_VERSION: &str = "1.0";
/// `invoice.validation.tool`.
pub const VALIDATION_TOOL: &str = "mustang";

/// `/v1/checks/<check_id>/xml` (`invoice.xml_ref`).
pub fn xml_ref(check_id: &str) -> String {
    format!("/v1/checks/{check_id}/xml")
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    Low,
    Medium,
    High,
}

impl Band {
    pub fn as_str(self) -> &'static str {
        match self {
            Band::Low => "low",
            Band::Medium => "medium",
            Band::High => "high",
        }
    }
}

/// `summary.decision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Review,
    Decline,
}

/// `final_decision` (`invoices` row, 5.2, 5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FinalDecision {
    Approved,
    Rejected,
}

impl FinalDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            FinalDecision::Approved => "approved",
            FinalDecision::Rejected => "rejected",
        }
    }
}

/// `decided_by` (`invoices` row).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    InitialCheck,
    Agents,
    Seed,
}

impl DecidedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            DecidedBy::InitialCheck => "initial_check",
            DecidedBy::Agents => "agents",
            DecidedBy::Seed => "seed",
        }
    }
}

/// `summary.checks_skipped[].source`, serialized in this order (3.8 step 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SkippedSource {
    Mustang,
    Blockfrost,
    Vies,
    Chainabuse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Ko,
    NotApplicable,
}

/// `invoice.validation.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    Valid,
    Invalid,
    Unavailable,
    Off,
}

impl From<mustang::ValidationStatus> for ValidationStatus {
    fn from(s: mustang::ValidationStatus) -> Self {
        match s {
            mustang::ValidationStatus::Valid => ValidationStatus::Valid,
            mustang::ValidationStatus::Invalid => ValidationStatus::Invalid,
            mustang::ValidationStatus::Unavailable => ValidationStatus::Unavailable,
            mustang::ValidationStatus::Off => ValidationStatus::Off,
        }
    }
}

/// `signature.status`. v1.0 emits `absent` and `present_unverified`; the other
/// values are reserved for the wallet signature (spec 11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    Absent,
    PresentUnverified,
    Valid,
    Invalid,
    ForeignKey,
}

// ---------------------------------------------------------------------------
// Result JSON (spec 4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckResult {
    pub schema_version: String,
    pub check_id: String,
    #[serde(with = "rfc3339_secs")]
    pub checked_at: DateTime<Utc>,
    pub engine: Engine,
    pub summary: Summary,
    pub invoice: Option<InvoiceOut>,
    pub supplier: Option<SupplierOut>,
    pub wallet: Option<WalletOut>,
    pub pair: Option<PairOut>,
    pub signature: Option<Signature>,
    pub criteria: Vec<CriterionOut>,
    pub reducers: Vec<ReducerOut>,
    pub agent_tasks: AgentTasks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Engine {
    pub version: String,
    pub config_sha256: String,
}

impl Engine {
    /// `engine.version` = package version from `Cargo.toml`.
    pub fn new(config_sha256: impl Into<String>) -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            config_sha256: config_sha256.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub band: Band,
    pub decision: Decision,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub reason_type: Option<ReasonType>,
    pub risk_score: i32,
    pub ko_triggered: bool,
    pub decline_reasons: Vec<DeclineReason>,
    pub checks_incomplete: Vec<String>,
    pub checks_skipped: Vec<SkippedCheck>,
}

/// `{id, text, evidence}` in `summary.decline_reasons` and stored decisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeclineReason {
    pub id: String,
    pub text: String,
    pub evidence: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedCheck {
    pub source: SkippedSource,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvoiceOut {
    pub invoice_hash: Option<String>,
    pub xml_ref: String,
    pub profile: Option<String>,
    pub validation: ValidationOut,
    pub invoice_number: Option<String>,
    pub type_code: Option<String>,
    pub issue_date: Option<NaiveDate>,
    pub due_date: Option<NaiveDate>,
    pub total: Option<Amount>,
    pub due_payable: Option<Amount>,
    pub payment: PaymentOut,
    pub order_reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationOut {
    pub tool: String,
    pub tool_version: Option<String>,
    pub status: ValidationStatus,
    pub errors: usize,
    pub error_rules: Vec<String>,
    pub whitelisted_rules: Vec<String>,
}

impl From<&mustang::Validation> for ValidationOut {
    fn from(v: &mustang::Validation) -> Self {
        Self {
            tool: VALIDATION_TOOL.to_string(),
            tool_version: v.tool_version.clone(),
            status: v.status.into(),
            errors: v.errors,
            error_rules: v.error_rules.clone(),
            whitelisted_rules: v.whitelisted_rules.clone(),
        }
    }
}

/// `{amount: "<2 decimals>", currency}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Amount {
    #[serde(with = "amount2")]
    pub amount: Decimal,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PaymentOut {
    pub means_code: Option<String>,
    pub network: Option<String>,
    pub asset: Option<String>,
    pub address_type: Option<String>,
    pub credential_type: Option<String>,
    pub address_hash: Option<String>,
    pub wallet_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupplierOut {
    pub supplier_hash: String,
    pub country: Option<String>,
    pub vat_country: String,
    pub vat_valid: Option<bool>,
    pub known: bool,
    pub approved: i32,
    #[serde(with = "trust3")]
    pub trust: Decimal,
    pub blocked: bool,
    pub first_invoice: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletOut {
    pub wallet_hash: String,
    pub known: bool,
    pub approved: i32,
    pub rejected_risk: i32,
    #[serde(with = "trust3")]
    pub trust: Decimal,
    pub blocked: bool,
    pub has_transactions: Option<bool>,
    #[serde(with = "opt_rfc3339_secs")]
    pub first_tx_at: Option<DateTime<Utc>>,
    pub age_days: Option<i64>,
    pub chainabuse: Option<ChainabuseOut>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainabuseOut {
    pub reports: u32,
    pub trusted_or_checked: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairOut {
    pub pair_hash: String,
    pub approved: i32,
    pub rejected_risk: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub status: SignatureStatus,
    pub scheme: Option<String>,
    pub key_hash: Option<String>,
    pub matches_known_key: Option<bool>,
}

impl Signature {
    /// v1.0 block: only `status` is set (spec 4, 11).
    pub fn unverified(present: bool) -> Self {
        Self {
            status: if present {
                SignatureStatus::PresentUnverified
            } else {
                SignatureStatus::Absent
            },
            scheme: None,
            key_hash: None,
            matches_known_key: None,
        }
    }
}

/// `criteria[]`; `id` is a free string (spec 4, Erweiterbarkeit).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CriterionOut {
    pub id: String,
    pub name: String,
    pub points: i32,
    pub evidence: String,
    pub agent: Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReducerOut {
    pub id: String,
    pub name: String,
    pub points: i32,
    pub evidence: String,
}

/// Always all three keys.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AgentTasks {
    pub invoice: Vec<AgentTask>,
    pub wallet: Vec<AgentTask>,
    pub research: Vec<AgentTask>,
}

impl AgentTasks {
    pub fn list_mut(&mut self, agent: Agent) -> &mut Vec<AgentTask> {
        match agent {
            Agent::Invoice => &mut self.invoice,
            Agent::Wallet => &mut self.wallet,
            Agent::Research => &mut self.research,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.invoice.is_empty() && self.wallet.is_empty() && self.research.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTask {
    pub source: String,
    pub task: String,
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/// `POST /v1/initial-check` body (FR-01).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitialCheckRequest {
    pub xml: String,
    #[serde(default)]
    pub checked_at: Option<String>,
}

impl InitialCheckRequest {
    /// FR-03: RFC 3339, converted to UTC and truncated to whole seconds.
    /// `Ok(None)` when absent, `Err(())` when not RFC 3339 (→ `invalid_request`).
    #[allow(clippy::result_unit_err)]
    pub fn checked_at_utc(&self) -> Result<Option<DateTime<Utc>>, ()> {
        self.checked_at
            .as_deref()
            .map(|s| parse_rfc3339_secs(s).ok_or(()))
            .transpose()
    }
}

/// `POST /v1/decisions` body (5.4). Field rules beyond types are checked by the handler.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    pub check_id: String,
    pub decision: FinalDecision,
    #[serde(default)]
    pub reason_type: Option<ReasonType>,
    #[serde(default)]
    pub block_wallet: bool,
    #[serde(default)]
    pub decline_reasons: Vec<DeclineReasonInput>,
}

/// `decline_reasons[]` entry of [`DecisionRequest`]; rejects unknown fields.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclineReasonInput {
    pub id: String,
    pub text: String,
    pub evidence: String,
}

impl From<DeclineReasonInput> for DeclineReason {
    fn from(r: DeclineReasonInput) -> Self {
        Self {
            id: r.id,
            text: r.text,
            evidence: r.evidence,
        }
    }
}

/// `POST /v1/decisions` response 200 (5.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionResponse {
    pub check_id: String,
    pub final_decision: FinalDecision,
    pub final_reason_type: Option<ReasonType>,
    pub decided_by: DecidedBy,
    #[serde(with = "rfc3339_secs")]
    pub decided_at: DateTime<Utc>,
}

/// `GET /v1/checks/{check_id}` response 200 (5.2). `result` is the stored JSON, unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckView {
    pub result: serde_json::Value,
    pub decision_state: Option<DecisionState>,
}

/// Decision columns of the `invoices` row; all `null` while a Medium case is open.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DecisionState {
    pub final_decision: Option<FinalDecision>,
    pub final_reason_type: Option<ReasonType>,
    pub final_block_wallet: Option<bool>,
    pub final_decline_reasons: Option<Vec<DeclineReason>>,
    pub decided_by: Option<DecidedBy>,
    #[serde(with = "opt_rfc3339_secs")]
    pub decided_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// Serde helpers
// ---------------------------------------------------------------------------

/// RFC 3339 → UTC, truncated to whole seconds.
pub fn parse_rfc3339_secs(s: &str) -> Option<DateTime<Utc>> {
    let t = DateTime::parse_from_rfc3339(s).ok()?.with_timezone(&Utc);
    DateTime::from_timestamp(t.timestamp(), 0)
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
pub fn format_rfc3339_secs(t: &DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

mod rfc3339_secs {
    use super::*;

    pub fn serialize<S: Serializer>(t: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_rfc3339_secs(t))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339_secs(&s).ok_or_else(|| serde::de::Error::custom("expected RFC 3339"))
    }
}

mod opt_rfc3339_secs {
    use super::*;

    pub fn serialize<S: Serializer>(t: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => s.serialize_str(&format_rfc3339_secs(t)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|s| {
                parse_rfc3339_secs(&s).ok_or_else(|| serde::de::Error::custom("expected RFC 3339"))
            })
            .transpose()
    }
}

/// Amount as a string with exactly two decimals.
mod amount2 {
    use super::*;

    pub fn serialize<S: Serializer>(d: &Decimal, s: S) -> Result<S::Ok, S::Error> {
        let mut r = d.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
        r.rescale(2);
        s.serialize_str(&r.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Decimal, D::Error> {
        let s = String::deserialize(d)?;
        Decimal::from_str_exact(&s).map_err(serde::de::Error::custom)
    }
}

/// Trust as a JSON number with at most three decimals (`0.545`, `0.0`, `-1.0`).
mod trust3 {
    use super::*;

    pub fn serialize<S: Serializer>(d: &Decimal, s: S) -> Result<S::Ok, S::Error> {
        let r = d.round_dp_with_strategy(3, RoundingStrategy::MidpointAwayFromZero);
        let f = r
            .to_f64()
            .ok_or_else(|| serde::ser::Error::custom("trust out of range"))?;
        s.serialize_f64(f)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Decimal, D::Error> {
        let f = f64::deserialize(d)?;
        if !f.is_finite() {
            return Err(serde::de::Error::custom("trust must be finite"));
        }
        // Shortest round-trip text of the f64, so 0.545 stays 0.545.
        Decimal::from_str(&f.to_string())
            .map(|d| d.round_dp_with_strategy(3, RoundingStrategy::MidpointAwayFromZero))
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const CHECK_ID: &str = "chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W";
    const INVOICE_HASH: &str =
        "hmac:4f1c9a0e7b2d58c3a6e91f04b7d2c85e3a90f6b1d4c7e28a5b03f96d1e4c7a20";
    const ADDRESS_HASH: &str =
        "hmac:9b7e2c41d08f6a35e1c94b70f2d83a6c5e19b04f7a2d6c83e5f01b94d7a2c6e1";
    const WALLET_HASH: &str =
        "hmac:2d6a9f13c8e04b75a1f39c62e8d05b47f3a1c96e0d84b27a5c3f19e60b8d4a73";
    const SUPPLIER_HASH: &str =
        "hmac:c3e85a1f60d27b94e4a03c18f7b62d95a0e4c71b38f5d26e9a14c07b5f3e82d6";
    const PAIR_HASH: &str = "hmac:7a04d1e95c3b28f6a9e17d40c5b3f82e6d19a07c4b5e3f28d60a91c7e4b2f5d8";
    const CONFIG_SHA: &str = "5b2f8e4a1c97d03e6a84f1b52c9e07d3a6f48b1e2c95d07a3f6e81b4c2d97a05";

    /// Spec 4 example (acceptance test 9) with full-length hashes.
    fn example() -> Value {
        json!({
          "schema_version": "1.0",
          "check_id": CHECK_ID,
          "checked_at": "2026-10-30T12:00:00Z",
          "engine": { "version": "1.0.0", "config_sha256": CONFIG_SHA },
          "summary": {
            "band": "medium",
            "decision": "review",
            "final": false,
            "reason_type": null,
            "risk_score": 58,
            "ko_triggered": false,
            "decline_reasons": [],
            "checks_incomplete": [],
            "checks_skipped": []
          },
          "invoice": {
            "invoice_hash": INVOICE_HASH,
            "xml_ref": "/v1/checks/chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W/xml",
            "profile": "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
            "validation": { "tool": "mustang", "tool_version": "2.26.0", "status": "valid", "errors": 0, "error_rules": [], "whitelisted_rules": [] },
            "invoice_number": "RE-2026-0412",
            "type_code": "380",
            "issue_date": "2026-10-28",
            "due_date": "2026-10-30",
            "total": { "amount": "833.00", "currency": "EUR" },
            "due_payable": { "amount": "833.00", "currency": "EUR" },
            "payment": {
              "means_code": "ZZZ",
              "network": "preprod",
              "asset": "ADA",
              "address_type": "base",
              "credential_type": "key",
              "address_hash": ADDRESS_HASH,
              "wallet_hash": WALLET_HASH
            },
            "order_reference": "PO-2026-001"
          },
          "supplier": {
            "supplier_hash": SUPPLIER_HASH,
            "country": "DE",
            "vat_country": "DE",
            "vat_valid": true,
            "known": true,
            "approved": 6,
            "trust": 0.545,
            "blocked": false,
            "first_invoice": false
          },
          "wallet": {
            "wallet_hash": WALLET_HASH,
            "known": false,
            "approved": 0,
            "rejected_risk": 0,
            "trust": 0.0,
            "blocked": false,
            "has_transactions": true,
            "first_tx_at": "2026-10-27T12:00:00Z",
            "age_days": 3,
            "chainabuse": { "reports": 0, "trusted_or_checked": 0 }
          },
          "pair": { "pair_hash": PAIR_HASH, "approved": 0, "rejected_risk": 0 },
          "signature": { "status": "absent", "scheme": null, "key_hash": null, "matches_known_key": null },
          "criteria": [
            { "id": "S-3", "name": "Known supplier, new wallet", "points": 25, "evidence": "supplier approved 6x, never with this wallet", "agent": "wallet" },
            { "id": "W-2", "name": "Young address", "points": 15, "evidence": "first transaction 2026-10-27, 3 days before check", "agent": "wallet" },
            { "id": "I-5", "name": "Pressure wording", "points": 10, "evidence": "pressure wording: dringend, neue wallet", "agent": "invoice" },
            { "id": "I-7", "name": "Due date < 3 days", "points": 8, "evidence": "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)", "agent": "invoice" }
          ],
          "reducers": [],
          "agent_tasks": {
            "invoice": [
              { "source": "I-5", "task": "Prüfe, warum die Rechnung zu schneller Zahlung drängt." },
              { "source": "I-7", "task": "Prüfe, ob ein Zahlungsziel unter 3 Tagen mit dem Rechnungssteller vereinbart ist." }
            ],
            "wallet": [
              { "source": "S-3", "task": "Prüfe, ob der Rechnungssteller die neue Zahlungsadresse über einen unabhängigen, bereits bekannten Kanal bestätigt hat." },
              { "source": "W-2", "task": "Prüfe, warum eine sehr neue Zahlungsadresse verwendet wird." }
            ],
            "research": []
          }
        })
    }

    #[test]
    fn spec4_example_round_trips() {
        let v = example();
        let r: CheckResult = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.schema_version, SCHEMA_VERSION);
        assert_eq!(r.engine.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(r.invoice.as_ref().unwrap().xml_ref, xml_ref(CHECK_ID));
        assert_eq!(r.supplier.as_ref().unwrap().trust, Decimal::new(545, 3));
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
        // Text form keeps the number shapes of the example.
        let text = serde_json::to_string(&r).unwrap();
        assert!(text.contains(r#""trust":0.545"#), "{text}");
        assert!(text.contains(r#""trust":0.0"#), "{text}");
        assert!(text.contains(r#""amount":"833.00""#), "{text}");
    }

    #[test]
    fn nulls_are_serialized_not_skipped() {
        let mut v = example();
        for k in ["invoice", "supplier", "wallet", "pair", "signature"] {
            v[k] = Value::Null;
        }
        v["summary"]["band"] = "high".into();
        v["summary"]["decision"] = "decline".into();
        v["summary"]["final"] = true.into();
        v["summary"]["reason_type"] = "formal".into();
        v["summary"]["checks_skipped"] = json!([
            { "source": "MUSTANG", "reason": "ko" },
            { "source": "VIES", "reason": "not_applicable" }
        ]);
        v["agent_tasks"] = json!({ "invoice": [], "wallet": [], "research": [] });
        let r: CheckResult = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), v);
    }

    #[test]
    fn result_ignores_unknown_fields() {
        let mut v = example();
        v["future_field"] = json!({ "x": 1 });
        v["summary"]["extra"] = 1.into();
        let r: CheckResult = serde_json::from_value(v).unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), example());
    }

    #[test]
    fn trust_and_amount_formats() {
        let t = |d: Decimal| {
            let w = PairOrTrust { trust: d };
            serde_json::to_string(&w).unwrap()
        };
        #[derive(Serialize)]
        struct PairOrTrust {
            #[serde(with = "trust3")]
            trust: Decimal,
        }
        assert_eq!(t(Decimal::ZERO), r#"{"trust":0.0}"#);
        assert_eq!(t(Decimal::new(545, 3)), r#"{"trust":0.545}"#);
        assert_eq!(t(Decimal::new(-500, 3)), r#"{"trust":-0.5}"#);
        assert_eq!(t(Decimal::new(-1, 0)), r#"{"trust":-1.0}"#);
        assert_eq!(t(Decimal::new(1, 0)), r#"{"trust":1.0}"#);
        assert_eq!(t(Decimal::new(250, 3)), r#"{"trust":0.25}"#);

        let a = |d: Decimal| {
            serde_json::to_value(Amount {
                amount: d,
                currency: "EUR".into(),
            })
            .unwrap()["amount"]
                .clone()
        };
        assert_eq!(a(Decimal::new(833, 0)), "833.00");
        assert_eq!(a(Decimal::new(11900, 1)), "1190.00");
        assert_eq!(a(Decimal::new(168067, 2)), "1680.67");
    }

    #[test]
    fn checked_at_rules() {
        let req = |v: Value| serde_json::from_value::<InitialCheckRequest>(v);
        let r = req(json!({ "xml": "<x/>" })).unwrap();
        assert_eq!(r.checked_at_utc(), Ok(None));
        let r =
            req(json!({ "xml": "<x/>", "checked_at": "2026-10-30T14:00:00.987+02:00" })).unwrap();
        assert_eq!(
            r.checked_at_utc().unwrap().map(|t| format_rfc3339_secs(&t)),
            Some("2026-10-30T12:00:00Z".to_string())
        );
        let r = req(json!({ "xml": "<x/>", "checked_at": "30.10.2026" })).unwrap();
        assert_eq!(r.checked_at_utc(), Err(()));
        // FR-01: unknown fields and wrong types are rejected.
        assert!(req(json!({ "xml": "<x/>", "extra": 1 })).is_err());
        assert!(req(json!({ "xml": 1 })).is_err());
        assert!(req(json!({})).is_err());
    }

    #[test]
    fn decision_request_parsing() {
        let v = json!({
          "check_id": "chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W",
          "decision": "rejected",
          "reason_type": "risk",
          "block_wallet": true,
          "decline_reasons": [ { "id": "S-3", "text": "Die Zahlungsadresse weicht von allen bisherigen Rechnungen dieses Rechnungsstellers ab.", "evidence": "supplier approved 6x, never with this wallet" } ]
        });
        let r: DecisionRequest = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(r.decision, FinalDecision::Rejected);
        assert_eq!(r.reason_type, Some(ReasonType::Risk));
        assert!(r.block_wallet);
        assert_eq!(r.decline_reasons.len(), 1);

        let r: DecisionRequest = serde_json::from_value(
            json!({ "check_id": CHECK_ID, "decision": "approved", "reason_type": null }),
        )
        .unwrap();
        assert_eq!(r.reason_type, None);
        assert!(!r.block_wallet);
        assert!(r.decline_reasons.is_empty());

        let mut extra = v.clone();
        extra["comment"] = "x".into();
        assert!(serde_json::from_value::<DecisionRequest>(extra).is_err());
        let mut extra = v.clone();
        extra["decline_reasons"][0]["extra"] = "x".into();
        assert!(serde_json::from_value::<DecisionRequest>(extra).is_err());
        let mut bad = v;
        bad["decision"] = "maybe".into();
        assert!(serde_json::from_value::<DecisionRequest>(bad).is_err());
    }

    #[test]
    fn check_view_and_decision_response_shapes() {
        let state = json!({ "final_decision": "approved", "final_reason_type": null, "final_block_wallet": false,
                            "final_decline_reasons": null, "decided_by": "agents", "decided_at": "2026-10-30T12:05:00Z" });
        let view = json!({ "result": example(), "decision_state": state });
        let v: CheckView = serde_json::from_value(view.clone()).unwrap();
        assert_eq!(
            v.decision_state.as_ref().unwrap().decided_by,
            Some(DecidedBy::Agents)
        );
        assert_eq!(serde_json::to_value(&v).unwrap(), view);

        let open = CheckView {
            result: example(),
            decision_state: Some(DecisionState::default()),
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap()["decision_state"],
            json!({ "final_decision": null, "final_reason_type": null, "final_block_wallet": null,
                    "final_decline_reasons": null, "decided_by": null, "decided_at": null })
        );
        let none = CheckView {
            result: example(),
            decision_state: None,
        };
        assert_eq!(
            serde_json::to_value(&none).unwrap()["decision_state"],
            Value::Null
        );

        let resp = json!({ "check_id": CHECK_ID, "final_decision": "rejected", "final_reason_type": "risk",
                           "decided_by": "agents", "decided_at": "2026-10-30T12:05:00Z" });
        let r: DecisionResponse = serde_json::from_value(resp.clone()).unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), resp);
    }

    #[test]
    fn validation_from_mustang() {
        let m = mustang::Validation {
            status: mustang::ValidationStatus::Invalid,
            tool_version: Some("2.26.0".into()),
            errors: 1,
            error_rules: vec!["BR-DE-15".into()],
            whitelisted_rules: vec![],
        };
        let v = ValidationOut::from(&m);
        assert_eq!(
            serde_json::to_value(&v).unwrap(),
            json!({ "tool": "mustang", "tool_version": "2.26.0", "status": "invalid", "errors": 1,
                    "error_rules": ["BR-DE-15"], "whitelisted_rules": [] })
        );
    }

    #[test]
    fn signature_v1_block() {
        assert_eq!(
            serde_json::to_value(Signature::unverified(true)).unwrap(),
            json!({ "status": "present_unverified", "scheme": null, "key_hash": null, "matches_known_key": null })
        );
        assert_eq!(Signature::unverified(false).status, SignatureStatus::Absent);
    }
}
