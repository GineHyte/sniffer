# Invoice Scam Sniffer – Initial Check · Spezifikation v1.0

Stand: 30.10.2026 · Status: **final, verbindlich für den Bau** · ersetzt v0.2
Grundlage: Design „Invoice Scam Sniffer – Criteria, Weights & JSON“ (v0.1)

**Lesehinweise**
- Dieses Dokument ist vollständig. Was hier nicht beschrieben ist, wird nicht gebaut.
- Bei Widerspruch gilt: Abschnitt 3 (Definition) vor Abschnitt 1 (Requirements) vor Beispielen.
- „muss“ ist verbindlich. Platzhalter stehen in spitzen Klammern: `<check_id>`.
- In Tabellen steht `\|` für das Zeichen `|` (Markdown-Escape), auch innerhalb von Code und regulären Ausdrücken.
- Alle Angaben zu externen Diensten, Bibliotheken und Mustang wurden am 30.10.2026 geprüft (Abschnitt 9). Die Beispielrechnung in Anhang A wurde mit Mustang 2.26.0 als gültig validiert.

---

## 0. Zweck und Überblick

Unternehmen erhalten E-Rechnungen im CII-Format (XRechnung, ZUGFeRD, Factur-X), die nicht per IBAN, sondern an eine **Cardano-Adresse** bezahlt werden. Betrüger versuchen, Zahlungen auf eigene Adressen umzuleiten. Krypto-Zahlungen lassen sich nicht zurückholen.

Der **Initial Check** ist ein HTTP-Dienst auf unserem Server. Er erhält **eine** Rechnung als XML und liefert ohne KI ein Risikoband, einen Score, alle gefeuerten Kriterien mit Evidenz und ein JSON für die Agenten-Stufe.

| Band | Bedeutung | Entscheidung | Wer entscheidet |
| --- | --- | --- | --- |
| **Low** | Rechnung kann bezahlt werden | `approve` | Initial Check, endgültig |
| **Medium** | Agenten prüfen nach | `review` | Agenten-Stufe über `POST /v1/decisions` |
| **High** | Ablehnung mit sachlichen Gründen | `decline` | Initial Check, endgültig |

```
ERP / Käufer-Agent ──POST /v1/initial-check──► Initial Check ──► Ergebnis-JSON
                                                   │
                                Medium ──► Agenten ──POST /v1/decisions──► Initial Check
```

Grundsätze:
- **Deterministisch:** Gleiche Eingabe, gleicher Datenstand und gleiche Antworten externer Quellen ergeben dasselbe Ergebnis. Einziger Zufallswert ist die `check_id`.
- **Nachvollziehbar:** Jeder Punkt im Score gehört zu genau einem Kriterium mit Evidenz.
- **Datensparsam:** Gespeichert werden nur HMAC-Hashes. Das Original-XML liegt befristet in Redis.
- **Ausfall ist nie „sauber“:** Fehlt eine Quelle, steht das im Ergebnis und hebt das Band gegebenenfalls an.

Nicht Teil dieses Dienstes: Ausführung von Zahlungen, PDF-Verarbeitung, KI, Prüfung von Wallet-Signaturen (Schnittstelle reserviert, Abschnitt 11), Umrechnung EUR → ADA.

---

## 1. Functional Requirements

### 1.1 Schnittstelle

| ID | Anforderung |
| --- | --- |
| FR-01 | `POST /v1/initial-check` nimmt `{"xml": <string>, "checked_at": <string, optional>}` mit `Content-Type: application/json` an. Unbekannte Felder führen zu 400 `invalid_request`. Antwort 200 mit Ergebnis-JSON (Abschnitt 4), auch bei Band High. |
| FR-02 | Fehlerantworten nach der Tabelle in 5.1. |
| FR-03 | `checked_at` ist nur erlaubt, wenn `ALLOW_CHECKED_AT=true` (Tests); sonst 400 `checked_at_not_allowed`. Format RFC 3339; Umrechnung nach UTC, Abschneiden auf ganze Sekunden. Ohne Angabe gilt die aktuelle UTC-Zeit, auf Sekunden abgeschnitten. „Prüfdatum“ ist der Datumsteil von `checked_at` in UTC. |
| FR-04 | `GET /v1/checks/{check_id}` liefert ein gespeichertes Ergebnis (5.2). |
| FR-05 | `GET /v1/checks/{check_id}/xml` liefert das Original-XML, solange es in Redis liegt (5.3). |
| FR-06 | `POST /v1/decisions` nimmt Entscheidungen der Agenten-Stufe an (5.4). |
| FR-07 | `GET /health` ohne Authentifizierung (5.5). |
| FR-08 | Alle Endpunkte außer `/health` verlangen `Authorization: Bearer <SNIFFER_API_TOKEN>`. Der Vergleich erfolgt in konstanter Zeit. Sonst 401 `unauthorized`. |
| FR-09 | Fehlerkörper sind immer `{"error": "<code>", "message": "<Text>"}`. `message` enthält nie Rohdaten aus der Rechnung. |

### 1.2 Einlesen und Validieren

| ID | Anforderung |
| --- | --- |
| FR-10 | Ist `xml` als UTF-8 länger als `MAX_XML_BYTES`, antwortet der Server 413 `xml_too_large`. Das Body-Limit des Servers ist `6 × MAX_XML_BYTES + 4096` Bytes; darüber 413 `payload_too_large`. |
| FR-11 | Ein führendes BOM (`U+FEFF`) wird vor dem Parsen entfernt. Sonst wird das XML unverändert verarbeitet und gespeichert. |
| FR-12 | Parsen mit `roxmltree` (`allow_dtd = false`, `nodes_limit = 200000`). Fehler `DtdDetected` → KO-1 `DTD_NOT_ALLOWED`; jeder andere Parse-Fehler → KO-1 `XML_MALFORMED`. |
| FR-13 | Das Wurzelelement muss `CrossIndustryInvoice` im Namespace `urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100` sein, sonst KO-1 `UNSUPPORTED_SYNTAX`. |
| FR-14 | Die Felder aus 3.1 werden gelesen und geprüft. Verstöße führen zu KO-1 mit den Codes aus 3.1. |
| FR-15 | Das XML wird mit Mustang validiert (3.7.1). Nicht-whitelistete Fehler führen zu KO-1 `MUSTANG:<Regel-ID>`. |
| FR-16 | Ist Mustang nicht verfügbar (3.7.1), steht `MUSTANG_UNAVAILABLE` in `checks_incomplete`. |

### 1.3 Zahlungsadresse

| ID | Anforderung |
| --- | --- |
| FR-20 | Die Adresse aus BT-84 wird nach 3.4 geprüft. Verstöße führen zu KO-2. |
| FR-21 | **Wallet-Identität ist das Payment-Credential der Adresse** (3.4). Der Stake-Teil wird für Identität, Vertrauen und Alter nicht verwendet. |
| FR-22 | Das Netzwerk der Adresse muss zu `EXPECTED_NETWORK` passen. |

### 1.4 Hashing und Datenschutz

| ID | Anforderung |
| --- | --- |
| FR-30 | Alle gespeicherten Identifikatoren sind HMAC-Werte nach 3.3. |
| FR-31 | `SNIFFER_HMAC_KEY` ist hex-kodiert und hat mindestens 64 Hex-Zeichen (32 Byte). Fehlt er oder ist er ungültig, startet der Server nicht. |
| FR-32 | Rohwerte aus Rechnungen (Namen, Anschriften, USt-IDs, Kontaktdaten, Zahlungsadresse) werden nicht in Postgres gespeichert und nie geloggt. Ausnahmen: Original-XML in Redis mit TTL; Geschäftsdaten im Ergebnis-JSON (Rechnungsnummer, Bestellnummer, Daten, Beträge, Währung, Ländercodes); öffentliche Sanktionsnamen in `sanction_names`. |
| FR-32a | Ausnahme für die Auszahlung (Abschnitt 12): `payout_intents.to_address` speichert die Zahlungsadresse (BT-84 nach 3.4 Schritt 1) im Klartext, weil sie nach der Auszahlung ohnehin öffentlich on-chain steht und für die Wiederherstellung unsicherer Auszahlungen (`submitting`, `unknown`) nötig ist. Eine Zeile entsteht nur für freigegebene Rechnungen (`final_decision = 'approved'`). Sie wird mit `sniffer subject-delete` (Treffer über `wallet_hash` oder über eine gelöschte `invoices`-Zeile) und mit dem Aufbewahrungsjob (FR-76) gelöscht (12.8). Die Adresse wird nie geloggt (FR-33). |
| FR-33 | Logs enthalten nur `check_id`, Hashes, Band, Score, Kriterien-IDs, Fehlercodes und Dauer. |

### 1.5 Prüfablauf

| ID | Anforderung |
| --- | --- |
| FR-40 | Der Ablauf folgt exakt 3.5. |
| FR-41 | K.O.-Kriterien werden vollständig ausgewertet, soweit ihre Eingaben vorhanden sind. |
| FR-42 | Hat ein K.O.-Kriterium gefeuert, finden keine Abfragen an Blockfrost, VIES und Chainabuse statt. |
| FR-43 | Die externen Abfragen laufen parallel, jede mit Timeout `HTTP_TIMEOUT_MS`. Erfolgreiche Antworten werden in Redis zwischengespeichert (3.9). |
| FR-44 | Scheitert eine Quelle, liefern die abhängigen Kriterien 0 Punkte, und ihr Code steht in `checks_incomplete`. |
| FR-45 | Pro `invoice_hash` läuft höchstens ein Check gleichzeitig (Redis-Sperre, 3.5 Schritt 6). Ein zweiter Check erhält 409 `check_in_progress`. |
| FR-46 | Sortierungen und Rundungen folgen 3.8; es gibt keine weiteren Zufallswerte außer `check_id`. |

### 1.6 Score, Band, Gründe, Agentenaufträge

| ID | Anforderung |
| --- | --- |
| FR-50 | Jedes gefeuerte Kriterium erzeugt einen Eintrag `{id, name, points, evidence, agent}`. Punkte, Namen und Texte kommen aus `config/criteria.json`, die Evidenz folgt den Mustern in 3.6 und enthält keine Rohwerte. |
| FR-51 | Score, Reducer und Band werden nach 3.8 berechnet. |
| FR-52 | `decline_reasons` und `agent_tasks` werden nach 3.8 gebildet. |
| FR-53 | Kriterien sind erweiterbar: Jedes Kriterium implementiert den Trait `Criterion` (3.6.0) und steht in einer Registry. Ein neues Kriterium braucht nur eine Implementierung, einen Registry-Eintrag und einen Eintrag in `config/criteria.json`. Ablauf, Score, Band und JSON-Schema bleiben unverändert. |

### 1.7 Speichern und Entscheiden

| ID | Anforderung |
| --- | --- |
| FR-60 | Jeder Check mit Antwort 200 schreibt genau eine Zeile in `checks`, auch bei K.O. |
| FR-61 | Ob eine `invoices`-Zeile entsteht, regelt die Tabelle in 3.5 Schritt 12. |
| FR-62 | Bei Low trägt der Initial Check `approved` ein, bei High `rejected` mit `reason_type` nach 3.8, jeweils mit Zähleränderung nach 5.4. Medium bleibt offen. |
| FR-63 | Alle Schreibvorgänge eines Checks in Postgres laufen in einer Transaktion. Das XML wird vor dem Commit in Redis geschrieben. Scheitert Redis oder der Commit, wird nichts gespeichert (Redis-Schlüssel wird gelöscht) und der Server antwortet 503 `dependency_unavailable`. |
| FR-64 | Die Agenten-Stufe entscheidet Medium-Fälle ausschließlich über `POST /v1/decisions`. |

### 1.8 Listen und Pflege

| ID | Anforderung |
| --- | --- |
| FR-70 | Der OFAC-Import (3.7.5) läuft als Befehl `sniffer lists-update` und automatisch nach FR-71. |
| FR-71 | Bei `OFAC_AUTO_UPDATE=true` startet der Server den Import beim Start, wenn die Liste fehlt oder älter als `LISTS_REFRESH_HOURS` ist, und danach alle `LISTS_REFRESH_HOURS` Stunden. Fehler werden geloggt; der alte Stand bleibt erhalten. |
| FR-72 | Fehlt ein erfolgreicher OFAC-Import oder ist er älter als `LISTS_MAX_AGE_HOURS` (gemessen an der echten Uhrzeit, nicht an `checked_at`), steht `SANCTIONS_LIST_STALE` in `checks_incomplete`. |
| FR-73 | `sniffer blocklist-add` und `sniffer blocklist-remove` pflegen die interne Sperrliste (Abschnitt 7). |
| FR-74 | `sniffer subject-delete` ist der DSGVO-Löschpfad (Abschnitt 7). |
| FR-75 | `sniffer db-seed` lädt Demo- und Testhistorie (Abschnitt 7). |
| FR-76 | Ein Job läuft beim Start und danach alle 24 h und löscht `checks`- und `invoices`-Zeilen, deren `created_at` älter als `RETENTION_DAYS` ist. |

### 1.9 Betrieb

| ID | Anforderung |
| --- | --- |
| FR-80 | Beim Start prüft der Server: Umgebungsvariablen (6.1), `config/criteria.json` und alle Datendateien (6.2, 6.3) inklusive Abgleich Registry ↔ Config, Anlage des Schemas `sniffer`, Migrationen, Erreichbarkeit von Redis, bei `MUSTANG_MODE=cli` die Existenz von `MUSTANG_JAR`. Jeder Fehler beendet den Prozess mit Exit-Code 1 und einer Log-Meldung. |
| FR-81 | Bei SIGTERM oder SIGINT werden laufende Requests beendet, höchstens 30 s lang (Graceful Shutdown). |
| FR-82 | Höchstens `MUSTANG_MAX_PARALLEL` Mustang-Prozesse laufen gleichzeitig (Semaphor). |

---

## 2. Technologien

Sprache **Rust** (stable, Edition 2021). Ein Binary `sniffer` mit Unterbefehlen. `rust-toolchain.toml` enthält die zum Bauzeitpunkt neueste stabile Version exakt. `Cargo.lock` wird committet; alle Crates werden in `Cargo.toml` exakt gepinnt (`=x.y.z`). Wo unten keine Version steht, nimmt der Bau die neueste Version zum Bauzeitpunkt und pinnt sie.

| Bereich | Crate / Werkzeug | Verwendung |
| --- | --- | --- |
| Async / HTTP-Server | `tokio`, `axum` | Server, `DefaultBodyLimit`, Graceful Shutdown |
| HTTP-Client | `reqwest` (Features `rustls`, `json`; bis 0.12 hieß das Feature `rustls-tls`) | Blockfrost, VIES, Chainabuse, OFAC; Redirects folgen (Standard) |
| XML lesen | `roxmltree` **0.21.2** | Rechnung und Mustang-Bericht; `ParsingOptions { allow_dtd: false, nodes_limit: 200000, .. }` |
| OFAC-Liste | `quick-xml` | Streaming-Parser für SDN.XML |
| Cardano-Adressen | `pallas-addresses` **1.4.0** | `Address::from_bech32`, `ShelleyAddress::{network, typeid, payment, to_bech32}`, `ShelleyPaymentPart::{is_script, to_hex}` |
| Hashing | `hmac`, `sha2`, `hex` | HMAC-SHA256, SHA-256 der Config |
| Konstantzeitvergleich | `subtle` | Token-Prüfung |
| Text | `unicode-normalization` **0.1.26** | NFKD, `char::is_combining_mark` |
| Beträge | `rust_decimal` | exakte Dezimalrechnung, nie `f64` für Beträge |
| Muster | `regex` | Regel-IDs, BT-82, Wertprüfungen |
| Datenbank | `sqlx` (Features `postgres`, `runtime-tokio`, `tls-rustls-aws-lc-rs`, `migrate`, `chrono`, `rust_decimal`, `macros`; nur ein Krypto-Backend aws-lc-rs wie reqwest) | PostgreSQL 16, Migrationen in `migrations/` |
| Redis | `redis` (Feature `tokio-comp`) | Redis 7 |
| JSON | `serde`, `serde_json` | Request- und Ergebnis-Structs |
| Zeit / IDs | `chrono`, `ulid` | UTC-Zeiten, `check_id` |
| Temporäre Dateien | `tempfile` | Mustang-Eingabe |
| Konfiguration / CLI | `dotenvy`, `clap` (Feature `derive`) | `.env`, Unterbefehle |
| Fehler / Logs | `thiserror`, `anyhow`, `tracing`, `tracing-subscriber` | ohne Rohdaten (FR-33) |
| Tests | `wiremock`, `tokio` (Test-Makros) | Stubs für Blockfrost, VIES, Chainabuse |
| Validierung | **Mustang-CLI 2.26.0** | Release `core-2.26.0` vom 25.08.2026, `https://github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar`, 59 163 641 Byte, SHA-256 `42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736` |
| Java | Java ≥ 11 (Manifest `Build-Jdk-Spec: 11`); Laufzeit-Image Eclipse Temurin 21 JRE | lokal geprüft mit OpenJDK 23.0.2 |
| Später (Abschnitt 11) | `pallas-crypto`, `cardano-message-signing` | CIP-8-Signaturen |

**Docker:** Multi-Stage-`Dockerfile`: Build-Stufe mit dem offiziellen `rust`-Image (gleiche Version wie `rust-toolchain.toml`), `cargo build --release`; Laufzeit-Stufe `eclipse-temurin:21-jre`, lädt die Mustang-JAR nach `/opt/mustang/Mustang-CLI-2.26.0.jar` und bricht ab, wenn die SHA-256-Prüfsumme nicht stimmt. `docker-compose.yml` startet `postgres:16`, `redis:7` und `sniffer`; Image-Tags werden beim Bau exakt gepinnt.

**Projektaufbau**

```
sniffer/
  Cargo.toml  Cargo.lock  rust-toolchain.toml  Dockerfile  docker-compose.yml  .env.example
  migrations/              SQL aus 3.9
  config/criteria.json     Inhalt aus 6.2
  data/                    Dateien aus 6.3
  seed/seed.json           Inhalt aus 7.5
  tests/fixtures/          Rechnungen aus 8.2, Mustang-Berichte aus Anhang B
  src/
    main.rs                clap-Unterbefehle, Start (FR-80)
    config.rs              .env, criteria.json, data/*.json laden und prüfen
    api.rs                 axum-Routen (Abschnitt 5)
    parse.rs               XML lesen, Felder prüfen (3.1)
    mustang.rs             Validierung (3.7.1)
    address.rs             Adressprüfung, Wallet-Identität (3.4)
    normalize.rs           Normalisierung (3.3)
    hashing.rs             HMAC (3.3)
    sources/               blockfrost.rs, vies.rs, chainabuse.rs, mock.rs (3.7)
    sanctions.rs           OFAC-Import (3.7.5)
    store/                 postgres.rs, redis.rs (3.9)
    criteria/              mod.rs (Trait + Registry), ko.rs, supplier.rs, wallet.rs, invoice.rs, reducers.rs
    scoring.rs             Score, Band, Gründe, Aufträge (3.8)
    decisions.rs           Entscheidungslogik (5.4)
    jobs.rs                OFAC-Aktualisierung, Aufbewahrung
    model.rs               serde-Structs (Abschnitt 4)
```

