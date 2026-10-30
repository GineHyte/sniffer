# Sniffer MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Project agents: start each milestone with `task-planner`, finish with `test-verifier`, then `safety-reviewer` (see `.claude/agents/AGENTS.md`).

**Goal:** Take one CII e-invoice (XRechnung/ZUGFeRD) paid to a Cardano address and run it end to end on Preprod: deterministic Initial Check, then three paid AI investigations for Medium cases, then a PAY / DONT_PAY decision, then a policy-checked ADA payout to the supplier.

**Architecture:** A Rust `sniffer` service implements spec v1.0 (`docs/initial-check-spec.md`) unchanged, except for the agreed routing change. It adds a payout policy extension. Node/TypeScript agents reuse the starter's Eve and Sokosumi plumbing. Main Sniffer is reached through an x402-paywalled intake. It creates one Sokosumi task per investigator and pays each investigator over x402, keyed by `taskId`. A TypeScript payout module uses Mesh SDK and signs with a dedicated Preprod payout wallet, but only after the Rust policy engine authorizes the payout.

**Tech Stack:**
- Rust: axum, tokio, sqlx, PostgreSQL 16, Redis 7, roxmltree, pallas-addresses, rust_decimal.
- Mustang CLI 2.26.0 on Java 21.
- Node 24 with Eve, `ai` and zod.
- Sokosumi CLI 1.0.4.
- `@x402/cardano` with the Cardano Foundation facilitator (Preprod).
- Mesh SDK and Blockfrost.
- Docker Compose.

---

## 0. Decision log

### Confirmed by user (30.10.2026)

| # | Topic | Decision |
|---|-------|----------|
| D1 | Agent-service payments | **x402**, replacing Masumi MPS. The existing MPS code stays in the repo with `PAID_TASKS_ENABLED=false` and is not deleted. |
| D2 | x402 flows | **Both.** (a) The customer pays Sniffer for invoice intake. (b) Main Sniffer pays each investigator. |
| D3 | Sokosumi ↔ x402 | **Sokosumi task + x402 gate.** Main creates a Sokosumi task and then pays `POST /pay/{taskId}` on the investigator. The investigator worker runs the task only after a settled payment for that `taskId`. |
| D4 | Supplier payout | **Minimal Preprod ADA transfer** through a Mesh SDK module, after a Rust policy check. Aiken is not used. |
| D5 | Signer / UI | **Server signer, no UI.** A dedicated Preprod payout wallet key lives in `.local/`. Interaction is CLI and JSON only. The Next.js frontend is post-MVP. |
| D6 | EUR → ADA | **Fixed demo rate** `ADA_PER_EUR` in config. The rate used is stored with each payout intent. |
| D7 | Medium-case decision | **LLM decision per `promts/main_agent_prompt.txt`.** Medium → LOW (PAY) or HIGH (DONT_PAY), fail closed, with code guardrails (§ M4). |
| D8 | Agent routing | **Change the spec.** S-8 and S-9 move from `invoice` to `research`. `MUSTANG_UNAVAILABLE` stays with `invoice`, and the Invoice prompt gets an explicit exception. |

### Defaults I chose (change if you disagree)

