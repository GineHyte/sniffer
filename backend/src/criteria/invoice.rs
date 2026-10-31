//! Invoice content criteria (spec 3.6.4). I-2, I-4 and I-10 run only with BT-5 = EUR
//! (otherwise scoring records `CURRENCY_NOT_EUR`, see [`super::currency_not_eur`]).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use chrono::Duration;
use regex::Regex;
use rust_decimal::Decimal;

use super::{
    effective_wallet_trust, eur_total, finding, fmt_trust, open_order_match, points, CheckContext,
    Criterion, Finding,
};
use crate::address::Network;
use crate::config::CriterionCfg;
use crate::normalize::{self, amount};

/// I-2: amount above the exposure limit.
pub struct I2;

impl Criterion for I2 {
    fn id(&self) -> &'static str {
        "I-2"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let a = eur_total(ctx)?;
        let trust = effective_wallet_trust(ctx);
        let p = ctx.params;
        let limit = if trust <= Decimal::ZERO && a > p.new_wallet_limit_eur {
            p.new_wallet_limit_eur
        } else if a > p.max_invoice_eur {
            p.max_invoice_eur
        } else {
            return None;
        };
        finding(
            points(cfg),
            format!(
                "amount {} EUR > limit {} EUR (wallet trust {})",
                amount(&a),
                amount(&limit),
                fmt_trust(trust)
            ),
        )
    }
}

/// I-3: buyer data differs from `data/buyer-master.json`.
pub struct I3;

impl Criterion for I3 {
    fn id(&self) -> &'static str {
        "I-3"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let inv = ctx.invoice?;
        let master = &ctx.data.buyer_master;
        let lf = &ctx.data.legal_forms;
        let mut fields = Vec::new();
        if inv
            .buyer_name
            .as_deref()
            .is_some_and(|n| normalize::name(n, lf) != normalize::name(&master.name, lf))
        {
            fields.push("name");
        }
        if inv
            .buyer_vat_id
            .as_deref()
            .is_some_and(|v| normalize::vat(v) != normalize::vat(&master.vat_id))
        {
            fields.push("vat_id");
        }
        if inv
            .buyer_postcode
            .as_deref()
            .is_some_and(|p| p.trim() != master.postcode)
        {
            fields.push("postcode");
        }
        if fields.is_empty() {
            return None;
        }
        finding(
            points(cfg),
            format!("buyer mismatch: {}", fields.join(", ")),
        )
    }
}

/// Median; even count → mean of the two middle values. `None` for an empty list.
pub fn median(values: &[Decimal]) -> Option<Decimal> {
    let mut v = values.to_vec();
    v.sort();
    let n = v.len();
    match n {
        0 => None,
        _ if n % 2 == 1 => Some(v[n / 2]),
        _ => Some((v[n / 2 - 1] + v[n / 2]) / Decimal::TWO),
    }
}

/// I-4: amount far above the supplier's approved EUR median.
pub struct I4;

impl Criterion for I4 {
    fn id(&self) -> &'static str {
        "I-4"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let a = eur_total(ctx)?;
        let amounts = &ctx.approved_eur_amounts;
        let n = amounts.len();
        if (n as i64) < ctx.params.median_min_invoices {
            return None;
        }
        let m = median(amounts)?;
        let f = ctx.params.median_factor;
        if a <= Decimal::from(f) * m {
            return None;
        }
        finding(
            points(cfg),
            format!(
                "amount {} EUR > {f} x median {} EUR ({n} invoices)",
                amount(&a),
                amount(&m)
            ),
        )
    }
}

/// I-5: pressure wording in BT-22 (without signature entries), BT-20 or BT-83.
pub struct I5;

impl Criterion for I5 {
    fn id(&self) -> &'static str {
        "I-5"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let inv = ctx.invoice?;
        // `Invoice::notes` already excludes `cardano-sig-` entries (3.2).
        let texts: Vec<String> = inv
            .notes
            .iter()
            .chain(&inv.payment_terms)
            .chain(&inv.payment_reference)
            .map(|t| normalize::phrase_text(t))
            .collect();
        let hits: BTreeSet<&str> = ctx
            .data
            .pressure_words
            .iter()
            .filter(|w| texts.iter().any(|t| t.contains(&w.phrase)))
            .map(|w| w.normalized.as_str())
            .collect();
        if hits.is_empty() {
            return None;
        }
        let hits: Vec<&str> = hits.into_iter().collect();
        finding(
            points(cfg),
            format!("pressure wording: {}", hits.join(", ")),
        )
    }
}