---

## 3. Definition des Initial Checks

### 3.1 Eingabe und Felder

Namespaces: `rsm` = `urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100`, `ram` = `urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100`, `udt` = `urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100`.

Pfade beginnen unter dem Wurzelelement und bestehen nur aus Kind-Schritten (Namespace + lokaler Name). Abkürzungen:
`CTX` = `rsm:ExchangedDocumentContext` · `DOC` = `rsm:ExchangedDocument` · `TX` = `rsm:SupplyChainTradeTransaction` · `AGR` = `TX/ram:ApplicableHeaderTradeAgreement` · `SEL` = `AGR/ram:SellerTradeParty` · `BUY` = `AGR/ram:BuyerTradeParty` · `STL` = `TX/ram:ApplicableHeaderTradeSettlement` · `PM` = `STL/ram:SpecifiedTradeSettlementPaymentMeans`

Allgemeine Regeln:
- Textwerte werden vor jeder Prüfung getrimmt (Leerzeichen, Tab, CR, LF). Ein leerer Wert gilt als fehlend.
- Kommt ein einwertiges Feld mehrfach vor, gilt das als `INVALID_FIELD:<BT>`. Mehrwertig sind nur BT-22 und BT-20; bei BT-9 zählt das früheste Datum.
- Fehlt ein Pflichtfeld: `MISSING_FIELD:<BT>`. Verletzt ein Wert die Prüfung: `INVALID_FIELD:<BT>` oder der genannte Code.
- Alle Codes werden gesammelt und als Evidenz von KO-1 ausgegeben (Reihenfolge der Tabelle).

| Feld | BT | Pfad | Pflicht | Prüfung |
| --- | --- | --- | --- | --- |
| Profil | BT-24 | `CTX/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID` | ja | nicht leer |
| Rechnungsnummer | BT-1 | `DOC/ram:ID` | ja | höchstens 200 Zeichen |
| Rechnungsart | BT-3 | `DOC/ram:TypeCode` | ja | einer von `326`, `380`, `384`, `875`, `876`, `877`, sonst `UNSUPPORTED_TYPE_CODE` |
| Rechnungsdatum | BT-2 | `DOC/ram:IssueDateTime/udt:DateTimeString` | ja | Attribut `format="102"`, Wert `YYYYMMDD`, gültiges Kalenderdatum |
| Freitexte | BT-22 | `DOC/ram:IncludedNote/ram:Content` | nein | 0..n |
| Bestellnummer | BT-13 | `AGR/ram:BuyerOrderReferencedDocument/ram:IssuerAssignedID` | nein | – |
| Seller-Name | BT-27 | `SEL/ram:Name` | ja | – |
| Seller-USt-ID | BT-31 | `SEL/ram:SpecifiedTaxRegistration/ram:ID` mit Attribut `schemeID="VA"` | ja | genau ein Eintrag; normalisiert (3.3) passend zu `^[A-Z]{2}[A-Z0-9]{2,14}$` |
| Seller-Straße | BT-35 | `SEL/ram:PostalTradeAddress/ram:LineOne` | nein | – |
| Seller-Ort | BT-37 | `SEL/ram:PostalTradeAddress/ram:CityName` | nein | – |
| Seller-PLZ | BT-38 | `SEL/ram:PostalTradeAddress/ram:PostcodeCode` | nein | – |
| Seller-Land | BT-40 | `SEL/ram:PostalTradeAddress/ram:CountryID` | ja | uppercase `^[A-Z]{2}$` |
| Seller-Telefon | BT-42 | `SEL/ram:DefinedTradeContact/ram:TelephoneUniversalCommunication/ram:CompleteNumber` (erster Kontakt) | nein | – |
| Seller-E-Mail | BT-43 | `SEL/ram:DefinedTradeContact/ram:EmailURIUniversalCommunication/ram:URIID` (erster Kontakt) | nein | – |
| Seller-E-Adresse | BT-34 | `SEL/ram:URIUniversalCommunication/ram:URIID` mit Attribut `schemeID` | nein | – |
| Buyer-Name | BT-44 | `BUY/ram:Name` | ja | – |
| Buyer-USt-ID | BT-48 | `BUY/ram:SpecifiedTaxRegistration/ram:ID` mit `schemeID="VA"` | nein | höchstens ein Eintrag |
| Buyer-PLZ | BT-53 | `BUY/ram:PostalTradeAddress/ram:PostcodeCode` | nein | – |
| Währung | BT-5 | `STL/ram:InvoiceCurrencyCode` | ja | `^[A-Z]{3}$` |
| Zahlungsanweisung | BG-16 | `PM` | ja | genau ein Element; 0 → `MISSING_FIELD:BT-81`; mehr als 1 → `AMBIGUOUS_PAYMENT` |
| Zahlungsart | BT-81 | `PM/ram:TypeCode` | ja | – (Abweichung von `ZZZ` wird in I-11 bewertet) |
| Zahlungsinfo | BT-82 | `PM/ram:Information` | nein | – (bewertet in I-11) |
| Konto | BG-17 | `PM/ram:PayeePartyCreditorFinancialAccount` | ja | genau ein Element; 0 → `MISSING_FIELD:BT-84`; mehr als 1 → `AMBIGUOUS_PAYMENT`; enthält `ram:IBANID` → `IBAN_NOT_SUPPORTED`; `PM/ram:ApplicableTradeSettlementFinancialCard` oder `PM/ram:PayerPartyDebtorFinancialAccount` vorhanden → `AMBIGUOUS_PAYMENT` |
| **Zahlungsadresse** | BT-84 | `PM/ram:PayeePartyCreditorFinancialAccount/ram:ProprietaryID` | ja | Prüfung in 3.4 (KO-2) |
| Verwendungszweck | BT-83 | `STL/ram:PaymentReference` | nein | – |
| Zahlungsbedingungen | BT-20 | `STL/ram:SpecifiedTradePaymentTerms/ram:Description` | nein | 0..n (alle Zahlungsbedingungen) |
| Fälligkeit | BT-9 | `STL/ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime/udt:DateTimeString` | nein | wie BT-2; bei mehreren gilt das früheste |
| Bruttobetrag | BT-112 | `STL/ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:GrandTotalAmount` | ja | `^[0-9]+(\.[0-9]{1,2})?$` und > 0 |
| Zahlbetrag | BT-115 | `STL/ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:DuePayableAmount` | ja | `^[0-9]+(\.[0-9]{1,2})?$` |

Weitere KO-1-Codes aus anderen Schritten: `XML_MALFORMED`, `DTD_NOT_ALLOWED`, `UNSUPPORTED_SYNTAX` (FR-12, FR-13), `MUSTANG:<Regel-ID>` (3.7.1).

### 3.2 Konvention für Zahlungsangaben

Verbindlich für alle Rechnungen, Testrechnungen und Demos. **Geprüft am 30.10.2026 mit Mustang 2.26.0 gegen XRechnung 3.0: gültig, 0 Fehler** (Anhang A, Anhang B.1).

| Feld | Wert |
| --- | --- |
| BT-81 `PM/ram:TypeCode` | `ZZZ` (gegenseitig vereinbart; kein SEPA-Code, daher greift die IBAN-Regel BR-DE-19 nicht) |
| BT-82 `PM/ram:Information` | `cardano:<preprod\|mainnet>:<asset>`, `<asset>` = `ADA` oder `<policy-id 56 hex>` oder `<policy-id>.<asset-name hex, 0–64 Zeichen>` |
| BT-84 | in `ram:PayeePartyCreditorFinancialAccount/ram:ProprietaryID`, **nicht** in `ram:IBANID` |
| Lieferanten | verwenden eine **feste** Empfangsadresse (Begründung in 3.4) |
| Reserviert | BT-22-Einträge, die nach dem Trimmen mit `cardano-sig-` beginnen, sind Signatur-Einträge (Abschnitt 11). v1.0 prüft sie nicht, zählt sie nicht für I-5 und setzt `signature.status = "present_unverified"`. |

Prüfergebnis zur Einordnung: Steht die Adresse stattdessen in `ram:IBANID` mit Code `58`, meldet Mustang nur eine **Warnung** BR-DE-19 und bewertet die Rechnung trotzdem als gültig (Anhang B.2). Fehlt BT-84 bei `ZZZ`, meldet Mustang **keinen** Fehler; die Pflichtprüfung in 3.1 ist deshalb nötig.

### 3.3 Normalisierung und Hashing

**Basisfunktion `tokens(s)`**
1. Unicode-NFKD.
2. Alle Zeichen mit General Category Mark entfernen (`unicode_normalization::char::is_combining_mark`).
3. Kleinschreibung (`to_lowercase`).
4. `ß` durch `ss` ersetzen.
5. Jedes Zeichen außer `a`–`z` und `0`–`9` durch ein Leerzeichen ersetzen.
6. An Leerzeichen trennen, leere Teile verwerfen.

**Abgeleitete Funktionen**

| Funktion | Regel |
| --- | --- |
| `compact(s)` | `tokens(s)` ohne Trenner verbinden |
| `name(s)` | `tokens(s)`; dann Rechtsformen entfernen: Jede Zeile aus `data/legal-forms.json` ist eine Token-Folge; sortiert nach Token-Anzahl absteigend, dann alphabetisch; jedes Vorkommen als zusammenhängende Token-Folge wird entfernt; Durchläufe wiederholen, bis sich nichts mehr ändert; Rest ohne Trenner verbinden. Ist das Ergebnis leer, gilt `compact(s)`. |
| `vat(s)` | uppercase; alle Zeichen außer `A`–`Z` und `0`–`9` entfernen; Präfix `GR` → `EL` |
| `street(s)` | `compact(s)`, danach jedes `strasse` durch `str` ersetzen |
| `postal` | `street(BT-35) + "\|" + compact(BT-38) + "\|" + compact(BT-37) + "\|" + compact(BT-40)`; `null`, wenn BT-35, BT-38 und BT-37 alle fehlen |
| `email_domain` | BT-43; fehlt es, BT-34 nur bei `schemeID="EM"`. Getrimmt, lowercase, Teil nach dem letzten `@`, abschließender `.` entfernt. Kein `@` oder leer → `null` |
| `phone(s)` | getrimmt; `plus` = beginnt mit `+`; nur Ziffern behalten; ohne `plus` und mit führendem `00`: `plus` = wahr und `00` entfernen; weniger als 3 Ziffern → `null`; Ergebnis `"+" + Ziffern` oder `Ziffern` |
| `invoice_no(s)` | getrimmt, uppercase |
| `order_id(s)` | getrimmt, uppercase (für Vergleiche mit `open-orders.json`) |
| `amount(d)` | Dezimalzahl mit genau 2 Nachkommastellen, Punkt als Trenner, ohne Tausendertrenner (`1190.00`) |
| `phrase_text(s)` | `" " + tokens(s) mit einem Leerzeichen verbunden + " "` (für I-5) |

**HMAC.** `H(x) = "hmac:" + hex_lowercase(HMAC-SHA256(key, UTF-8(x)))`, `key` = hex-dekodierter `SNIFFER_HMAC_KEY`.

| Hash | Eingabe `x` |
| --- | --- |
| `address_hash` | `"address:" + Adresse` (Adresse nach 3.4 Schritt 1) |
| `wallet_hash` | `"wallet:" + ("key"\|"script") + ":" + Payment-Credential als 56 Hex-Zeichen, lowercase` |
| `supplier_hash` | `"supplier:" + vat(BT-31)` |
| `name_hash` | `"name:" + name(BT-27)` |
| `email_domain_hash` | `"email:" + email_domain` |
| `phone_hash` | `"phone:" + phone(BT-42)` |
| `postal_hash` | `"postal:" + postal` |
| `invoice_hash` | `"invoice:" + vat(BT-31) + "\|" + invoice_no(BT-1) + "\|" + amount(BT-112) + "\|" + BT-2 als YYYY-MM-DD + "\|" + BT-3` |
| `pair_hash` | `"pair:" + supplier_hash + "\|" + wallet_hash` (jeweils mit Präfix `hmac:`) |

Ist eine Eingabe `null`, ist auch der Hash `null`.

**Testvektoren** (Key `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`; berechnet am 30.10.2026 mit einer Referenzimplementierung):

| Funktion | Eingabe | Ergebnis |
| --- | --- | --- |
| `name` | `Alpha Consulting GmbH` | `alphaconsulting` |
| `name` | `Müller & Söhne GmbH & Co. KG` | `mullersohne` |
| `name` | `ACME Ltd.` | `acme` |
| `name` | `AG` | `ag` |
| `name` | `E.K. Schmidt e.K.` | `schmidt` |
| `name` | `Bäckerei Groß UG (haftungsbeschränkt)` | `backereigross` |
| `name` | `Polski Handel Sp. z o.o.` | `polskihandel` |
| `vat` | `de 111 111 111` | `DE111111111` |
| `vat` | `GR 123456789` | `EL123456789` |
| `vat` | `DE-111.111.111` | `DE111111111` |
| `phone` | `+49 89 1234567` | `+49891234567` |
| `phone` | `0049 (0)89 1234567` | `+490891234567` |
| `phone` | `089/1234567` | `0891234567` |
| `phone` | `12` | `null` |
| `postal` | `Musterstraße 1`, `80333`, `München`, `DE` | `musterstr1\|80333\|munchen\|de` |

| Hash | Eingabe `x` | Ergebnis |
| --- | --- | --- |
| `address_hash` | `address:addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c` | `hmac:123a45eab166d61361f307bfed62f81b4d440ea78738ddeddb584827ff9ecddd` |
| `wallet_hash` | `wallet:key:11111111111111111111111111111111111111111111111111111111` | `hmac:151a8655a43e64cd264a08914782a4813cf9813b24949412f1f2982d0dd5f090` |
| `supplier_hash` | `supplier:DE111111111` | `hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060` |
| `name_hash` | `name:alphaconsulting` | `hmac:ae9f9068ecda382921db60e08d7b63fddcb71b8cc6d7873b5f0144620728283e` |
| `email_domain_hash` | `email:alpha-consulting.example` | `hmac:e207dd8824dfc54c7f5e06c303bf8c75dcb27b34a79da1d36bf3a6d578ce2605` |
| `phone_hash` | `phone:+49891234567` | `hmac:0ec970e7ac952f9036af04d68f06a3eba01c1ba5af84190f62c8bb8146e65faf` |
| `postal_hash` | `postal:musterstr1\|80333\|munchen\|de` | `hmac:047e5c67e89c1fb3fbc09c001dd7fb73cedb6bbf8475270bac86aedfb40ca4fc` |
| `invoice_hash` | `invoice:DE111111111\|RE-2026-0412\|1190.00\|2026-10-28\|380` | `hmac:9c51f2952f2525e6f1b99c6e045bb9798402e583495892b9cdf1225aaba45886` |
| `pair_hash` | `pair:hmac:d88e…9060\|hmac:151a…f090` (die beiden vollständigen Werte oben) | `hmac:d0323c2f6d8cb2ac79d4051e884ae7693c08022489b933ddd84695829ec9f7fb` |

### 3.4 Zahlungsadresse und Wallet-Identität

Prüfung der Adresse aus BT-84, in dieser Reihenfolge; der erste Verstoß beendet die Prüfung mit KO-2 und dem genannten Code:

1. `a` = getrimmter Wert. Enthält `a` Groß- **und** Kleinbuchstaben → `MIXED_CASE`. Sonst `a` = lowercase(`a`).
2. `Address::from_bech32(a)` (pallas-addresses 1.4.0). Fehler → `BECH32_INVALID`.
3. Variante muss `Address::Shelley` sein. `Byron` oder `Stake` → `NOT_PAYMENT_ADDRESS`.
4. `typeid()` muss in {0, 1, 2, 3, 6, 7} liegen. 4 oder 5 (Pointer) → `POINTER_ADDRESS`.
5. `network()`: `EXPECTED_NETWORK=preprod` verlangt `Network::Testnet`, `mainnet` verlangt `Network::Mainnet`. Sonst → `NETWORK_MISMATCH`.
6. `to_bech32()` muss exakt `a` ergeben. Sonst → `NON_CANONICAL` (fängt z. B. einen HRP ab, der nicht zum Netzwerk passt).
7. Ergebnis: `address_type` = `base` (Typ 0–3) oder `enterprise` (Typ 6–7); `credential_type` = `script`, wenn `payment().is_script()`, sonst `key`; `credential_hex` = `payment().to_hex()`.

**Warum das Payment-Credential die Wallet-Identität ist (Sicherheitsentscheidung).** Eine Base-Adresse besteht aus Payment-Teil und Stake-Teil. Jeder kann eine Adresse bauen, die seinen eigenen Payment-Teil mit dem Stake-Teil einer fremden, vertrauenswürdigen Wallet kombiniert („mangled address“). Geld an diese Adresse kann nur der Besitzer des Payment-Teils ausgeben. Wäre der Stake-Teil die Identität, sähe eine solche Angreifer-Adresse aus wie die bekannte Wallet des Lieferanten, S-3 würde nicht feuern und die Rechnung könnte als Low durchgehen. Deshalb zählen für Identität, Vertrauen und Alter nur Payment-Credential bzw. Adresse. Folge: Eine neue Empfangsadresse derselben HD-Wallet gilt als neue Wallet. Deshalb gilt die Konvention „feste Empfangsadresse“ (3.2). Abnahmetest 16 sichert das ab.

Hinweis: Preprod und Preview teilen die Netzwerk-ID 0. KO-2 unterscheidet nur Testnet und Mainnet; eine Preview-Adresse hat auf Preprod keine Transaktionen (W-4).

### 3.5 Ablauf