| # | Topic | Default | Why |
|---|-------|---------|-----|
| A1 | Spec agent `research` | = **Supplier Investigator** | All `research` tasks (S-1, S-2, S-4, S-7, VIES, sanctions) are supplier or identity checks. |
| A2 | Repo layout | Rust in `backend/` (the spec's tree from §2 sits inside it). Node agents stay at the repo root. Payout module in `payout/`. | AGENTS.md says to keep the starter's working paths. This avoids mixing `src/` and `Cargo.toml` with the `*.mjs` files. |
| A3 | DONT_PAY → `/v1/decisions` | If evidence of risk exists → `rejected`/`risk`. If verification failed or data was insufficient → `rejected`/`formal`. | Main prompt: "operational block does not mean fraud is proven". `formal` does not penalize the wallet counters (spec 5.4). |
| A4 | `block_wallet` | `true` only when the Wallet Investigator returns `CRITICAL` **and** `critical_issue=true` | Least-surprise rule. A block is a strong, persistent action. |
| A5 | Decline-reason language | German, built from the `customer_text` of the criteria concerned plus a short evidence summary. The words "Betrug" and "Fraud" are never used (spec 5.1 `forbidden_wording`). | Matches the spec texts. |
| A6 | Data given to investigators | Main reads the raw XML through `GET /v1/checks/{id}/xml` and gives each investigator only the fields for its domain (per main prompt Step 4). | Spec FR-32 limits only Sniffer's own storage. Investigators need names and addresses for research. |
| A7 | Investigator processes | One worker and one x402 API per role (`ROLE=invoice\|wallet\|supplier`), each with its own Coworker ID and its own lock file | The starter's worker lock allows one worker per Coworker. |
| A8 | x402 asset | tADA on Preprod | No token faucet is needed. `@x402/cardano` supports ADA. |
| A9 | Payout cap | `PAYOUT_MAX_ADA_PER_INVOICE=50` and `PAYOUT_MAX_ADA_PER_DAY=200` (config) | Preprod safety. The policy engine rejects anything above these caps. |

### Confirmed by user (31.10.2026): O1 and O2 accepted as proposed. Defaults A1–A9 accepted.

| # | Issue | Decision |
|---|-------|----------------------------|
| O1 | **FR-32 vs payout ledger.** Recovering a payout needs the raw supplier address and the lovelace amount. The XML in Redis expires after `XML_TTL_SECONDS` (24 h), and FR-32 forbids raw addresses in Postgres. | New table `payout_intents` stores the raw `to_address` as a **documented FR-32 exception**, justified because the address is public on-chain once paid. The exception is added to the spec as FR-32a. |
| O2 | **Invoice Investigator history.** The prompt wants historical prices and line items. Sniffer stores only hashes and totals, so historical price comparison is impossible. | Investigators get the supplier's approved-amount history (count, median, last 6 totals) from a new read-only endpoint `GET /v1/suppliers/{supplier_hash}/history`. Line-item comparison reports `INSUFFICIENT_DATA`. |

---

## 1. Issues found in the docs

1. **Routing conflict** (resolved by D8). The spec sends S-8 and S-9 to `invoice`, but the Invoice prompt forbids supplier-credibility checks. `MUSTANG_UNAVAILABLE` asks the Invoice agent to "check formal validity", but the prompt forbids repeating XML validation.
2. **No prompt for `research`** (resolved by A1).
3. **x402 vs Masumi** (resolved by D1). The tech stack says x402, while the starter implements Masumi MPS.
4. **No documented Sokosumi ↔ x402 integration** (resolved by D3, which defines a custom gate).
5. **Payment scope gap** (resolved by D4/D6). The spec excludes payment execution and EUR→ADA conversion. The tech stack and main prompt require a payout.
6. **Main prompt thresholds** "LOW 0–19 / MEDIUM 20–59 / HIGH 60–100" are not the whole band rule. The spec also gives Medium for a score of 0 (I-12 fired, or critical `checks_incomplete`). **Rule:** Main uses `summary.band` and never recomputes it from the score.
7. **Decision vocabulary mismatch.** The main prompt says `PAY`/`DONT_PAY`, while the spec uses `approved`/`rejected` + `reason_type` + `block_wallet` + `decline_reasons`. The mapping is defined in A3–A5.
8. **FR-32 vs payout ledger** (O1).
9. **Investigator inputs are partly impossible** (O2). The Wallet prompt also wants "previously recorded supplier addresses", but only hashes exist. Investigators get `known`/`approved`/pair counts from the result JSON instead.
10. **The tech stack lists the KoSIT Validator**, while the spec uses only Mustang. The spec wins for the MVP, so KoSIT is post-MVP.
11. **Tooling (fixed 31.10.2026):**
    - Node 24.22.2 via nvm.
    - Sokosumi CLI 1.0.4.
    - Rust 1.99.1 / cargo 1.99.1.
    - Java 17 and Docker 29.7.
13. **Windows bug:** `sokosumiRoot()` in `sokosumi-runtime.mjs` requires a path ending in `/skills`. On Windows, `sokosumi skills path` returns `…\skills\`, so the worker and comments cannot start here. Baseline `npm test` on Windows has 3 failures (path separators, POSIX file modes). Fixed in Task 4b.
12. The folder name `promts/` is a typo. Kept as is; the paths below use it.

---

## 2. Target architecture

```
Customer ──x402──► Main Sniffer API (Node, :21951)  POST /v1/invoices {xml}
                        │ Bearer
                        ▼
              Rust sniffer (:8080) POST /v1/initial-check ──► band
                        │
        ┌───────────────┼──────────────────────────┐
       LOW            MEDIUM                      HIGH
        │   ┌──────────┴───────────┐               │
        │   │ 3× Sokosumi task     │          DONT_PAY report
        │   │ 3× x402 POST /pay/id │
        │   ▼                      ▼
        │  Invoice / Wallet / Supplier investigator
        │  (worker + x402 API per role, :21961-21963)
        │   └──── 3 JSON reports ───┘
        │          Main LLM → PAY/DONT_PAY → POST /v1/decisions
        ▼                      │ approved
   Rust POST /v1/payouts/authorize (policy) ──► payout/ (Mesh SDK, signer)
                                                └─► Blockfrost confirm ─► POST /v1/payouts/{id}/confirm
```

| Component | Path | Port |
|-----------|------|------|
| Rust Initial Check + payout policy | `backend/` | 8080 |
| Postgres 16, Redis 7 | `docker-compose.yml` | 5432, 6379 |
| Eve model runtime | `start.mjs` (existing) | 21949 |
| Main Sniffer intake API (x402) | `main/api.mjs` | 21951 |
| Investigator x402 API ×3 | `investigator/api.mjs ROLE=…` | 21961 / 21962 / 21963 |
| Investigator worker ×3 | `worker.mjs ROLE=…` (adapted) | – |
| Payout module | `payout/` | CLI, called by Main |

---

## 3. Prerequisites (user actions, need authorization)

1. Install Node 24 LTS. Check: `node --version` shows `v24.x`.
2. `npm install --global @masumi_network/sokosumi@1.0.4`, then `sokosumi --version` and `sokosumi skills`. Read the current skills and help before provisioning (AGENTS.md).
3. `rustup update stable`, then pin that exact version in `backend/rust-toolchain.toml`.
4. Set `AGENT_AUTHOR` in `.env` (required before agent registration).
5. Fresh Preprod resources for this project only:
   - 3 Coworkers (invoice, wallet, supplier)
   - wallets: customer test wallet, Sniffer receiving wallet, Main paying wallet, 3 investigator receiving wallets, 1 payout wallet
   - Blockfrost Preprod key

   Fund the wallets from the Preprod faucet. **Each creation and transfer is a separate authorization step** (`sokosumi-provisioner` / `payments-registrar` ask first).

---

## Agent assignment (small tasks, one owner each)

Rule: only one agent edits a given file at a time. Agents do not commit; the main session reviews and commits per wave on branch `feat/mvp`.

| Wave | Small task | Owner agent | Files (exclusive) | Depends on |
|------|-----------|-------------|-------------------|------------|
| 0 | T1+T2 spec routing + §12 payout extension + FR-32a | general-purpose | `docs/initial-check-spec.md` | – |
| 0 | T3 prompt alignment | agent-builder | `promts/*.txt` | – |
| 0 | T4 skeleton, compose, gitignore | general-purpose | `docker-compose.yml`, `.gitignore`, `backend/` dirs | – |
| 0 | T4b Windows path bug + platform-aware tests | worker-integrator | `sokosumi-runtime.mjs`, `start.test.mjs`, `worker-lock.test.mjs`, new `sokosumi-runtime.test.mjs` | – |
| 1 | T5 Cargo crate, toolchain pin, clap stubs | general-purpose | `backend/Cargo.*`, `backend/rust-toolchain.toml`, `backend/src/main.rs` | T4 |
| 2 | T6 normalize.rs (Test 35) | general-purpose | `backend/src/normalize.rs`, `backend/data/legal-forms.json` | T5 |
| 2 | T7 hashing.rs (Test 34) | general-purpose | `backend/src/hashing.rs` | T5 |
| 2 | T8 address.rs (Test 37) | general-purpose | `backend/src/address.rs` | T5 |
| 2 | T12 migrations + store | general-purpose | `backend/migrations/0001_init.sql`, `backend/src/store/*` | T5 |
| 3 | T9 config.rs + criteria.json + data/* | general-purpose | `backend/src/config.rs`, `backend/config/*`, `backend/data/*` (except legal-forms) | T6 |
| 3 | T10 parse.rs + fixtures | general-purpose | `backend/src/parse.rs`, `backend/tests/fixtures/*` | T6 |
| 3 | T11 mustang.rs (Test 36) | general-purpose | `backend/src/mustang.rs` | T5 |
| 3 | T13 sources/* (wiremock) | general-purpose | `backend/src/sources/*` | T12 |
| 4 | T14 criteria/* | general-purpose | `backend/src/criteria/*`, `backend/src/model.rs` | T6–T13 |
| 4 | T15 scoring.rs | general-purpose | `backend/src/scoring.rs` | T14 |
| 5 | T16 api.rs + flow (Tests 1–33) | general-purpose | `backend/src/api.rs`, `backend/tests/acceptance.rs` | T14, T15 |
| 5 | T17 decisions.rs (Tests 13, 26) | general-purpose | `backend/src/decisions.rs` | T16 |
| 5 | T18 sanctions, jobs, CLI, seed, Dockerfile | general-purpose | `backend/src/{sanctions,jobs}.rs`, `backend/seed/*`, `backend/Dockerfile` | T16 |
| 6 | T19 payout policy + 0002 migration | general-purpose | `backend/src/payouts.rs`, `backend/migrations/0002_payouts.sql` | T17 |
| 6 | T20 supplier history endpoint | general-purpose | `backend/src/history.rs` | T16 |
| 6 | T21 x402 spike (read-only; Preprod payment needs approval) | general-purpose | `docs/x402-notes.md` | – |
| 7 | T22 x402 wrapper | worker-integrator | `x402/*` | T21 |
| 7 | T23 report schemas | agent-builder | `agents/report-schema.*` | – |
| 7 | T24 multi-role Eve | agent-builder | `agent/*`, `client.mjs`, `agent-config.test.mjs` | T23 |
| 8 | T25 investigator API + worker gate | worker-integrator | `investigator/*`, `worker.mjs`, `worker-lock.mjs` | T22, T24 |
| 8 | T26 main orchestrator | worker-integrator | `main/*` | T22, T24 |
| 8 | T27 payout module | general-purpose | `payout/*` | T19 |
| 9 | T28 live provisioning (asks each step) | sokosumi-provisioner + payments-registrar | `.env`, `.local/` | T25, T26 |
| 9 | T29 E2E demo | test-verifier | `scripts/demo.mjs`, `docs/demo.md` | T28 |
| 9 | T30 verify + review + README | test-verifier → safety-reviewer → general-purpose | `README.md` | T29 |

## M0: Setup and doc fixes

### Task 1: Apply the routing change to the spec (D8)

**Files:** Modify `docs/initial-check-spec.md` (§3.6.2 table rows S-8 and S-9: column Agent `invoice` → `research`; §6.2 JSON entries S-8 and S-9 `"agent": "invoice"` → `"agent": "research"`; §10 add a row: "S-8/S-9 → research: Invoice Investigator darf keine Lieferantenprüfung").

**Step 1:** Make the edits.
**Step 2:** `grep -n '"S-8"\|"S-9"' docs/initial-check-spec.md` shows `research` in both places.
**Step 3:** Commit `docs(spec): route S-8 and S-9 to research agent`.

### Task 2: Add the FR-32a payout exception and supplier-history endpoint to the spec (O1, O2, after you confirm)

**Files:** `docs/initial-check-spec.md`. Add §12 "Erweiterung Auszahlung (MVP)" with tables `payout_intents` (Task 19), endpoints `/v1/payouts/*` and `GET /v1/suppliers/{hash}/history`, and rule FR-32a.
**Commit:** `docs(spec): add payout extension and FR-32a`.

### Task 3: Fix the prompts

**Files:**
- `promts/invoice_investigator.txt`: add the exception "If the task source is `MUSTANG_UNAVAILABLE`, review the supplied invoice fields for obvious formal gaps; do not claim schema validation."
- `promts/supplier_investigator.txt`: add "Tasks with source S-8 and S-9 are in your scope."
- `promts/main_agent_prompt.txt`:
  - "Use `summary.band` from the Rust engine; never derive the band from the score."
  - Add a section "Decision mapping" with the A3–A5 rules.
  - Add a rule that `decline_reasons` must be German and must not contain "Betrug"/"Fraud".

**Commit:** `docs(prompts): align investigator scopes with spec routing`.

### Task 4: Repo skeleton and ignores

**Files:** Create `backend/`, `main/`, `investigator/`, `payout/`, `docker-compose.yml`. Modify `.gitignore`: add `backend/target/` and `.local/`; `payout/state/` must never be committed.
`docker-compose.yml`: pinned `postgres:16.x` and `redis:7.x` tags. The `sniffer` service is added in Task 18.
**Check:** `docker compose up -d postgres redis && docker compose ps` shows both healthy.
**Commit:** `chore: add MVP skeleton and compose for postgres and redis`.

---

## M1: Rust Initial Check (spec v1.0, exactly as written)

The spec is the source of truth. Every task follows the same TDD loop:
1. Write the acceptance or unit test from spec §8.3.
2. `cargo test <name>` fails.
3. Implement.
4. The test passes.
5. Commit.

All commands run in `backend/`. Pin crates as `=x.y.z` (spec §2).

| Task | Module (spec §) | Tests that must pass | Notes |
|------|-----------------|----------------------|-------|
| 5 | `Cargo.toml`, `rust-toolchain.toml`, `main.rs` clap stubs (`serve`, `migrate`, `lists-update`, `blocklist-add/remove`, `subject-delete`, `db-seed`) | `cargo build` | Pin roxmltree 0.21.2, pallas-addresses 1.4.0, unicode-normalization 0.1.26. |
| 6 | `normalize.rs` (3.3) | Test 35 (all normalization vectors) | `tokens`, `name` with legal-form loop, `vat`, `phone`, `postal`. |
| 7 | `hashing.rs` (3.3) | Test 34 (HMAC vectors) | Key from the spec test vector. |
| 8 | `address.rs` (3.4) | Test 37 (W1–W5, M, W1-main, W1-bad) | **Credential = identity.** M must share its credential with W3. |
| 9 | `config.rs` (6.1, 6.2, 6.3) + `config/criteria.json` (with the Task 1 change) + `data/*.json` | Unit: start-up checks from 6.2 fail on a missing ID, wrong `kind`, or a "Betrug" text | `config_sha256` = SHA-256 of the file bytes. |
| 10 | `parse.rs` (3.1, FR-11..14) | Tests 2, 3, 29, 30, 31 (with a mocked pipeline) | Copy the fixtures `docs/fixtures/*` → `backend/tests/fixtures/` unchanged. |
| 11 | `mustang.rs` (3.7.1) | Test 36 (B.1–B.4); Tests 22–23 behind `SNIFFER_TEST_MUSTANG=1` | Semaphore `MUSTANG_MAX_PARALLEL`; temp file with mode 0600. Note: on Windows, 0600 is a no-op, so document that it is enforced only in the Linux container. |
| 12 | `store/postgres.rs` + `migrations/0001_init.sql` (3.9), `store/redis.rs` | `sniffer migrate` against compose | Schema `sniffer`, `search_path` in `after_connect`. |
| 13 | `sources/{blockfrost,vies,chainabuse,mock}.rs` (3.7.2–3.7.4, 3.7.6) | wiremock unit tests per source: success, 404, timeout, bad JSON | Cache keys use the `sniffer:` prefix. |
| 14 | `criteria/` trait + registry (3.6.0), `ko.rs`, `supplier.rs`, `wallet.rs`, `invoice.rs`, `reducers.rs` | Unit test per criterion: one firing and one non-firing case | IDs are `String`, never an `enum` (§4 extensibility). |
| 15 | `scoring.rs` (3.8) | Unit: reducer cap with remaining budget; reducers blocked by ≥ 25; band rules 1–6 in order; sort orders | |
| 16 | `api.rs` + flow (3.5, §5.1–5.3, 5.5) + `model.rs` (§4) | Tests 1, 4–25, 27, 28, 32, 33 | Lock with `SET NX PX`; one transaction per check; Redis written before commit (FR-63). |
| 17 | `decisions.rs` (5.4) | Tests 13, 26 a–g | `SELECT … FOR UPDATE`; idempotent repeat; forbidden wording. |
| 18 | `sanctions.rs`, `jobs.rs`, the CLI commands, `seed/seed.json` (7.x), `Dockerfile` (Mustang SHA-256 check), compose service `sniffer` | `sniffer db-seed` then Test 1 again; `docker compose up` passes `/health` | OFAC import plausibility (≥ 1000 entries). |

**Milestone gate M1:** `cargo test` passes for all 37 spec tests (22–23 only with Mustang). Run `test-verifier` and record the evidence in the PR.

---

## M2: Payout policy extension (Rust)

### Task 19: `migrations/0002_payouts.sql` and the policy engine

**Files:** Create `backend/migrations/0002_payouts.sql`, `backend/src/payouts.rs`. Modify `backend/src/api.rs`.

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

**`POST /v1/payouts/authorize`** takes `{check_id}`. It returns `{payout_id, to_address, lovelace}` or a 409 with a reason code. The policy is deterministic, and each rule below is one test:
1. An `invoices` row exists and `final_decision = 'approved'`. Otherwise `not_approved`.
2. `currency = 'EUR'`. Otherwise `currency_not_supported`.
3. No existing intent for `invoice_hash`. If one exists → 200 with that same intent (idempotent), never a second one.
4. The wallet is not `blocked` (it is re-read now; it may have been blocked after approval). Otherwise `wallet_blocked`.
5. The XML is still in Redis, and `wallet_hash` recomputed from its BT-84 equals `invoices.wallet_hash`. Otherwise `recipient_mismatch` or `xml_expired`.
6. `lovelace = floor(BT-115 × ADA_PER_EUR × 1_000_000)` and must be ≤ `PAYOUT_MAX_ADA_PER_INVOICE`. Otherwise `over_invoice_cap`.
7. The sum of today's (UTC) non-failed intents + this one must be ≤ `PAYOUT_MAX_ADA_PER_DAY`. Otherwise `over_daily_cap`.
8. `EXPECTED_NETWORK = preprod`. Otherwise `network_not_allowed`.

**State transitions:**
- `POST /v1/payouts/{id}/submitting`: `authorized` → `submitting`.
- `POST /v1/payouts/{id}/submitted {tx_hash}`.
- `POST /v1/payouts/{id}/confirm`: the server itself checks Blockfrost `GET /txs/{hash}` and confirms only if one output pays `to_address` ≥ `lovelace`.
- `POST /v1/payouts/{id}/failed`: allowed only from `authorized`.

A `submitting` intent whose outcome is unknown → `unknown`. It is never retried automatically and needs manual inspection.

**Tests:** one integration test per rule 1–8, plus idempotency, plus a confirm with a wiremock Blockfrost stub (matching output, wrong address, too little).
**Commit:** `feat(backend): add payout policy engine and intents ledger`.

### Task 20: `GET /v1/suppliers/{supplier_hash}/history` (O2)

Returns `{approved_count, median_eur, last_amounts: [..6], first_seen}` from `invoices`, with no raw values.
**Test:** after the seed, A has `approved_count=6` and `median_eur="1145.00"`.
**Commit:** `feat(backend): add supplier history read endpoint`.

---

## M3: x402 integration (spike first)

### Task 21: x402 spike (no external writes without approval)

**Goal:** Verify on Preprod the current `@x402/cardano` package version, its client/server API, the facilitator URL, and the payment payload shape. Coverage from Sep 2026 says the facilitator works on Preprod and is not yet on mainnet. **Do not code against remembered APIs.** Read the package README and types.
**Output:** `docs/x402-notes.md` with the pinned version, the facilitator URL, a minimal server and client snippet, and one measured Preprod payment (tx hash) between two fresh test wallets, made with user approval.
**Gate:** if the spike fails, stop and ask the user (the fallback is Masumi MPS, already in the repo).

### Task 22: `x402/` shared wrapper

**Files:** Create `x402/gate.mjs`, `x402/pay.mjs`, `x402/gate.test.mjs`.

```js
// gate.mjs: wraps the verified @x402/cardano server API from Task 21
export function x402Gate({priceLovelace, payTo, facilitatorUrl, resourceId}) // → (req,res)=>Promise<{paid:true,txHash}|null>
// pay.mjs: wraps the verified client API; idempotent per key
export async function payOnce({url, key, journalDir}) // journal phase: pending → paid|unknown; unknown never auto-retried
```

**Tests** (unit, facilitator mocked):
- Unpaid request → 402 with requirements.
- Valid payment → handler runs.
- Replayed payment for another `resourceId` → rejected.
- `payOnce` with an existing `paid` journal → no new payment.
- `payOnce` with an `unknown` journal → throws "inspect".

**Commit:** `feat(x402): add payment gate and idempotent payer`.

---

## M4: Agents

### Task 23: Shared report schema

**Files:** Create `agents/report-schema.mjs`, `agents/report-schema.test.mjs`. Zod schemas exactly as in the three investigator prompts (`schema_version`, `agent`, `case_id`, `task_id`, `verdict` ∈ CLEAR|CONCERN|CRITICAL|INSUFFICIENT_DATA, `findings[]`, `evidence[]`, `checks_completed`, `checks_not_verified`, `missing_information`, `critical_issue`, `explanation`), plus the main-prompt output schema.
**Tests:** a valid sample passes; a missing verdict fails; extra prose around the JSON fails.
**Commit:** `feat(agents): add investigator and main report schemas`.

### Task 24: Multi-role Eve agent (spike + implement)

**Spike:** check whether Eve 0.71.0 can serve several agent definitions or system prompts from one runtime. If not, run one Eve process per role with `EVE_PORT` per role (`start.mjs` already parameterizes the port).
**Files:** Modify `agent/agent.ts` to load the instructions from `promts/<role>.txt` chosen by `AGENT_ROLE`. Modify `client.mjs` to validate output against Task 23 (one repair retry, then fail closed).
**Tests:** `agent-config.test.mjs` is extended: an unknown role is rejected and each role loads a non-empty prompt.
**Commit:** `feat(agent): support investigator and main roles`.

### Task 25: Investigator API + worker (per role)

**Files:**
- Create `investigator/api.mjs` (`POST /pay/{taskId}` behind `x402Gate`, recording `paid` in `.local/<role>/<taskId>.json`).
- Modify `worker.mjs` and `worker-lock.mjs` to read `ROLE`, use a lock file per role, and process a READY task **only if** the journal shows `paid` for that `taskId`; otherwise skip and log.
- Create `investigator/input.mjs` (parse the task description JSON `{case_id, task_id, tasks[], data}`).

**Tests:**
- Unpaid task → not started.
- Paid task → `runtime start` → model → `runtime complete`, with a valid report.
- A second worker for the same role cannot start (lock).
- Existing `task-target.test.mjs` and `worker-lock.test.mjs` still pass.

**Commit:** `feat(investigator): gate Sokosumi tasks on x402 payment`.

### Task 26: Main Sniffer orchestrator

**Files:** Create `main/api.mjs`, `main/orchestrate.mjs`, `main/decide.mjs`, `main/*.test.mjs`.

Flow for `POST /v1/invoices` (behind `x402Gate`, customer pays):
1. Call Rust `POST /v1/initial-check` with the Bearer token → result.
2. `band = result.summary.band`; the score is never re-derived.
3. **low**: go to payout (Task 27).
4. **high**: DONT_PAY report, no investigators, no payout.
5. **medium**:
   - Fetch the XML (`/v1/checks/{id}/xml`) and the supplier history (Task 20).
   - Build three domain-scoped inputs (A6) with the `agent_tasks` per agent (`research` → supplier).
   - Create three Sokosumi tasks (`sokosumi --preprod tasks create … --coworker-id <role id>`). Journal each `taskId` before the next write.
   - `payOnce` for each `investigator/pay/{taskId}`.
   - Poll until COMPLETED or timeout `INVESTIGATION_TIMEOUT_MS` (default 15 min).
   - Validate each report with Task 23.
   - Run the Main LLM with all reports → main-prompt JSON.
   - `decide.mjs` maps and enforces the guardrails, then `POST /v1/decisions`.
   - If approved → payout.

**Guardrails in `decide.mjs`** (code wins over the LLM):

```js
export function decide(llm, reports) {
  const missing = ['invoice','wallet','supplier'].filter(r => !reports[r]?.valid);
  const critical = Object.values(reports).some(r => r.valid && r.report.verdict === 'CRITICAL');
  const insufficient = Object.values(reports).some(r => r.valid && r.report.verdict === 'INSUFFICIENT_DATA');
  if (missing.length || insufficient) return {decision: 'rejected', reason_type: 'formal', block_wallet: false};  // fail closed, no wallet penalty (A3)
  if (critical || llm.decision === 'DONT_PAY') return {decision: 'rejected', reason_type: 'risk',
    block_wallet: reports.wallet.report.verdict === 'CRITICAL' && reports.wallet.report.critical_issue === true}; // A4
  return {decision: 'approved', reason_type: null, block_wallet: false};
}
```

`decline_reasons` (German, 1–10) come from the `customer_text` of the criteria behind the strongest findings. They are checked locally for `betrug|fraud` before sending (A5).

**Tests** (`node --test`):
- One test per `decide` rule.
- High → no Sokosumi call.
- Low → no investigators.
- Medium: one investigator times out → `rejected`/`formal`.
- Restart after a crash between task creation and payment → no duplicate task or payment (journal).

**Commit:** `feat(main): orchestrate medium-risk investigations`.

### Task 27: Payout module (Mesh SDK)

**Files:** Create `payout/transfer.mjs`, `payout/transfer.test.mjs`, `payout/package.json` with pinned versions (or add to the root `package.json`, keeping pins).
Flow:
1. `POST /v1/payouts/authorize`.
2. If the state is `authorized` → mark `submitting` → build the tx with Mesh SDK (payout wallet key from `.local/payout.env`) → submit → `submitted {tx_hash}` → poll `confirm`.
3. A crash during `submitting` → state `unknown` → stop and print the inspection steps. **Never resubmit automatically.**

**Tests** (Mesh and the backend mocked):
- `authorized` → `confirmed`.
- An existing `submitted` intent → resumes the confirm and builds no new tx.
- `unknown` → throws.
- The key is never logged (assert log output).

**Commit:** `feat(payout): add policy-gated Preprod ADA transfer`.

---

## M5: End to end and handoff

### Task 28: Provision live resources (asks the user at each step)

`sokosumi-provisioner` creates the Vendor and the 3 Coworkers, connects them, and writes the IDs into `.env` (`COWORKER_ID_INVOICE`, `_WALLET`, `_SUPPLIER`). `payments-registrar` creates and funds the wallets for D2/A8 and the payout wallet. Nothing is copied from other projects.

### Task 29: E2E demo script

**Files:** Create `scripts/demo.mjs` and `docs/demo.md`.
1. `docker compose up -d` → `sniffer db-seed --file seed/seed.json` → mock modes for VIES and Chainabuse (fictional companies).
2. **F1** (Low): customer x402 payment → approve → payout confirmed (tx hash measured on Blockfrost).
3. **F9** (Medium): 3 tasks + 3 x402 payments → reports → decision → payout or DONT_PAY.
4. **F10** (High): DONT_PAY, no investigators, no payout.

**Evidence:** tx hashes, task IDs and check IDs recorded in `docs/demo.md`. No claim is made without a measured tx (AGENTS.md).

### Task 30: Verify and review

`npm test`, `cargo test` (+ Mustang tests), the demo run, then `safety-reviewer` on the diff (secrets, `.local/`, pinned deps, foreign IDs). Update `README.md`: replace the team-name-finder text with Sniffer run steps.

---

## Out of MVP scope

- Next.js/React dashboard, React Flow, CIP-30 wallet connect (D5)
- KoSIT validator
- Aiken vault
- Cardano Card / MIP-003 retail integration
- Wallet-signature criteria SIG-1..4 (spec §11)
- OpenTelemetry, Cloudflare, SSE
- Mainnet

## Risks

| Risk | Mitigation |
|------|------------|
| The x402 Cardano facilitator is immature (Preprod only) | Task 21 spike gate. Masumi MPS fallback is already in the repo. |
| Eve may not run several roles in one process | Task 24 spike. Fallback: one Eve process per role. |
| Mustang is slow or Java is missing on Windows | `MUSTANG_MODE=mock_valid` for dev. Real Mustang runs in the Docker image. |
| LLM output is not valid JSON | Zod validation, one repair retry, then fail closed (`rejected`/`formal`). |
| Duplicate payment after a crash | Journals before every external write. The `unknown` state is never retried automatically. |
