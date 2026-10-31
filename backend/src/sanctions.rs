//! OFAC SDN import (spec 3.7.5). Owner: Task 18.
//!
//! Streams `SDN.XML` with quick-xml, matching elements by local name only (the
//! namespace changes between publications). Per `sdnEntry` it derives the
//! normalized names (`name()` from 3.3, at least 4 characters) and, for
//! `Digital Currency Address - *` ids that are Shelley payment addresses (3.4 steps
//! 1–3, no network check), the `wallet_hash`. The result replaces the OFAC state in
//! one transaction; a list with fewer than [`MIN_ENTRIES`] entries is rejected
//! without any change. Logs and errors never contain names or addresses.

use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use std::time::Duration;

use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use sqlx::PgPool;

use crate::address::{self, CheckedAddress, CredentialType};
use crate::hashing::{self, CredentialKind, HmacKey};
use crate::normalize::{self, LegalForms};

/// Plausibility threshold (3.7.5 step 5).
pub const MIN_ENTRIES: usize = 1000;
/// Download limit (3.7.5 step 1).
pub const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
/// Download timeout (3.7.5 step 1).
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Normalized names shorter than this are dropped (3.7.5 step 3).
pub const MIN_NAME_CHARS: usize = 4;
/// `list_updates.source`, `sanction_names.source`, `subjects.block_source`.
pub const SOURCE: &str = "OFAC";

const DIGITAL_CURRENCY_PREFIX: &str = "Digital Currency Address - ";

/// `wallet_hash` (3.3) of a checked address: `"wallet:" + key|script + ":" + credential`.
pub fn wallet_hash_of(key: &HmacKey, checked: &CheckedAddress) -> String {
    let kind = match checked.credential_type {
        CredentialType::Key => CredentialKind::Key,
        CredentialType::Script => CredentialKind::Script,
    };
    hashing::wallet_hash(key, kind, &checked.credential_hex)
}

/// Parsed list, ready to be applied.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParsedList {
    /// Number of `sdnEntry` elements.
    pub entries: usize,
    /// `(name_normalized, sdn_uid)`.
    pub names: BTreeSet<(String, String)>,
    /// `wallet_hash` → block reason (`OFAC_SDN_<uid>`); first listing wins.
    pub wallets: BTreeMap<String, String>,
}

/// Outcome of an import (printed by `lists-update`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImportStats {
    pub entries: usize,
    pub names: usize,
    pub cardano_addresses: usize,
    /// OFAC-blocked wallets that are no longer listed and were set back to `normal`.
    pub unblocked_wallets: u64,
}

#[derive(Default)]
struct Entry {
    uid: String,
    sdn_type: String,
    first: String,
    last: String,
    /// `(firstName, lastName)` per `akaList/aka`.
    akas: Vec<(String, String)>,
    /// `(idType, idNumber)` per `idList/id`.
    ids: Vec<(String, String)>,
}

fn push_name(names: &mut BTreeSet<(String, String)>, raw: &str, uid: &str, lf: &LegalForms) {
    let n = normalize::name(raw, lf);
    if n.chars().count() >= MIN_NAME_CHARS {
        names.insert((n, uid.to_string()));
    }
}

fn reason_for(uid: &str) -> String {
    let clean: String = uid
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .map(|c| c.to_ascii_uppercase())
        .take(31)
        .collect();
    if clean.is_empty() {
        "OFAC_SDN".to_string()
    } else {
        format!("OFAC_SDN_{clean}")
    }
}

impl Entry {
    fn collect(self, key: &HmacKey, lf: &LegalForms, out: &mut ParsedList) {
        let uid = self.uid.trim();
        let individual = self.sdn_type.trim() == "Individual";
        let variants = std::iter::once((self.first.as_str(), self.last.as_str()))
            .chain(self.akas.iter().map(|(f, l)| (f.as_str(), l.as_str())));
        for (first, last) in variants {
            if individual {
                push_name(&mut out.names, &format!("{first} {last}"), uid, lf);
                push_name(&mut out.names, &format!("{last} {first}"), uid, lf);
            } else {
                push_name(&mut out.names, last, uid, lf);
            }
        }
        for (id_type, id_number) in &self.ids {
            if !id_type.trim().starts_with(DIGITAL_CURRENCY_PREFIX) {
                continue;
            }
            if let Ok(checked) = address::check_without_network(id_number) {
                out.wallets
                    .entry(wallet_hash_of(key, &checked))
                    .or_insert_with(|| reason_for(uid));
            }
        }
    }
}