| Schritt | Inhalt |
| --- | --- |
| 0 | **Request prüfen:** Token (FR-08), Content-Type, Body-Limit, JSON-Form, `xml`-Größe, `checked_at` (FR-01 bis FR-10). Fehler → HTTP-Fehler nach 5.1, nichts wird gespeichert. |
| 1 | **IDs:** `check_id` = `chk_` + ULID (26 Zeichen, Crockford-Base32, uppercase); `checked_at` nach FR-03. |
| 2 | **Parsen:** BOM entfernen, parsen, Wurzel prüfen (FR-11 bis FR-13). Fehler → KO-1, weiter mit Schritt 10 (`invoice`, `supplier`, `wallet`, `pair`, `signature` = `null`; Mustang und alle externen Quellen in `checks_skipped` mit Grund `ko`). |
| 3 | **Felder:** lesen und prüfen nach 3.1, Codes für KO-1 sammeln. |
| 4 | **Mustang** nach 3.7.1 (auch wenn Schritt 3 schon Codes gesammelt hat). |
| 5 | **Adresse** nach 3.4, sofern BT-84 vorhanden ist. |
| 6 | **Hashes** nach 3.3, soweit die Eingaben gültig sind. `invoice_hash` braucht gültige BT-31, BT-1, BT-112, BT-2 und BT-3; `wallet_hash` eine gültige Adresse; `pair_hash` beide Hashes. Ist `invoice_hash` vorhanden: Redis `SET sniffer:lock:invoice:<invoice_hash> 1 NX PX 120000`. Wird die Sperre nicht gesetzt → 409 `check_in_progress`, nichts wird gespeichert. Die Sperre wird am Ende jedes Pfads gelöscht. |
| 7 | **Datenbank lesen:** `subjects` für `wallet_hash`, `supplier_hash`, `pair_hash`; Frische der Sanktionsliste (FR-72). Danach KO-3, KO-4, KO-6, soweit ihre Eingaben vorhanden sind. |
| 8 | **Bei K.O.:** Blockfrost, VIES und Chainabuse kommen mit Grund `ko` in `checks_skipped`; weiter mit Schritt 10. |
| 9 | **Daten laden, parallel:** Datenbank (letzte freigegebene Rechnung des Lieferanten, Anzahl früherer Rechnungen des Lieferanten, Beträge freigegebener EUR-Rechnungen), Blockfrost (3.7.2), VIES (3.7.3; nur bei EU-Präfix, sonst `checks_skipped` mit Grund `not_applicable`), Chainabuse (3.7.4). Danach alle Punkte-Kriterien in Katalogreihenfolge, danach die Reducer. |
| 10 | **Score, Band, Gründe, Aufträge** nach 3.8. |
| 11 | **Ergebnis bauen** nach Abschnitt 4. |
| 12 | **Speichern** in einer Transaktion (FR-63): `checks`-Zeile; `invoices`-Zeile und Entscheidung nach der Tabelle unten; Redis `SET sniffer:xml:<check_id> <xml> EX XML_TTL_SECONDS`; Commit. Sperre löschen, Antwort 200. |

| Ergebnis | `invoices`-Zeile | `final_decision` / `final_reason_type` | Zähler (5.4) |
| --- | --- | --- | --- |
| K.O. mit KO-3 | keine | – | keine |
| K.O. nur mit KO-1 und/oder KO-2 | keine | – | keine |
| K.O. mit KO-4 oder KO-6 (ohne KO-3), `invoice_hash`, `supplier_hash`, `wallet_hash`, `pair_hash` und `name_hash` vorhanden | ja | `rejected` / `risk` | wallet, pair: `rejected_risk + 1` |
| K.O. mit KO-4 oder KO-6, aber einer dieser Hashes fehlt | keine | – | keine |
| High durch Score | ja | `rejected` / `risk` | wallet, pair: `rejected_risk + 1` |
| Medium | ja | `NULL` / `NULL` | keine |
| Low | ja | `approved` / `NULL` | wallet, supplier, pair: `approved + 1` |

Bei automatischen Entscheidungen gilt: `decided_by = 'initial_check'`, `decided_at` = `checked_at`, `final_block_wallet = false`, `final_decline_reasons` = `summary.decline_reasons` (High) bzw. `NULL` (Low).

### 3.6 Kriterienkatalog

#### 3.6.0 Trait und Registry

```rust
pub trait Criterion: Send + Sync {
    /// ID wie in config/criteria.json, z. B. "S-3".
    fn id(&self) -> &'static str;
    /// Liefert Some(Finding), wenn das Kriterium feuert.
    fn evaluate(&self, ctx: &CheckContext, cfg: &CriterionConfig) -> Option<Finding>;
}

pub struct Finding {
    pub points: i32,      // aus cfg (bei W-2 aus den Stufen)
    pub evidence: String, // nach Muster unten
}
```

`CheckContext` enthält die geprüften Felder, das Adressergebnis, die Hashes, die gelesenen `subjects`, die Datenbankabfragen aus Schritt 9, die Ergebnisse der externen Quellen und `checked_at`. Die Registry hält die Kriterien in Katalogreihenfolge (Reihenfolge in `config/criteria.json`). Beim Start muss jede Registry-ID genau einen Config-Eintrag haben und umgekehrt (FR-80).

Begriffe: **effektiver Vertrauenswert** = `-1`, wenn `status = 'blocked'`, sonst `trust`; fehlender Eintrag = `0`. **bekannt** = Eintrag mit `approved ≥ 1`. **Paar-Freigaben** = `approved` des Paar-Eintrags, fehlend = 0. **Prüfdatum** nach FR-03.

#### 3.6.1 K.O.-Kriterien (`kind = "ko"`, je 100 Punkte)

| ID | Bedingung | Evidenz | `reason_type` |
| --- | --- | --- | --- |
| KO-1 | Codes aus Schritt 2, 3 oder 4 | Codes mit `, ` verbunden, z. B. `MISSING_FIELD:BT-84, MUSTANG:BR-DE-15` | formal |
| KO-2 | Verstoß in 3.4 | Code, z. B. `NETWORK_MISMATCH` | formal |
| KO-3 | `invoice_hash` existiert in `invoices` | `duplicate of <check_id der vorhandenen Zeile>` | formal |
| KO-4 | Wallet-Eintrag `blocked` mit `block_source = 'OFAC'` **oder** `name(BT-27)` steht in `sanction_names` | `wallet on OFAC SDN list` und/oder `seller name matches OFAC SDN entry`, mit `; ` verbunden | risk |
| KO-6 | Wallet- oder Lieferanten-Eintrag `blocked` mit `block_source = 'internal'` | `wallet blocked (<block_reason>)` und/oder `supplier blocked (<block_reason>)`, mit `; ` verbunden | risk |

KO-5 aus dem Design ist in KO-4 aufgegangen; die ID bleibt frei.

#### 3.6.2 Lieferant und Identität

| ID | Pkt | Bedingung | Evidenz | Agent |
| --- | --- | --- | --- | --- |
| S-1 | 35 | Wallet bekannt **und** Paar-Freigaben = 0 | `wallet approved <n>x, never for this supplier` | research |
| S-2 | 35 | VIES-Ergebnis `valid = false` | `VIES: invalid` | research |
| S-3 | 25 | Lieferant bekannt **und** Paar-Freigaben = 0 | `supplier approved <n>x, never with this wallet` | wallet |
| S-4 | 15 | BT-40 steht in `data/high-risk-countries.json` | `BT-40 <CC> on high-risk list (as of <as_of>)` | research |
| S-7 | 10 | Lieferant bekannt **und** bei der letzten freigegebenen Rechnung des Lieferanten (`final_decision = 'approved'`, sortiert nach `issue_date` absteigend, dann `created_at` absteigend) weicht mindestens einer von `name_hash`, `email_domain_hash`, `phone_hash`, `postal_hash` ab; verglichen werden nur Felder, die in beiden vorhanden sind | `changed vs last approved invoice: <Felder>`, Felder aus `name`, `email_domain`, `phone`, `postal_address` in dieser Reihenfolge | research |
| S-8 | 5 | `email_domain` steht in `data/freemail-domains.json` (exakter Vergleich) | `free-mail domain in <BT-43\|BT-34>` | research |
| S-9 | 5 | Es gibt keine `invoices`-Zeile mit diesem `supplier_hash` | `no previous invoice from this supplier` | research |

#### 3.6.3 Wallet und On-Chain

| ID | Pkt | Bedingung | Evidenz | Agent |
| --- | --- | --- | --- | --- |
| W-1 | 30 | Chainabuse: mindestens ein Report mit `trusted = true` oder `checked = true` | `chainabuse: <count> report(s), <m> trusted or checked` | wallet |
| W-2 | 15 / 8 | Adresse hat Transaktionen; Alter = ganze Tage `floor((checked_at − erste Transaktion) / 86400 s)`, negative Werte zählen als 0. Alter < 7 → 15; 7 ≤ Alter < 30 → 8 | `first transaction <YYYY-MM-DD>, <age> days before check` | wallet |
| W-4 | 10 | Adresse hat keine Transaktion | `no transactions on this address` | wallet |
| W-6 | 10 | Chainabuse: mindestens ein Report, keiner `trusted` oder `checked` | `chainabuse: <count> unverified report(s)` | wallet |

#### 3.6.4 Rechnungsinhalt

Kriterien mit EUR-Beträgen (I-2, I-4, I-10) werden nur bei BT-5 = `EUR` ausgewertet; sonst steht `CURRENCY_NOT_EUR` in `checks_incomplete`.

| ID | Pkt | Bedingung | Evidenz | Agent |
| --- | --- | --- | --- | --- |
| I-2 | 20 | (effektiver Wallet-Vertrauenswert ≤ 0 **und** BT-112 > `new_wallet_limit_eur`) **oder** BT-112 > `max_invoice_eur` | `amount <a> EUR > limit <l> EUR (wallet trust <t>)` | invoice |
| I-3 | 15 | `name(BT-44)` ≠ `name(buyer.name)` **oder** (BT-48 vorhanden **und** `vat(BT-48)` ≠ `vat(buyer.vat_id)`) **oder** (BT-53 vorhanden **und** getrimmte BT-53 ≠ `buyer.postcode`); Stammdaten aus `data/buyer-master.json` | `buyer mismatch: <Felder>` aus `name`, `vat_id`, `postcode` | invoice |
| I-4 | 10 | Lieferant hat ≥ `median_min_invoices` freigegebene EUR-Rechnungen **und** BT-112 > `median_factor` × Median ihrer Beträge (gerade Anzahl: Mittel der beiden mittleren Werte) | `amount <a> EUR > <f> x median <m> EUR (<n> invoices)` | invoice |
| I-5 | 10 | `phrase_text` eines Textes aus BT-22 (ohne Signatur-Einträge), BT-20 oder BT-83 enthält `phrase_text` eines Eintrags aus `data/pressure-words.json` | `pressure wording: <Treffer, normalisiert, alphabetisch, eindeutig, mit ", ">` | invoice |
| I-6 | 8 | BT-2 > Prüfdatum **oder** BT-2 < Prüfdatum − `issue_date_max_age_days` Tage | `BT-2 <date>, check date <date>` | invoice |
| I-7 | 8 | BT-9 vorhanden **und** (BT-9 − BT-2) in Tagen < `due_min_days` | `BT-2 <date>, BT-9 <date> (<n> days)` | invoice |
| I-8 | 8 | BT-13 fehlt **oder** es gibt in `data/open-orders.json` keinen Eintrag mit `order_id(order_id) = order_id(BT-13)` und `vat(supplier_vat_id) = vat(BT-31)` | `BT-13 empty` bzw. `BT-13 not an open order of this supplier` | invoice |
| I-10 | 5 | BT-112 ist ein ganzzahliges Vielfaches von `round_amount_multiple_eur` **oder** es gibt eine Schwelle `t` aus `approval_thresholds_eur` mit `t × (100 − threshold_margin_percent) / 100 ≤ BT-112 < t` | `amount <a> EUR is a multiple of <m> EUR` bzw. `amount <a> EUR within <p>% below threshold <t> EUR` | invoice |
| I-11 | 5 | Mindestens eins: BT-81 ≠ `ZZZ`; BT-82 fehlt; BT-82 passt nicht zu `^cardano:(preprod\|mainnet):(ADA\|[0-9a-f]{56}(\.[0-9a-f]{0,64})?)$`; Netzwerk in BT-82 ≠ `EXPECTED_NETWORK` | Gründe mit `; ` verbunden: `BT-81 <code> (expected ZZZ)`, `BT-82 missing`, `BT-82 malformed`, `BT-82 network <x> (expected <y>)` | invoice |
| I-12 | 0 | BT-3 = `384` (Korrekturrechnung); erzwingt mindestens Medium | `BT-3 384 (corrected invoice)` | invoice |

#### 3.6.5 Reducer (`kind = "reducer"`)

| ID | Pkt | Bedingung | Evidenz |
| --- | --- | --- | --- |
| T-1 | −15 | effektiver Wallet-Vertrauenswert ≥ `wallet_trust_reducer_min` (0.500) | `wallet trust <t>` |
| T-2 | −10 | Paar-Freigaben ≥ `pair_reducer_min_approved` (3) | `pair approved <n>x` |
| T-3 | −10 | BT-13 vorhanden und es gibt den passenden Eintrag aus I-8 | `BT-13 matches an open order of this supplier` |
| T-4 | −5 | VIES-Ergebnis `valid = true` | `VIES: valid` |

### 3.7 Externe Quellen

Alle HTTP-Aufrufe: Timeout `HTTP_TIMEOUT_MS`, kein automatischer Retry. Die Basis-URLs sind über Umgebungsvariablen änderbar (6.1), damit Tests gegen `wiremock` laufen.

#### 3.7.1 Mustang

| Modus | Verhalten |
| --- | --- |
| `cli` | Aufruf wie unten |
| `off` | kein Aufruf; `MUSTANG_UNAVAILABLE`; `validation.status = "off"` |
| `mock_valid` | nur für Tests: Ergebnis gültig, 0 Fehler, `tool_version = "mock"` |

Aufruf im Modus `cli`:
1. Das XML (nach BOM-Entfernung) wird in eine temporäre Datei geschrieben (Rechte 0600) und nach dem Aufruf in jedem Fall gelöscht.
2. Befehl: `<JAVA_BIN> -Xmx1G -Dfile.encoding=UTF-8 -jar <MUSTANG_JAR> --no-notices --action validate --source <datei>`; stdin geschlossen; stdout und stderr getrennt lesen. stderr enthält nur Logzeilen und wird verworfen.
3. Timeout `MUSTANG_TIMEOUT_MS`: Prozess beenden → `MUSTANG_UNAVAILABLE`.
4. Exit-Code muss 0 (gültig) oder 255 (ungültig) sein, sonst `MUSTANG_UNAVAILABLE`.
5. Aus stdout den Teil vom ersten `<validation` bis zum letzten `</validation>` mit `roxmltree` parsen. Fehler → `MUSTANG_UNAVAILABLE`.
6. Enthält der Bericht ein Element `exception` → `MUSTANG_UNAVAILABLE`.
7. Fehler = alle Elemente mit lokalem Namen `error`. Elemente `warning` und `notice` werden ignoriert.
8. Regel-ID je Fehler: erster Treffer von `\[ID ([A-Za-z0-9_.-]+)\]` im Elementtext; sonst `^\s*\[([A-Za-z0-9_.-]+)\]`; sonst `TYPE-<Attribut type>`; sonst `UNSPECIFIED`.
9. Regel-IDs aus `MUSTANG_RULE_WHITELIST` werden entfernt und in `whitelisted_rules` aufgeführt (eindeutig, in Berichtsreihenfolge).
10. Bleiben Fehler übrig → KO-1 mit je `MUSTANG:<Regel-ID>` (eindeutig, Berichtsreihenfolge). Meldet `validation/summary/@status` `invalid`, gibt es aber kein `error`-Element und keinen whitelisteten Fehler → KO-1 `MUSTANG:UNSPECIFIED`.
11. `validation.status` = `valid`, `invalid` oder `unavailable`; `tool_version` aus `validator/@version`.

Geprüftes Verhalten (Anhang B): gültig → Exit 0, Dauer ca. 1 s; Fehler BR-DE-15 → Exit 255, Text `[BR-DE-15] … [ID BR-DE-15] from …`; Rechnung ohne XML-Deklaration oder mit BOM → gültig.

#### 3.7.2 Blockfrost (Code bei Ausfall: `BLOCKFROST_UNAVAILABLE`; betrifft W-2, W-4)

- Basis-URL: `BLOCKFROST_BASE_URL`, Standard `https://cardano-preprod.blockfrost.io/api/v0` bei `preprod`, `https://cardano-mainnet.blockfrost.io/api/v0` bei `mainnet`.
- Anfrage: `GET <base>/addresses/<Adresse>/transactions?order=asc&count=1&page=1` mit Header `project_id: <BLOCKFROST_PROJECT_ID>`.
- `200` mit leerem Array oder `404` → keine Transaktion. `200` mit einem Element → erste Transaktion = `block_time` (UNIX-Sekunden). Jede andere Antwort, Timeout oder ungültiges JSON → Ausfall.
- Cache-Wert: `{"first_tx_time": <unix>|null}`.
- Rate-Limit laut Blockfrost: 10 Anfragen/s, Burst 500; ein Check stellt eine Anfrage.

#### 3.7.3 VIES (Code bei Ausfall: `VIES_UNAVAILABLE`; betrifft S-2, T-4)

- Nur wenn die ersten zwei Zeichen von `vat(BT-31)` einer von `AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK XI` sind; sonst `checks_skipped` mit Grund `not_applicable`.
- Basis-URL: `VIES_BASE_URL`, Standard `https://ec.europa.eu/taxation_customs/vies/rest-api`.
- Anfrage: `GET <base>/ms/<Länderpräfix>/vat/<Rest der USt-ID>`.
- Auswertung bei HTTP 200: Feld `userError` = `VALID` → gültig; `INVALID` oder `INVALID_INPUT` → ungültig; jeder andere Wert (z. B. `MS_UNAVAILABLE`, `TIMEOUT`, `SERVICE_UNAVAILABLE`, `MS_MAX_CONCURRENT_REQ`, `GLOBAL_MAX_CONCURRENT_REQ`) → Ausfall. Jeder andere HTTP-Status oder Timeout → Ausfall.
- Geprüfte Antwortform (30.10.2026, ungültige Nummer): `{"isValid": false, "requestDate": "…", "userError": "INVALID", "name": "---", "address": "---", …}`.
- Cache-Wert: `{"valid": true|false}`.

#### 3.7.4 Chainabuse (Code bei Ausfall: `CHAINABUSE_UNAVAILABLE`; betrifft W-1, W-6)

