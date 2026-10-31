//! Supplier and identity criteria (spec 3.6.2).

use super::{finding, known, pair_approved, points, CheckContext, Criterion, Finding};
use crate::config::CriterionCfg;

/// S-1: wallet known, never approved for this supplier.
pub struct S1;

impl Criterion for S1 {
    fn id(&self) -> &'static str {
        "S-1"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let n = known(&ctx.wallet)?;
        if pair_approved(ctx) != 0 {
            return None;
        }
        finding(
            points(cfg),
            format!("wallet approved {n}x, never for this supplier"),
        )
    }
}

/// S-2: VIES says invalid.
pub struct S2;

impl Criterion for S2 {
    fn id(&self) -> &'static str {
        "S-2"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        match ctx.vies.ok() {
            Some(false) => finding(points(cfg), "VIES: invalid"),
            _ => None,
        }
    }
}

/// S-3: supplier known, never approved with this wallet.
pub struct S3;

impl Criterion for S3 {
    fn id(&self) -> &'static str {
        "S-3"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let n = known(&ctx.supplier)?;
        if pair_approved(ctx) != 0 {
            return None;
        }
        finding(
            points(cfg),
            format!("supplier approved {n}x, never with this wallet"),
        )
    }
}

/// S-4: BT-40 on the high-risk country list.
pub struct S4;

impl Criterion for S4 {
    fn id(&self) -> &'static str {
        "S-4"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let cc = ctx.invoice?.seller_country.as_deref()?;
        let list = &ctx.data.high_risk_countries;
        if !list.countries.contains(cc) {
            return None;
        }
        finding(
            points(cfg),
            format!(
                "BT-40 {cc} on high-risk list (as of {})",
                list.as_of.format("%Y-%m-%d")
            ),
        )
    }
}

/// S-7: identity fields changed against the last approved invoice; only fields
/// present on both sides are compared.
pub struct S7;

impl Criterion for S7 {
    fn id(&self) -> &'static str {
        "S-7"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        known(&ctx.supplier)?;
        let last = ctx.last_approved.as_ref()?;
        let h = &ctx.hashes;
        let pairs = [
            ("name", &h.name, &last.name_hash),
            ("email_domain", &h.email_domain, &last.email_domain_hash),
            ("phone", &h.phone, &last.phone_hash),
            ("postal_address", &h.postal, &last.postal_hash),
        ];
        let changed: Vec<&str> = pairs
            .iter()
            .filter_map(|(field, now, before)| match (now, before) {
                (Some(a), Some(b)) if a != b => Some(*field),
                _ => None,
            })
            .collect();
        if changed.is_empty() {
            return None;
        }
        finding(
            points(cfg),
            format!("changed vs last approved invoice: {}", changed.join(", ")),
        )
    }
}

/// S-8: free-mail domain (exact match).
pub struct S8;

impl Criterion for S8 {
    fn id(&self) -> &'static str {
        "S-8"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        let (domain, source) = ctx.email_domain.as_ref()?;
        if !ctx.data.freemail_domains.contains(domain) {
            return None;
        }
        finding(
            points(cfg),
            format!("free-mail domain in {}", source.as_str()),
        )
    }
}

/// S-9: no earlier `invoices` row for this `supplier_hash`.
pub struct S9;

