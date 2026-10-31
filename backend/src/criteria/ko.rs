//! K.O. criteria (spec 3.6.1). Points: `ko_points` unless the entry sets `points`.

use super::{finding, CheckContext, Criterion, Finding};
use crate::config::CriterionCfg;
use crate::store::postgres::{BlockSource, Subject};

fn ko_points(ctx: &CheckContext, cfg: &CriterionCfg) -> i32 {
    cfg.points.unwrap_or(ctx.ko_points)
}

/// Blocked entry with the given `block_source`.
fn blocked_by(s: &Option<Subject>, source: BlockSource) -> Option<&Subject> {
    s.as_ref()
        .filter(|s| s.is_blocked() && s.block_source == Some(source))
}

/// KO-1: codes from steps 2, 3 or 4, joined with `, `.
pub struct Ko1;

impl Criterion for Ko1 {
    fn id(&self) -> &'static str {
        "KO-1"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        if ctx.ko1_codes.is_empty() {
            return None;
        }
        finding(ko_points(ctx, cfg), ctx.ko1_codes.join(", "))
    }
}

/// KO-2: 3.4 violation; evidence is the code.
pub struct Ko2;

impl Criterion for Ko2 {
    fn id(&self) -> &'static str {
        "KO-2"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        match &ctx.address {
            Some(Err(e)) => finding(ko_points(ctx, cfg), e.code()),
            _ => None,
        }
    }
}

/// KO-3: `invoice_hash` already in `invoices`.
pub struct Ko3;

impl Criterion for Ko3 {
    fn id(&self) -> &'static str {
        "KO-3"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let id = ctx.existing_invoice_check_id.as_deref()?;
        finding(ko_points(ctx, cfg), format!("duplicate of {id}"))
    }
}

/// KO-4: wallet blocked by OFAC and/or seller name on the SDN list.
pub struct Ko4;

impl Criterion for Ko4 {
    fn id(&self) -> &'static str {
        "KO-4"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let mut parts = Vec::new();
        if blocked_by(&ctx.wallet, BlockSource::Ofac).is_some() {
            parts.push("wallet on OFAC SDN list");
        }
        if ctx.sanction_name_hit {
            parts.push("seller name matches OFAC SDN entry");
        }
        if parts.is_empty() {
            return None;
        }
        finding(ko_points(ctx, cfg), parts.join("; "))
    }
}

/// KO-6: wallet and/or supplier on the internal blocklist.
pub struct Ko6;

impl Criterion for Ko6 {
    fn id(&self) -> &'static str {
        "KO-6"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let reason = |s: &Subject| s.block_reason.clone().unwrap_or_default();
        let mut parts = Vec::new();
        if let Some(w) = blocked_by(&ctx.wallet, BlockSource::Internal) {
            parts.push(format!("wallet blocked ({})", reason(w)));
        }
        if let Some(s) = blocked_by(&ctx.supplier, BlockSource::Internal) {
            parts.push(format!("supplier blocked ({})", reason(s)));
        }
        if parts.is_empty() {
            return None;
        }
        finding(ko_points(ctx, cfg), parts.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::AddressError;
    use crate::criteria::testutil::*;
    use crate::store::postgres::SubjectType;

    #[test]
    fn ko1() {
        let mut c = ctx();
        assert_eq!(eval(&Ko1, &c), None);
        c.ko1_codes = vec!["MISSING_FIELD:BT-84".into(), "MUSTANG:BR-DE-15".into()];
        fired(&Ko1, &c, 100, "MISSING_FIELD:BT-84, MUSTANG:BR-DE-15");
    }

    #[test]
    fn ko2() {
        let mut c = ctx();
        assert_eq!(eval(&Ko2, &c), None);
        c.address = Some(Err(AddressError::NetworkMismatch));
        fired(&Ko2, &c, 100, "NETWORK_MISMATCH");
    }

    #[test]
    fn ko3() {
        let mut c = ctx();
        assert_eq!(eval(&Ko3, &c), None);
        c.existing_invoice_check_id = Some("chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W".into());
        fired(&Ko3, &c, 100, "duplicate of chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W");
    }

    #[test]
    fn ko4_single_and_both_reasons() {
        let mut c = ctx();
        // Internal block is KO-6, not KO-4.
        c.wallet = Some(blocked(
            SubjectType::Wallet,
            BlockSource::Internal,
            "TEST_INTERNAL",
        ));
        assert_eq!(eval(&Ko4, &c), None);
        c.wallet = Some(blocked(SubjectType::Wallet, BlockSource::Ofac, "TEST_OFAC"));
        fired(&Ko4, &c, 100, "wallet on OFAC SDN list");
        c.sanction_name_hit = true;
        fired(
            &Ko4,
            &c,
            100,
            "wallet on OFAC SDN list; seller name matches OFAC SDN entry",
        );
        c.wallet = None;
        fired(&Ko4, &c, 100, "seller name matches OFAC SDN entry");
    }

    #[test]
    fn ko6_single_and_both_reasons() {
        let mut c = ctx();
        c.wallet = Some(blocked(SubjectType::Wallet, BlockSource::Ofac, "TEST_OFAC"));
        c.supplier = Some(subject(SubjectType::Supplier, 6, "0.545"));
        assert_eq!(eval(&Ko6, &c), None);
        c.wallet = Some(blocked(
            SubjectType::Wallet,
            BlockSource::Internal,
            "TEST_INTERNAL",
        ));
        fired(&Ko6, &c, 100, "wallet blocked (TEST_INTERNAL)");
        c.supplier = Some(blocked(
            SubjectType::Supplier,
            BlockSource::Internal,
            "AGENT_DECISION",
        ));
        fired(
            &Ko6,
            &c,
            100,
            "wallet blocked (TEST_INTERNAL); supplier blocked (AGENT_DECISION)",
        );
    }
}