- Basis-URL: `CHAINABUSE_BASE_URL`, Standard `https://api.chainabuse.com/v0`.
- Anfrage: `GET <base>/reports?address=<Adresse>&page=1&perPage=50`, HTTP Basic Auth mit `CHAINABUSE_API_KEY` als Benutzername **und** Passwort (die Anleitung von Chainabuse nennt beide Felder).
- Antwort 200: `{"reports": [ … ], "count": <n>}`. Ausgewertet werden die bis zu 50 Reports der ersten Seite: `reports` = `count`; `trusted_or_checked` = Anzahl Reports mit `trusted == true` oder `checked == true`.
- Jede andere Antwort, Timeout oder ungültiges JSON → Ausfall.
- Hinweis: Die API hat kein Konfidenz-Feld. W-1 und W-6 nutzen deshalb `trusted` und `checked`.
- Cache-Wert: `{"reports": <n>, "trusted_or_checked": <m>}`.

#### 3.7.5 OFAC-SDN-Import

1. `GET <OFAC_SDN_URL>`, Standard `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` (antwortet mit Redirect auf einen Download; Redirects folgen), Timeout 120 s, höchstens 200 MB.
2. Streaming-Parse mit `quick-xml`; Elemente werden über ihren **lokalen Namen** erkannt (Namespace ignorieren). Je `sdnEntry`: `uid`, `sdnType`, `firstName`, `lastName`, alle `akaList/aka` (`firstName`, `lastName`), alle `idList/id` (`idType`, `idNumber`).
3. Namen: Bei `sdnType` ≠ `Individual` `name(lastName)` je Haupt- und aka-Eintrag. Bei `Individual` je Haupt- und aka-Eintrag `name(firstName + " " + lastName)` und `name(lastName + " " + firstName)`. Namen mit weniger als 4 Zeichen nach Normalisierung werden verworfen.
4. Adressen: `idType` beginnt mit `Digital Currency Address - `: `idNumber` nach 3.4 Schritt 1–3 prüfen, ohne Netzwerkprüfung. Gültige Shelley-Adressen ergeben einen `wallet_hash`; alle anderen Einträge werden übersprungen.
5. Plausibilität: Weniger als 1000 `sdnEntry` → Abbruch ohne Änderung, Fehler im Log.
6. In einer Transaktion: `sanction_names` mit `source = 'OFAC'` ersetzen; Wallets mit `block_source = 'OFAC'`, die nicht mehr gelistet sind, auf `status = 'normal'` setzen (Felder `block_*` leeren); gelistete Wallets per Upsert sperren, wobei eine interne Sperre bestehen bleibt; `list_updates` für `OFAC` aktualisieren (`last_success_at`, `entries`, `cardano_addresses`).

Ob die SDN-Liste derzeit Cardano-Adressen enthält, ist für die Umsetzung unerheblich. Der Import findet sie, falls vorhanden; für Demos werden Sperren über `seed` oder `blocklist-add` gesetzt.

#### 3.7.6 Mock-Modi (Demo)

`BLOCKFROST_MODE`, `VIES_MODE`, `CHAINABUSE_MODE` = `api` oder `mock`. Im Modus `mock` werden Dateien aus `data/` gelesen (6.3), nichts zwischengespeichert, keine Netzwerkanfragen gestellt. Die Antworten werden so behandelt, als kämen sie aus der API. Tests nutzen den Modus `api` gegen `wiremock`.

### 3.8 Score, Reducer, Band, Gründe, Aufträge

1. **Punkte:** K.O.-Kriterien je `ko_points` (100); sonst `points` aus der Config.
2. **Reducer** werden nur angewendet, wenn kein K.O. vorliegt **und** kein gefeuertes Kriterium mindestens `reducers_blocked_by_points` (25) Punkte hat. Reihenfolge T-1, T-2, T-3, T-4. Budget `reducer_cap` (25): Jeder gefeuerte Reducer erhält `−min(|Punkte|, Restbudget)`; ist das Budget erschöpft, wird er mit `0` Punkten und dem Zusatz ` (cap reached)` in der Evidenz trotzdem aufgeführt.
3. **Score:** `risk_score = clamp(Σ criteria.points + Σ reducers.points, 0, 100)`.
4. **Band** (erste zutreffende Regel):
   1. K.O. → `high`
   2. `risk_score ≥ high_min` (60) → `high`
   3. `risk_score ≥ medium_min` (20) → `medium`
   4. I-12 gefeuert → `medium`
   5. `checks_incomplete` enthält `MUSTANG_UNAVAILABLE`, `BLOCKFROST_UNAVAILABLE`, `SANCTIONS_LIST_STALE` oder `CURRENCY_NOT_EUR` → `medium`
   6. sonst `low`
5. **`decision`:** `low` → `approve`, `medium` → `review`, `high` → `decline`. `final` = wahr bei `low` und `high`.
6. **`reason_type`** (nur `high`): `risk`, wenn KO-4 oder KO-6 gefeuert hat oder das Band durch den Score entstand; sonst `formal`.
7. **Sortierung:** `criteria` nach Punkten absteigend, bei Gleichstand nach Katalogreihenfolge. `reducers` in Reihenfolge T-1 bis T-4. `checks_incomplete` alphabetisch. `checks_skipped` in der Reihenfolge MUSTANG, BLOCKFROST, VIES, CHAINABUSE.
8. **`decline_reasons`** (nur `high`): bei K.O. alle gefeuerten K.O.-Kriterien in Katalogreihenfolge; sonst die drei ersten Kriterien mit Punkten > 0 aus der sortierten Liste. Je Eintrag `{id, text: customer_text, evidence}`.
9. **`agent_tasks`** (nur `medium`): Für jedes gefeuerte Kriterium in Listenreihenfolge ein Eintrag `{source: <ID>, task: agent_task}` beim Agenten des Kriteriums; danach für jeden Code in `checks_incomplete` (alphabetisch) der Eintrag aus `incomplete_tasks`. Reducer erzeugen keine Aufträge. Bei `low` und `high` sind alle drei Listen leer.

### 3.9 Datenmodell

**Postgres.** Alle Tabellen liegen im Schema `sniffer`. Vor den Migrationen führt der Server `CREATE SCHEMA IF NOT EXISTS sniffer` aus; jede Verbindung setzt `SET search_path TO sniffer` (in `after_connect`). Migration `0001_init.sql`:

```sql
CREATE TABLE subjects (
  hash          text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('wallet', 'supplier', 'pair')),
  approved      integer NOT NULL DEFAULT 0 CHECK (approved >= 0),
  rejected_risk integer NOT NULL DEFAULT 0 CHECK (rejected_risk >= 0),
  trust         numeric(4,3) NOT NULL DEFAULT 0 CHECK (trust BETWEEN -1 AND 1),
  status        text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'blocked')),
  block_source  text CHECK (block_source IN ('OFAC', 'internal')),
  block_reason  text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  invoice_hash          text PRIMARY KEY,
  check_id              text NOT NULL UNIQUE,
  supplier_hash         text NOT NULL,
  wallet_hash           text NOT NULL,
  pair_hash             text NOT NULL,
  name_hash             text NOT NULL,
  email_domain_hash     text,
  phone_hash            text,
  postal_hash           text,
  amount                numeric(14,2) NOT NULL,
  currency              char(3) NOT NULL,
  issue_date            date NOT NULL,
  type_code             text NOT NULL,
  initial_band          text NOT NULL CHECK (initial_band IN ('low', 'medium', 'high')),
  initial_score         integer NOT NULL,
  final_decision        text CHECK (final_decision IN ('approved', 'rejected')),
  final_reason_type     text CHECK (final_reason_type IN ('risk', 'formal')),
  final_block_wallet    boolean,
  final_decline_reasons jsonb,
  decided_by            text CHECK (decided_by IN ('initial_check', 'agents', 'seed')),
  decided_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_supplier_idx ON invoices (supplier_hash, final_decision, issue_date DESC, created_at DESC);
CREATE INDEX invoices_wallet_idx ON invoices (wallet_hash);
CREATE INDEX invoices_created_idx ON invoices (created_at);

CREATE TABLE checks (
  check_id   text PRIMARY KEY,
  band       text NOT NULL CHECK (band IN ('low', 'medium', 'high')),
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_created_idx ON checks (created_at);

CREATE TABLE sanction_names (
  name_normalized text NOT NULL,
  source          text NOT NULL,
  sdn_uid         text NOT NULL,
  PRIMARY KEY (name_normalized, source, sdn_uid)
);

CREATE TABLE list_updates (
  source            text PRIMARY KEY,
  last_success_at   timestamptz NOT NULL,
  entries           integer NOT NULL,
  cardano_addresses integer NOT NULL
);
```

**Vertrauenswert:** `trust = clamp(round((approved − 3 × rejected_risk) / (approved + rejected_risk + 5), 3), −1, 1)`, berechnet in SQL (Postgres `round` rundet bei ,5 von null weg). Die Upserts stehen in 5.4.

**Redis.** Alle Schlüssel tragen das Präfix `sniffer:`, weil die Agenten dieselbe Instanz nutzen. Gecacht wird nur im Modus `api` und nur bei Erfolg.

| Schlüssel | Inhalt | TTL |
| --- | --- | --- |
| `sniffer:xml:<check_id>` | Original-XML (nach BOM-Entfernung) | `XML_TTL_SECONDS` |
| `sniffer:lock:invoice:<invoice_hash>` | `1` | 120 s |
| `sniffer:cache:bf:<address_hash>` | Blockfrost-Cache-Wert | 600 s |
| `sniffer:cache:vies:<supplier_hash>` | VIES-Cache-Wert | 86400 s |
| `sniffer:cache:ca:<address_hash>` | Chainabuse-Cache-Wert | 3600 s |

---

## 4. Ergebnis-JSON

`schema_version` = `"1.0"`. Beispiel: Abnahmetest 9 (Hashes gekürzt).

```json
{
  "schema_version": "1.0",
  "check_id": "chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W",
  "checked_at": "2026-10-30T12:00:00Z",
  "engine": { "version": "1.0.0", "config_sha256": "<sha256 von config/criteria.json>" },
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
    "invoice_hash": "hmac:…",
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
      "address_hash": "hmac:…",
      "wallet_hash": "hmac:…"
    },
    "order_reference": "PO-2026-001"
  },
  "supplier": {
    "supplier_hash": "hmac:…",
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
    "wallet_hash": "hmac:…",
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
  "pair": { "pair_hash": "hmac:…", "approved": 0, "rejected_risk": 0 },
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
}
```

**Feldreferenz**

| Feld | Typ | Regel |
| --- | --- | --- |
| `schema_version` | string | `"1.0"` |
| `check_id` | string | `chk_` + ULID |
| `checked_at` | string | RFC 3339 UTC, Sekunden, Suffix `Z` |
| `engine.version` | string | Paketversion aus `Cargo.toml` |
| `engine.config_sha256` | string | SHA-256 (hex) der Bytes von `config/criteria.json` |
| `summary.band` | string | `low` \| `medium` \| `high` |
| `summary.decision` | string | `approve` \| `review` \| `decline` |
| `summary.final` | bool | wahr bei `low` und `high` |
| `summary.reason_type` | string \| null | `risk` \| `formal` bei `high`, sonst `null` |
| `summary.risk_score` | int | 0–100 |
| `summary.ko_triggered` | bool | – |
| `summary.decline_reasons[]` | object | `{id, text, evidence}` (3.8) |
| `summary.checks_incomplete[]` | string | Codes aus 3.7 und 3.6.4, alphabetisch |
| `summary.checks_skipped[]` | object | `{source: MUSTANG\|BLOCKFROST\|VIES\|CHAINABUSE, reason: ko\|not_applicable}` |
| `invoice` | object \| null | `null` nur bei nicht parsebarem XML oder falscher Wurzel |
| `invoice.invoice_hash` | string \| null | `null`, wenn nicht berechenbar |
| `invoice.xml_ref` | string | `/v1/checks/<check_id>/xml` |
| `invoice.profile` | string \| null | BT-24 |
| `invoice.validation` | object | `tool` = `mustang`; `tool_version` \| null; `status` = `valid` \| `invalid` \| `unavailable` \| `off`; `errors` = Anzahl nicht-whitelisteter Fehler; `error_rules[]`; `whitelisted_rules[]` |
| `invoice.invoice_number` | string \| null | BT-1 getrimmt |
| `invoice.type_code` | string \| null | BT-3 |
| `invoice.issue_date`, `invoice.due_date` | string \| null | `YYYY-MM-DD` |
| `invoice.total`, `invoice.due_payable` | object \| null | `{amount: "<2 Nachkommastellen>", currency}` (Betrag als String) |
| `invoice.payment.means_code` | string \| null | BT-81 |
| `invoice.payment.network` | string \| null | `EXPECTED_NETWORK`, wenn die Adresse gültig ist |
| `invoice.payment.asset` | string \| null | aus BT-82, wenn das Muster passt |
| `invoice.payment.address_type` | string \| null | `base` \| `enterprise` |
| `invoice.payment.credential_type` | string \| null | `key` \| `script` |
| `invoice.payment.address_hash`, `wallet_hash` | string \| null | 3.3 |
| `invoice.order_reference` | string \| null | BT-13 getrimmt |
| `supplier` | object \| null | `null`, wenn `supplier_hash` fehlt |
| `supplier.country` | string \| null | BT-40 |
| `supplier.vat_country` | string | Präfix von `vat(BT-31)` |
| `supplier.vat_valid` | bool \| null | `null` bei Ausfall, `not_applicable` oder K.O. |
| `supplier.known`, `approved`, `trust`, `blocked` | – | aus `subjects`; `trust` als Zahl mit höchstens 3 Nachkommastellen |
| `supplier.first_invoice` | bool \| null | Bedingung von S-9; `null` bei K.O. |
| `wallet` | object \| null | `null`, wenn `wallet_hash` fehlt |
| `wallet.has_transactions`, `first_tx_at`, `age_days` | – \| null | `null` bei Ausfall oder K.O. |
| `wallet.chainabuse` | object \| null | `null` bei Ausfall oder K.O. |
| `pair` | object \| null | `null`, wenn `pair_hash` fehlt |
| `signature` | object \| null | `null` nur, wenn `invoice` `null` ist; sonst `status` = `absent` \| `present_unverified`, übrige Felder `null` |
| `criteria[]` | object | `{id, name, points, evidence, agent}`; `agent` = `invoice` \| `wallet` \| `research` |
| `reducers[]` | object | `{id, name, points, evidence}` |
| `agent_tasks` | object | immer alle drei Schlüssel `invoice`, `wallet`, `research`, je Liste von `{source, task}` |

**Erweiterbarkeit (verbindlich für alle Folgestufen)**
- `criteria[].id`, `reducers[].id` und `agent_tasks[].source` sind freie Strings, keine feste Liste (Rust: `String`, kein `enum`). Folgestufen verarbeiten Kriterien allgemein über `id`, `name`, `points`, `evidence`, `agent` und dürfen nicht an einzelnen IDs hängen.
- `agent` ist einer von `invoice`, `wallet`, `research`. Ein neuer Agent erfordert eine neue Major-Version.
- Den Agenten `research` bedient der **Supplier Investigator**. Er übernimmt alle Lieferanten- und Identitätsprüfungen (S-1, S-2, S-4, S-7, S-8, S-9, KO-4, KO-6, `SANCTIONS_LIST_STALE`, `VIES_UNAVAILABLE`).
- Konsumenten ignorieren unbekannte Felder (in Rust kein `#[serde(deny_unknown_fields)]` auf Ergebnis-Structs). Neue Felder erhöhen die Minor-Version (`1.0` → `1.1`), Umbenennen oder Entfernen die Major-Version.
- Der Block `signature` ist für die Wallet-Signatur reserviert (Abschnitt 11). Spätere Werte: `status` zusätzlich `valid` \| `invalid` \| `foreign_key`; `scheme` z. B. `cip8-v1`; `key_hash` = `hmac:…`; `matches_known_key` = `true` \| `false`.

---

## 5. Endpunkte und Entscheidungslogik

### 5.1 Fehlercodes

| HTTP | `error` | Wann |
| --- | --- | --- |
| 400 | `invalid_request` | Body kein JSON, falsche Typen, unbekannte Felder, ungültiges `checked_at`, ungültige Felder in `/v1/decisions` |
| 400 | `checked_at_not_allowed` | `checked_at` gesetzt bei `ALLOW_CHECKED_AT=false` |
| 400 | `forbidden_wording` | `decline_reasons[].text` enthält `betrug` oder `fraud` (ohne Groß-/Kleinschreibung) |
| 401 | `unauthorized` | Token fehlt oder falsch |
| 404 | `not_found` | `check_id` unbekannt; bei `/v1/decisions` auch, wenn es zum Check keine `invoices`-Zeile gibt |
| 409 | `check_in_progress` | Sperre für diesen `invoice_hash` besteht |
| 409 | `not_pending` | `/v1/decisions` für einen Check, dessen Band nicht `medium` ist |
| 409 | `already_decided` | `/v1/decisions` mit anderem Inhalt als die bereits gespeicherte Entscheidung |
| 410 | `xml_expired` | XML liegt nicht mehr in Redis |
| 413 | `payload_too_large` / `xml_too_large` | FR-10 |
| 415 | `unsupported_media_type` | Content-Type nicht `application/json` |
| 503 | `dependency_unavailable` | Postgres oder Redis nicht erreichbar, Commit gescheitert |

### 5.2 `GET /v1/checks/{check_id}`

Antwort 200:
```json
{ "result": { "…": "gespeichertes Ergebnis-JSON, unverändert" },
  "decision_state": { "final_decision": "approved", "final_reason_type": null, "final_block_wallet": false,
                      "final_decline_reasons": null, "decided_by": "agents", "decided_at": "2026-10-30T12:05:00Z" } }
```
`decision_state` ist `null`, wenn es keine `invoices`-Zeile gibt (formaler K.O. oder Duplikat). Unbekannte ID → 404.

### 5.3 `GET /v1/checks/{check_id}/xml`

200 mit `Content-Type: application/xml; charset=utf-8` und dem XML aus Redis. Unbekannte ID → 404 `not_found`; ID bekannt, aber Schlüssel abgelaufen → 410 `xml_expired`.

### 5.4 `POST /v1/decisions`

Request:
```json
{
  "check_id": "chk_…",
  "decision": "rejected",
  "reason_type": "risk",
  "block_wallet": true,
  "decline_reasons": [ { "id": "S-3", "text": "Die Zahlungsadresse weicht von allen bisherigen Rechnungen dieses Rechnungsstellers ab.", "evidence": "supplier approved 6x, never with this wallet" } ]
}
```

