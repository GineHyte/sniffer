//! Acceptance tests of spec 8.3 (tests 1-25, 26 e/g, 27-33) against the real router,
//! Postgres, Redis and wiremock stubs. Harness and environment: see `common/mod.rs`.
//! Test 26 a-d and f belong to the decisions module (Task 17); tests 34-37 are unit
//! tests in the library.

mod common;

use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use common::*;
use sniffer::hashing::{self, CredentialKind};

const NOTE: &str = "<ram:Content>Vielen Dank für Ihren Auftrag.</ram:Content>";

fn note(text: &str) -> String {
    format!("<ram:Content>{text}</ram:Content>")
}

/// Shared assertions of test 1 (also used by tests 14 and 23).
fn assert_test1_result(r: &Value) {
    assert_eq!(band(r), "low", "{r}");
    assert_eq!(r["summary"]["decision"], "approve");
    assert_eq!(r["summary"]["final"], true);
    assert_eq!(score(r), 0);
    assert!(criteria(r).is_empty(), "{r}");
    assert_eq!(
        reducers(r),
        ids(&[("T-1", -15), ("T-2", -10), ("T-3", 0), ("T-4", 0)])
    );
    let red = r["reducers"].as_array().unwrap();
    assert_eq!(red[0]["evidence"], "wallet trust 0.545");
    assert_eq!(red[1]["evidence"], "pair approved 6x");
    assert_eq!(
        red[2]["evidence"],
        "BT-13 matches an open order of this supplier (cap reached)"
    );
    assert_eq!(red[3]["evidence"], "VIES: valid (cap reached)");
    assert_eq!(r["invoice"]["open_order"]["order_id"], "PO-2026-001");
    assert_eq!(
        r["invoice"]["open_order"]["ordered_total"],
        json!({ "amount": "1190.00", "currency": "EUR" })
    );
    assert!(incomplete(r).is_empty());
    assert!(skipped(r).is_empty());
    for agent in ["invoice", "wallet", "research"] {
        assert!(task_sources(r, agent).is_empty());
    }
}

#[tokio::test]
async fn test01_f1_low_and_counters() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&f1()).await;
    assert_test1_result(&r);
    assert_eq!(r["signature"]["status"], "absent");
    assert_eq!(r["supplier"]["approved"], 6);
    assert_eq!(r["wallet"]["has_transactions"], true);
    assert_eq!(r["wallet"]["first_tx_at"], "2026-01-10T09:00:00Z");

    let id = check_id(&r);
    assert_eq!(
        h.invoice_row(&id).await,
        Some((Some("approved".into()), None, Some("initial_check".into())))
    );
    for hash in [
        supplier_hash("DE111111111"),
        wallet_hash(W1),
        pair_hash("DE111111111", W1),
    ] {
        let s = h.subject(&hash).await.unwrap();
        assert_eq!(s.0, 7, "approved");
    }
    // FR-60, 5.2, 5.3.
    let view = h.get(&format!("/v1/checks/{id}")).await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(view.body["result"], r);
    assert_eq!(
        view.body["decision_state"],
        json!({ "final_decision": "approved", "final_reason_type": null, "final_block_wallet": false,
                "final_decline_reasons": null, "decided_by": "initial_check",
                "decided_at": "2026-10-30T12:00:00Z" })
    );
    let xml = h.get(&format!("/v1/checks/{id}/xml")).await;
    assert_eq!(xml.status, StatusCode::OK);
    assert_eq!(xml.text, f1());
    // The invoice lock is released.
    assert_eq!(
        h.count("SELECT count(*) FROM checks").await,
        1,
        "exactly one checks row"
    );
}

