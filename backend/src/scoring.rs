//! Score, reducers, band, decline reasons, agent tasks (spec 3.8).
//!
//! Consumes a neutral list of fired criteria so it does not depend on how the
//! criteria are evaluated. Kinds, names, agents and texts come from the config;
//! IDs are free strings and only the IDs the spec names explicitly (I-12, KO-3)
//! are matched literally.

use std::collections::BTreeSet;

use crate::config::{Criteria, CriterionCfg, Kind, ReasonType};
use crate::model::{
    AgentTask, AgentTasks, Band, CriterionOut, Decision, DeclineReason, FinalDecision, ReducerOut,
};

/// Band rule 4: a corrected invoice forces at least Medium.
pub const CORRECTED_INVOICE_ID: &str = "I-12";
/// Duplicate K.O.: never creates an `invoices` row (3.5 step 12).
pub const DUPLICATE_KO_ID: &str = "KO-3";
/// Band rule 5: these `checks_incomplete` codes force at least Medium.
pub const MEDIUM_INCOMPLETE_CODES: [&str; 4] = [
    "MUSTANG_UNAVAILABLE",
    "BLOCKFROST_UNAVAILABLE",
    "SANCTIONS_LIST_STALE",
    "CURRENCY_NOT_EUR",
];
/// Evidence suffix of a reducer applied after the budget ran out.
pub const CAP_REACHED_SUFFIX: &str = " (cap reached)";

/// A criterion that fired (K.O., score or reducer), as produced by the evaluation.
/// For score criteria `points` is the evaluated value (W-2 tiers); for K.O. it is
/// replaced by `ko_points`; for reducers it is the configured negative value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fired {
    pub id: String,
    pub points: i32,
    pub evidence: String,
}

impl Fired {
    pub fn new(id: impl Into<String>, points: i32, evidence: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            points,
            evidence: evidence.into(),
        }
    }
}

/// Everything 3.8 decides; the result JSON takes these fields unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreOutcome {
    pub band: Band,
    pub decision: Decision,
    pub is_final: bool,
    pub reason_type: Option<ReasonType>,
    pub risk_score: i32,
    pub ko_triggered: bool,
    /// IDs of the fired K.O. criteria in catalog order.
    pub ko_ids: Vec<String>,
    pub decline_reasons: Vec<DeclineReason>,
    /// Alphabetical, unique.
    pub checks_incomplete: Vec<String>,
    /// Sorted by points descending, ties in catalog order.
    pub criteria: Vec<CriterionOut>,
    /// T-1 … T-4 order (catalog order); empty when reducers are blocked.
    pub reducers: Vec<ReducerOut>,
    pub agent_tasks: AgentTasks,
}

/// Outcome of 3.5 step 12 for the `invoices` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvoiceRow {
    /// No `invoices` row, no counter changes.
    None,
    /// Row with these decision columns (`None` = Medium, still open).
    Insert {
        final_decision: Option<FinalDecision>,
        final_reason_type: Option<ReasonType>,
    },
}

impl ScoreOutcome {
    /// 3.5 step 12 table. `all_hashes` = `invoice_hash`, `supplier_hash`,
    /// `wallet_hash`, `pair_hash` and `name_hash` are all present.
    pub fn invoice_row(&self, all_hashes: bool) -> InvoiceRow {
        if !all_hashes {
            return InvoiceRow::None;
        }
        if self.ko_triggered {
            let duplicate = self.ko_ids.iter().any(|id| id == DUPLICATE_KO_ID);
            if duplicate || self.reason_type != Some(ReasonType::Risk) {
                return InvoiceRow::None;
            }
        }
        let (final_decision, final_reason_type) = match self.band {
            Band::Low => (Some(FinalDecision::Approved), None),
            Band::Medium => (None, None),
            Band::High => (Some(FinalDecision::Rejected), Some(ReasonType::Risk)),
        };
        InvoiceRow::Insert {
            final_decision,
            final_reason_type,
        }
    }
}