| Feld | Regel |
| --- | --- |
| `check_id` | Pflicht |
| `decision` | `approved` \| `rejected` |
| `reason_type` | bei `rejected` Pflicht: `risk` \| `formal`; bei `approved` muss es `null` sein oder fehlen |
| `block_wallet` | bool, Standard `false`; `true` nur bei `rejected` + `risk` erlaubt |
| `decline_reasons` | bei `rejected` Pflicht, 1–10 Einträge `{id, text, evidence}`, `id` und `text` nicht leer, `text` und `evidence` je höchstens 500 Zeichen; bei `approved` leer oder fehlend |

Ablauf in einer Transaktion (`SELECT … FOR UPDATE` auf die `invoices`-Zeile):
1. Keine `invoices`-Zeile zum `check_id` → 404.
2. `initial_band` ≠ `medium` → 409 `not_pending`.
3. `final_decision` ist gesetzt: stimmt der Request in `decision`, `reason_type`, `block_wallet` und `decline_reasons` (gleiche Einträge in gleicher Reihenfolge) überein → 200 mit dem gespeicherten Stand (idempotent); sonst 409 `already_decided`.
4. `final_decision`, `final_reason_type`, `final_block_wallet`, `final_decline_reasons`, `decided_by = 'agents'`, `decided_at = now()` setzen.
5. Zähler ändern:

| Entscheidung | wallet | pair | supplier |
| --- | --- | --- | --- |
| `approved` | `approved + 1` | `approved + 1` | `approved + 1` |
| `rejected` / `risk` | `rejected_risk + 1` | `rejected_risk + 1` | – |
| `rejected` / `formal` | – | – | – |

Der Lieferant wird bei `risk` nicht belastet, weil sich ein Angreifer als echter Lieferant ausgeben kann.

6. `block_wallet = true` → Wallet sperren (`block_reason = 'AGENT_DECISION'`).

Antwort 200: `{"check_id", "final_decision", "final_reason_type", "decided_by", "decided_at"}`.

SQL (je Subjekt `$1` = Hash, `$2` = Typ):
```sql
-- approved + 1
INSERT INTO subjects (hash, type, approved, rejected_risk, trust, updated_at)
VALUES ($1, $2, 1, 0, round(1::numeric / 6, 3), now())
ON CONFLICT (hash) DO UPDATE SET
  approved   = subjects.approved + 1,
  trust      = greatest(-1, least(1, round(((subjects.approved + 1) - 3 * subjects.rejected_risk)::numeric
                 / ((subjects.approved + 1) + subjects.rejected_risk + 5), 3))),
  updated_at = now();

-- rejected_risk + 1
INSERT INTO subjects (hash, type, approved, rejected_risk, trust, updated_at)
VALUES ($1, $2, 0, 1, round(-3::numeric / 6, 3), now())
ON CONFLICT (hash) DO UPDATE SET
  rejected_risk = subjects.rejected_risk + 1,
  trust         = greatest(-1, least(1, round((subjects.approved - 3 * (subjects.rejected_risk + 1))::numeric
                    / (subjects.approved + (subjects.rejected_risk + 1) + 5), 3))),
  updated_at    = now();

-- Sperre (Wallet oder Lieferant); eine OFAC-Sperre bleibt OFAC
INSERT INTO subjects (hash, type, status, block_source, block_reason, updated_at)
VALUES ($1, $2, 'blocked', 'internal', $3, now())
ON CONFLICT (hash) DO UPDATE SET
  status       = 'blocked',
  block_source = CASE WHEN subjects.block_source = 'OFAC' THEN 'OFAC' ELSE 'internal' END,
  block_reason = CASE WHEN subjects.block_source = 'OFAC' THEN subjects.block_reason ELSE $3 END,
  updated_at   = now();
```

### 5.5 `GET /health`

200 `{"status": "ok", "postgres": "ok", "redis": "ok", "sanctions_list_age_hours": <int|null>}`; ist Postgres oder Redis nicht erreichbar, 503 mit `"status": "degraded"` und `"error"` beim betroffenen Dienst.

---

## 6. Konfiguration

### 6.1 Umgebungsvariablen (`.env`)

| Variable | Standard | Pflicht / Regel |
| --- | --- | --- |
| `SNIFFER_BIND_ADDR` | `0.0.0.0:8080` | – |
| `SNIFFER_API_TOKEN` | – | Pflicht, mindestens 32 Zeichen |
| `SNIFFER_HMAC_KEY` | – | Pflicht, hex, mindestens 64 Zeichen; erzeugen mit `openssl rand -hex 32` |
| `DATABASE_URL` | – | Pflicht |
| `REDIS_URL` | – | Pflicht |
| `EXPECTED_NETWORK` | `preprod` | `preprod` \| `mainnet` |
| `BLOCKFROST_MODE` | `api` | `api` \| `mock` |
| `BLOCKFROST_PROJECT_ID` | – | Pflicht bei `api` |
| `BLOCKFROST_BASE_URL` | nach Netzwerk (3.7.2) | – |
| `VIES_MODE` | `api` | `api` \| `mock` |
| `VIES_BASE_URL` | `https://ec.europa.eu/taxation_customs/vies/rest-api` | – |
| `CHAINABUSE_MODE` | `mock` | `api` \| `mock` |
| `CHAINABUSE_API_KEY` | – | Pflicht bei `api` |
| `CHAINABUSE_BASE_URL` | `https://api.chainabuse.com/v0` | – |
| `MUSTANG_MODE` | `cli` | `cli` \| `off` \| `mock_valid` |
| `JAVA_BIN` | `java` | – |
| `MUSTANG_JAR` | `/opt/mustang/Mustang-CLI-2.26.0.jar` | muss bei `cli` existieren |
| `MUSTANG_RULE_WHITELIST` | leer | Regel-IDs, kommagetrennt |
| `MUSTANG_TIMEOUT_MS` | `20000` | – |
| `MUSTANG_MAX_PARALLEL` | `2` | ≥ 1 |
| `HTTP_TIMEOUT_MS` | `5000` | – |
| `XML_TTL_SECONDS` | `86400` | – |
| `MAX_XML_BYTES` | `500000` | – |
| `OFAC_SDN_URL` | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` | – |
| `OFAC_AUTO_UPDATE` | `true` | `true` \| `false` |
| `LISTS_REFRESH_HOURS` | `12` | – |
| `LISTS_MAX_AGE_HOURS` | `48` | – |
| `ALLOW_CHECKED_AT` | `false` | `true` nur in Tests |
| `RETENTION_DAYS` | `730` | – |
| `CONFIG_DIR` | `./config` | – |
| `DATA_DIR` | `./data` | – |
| `RUST_LOG` | `info` | – |

`.env.example` enthält alle Variablen ohne Geheimnisse. `.env` wird nie committet.

### 6.2 `config/criteria.json`

Alle Punkte, Schwellen und Texte. Die Reihenfolge von `criteria` ist die Katalogreihenfolge. Beträge und Vertrauenswerte stehen als Strings (exakte Dezimalwerte).

```json
{
  "version": "1.0.0",
  "bands": { "medium_min": 20, "high_min": 60 },
  "ko_points": 100,
  "reducer_cap": 25,
  "reducers_blocked_by_points": 25,
  "params": {
    "new_wallet_limit_eur": "1000.00",
    "max_invoice_eur": "10000.00",
    "round_amount_multiple_eur": "100.00",
    "approval_thresholds_eur": ["1000.00", "5000.00", "10000.00"],
    "threshold_margin_percent": 5,
    "median_factor": 3,
    "median_min_invoices": 3,
    "issue_date_max_age_days": 90,
    "due_min_days": 3,
    "wallet_trust_reducer_min": "0.500",
    "pair_reducer_min_approved": 3
  },
  "criteria": [
    { "id": "KO-1", "kind": "ko", "reason_type": "formal", "name": "Invoice fails validation", "agent": "invoice",
      "customer_text": "Die Rechnung ist formal ungültig oder unvollständig und kann nicht verarbeitet werden.", "agent_task": null },
    { "id": "KO-2", "kind": "ko", "reason_type": "formal", "name": "Payment address invalid or wrong network", "agent": "wallet",
      "customer_text": "Die angegebene Zahlungsadresse ist keine gültige Cardano-Adresse für das erwartete Netzwerk.", "agent_task": null },
    { "id": "KO-3", "kind": "ko", "reason_type": "formal", "name": "Exact duplicate invoice", "agent": "invoice",
      "customer_text": "Diese Rechnung wurde bereits eingereicht.", "agent_task": null },
    { "id": "KO-4", "kind": "ko", "reason_type": "risk", "name": "Sanctions list hit", "agent": "research",
      "customer_text": "Die Zahlungsadresse oder der Name des Rechnungsstellers steht auf einer Sanktionsliste.", "agent_task": null },
    { "id": "KO-6", "kind": "ko", "reason_type": "risk", "name": "Internal blocklist hit", "agent": "research",
      "customer_text": "Die Zahlungsadresse oder der Rechnungssteller ist bei uns gesperrt.", "agent_task": null },
    { "id": "S-1", "kind": "score", "points": 35, "name": "Known wallet, different supplier", "agent": "research",
      "customer_text": "Die Zahlungsadresse wurde bisher für einen anderen Rechnungssteller verwendet.",
      "agent_task": "Prüfe, warum eine Zahlungsadresse, die bisher einem anderen Rechnungssteller zugeordnet war, für diesen Rechnungssteller verwendet wird." },
    { "id": "S-2", "kind": "score", "points": 35, "name": "Seller VAT ID invalid", "agent": "research",
      "customer_text": "Die Umsatzsteuer-Identifikationsnummer des Rechnungsstellers ist laut EU-Datenbank (VIES) ungültig.",
      "agent_task": "Prüfe die Umsatzsteuer-Identifikationsnummer des Rechnungsstellers über eine unabhängige Quelle." },
    { "id": "S-3", "kind": "score", "points": 25, "name": "Known supplier, new wallet", "agent": "wallet",
      "customer_text": "Die Zahlungsadresse weicht von allen bisherigen Rechnungen dieses Rechnungsstellers ab.",
      "agent_task": "Prüfe, ob der Rechnungssteller die neue Zahlungsadresse über einen unabhängigen, bereits bekannten Kanal bestätigt hat." },
    { "id": "S-4", "kind": "score", "points": 15, "name": "Seller in high-risk country", "agent": "research",
      "customer_text": "Der Rechnungssteller hat seinen Sitz in einem Land mit erhöhtem Geldwäscherisiko oder unter Embargo.",
      "agent_task": "Prüfe, ob Geschäfte mit dem Sitzland des Rechnungsstellers zulässig sind." },
    { "id": "S-7", "kind": "score", "points": 10, "name": "Seller contact changed", "agent": "research",
      "customer_text": "Name, Kontaktdaten oder Anschrift des Rechnungsstellers weichen von früheren Rechnungen ab.",
      "agent_task": "Prüfe, warum sich Name, Kontaktdaten oder Anschrift des Rechnungsstellers geändert haben." },
    { "id": "S-8", "kind": "score", "points": 5, "name": "Free-mail contact", "agent": "research",
      "customer_text": "Der Rechnungssteller verwendet eine private E-Mail-Adresse.",
      "agent_task": "Prüfe, ob die private E-Mail-Adresse wirklich zum Rechnungssteller gehört." },
    { "id": "S-9", "kind": "score", "points": 5, "name": "First invoice from supplier", "agent": "research",
      "customer_text": "Es ist die erste Rechnung dieses Rechnungsstellers.",
      "agent_task": "Prüfe, ob der Rechnungssteller existiert und eine Geschäftsbeziehung besteht." },
    { "id": "W-1", "kind": "score", "points": 30, "name": "Chainabuse report (trusted or checked)", "agent": "wallet",
      "customer_text": "Zur Zahlungsadresse liegen bestätigte Meldungen in einer Scam-Datenbank vor.",
      "agent_task": "Prüfe die bestätigten Scam-Meldungen zur Zahlungsadresse." },
    { "id": "W-2", "kind": "score", "points_tiers": [ { "below_days": 7, "points": 15 }, { "below_days": 30, "points": 8 } ],
      "name": "Young address", "agent": "wallet",
      "customer_text": "Die Zahlungsadresse ist erst seit kurzer Zeit in Benutzung.",
      "agent_task": "Prüfe, warum eine sehr neue Zahlungsadresse verwendet wird." },
    { "id": "W-4", "kind": "score", "points": 10, "name": "Address never used", "agent": "wallet",
      "customer_text": "Die Zahlungsadresse wurde noch nie verwendet.",
      "agent_task": "Prüfe, warum eine noch nie verwendete Zahlungsadresse angegeben ist." },
    { "id": "W-6", "kind": "score", "points": 10, "name": "Chainabuse report (unverified)", "agent": "wallet",
      "customer_text": "Zur Zahlungsadresse liegen unbestätigte Meldungen in einer Scam-Datenbank vor.",
      "agent_task": "Prüfe die unbestätigten Scam-Meldungen zur Zahlungsadresse." },
    { "id": "I-2", "kind": "score", "points": 20, "name": "Amount over exposure limit", "agent": "invoice",
      "customer_text": "Der Rechnungsbetrag überschreitet das Limit für diese Zahlungsadresse.",
      "agent_task": "Prüfe, ob der Betrag für diese Zahlungsadresse plausibel ist." },
    { "id": "I-3", "kind": "score", "points": 15, "name": "Buyer data mismatch", "agent": "invoice",
      "customer_text": "Die Angaben zum Rechnungsempfänger stimmen nicht mit unseren Stammdaten überein.",
      "agent_task": "Prüfe, ob die Rechnung wirklich an unser Unternehmen gerichtet ist." },
    { "id": "I-4", "kind": "score", "points": 10, "name": "Amount far above supplier median", "agent": "invoice",
      "customer_text": "Der Rechnungsbetrag liegt deutlich über den bisherigen Rechnungen dieses Rechnungsstellers.",
      "agent_task": "Prüfe, ob der hohe Betrag durch eine Bestellung oder Leistung gedeckt ist." },
    { "id": "I-5", "kind": "score", "points": 10, "name": "Pressure wording", "agent": "invoice",
      "customer_text": "Die Rechnung enthält Formulierungen, die zu schneller Zahlung drängen.",
      "agent_task": "Prüfe, warum die Rechnung zu schneller Zahlung drängt." },
    { "id": "I-6", "kind": "score", "points": 8, "name": "Implausible issue date", "agent": "invoice",
      "customer_text": "Das Rechnungsdatum liegt in der Zukunft oder mehr als 90 Tage zurück.",
      "agent_task": "Prüfe, warum das Rechnungsdatum in der Zukunft oder weit zurück liegt." },
    { "id": "I-7", "kind": "score", "points": 8, "name": "Due date < 3 days", "agent": "invoice",
      "customer_text": "Das Zahlungsziel ist kürzer als 3 Tage.",
      "agent_task": "Prüfe, ob ein Zahlungsziel unter 3 Tagen mit dem Rechnungssteller vereinbart ist." },
    { "id": "I-8", "kind": "score", "points": 8, "name": "No open order reference", "agent": "invoice",
      "customer_text": "Die Rechnung verweist auf keine offene Bestellung bei diesem Rechnungssteller.",
      "agent_task": "Prüfe, ob die Leistung ohne offene Bestellung beauftragt wurde." },
    { "id": "I-10", "kind": "score", "points": 5, "name": "Round or just-below-threshold amount", "agent": "invoice",
      "customer_text": "Der Rechnungsbetrag ist auffällig rund oder liegt knapp unter einer Freigabegrenze.",
      "agent_task": "Prüfe, ob der Betrag einer vereinbarten Leistung entspricht." },
    { "id": "I-11", "kind": "score", "points": 5, "name": "Payment details inconsistent", "agent": "invoice",
      "customer_text": "Die Zahlungsangaben (Zahlungsart, Netzwerk oder Asset) sind unvollständig oder widersprüchlich.",
      "agent_task": "Prüfe, ob Zahlungsart, Netzwerk und Asset der Rechnung korrekt angegeben sind." },
    { "id": "I-12", "kind": "score", "points": 0, "name": "Corrected invoice", "agent": "invoice",
      "customer_text": "Es handelt sich um eine Korrekturrechnung.",
      "agent_task": "Prüfe, ob die Korrekturrechnung zu einer bekannten Originalrechnung passt und die Änderung plausibel ist." },
    { "id": "T-1", "kind": "reducer", "points": -15, "name": "Trusted wallet", "agent": null, "customer_text": null, "agent_task": null },
    { "id": "T-2", "kind": "reducer", "points": -10, "name": "Established supplier-wallet pair", "agent": null, "customer_text": null, "agent_task": null },
    { "id": "T-3", "kind": "reducer", "points": -10, "name": "Matches open order", "agent": null, "customer_text": null, "agent_task": null },
    { "id": "T-4", "kind": "reducer", "points": -5, "name": "VAT ID valid", "agent": null, "customer_text": null, "agent_task": null }
  ],
  "incomplete_tasks": {
    "BLOCKFROST_UNAVAILABLE": { "agent": "wallet", "task": "Prüfe Alter und Nutzung der Zahlungsadresse; die On-Chain-Abfrage war nicht verfügbar." },
    "CHAINABUSE_UNAVAILABLE": { "agent": "wallet", "task": "Prüfe die Zahlungsadresse in Scam-Datenbanken; Chainabuse war nicht erreichbar." },
    "CURRENCY_NOT_EUR": { "agent": "invoice", "task": "Prüfe Betrag und Limits manuell; die Rechnungswährung ist nicht EUR." },
    "MUSTANG_UNAVAILABLE": { "agent": "invoice", "task": "Prüfe die formale Gültigkeit der Rechnung; die automatische Validierung war nicht verfügbar." },
    "SANCTIONS_LIST_STALE": { "agent": "research", "task": "Prüfe Rechnungssteller und Zahlungsadresse gegen aktuelle Sanktionslisten; die lokale Liste ist veraltet." },
    "VIES_UNAVAILABLE": { "agent": "research", "task": "Prüfe die Umsatzsteuer-Identifikationsnummer des Rechnungsstellers; VIES war nicht erreichbar." }
  }
}
```

Startprüfung (FR-80): IDs eindeutig; `kind` ∈ {`ko`, `score`, `reducer`}; `ko` braucht `reason_type`; `score` braucht `points` oder `points_tiers`; `reducer` braucht negative `points`; `score` und `ko` brauchen `agent` und `customer_text`; `score` braucht `agent_task`; keine Texte mit `Betrug` oder `Fraud`; Schlüssel von `incomplete_tasks` = die sechs Codes oben.

### 6.3 Dateien in `data/`

`data/legal-forms.json`
```json
["gmbh co kgaa", "gmbh co kg", "ag co kgaa", "ag co kg", "se co kgaa", "se co kg",
 "ug haftungsbeschrankt co kg", "ug haftungsbeschrankt", "partg mbb", "e kfm", "e kfr",
 "e k", "e v", "e g", "gmbh", "gesmbh", "mbh", "ag", "kgaa", "kg", "ohg", "gbr", "ug",
 "ek", "ev", "eg", "se", "partg", "ltd", "limited", "llc", "inc", "corp", "corporation",
 "plc", "llp", "lp", "co", "company", "sa", "sas", "sasu", "sarl", "eurl", "sl", "slu",
 "srl", "spa", "bv", "nv", "vof", "ab", "as", "aps", "oy", "oyj", "sp z o o"]
