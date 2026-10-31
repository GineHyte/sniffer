//! Reducers (spec 3.6.5, `kind = "reducer"`). They return the configured negative
//! points; scoring decides whether they apply and caps them (3.8 step 2).

use rust_decimal::Decimal;

use super::{
    effective_wallet_trust, finding, fmt_trust, open_order_match, pair_approved, points,
    CheckContext, Criterion, Finding,
};
use crate::config::CriterionCfg;

/// T-1: effective wallet trust ≥ `wallet_trust_reducer_min`.
pub struct T1;

impl Criterion for T1 {
    fn id(&self) -> &'static str {
        "T-1"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let t: Decimal = effective_wallet_trust(ctx);
        if t < ctx.params.wallet_trust_reducer_min {
            return None;
        }
        finding(points(cfg), format!("wallet trust {}", fmt_trust(t)))
    }
}

/// T-2: pair approvals ≥ `pair_reducer_min_approved`.
pub struct T2;

impl Criterion for T2 {
    fn id(&self) -> &'static str {
        "T-2"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let n = pair_approved(ctx);
        if i64::from(n) < ctx.params.pair_reducer_min_approved {
            return None;
        }
        finding(points(cfg), format!("pair approved {n}x"))
    }
}

/// T-3: BT-13 matches an open order of this supplier (the I-8 match).
pub struct T3;

impl Criterion for T3 {
    fn id(&self) -> &'static str {
        "T-3"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        if open_order_match(ctx) != Some(true) {
            return None;
        }
        finding(points(cfg), "BT-13 matches an open order of this supplier")
    }
}

/// T-4: VIES says valid.
pub struct T4;

impl Criterion for T4 {
    fn id(&self) -> &'static str {
        "T-4"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        match ctx.vies.ok() {
            Some(true) => finding(points(cfg), "VIES: valid"),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria::testutil::*;
    use crate::criteria::SourceResult;
    use crate::store::postgres::{BlockSource, SubjectType};

    #[test]
    fn t1() {
        let mut c = ctx();
        assert_eq!(eval(&T1, &c), None, "missing wallet = trust 0");
        c.wallet = Some(subject(SubjectType::Wallet, 6, "0.545"));
        fired(&T1, &c, -15, "wallet trust 0.545");
        c.wallet = Some(subject(SubjectType::Wallet, 5, "0.5"));
        fired(&T1, &c, -15, "wallet trust 0.500");
        c.wallet = Some(subject(SubjectType::Wallet, 4, "0.444"));
        assert_eq!(eval(&T1, &c), None);
        // Blocked wallet: effective trust -1 regardless of `trust`.
        let mut b = blocked(SubjectType::Wallet, BlockSource::Internal, "X");
        b.trust = d("0.9");
        c.wallet = Some(b);
        assert_eq!(eval(&T1, &c), None);
    }

    #[test]
    fn t2() {
        let mut c = ctx();
        assert_eq!(eval(&T2, &c), None);
        c.pair = Some(subject(SubjectType::Pair, 2, "0.286"));
        assert_eq!(eval(&T2, &c), None);
        c.pair = Some(subject(SubjectType::Pair, 6, "0.545"));
        fired(&T2, &c, -10, "pair approved 6x");
    }

    #[test]
    fn t3() {
        let mut inv = f1();
        fired(
            &T3,
            &ctx().with_invoice(&inv),
            -10,
            "BT-13 matches an open order of this supplier",
        );
        inv.order_reference = Some("PO-2026-002".into());
        assert_eq!(eval(&T3, &ctx().with_invoice(&inv)), None);
        inv.order_reference = None;
        assert_eq!(eval(&T3, &ctx().with_invoice(&inv)), None);
    }

    #[test]
    fn t4() {
        let mut c = ctx();
        for r in [
            SourceResult::Ok(false),
            SourceResult::Unavailable,
            SourceResult::NotApplicable,
        ] {
            c.vies = r;
            assert_eq!(eval(&T4, &c), None);
        }
        c.vies = SourceResult::Ok(true);
        fired(&T4, &c, -5, "VIES: valid");
    }
}
