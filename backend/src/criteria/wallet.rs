//! Wallet and on-chain criteria (spec 3.6.3). They fire only on a successful source
//! answer; an unavailable or skipped source never fires (FR-44).

use chrono::DateTime;

use super::{finding, points, CheckContext, Criterion, Finding};
use crate::config::CriterionCfg;

const SECS_PER_DAY: i64 = 86_400;

/// W-1: at least one Chainabuse report with `trusted` or `checked`.
pub struct W1;

impl Criterion for W1 {
    fn id(&self) -> &'static str {
        "W-1"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let v = ctx.chainabuse.ok()?;
        if v.trusted_or_checked == 0 {
            return None;
        }
        finding(
            points(cfg),
            format!(
                "chainabuse: {} report(s), {} trusted or checked",
                v.reports, v.trusted_or_checked
            ),
        )
    }
}

/// W-2: young address; points from `points_tiers` (first tier with `age < below_days`).
pub struct W2;

/// Whole days between the first transaction and `checked_at`; negative → 0.
pub fn age_days(checked_at_unix: i64, first_tx_unix: i64) -> i64 {
    (checked_at_unix - first_tx_unix)
        .div_euclid(SECS_PER_DAY)
        .max(0)
}

impl Criterion for W2 {
    fn id(&self) -> &'static str {
        "W-2"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let first = (*ctx.blockfrost.ok()?)?;
        let age = age_days(ctx.checked_at.timestamp(), first);
        let tier = cfg
            .points_tiers
            .as_deref()?
            .iter()
            .find(|t| age < t.below_days)?;
        let date = DateTime::from_timestamp(first, 0)?.date_naive();
        finding(
            tier.points,
            format!(
                "first transaction {}, {age} days before check",
                date.format("%Y-%m-%d")
            ),
        )
    }
}

/// W-4: the address has no transaction.
pub struct W4;

impl Criterion for W4 {
    fn id(&self) -> &'static str {
        "W-4"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        match ctx.blockfrost.ok()? {
            None => finding(points(cfg), "no transactions on this address"),
            Some(_) => None,
        }
    }
}

/// W-6: Chainabuse reports, none trusted or checked.
pub struct W6;

impl Criterion for W6 {
    fn id(&self) -> &'static str {
        "W-6"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let v = ctx.chainabuse.ok()?;
        if v.reports == 0 || v.trusted_or_checked != 0 {
            return None;
        }
        finding(
            points(cfg),
            format!("chainabuse: {} unverified report(s)", v.reports),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria::testutil::*;
    use crate::criteria::SourceResult;
    use crate::sources::ChainabuseValue;

    /// 27.10.2026 12:00 UTC (8.1 stub for W2).
    const W2_FIRST_TX: i64 = 1_793_102_400;
    /// 10.01.2026 09:00 UTC (8.1 stub for W1).
    const W1_FIRST_TX: i64 = 1_768_035_600;

    fn ca(reports: u64, trusted_or_checked: u64) -> SourceResult<ChainabuseValue> {
        SourceResult::Ok(ChainabuseValue {
            reports,
            trusted_or_checked,
        })
    }

    #[test]
    fn w1() {
        let mut c = ctx();
        assert_eq!(eval(&W1, &c), None);
        c.chainabuse = ca(0, 0);
        assert_eq!(eval(&W1, &c), None);
        c.chainabuse = ca(1, 0);
        assert_eq!(eval(&W1, &c), None);
        c.chainabuse = ca(3, 1);
        fired(&W1, &c, 30, "chainabuse: 3 report(s), 1 trusted or checked");
        c.chainabuse = SourceResult::Unavailable;
        assert_eq!(eval(&W1, &c), None);
    }

    #[test]
    fn w6() {
        let mut c = ctx();
        c.chainabuse = ca(0, 0);
        assert_eq!(eval(&W6, &c), None);
        c.chainabuse = ca(1, 1);
        assert_eq!(eval(&W6, &c), None);
        c.chainabuse = ca(2, 0);
        fired(&W6, &c, 10, "chainabuse: 2 unverified report(s)");
    }

    #[test]
    fn w2_tier_15() {
        let mut c = ctx();
        c.blockfrost = SourceResult::Ok(Some(W2_FIRST_TX));
        fired(
            &W2,
            &c,
            15,
            "first transaction 2026-10-27, 3 days before check",
        );
    }

    #[test]
    fn w2_tier_8_and_boundaries() {
        let now = checked_at().timestamp();
        let mut c = ctx();
        // Exactly 7 days → second tier.
        c.blockfrost = SourceResult::Ok(Some(now - 7 * SECS_PER_DAY));
        fired(
            &W2,
            &c,
            8,
            "first transaction 2026-10-23, 7 days before check",
        );
        // One second short of 7 days → floor 6 → first tier.
        c.blockfrost = SourceResult::Ok(Some(now - 7 * SECS_PER_DAY + 1));
        fired(
            &W2,
            &c,
            15,
            "first transaction 2026-10-23, 6 days before check",
        );
        // 29 days → 8; 30 days → none.
        c.blockfrost = SourceResult::Ok(Some(now - 29 * SECS_PER_DAY));
        fired(
            &W2,
            &c,
            8,
            "first transaction 2026-10-01, 29 days before check",
        );
        c.blockfrost = SourceResult::Ok(Some(now - 30 * SECS_PER_DAY));
        assert_eq!(eval(&W2, &c), None);
        c.blockfrost = SourceResult::Ok(Some(W1_FIRST_TX));
        assert_eq!(eval(&W2, &c), None);
    }

    #[test]
    fn w2_negative_age_counts_as_zero() {
        let mut c = ctx();
        // First transaction one hour after checked_at.
        c.blockfrost = SourceResult::Ok(Some(checked_at().timestamp() + 3600));
        fired(
            &W2,
            &c,
            15,
            "first transaction 2026-10-30, 0 days before check",
        );
        assert_eq!(age_days(0, 10 * SECS_PER_DAY), 0);
    }

    #[test]
    fn w2_w4_not_on_unavailable_or_no_tx() {
        let mut c = ctx();
        for r in [SourceResult::Unavailable, SourceResult::Skipped] {
            c.blockfrost = r;
            assert_eq!(eval(&W2, &c), None);
            assert_eq!(eval(&W4, &c), None);
        }
        c.blockfrost = SourceResult::Ok(None);
        assert_eq!(eval(&W2, &c), None);
    }

    #[test]
    fn w4() {
        let mut c = ctx();
        c.blockfrost = SourceResult::Ok(Some(W1_FIRST_TX));
        assert_eq!(eval(&W4, &c), None);
        c.blockfrost = SourceResult::Ok(None);
        fired(&W4, &c, 10, "no transactions on this address");
    }
}