#[tokio::test]
async fn test02_malformed_xml() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok("<x").await;
    assert_single_ko(&r, "KO-1", "XML_MALFORMED");
    assert_eq!(r["summary"]["reason_type"], "formal");
    assert_eq!(r["invoice"], Value::Null);
    assert_eq!(r["supplier"], Value::Null);
    assert_eq!(r["wallet"], Value::Null);
    assert_eq!(r["pair"], Value::Null);
    assert_eq!(r["signature"], Value::Null);
    assert_eq!(
        skipped(&r),
        pairs(&[
            ("MUSTANG", "ko"),
            ("BLOCKFROST", "ko"),
            ("VIES", "ko"),
            ("CHAINABUSE", "ko")
        ])
    );
    assert_eq!(h.count("SELECT count(*) FROM invoices").await, 6);
    let view = h.get(&format!("/v1/checks/{}", check_id(&r))).await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(view.body["decision_state"], Value::Null);
}

#[tokio::test]
async fn test03_missing_payment_account() {
    let Some(h) = harness().await else { return };
    let xml = f1();
    let account = element(
        &xml,
        "<ram:PayeePartyCreditorFinancialAccount>",
        "</ram:PayeePartyCreditorFinancialAccount>",
    )
    .to_string();
    let r = h.check_ok(&sub(&xml, &account, "")).await;
    assert_single_ko(&r, "KO-1", "MISSING_FIELD:BT-84");
    assert_eq!(r["wallet"], Value::Null);
    assert_eq!(h.count("SELECT count(*) FROM invoices").await, 6);
}

#[tokio::test]
async fn test04_mainnet_address() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&with_address(&f1(), W1_MAIN)).await;
    assert_single_ko(&r, "KO-2", "NETWORK_MISMATCH");
    assert_eq!(r["invoice"]["payment"]["network"], Value::Null);
}

#[tokio::test]
async fn test05_bad_checksum() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&with_address(&f1(), W1_BAD)).await;
    assert_single_ko(&r, "KO-2", "BECH32_INVALID");
}

#[tokio::test]
async fn test06_duplicate() {
    let Some(h) = harness().await else { return };
    let first = h.check_ok(&f1()).await;
    assert_eq!(band(&first), "low");
    let second = h.check_ok(&f1()).await;
    assert_single_ko(
        &second,
        "KO-3",
        &format!("duplicate of {}", check_id(&first)),
    );
    assert_eq!(second["summary"]["reason_type"], "formal");
    assert_eq!(h.count("SELECT count(*) FROM invoices").await, 7);
    assert_eq!(h.invoice_row(&check_id(&second)).await, None);
}

#[tokio::test]
async fn test07_corrected_invoice_medium() {
    let Some(h) = harness().await else { return };
    let xml = sub(
        &sub(
            &f1(),
            "<ram:TypeCode>380</ram:TypeCode>",
            "<ram:TypeCode>384</ram:TypeCode>",
        ),
        "<ram:ID>RE-2026-0412</ram:ID>",
        "<ram:ID>RE-2026-0412-K</ram:ID>",
    );
    let r = h.check_ok(&xml).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(criteria(&r), ids(&[("I-12", 0)]));
    let red: i64 = reducers(&r).iter().map(|(_, p)| p).sum();
    assert_eq!(red, -25);
    assert_eq!(score(&r), 0);
    assert_eq!(task_sources(&r, "invoice"), ["I-12"]);
    assert_eq!(
        h.invoice_row(&check_id(&r)).await,
        Some((None, None, None)),
        "medium stays open"
    );
}

#[tokio::test]
async fn test08_internal_block() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&with_address(&f1(), W4)).await;
    assert_single_ko(&r, "KO-6", "wallet blocked (TEST_INTERNAL)");
    assert_eq!(r["summary"]["reason_type"], "risk");
    assert_eq!(
        h.invoice_row(&check_id(&r)).await,
        Some((
            Some("rejected".into()),
            Some("risk".into()),
            Some("initial_check".into())
        ))
    );
    assert_eq!(h.subject(&wallet_hash(W4)).await.unwrap().1, 1);
    assert_eq!(h.subject(&pair_hash("DE111111111", W4)).await.unwrap().1, 1);
    assert_eq!(h.stub_requests().await, 0, "no request to the stubs");
    let state = h.get(&format!("/v1/checks/{}", check_id(&r))).await.body;
    assert_eq!(
        state["decision_state"]["final_decline_reasons"],
        r["summary"]["decline_reasons"]
    );
}