/// I-6: issue date in the future or older than `issue_date_max_age_days`.
pub struct I6;

impl Criterion for I6 {
    fn id(&self) -> &'static str {
        "I-6"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let issue = ctx.invoice?.issue_date?;
        let today = ctx.check_date;
        let oldest = today - Duration::days(ctx.params.issue_date_max_age_days);
        if issue <= today && issue >= oldest {
            return None;
        }
        finding(
            points(cfg),
            format!(
                "BT-2 {}, check date {}",
                issue.format("%Y-%m-%d"),
                today.format("%Y-%m-%d")
            ),
        )
    }
}

/// I-7: due date less than `due_min_days` after the issue date.
pub struct I7;

impl Criterion for I7 {
    fn id(&self) -> &'static str {
        "I-7"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let inv = ctx.invoice?;
        let (issue, due) = (inv.issue_date?, inv.due_date?);
        let days = (due - issue).num_days();
        if days >= ctx.params.due_min_days {
            return None;
        }
        finding(
            points(cfg),
            format!(
                "BT-2 {}, BT-9 {} ({days} days)",
                issue.format("%Y-%m-%d"),
                due.format("%Y-%m-%d")
            ),
        )
    }
}

/// I-8: no BT-13, or BT-13 is not an open order of this supplier.
pub struct I8;

impl Criterion for I8 {
    fn id(&self) -> &'static str {
        "I-8"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        ctx.invoice?;
        match open_order_match(ctx) {
            None => finding(points(cfg), "BT-13 empty"),
            Some(false) => finding(points(cfg), "BT-13 not an open order of this supplier"),
            Some(true) => None,
        }
    }
}

/// I-10: round amount, or just below an approval threshold.
pub struct I10;

impl Criterion for I10 {
    fn id(&self) -> &'static str {
        "I-10"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let a = eur_total(ctx)?;
        let p = ctx.params;
        let m = p.round_amount_multiple_eur;
        if m > Decimal::ZERO && (a % m).is_zero() {
            return finding(
                points(cfg),
                format!(
                    "amount {} EUR is a multiple of {} EUR",
                    amount(&a),
                    amount(&m)
                ),
            );
        }
        let pct = p.threshold_margin_percent;
        let factor = Decimal::from(100 - pct) / Decimal::ONE_HUNDRED;
        let t = p
            .approval_thresholds_eur
            .iter()
            .find(|t| **t * factor <= a && a < **t)?;
        finding(
            points(cfg),
            format!(
                "amount {} EUR within {pct}% below threshold {} EUR",
                amount(&a),
                amount(t)
            ),
        )
    }
}

static BT82_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^cardano:(preprod|mainnet):(ADA|[0-9a-f]{56}(\.[0-9a-f]{0,64})?)$")
        .expect("BT-82 regex")
});

fn network_str(n: Network) -> &'static str {
    match n {
        Network::Preprod => "preprod",
        Network::Mainnet => "mainnet",
    }
}

/// I-11: payment details inconsistent; all reasons in table order, joined with `; `.
pub struct I11;

impl Criterion for I11 {
    fn id(&self) -> &'static str {
        "I-11"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let inv = ctx.invoice?;
        let mut reasons = Vec::new();
        if let Some(code) = inv.payment_means_code.as_deref().filter(|c| *c != "ZZZ") {
            reasons.push(format!("BT-81 {code} (expected ZZZ)"));
        }
        match inv.payment_info.as_deref() {
            None => reasons.push("BT-82 missing".into()),
            Some(info) => match BT82_RE.captures(info) {
                None => reasons.push("BT-82 malformed".into()),
                Some(caps) => {
                    let net = &caps[1];
                    let expected = network_str(ctx.expected_network);
                    if net != expected {
                        reasons.push(format!("BT-82 network {net} (expected {expected})"));
                    }
                }
            },
        }
        if reasons.is_empty() {
            return None;
        }
        finding(points(cfg), reasons.join("; "))
    }
}

/// I-12: corrected invoice (BT-3 = 384); 0 points, forces at least Medium in scoring.
pub struct I12;