/// Spec 3.8 steps 1–9. `fired` holds K.O., score and reducer findings; `incomplete`
/// the `checks_incomplete` codes in any order. Requires a config that passed
/// [`Criteria::validate`]; findings with an ID missing from the config are ignored.
pub fn score(fired: &[Fired], incomplete: &[String], cfg: &Criteria) -> ScoreOutcome {
    // Resolve config entries and keep catalog order.
    let mut resolved: Vec<(usize, &CriterionCfg, &Fired)> = fired
        .iter()
        .filter_map(|f| {
            let pos = cfg.criteria.iter().position(|c| c.id == f.id);
            if pos.is_none() {
                tracing::error!(criterion = %f.id, "fired criterion has no config entry");
            }
            pos.map(|i| (i, &cfg.criteria[i], f))
        })
        .collect();
    resolved.sort_by_key(|(i, _, _)| *i);

    let kos: Vec<_> = resolved
        .iter()
        .filter(|(_, c, _)| c.kind == Kind::Ko)
        .collect();
    let ko_triggered = !kos.is_empty();

    // Step 1: points; criteria entries (K.O. and score) in catalog order.
    let mut criteria: Vec<(usize, &CriterionCfg, CriterionOut)> = Vec::new();
    for (i, c, f) in &resolved {
        if c.kind == Kind::Reducer {
            continue;
        }
        let Some(agent) = c.agent else {
            tracing::error!(criterion = %c.id, "criterion has no agent in config");
            continue;
        };
        let points = if c.kind == Kind::Ko {
            cfg.ko_points
        } else {
            f.points
        };
        criteria.push((
            *i,
            c,
            CriterionOut {
                id: c.id.clone(),
                name: c.name.clone(),
                points,
                evidence: f.evidence.clone(),
                agent,
            },
        ));
    }

    // Step 2: reducers with budget.
    let blocked = ko_triggered
        || criteria
            .iter()
            .any(|(_, _, o)| o.points >= cfg.reducers_blocked_by_points);
    let mut reducers = Vec::new();
    if !blocked {
        let mut rest = cfg.reducer_cap.max(0);
        for (_, c, f) in resolved.iter().filter(|(_, c, _)| c.kind == Kind::Reducer) {
            let take = f.points.unsigned_abs().min(rest as u32) as i32;
            rest -= take;
            let evidence = if take == 0 {
                format!("{}{CAP_REACHED_SUFFIX}", f.evidence)
            } else {
                f.evidence.clone()
            };
            reducers.push(ReducerOut {
                id: c.id.clone(),
                name: c.name.clone(),
                points: -take,
                evidence,
            });
        }
    }

    // Step 3: score.
    let sum: i64 = criteria
        .iter()
        .map(|(_, _, o)| i64::from(o.points))
        .chain(reducers.iter().map(|r| i64::from(r.points)))
        .sum();
    let risk_score = sum.clamp(0, 100) as i32;

    // Step 7 (needed by band rule 5): incomplete codes alphabetical, unique.
    let checks_incomplete: Vec<String> = incomplete
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    // Step 4: band, first matching rule.
    let corrected = criteria
        .iter()
        .any(|(_, _, o)| o.id == CORRECTED_INVOICE_ID);
    let medium_incomplete = checks_incomplete
        .iter()
        .any(|c| MEDIUM_INCOMPLETE_CODES.contains(&c.as_str()));
    let by_score_high = !ko_triggered && risk_score >= cfg.bands.high_min;
    let band = if ko_triggered || by_score_high {
        Band::High
    } else if risk_score >= cfg.bands.medium_min || corrected || medium_incomplete {
        Band::Medium
    } else {
        Band::Low
    };

    // Step 5.
    let (decision, is_final) = match band {
        Band::Low => (Decision::Approve, true),
        Band::Medium => (Decision::Review, false),
        Band::High => (Decision::Decline, true),
    };

    // Step 6.
    let reason_type = (band == Band::High).then(|| {
        let ko_risk = kos
            .iter()
            .any(|(_, c, _)| c.reason_type == Some(ReasonType::Risk));
        if ko_risk || by_score_high {
            ReasonType::Risk
        } else {
            ReasonType::Formal
        }
    });

    // Step 7: criteria by points descending, ties in catalog order (stable sort).
    criteria.sort_by(|(ia, _, a), (ib, _, b)| b.points.cmp(&a.points).then(ia.cmp(ib)));

    // Step 8.
    let decline = |c: &CriterionCfg, evidence: &str| DeclineReason {
        id: c.id.clone(),
        text: c.customer_text.clone().unwrap_or_default(),
        evidence: evidence.to_string(),
    };
    let decline_reasons = match band {
        Band::High if ko_triggered => kos
            .iter()
            .map(|(_, c, f)| decline(c, &f.evidence))
            .collect(),
        Band::High => criteria
            .iter()
            .filter(|(_, _, o)| o.points > 0)
            .take(3)
            .map(|(_, c, o)| decline(c, &o.evidence))
            .collect(),
        _ => Vec::new(),
    };

    // Step 9.
    let mut agent_tasks = AgentTasks::default();
    if band == Band::Medium {
        for (_, c, o) in &criteria {
            if let Some(task) = &c.agent_task {
                agent_tasks.list_mut(o.agent).push(AgentTask {
                    source: o.id.clone(),
                    task: task.clone(),
                });
            }
        }
        for code in &checks_incomplete {
            if let Some(t) = cfg.incomplete_tasks.get(code) {
                agent_tasks.list_mut(t.agent).push(AgentTask {
                    source: code.clone(),
                    task: t.task.clone(),
                });
            }
        }
    }

    ScoreOutcome {
        band,
        decision,
        is_final,
        reason_type,
        risk_score,
        ko_triggered,
        ko_ids: kos.iter().map(|(_, c, _)| c.id.clone()).collect(),
        decline_reasons,
        checks_incomplete,
        criteria: criteria.into_iter().map(|(_, _, o)| o).collect(),
        reducers,
        agent_tasks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Agent;

    fn cfg() -> Criteria {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/criteria.json");
        Criteria::load_file(&path).unwrap().0
    }

    fn f(id: &str, points: i32, evidence: &str) -> Fired {
        Fired::new(id, points, evidence)
    }

    /// F1 reducers (test 1): T-1 … T-4 all fire.
    fn f1_reducers() -> Vec<Fired> {
        vec![
            f("T-1", -15, "wallet trust 0.538"),
            f("T-2", -10, "pair approved 6x"),
            f("T-3", -10, "BT-13 matches an open order of this supplier"),
            f("T-4", -5, "VIES: valid"),
        ]
    }

    fn with_f1_reducers(mut v: Vec<Fired>) -> Vec<Fired> {
        v.extend(f1_reducers());
        v
    }

    fn ids(c: &[CriterionOut]) -> Vec<(&str, i32)> {
        c.iter().map(|c| (c.id.as_str(), c.points)).collect()
    }

    fn reducer_points(r: &[ReducerOut]) -> Vec<(&str, i32)> {
        r.iter().map(|r| (r.id.as_str(), r.points)).collect()
    }

    fn sources(t: &[AgentTask]) -> Vec<&str> {
        t.iter().map(|t| t.source.as_str()).collect()
    }

    fn codes(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn assert_no_lists(o: &ScoreOutcome) {
        assert!(o.decline_reasons.is_empty());
        assert!(o.agent_tasks.is_empty());
    }

    #[test]
    fn test1_no_criteria_reducers_capped_low() {
        let o = score(&f1_reducers(), &[], &cfg());
        assert!(o.criteria.is_empty());
        assert_eq!(
            reducer_points(&o.reducers),
            [("T-1", -15), ("T-2", -10), ("T-3", 0), ("T-4", 0)]
        );
        assert_eq!(o.reducers[0].evidence, "wallet trust 0.538");
        assert_eq!(o.reducers[0].name, "Trusted wallet");
        assert_eq!(
            o.reducers[2].evidence,
            "BT-13 matches an open order of this supplier (cap reached)"
        );
        assert_eq!(o.reducers[3].evidence, "VIES: valid (cap reached)");
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Low);
        assert_eq!(o.decision, Decision::Approve);
        assert!(o.is_final);
        assert_eq!(o.reason_type, None);
        assert!(!o.ko_triggered);
        assert_no_lists(&o);
        assert_eq!(
            o.invoice_row(true),
            InvoiceRow::Insert {
                final_decision: Some(FinalDecision::Approved),
                final_reason_type: None
            }
        );
    }

    #[test]
    fn test7_corrected_invoice_forces_medium() {
        let fired = with_f1_reducers(vec![f("I-12", 0, "BT-3 384 (corrected invoice)")]);
        let o = score(&fired, &[], &cfg());
        assert_eq!(ids(&o.criteria), [("I-12", 0)]);
        assert_eq!(o.reducers.iter().map(|r| r.points).sum::<i32>(), -25);
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(o.decision, Decision::Review);
        assert!(!o.is_final);
        assert_eq!(sources(&o.agent_tasks.invoice), ["I-12"]);
        assert!(o.agent_tasks.wallet.is_empty() && o.agent_tasks.research.is_empty());
        assert!(o.decline_reasons.is_empty());
        assert_eq!(
            o.invoice_row(true),
            InvoiceRow::Insert {
                final_decision: None,
                final_reason_type: None
            }
        );
    }

    #[test]
    fn test9_matches_spec4_example() {
        let fired = vec![
            f("S-3", 25, "supplier approved 6x, never with this wallet"),
            f(
                "W-2",
                15,
                "first transaction 2026-10-27, 3 days before check",
            ),
            f("I-5", 10, "pressure wording: dringend, neue wallet"),
            f("I-7", 8, "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)"),
            // F9 still has T-3/T-4; S-3 ≥ 25 blocks all reducers.
            f("T-3", -10, "BT-13 matches an open order of this supplier"),
            f("T-4", -5, "VIES: valid"),
        ];
        let o = score(&fired, &[], &cfg());
        assert_eq!(
            ids(&o.criteria),
            [("S-3", 25), ("W-2", 15), ("I-5", 10), ("I-7", 8)]
        );
        assert!(o.reducers.is_empty());
        assert_eq!(o.risk_score, 58);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(o.reason_type, None);

        let criteria = serde_json::to_value(&o.criteria).unwrap();
        assert_eq!(
            criteria,
            serde_json::json!([
              { "id": "S-3", "name": "Known supplier, new wallet", "points": 25, "evidence": "supplier approved 6x, never with this wallet", "agent": "wallet" },
              { "id": "W-2", "name": "Young address", "points": 15, "evidence": "first transaction 2026-10-27, 3 days before check", "agent": "wallet" },
              { "id": "I-5", "name": "Pressure wording", "points": 10, "evidence": "pressure wording: dringend, neue wallet", "agent": "invoice" },
              { "id": "I-7", "name": "Due date < 3 days", "points": 8, "evidence": "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)", "agent": "invoice" }
            ])
        );
        assert_eq!(
            serde_json::to_value(&o.agent_tasks).unwrap(),
            serde_json::json!({
              "invoice": [
                { "source": "I-5", "task": "Prüfe, warum die Rechnung zu schneller Zahlung drängt." },
                { "source": "I-7", "task": "Prüfe, ob ein Zahlungsziel unter 3 Tagen mit dem Rechnungssteller vereinbart ist." }
              ],
              "wallet": [
                { "source": "S-3", "task": "Prüfe, ob der Rechnungssteller die neue Zahlungsadresse über einen unabhängigen, bereits bekannten Kanal bestätigt hat." },
                { "source": "W-2", "task": "Prüfe, warum eine sehr neue Zahlungsadresse verwendet wird." }
              ],
              "research": []
            })
        );
    }

    #[test]
    fn test10_high_by_score_decline_reasons() {
        // Catalog order input; sorting must yield S-1, I-5, I-7, I-8, S-9.
        let fired = vec![
            f("S-1", 35, "wallet approved 6x, never for this supplier"),
            f("S-9", 5, "no previous invoice from this supplier"),
            f("I-5", 10, "pressure wording: dringend"),
            f("I-7", 8, "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)"),
            f("I-8", 8, "BT-13 empty"),
            f("T-1", -15, "wallet trust 0.538"),
            f("T-4", -5, "VIES: valid"),
        ];
        let o = score(&fired, &[], &cfg());
        assert_eq!(
            ids(&o.criteria),
            [("S-1", 35), ("I-5", 10), ("I-7", 8), ("I-8", 8), ("S-9", 5)]
        );
        assert!(o.reducers.is_empty());
        assert_eq!(o.risk_score, 66);
        assert_eq!(o.band, Band::High);
        assert_eq!(o.decision, Decision::Decline);
        assert!(o.is_final);
        assert_eq!(o.reason_type, Some(ReasonType::Risk));
        assert!(o.agent_tasks.is_empty());
        assert_eq!(
            o.decline_reasons,
            [
                DeclineReason {
                    id: "S-1".into(),
                    text: "Die Zahlungsadresse wurde bisher für einen anderen Rechnungssteller verwendet."
                        .into(),
                    evidence: "wallet approved 6x, never for this supplier".into(),
                },
                DeclineReason {
                    id: "I-5".into(),
                    text: "Die Rechnung enthält Formulierungen, die zu schneller Zahlung drängen."
                        .into(),
                    evidence: "pressure wording: dringend".into(),
                },
                DeclineReason {
                    id: "I-7".into(),
                    text: "Das Zahlungsziel ist kürzer als 3 Tage.".into(),
                    evidence: "BT-2 2026-10-28, BT-9 2026-10-30 (2 days)".into(),
                },
            ]
        );
        assert_eq!(
            o.invoice_row(true),
            InvoiceRow::Insert {
                final_decision: Some(FinalDecision::Rejected),
                final_reason_type: Some(ReasonType::Risk)
            }
        );
    }

    #[test]
    fn test11_medium_with_t4_reducer() {
        let fired = vec![
            f("S-8", 5, "free-mail domain in BT-43"),
            f("S-9", 5, "no previous invoice from this supplier"),
            f("W-4", 10, "no transactions on this address"),
            f(
                "I-2",
                20,
                "amount 2000.00 EUR > limit 1000.00 EUR (wallet trust 0.0)",
            ),
            f("I-8", 8, "BT-13 empty"),
            f("I-10", 5, "amount 2000.00 EUR is a multiple of 100.00 EUR"),
            f("T-4", -5, "VIES: valid"),
        ];
        let o = score(&fired, &[], &cfg());
        assert_eq!(
            ids(&o.criteria),
            [
                ("I-2", 20),
                ("W-4", 10),
                ("I-8", 8),
                ("S-8", 5),
                ("S-9", 5),
                ("I-10", 5)
            ]
        );
        assert_eq!(reducer_points(&o.reducers), [("T-4", -5)]);
        assert_eq!(o.risk_score, 48);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(sources(&o.agent_tasks.invoice), ["I-2", "I-8", "I-10"]);
        assert_eq!(sources(&o.agent_tasks.wallet), ["W-4"]);
        // S-8 and S-9 belong to the Supplier Investigator.
        assert_eq!(sources(&o.agent_tasks.research), ["S-8", "S-9"]);
        assert!(o
            .criteria
            .iter()
            .filter(|c| c.id.starts_with("S-"))
            .all(|c| c.agent == Agent::Research));
    }

    #[test]
    fn test12_blockfrost_unavailable_forces_medium() {
        let o = score(&f1_reducers(), &codes(&["BLOCKFROST_UNAVAILABLE"]), &cfg());
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(o.checks_incomplete, ["BLOCKFROST_UNAVAILABLE"]);
        assert_eq!(sources(&o.agent_tasks.wallet), ["BLOCKFROST_UNAVAILABLE"]);
        assert_eq!(
            o.agent_tasks.wallet[0].task,
            "Prüfe Alter und Nutzung der Zahlungsadresse; die On-Chain-Abfrage war nicht verfügbar."
        );
        assert!(o.agent_tasks.invoice.is_empty() && o.agent_tasks.research.is_empty());
    }

    #[test]
    fn test15_pressure_wording_still_low() {
        let fired = with_f1_reducers(vec![f("I-5", 10, "pressure wording: heute noch")]);
        let o = score(&fired, &[], &cfg());
        assert_eq!(ids(&o.criteria), [("I-5", 10)]);
        assert_eq!(o.reducers.iter().map(|r| r.points).sum::<i32>(), -25);
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Low);
        assert_no_lists(&o);
    }

    #[test]
    fn test20_trusted_chainabuse_blocks_reducers() {
        let fired = with_f1_reducers(vec![f(
            "W-1",
            30,
            "chainabuse: 1 report(s), 1 trusted or checked",
        )]);
        let o = score(&fired, &[], &cfg());
        assert_eq!(ids(&o.criteria), [("W-1", 30)]);
        assert!(o.reducers.is_empty());
        assert_eq!(o.risk_score, 30);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(sources(&o.agent_tasks.wallet), ["W-1"]);
    }

    #[test]
    fn test21_unverified_chainabuse_low() {
        let fired = with_f1_reducers(vec![f("W-6", 10, "chainabuse: 1 unverified report(s)")]);
        let o = score(&fired, &[], &cfg());
        assert_eq!(ids(&o.criteria), [("W-6", 10)]);
        assert_eq!(o.reducers.iter().map(|r| r.points).sum::<i32>(), -25);
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Low);
        assert_no_lists(&o);
    }

    #[test]
    fn test24_currency_not_eur_forces_medium() {
        let o = score(&f1_reducers(), &codes(&["CURRENCY_NOT_EUR"]), &cfg());
        assert_eq!(o.risk_score, 0);
        assert_eq!(o.band, Band::Medium);
        assert_eq!(sources(&o.agent_tasks.invoice), ["CURRENCY_NOT_EUR"]);
    }

    #[test]
    fn other_incomplete_codes_do_not_force_medium() {
        let o = score(
            &f1_reducers(),
            &codes(&["VIES_UNAVAILABLE", "CHAINABUSE_UNAVAILABLE"]),
            &cfg(),
        );
        assert_eq!(o.band, Band::Low);
        assert_eq!(
            o.checks_incomplete,
            ["CHAINABUSE_UNAVAILABLE", "VIES_UNAVAILABLE"]
        );
        assert_no_lists(&o);
    }

    #[test]
    fn incomplete_tasks_follow_criteria_alphabetically() {
        let fired = vec![f(
            "W-1",
            30,
            "chainabuse: 1 report(s), 1 trusted or checked",
        )];
        let incomplete = codes(&[
            "VIES_UNAVAILABLE",
            "SANCTIONS_LIST_STALE",
            "BLOCKFROST_UNAVAILABLE",
            "VIES_UNAVAILABLE",
        ]);
        let o = score(&fired, &incomplete, &cfg());
        assert_eq!(
            o.checks_incomplete,
            [
                "BLOCKFROST_UNAVAILABLE",
                "SANCTIONS_LIST_STALE",
                "VIES_UNAVAILABLE"
            ]
        );
        assert_eq!(
            sources(&o.agent_tasks.wallet),
            ["W-1", "BLOCKFROST_UNAVAILABLE"]
        );
        assert_eq!(
            sources(&o.agent_tasks.research),
            ["SANCTIONS_LIST_STALE", "VIES_UNAVAILABLE"]
        );
    }

    #[test]
    fn ko1_only_is_high_formal() {
        let fired = with_f1_reducers(vec![f("KO-1", 0, "MISSING_FIELD:BT-84")]);
        let o = score(&fired, &[], &cfg());
        assert!(o.ko_triggered);
        assert_eq!(ids(&o.criteria), [("KO-1", 100)]);
        assert_eq!(o.criteria[0].agent, Agent::Invoice);
        assert!(o.reducers.is_empty());
        assert_eq!(o.risk_score, 100);
        assert_eq!(o.band, Band::High);
        assert_eq!(o.reason_type, Some(ReasonType::Formal));
        assert_eq!(
            o.decline_reasons,
            [DeclineReason {
                id: "KO-1".into(),
                text: "Die Rechnung ist formal ungültig oder unvollständig und kann nicht verarbeitet werden."
                    .into(),
                evidence: "MISSING_FIELD:BT-84".into(),
            }]
        );
        assert!(o.agent_tasks.is_empty());
        assert_eq!(o.invoice_row(true), InvoiceRow::None);
    }

    #[test]
    fn ko6_is_high_risk() {
        let o = score(
            &[f("KO-6", 100, "wallet blocked (TEST_INTERNAL)")],
            &[],
            &cfg(),
        );
        assert_eq!(o.band, Band::High);
        assert_eq!(o.reason_type, Some(ReasonType::Risk));
        assert_eq!(o.ko_ids, ["KO-6"]);
        assert_eq!(o.decline_reasons.len(), 1);
        assert_eq!(
            o.decline_reasons[0].evidence,
            "wallet blocked (TEST_INTERNAL)"
        );
        assert_eq!(
            o.invoice_row(true),
            InvoiceRow::Insert {
                final_decision: Some(FinalDecision::Rejected),
                final_reason_type: Some(ReasonType::Risk)
            }
        );
        assert_eq!(o.invoice_row(false), InvoiceRow::None);
    }

    #[test]
    fn multiple_kos_listed_in_catalog_order_and_duplicate_has_no_row() {
        let fired = vec![
            f("KO-6", 100, "supplier blocked (TEST)"),
            f("KO-3", 100, "duplicate of chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W"),
            f("KO-1", 100, "MUSTANG:BR-DE-15"),
        ];
        let o = score(&fired, &codes(&["MUSTANG_UNAVAILABLE"]), &cfg());
        assert_eq!(o.ko_ids, ["KO-1", "KO-3", "KO-6"]);
        assert_eq!(
            o.decline_reasons
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["KO-1", "KO-3", "KO-6"]
        );
        assert_eq!(o.risk_score, 100);
        assert_eq!(o.reason_type, Some(ReasonType::Risk));
        assert!(o.agent_tasks.is_empty());
        assert_eq!(o.invoice_row(true), InvoiceRow::None);
    }

    #[test]
    fn ko_identified_by_kind_not_id() {
        let mut c = cfg();
        let ko = c.criteria.iter_mut().find(|c| c.id == "KO-2").unwrap();
        ko.id = "ADDR".into();
        let o = score(&[f("ADDR", 0, "NETWORK_MISMATCH")], &[], &c);
        assert!(o.ko_triggered);
        assert_eq!(o.risk_score, 100);
        assert_eq!(o.reason_type, Some(ReasonType::Formal));
        assert_eq!(o.decline_reasons[0].id, "ADDR");
    }

    #[test]
    fn decline_reasons_skip_zero_point_criteria() {
        let fired = vec![
            f("S-1", 35, "a"),
            f("S-2", 35, "b"),
            f("I-12", 0, "BT-3 384 (corrected invoice)"),
        ];
        let o = score(&fired, &[], &cfg());
        assert_eq!(o.band, Band::High);
        assert_eq!(o.risk_score, 70);
        assert_eq!(
            o.decline_reasons
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["S-1", "S-2"]
        );
    }

    #[test]
    fn score_is_clamped_to_100() {
        let fired = vec![
            f("S-1", 35, "a"),
            f("S-2", 35, "b"),
            f("S-3", 25, "c"),
            f("W-1", 30, "d"),
        ];
        let o = score(&fired, &[], &cfg());
        assert_eq!(o.risk_score, 100);
        assert_eq!(o.reason_type, Some(ReasonType::Risk));
    }

    #[test]
    fn unknown_ids_are_ignored() {
        let o = score(&[f("X-99", 50, "x")], &[], &cfg());
        assert!(o.criteria.is_empty());
        assert_eq!(o.band, Band::Low);
    }
}