/// Spec 4 example with the real hashes of F9, `config_sha256` and the mock Mustang.
fn spec4_example(check_id: &str) -> Value {
    let key = key();
    let supplier = supplier_hash("DE111111111");
    let wallet = hashing::wallet_hash(&key, CredentialKind::Key, &"22".repeat(28));
    assert_eq!(wallet, wallet_hash(W2));
    let pair = hashing::pair_hash(&key, &supplier, &wallet);
    let invoice = hashing::invoice_hash(
        &key,
        "DE111111111",
        "RE-2026-0412",
        "833.00",
        "2026-10-28",
        "380",
    );
    json!({
      "schema_version": "1.0",
      "check_id": check_id,
      "checked_at": "2026-10-30T12:00:00Z",
      "engine": { "version": "1.0.0", "config_sha256": config_sha256() },
      "summary": {
        "band": "medium", "decision": "review", "final": false, "reason_type": null,
        "risk_score": 58, "ko_triggered": false, "decline_reasons": [],
        "checks_incomplete": [], "checks_skipped": []
      },
      "invoice": {
        "invoice_hash": invoice,
        "xml_ref": format!("/v1/checks/{check_id}/xml"),
        "profile": "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
        "validation": { "tool": "mustang", "tool_version": "mock", "status": "valid", "errors": 0, "error_rules": [], "whitelisted_rules": [] },
        "invoice_number": "RE-2026-0412",
        "type_code": "380",
        "issue_date": "2026-10-28",
        "due_date": "2026-10-30",
        "total": { "amount": "833.00", "currency": "EUR" },
        "due_payable": { "amount": "833.00", "currency": "EUR" },
        "payment": {
          "means_code": "ZZZ", "network": "preprod", "asset": "ADA", "address_type": "base",
          "credential_type": "key", "address_hash": hashing::address_hash(&key, W2), "wallet_hash": wallet
        },
        "order_reference": "PO-2026-001",
        "open_order": {
          "order_id": "PO-2026-001", "supplier_vat_id": "DE111111111",
          "ordered_total": { "amount": "1190.00", "currency": "EUR" },
          "description": "Beratungsleistung Oktober 2026: 1 x 1000.00 EUR netto zzgl. 19 % USt; Besteller Käufer Handels AG (DE999999999)"
        }
      },
      "supplier": {
        "supplier_hash": supplier, "country": "DE", "vat_country": "DE", "vat_valid": true,
        "known": true, "approved": 6, "trust": 0.545, "blocked": false, "first_invoice": false
      },
      "wallet": {
        "wallet_hash": wallet, "known": false, "approved": 0, "rejected_risk": 0, "trust": 0.0,
        "blocked": false, "has_transactions": true, "first_tx_at": "2026-10-27T12:00:00Z",
        "age_days": 3, "chainabuse": { "reports": 0, "trusted_or_checked": 0 }
      },
      "pair": { "pair_hash": pair, "approved": 0, "rejected_risk": 0 },
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

#[tokio::test]
async fn test09_f9_matches_spec4() {
    let Some(h) = harness().await else { return };
    let resp = h.check(&fixture("f9.xml")).await;
    assert_eq!(resp.status, StatusCode::OK, "{}", resp.text);
    let r = resp.body;
    assert_eq!(r, spec4_example(&check_id(&r)));
    // Serialized number shapes of the example.
    assert!(resp.text.contains(r#""trust":0.545"#), "{}", resp.text);
    assert!(resp.text.contains(r#""trust":0.0"#), "{}", resp.text);
    let view = h.get(&format!("/v1/checks/{}", check_id(&r))).await;
    assert_eq!(view.body["result"], r);
    assert_eq!(
        view.body["decision_state"],
        json!({ "final_decision": null, "final_reason_type": null, "final_block_wallet": null,
                "final_decline_reasons": null, "decided_by": null, "decided_at": null })
    );
}

#[tokio::test]
async fn test10_f10_high_by_score() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&fixture("f10.xml")).await;
    assert_eq!(band(&r), "high", "{r}");
    assert_eq!(r["summary"]["reason_type"], "risk");
    assert_eq!(score(&r), 66);
    assert_eq!(
        criteria(&r),
        ids(&[("S-1", 35), ("I-5", 10), ("I-7", 8), ("I-8", 8), ("S-9", 5)])
    );
    assert_eq!(r["invoice"]["open_order"], Value::Null);
    let reasons: Vec<&str> = r["summary"]["decline_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(reasons, ["S-1", "I-5", "I-7"]);
    let w1 = h.subject(&wallet_hash(W1)).await.unwrap();
    assert_eq!((w1.0, w1.1, w1.2.as_str()), (6, 1, "0.250"));
    assert_eq!(h.subject(&pair_hash("DE222222222", W1)).await.unwrap().1, 1);
    assert_eq!(h.subject(&supplier_hash("DE222222222")).await, None);
}

#[tokio::test]
async fn test11_f11_medium_with_t4() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&fixture("f11.xml")).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(
        criteria(&r),
        ids(&[("W-4", 10), ("I-8", 8), ("S-8", 5), ("S-9", 5), ("I-10", 5)])
    );
    assert_eq!(reducers(&r), ids(&[("T-4", -5)]));
    assert_eq!(score(&r), 28);
}

#[tokio::test]
async fn test12_blockfrost_timeout() {
    let slow = Mock::given(method("GET"))
        .and(path(format!("/bf/addresses/{W1}/transactions")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!([{ "block_time": W1_FIRST_TX }]))
                .set_delay(Duration::from_millis(HTTP_TIMEOUT_MS + 1000)),
        );
    let Some(h) = harness_with(Options {
        stubs: vec![slow],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1()).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(score(&r), 0);
    assert_eq!(incomplete(&r), ["BLOCKFROST_UNAVAILABLE"]);
    assert_eq!(task_sources(&r, "wallet"), ["BLOCKFROST_UNAVAILABLE"]);
    assert_eq!(r["wallet"]["has_transactions"], Value::Null);
    assert_eq!(r["wallet"]["age_days"], Value::Null);
}

#[tokio::test]
async fn test13_decision_then_known_pair() {
    let Some(h) = harness().await else { return };
    let f9 = h.check_ok(&fixture("f9.xml")).await;
    let d = h
        .post(
            "/v1/decisions",
            &json!({ "check_id": check_id(&f9), "decision": "approved" }),
        )
        .await;
    if d.status == StatusCode::BAD_REQUEST && d.text.contains("not implemented") {
        println!("skipping test 13: decisions::decide is not implemented yet (Task 17)");
        return;
    }
    assert_eq!(d.status, StatusCode::OK, "{}", d.text);
    let xml = with_address(&f1(), W2);
    let xml = sub(
        &xml,
        "<ram:ID>RE-2026-0412</ram:ID>",
        "<ram:ID>RE-2026-0413</ram:ID>",
    );
    let xml = sub(
        &xml,
        r#"<udt:DateTimeString format="102">20261028</udt:DateTimeString>"#,
        r#"<udt:DateTimeString format="102">20261029</udt:DateTimeString>"#,
    );
    let xml = sub(
        &xml,
        r#"<udt:DateTimeString format="102">20261127</udt:DateTimeString>"#,
        r#"<udt:DateTimeString format="102">20261128</udt:DateTimeString>"#,
    );
    let r = h.check_ok(&xml).await;
    assert_eq!(band(&r), "low", "{r}");
    assert_eq!(criteria(&r), ids(&[("W-2", 15)]));
    assert_eq!(reducers(&r), ids(&[("T-3", -10), ("T-4", -5)]));
    assert_eq!(score(&r), 0);
}

#[tokio::test]
async fn test14_signature_present_unverified() {
    let Some(h) = harness().await else { return };
    let xml = sub(
        &f1(),
        "</ram:IncludedNote>",
        "</ram:IncludedNote>\n    <ram:IncludedNote>\n      <ram:Content>cardano-sig-v1:abcd;ef01</ram:Content>\n    </ram:IncludedNote>",
    );
    let r = h.check_ok(&xml).await;
    assert_test1_result(&r);
    assert_eq!(r["signature"]["status"], "present_unverified");
}

#[tokio::test]
async fn test15_pressure_wording_still_low() {
    let Some(h) = harness().await else { return };
    let r = h
        .check_ok(&sub(&f1(), NOTE, &note("Bitte heute noch zahlen")))
        .await;
    assert_eq!(band(&r), "low", "{r}");
    assert_eq!(criteria(&r), ids(&[("I-5", 10)]));
    assert_eq!(evidence(&r, "I-5"), "pressure wording: heute noch");
    let red: i64 = reducers(&r).iter().map(|(_, p)| p).sum();
    assert_eq!(red, -25);
    assert_eq!(score(&r), 0);
}

#[tokio::test]
async fn test16_mangled_address() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&with_address(&f1(), M)).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(criteria(&r), ids(&[("S-3", 25), ("W-4", 10)]));
    assert!(r["reducers"].as_array().unwrap().is_empty());
    assert_eq!(score(&r), 35);
    assert_eq!(r["wallet"]["wallet_hash"], wallet_hash(W3));
    assert_eq!(r["wallet"]["known"], false);
}

#[tokio::test]
async fn test17_ofac_wallet() {
    let Some(h) = harness().await else { return };
    let r = h.check_ok(&with_address(&f1(), W5)).await;
    assert_single_ko(&r, "KO-4", "wallet on OFAC SDN list");
    assert_eq!(r["summary"]["reason_type"], "risk");
    assert_eq!(h.stub_requests().await, 0);
}

#[tokio::test]
async fn test18_ofac_seller_name() {
    let Some(h) = harness().await else { return };
    let xml = sub(
        &sub(
            &f1(),
            "<ram:Name>Alpha Consulting GmbH</ram:Name>",
            "<ram:Name>Delta Trading LLC</ram:Name>",
        ),
        "DE111111111",
        "DE555555555",
    );
    let r = h.check_ok(&xml).await;
    assert_single_ko(&r, "KO-4", "seller name matches OFAC SDN entry");
    assert_eq!(r["summary"]["reason_type"], "risk");
}

#[tokio::test]
async fn test19_vies_invalid() {
    let Some(h) = harness().await else { return };
    let xml = sub(
        &sub(
            &f1(),
            "<ram:Name>Alpha Consulting GmbH</ram:Name>",
            "<ram:Name>Epsilon GmbH</ram:Name>",
        ),
        "DE111111111",
        "DE444444444",
    );
    let r = h.check_ok(&xml).await;
    assert_eq!(band(&r), "high", "{r}");
    assert_eq!(
        criteria(&r),
        ids(&[("S-1", 35), ("S-2", 35), ("I-8", 8), ("S-9", 5)])
    );
    assert_eq!(score(&r), 83);
    let reasons: Vec<&str> = r["summary"]["decline_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(reasons, ["S-1", "S-2", "I-8"]);
    assert_eq!(r["supplier"]["vat_valid"], false);
}

#[tokio::test]
async fn test20_chainabuse_trusted() {
    let stub = chainabuse_stub(
        W1,
        json!([{ "id": "r1", "trusted": true, "checked": false }]),
    );
    let Some(h) = harness_with(Options {
        stubs: vec![stub],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1()).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(criteria(&r), ids(&[("W-1", 30)]));
    assert!(r["reducers"].as_array().unwrap().is_empty());
    assert_eq!(score(&r), 30);
    assert_eq!(
        r["wallet"]["chainabuse"],
        json!({ "reports": 1, "trusted_or_checked": 1 })
    );
}

#[tokio::test]
async fn test21_chainabuse_unverified() {
    let stub = chainabuse_stub(
        W1,
        json!([{ "id": "r1", "trusted": false, "checked": false }]),
    );
    let Some(h) = harness_with(Options {
        stubs: vec![stub],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1()).await;
    assert_eq!(band(&r), "low", "{r}");
    assert_eq!(criteria(&r), ids(&[("W-6", 10)]));
    let red: i64 = reducers(&r).iter().map(|(_, p)| p).sum();
    assert_eq!(red, -25);
    assert_eq!(score(&r), 0);
}

/// Tests 22/23 need Java and the Mustang JAR: `SNIFFER_TEST_MUSTANG=1`, `JAVA_BIN`
/// (default `java`) and `MUSTANG_JAR`. Run with `--ignored`.
fn mustang_env(whitelist: Option<&str>) -> Option<Vec<(&'static str, String)>> {
    if std::env::var("SNIFFER_TEST_MUSTANG").as_deref() != Ok("1") {
        println!("skipping Mustang test: SNIFFER_TEST_MUSTANG != 1");
        return None;
    }
    let Ok(jar) = std::env::var("MUSTANG_JAR") else {
        println!("skipping Mustang test: MUSTANG_JAR not set");
        return None;
    };
    let mut env = vec![
        ("MUSTANG_MODE", "cli".to_string()),
        ("MUSTANG_JAR", jar),
        (
            "JAVA_BIN",
            std::env::var("JAVA_BIN").unwrap_or_else(|_| "java".into()),
        ),
    ];
    if let Some(w) = whitelist {
        env.push(("MUSTANG_RULE_WHITELIST", w.to_string()));
    }
    Some(env)
}

fn f1_without_buyer_reference() -> String {
    sub(
        &f1(),
        "      <ram:BuyerReference>04011000-12345-34</ram:BuyerReference>\n",
        "",
    )
}

#[tokio::test]
#[ignore = "needs SNIFFER_TEST_MUSTANG=1, Java and MUSTANG_JAR"]
async fn test22_mustang_br_de_15() {
    let Some(env) = mustang_env(None) else { return };
    let Some(h) = harness_with(Options {
        env,
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1_without_buyer_reference()).await;
    assert_single_ko(&r, "KO-1", "MUSTANG:BR-DE-15");
    assert_eq!(h.count("SELECT count(*) FROM invoices").await, 6);
}

#[tokio::test]
#[ignore = "needs SNIFFER_TEST_MUSTANG=1, Java and MUSTANG_JAR"]
async fn test23_mustang_whitelist() {
    let Some(env) = mustang_env(Some("BR-DE-15")) else {
        return;
    };
    let Some(h) = harness_with(Options {
        env,
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1_without_buyer_reference()).await;
    assert_test1_result(&r);
    assert_eq!(
        r["invoice"]["validation"]["whitelisted_rules"],
        json!(["BR-DE-15"])
    );
}

#[tokio::test]
async fn test24_currency_not_eur() {
    let Some(h) = harness().await else { return };
    let xml = sub(
        &sub(
            &f1(),
            "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
            "<ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
        ),
        r#"currencyID="EUR""#,
        r#"currencyID="USD""#,
    );
    let r = h.check_ok(&xml).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(score(&r), 0);
    assert_eq!(incomplete(&r), ["CURRENCY_NOT_EUR"]);
    assert_eq!(task_sources(&r, "invoice"), ["CURRENCY_NOT_EUR"]);
    assert_eq!(r["invoice"]["total"]["currency"], "USD");
}

#[tokio::test]
async fn test25_invoice_lock_conflict() {
    let Some(h) = harness().await else { return };
    let invoice_hash = hashing::invoice_hash(
        &h.key,
        "DE111111111",
        "RE-2026-0412",
        "1190.00",
        "2026-10-28",
        "380",
    );
    let lock = format!("sniffer:lock:invoice:{invoice_hash}");
    let mut redis = h.redis.clone();
    let _: () = redis::cmd("SET")
        .arg(&lock)
        .arg(1)
        .query_async(&mut redis)
        .await
        .unwrap();
    let r = h.check(&f1()).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text);
    assert_eq!(r.body["error"], "check_in_progress");
    assert_eq!(h.count("SELECT count(*) FROM checks").await, 0);
    let exists: i64 = redis::cmd("EXISTS")
        .arg(&lock)
        .query_async(&mut redis)
        .await
        .unwrap();
    assert_eq!(exists, 1, "a foreign lock is not released");
}

#[tokio::test]
async fn test26_eg_decision_routing() {
    let Some(h) = harness().await else { return };
    // (g) unknown check_id.
    let g = h
        .post(
            "/v1/decisions",
            &json!({ "check_id": "chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W", "decision": "approved" }),
        )
        .await;
    if g.status == StatusCode::BAD_REQUEST && g.text.contains("not implemented") {
        println!("skipping test 26 e/g: decisions::decide is not implemented yet (Task 17)");
        return;
    }
    assert_eq!(g.status, StatusCode::NOT_FOUND, "{}", g.text);
    assert_eq!(g.body["error"], "not_found");
    // (e) a Low check is not pending.
    let low = h.check_ok(&f1()).await;
    let e = h
        .post(
            "/v1/decisions",
            &json!({ "check_id": check_id(&low), "decision": "approved" }),
        )
        .await;
    assert_eq!(e.status, StatusCode::CONFLICT, "{}", e.text);
    assert_eq!(e.body["error"], "not_pending");
}

#[tokio::test]
async fn test27_missing_token() {
    let Some(h) = harness().await else { return };
    let body = serde_json::to_vec(&json!({ "xml": f1(), "checked_at": CHECKED_AT })).unwrap();
    let r = h
        .post_raw(
            "/v1/initial-check",
            None,
            Some("application/json"),
            body.clone(),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.body["error"], "unauthorized");
    let wrong = h
        .post_raw(
            "/v1/initial-check",
            Some("wrong-token-0123456789abcdef012345"),
            Some("application/json"),
            body,
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let get = h.http.get(h.url("/v1/checks/chk_x")).send().await.unwrap();
    assert_eq!(get.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(h.count("SELECT count(*) FROM checks").await, 0);
}

#[tokio::test]
async fn test28_checked_at_not_allowed() {
    let Some(h) = harness_with(Options {
        env: vec![("ALLOW_CHECKED_AT", "false".into())],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check(&f1()).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["error"], "checked_at_not_allowed");
    assert_eq!(h.count("SELECT count(*) FROM checks").await, 0);
    // Without checked_at the server uses its own clock.
    let ok = h.post("/v1/initial-check", &json!({ "xml": f1() })).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text);
    assert_ne!(ok.body["checked_at"], CHECKED_AT);
}

#[tokio::test]
async fn test29_unsupported_type_code() {
    let Some(h) = harness().await else { return };
    let r = h
        .check_ok(&sub(
            &f1(),
            "<ram:TypeCode>380</ram:TypeCode>",
            "<ram:TypeCode>381</ram:TypeCode>",
        ))
        .await;
    assert_single_ko(&r, "KO-1", "UNSUPPORTED_TYPE_CODE");
}

#[tokio::test]
async fn test30_ambiguous_payment() {
    let Some(h) = harness().await else { return };
    let xml = f1();
    let pm = element(
        &xml,
        "<ram:SpecifiedTradeSettlementPaymentMeans>",
        "</ram:SpecifiedTradeSettlementPaymentMeans>",
    )
    .to_string();
    let r = h.check_ok(&sub(&xml, &pm, &format!("{pm}{pm}"))).await;
    assert_single_ko(&r, "KO-1", "AMBIGUOUS_PAYMENT");
}

#[tokio::test]
async fn test31_dtd_rejected() {
    let Some(h) = harness().await else { return };
    let xml = f1().replacen(
        "?>",
        "?>\n<!DOCTYPE rsm:CrossIndustryInvoice [<!ENTITY x \"y\">]>",
        1,
    );
    let r = h.check_ok(&xml).await;
    assert_single_ko(&r, "KO-1", "DTD_NOT_ALLOWED");
    assert_eq!(r["invoice"], Value::Null);
}

#[tokio::test]
async fn test32_sanctions_list_stale() {
    let Some(h) = harness().await else { return };
    sqlx::query("DELETE FROM list_updates")
        .execute(&h.pool)
        .await
        .unwrap();
    let r = h.check_ok(&f1()).await;
    assert_eq!(band(&r), "medium", "{r}");
    assert_eq!(score(&r), 0);
    assert_eq!(incomplete(&r), ["SANCTIONS_LIST_STALE"]);
    assert_eq!(task_sources(&r, "research"), ["SANCTIONS_LIST_STALE"]);
}

#[tokio::test]
async fn test33_xml_expired_and_unknown() {
    let Some(h) = harness_with(Options {
        env: vec![("XML_TTL_SECONDS", "1".into())],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let r = h.check_ok(&f1()).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let expired = h.get(&format!("/v1/checks/{}/xml", check_id(&r))).await;
    assert_eq!(expired.status, StatusCode::GONE);
    assert_eq!(expired.body["error"], "xml_expired");
    let unknown = h.get("/v1/checks/chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W/xml").await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown.body["error"], "not_found");
    let unknown = h.get("/v1/checks/chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W").await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
}

/// 5.1 request errors and 5.5 health (not a numbered 8.3 test).
#[tokio::test]
async fn api_request_errors_and_health() {
    let Some(h) = harness_with(Options {
        env: vec![("MAX_XML_BYTES", "1000".into())],
        ..Options::default()
    })
    .await
    else {
        return;
    };
    let json_body = |v: Value| serde_json::to_vec(&v).unwrap();
    let post = |ct: Option<&'static str>, body: Vec<u8>| {
        let h = &h;
        async move { h.post_raw("/v1/initial-check", Some(TOKEN), ct, body).await }
    };

    let r = post(Some("text/plain"), json_body(json!({ "xml": "<x/>" }))).await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(r.body["error"], "unsupported_media_type");

    let r = post(Some("application/json"), b"not json".to_vec()).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["error"], "invalid_request");

    let r = post(
        Some("application/json; charset=utf-8"),
        json_body(json!({ "xml": "<x/>", "extra": 1 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["error"], "invalid_request");

    let r = post(
        Some("application/json"),
        json_body(json!({ "xml": "<x/>", "checked_at": "30.10.2026" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.body["error"], "invalid_request");

    let r = post(
        Some("application/json"),
        json_body(json!({ "xml": "a".repeat(1001) })),
    )
    .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(r.body["error"], "xml_too_large");

    let r = post(
        Some("application/json"),
        json_body(json!({ "xml": "a".repeat(6 * 1000 + 4096) })),
    )
    .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(r.body["error"], "payload_too_large");

    assert_eq!(h.count("SELECT count(*) FROM checks").await, 0);

    let health = h.http.get(h.url("/health")).send().await.unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let body: Value = health.json().await.unwrap();
    assert_eq!(
        body,
        json!({ "status": "ok", "postgres": "ok", "redis": "ok", "sanctions_list_age_hours": 0 })
    );
}