impl Criterion for I12 {
    fn id(&self) -> &'static str {
        "I-12"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        if ctx.invoice?.type_code.as_deref() != Some("384") {
            return None;
        }
        finding(points(cfg), "BT-3 384 (corrected invoice)")
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;
    use crate::criteria::currency_not_eur;
    use crate::criteria::testutil::*;
    use crate::store::postgres::{BlockSource, SubjectType};

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn i2_new_wallet_limit() {
        // The shipped config sets the new-wallet limit equal to the max, so test the rule with a lower limit.
        let mut params = CRITERIA.params.clone();
        params.new_wallet_limit_eur = d("1000.00");
        let ctx = || {
            let mut c = ctx();
            c.params = &params;
            c
        };
        let mut inv = f1();
        inv.grand_total = Some(d("2000.00"));
        let c = ctx().with_invoice(&inv);
        fired(
            &I2,
            &c,
            20,
            "amount 2000.00 EUR > limit 1000.00 EUR (wallet trust 0.000)",
        );
        let mut c = ctx().with_invoice(&inv);
        c.wallet = Some(blocked(SubjectType::Wallet, BlockSource::Internal, "X"));
        fired(
            &I2,
            &c,
            20,
            "amount 2000.00 EUR > limit 1000.00 EUR (wallet trust -1.000)",
        );
        c.wallet = Some(subject(SubjectType::Wallet, 6, "0.545"));
        assert_eq!(eval(&I2, &c), None, "trusted wallet, below max");
        // Exactly the limit does not fire.
        inv.grand_total = Some(d("1000.00"));
        let c = ctx().with_invoice(&inv);
        assert_eq!(eval(&I2, &c), None);
    }

    #[test]
    fn i2_max_invoice() {
        let mut inv = f1();
        inv.grand_total = Some(d("10000.01"));
        let mut c = ctx().with_invoice(&inv);
        c.wallet = Some(subject(SubjectType::Wallet, 6, "0.545"));
        fired(
            &I2,
            &c,
            20,
            "amount 10000.01 EUR > limit 10000.00 EUR (wallet trust 0.545)",
        );
    }

    #[test]
    fn eur_only_criteria_skip_other_currencies() {
        let mut inv = f1();
        inv.grand_total = Some(d("12000.00"));
        inv.currency = Some("USD".into());
        let mut c = ctx().with_invoice(&inv);
        c.approved_eur_amounts = vec![d("100"), d("100"), d("100")];
        assert!(currency_not_eur(&c));
        assert_eq!(eval(&I2, &c), None);
        assert_eq!(eval(&I4, &c), None);
        assert_eq!(eval(&I10, &c), None);
        let inv = f1();
        assert!(!currency_not_eur(&ctx().with_invoice(&inv)));
        assert!(!currency_not_eur(&ctx()));
    }

    #[test]
    fn i3() {
        let mut inv = f1();
        assert_eq!(eval(&I3, &ctx().with_invoice(&inv)), None);
        // Legal form and case differences are normalized away.
        inv.buyer_name = Some("KÄUFER HANDELS".into());
        assert_eq!(eval(&I3, &ctx().with_invoice(&inv)), None);
        inv.buyer_postcode = Some("10117".into());
        fired(
            &I3,
            &ctx().with_invoice(&inv),
            15,
            "buyer mismatch: postcode",
        );
        inv.buyer_name = Some("Other Buyer GmbH".into());
        inv.buyer_vat_id = Some("DE 123 456 789".into());
        fired(
            &I3,
            &ctx().with_invoice(&inv),
            15,
            "buyer mismatch: name, vat_id, postcode",
        );
        // Absent BT-48 / BT-53 are not compared.
        inv.buyer_vat_id = None;
        inv.buyer_postcode = None;
        fired(&I3, &ctx().with_invoice(&inv), 15, "buyer mismatch: name");
    }