```

`data/pressure-words.json` (normalisierte Form; Vergleich über `phrase_text`)
```json
["dringend", "dringlich", "eilig", "eilt", "sofort", "sofortige zahlung", "umgehend", "unverzuglich",
 "heute noch", "noch heute", "bis heute", "innerhalb von 24 stunden", "letzte mahnung", "letzte erinnerung",
 "letzte frist", "neue bankverbindung", "neue kontoverbindung", "neue zahlungsadresse", "neue wallet",
 "neue walletadresse", "neue wallet adresse", "neue adresse", "geanderte bankverbindung",
 "geanderte kontoverbindung", "geanderte zahlungsadresse", "geanderte wallet", "aktualisierte wallet",
 "vertraulich", "inkasso", "rechtliche schritte",
 "urgent", "urgently", "immediately", "immediate payment", "asap", "pay today", "today only",
 "within 24 hours", "final notice", "final reminder", "last reminder", "new bank details",
 "new account details", "new wallet", "new wallet address", "new payment address", "new address",
 "changed bank details", "updated wallet", "updated payment details", "confidential", "legal action"]
```

`data/freemail-domains.json`
```json
["gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de",
 "msn.com", "yahoo.com", "yahoo.de", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de",
 "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de", "freenet.de", "arcor.de",
 "posteo.de", "mailbox.org", "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com",
 "tutanota.de", "tuta.io", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "mail.com", "email.de"]
```

`data/high-risk-countries.json`
```json
{
  "as_of": "2026-06-19",
  "sources": [
    "FATF, High-Risk Jurisdictions subject to a Call for Action, 19.06.2026: KP, IR, MM",
    "OFAC, Cuban Assets Control Regulations (31 CFR Part 515): CU"
  ],
  "countries": ["CU", "IR", "KP", "MM"]
}
```
Hinweis: Die FATF hat am 30.10.2026 eine neue Liste veröffentlicht. Ihre Seite war für automatische Abrufe gesperrt; Suchergebnisse bestätigen Iran und Myanmar. Vor einer Demo die Seite im Browser öffnen und die Datei bei Bedarf anpassen (nur Daten, kein Code).

`data/buyer-master.json` (eigene Stammdaten; Werte für Tests und Demo)
```json
{ "name": "Käufer Handels AG", "vat_id": "DE999999999", "postcode": "10115" }
```

`data/open-orders.json`
```json
[ { "order_id": "PO-2026-001", "supplier_vat_id": "DE111111111" },
  { "order_id": "PO-2026-002", "supplier_vat_id": "DE222222222" } ]
```

Mock-Dateien (nur `*_MODE=mock`):
- `data/blockfrost-mock.json`: `{"addresses": {"<adresse>": {"first_tx_time": "<RFC 3339>" | null} | {"error": true}}}`; unbekannte Adresse = keine Transaktion; `{"error": true}` = Ausfall.
- `data/vies-mock.json`: `{"<vat normalisiert>": true | false | "error"}`; unbekannt = `false`; `"error"` = Ausfall.
- `data/chainabuse-mock.json`: `{"<adresse>": {"reports": <n>, "trusted_or_checked": <m>} | {"error": true}}`; unbekannt = 0 Reports.

---

## 7. CLI-Befehle, Seed, Hintergrundjobs

### 7.1 Befehle

| Befehl | Verhalten |
| --- | --- |
| `sniffer serve` | Start nach FR-80, HTTP-Server, Hintergrundjobs (7.6) |
| `sniffer migrate` | nur Schema anlegen und Migrationen ausführen |
| `sniffer lists-update` | OFAC-Import (3.7.5); Exit 0 bei Erfolg, sonst 1 |
| `sniffer blocklist-add --type <wallet\|supplier> --value <rohwert> --reason <CODE>` | `wallet`: Adresse nach 3.4 Schritt 1–3 (ohne Netzwerkprüfung) → `wallet_hash`; `supplier`: `vat(value)` → `supplier_hash`. Sperre per Upsert aus 5.4. `CODE`: `^[A-Z0-9_]{1,40}$`. Der Rohwert wird nicht gespeichert oder ausgegeben. |
| `sniffer blocklist-remove --type <wallet\|supplier> --value <rohwert>` | Hash wie oben; nur bei `block_source = 'internal'`: `status = 'normal'`, `block_*` leeren. Sonst Meldung und Exit 1. |
| `sniffer subject-delete --hash <hmac:…>` | 7.3 |
| `sniffer db-seed --file <pfad>` | 7.4 |

### 7.2 Ausgaben

Befehle schreiben eine Zeile JSON auf stdout, z. B. `{"ok": true, "deleted_invoices": 3}`; Fehler gehen nach stderr, Exit-Code 1.

### 7.3 `subject-delete` (DSGVO)

In einer Transaktion:
1. Alle `invoices`-Zeilen mit `supplier_hash = h` oder `wallet_hash = h` laden.
2. Deren `pair_hash`-Einträge aus `subjects` löschen.
3. `checks`-Zeilen zu deren `check_id` löschen, außerdem alle `checks`-Zeilen mit `result::text LIKE '%' || h || '%'`.
4. Die `invoices`-Zeilen löschen.
5. `subjects`-Eintrag `h` löschen.
6. Nach dem Commit die Redis-Schlüssel `sniffer:xml:<check_id>` der gelöschten Checks löschen.

### 7.4 `db-seed`

Liest eine JSON-Datei (7.5). Für jede Rechnung: Hashes nach 3.3 mit dem konfigurierten Key; existiert `invoice_hash`, wird sie übersprungen; sonst `invoices`-Zeile mit `check_id = "seed_<laufende Nummer ab 1>"`, `initial_band = 'low'`, `initial_score = 0`, `decided_by = 'seed'`, `decided_at` = `issue_date` 00:00 UTC, Entscheidung aus der Datei; Zähler nach 5.4. Danach Sperren (Upsert aus 5.4; bei `source = "OFAC"` dieselbe Anweisung mit `'OFAC'` statt `'internal'`), Sanktionsnamen (`name()` normalisiert, `source = 'OFAC'`) und, bei `"ofac_list_fresh": true`, `list_updates` für `OFAC` mit `now()`. Der Befehl ist wiederholbar.

### 7.5 Seed-Datei `seed/seed.json` (Tests und Demo)

Adressen (gültige Bech32-Adressen, erzeugt mit dem BIP-173-Referenzalgorithmus; der Bau muss in einem Unit-Test bestätigen, dass `pallas-addresses` sie wie angegeben dekodiert):

| Name | Typ | Payment-Credential | Adresse |
| --- | --- | --- | --- |
| W1 | Base, Preprod | Key `11…11` (28 Byte), Stake `aa…aa` | `addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c` |
| W2 | Base, Preprod | Key `22…22`, Stake `aa…aa` | `addr_test1qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg424242424242424242424242424242424242424242424q4d8wgt` |
| W3 | Enterprise, Preprod | Key `33…33` | `addr_test1vqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvc9myyf9` |
| W4 | Enterprise, Preprod | Key `44…44` | `addr_test1vpzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q5drxww` |
| W5 | Enterprise, Preprod | Key `55…55` | `addr_test1vp24242424242424242424242424242424242424242424glts28l` |
| M | Base, Preprod („mangled“) | Key `33…33`, Stake `aa…aa` (Stake von W1) | `addr_test1qqenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxva24242424242424242424242424242424242424242424qdm5upe` |
| W1-main | Base, Mainnet | wie W1 | `addr1qyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qc5hee8` |
| W1-bad | wie W1, letzte Stelle verändert | – | `addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4q` |

Inhalt:
```json
{
  "invoices": [
    { "seller_vat_id": "DE111111111", "seller_name": "Alpha Consulting GmbH", "seller_email": "rechnung@alpha-consulting.example",
      "seller_phone": "+49 89 1234567", "seller_street": "Musterstraße 1", "seller_postcode": "80333", "seller_city": "München",
      "seller_country": "DE", "wallet_address": "<W1>", "invoice_number": "RE-2026-0101", "amount": "1190.00", "currency": "EUR",
      "issue_date": "2026-04-15", "type_code": "380", "final_decision": "approved", "final_reason_type": null }
  ],
  "blocklist": [
    { "type": "wallet", "value": "<W4>", "source": "internal", "reason": "TEST_INTERNAL" },
    { "type": "wallet", "value": "<W5>", "source": "OFAC", "reason": "TEST_OFAC" }
  ],
  "sanction_names": [ { "name": "Delta Trading LLC", "sdn_uid": "TEST-1" } ],
  "ofac_list_fresh": true
}
```
`<W1>`, `<W4>`, `<W5>` stehen für die Adressen aus der Tabelle oben. Die Liste `invoices` enthält sechs Einträge für Lieferant A, die sich nur in Nummer, Betrag und Datum unterscheiden:

| Nummer | Betrag | Datum |
| --- | --- | --- |
| RE-2026-0101 | 1190.00 | 2026-04-15 |
| RE-2026-0102 | 1250.00 | 2026-05-15 |
| RE-2026-0103 | 980.00 | 2026-06-15 |
| RE-2026-0104 | 1100.00 | 2026-07-15 |
| RE-2026-0105 | 1300.00 | 2026-08-15 |
| RE-2026-0106 | 1050.00 | 2026-09-15 |

Ergebnis nach dem Seed: Lieferant A, Wallet W1 und Paar A/W1 je `approved = 6`, `trust = 0.545`; Median der Beträge 1145.00.

### 7.6 Hintergrundjobs (`serve`)

| Job | Zeitpunkt |
| --- | --- |
| OFAC-Aktualisierung | FR-71 |
| Aufbewahrung | FR-76 |

Jobs laufen nicht parallel zu sich selbst. Ein Fehler beendet nicht den Server.

---

## 8. Abnahmetests

### 8.1 Testumgebung

- Postgres und Redis per `docker-compose`; vor jedem Test ein leeres Schema und eine geleerte Redis-Testdatenbank (`FLUSHDB`), danach `db-seed` mit `seed/seed.json`.
- `.env` für Tests: `ALLOW_CHECKED_AT=true`, `MUSTANG_MODE=mock_valid` (außer Tests 22 und 23), `BLOCKFROST_MODE=api`, `VIES_MODE=api`, `CHAINABUSE_MODE=api`, alle drei `*_BASE_URL` auf `wiremock`, `OFAC_AUTO_UPDATE=false`, Test-HMAC-Key aus 3.3.
- Jeder Request sendet `checked_at = "2026-10-30T12:00:00Z"`.
- Standard-Stubs:

| Quelle | Anfrage | Antwort |
| --- | --- | --- |
| Blockfrost | Transaktionen von W1 | 200 `[{"tx_hash": "<64 hex>", "tx_index": 0, "block_height": 100, "block_time": 1768035600}]` (10.01.2026 09:00 UTC) |
| Blockfrost | Transaktionen von W2 | 200 mit `block_time` 1793102400 (27.10.2026 12:00 UTC) |
| Blockfrost | alle anderen Adressen | 404 `{"status_code": 404, "error": "Not Found", "message": "The requested component has not been found."}` |
| VIES | `DE/111111111`, `DE/222222222`, `DE/333333333`, `DE/555555555` | 200 `{"isValid": true, "userError": "VALID"}` |
| VIES | `DE/444444444` | 200 `{"isValid": false, "userError": "INVALID"}` |
| Chainabuse | jede Adresse | 200 `{"reports": [], "count": 0}` |

- Mustang-Tests (22, 23) laufen nur, wenn `SNIFFER_TEST_MUSTANG=1` gesetzt ist und Java sowie die JAR vorhanden sind; sonst werden sie übersprungen (`#[ignore]`).

### 8.2 Testrechnungen

Basis ist **F1** = Anhang A (Lieferant A, W1, `RE-2026-0412`, 1190.00 EUR, Datum 28.10.2026, fällig 27.11.2026, Bestellung `PO-2026-001`). Varianten:

| Name | Änderung gegenüber F1 |
| --- | --- |
| F9 | Adresse W2; Position 7 × 100.00; Steuer 133.00; Brutto und Zahlbetrag 833.00; Fälligkeit `20261030`; BT-22-Text ersetzt durch `Bitte dringend überweisen, neue Wallet.` |
| F10 | Seller `Beta Services GmbH`, USt-ID `DE222222222`, E-Mail (BT-43 und BT-34) `info@beta-services.example`, Telefon `+49 30 7654321`, Anschrift `Hauptstraße 5`, `10117`, `Berlin`; Adresse W1; ohne `BuyerOrderReferencedDocument`; Position 15 × 100.00; Steuer 285.00; Brutto 1785.00; Fälligkeit `20261030`; BT-22-Text ersetzt durch `Bitte dringend zahlen.` |
| F11 | Seller `Gamma Handel GmbH`, USt-ID `DE333333333`, E-Mail (BT-43 und BT-34) `gamma.handel@gmail.com`, Telefon `+49 40 1111111`, Anschrift `Hafenweg 3`, `20095`, `Hamburg`; Adresse W3; ohne Bestellung; Position 1 × 1680.67; Steuer 319.33; Brutto 2000.00 |
| F18 | Seller `Delta Trading LLC`, USt-ID `DE555555555` |
| F19 | Seller `Epsilon GmbH`, USt-ID `DE444444444` |

F9, F10 und F11 wurden am 30.10.2026 mit Mustang 2.26.0 als gültig validiert (Exit 0) und liegen fertig unter `docs/fixtures/f9.xml`, `f10.xml`, `f11.xml` (beim Bau nach `tests/fixtures/` kopieren). Beträge werden in allen betroffenen Elementen geändert: Positionspreis und -menge, `LineTotalAmount` (Position und Kopf), `BasisAmount`, `TaxBasisTotalAmount`, `CalculatedAmount`, `TaxTotalAmount`, `GrandTotalAmount`, `DuePayableAmount`. Seller-Änderungen betreffen BT-27, BT-31, BT-42, BT-43, BT-34, BT-35, BT-38, BT-37.

### 8.3 Testfälle

| # | Eingabe | Erwartung |
| --- | --- | --- |
| 1 | F1 | Low, Score 0, `criteria` leer, Reducer T-1 −15, T-2 −10, T-3 0 und T-4 0 (beide `(cap reached)`), `signature.status = "absent"`; danach A, W1 und Paar A/W1 je `approved = 7` |
| 2 | `{"xml": "<x"}` | High, KO-1 `XML_MALFORMED`, `invoice` = `null`, keine `invoices`-Zeile, `decision_state` = `null` |
| 3 | F1 ohne `PayeePartyCreditorFinancialAccount` | High, KO-1 `MISSING_FIELD:BT-84` |
| 4 | F1 mit W1-main | High, KO-2 `NETWORK_MISMATCH` |
| 5 | F1 mit W1-bad | High, KO-2 `BECH32_INVALID` |
| 6 | F1 zweimal | zweiter Lauf High, KO-3 `duplicate of <check_id von Lauf 1>`, keine neue `invoices`-Zeile |
| 7 | F1 mit TypeCode `384` und Nummer `RE-2026-0412-K` | Medium, `criteria` = I-12 (0), Reducer −25, Score 0, Auftrag I-12 beim Invoice-Agenten |
| 8 | F1 mit W4 | High, KO-6 `wallet blocked (TEST_INTERNAL)`, `reason_type = risk`, `invoices`-Zeile `rejected`/`risk`, W4 und Paar A/W4 `rejected_risk = 1`, keine Anfrage an die Stubs |
| 9 | F9 | Medium, S-3 25 + W-2 15 + I-5 10 + I-7 8 = 58, keine Reducer (S-3 ≥ 25), JSON wie in Abschnitt 4 |
| 10 | F10 | High (`risk`), S-1 35 + I-5 10 + I-7 8 + I-8 8 + S-9 5 = 66; `decline_reasons` = S-1, I-5, I-7; danach W1 `trust = 0.25`, Paar B/W1 `rejected_risk = 1`, B ohne Eintrag |
| 11 | F11 | Medium, I-2 20 + W-4 10 + I-8 8 + S-8 5 + S-9 5 + I-10 5 = 53, Reducer T-4 −5, Score 48 |
| 12 | F1, Blockfrost-Stub für W1 antwortet nach `HTTP_TIMEOUT_MS + 1000` ms | Medium, Score 0, `checks_incomplete = ["BLOCKFROST_UNAVAILABLE"]`, Auftrag beim Wallet-Agenten |
| 13 | nach Test 9: `POST /v1/decisions` `approved` für dessen `check_id`; dann F1 mit W2, Nummer `RE-2026-0413`, Datum `20261029`, fällig `20261128` | Entscheidung 200; zweiter Check Low, W-2 15, Reducer T-3 −10 und T-4 −5, Score 0 (S-3 feuert nicht mehr) |
| 14 | F1 mit zusätzlicher Notiz `cardano-sig-v1:abcd;ef01` | wie Test 1, `signature.status = "present_unverified"` |
| 15 | F1, BT-22-Text ersetzt durch `Bitte heute noch zahlen` | wie Test 1 plus I-5 10; Reducer −25; Score 0; Low |
| 16 | F1 mit M | Medium, S-3 25 + I-2 20 + W-4 10 = 55 (Regressionstest für FR-21) |
| 17 | F1 mit W5 | High, KO-4 `wallet on OFAC SDN list` |
| 18 | F18 | High, KO-4 `seller name matches OFAC SDN entry` |
| 19 | F19 | High, S-1 35 + S-2 35 + I-8 8 + S-9 5 = 83; `decline_reasons` = S-1, S-2, I-8 |
| 20 | F1, Chainabuse-Stub W1: ein Report mit `trusted: true` | Medium, W-1 30, keine Reducer, Score 30 |
| 21 | F1, Chainabuse-Stub W1: ein Report mit `trusted: false, checked: false` | Low, W-6 10, Reducer −25, Score 0 |
| 22 | F1 ohne `BuyerReference`, `MUSTANG_MODE=cli` | High, KO-1 `MUSTANG:BR-DE-15`, keine `invoices`-Zeile |
| 23 | wie 22 mit `MUSTANG_RULE_WHITELIST=BR-DE-15` | wie Test 1, `whitelisted_rules = ["BR-DE-15"]` |
| 24 | F1 mit Währung `USD` (auch `currencyID="USD"`) | Medium, Score 0, `CURRENCY_NOT_EUR` |
| 25 | F1, vorher Redis-Schlüssel `sniffer:lock:invoice:<invoice_hash von F1>` setzen | 409 `check_in_progress`, keine `checks`-Zeile |
| 26 | nach Test 9: (a) `rejected` ohne `decline_reasons` → 400; (b) `rejected`/`risk`, `block_wallet: true`, ein Grund → 200, W2 gesperrt (`AGENT_DECISION`), W2 und Paar A/W2 `rejected_risk = 1`, A unverändert; (c) b wiederholt → 200 gleicher Inhalt; (d) danach `approved` → 409 `already_decided`; (e) für den Check aus Test 1 → 409 `not_pending`; (f) Grundtext mit `Betrug` → 400 `forbidden_wording`; (g) unbekannte `check_id` → 404 | wie angegeben |
| 27 | Request ohne Token | 401 |
| 28 | `ALLOW_CHECKED_AT=false` und `checked_at` gesetzt | 400 `checked_at_not_allowed` |
| 29 | F1 mit TypeCode `381` | High, KO-1 `UNSUPPORTED_TYPE_CODE` |
| 30 | F1 mit zweitem `SpecifiedTradeSettlementPaymentMeans` | High, KO-1 `AMBIGUOUS_PAYMENT` |
| 31 | F1 mit `<!DOCTYPE rsm:CrossIndustryInvoice [<!ENTITY x "y">]>` nach der Deklaration | High, KO-1 `DTD_NOT_ALLOWED` |
| 32 | F1, `list_updates` leer | Medium, `SANCTIONS_LIST_STALE` |
| 33 | `XML_TTL_SECONDS=1`, F1, 2 s warten, `GET …/xml` | 410 `xml_expired`; `GET` mit unbekannter ID → 404 |
| 34 | Unit: HMAC-Testvektoren aus 3.3 | alle gleich |
| 35 | Unit: Normalisierungsbeispiele aus 3.3 | alle gleich |
| 36 | Unit: Mustang-Berichte aus Anhang B | B.1 gültig; B.2 gültig (Warnung ignoriert); B.3 KO-1 `MUSTANG:BR-DE-15`; B.4 `MUSTANG_UNAVAILABLE` |
| 37 | Unit: Adressen aus 7.5 mit `pallas-addresses` | Netzwerk, Typ und Payment-Credential wie in der Tabelle; M hat dasselbe Credential wie W3 |