impl Criterion for S9 {
    fn id(&self) -> &'static str {
        "S-9"
    }

    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionCfg) -> Option<Finding> {
        ctx.hashes.supplier.as_ref()?;
        if ctx.previous_invoice_count != 0 {
            return None;
        }
        finding(points(cfg), "no previous invoice from this supplier")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::criteria::testutil::*;
    use crate::criteria::{EmailSource, LastApproved, SourceResult};
    use crate::store::postgres::SubjectType;

    #[test]
    fn s1() {
        let mut c = ctx();
        assert_eq!(eval(&S1, &c), None);
        c.wallet = Some(subject(SubjectType::Wallet, 6, "0.545"));
        fired(&S1, &c, 35, "wallet approved 6x, never for this supplier");
        c.pair = Some(subject(SubjectType::Pair, 1, "0.167"));
        assert_eq!(eval(&S1, &c), None);
        // A pair entry with 0 approvals counts as 0.
        c.pair = Some(subject(SubjectType::Pair, 0, "-0.375"));
        fired(&S1, &c, 35, "wallet approved 6x, never for this supplier");
        // Wallet entry without approvals is not "bekannt".
        c.wallet = Some(subject(SubjectType::Wallet, 0, "0"));
        assert_eq!(eval(&S1, &c), None);
    }

    #[test]
    fn s2() {
        let mut c = ctx();
        for r in [
            SourceResult::Ok(true),
            SourceResult::Unavailable,
            SourceResult::Skipped,
            SourceResult::NotApplicable,
        ] {
            c.vies = r;
            assert_eq!(eval(&S2, &c), None);
        }
        c.vies = SourceResult::Ok(false);
        fired(&S2, &c, 35, "VIES: invalid");
    }

    #[test]
    fn s3() {
        let mut c = ctx();
        assert_eq!(eval(&S3, &c), None);
        c.supplier = Some(subject(SubjectType::Supplier, 6, "0.545"));
        fired(&S3, &c, 25, "supplier approved 6x, never with this wallet");
        c.pair = Some(subject(SubjectType::Pair, 6, "0.545"));
        assert_eq!(eval(&S3, &c), None);
    }

    #[test]
    fn s4() {
        let mut inv = f1();
        let c = ctx().with_invoice(&inv);
        assert_eq!(eval(&S4, &c), None);
        inv.seller_country = Some("IR".into());
        let c = ctx().with_invoice(&inv);
        fired(&S4, &c, 15, "BT-40 IR on high-risk list (as of 2026-06-19)");
    }

    fn last(name: &str, email: Option<&str>, phone: Option<&str>, postal: &str) -> LastApproved {
        LastApproved {
            name_hash: Some(name.into()),
            email_domain_hash: email.map(String::from),
            phone_hash: phone.map(String::from),
            postal_hash: Some(postal.into()),
        }
    }

    #[test]
    fn s7_compares_only_fields_present_in_both() {
        let mut c = ctx();
        c.supplier = Some(subject(SubjectType::Supplier, 6, "0.545"));
        c.hashes.name = Some("n1".into());
        c.hashes.email_domain = Some("e1".into());
        c.hashes.phone = None;
        c.hashes.postal = Some("p1".into());
        assert_eq!(eval(&S7, &c), None, "no last approved invoice");
        c.last_approved = Some(last("n1", Some("e1"), Some("ph-old"), "p1"));
        assert_eq!(eval(&S7, &c), None, "phone missing now: not compared");
        c.last_approved = Some(last("n1", Some("e2"), None, "p1"));
        fired(
            &S7,
            &c,
            10,
            "changed vs last approved invoice: email_domain",
        );
    }

    #[test]
    fn s7_multiple_fields_in_order() {
        let mut c = ctx();
        c.supplier = Some(subject(SubjectType::Supplier, 2, "0.286"));
        c.hashes.name = Some("n1".into());
        c.hashes.email_domain = Some("e1".into());
        c.hashes.phone = Some("ph1".into());
        c.hashes.postal = Some("p1".into());
        c.last_approved = Some(last("n0", Some("e1"), Some("ph0"), "p0"));
        fired(
            &S7,
            &c,
            10,
            "changed vs last approved invoice: name, phone, postal_address",
        );
        // Supplier not "bekannt" → no S-7.
        c.supplier = None;
        assert_eq!(eval(&S7, &c), None);
    }

    #[test]
    fn s8() {
        let mut inv = f1();
        let c = ctx().with_invoice(&inv);
        assert_eq!(eval(&S8, &c), None);
        inv.seller_email = Some("Max.Muster@GMX.de".into());
        let c = ctx().with_invoice(&inv);
        fired(&S8, &c, 5, "free-mail domain in BT-43");
        // Without BT-43 the domain comes from BT-34 (schemeID EM).
        inv.seller_email = None;
        inv.seller_electronic_address.as_mut().unwrap().value = "x@gmail.com".into();
        let c = ctx().with_invoice(&inv);
        assert_eq!(
            c.email_domain,
            Some(("gmail.com".to_string(), EmailSource::Bt34))
        );
        fired(&S8, &c, 5, "free-mail domain in BT-34");
        // Exact comparison: a subdomain is not on the list.
        inv.seller_email = Some("a@mail.gmail.com".into());
        let c = ctx().with_invoice(&inv);
        assert_eq!(eval(&S8, &c), None);
    }

    #[test]
    fn s9() {
        let mut c = ctx();
        c.hashes.supplier = Some("hmac:s".into());
        fired(&S9, &c, 5, "no previous invoice from this supplier");
        c.previous_invoice_count = 1;
        assert_eq!(eval(&S9, &c), None);
    }
}