    #[test]
    fn median_odd_even() {
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[d("3"), d("1"), d("2")]), Some(d("2")));
        let seed = [
            d("1190.00"),
            d("1250.00"),
            d("980.00"),
            d("1100.00"),
            d("1300.00"),
            d("1050.00"),
        ];
        assert_eq!(median(&seed), Some(d("1145.00")));
    }

    #[test]
    fn i4_even_count_median() {
        let seed = [
            "1190.00", "1250.00", "980.00", "1100.00", "1300.00", "1050.00",
        ]
        .map(d)
        .to_vec();
        let mut inv = f1();
        inv.grand_total = Some(d("3435.01"));
        let mut c = ctx().with_invoice(&inv);
        c.wallet = Some(subject(SubjectType::Wallet, 6, "0.545"));
        c.approved_eur_amounts = seed.clone();
        fired(
            &I4,
            &c,
            10,
            "amount 3435.01 EUR > 3 x median 1145.00 EUR (6 invoices)",
        );
        // Exactly 3 x median does not fire.
        let mut inv = f1();
        inv.grand_total = Some(d("3435.00"));
        let mut c = ctx().with_invoice(&inv);
        c.approved_eur_amounts = seed;
        assert_eq!(eval(&I4, &c), None);
    }

    #[test]
    fn i4_needs_min_invoices() {
        let mut inv = f1();
        inv.grand_total = Some(d("5000.00"));
        let mut c = ctx().with_invoice(&inv);
        c.approved_eur_amounts = vec![d("100.00"), d("100.00")];
        assert_eq!(eval(&I4, &c), None);
        c.approved_eur_amounts.push(d("400.00"));
        fired(
            &I4,
            &c,
            10,
            "amount 5000.00 EUR > 3 x median 100.00 EUR (3 invoices)",
        );
    }

    #[test]
    fn i5_fires_on_notes_terms_and_reference() {
        let mut inv = f1();
        assert_eq!(eval(&I5, &ctx().with_invoice(&inv)), None);
        inv.notes = vec!["Bitte dringend überweisen, neue Wallet.".into()];
        fired(
            &I5,
            &ctx().with_invoice(&inv),
            10,
            "pressure wording: dringend, neue wallet",
        );
        inv.notes = vec!["Bitte heute noch zahlen".into()];
        inv.payment_terms.push("SOFORT fällig".into());
        inv.payment_reference = Some("URGENT".into());
        fired(
            &I5,
            &ctx().with_invoice(&inv),
            10,
            "pressure wording: heute noch, sofort, urgent",
        );
    }

    #[test]
    fn i5_ignores_signatures_and_partial_words() {
        let mut inv = f1();
        inv.signature_notes = vec!["cardano-sig-v1:dringend".into()];
        // "Eilige" is not the token "eilig"; "Neue Walletadresse" is its own entry only.
        inv.notes = vec!["Eilige Lieferung".into()];
        assert_eq!(eval(&I5, &ctx().with_invoice(&inv)), None);
        inv.notes = vec!["Neue Walletadresse".into()];
        fired(
            &I5,
            &ctx().with_invoice(&inv),
            10,
            "pressure wording: neue walletadresse",
        );
    }

    #[test]
    fn i6() {
        let mut inv = f1();
        assert_eq!(eval(&I6, &ctx().with_invoice(&inv)), None);
        inv.issue_date = Some(date(2026, 10, 31));
        fired(
            &I6,
            &ctx().with_invoice(&inv),
            8,
            "BT-2 2026-10-31, check date 2026-10-30",
        );
        // Exactly 90 days back is fine; 91 fires.
        inv.issue_date = Some(date(2026, 8, 1));
        assert_eq!(eval(&I6, &ctx().with_invoice(&inv)), None);
        inv.issue_date = Some(date(2026, 7, 31));
        fired(
            &I6,
            &ctx().with_invoice(&inv),
            8,
            "BT-2 2026-07-31, check date 2026-10-30",
        );
    }

    #[test]
    fn i7() {
        let mut inv = f1();
        assert_eq!(eval(&I7, &ctx().with_invoice(&inv)), None);
        inv.due_date = Some(date(2026, 10, 30));
        fired(
            &I7,
            &ctx().with_invoice(&inv),
            8,
            "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)",
        );
        inv.due_date = Some(date(2026, 10, 31));
        assert_eq!(eval(&I7, &ctx().with_invoice(&inv)), None);
        inv.due_date = None;
        assert_eq!(eval(&I7, &ctx().with_invoice(&inv)), None);
    }

    #[test]
    fn i8() {
        let mut inv = f1();
        assert_eq!(eval(&I8, &ctx().with_invoice(&inv)), None);
        // order_id() and vat() normalize both sides.
        inv.order_reference = Some(" po-2026-001 ".into());
        inv.seller_vat_id = Some("de 111 111 111".into());
        assert_eq!(eval(&I8, &ctx().with_invoice(&inv)), None);
        // PO-2026-002 belongs to DE222222222.
        inv.order_reference = Some("PO-2026-002".into());
        fired(
            &I8,
            &ctx().with_invoice(&inv),
            8,
            "BT-13 not an open order of this supplier",
        );
        inv.order_reference = None;
        fired(&I8, &ctx().with_invoice(&inv), 8, "BT-13 empty");
    }

    #[test]
    fn matched_open_order_is_the_i8_entry() {
        use crate::criteria::matched_open_order;
        let mut inv = f1();
        let o = matched_open_order(&ctx().with_invoice(&inv)).expect("F1 matches PO-2026-001");
        assert_eq!(o.order_id, "PO-2026-001");
        assert_eq!(o.supplier_vat_id, "DE111111111");
        assert_eq!(o.ordered_total, Some(d("1190.00")));
        assert_eq!(o.currency.as_deref(), Some("EUR"));
        // Normalized like I-8.
        inv.order_reference = Some(" po-2026-001 ".into());
        assert!(matched_open_order(&ctx().with_invoice(&inv)).is_some());
        // Order of another supplier, no BT-13, no BT-31: no match.
        inv.order_reference = Some("PO-2026-002".into());
        assert_eq!(matched_open_order(&ctx().with_invoice(&inv)), None);
        inv.order_reference = None;
        assert_eq!(matched_open_order(&ctx().with_invoice(&inv)), None);
        let mut inv = f1();
        inv.seller_vat_id = None;
        assert_eq!(matched_open_order(&ctx().with_invoice(&inv)), None);
        fired(
            &I8,
            &ctx().with_invoice(&inv),
            8,
            "BT-13 not an open order of this supplier",
        );
        // Demo orders for the --new-supplier VATs.
        let mut inv = f1();
        inv.seller_vat_id = Some("DE333333333".into());
        inv.order_reference = Some("PO-2026-003".into());
        assert_eq!(
            matched_open_order(&ctx().with_invoice(&inv)).map(|o| o.order_id.as_str()),
            Some("PO-2026-003")
        );
        inv.seller_vat_id = Some("DE555555555".into());
        inv.order_reference = Some("PO-2026-005".into());
        assert_eq!(eval(&I8, &ctx().with_invoice(&inv)), None);
    }

    #[test]
    fn i10_multiple_branch() {
        let mut inv = f1();
        assert_eq!(eval(&I10, &ctx().with_invoice(&inv)), None);
        inv.grand_total = Some(d("2000.00"));
        fired(
            &I10,
            &ctx().with_invoice(&inv),
            5,
            "amount 2000.00 EUR is a multiple of 100.00 EUR",
        );
    }

    #[test]
    fn i10_threshold_branch() {
        let mut inv = f1();
        inv.grand_total = Some(d("4750.00"));
        fired(
            &I10,
            &ctx().with_invoice(&inv),
            5,
            "amount 4750.00 EUR within 5% below threshold 5000.00 EUR",
        );
        inv.grand_total = Some(d("999.99"));
        fired(
            &I10,
            &ctx().with_invoice(&inv),
            5,
            "amount 999.99 EUR within 5% below threshold 1000.00 EUR",
        );
        inv.grand_total = Some(d("949.99"));
        assert_eq!(eval(&I10, &ctx().with_invoice(&inv)), None);
    }

    #[test]
    fn i11_single_and_multiple_reasons() {
        let mut inv = f1();
        assert_eq!(eval(&I11, &ctx().with_invoice(&inv)), None);
        let pid = "a".repeat(56);
        inv.payment_info = Some(format!("cardano:preprod:{pid}.4d79"));
        assert_eq!(eval(&I11, &ctx().with_invoice(&inv)), None);
        inv.payment_info = Some("cardano:mainnet:ADA".into());
        fired(
            &I11,
            &ctx().with_invoice(&inv),
            5,
            "BT-82 network mainnet (expected preprod)",
        );
        inv.payment_means_code = Some("58".into());
        inv.payment_info = None;
        fired(
            &I11,
            &ctx().with_invoice(&inv),
            5,
            "BT-81 58 (expected ZZZ); BT-82 missing",
        );
        inv.payment_info = Some("cardano:preprod:ada".into());
        fired(
            &I11,
            &ctx().with_invoice(&inv),
            5,
            "BT-81 58 (expected ZZZ); BT-82 malformed",
        );
    }

    #[test]
    fn i12() {
        let mut inv = f1();
        assert_eq!(eval(&I12, &ctx().with_invoice(&inv)), None);
        inv.type_code = Some("384".into());
        fired(
            &I12,
            &ctx().with_invoice(&inv),
            0,
            "BT-3 384 (corrected invoice)",
        );
    }
}