---

## 9. Verifizierte Fakten (Stand 30.10.2026)

| Thema | Ergebnis | Quelle |
| --- | --- | --- |
| Mustang-Version | 2.26.0, Release `core-2.26.0` vom 25.08.2026, JAR 59 163 641 Byte, SHA-256 siehe Abschnitt 2 | GitHub API `repos/ZUGFeRD/mustangproject/releases/latest`; Download geprüft |
| Mustang-Aufruf | `--no-notices --action validate --source <datei>`, XML-Bericht auf stdout, Logs auf stderr | mustangproject.org/commandline; lokal ausgeführt |
| Mustang-Verhalten | Konvention aus 3.2 gültig; Exit 0 gültig, 255 ungültig; Regel-ID im Text `[ID …]`; IBAN-Regel BR-DE-19 ist nur eine Warnung; fehlendes BT-84 bei `ZZZ` kein Fehler; ohne XML-Deklaration und mit BOM gültig; TypeCode 381 gültig | lokale Läufe mit OpenJDK 23.0.2 (Anhang B) |
| Mustang-Java | `Build-Jdk-Spec: 11` im Manifest | JAR-Manifest |
| Blockfrost | Preprod-Basis-URL; `/addresses/{address}/transactions` mit `count` (max. 100), `page`, `order`; Felder `tx_hash`, `tx_index`, `block_height`, `block_time` (UNIX); 404-Körper `{"status_code":404,"error":"Not Found",…}`; 10 Anfragen/s, Burst 500 | Blockfrost OpenAPI (`blockfrost/openapi`) |
| VIES | `GET /ms/{cc}/vat/{nr}` liefert `isValid`, `userError`, `name`, `address`; live abgefragt | ec.europa.eu, Abruf 30.10.2026 |
| Chainabuse | `GET https://api.chainabuse.com/v0/reports`, Basic Auth, Parameter `address`, `page`, `perPage` (max. 50); Report-Felder `trusted` (Pflicht), `checked`, kein Konfidenz-Feld; Chain `CARDANO` unterstützt | chainabuse.readme.io (Referenz und Anleitung) |
| OFAC | SDN.XML unter `…/api/PublicationPreview/exports/`, Antwort Redirect auf Download; Feld „Digital Currency Address – <Symbol>“; Cardano-Einträge nicht bestätigt | sanctionslist.ofac.treas.gov, Abruf mit Redirect; Suche |
| FATF | Stand 19.06.2026: Call for Action DPRK, Iran (Gegenmaßnahmen), Myanmar (erhöhte Sorgfalt); Liste vom 30.10.2026 nicht maschinell lesbar | Suchergebnisse mit Veröffentlichungen von MAS, FIAU Malta und Bahamas SCB; fatf-gafi.org lieferte 403 |
| pallas-addresses | 1.4.0; Signaturen aus Abschnitt 2 | docs.rs |
| roxmltree | 0.21.2; `allow_dtd` Standard `false`, Fehler `DtdDetected` | docs.rs |
| unicode-normalization | 0.1.26; `char::is_combining_mark` (General_Category = Mark) | docs.rs |

---

## 10. Änderungen gegenüber v0.2 (Ergebnis des finalen Reviews)

| Änderung | Grund |
| --- | --- |
| **Wallet-Identität = Payment-Credential statt Stake-Adresse** | Sicherheitslücke: Mit einer „mangled address“ (fremder Stake-Teil) hätte ein Angreifer als bekannte Wallet gegolten (3.4). Test 16 sichert das ab. |
| Wallet-Alter aus der ersten Transaktion der Adresse (eine Blockfrost-Anfrage) | Alter über den Stake-Key war mit derselben Methode manipulierbar; weniger Abfragen |
| W-8 (Enterprise-Adresse) entfällt | Ohne Gruppierung über den Stake-Key hat das Kriterium keinen Zweck mehr |
| Typ `address` in `subjects` und Spalte `rejected_formal` entfallen | wurden von keinem Kriterium genutzt |
| W-1/W-6 über `trusted`/`checked`, `CHAINABUSE_HIGH_CONFIDENCE` entfällt | Die Chainabuse-API hat kein Konfidenz-Feld |
| VIES über `GET /ms/{cc}/vat/{nr}` und `userError` | Der POST-Endpunkt liefert laut Swagger kein `userError`; GET live geprüft |
| `INVALID_INPUT` bei VIES zählt als ungültig | eine formal falsche USt-ID ist kein Ausfall |
| Mustang-Konvention geprüft, Fehlerformat, Exit-Codes, Regel-ID-Extraktion festgelegt | vorher offener Punkt; jetzt mit echter Validierung belegt |
| `sxd-xpath` → `roxmltree` | aktiv gepflegt, DTD standardmäßig gesperrt |
| Reducer entfallen, wenn ein Kriterium ≥ 25 Punkte gefeuert hat (statt nur bei S-1/S-3) | sonst hätte z. B. eine bestätigte Scam-Meldung (W-1, 30) bei vertrauter Wallet auf Low fallen können |
| Reducer-Deckel mit Restbudget, gedeckelte Reducer mit 0 Punkten aufgeführt | `risk_score` bleibt aus den Einträgen nachrechenbar |
| KO-3C → I-12: jede Korrekturrechnung (384) mindestens Medium; `invoice_hash` enthält BT-3 | sonst Primärschlüssel-Konflikt bei Korrekturen mit gleicher Nummer |
| Erlaubte Rechnungsarten 326, 380, 384, 875, 876, 877; Gutschrift 381 → KO-1 | nur Zahlungsforderungen sind im Scope |
| Genau eine Zahlungsanweisung; IBAN → `IBAN_NOT_SUPPORTED`; mehrere → `AMBIGUOUS_PAYMENT` | eindeutiges Zahlungsziel |
| Hash-Eingaben mit Typ-Präfixen, Testvektoren | keine Kollision zwischen Hash-Typen, prüfbare Implementierung |
| K.O. = 100 Punkte | `risk_score` = 100 bei K.O., nachrechenbar |
| `invoices`-Zeilen nur ohne formalen K.O. | eine korrigierte Rechnung mit gleichen Daten soll nicht als Duplikat scheitern |
| `CURRENCY_NOT_EUR` ist kritisch (mindestens Medium) | Limits waren nicht prüfbar |
| Redis-Sperre pro Rechnung, 409 bei parallelem Check | Duplikatprüfung unter Parallelität |
| Schema `sniffer` in Postgres, Präfix `sniffer:` in Redis | gemeinsame Instanzen mit den Agenten |
| Mock-Modi für Blockfrost, VIES, Chainabuse; Basis-URLs änderbar | Demo mit fiktiven Firmen (VIES würde sie als ungültig melden), Tests gegen `wiremock` |
| `checked_at` nur mit `ALLOW_CHECKED_AT=true` | Produktion soll Datumsregeln nicht umgehen können |
| Grenzwerte aus `.env` in `config/criteria.json` | eine Quelle für alle Punkte und Schwellen |
| Vollständige Texte, Listen, Seed und 37 Testfälle | kein Raten beim Bau |
| `agent_tasks` als `{source, task}` plus Aufträge für Ausfälle | Agenten wissen, woher ein Auftrag kommt |
| Aufbewahrung `RETENTION_DAYS`, `blocklist-remove`, `migrate`, `/health` | Betrieb und DSGVO |
| `signature.matches_known_wallet` → `matches_known_key` | passt zum Schlüssel-Modell in Abschnitt 11 |
| S-8/S-9 → `research` | Invoice Investigator darf keine Lieferantenprüfung durchführen; Lieferanten-Themen gehören zum Supplier Investigator (Agent `research`) |

---

## 11. Geplante Erweiterung: Wallet-Signatur (nicht Teil von v1.0, Schnittstellen reserviert)

**Problem.** Der häufigste Angriff ist die umgeleitete Zahlungsadresse (Payment Diversion, Business E-Mail Compromise): Eine Rechnung sieht aus wie die eines echten Lieferanten, nur die Adresse gehört dem Angreifer. Der Score erkennt das nur indirekt über S-3 und kann einen echten Adresswechsel nicht von einem Angriff unterscheiden.

**Lösung.** Der Lieferant unterschreibt mit einem Schlüssel seiner Wallet (CIP-30 `signData`, Format CIP-8 COSE_Sign1) eine kanonische Zahlungszeile, die die vollständige Adresse enthält:

```
cardano-invoice-v1|<vat(BT-31)>|<invoice_no(BT-1)>|<amount(BT-112)>|<BT-5>|<BT-2 YYYY-MM-DD>|<Adresse nach 3.4 Schritt 1>
```

Die Signatur steht als BT-22-Eintrag `cardano-sig-v1:<hex COSE_Sign1>;<hex COSE_Key>`. Der Sniffer führt je Lieferant die Schlüssel, die bereits freigegebene Rechnungen signiert haben. Weil die Adresse im signierten Text steht, schützt auch eine Signatur mit dem Stake-Key vor „mangled addresses“. Zusätzlich kann eine neue Empfangsadresse derselben Wallet akzeptiert werden, wenn ein bekannter Schlüssel sie signiert hat; das behebt die Fehlalarme aus 3.4. Ein echter Wechsel der Wallet wird einmalig von alter und neuer Wallet unterschrieben und über einen eigenen Endpunkt registriert.

**Geplante Kriterien** (IDs reserviert, Punkte Vorschlag):

| ID | Bedingung | Wirkung |
| --- | --- | --- |
| SIG-1 | Signatur vorhanden, aber ungültig für die Zahlungszeile | K.O. (`risk`) |
| SIG-2 | Gültig, aber Schlüssel gehört nicht zu den bekannten Schlüsseln des Lieferanten | +40 |
| SIG-3 | Lieferant hat früher signiert, diese Rechnung nicht | +25 |
| SIG-4 | Gültig und Schlüssel bekannt | −20 (Reducer) |

**In v1.0 vorbereitet:** reserviertes Präfix (3.2), Block `signature` (Abschnitt 4), freie Kriterien-IDs und Trait (FR-53). Beim Einbau kommen hinzu: Kriterien-Implementierungen, Config-Einträge, Befüllung von `signature`, eine Tabelle `supplier_keys (supplier_hash, key_hash, first_seen_at)`, ein Endpunkt für Wallet-Wechsel.

**Bekannte Komplikationen:**
- Kein Standardfeld in XRechnung/ZUGFeRD; fremde Rechnungssoftware erzeugt die Signatur nicht. Lieferanten brauchen ein Signier-Werkzeug (Webseite mit CIP-30-Anbindung).
- Die Zahlungszeile muss bytegenau definiert sein, mit Testvektoren.
- Stake-Key-Signaturen in Hardware-Wallets prüfen; Multisig-/Script-Wallets haben keinen einzelnen Schlüssel und brauchen einen separat registrierten Signaturschlüssel.
- Erster Kontakt: Ohne bekannten Schlüssel beweist die Signatur nur Kontrolle über die Wallet, nicht die Identität der Firma.
- Schlüsselverlust oder -diebstahl braucht einen Ausweg außerhalb des automatischen Ablaufs.
- Die Wallet-Signatur ist keine qualifizierte elektronische Signatur nach eIDAS und darf nicht so bezeichnet werden.

---

## 12. Erweiterung Auszahlung (MVP, nicht Teil des Initial Checks v1.0)

### 12.1 Zweck und Grenzen

Der Dienst **autorisiert** Auszahlungen an freigegebene Rechnungen nach einer festen Policy, führt das Auszahlungsjournal `payout_intents` und **bestätigt** die Zahlung selbst on-chain. Er signiert und sendet keine Transaktionen; das übernimmt ein externes Auszahlungsmodul mit eigenem Schlüssel, und zwar nur für einen autorisierten Intent. Abschnitte 0 bis 11 bleiben unverändert gültig; dieser Abschnitt ergänzt sie.

Grundsätze:
- **Deterministisch:** Die Policy (12.4) hat eine feste Reihenfolge; die erste verletzte Regel bestimmt den Fehlercode.
- **Höchstens eine Auszahlung je Rechnung:** `invoice_hash` ist in `payout_intents` eindeutig.
- **Nie automatisch wiederholen:** Ein Intent mit unklarem Ausgang geht nach `unknown` und braucht eine manuelle Prüfung.
- **Datenschutz:** Einzige Ausnahme von FR-32 ist `to_address` (FR-32a). Logs folgen FR-33, ergänzt um `payout_id` und `state`; `to_address` wird nie geloggt.
- Alle Endpunkte dieses Abschnitts verlangen `Authorization: Bearer <SNIFFER_API_TOKEN>` (FR-08). Fehlerkörper nach FR-09.

### 12.2 Datenmodell (Migration `0002_payouts.sql`)

Schema `sniffer` wie in 3.9:

```sql
CREATE TABLE payout_intents (
  payout_id      text PRIMARY KEY,                -- 'pay_' + ULID
  invoice_hash   text NOT NULL UNIQUE REFERENCES invoices(invoice_hash),
  check_id       text NOT NULL,
  wallet_hash    text NOT NULL,
  to_address     text NOT NULL,                   -- FR-32a exception (O1)
  amount_eur     numeric(14,2) NOT NULL,
  ada_per_eur    numeric(18,6) NOT NULL,
  lovelace       bigint NOT NULL CHECK (lovelace > 0),
  state          text NOT NULL CHECK (state IN ('authorized','submitting','submitted','confirmed','failed','unknown')),
  tx_hash        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

| Spalte | Regel |
| --- | --- |
| `payout_id` | `pay_` + ULID (26 Zeichen, Crockford-Base32, uppercase) |
| `check_id`, `wallet_hash` | aus der `invoices`-Zeile |
| `to_address` | BT-84 nach 3.4 Schritt 1, aus dem XML in Redis (12.4 Regel 5) |
| `amount_eur` | BT-115 aus demselben XML |
| `ada_per_eur` | `ADA_PER_EUR` zum Zeitpunkt der Autorisierung (gespeichert, damit der Betrag nachrechenbar bleibt) |
| `lovelace` | `floor(BT-115 × ADA_PER_EUR × 1_000_000)`, exakt dezimal gerechnet (`rust_decimal`), dann abgerundet |
| `tx_hash` | 64 Hex-Zeichen, lowercase; gesetzt ab `submitted` |
| `updated_at` | wird bei jedem Zustandswechsel auf `now()` gesetzt |

### 12.3 Konfiguration (Ergänzung zu 6.1)

| Variable | Standard | Pflicht / Regel |
| --- | --- | --- |
| `ADA_PER_EUR` | – | Pflicht bei Auszahlung. Dezimal-String passend zu `^[0-9]+(\.[0-9]{1,6})?$` und > 0, z. B. `0.040000`. Ungültiger Wert → Start bricht ab (FR-80). Fehlt der Wert, antwortet `POST /v1/payouts/authorize` 409 `payouts_disabled`. |
| `PAYOUT_MAX_ADA_PER_INVOICE` | `50` | ganze Zahl ≥ 1, in ADA |
| `PAYOUT_MAX_ADA_PER_DAY` | `200` | ganze Zahl ≥ 1, in ADA; Tag = UTC-Kalendertag nach echter Uhrzeit (nicht `checked_at`) |

### 12.4 `POST /v1/payouts/authorize`

Request: `{"check_id": "chk_…"}`. Unbekannte Felder oder falsche Typen → 400 `invalid_request`.

Ablauf in einer Transaktion. Die Transaktion nimmt zuerst `pg_advisory_xact_lock` auf einen festen Schlüssel, damit Regel 7 auch bei parallelen Requests gilt. Die Regeln werden in dieser Reihenfolge geprüft; die erste verletzte Regel beendet den Ablauf mit 409 und dem genannten Code:

| # | Regel | Code bei Verstoß |
| --- | --- | --- |
| 1 | Es gibt eine `invoices`-Zeile zum `check_id`, und `final_decision = 'approved'` | `not_approved` |
| 2 | `invoices.currency = 'EUR'` | `currency_not_supported` |
| 3 | Es gibt noch keinen Intent zu `invoice_hash`. Gibt es einen, antwortet der Server 200 mit genau diesem Intent, in jedem Zustand (idempotent), und legt nie einen zweiten an. | – (200) |
| 4 | Der Wallet-Eintrag in `subjects` ist jetzt nicht `blocked` (neu gelesen, denn er kann nach der Freigabe gesperrt worden sein) | `wallet_blocked` |
| 5 | `sniffer:xml:<check_id>` liegt noch in Redis; sonst `xml_expired`. BT-84 aus diesem XML besteht 3.4 vollständig, und der daraus berechnete `wallet_hash` ist gleich `invoices.wallet_hash`; sonst `recipient_mismatch`. | `xml_expired` / `recipient_mismatch` |
| 6 | `lovelace = floor(BT-115 × ADA_PER_EUR × 1_000_000)` ist > 0 und ≤ `PAYOUT_MAX_ADA_PER_INVOICE × 1_000_000`. Bei `lovelace = 0` → `amount_zero`. | `amount_zero` / `over_invoice_cap` |
| 7 | Summe `lovelace` aller Intents mit `created_at` am heutigen UTC-Tag und `state ≠ 'failed'` plus dieser Intent ≤ `PAYOUT_MAX_ADA_PER_DAY × 1_000_000` | `over_daily_cap` |
| 8 | `EXPECTED_NETWORK = preprod` | `network_not_allowed` |

Hinweis: `xml_expired` ist hier ein 409 (Policy-Ablehnung), anders als bei `GET /v1/checks/{check_id}/xml` (410, 5.3).

Sind alle Regeln erfüllt, legt der Server den Intent mit `state = 'authorized'` an und antwortet 200:

```json
{ "payout_id": "pay_01JC2M4N6P8Q0R2S4T6V8W0X2Y", "check_id": "chk_…", "state": "authorized",
  "to_address": "addr_test1…", "amount_eur": "1190.00", "ada_per_eur": "0.040000",
  "lovelace": 47600000, "tx_hash": null }
