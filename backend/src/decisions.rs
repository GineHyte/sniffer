//! Agent-stage decisions (spec 5.4). Owner: Task 17.
//!
//! [`decide`] validates the request against the field table of 5.4, then runs steps
//! 1–6 in one transaction that holds `SELECT … FOR UPDATE` on the `invoices` row.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use crate::model::{
    DecidedBy, DecisionRequest, DecisionResponse, DeclineReason, FinalDecision, ReasonType,
};
use crate::store::postgres::{
    approve_subject, block_subject, reject_risk_subject, BlockSource, SubjectType,
};

/// `block_reason` of a wallet blocked by an agent decision (5.4 step 6).
pub const AGENT_BLOCK_REASON: &str = "AGENT_DECISION";
/// Maximum number of `decline_reasons` entries for `rejected`.
pub const MAX_DECLINE_REASONS: usize = 10;
/// Maximum length of `text` and `evidence` in characters.
pub const MAX_REASON_CHARS: usize = 500;
/// Words that must not appear in a decline reason text (5.1 `forbidden_wording`).
const FORBIDDEN_WORDS: [&str; 2] = ["betrug", "fraud"];

#[derive(Debug, thiserror::Error)]
pub enum DecisionError {
    #[error("invalid_request: {0}")]
    Invalid(String),
    #[error("forbidden_wording")]
    ForbiddenWording,
    #[error("not_found")]
    NotFound,
    #[error("not_pending")]
    NotPending,
    #[error("already_decided")]
    AlreadyDecided,
    #[error("dependency_unavailable")]
    Db(#[from] sqlx::Error),
}

const SELECT_FOR_UPDATE_SQL: &str = "\
SELECT initial_band, supplier_hash, wallet_hash, pair_hash,
       final_decision, final_reason_type, final_block_wallet, final_decline_reasons,
       decided_by, decided_at
FROM invoices
WHERE check_id = $1
FOR UPDATE";

const UPDATE_DECISION_SQL: &str = "\
UPDATE invoices SET
  final_decision        = $2,
  final_reason_type     = $3,
  final_block_wallet    = $4,
  final_decline_reasons = $5,
  decided_by            = 'agents',
  decided_at            = now()
WHERE check_id = $1
RETURNING decided_at";

/// Validates and applies one decision in a single transaction (5.4 steps 1-6).
pub async fn decide(
    pool: &PgPool,
    req: &DecisionRequest,
) -> Result<DecisionResponse, DecisionError> {
    validate(req)?;

    let mut tx = pool.begin().await?;

    // Step 1: the invoices row, locked for the rest of the transaction.
    let row = sqlx::query(SELECT_FOR_UPDATE_SQL)
        .bind(&req.check_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(DecisionError::NotFound)?;

    // Step 2: only Medium cases are open for agents.
    let band: String = row.try_get("initial_band")?;
    if band != "medium" {
        return Err(DecisionError::NotPending);
    }

    // Step 3: an existing decision is either repeated exactly (idempotent) or a conflict.
    let stored_decision: Option<String> = row.try_get("final_decision")?;
    if let Some(stored_decision) = stored_decision {
        let stored = StoredDecision {
            decision: stored_decision,
            reason_type: row.try_get("final_reason_type")?,
            block_wallet: row.try_get("final_block_wallet")?,
            decline_reasons: row.try_get("final_decline_reasons")?,
        };
        if !stored.matches(req) {
            return Err(DecisionError::AlreadyDecided);
        }
        let decided_by: Option<String> = row.try_get("decided_by")?;
        let decided_at: Option<DateTime<Utc>> = row.try_get("decided_at")?;
        let response = DecisionResponse {
            check_id: req.check_id.clone(),
            final_decision: req.decision,
            final_reason_type: req.reason_type,
            decided_by: parse_decided_by(decided_by.as_deref())?,
            decided_at: truncate_secs(decided_at.ok_or_else(|| missing("decided_at"))?),
        };
        tx.commit().await?;
        return Ok(response);
    }

    // Step 4: store the decision.
    let decline_reasons = decline_reasons_json(req);
    let decided_at: DateTime<Utc> = sqlx::query_scalar(UPDATE_DECISION_SQL)
        .bind(&req.check_id)
        .bind(req.decision.as_str())
        .bind(req.reason_type.map(ReasonType::as_str))
        .bind(req.block_wallet)
        .bind(&decline_reasons)
        .fetch_one(&mut *tx)
        .await?;

    // Step 5: counters.
    let wallet_hash: String = row.try_get("wallet_hash")?;
    let pair_hash: String = row.try_get("pair_hash")?;
    let supplier_hash: String = row.try_get("supplier_hash")?;
    match (req.decision, req.reason_type) {
        (FinalDecision::Approved, _) => {
            approve_subject(&mut *tx, &wallet_hash, SubjectType::Wallet).await?;
            approve_subject(&mut *tx, &pair_hash, SubjectType::Pair).await?;
            approve_subject(&mut *tx, &supplier_hash, SubjectType::Supplier).await?;
        }
        (FinalDecision::Rejected, Some(ReasonType::Risk)) => {
            reject_risk_subject(&mut *tx, &wallet_hash, SubjectType::Wallet).await?;
            reject_risk_subject(&mut *tx, &pair_hash, SubjectType::Pair).await?;
        }
        (FinalDecision::Rejected, _) => {}
    }

    // Step 6: block the wallet; an existing OFAC block stays OFAC.
    if req.block_wallet {
        block_subject(
            &mut *tx,
            &wallet_hash,
            SubjectType::Wallet,
            BlockSource::Internal,
            AGENT_BLOCK_REASON,
        )
        .await?;
    }

    tx.commit().await?;

    Ok(DecisionResponse {
        check_id: req.check_id.clone(),
        final_decision: req.decision,
        final_reason_type: req.reason_type,
        decided_by: DecidedBy::Agents,
        decided_at: truncate_secs(decided_at),
    })
}

/// Field rules of the 5.4 table, then the 5.1 `forbidden_wording` rule.
pub fn validate(req: &DecisionRequest) -> Result<(), DecisionError> {
    let invalid = |msg: &str| Err(DecisionError::Invalid(msg.to_owned()));

    if req.check_id.trim().is_empty() {
        return invalid("check_id must not be empty");
    }

    match req.decision {
        FinalDecision::Approved => {
            if req.reason_type.is_some() {
                return invalid("reason_type must be null or absent for approved");
            }
            if req.block_wallet {
                return invalid("block_wallet is only allowed for rejected with risk");
            }
            if !req.decline_reasons.is_empty() {
                return invalid("decline_reasons must be empty or absent for approved");
            }
            Ok(())
        }
        FinalDecision::Rejected => {
            let Some(reason_type) = req.reason_type else {
                return invalid("reason_type is required for rejected");
            };
            if req.block_wallet && reason_type != ReasonType::Risk {
                return invalid("block_wallet is only allowed for rejected with risk");
            }
            let n = req.decline_reasons.len();
            if n == 0 {
                return invalid("decline_reasons is required for rejected");
            }
            if n > MAX_DECLINE_REASONS {
                return invalid("decline_reasons allows at most 10 entries");
            }
            for r in &req.decline_reasons {
                if r.id.trim().is_empty() {
                    return invalid("decline_reasons[].id must not be empty");
                }
                if r.text.trim().is_empty() {
                    return invalid("decline_reasons[].text must not be empty");
                }
                if r.text.chars().count() > MAX_REASON_CHARS {
                    return invalid("decline_reasons[].text exceeds 500 characters");
                }
                if r.evidence.chars().count() > MAX_REASON_CHARS {
                    return invalid("decline_reasons[].evidence exceeds 500 characters");
                }
            }
            if req
                .decline_reasons
                .iter()
                .any(|r| contains_forbidden_wording(&r.text))
            {
                return Err(DecisionError::ForbiddenWording);
            }
            Ok(())
        }
    }
}

/// `betrug` or `fraud`, case-insensitive (5.1).
pub fn contains_forbidden_wording(text: &str) -> bool {
    let lower = text.to_lowercase();
    FORBIDDEN_WORDS.iter().any(|w| lower.contains(w))
}

/// Decision columns of an already decided `invoices` row.
struct StoredDecision {
    decision: String,
    reason_type: Option<String>,
    block_wallet: Option<bool>,
    decline_reasons: Option<serde_json::Value>,
}

impl StoredDecision {
    /// Step 3: same `decision`, `reason_type`, `block_wallet` and `decline_reasons`
    /// (same entries in the same order). `NULL` reasons equal an empty list and a
    /// `NULL` block flag equals `false`. Reasons compare as JSON values, so key order
    /// inside the stored jsonb does not matter.
    fn matches(&self, req: &DecisionRequest) -> bool {
        let stored_reasons = match &self.decline_reasons {
            None | Some(serde_json::Value::Null) => serde_json::Value::Array(Vec::new()),
            Some(v) => v.clone(),
        };
        let requested_reasons =
            decline_reasons_json(req).unwrap_or(serde_json::Value::Array(Vec::new()));
        self.decision == req.decision.as_str()
            && self.reason_type.as_deref() == req.reason_type.map(ReasonType::as_str)
            && self.block_wallet.unwrap_or(false) == req.block_wallet
            && stored_reasons == requested_reasons
    }
}

/// `final_decline_reasons` to store: the list for `rejected`, `NULL` for `approved`
/// (like the automatic Low decision in 3.5).
fn decline_reasons_json(req: &DecisionRequest) -> Option<serde_json::Value> {
    if req.decline_reasons.is_empty() {
        return None;
    }
    let reasons: Vec<DeclineReason> = req
        .decline_reasons
        .iter()
        .cloned()
        .map(DeclineReason::from)
        .collect();
    Some(serde_json::to_value(reasons).expect("decline reasons serialize"))
}

fn parse_decided_by(value: Option<&str>) -> Result<DecidedBy, sqlx::Error> {
    match value {
        Some("agents") => Ok(DecidedBy::Agents),
        Some("initial_check") => Ok(DecidedBy::InitialCheck),
        Some(other) => Err(sqlx::Error::ColumnDecode {
            index: "decided_by".to_owned(),
            source: format!("unexpected decided_by value: {other}").into(),
        }),
        None => Err(missing("decided_by")),
    }
}

fn missing(column: &str) -> sqlx::Error {
    sqlx::Error::ColumnDecode {
        index: column.to_owned(),
        source: format!("{column} is NULL on a decided invoice").into(),
    }
}

/// `decided_at` in the response has whole seconds (RFC 3339 `…:SSZ`).
fn truncate_secs(t: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp(t.timestamp(), 0).unwrap_or(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DeclineReasonInput;

    fn reason(id: &str, text: &str, evidence: &str) -> DeclineReasonInput {
        DeclineReasonInput {
            id: id.into(),
            text: text.into(),
            evidence: evidence.into(),
        }
    }

    fn approved() -> DecisionRequest {
        DecisionRequest {
            check_id: "chk_X".into(),
            decision: FinalDecision::Approved,
            reason_type: None,
            block_wallet: false,
            decline_reasons: vec![],
        }
    }

    fn rejected_risk() -> DecisionRequest {
        DecisionRequest {
            check_id: "chk_X".into(),
            decision: FinalDecision::Rejected,
            reason_type: Some(ReasonType::Risk),
            block_wallet: true,
            decline_reasons: vec![reason("S-3", "Adresse weicht ab.", "approved 6x")],
        }
    }

    fn assert_invalid(req: &DecisionRequest) {
        match validate(req) {
            Err(DecisionError::Invalid(_)) => {}
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn valid_requests_pass() {
        validate(&approved()).unwrap();
        validate(&rejected_risk()).unwrap();
        let mut formal = rejected_risk();
        formal.reason_type = Some(ReasonType::Formal);
        formal.block_wallet = false;
        validate(&formal).unwrap();
    }

    #[test]
    fn decisions_parse_null_reason_type_for_approved() {
        let req: DecisionRequest = serde_json::from_value(serde_json::json!({
            "check_id": "chk_X", "decision": "approved", "reason_type": null, "decline_reasons": []
        }))
        .unwrap();
        validate(&req).unwrap();
    }

    #[test]
    fn empty_check_id_is_invalid() {
        let mut r = approved();
        r.check_id = "  ".into();
        assert_invalid(&r);
    }

    #[test]
    fn approved_rejects_reason_type_block_and_reasons() {
        let mut r = approved();
        r.reason_type = Some(ReasonType::Risk);
        assert_invalid(&r);

        let mut r = approved();
        r.block_wallet = true;
        assert_invalid(&r);

        let mut r = approved();
        r.decline_reasons = vec![reason("S-3", "t", "e")];
        assert_invalid(&r);
    }

    #[test]
    fn rejected_requires_reason_type_and_reasons() {
        let mut r = rejected_risk();
        r.reason_type = None;
        r.block_wallet = false;
        assert_invalid(&r);

        // Test 26 (a): rejected without decline_reasons.
        let mut r = rejected_risk();
        r.decline_reasons.clear();
        assert_invalid(&r);
    }

    #[test]
    fn block_wallet_only_for_rejected_risk() {
        let mut r = rejected_risk();
        r.reason_type = Some(ReasonType::Formal);
        assert_invalid(&r);
    }

    #[test]
    fn decline_reasons_count_limits() {
        let mut r = rejected_risk();
        r.decline_reasons = (0..10)
            .map(|i| reason(&format!("I-{i}"), "t", ""))
            .collect();
        validate(&r).unwrap();
        r.decline_reasons.push(reason("I-10", "t", ""));
        assert_invalid(&r);
    }

    #[test]
    fn decline_reason_fields() {
        let mut r = rejected_risk();
        r.decline_reasons = vec![reason("", "t", "e")];
        assert_invalid(&r);

        r.decline_reasons = vec![reason("S-3", " ", "e")];
        assert_invalid(&r);

        // Empty evidence is allowed.
        r.decline_reasons = vec![reason("S-3", "t", "")];
        validate(&r).unwrap();

        // 500 characters (multi-byte) pass, 501 fail.
        r.decline_reasons = vec![reason("S-3", &"ä".repeat(500), &"ü".repeat(500))];
        validate(&r).unwrap();
        r.decline_reasons = vec![reason("S-3", &"ä".repeat(501), "e")];
        assert_invalid(&r);
        r.decline_reasons = vec![reason("S-3", "t", &"ü".repeat(501))];
        assert_invalid(&r);
    }

    #[test]
    fn forbidden_wording_case_insensitive() {
        assert!(contains_forbidden_wording("Verdacht auf Betrug"));
        assert!(contains_forbidden_wording("BETRUG"));
        assert!(contains_forbidden_wording("possible FrAuD"));
        assert!(contains_forbidden_wording("Fraudulent"));
        assert!(!contains_forbidden_wording("Adresse weicht ab"));

        // Test 26 (f).
        let mut r = rejected_risk();
        r.decline_reasons = vec![
            reason("S-3", "Adresse weicht ab", ""),
            reason("S-1", "Betrug vermutet", ""),
        ];
        assert!(matches!(validate(&r), Err(DecisionError::ForbiddenWording)));

        // Only `text` is checked.
        r.decline_reasons = vec![reason("S-3", "Adresse weicht ab", "fraud report")];
        validate(&r).unwrap();
    }

    #[test]
    fn invalid_fields_take_precedence_over_wording() {
        let mut r = rejected_risk();
        r.decline_reasons = vec![reason("", "Betrug", "")];
        assert_invalid(&r);
    }

    #[test]
    fn stored_decision_matching() {
        let req = rejected_risk();
        let stored = StoredDecision {
            decision: "rejected".into(),
            reason_type: Some("risk".into()),
            block_wallet: Some(true),
            // Different key order than the serialized request.
            decline_reasons: Some(serde_json::json!([
                {"evidence": "approved 6x", "text": "Adresse weicht ab.", "id": "S-3"}
            ])),
        };
        assert!(stored.matches(&req));

        let mut other = req.clone();
        other.block_wallet = false;
        assert!(!stored.matches(&other));

        let mut other = req.clone();
        other.decline_reasons[0].evidence = "x".into();
        assert!(!stored.matches(&other));

        let mut other = req.clone();
        other.decline_reasons.push(reason("I-5", "t", ""));
        assert!(!stored.matches(&other));

        assert!(!stored.matches(&approved()));

        let stored_approved = StoredDecision {
            decision: "approved".into(),
            reason_type: None,
            block_wallet: Some(false),
            decline_reasons: None,
        };
        assert!(stored_approved.matches(&approved()));
        assert!(!stored_approved.matches(&req));
    }

    #[test]
    fn stored_reason_order_matters() {
        let mut req = rejected_risk();
        req.block_wallet = false;
        req.decline_reasons = vec![reason("A", "a", ""), reason("B", "b", "")];
        let stored = StoredDecision {
            decision: "rejected".into(),
            reason_type: Some("risk".into()),
            block_wallet: Some(false),
            decline_reasons: Some(serde_json::json!([
                {"id": "B", "text": "b", "evidence": ""},
                {"id": "A", "text": "a", "evidence": ""}
            ])),
        };
        assert!(!stored.matches(&req));
    }

    #[test]
    fn decided_at_truncated_to_seconds() {
        let t = DateTime::parse_from_rfc3339("2026-10-30T12:05:00.987654Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            crate::model::format_rfc3339_secs(&truncate_secs(t)),
            "2026-10-30T12:05:00Z"
        );
    }
}