/// Streams and parses SDN.XML (3.7.5 steps 2–4). Pure; no database access.
pub fn parse_sdn<R: BufRead>(
    reader: R,
    key: &HmacKey,
    legal_forms: &LegalForms,
) -> anyhow::Result<ParsedList> {
    let mut reader = Reader::from_reader(reader);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut entry: Option<Entry> = None;
    let mut out = ParsedList::default();

    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| {
            anyhow::anyhow!(
                "SDN.XML parse error at byte {}: {e}",
                reader.buffer_position()
            )
        })?;
        match event {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_string();
                start_element(&stack, &name, &mut entry);
                stack.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_string();
                start_element(&stack, &name, &mut entry);
                end_element(&stack, &name, "", &mut entry, key, legal_forms, &mut out);
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::CData(c) => text.push_str(&c.xml10_content()),
            Event::GeneralRef(r) => {
                if let Some(ch) = r.resolve_char_ref()? {
                    text.push(ch);
                } else if let Some(s) = resolve_predefined_entity(&r) {
                    text.push_str(s);
                } else {
                    anyhow::bail!("SDN.XML uses an undefined entity reference");
                }
            }
            Event::End(_) => {
                let Some(name) = stack.pop() else {
                    anyhow::bail!("SDN.XML: unbalanced end tag");
                };
                let value = std::mem::take(&mut text);
                end_element(
                    &stack,
                    &name,
                    value.trim(),
                    &mut entry,
                    key,
                    legal_forms,
                    &mut out,
                );
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !stack.is_empty() {
        anyhow::bail!("SDN.XML ended inside an element");
    }
    Ok(out)
}

fn start_element(stack: &[String], name: &str, entry: &mut Option<Entry>) {
    let parent = stack.last().map(String::as_str);
    match (parent, name) {
        (_, "sdnEntry") => *entry = Some(Entry::default()),
        (Some("akaList"), "aka") => {
            if let Some(e) = entry {
                e.akas.push(Default::default());
            }
        }
        (Some("idList"), "id") => {
            if let Some(e) = entry {
                e.ids.push(Default::default());
            }
        }
        _ => {}
    }
}

/// `stack` no longer contains `name`; its last element is the parent.
fn end_element(
    stack: &[String],
    name: &str,
    value: &str,
    entry: &mut Option<Entry>,
    key: &HmacKey,
    lf: &LegalForms,
    out: &mut ParsedList,
) {
    if name == "sdnEntry" {
        if let Some(e) = entry.take() {
            out.entries += 1;
            e.collect(key, lf, out);
        }
        return;
    }
    let Some(e) = entry.as_mut() else { return };
    let parent = stack.last().map(String::as_str);
    let grandparent = stack.len().checked_sub(2).map(|i| stack[i].as_str());
    match (grandparent, parent, name) {
        (_, Some("sdnEntry"), "uid") => e.uid = value.to_string(),
        (_, Some("sdnEntry"), "sdnType") => e.sdn_type = value.to_string(),
        (_, Some("sdnEntry"), "firstName") => e.first = value.to_string(),
        (_, Some("sdnEntry"), "lastName") => e.last = value.to_string(),
        (Some("akaList"), Some("aka"), "firstName") => {
            if let Some(a) = e.akas.last_mut() {
                a.0 = value.to_string();
            }
        }
        (Some("akaList"), Some("aka"), "lastName") => {
            if let Some(a) = e.akas.last_mut() {
                a.1 = value.to_string();
            }
        }
        (Some("idList"), Some("id"), "idType") => {
            if let Some(i) = e.ids.last_mut() {
                i.0 = value.to_string();
            }
        }
        (Some("idList"), Some("id"), "idNumber") => {
            if let Some(i) = e.ids.last_mut() {
                i.1 = value.to_string();
            }
        }
        _ => {}
    }
}

/// 3.7.5 step 5.
pub fn check_plausible(parsed: &ParsedList, min_entries: usize) -> anyhow::Result<()> {
    if parsed.entries < min_entries {
        anyhow::bail!(
            "OFAC plausibility check failed: {} sdnEntry elements, at least {min_entries} required; nothing changed",
            parsed.entries
        );
    }
    Ok(())
}

const CHUNK: usize = 5000;

const INSERT_NAMES_SQL: &str = "\
INSERT INTO sanction_names (name_normalized, source, sdn_uid)
SELECT n, 'OFAC', u FROM UNNEST($1::text[], $2::text[]) AS t(n, u)
ON CONFLICT DO NOTHING";

const UNBLOCK_DELISTED_SQL: &str = "\
UPDATE subjects SET status = 'normal', block_source = NULL, block_reason = NULL, updated_at = now()
WHERE type = 'wallet' AND block_source = 'OFAC' AND NOT (hash = ANY($1::text[]))";

/// Upsert of listed wallets; an existing internal block stays internal (3.7.5 step 6).
const BLOCK_LISTED_SQL: &str = "\
INSERT INTO subjects (hash, type, status, block_source, block_reason, updated_at)
SELECT h, 'wallet', 'blocked', 'OFAC', r, now() FROM UNNEST($1::text[], $2::text[]) AS t(h, r)
ON CONFLICT (hash) DO UPDATE SET
  status       = 'blocked',
  block_source = CASE WHEN subjects.status = 'blocked' AND subjects.block_source = 'internal'
                      THEN 'internal' ELSE 'OFAC' END,
  block_reason = CASE WHEN subjects.status = 'blocked' AND subjects.block_source = 'internal'
                      THEN subjects.block_reason ELSE EXCLUDED.block_reason END,
  updated_at   = now()";

const LIST_UPDATE_SQL: &str = "\
INSERT INTO list_updates (source, last_success_at, entries, cardano_addresses)
VALUES ('OFAC', now(), $1, $2)
ON CONFLICT (source) DO UPDATE SET
  last_success_at = EXCLUDED.last_success_at,
  entries = EXCLUDED.entries,
  cardano_addresses = EXCLUDED.cardano_addresses";

/// 3.7.5 steps 5–6: plausibility check, then one transaction replacing the OFAC state.
pub async fn apply(
    pool: &PgPool,
    parsed: &ParsedList,
    min_entries: usize,
) -> anyhow::Result<ImportStats> {
    check_plausible(parsed, min_entries)?;
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM sanction_names WHERE source = 'OFAC'")
        .execute(&mut *tx)
        .await?;
    let names: Vec<&(String, String)> = parsed.names.iter().collect();
    for chunk in names.chunks(CHUNK) {
        let n: Vec<&str> = chunk.iter().map(|(n, _)| n.as_str()).collect();
        let u: Vec<&str> = chunk.iter().map(|(_, u)| u.as_str()).collect();
        sqlx::query(INSERT_NAMES_SQL)
            .bind(&n)
            .bind(&u)
            .execute(&mut *tx)
            .await?;
    }

    let hashes: Vec<&str> = parsed.wallets.keys().map(String::as_str).collect();
    let unblocked = sqlx::query(UNBLOCK_DELISTED_SQL)
        .bind(&hashes)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let wallets: Vec<(&String, &String)> = parsed.wallets.iter().collect();
    for chunk in wallets.chunks(CHUNK) {
        let h: Vec<&str> = chunk.iter().map(|(h, _)| h.as_str()).collect();
        let r: Vec<&str> = chunk.iter().map(|(_, r)| r.as_str()).collect();
        sqlx::query(BLOCK_LISTED_SQL)
            .bind(&h)
            .bind(&r)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(LIST_UPDATE_SQL)
        .bind(i32::try_from(parsed.entries)?)
        .bind(i32::try_from(parsed.wallets.len())?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(ImportStats {
        entries: parsed.entries,
        names: parsed.names.len(),
        cardano_addresses: parsed.wallets.len(),
        unblocked_wallets: unblocked,
    })
}

/// Parses `reader` and applies it (for tests and local files). `min_entries` is the
/// plausibility threshold; production uses [`MIN_ENTRIES`].
pub async fn import_from_reader<R: BufRead>(
    pool: &PgPool,
    key: &HmacKey,
    legal_forms: &LegalForms,
    reader: R,
    min_entries: usize,
) -> anyhow::Result<ImportStats> {
    let parsed = parse_sdn(reader, key, legal_forms)?;
    apply(pool, &parsed, min_entries).await
}

/// `User-Agent` of the SDN download. reqwest sends none by default, and the OFAC
/// load balancer answers requests without one with HTTP 403.
const USER_AGENT: &str = concat!("sniffer/", env!("CARGO_PKG_VERSION"), " (OFAC SDN import)");

/// Downloads `url` (redirects followed) with `http_timeout`, at most [`MAX_DOWNLOAD_BYTES`].
async fn download(url: &str, http_timeout: Duration) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(http_timeout)
        .build()?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("OFAC download failed: {}", e.without_url()))?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("OFAC download failed: HTTP {status}");
    }
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_DOWNLOAD_BYTES)
    {
        anyhow::bail!("OFAC download exceeds {MAX_DOWNLOAD_BYTES} bytes");
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| anyhow::anyhow!("OFAC download failed: {}", e.without_url()))?
    {
        if body.len() as u64 + chunk.len() as u64 > MAX_DOWNLOAD_BYTES {
            anyhow::bail!("OFAC download exceeds {MAX_DOWNLOAD_BYTES} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Full OFAC import (3.7.5): download, parse off the async runtime, apply with
/// [`MIN_ENTRIES`]. On any error the previous state stays untouched.
pub async fn import(
    pool: &PgPool,
    key: &HmacKey,
    legal_forms: &LegalForms,
    url: &str,
    http_timeout: Duration,
) -> anyhow::Result<ImportStats> {
    let body = download(url, http_timeout).await?;
    let (key, lf) = (key.clone(), legal_forms.clone());
    let parsed =
        tokio::task::spawn_blocking(move || parse_sdn(body.as_slice(), &key, &lf)).await??;
    apply(pool, &parsed, MIN_ENTRIES).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const W5: &str = "addr_test1vp24242424242424242424242424242424242424242424glts28l";
    const W1_MAIN: &str = "addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qc5hee8";
    const W1_BAD: &str = "addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q";
    /// W1 / W1-main payment credential `11…11` (3.3 test vector).
    const W1_HASH: &str = "hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090";

    fn key() -> HmacKey {
        HmacKey::from_hex(KEY).unwrap()
    }

    fn lf() -> LegalForms {
        LegalForms::from_json(include_str!("../data/legal-forms.json")).unwrap()
    }

    /// Small synthetic SDN.XML in the shape of the real publication.
    fn synthetic_sdn() -> String {
        format!(
            r#"<?xml version="1.0" standalone="yes"?>
<sdnList xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>10/30/2026</Publish_Date><Record_Count>4</Record_Count></publshInformation>
  <sdnEntry>
    <uid>101</uid>
    <lastName>Delta Trading LLC</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>SDGT</program></programList>
    <idList>
      <id><uid>9001</uid><idType>Digital Currency Address - ADA</idType><idNumber>{W5}</idNumber></id>
      <id><uid>9002</uid><idType>Digital Currency Address - XBT</idType><idNumber>1BoatSLRHtKNngkdXEeobR76b53LETtpyT</idNumber></id>
      <id><uid>9003</uid><idType>Registration Number</idType><idNumber>{W1_MAIN}</idNumber></id>
    </idList>
    <akaList>
      <aka><uid>7001</uid><type>a.k.a.</type><category>strong</category><lastName>Delta &amp; Sons Trading</lastName></aka>
      <aka><uid>7002</uid><type>a.k.a.</type><category>weak</category><lastName>DTL</lastName></aka>
    </akaList>
  </sdnEntry>
  <sdnEntry>
    <uid>102</uid>
    <firstName>Ivan</firstName>
    <lastName>Petrov</lastName>
    <sdnType>Individual</sdnType>
    <akaList><aka><uid>7003</uid><firstName>Iwan</firstName><lastName>Petrow</lastName></aka></akaList>
    <idList>
      <id><uid>9004</uid><idType>Digital Currency Address - ADA</idType><idNumber> {W1_MAIN} </idNumber></id>
      <id><uid>9005</uid><idType>Digital Currency Address - ADA</idType><idNumber>{W1_BAD}</idNumber></id>
    </idList>
  </sdnEntry>
  <sdnEntry>
    <uid>103</uid>
    <lastName><![CDATA[Groß Handel GmbH]]></lastName>
    <sdnType>Entity</sdnType>
  </sdnEntry>
  <sdnEntry>
    <uid>104</uid>
    <lastName>&#65;BC Ltd.</lastName>
    <sdnType>Vessel</sdnType>
    <idList/>
  </sdnEntry>
</sdnList>
"#
        )
    }

    fn parsed() -> ParsedList {
        parse_sdn(synthetic_sdn().as_bytes(), &key(), &lf()).unwrap()
    }

    fn names_of(p: &ParsedList, uid: &str) -> Vec<String> {
        p.names
            .iter()
            .filter(|(_, u)| u == uid)
            .map(|(n, _)| n.clone())
            .collect()
    }

    #[test]
    fn counts_entries_and_derives_names() {
        let p = parsed();
        assert_eq!(p.entries, 4);
        // Entity: name(lastName) for main and aka; "DTL" (3 chars) is dropped.
        assert_eq!(names_of(&p, "101"), ["deltasonstrading", "deltatrading"]);
        // Individual: "first last" and "last first", main and aka.
        assert_eq!(
            names_of(&p, "102"),
            ["ivanpetrov", "iwanpetrow", "petrovivan", "petrowiwan"]
        );
        // CDATA, legal form removed.
        assert_eq!(names_of(&p, "103"), ["grosshandel"]);
        // Char reference resolved; "abc" has 3 chars and is dropped.
        assert!(names_of(&p, "104").is_empty());
        // Nested aka/id uids never become entry uids.
        assert!(p.names.iter().all(|(_, u)| u.starts_with("10")));
    }

    #[test]
    fn digital_currency_addresses_become_wallet_hashes() {
        let p = parsed();
        let w5 = wallet_hash_of(&key(), &address::check_without_network(W5).unwrap());
        // W5 (preprod) and W1-main (mainnet, no network check) are valid Shelley
        // addresses; the XBT id, the non-currency id and W1-bad are skipped.
        assert_eq!(p.wallets.len(), 2);
        assert_eq!(p.wallets[&w5], "OFAC_SDN_101");
        assert_eq!(p.wallets[W1_HASH], "OFAC_SDN_102");
    }

    #[test]
    fn plausibility_threshold() {
        let p = parsed();
        let e = check_plausible(&p, MIN_ENTRIES).unwrap_err().to_string();
        assert!(e.contains("plausibility") && e.contains('4'), "{e}");
        check_plausible(&p, 4).unwrap();
    }

    #[test]
    fn errors_do_not_leak_content() {
        let broken = "<sdnList><sdnEntry><lastName>Secret Name</sdnEntry></sdnList>";
        let e = parse_sdn(broken.as_bytes(), &key(), &lf())
            .unwrap_err()
            .to_string();
        assert!(!e.contains("Secret"), "{e}");
        let truncated = "<sdnList><sdnEntry><lastName>Secret Name</lastName>";
        assert!(parse_sdn(truncated.as_bytes(), &key(), &lf()).is_err());
    }

    #[test]
    fn reason_is_a_valid_block_code() {
        assert_eq!(reason_for("36"), "OFAC_SDN_36");
        assert_eq!(reason_for(""), "OFAC_SDN");
        assert!(crate::seed::is_valid_reason_code(&reason_for(
            &"9".repeat(80)
        )));
    }

    #[tokio::test]
    async fn apply_rejects_implausible_list_before_touching_the_database() {
        // Lazy pool to an unreachable address: any query would fail with a connection error.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy("postgres://nobody:nothing@127.0.0.1:1/none")
            .unwrap();
        let e = apply(&pool, &parsed(), MIN_ENTRIES).await.unwrap_err();
        assert!(e.to_string().contains("plausibility"), "{e}");
    }

    #[tokio::test]
    async fn download_sends_user_agent_and_follows_redirect() {
        // Regression: the OFAC load balancer answers requests without a User-Agent with
        // HTTP 403, and reqwest sends none by default. Unmatched requests get wiremock's 404.
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/exports/SDN.XML"))
            .and(header("user-agent", USER_AGENT))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/s3/sdn.xml", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/s3/sdn.xml"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<sdnList/>"))
            .mount(&server)
            .await;
        let url = format!("{}/exports/SDN.XML", server.uri());
        let body = download(&url, Duration::from_secs(5)).await.unwrap();
        assert_eq!(body, b"<sdnList/>");
    }
}