```

Dieses Objekt („Intent-Sicht“) ist auch die Antwort aller Endpunkte in 12.5. `amount_eur` mit 2, `ada_per_eur` mit 6 Nachkommastellen als String; `lovelace` als Ganzzahl.

### 12.5 Zustände und Endpunkte

```
authorized ──► submitting ──► submitted ──► confirmed
    │               │               │
    ▼               ▼ (Job, 600 s)  ▼ (tx_mismatch)
  failed         unknown ◄──────────┘
```

Jeder Wechsel läuft in einer Transaktion mit `SELECT … FOR UPDATE` auf die Intent-Zeile. Unbekannte `payout_id` → 404 `not_found`. Ein Request, dessen Zielzustand schon erreicht ist (bei `submitted` mit gleichem `tx_hash`), antwortet 200 mit der Intent-Sicht (idempotent). Jeder andere unerlaubte Wechsel → 409 `invalid_state`.

| Endpunkt | Erlaubt aus | Ergebnis |
| --- | --- | --- |
| `POST /v1/payouts/{payout_id}/submitting` | `authorized` | `submitting`. Regel 4 wird erneut geprüft; ist die Wallet jetzt gesperrt → 409 `wallet_blocked`, Zustand bleibt `authorized`. Das Auszahlungsmodul signiert erst nach dieser Antwort. |
| `POST /v1/payouts/{payout_id}/submitted` mit `{"tx_hash": "<64 hex>"}` | `submitting`, `unknown` | `submitted`, `tx_hash` gesetzt. `tx_hash` nicht passend zu `^[0-9a-f]{64}$` → 400 `invalid_request`. |
| `POST /v1/payouts/{payout_id}/confirm` | `submitted` | Der Server fragt selbst Blockfrost ab (siehe unten); bei Treffer `confirmed` |
| `POST /v1/payouts/{payout_id}/failed` | nur `authorized` | `failed`. Ab `submitting` ist ein Fehlschlag nicht mehr sicher feststellbar. |

**Bestätigung (`/confirm`).** `GET <BLOCKFROST_BASE_URL>/txs/<tx_hash>/utxos` mit Header `project_id: <BLOCKFROST_PROJECT_ID>`, Timeout `HTTP_TIMEOUT_MS`, kein Cache, kein Retry. Verlangt `BLOCKFROST_MODE=api`; im Modus `mock` → 503 `dependency_unavailable`.

| Blockfrost-Antwort | Ergebnis |
| --- | --- |
| 200, und mindestens ein Eintrag in `outputs` hat `address` = `to_address` (exakter Vergleich) und in `amount` den Eintrag `unit = "lovelace"` mit `quantity` ≥ `lovelace` | `confirmed`, 200 |
| 200, aber kein solcher Eintrag | 409 `tx_mismatch`, Zustand `unknown` |
| 404 (Transaktion noch nicht in einem Block) | 409 `tx_not_found`, Zustand bleibt `submitted`; `/confirm` darf später erneut aufgerufen werden |
| jede andere Antwort, Timeout, ungültiges JSON | 503 `dependency_unavailable`, Zustand bleibt `submitted` |

**`unknown`.** Ein Intent, der länger als 600 s in `submitting` steht, wird vom Hintergrundjob (12.8) auf `unknown` gesetzt. `unknown` wird nie automatisch wiederholt. Nach manueller Prüfung kann das Auszahlungsmodul eine gefundene Transaktion über `/submitted` nachtragen; sie wird dann wie jede andere über `/confirm` on-chain geprüft.

### 12.6 `GET /v1/suppliers/{supplier_hash}/history`

Liefert die Freigabe-Historie eines Lieferanten für die Agenten-Stufe, ohne Rohwerte. `supplier_hash` im Format aus 3.3 (`hmac:` + 64 Hex-Zeichen; der Doppelpunkt darf roh oder als `%3A` stehen); anderes Format → 400 `invalid_request`. Gibt es keine `invoices`-Zeile mit diesem `supplier_hash` → 404 `not_found`.

Ausgewertet werden nur Zeilen mit `final_decision = 'approved'` und `currency = 'EUR'`, sortiert nach `issue_date` absteigend, dann `created_at` absteigend (wie S-7).

```json
{ "supplier_hash": "hmac:…", "approved_count": 6, "median_eur": "1145.00",
  "last_amounts": ["1050.00", "1300.00", "1100.00", "980.00", "1250.00", "1190.00"],
  "first_seen": "2026-04-15" }
```

| Feld | Typ | Regel |
| --- | --- | --- |
| `approved_count` | int | Anzahl der ausgewerteten Zeilen |
| `median_eur` | string \| null | Median aller ausgewerteten `amount` wie bei I-4 (gerade Anzahl: Mittel der beiden mittleren Werte), `amount()` aus 3.3 (2 Nachkommastellen, kaufmännisch gerundet); `null` bei `approved_count = 0` |
| `last_amounts[]` | string | höchstens 6 Beträge, neueste zuerst, je `amount()` aus 3.3 |
| `first_seen` | string \| null | frühestes `issue_date` der ausgewerteten Zeilen, `YYYY-MM-DD`; `null` bei `approved_count = 0` |

### 12.7 Fehlercodes (Ergänzung zu 5.1)

| HTTP | `error` | Wann |
| --- | --- | --- |
| 409 | `not_approved` | Regel 1 |
| 409 | `currency_not_supported` | Regel 2 |
| 409 | `wallet_blocked` | Regel 4, auch bei `/submitting` |
| 409 | `xml_expired` | Regel 5, XML nicht mehr in Redis |
| 409 | `recipient_mismatch` | Regel 5, Adresse ungültig oder `wallet_hash` abweichend |
| 409 | `amount_zero` | Regel 6, `lovelace = 0` |
| 409 | `over_invoice_cap` | Regel 6 |
| 409 | `over_daily_cap` | Regel 7 |
| 409 | `network_not_allowed` | Regel 8 |
| 409 | `payouts_disabled` | `ADA_PER_EUR` nicht gesetzt |
| 409 | `invalid_state` | unerlaubter Zustandswechsel (12.5) |
| 409 | `tx_not_found` | `/confirm`, Blockfrost 404 |
| 409 | `tx_mismatch` | `/confirm`, keine passende Ausgabe |

### 12.8 Löschung und Hintergrundjobs

- **`subject-delete` (Ergänzung zu 7.3):** Vor Schritt 4 werden alle `payout_intents` gelöscht, deren `invoice_hash` zu einer der geladenen `invoices`-Zeilen gehört oder deren `wallet_hash = h` ist.
- **Aufbewahrung (Ergänzung zu FR-76):** Vor dem Löschen der `invoices`-Zeilen werden deren `payout_intents` gelöscht (Fremdschlüssel).
- **Neuer Job (Ergänzung zu 7.6):** alle 60 s; setzt Intents mit `state = 'submitting'` und `updated_at` älter als 600 s auf `unknown`.

### 12.9 Abnahmetests

Testumgebung wie 8.1, zusätzlich `ADA_PER_EUR=0.040000`, Standard-Caps (50 / 200 ADA) und ein `wiremock`-Stub für `GET /txs/<tx_hash>/utxos`. F1 ergibt damit `lovelace = floor(1190.00 × 0.040000 × 1_000_000) = 47600000`.

| # | Eingabe | Erwartung |
| --- | --- | --- |
| P1 | `authorize` für den Check aus Test 9 (Medium, offen) und aus Test 10 (High, `rejected`) | je 409 `not_approved`, kein Intent |
| P2 | Test 24 (USD), dann `POST /v1/decisions` `approved`, dann `authorize` | 409 `currency_not_supported` |
| P3 | Test 1, dann `authorize` zweimal; danach `/failed` und erneut `authorize` | gleiche `payout_id` bei allen Aufrufen, genau eine Zeile in `payout_intents`; letzter Aufruf 200 mit `state = "failed"` |
| P4 | Test 1, dann `sniffer blocklist-add --type wallet --value <W1> --reason TEST_PAYOUT`, dann `authorize` | 409 `wallet_blocked` |
| P5 | (a) `XML_TTL_SECONDS=1`, Test 1, 2 s warten, `authorize`; (b) Test 1, dann `sniffer:xml:<check_id>` durch F1 mit W2 ersetzen, `authorize` | (a) 409 `xml_expired`; (b) 409 `recipient_mismatch` |
| P6 | (a) Test 1, `authorize`; (b) `ADA_PER_EUR=0.050000`, Test 1, `authorize`; (c) Unit: BT-115 `1190.01`, `ADA_PER_EUR=0.033333` | (a) 200, `lovelace = 47600000`, `ada_per_eur = "0.040000"`; (b) 409 `over_invoice_cap` (59.5 ADA); (c) `lovelace = 39666603` |
| P7 | `PAYOUT_MAX_ADA_PER_DAY=90`; Test 1 + `authorize`; F1 mit Nummer `RE-2026-0413` (Low) + `authorize`; dann ersten Intent `/failed`, zweiten erneut `authorize` | zweiter Aufruf 409 `over_daily_cap` (95.2 ADA); nach `/failed` 200 |
| P8 | `EXPECTED_NETWORK=mainnet`, F1 mit W1-main (Low), `authorize` | 409 `network_not_allowed` |
| P9 | Intent aus P6 (a): `/submitted` → `/submitting` → `/submitting` → `/failed` → `/submitted` mit gültigem `tx_hash` → `/failed`; zweiter Lauf (frische Testdatenbank, Test 1 + `authorize`): `/submitting`, `updated_at` um 601 s zurücksetzen, Job ausführen | 409 `invalid_state`; 200 `submitting`; 200 (idempotent); 409 `invalid_state`; 200 `submitted`; 409 `invalid_state`; zweiter Intent `unknown` |
| P10 | Intent im Zustand `submitted`, Blockfrost-Stub für `/txs/<tx_hash>/utxos`: (a) Ausgabe an `to_address` mit `quantity = "47600000"`; (b) wie a, aber andere Adresse (W2); (c) wie a mit `quantity = "47599999"`; (d) 404; (e) a, danach `/confirm` erneut | (a) 200 `confirmed`; (b) 409 `tx_mismatch`, `unknown`; (c) 409 `tx_mismatch`, `unknown`; (d) 409 `tx_not_found`, bleibt `submitted`; (e) 200 `confirmed` (idempotent) |
| H1 | nach `db-seed`: `GET /v1/suppliers/<supplier_hash von A>/history`; dann mit unbekanntem Hash | `approved_count = 6`, `median_eur = "1145.00"`, `last_amounts = ["1050.00", "1300.00", "1100.00", "980.00", "1250.00", "1190.00"]`, `first_seen = "2026-04-15"`; unbekannter Hash 404 `not_found` |

---

## Anhang A: Validierte Beispielrechnung F1

Mit Mustang 2.26.0 am 30.10.2026 validiert: `summary status="valid"`, 15 Regeln ausgewertet, 0 fehlgeschlagen, Exit-Code 0. Alle Firmen und Nummern sind erfunden. Datei im Repo: `docs/fixtures/f1.xml`; beim Bau unverändert nach `tests/fixtures/f1.xml` kopieren.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
    xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
    xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
    xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0412</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20261028</udt:DateTimeString>
    </ram:IssueDateTime>
    <ram:IncludedNote>
      <ram:Content>Vielen Dank für Ihren Auftrag.</ram:Content>
    </ram:IncludedNote>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>1</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>Beratungsleistung Oktober</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>100.00</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="HUR">10</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>1000.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>04011000-12345-34</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Alpha Consulting GmbH</ram:Name>
        <ram:DefinedTradeContact>
          <ram:PersonName>Anna Alpha</ram:PersonName>
          <ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>+49 89 1234567</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication>
            <ram:URIID>rechnung@alpha-consulting.example</ram:URIID>
          </ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>80333</ram:PostcodeCode>
          <ram:LineOne>Musterstraße 1</ram:LineOne>
          <ram:CityName>München</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">rechnung@alpha-consulting.example</ram:URIID>
        </ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">DE111111111</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Käufer Handels AG</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>10115</ram:PostcodeCode>
          <ram:LineOne>Käuferweg 2</ram:LineOne>
          <ram:CityName>Berlin</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">einkauf@kaeufer-handels.example</ram:URIID>
        </ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">DE999999999</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:BuyerTradeParty>
      <ram:BuyerOrderReferencedDocument>
        <ram:IssuerAssignedID>PO-2026-001</ram:IssuerAssignedID>
      </ram:BuyerOrderReferencedDocument>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">20261027</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>RE-2026-0412</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>ZZZ</ram:TypeCode>
        <ram:Information>cardano:preprod:ADA</ram:Information>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:ProprietaryID>addr_test1qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyd24242424242424242424242424242424242424242424qmz2e4c</ram:ProprietaryID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>190.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>1000.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>Zahlbar innerhalb von 30 Tagen ohne Abzug.</ram:Description>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20261127</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>1000.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>1000.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">190.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>1190.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>1190.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
```

Varianten in 8.2 ändern nur die genannten Elemente. F9, F10 und F11 sind rechnerisch stimmig (Steuer = Basis × 19 %, auf 2 Stellen gerundet) und wurden ebenfalls mit Mustang 2.26.0 als gültig validiert.

---

## Anhang B: Echte Mustang-Ausgaben (2.26.0, 30.10.2026)

Dateien für Test 36 im Repo: `docs/fixtures/mustang/b1.xml` bis `b4.xml` (jeweils das vollständige stdout, ungekürzt); beim Bau nach `tests/fixtures/mustang/` kopieren.

**B.1 – F1 gültig (Exit 0)**
```xml
<validation filename="clean-a-w1.xml" datetime="2026-10-30 22:57:55">
  <xml>
    <info>
      <version>2</version>
      <profile>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</profile>
      <validator version="2.26.0"/>
      <rules>
        <fired>15</fired>
        <failed>0</failed>
      </rules>
      <duration unit="ms">797</duration>
    </info>
    <summary status="valid"/>
  </xml>
  <summary status="valid"/>
</validation>
```

**B.2 – Adresse in `IBANID` mit Code 58: nur Warnung, gültig (Exit 0)** (Attribut `criterion` gekürzt)
```xml
<validation filename="v-iban58.xml" datetime="2026-10-30 22:58:07">
  <xml>
    <info>
      <version>2</version>
      <profile>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</profile>
      <validator version="2.26.0"/>
      <rules>
        <fired>16</fired>
        <failed>1</failed>
      </rules>
      <duration unit="ms">806</duration>
    </info>
    <messages>
      <warning type="27" location="/rsm:CrossIndustryInvoice/rsm:SupplyChainTradeTransaction[1]/ram:ApplicableHeaderTradeSettlement[1]/ram:SpecifiedTradeSettlementPaymentMeans[1]" criterion="not(normalize-space(ram:TypeCode) = '58') or …">[BR-DE-19] "Payment account identifier" (BT-84) soll eine korrekte IBAN enthalten, wenn in "Payment means type code" (BT-81) mit dem Code 58 SEPA als Zahlungsmittel gefordert wird. [ID BR-DE-19] from /xslt/XR_30/XRechnung-CII-validation.xslt)</warning>
    </messages>
    <summary status="valid"/>
  </xml>
  <messages></messages>
  <summary status="valid"/>
</validation>
```

**B.3 – F1 ohne BT-10: Fehler BR-DE-15 (Exit 255)**
```xml
<validation filename="v-no-bt10.xml" datetime="2026-10-30 22:58:08">
  <xml>
    <info>
      <version>2</version>
      <profile>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</profile>
      <validator version="2.26.0"/>
      <rules>
        <fired>15</fired>
        <failed>1</failed>
      </rules>
      <duration unit="ms">820</duration>
    </info>
    <messages>
      <error type="27" location="/rsm:CrossIndustryInvoice" criterion="rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement/ram:BuyerReference[boolean(normalize-space(.))]">[BR-DE-15] Das Element "Buyer reference" (BT-10) muss übermittelt werden. [ID BR-DE-15] from /xslt/XR_30/XRechnung-CII-validation.xslt)</error>
    </messages>
    <summary status="invalid"/>
  </xml>
  <messages></messages>
  <summary status="invalid"/>
</validation>
```

**B.4 – abgeschnittene Datei: Exception (Exit 255)**
```xml
<validation filename="v-broken.xml" datetime="2026-10-30 22:58:09">
  <messages>
    <exception type="8">File does not look like PDF nor XML (contains neither %PDF nor &lt;?xml)</exception>
  </messages>
  <summary status="invalid"/>
</validation>
```
Im Ablauf tritt B.4 praktisch nicht auf, weil nicht wohlgeformtes XML schon in Schritt 2 als KO-1 erkannt wird. Erscheint trotzdem eine `exception`, gilt `MUSTANG_UNAVAILABLE`.
