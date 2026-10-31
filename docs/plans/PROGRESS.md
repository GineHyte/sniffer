# Sniffer MVP: Progress Journal

Read this first when resuming. The full plan is in `docs/plans/2026-10-30-sniffer-mvp.md` (decision log §0 and agent-assignment table).
Last update: 2026-10-31 (evening, macOS). Work happens directly on `main`, pushed to `origin/main` (public repo `GineHyte/sniffer`; git push works via `gh auth setup-git`, account `Skifry`).
Overall: **about 95%.** Code, live provisioning (T28) and paid E2E runs on Preprod (T29) are done; the low-risk and medium-risk paths both ran end to end. Left: a medium-risk *approval* run with the open-order change, optional parallel investigator payments, T30 (safety review, final README).

## RESUME HERE (state at 2026-10-31 ~05:10 UTC)
**Next step for the user:** `sokosumi --preprod auth login` (OAuth session lasts ~2 h), then
`npm run preflight -- --new-supplier --fresh-wallet` and `npm run demo -- --confirm-live-payment --new-supplier --fresh-wallet`.
This is the first live run with the matched open order passed to investigators (39e2c65). Expected (computed, not measured): score 20, medium, supplier DE333333333 / PO-2026-003. After it only DE555555555 is left as a fresh mock supplier; add new VATs to `backend/data/vies-mock.json` + `open-orders.json` (then `npm run stack`) for more runs.
**Remind the user** about the deferred optimisation: pay the 3 investigators in parallel by splitting `main-payer` into ≥3 UTxOs (~1.5 min saving per medium case; measured ~2 min sequential in `case-eb1afa98…`).

**How to run everything** (all bind 127.0.0.1; logs went to the Claude scratchpad, which is session-specific):
- `npm run stack` — Postgres, Redis (host 6380), Rust backend :8080 (rebuilds the image; needed after backend code or `backend/data/*` changes).
- `npm run investigator:eve -- <invoice|wallet|supplier|main>` — Claude-backed Eve runtimes :21971–21974. Restart after any `promts/` change (they copy prompts into `.local/eve-<role>/` on start).
- `npm run investigator:api -- <invoice|wallet|supplier>` — x402 APIs :21961–21963.
- `npm run investigator:worker -- <invoice|wallet|supplier>` — Sokosumi workers (Celeris), keys in the macOS Keychain.
- `npm run main -- --confirm-live-payments` — Main :21951 (restart after `main/`, `x402/`, `payout/` changes).
- `npm run preflight` (read-only check of all of the above) and `npm run demo -- --confirm-live-payment [--invoice-number N] [--new-supplier] [--fresh-wallet] [--case ID]`.
Processes were started with `nohup` in the background; stop with `pkill -f "main/api.mjs"` etc. Tests: `npm test` 245/245; `cargo test --lib` 302 (+3 ignored); OpenAPI lint clean.

**Wallet balances (approx.):** payer ~94 tADA (test customer), main-payer ~100 tADA, payout ~100 tADA (funded from the faucet 2026-10-31).

**Sandbox notes for Claude:** the auto-mode classifier blocks reading `.local/*.env`, minting Sokosumi keys and creating Sokosumi tasks — give the user the command with `!` instead. Appending to `.local/live.env` (no read) works.

## Working rules (from the user)
- Split work into small tasks. Give each task to one project agent (see `.claude/agents/AGENTS.md`). Only one agent edits a given file at a time.
- Agents do not commit. The main session checks each wave (tests, clippy, fmt) and commits it.
- When docs conflict, or there are two valid points of view, **ask the user**.
- Get user authorization before any external write, resource creation, funds transfer, deployment or publishing (AGENTS.md).
- Write commit messages normally. They end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (all confirmed, details in plan §0)
- **Payments:** agent-service payments use **x402**, for both flows: customer → Sniffer intake, and Main → each investigator.
- **Sokosumi + x402:** one Sokosumi task per investigator. The investigator's `POST /pay/{taskId}` is behind an x402 gate.
- **Supplier payout:** a minimal Preprod ADA transfer with a server signer and no UI. EUR→ADA uses a fixed rate `ADA_PER_EUR`. **SDK: `@evolution-sdk/evolution` 0.5.19 (already pinned), not Mesh** (user decision 2026-10-31; no new deps).
- **Main decision:** an LLM decides per `promts/main_agent_prompt.txt`. Code guardrails override it:
  - A missing report or INSUFFICIENT_DATA → `rejected`/`formal`.
  - A CRITICAL report or DONT_PAY → `rejected`/`risk`.
  - `block_wallet` only when the Wallet report is CRITICAL with `critical_issue`.
- **Agent routing:** spec agent `research` = Supplier Investigator. S-8 and S-9 are routed to `research`.
- **Payout ledger:** FR-32a allows the raw `to_address` in `payout_intents`. The new supplier-history endpoint is §12.6.

## Done (with evidence)
| Task | Result |
|---|---|
| T1–T3 | Spec: routing, FR-32a, §12 payout extension, reqwest/sqlx feature names. All 4 prompts aligned. |
| T4/T4b | Skeleton, compose (`postgres:16.15`, `redis:7.4.12`), `.gitattributes` (LF). Windows `sokosumi skills path` fixed. |
| T5–T18 | Rust `backend/`: normalize, hashing, address, store, config, parse, mustang, sources, criteria, scoring, model, check pipeline, API, decisions, CLI, seed, OFAC import, jobs, Dockerfile. |
| Tests | `cargo test`: 290 unit tests. With DB env: acceptance 32 (+2 ignored Mustang), decisions_it 7, cli_it 1, store_it 2. Mustang tests 22/23 pass against the real JAR. Clippy and fmt are clean. Docker image `sniffer:dev` builds (543 MB). |
| T21 | x402 spike: conditional GO (`docs/x402-notes.md`). |
| T23 | `agents/report-schema.mjs`: zod schemas for the reports, plus `parseModelJson`. |
| T24 | One Eve process per role (`AGENT_ROLE` = invoice, wallet, supplier or main). `client.mjs` `answerReport()` validates the reply, allows 1 repair, then fails closed. |
| x402 phase A | `@x402/cardano`, `core`, `fetch` @2.28.0 and `@evolution-sdk/evolution` @0.5.19 are pinned. `x402/wallets.mjs`, `facilitator.mjs`, `live-test.mjs`. |
| x402 phase B | Live Preprod payment confirmed: tx `7feeb885…b07b` (d9bce8f). x402 is a full GO. |
| T19 (9310f98) | Payout policy engine, `0002_payouts.sql`, state machine, Blockfrost `/txs/{hash}/utxos` confirm, `unknown` job (started in `jobs::spawn_all`). Reason codes incl. spec-only `amount_zero`, `payouts_disabled`. `payouts_it` 18/18. |
| T20 (fc29dc0) | `GET /v1/suppliers/{supplier_hash}/history`. `history_it` 2/2 (H1). |
| T22 (39416de) | `x402/gate.mjs` (confirmed settle only, unique `txHash → resource` journal) and `x402/pay.mjs` (`payOnce`, journals before signing, `pending`/`unknown` → "inspect"). `resourceId` may be a function of `req`. Journals assume one process per file. |
| T27 (0624459) | `payout/transfer.mjs` (Evolution SDK). Never resubmits. `.local/payout.env` format: `PAYOUT_MNEMONIC="<24 words>"` + optional `PAYOUT_ACCOUNT_INDEX` (T28 creates it). The local journal claim does not stop two machines from paying one intent. |
| Tests now | `cargo test`: lib 298, acceptance 32 (+2 ignored), cli_it 1, decisions_it 7, history_it 2, payouts_it 18, store_it 2. Clippy and fmt clean. `npm test` 100/100. |

## T28 live provisioning (DONE 2026-10-31, Celeris; TUM access pending)
User choices: **organization** Workspace; generated local secrets; Postgres keeps `throwaway-test` (local only).
Done (local only, no network writes):
- `.local/sniffer-secrets.env`: random `SNIFFER_API_TOKEN`, `SNIFFER_HMAC_KEY` (32-byte hex), `POSTGRES_PASSWORD=throwaway-test`. Never print.
- `.local/payout.env`: fresh payout mnemonic. Payout address `addr_test1qpn7t2trak0rlsush4237ysa4yuu48265r9m5fug8jkup0z0929498cxn7fstduw8s53wzy5awsl03t6vqzrf500l89qr44l92`.
- Wallets in `.local/x402/`: `main-payer` `addr_test1qpaj66hl86xrt258lmxsf403nh04q76fs9s3tssr78h7qjkqzpn22xxu94p0zqcp9tw986p8neruzual0lp33n5vnwhsedn75p`, `intake` `addr_test1qzpdqn7hv5wdyfw76ay7c5vu92xad6d2s0sw4ggpcgdm2qn9jnsryv05ec04fclqtsh3rnhdetpysf2pmtgmqvnpxwpsv5h8sk`, `inv-invoice`, `inv-wallet`, `inv-supplier` (addresses in `.local/live.env`). The x402 `payer` wallet (~99 tADA) acts as the test customer.
- `.local/live.env`: non-secret settings (addresses, prices 1 tADA, `ADA_PER_EUR=0.001`, caps 10/50 ADA, ports, Eve URLs). npm scripts and compose load it (063ee2c); `npm run stack` starts the compose stack with all env files.
Done 2026-10-31 (moved to macOS; state copied into `.local/`):
- **Model:** ZAI replaced by the Claude API. `agent/agent.ts` uses `@ai-sdk/anthropic` 4.0.71 (pinned, same `@ai-sdk/provider` as `ai@7.0.127`). Env: `ANTHROPIC_API_KEY` (required), `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `MODEL_CONTEXT_WINDOW_TOKENS` (default 1000000, so Eve skips its catalog lookup). Live smoke reply from the invoice Eve measured.
- **Sokosumi** (account `o.petrenko@skfx.io`): Vendor `Sniffer` `01a19000-ecef-721f-8991-2dd0e9fc7140`; Coworkers invoice `01a19001-22c9-72b4-9d9b-60da266bcd3f`, wallet `01a19001-269b-744c-9f16-1ee6c7e5b0e6`, supplier `01a19001-2b0b-77fc-a5f4-315fd8e5b010`. TUM-Hackathon access PENDING (admin approval); **Celeris** (`celeris-diigps`, owner) GRANTED and active in `.local/live.env`. Runtime keys imported into the macOS Keychain. CLI responses in `.local/sokosumi/`.
- Unpaid smoke task `01a19014-b357-76ee-b607-7ce5f1d42b9b` in Celeris: the invoice worker logged "Skipping unpaid task" (measured).
- **Bug found live:** Sokosumi prepends `[DESIGN.md](https://…)\n\n` to task descriptions in a Workspace with a design doc. `stripDescriptionPrefix` in `investigator/contract.mjs` now strips only that pattern; Main's `findCreatedTask` uses it too.
- Compose maps `BLOCKFROST_PROJECT_ID` from `BLOCKFROST_API_KEY_PREPROD`. Backend `/health` ok.
- Also fixed 2026-10-31: OFAC download (User-Agent, fda9e5f); x402 UTxO reuse between sequential payments (6be1c28); VIES_MODE=mock for fixtures (in `.local/live.env`). Tooling: `npm run preflight`, `npm run demo` (`--new-supplier`, `--invoice-number`), OpenAPI specs in `docs/openapi/`. Latency: intake grants on submission, payouts report on submit (8d3c93b); no money moves before intake confirmation.
- **T29 live E2E runs (Preprod, measured):**
  - `case-7c525f29…` medium: stopped `needs_inspection` (`investigator_payment_unknown`) — the UTxO-reuse bug. Invoice investigator paid; wallet tx `95f10775…` can never land (input spent by `544864fc…`). Left parked for a human.
  - `case-858cf9a0…` low (S-9 gone, score 15): approved by the initial check, payout confirmed (`4d9da357…`), ~57 s.
  - `case-df1fe6fe…` low after the latency change: 202 at +3.9 s, payout submitted at +11.9 s, confirmed at +52 s.
  - `case-eb1afa98…` medium (`--new-supplier`, score 55 incl. S-1): all 3 investigators paid sequentially, reports INSUFFICIENT_DATA/CONCERN/CONCERN → DONT_PAY/rejected (formal) at +3m17s.
- **Open order to investigators (39e2c65):** Initial Check result has `invoice.open_order` (same match as I-8/T-3; `schema_version` kept at "1.0" — decide whether to bump to 1.1); Main passes it to the invoice and supplier investigators; their prompts treat a matching order as verifying amount and business relationship. Guardrails unchanged. Demo orders PO-2026-003 (DE333333333), PO-2026-005 (DE555555555). Demo `--fresh-wallet` creates `.local/x402/demo-recipient-<ms>.json` as the recipient (avoids S-1). Backend rebuilt, Eves and Main restarted with it; not yet run live.
- **OpenAPI 3.1 specs:** `docs/openapi/{main-api,backend,investigator-api}.yaml` + README (lint: `npx --yes @redocly/cli@2.64.1 lint --skip-rule info-license docs/openapi/*.yaml`). The spec agent noted minor inconsistencies (backend 405 bodies empty vs FR-09, Main `/health` checks nothing, backend binds 0.0.0.0 inside the container) — not fixed.
Still open: medium-risk approval run (see RESUME HERE); parallel investigator payments (remind the user); TUM-Hackathon Coworker access still PENDING (re-run `coworkers connect`, never `register`, after admin approval; then remove the two Celeris override lines at the end of `.local/live.env`); stale `COWORKER_ID`/`SOKOSUMI_ORGANIZATION_*` lines in `.env` (user should delete); parked `case-7c525f29…`.

## Wave 7 (DONE 2026-10-31; pushed to origin/main). Next: T28 live provisioning, T29 E2E demo, T30 verify/review/README.
Wave 6 (T19, T20, T22, T27) is done and committed.
Shared interface written by the main session first (376cd4d): `investigator/contract.mjs` (task description schema, `task_id = <case_id>-<role>`, Sokosumi task ID check, `/pay/{taskId}` path) and `sokosumi-cli.mjs` (CLI JS entry via `process.execPath`, no shell). `package.json` test script already globs `investigator/` and `main/`, so agents do not edit it.

| Task | Owner | Files |
|---|---|---|
| T25 investigator API + worker gate + Eve multi-process check | general | `investigator/*` (not contract), `worker.mjs`, `worker-lock*` — DONE (`npm test` 186/186). |

T25 notes:
- **Eve:** two role processes cannot share one app root (Eve allows one dev server per root, `.eve/dev-server-state.v1.json`). Each role now gets its own app root `.local/eve-<role>/` via `investigator/eve-root.mjs` (copies `agent/` and `promts/` on every start, links `node_modules`). Restart a role's Eve after a prompt change. Delete a role root with `fs.rmSync` only.
- **Fail closed:** invalid input → journaled `failed`, task not completed (Main times out → rejected/formal). Valid input but no valid model report → completed with a code-built `INSUFFICIENT_DATA` report. A crash during runtime start/complete → blocked for inspection.
- **Run:** `npm run investigator:eve|investigator:api|investigator:worker -- <role>`; the argument wins over `AGENT_ROLE`. Default ports 21961/21962/21963.
- **For T28:** keep per-role prices ≤ the shared `INVESTIGATOR_PRICE_LOVELACE` (Main's payment cap). Main reads `MAIN_EVE_URL`; the launcher uses `EVE_URL_MAIN`, so set both to the same URL or run main's Eve from the repo root with `npm start`.
| T26 main orchestrator + `decide.mjs` | general | `main/*` — DONE 496796d + Q1/Q2 follow-up 66bc630 (51 tests). |

T26 decisions (user, 2026-10-31):
- Q1: a failed `tasks create` triggers a read-only `tasks list` check; exactly one match → continue, provably none → recreate (bounded), otherwise inspection.
- Q2: resend `POST /v1/initial-check` only on a connect error (nothing reached Rust); anything else → inspection.
- Q3: an unsigned investigator payment failure → rejected/formal. Update (user decision 2026-10-31, after case-833a92c7… lost the invoice payment to a transient Blockfrost `getProtocolParameters` error): a payOnce journal in `failed_before_signing` is retried up to 3 times after 2 s, 5 s, 10 s (4 attempts, `investigator_payment_retry` log, attempt journaled in case.json); only then rejected/formal. `rejected`, `pending`, `unknown` and other signed states are never retried.
- Q5: `.local/payout.env` stays required at Main startup.
- Main LLM failure or invalid JSON → rejected/formal. Decline reasons are built by code only (fixed German texts + criterion `customer_text`), filtered for betrug/fraud.
- Suggested script: `"main": "node --env-file-if-exists=.env main/api.mjs"`, run with `--confirm-live-payments`.
- Q1 caveats (verify in T28/T29 live): the "provably none" proof assumes the server honours `take=100` and filters by `coworkerId`; a create that lands later than the 10 s re-check can leave an unpaid orphan READY task (never worked, never paid).
- Q2 change: a 503 from Rust initial-check now stops for inspection (was `failed`).
- **T25:** investigator API and worker gate. Also verify that 2+ Eve role processes run in parallel; if not, give each role its own app root under `.local/eve-<role>/`. Fix `worker.mjs` `execFileSync('sokosumi')` on Windows: run the CLI's JS entry with `process.execPath`, never `shell: true` with task IDs.
- **T26:** Main orchestrator with `decide.mjs` guardrails.
- **T28:** live provisioning (asks the user at each step).
- **T29:** E2E demo.
- **T30:** test-verifier, safety-reviewer, README rewrite.

## Open items / blockers
1. **x402 phase B DONE (2026-10-31):** tx `7feeb885ff97026405b497045fb1a38cb2f820eb057dbbeae9855c406754b07b`, 1 tADA payer → payee, confirmed; recorded in `docs/x402-notes.md` (commit d9bce8f). The payer had 100 tADA before the payment. The original steps, kept for reference:
   - Fund the payer `addr_test1qqp5a9cwecr7yh9arg8hu4c28v40jsrr44qpqgq690suhp5e6fwja63vqpj23ygdd6tawcw6r25lk7aulyyfeue4exsqjdtqf8` from the Preprod faucet.
   - Check the balance: `node --env-file=.env x402/wallets.mjs balance payer`.
   - Run: `node --env-file=.env x402/live-test.mjs --confirm-live-payment`.
   - Record the tx hash in `docs/x402-notes.md`.
   - Payee: `addr_test1qqsukwn3txs33kx4qh97g5suejsc6w78x994j7y6sefsk29vnt2urqy4t5rmhddtmprmhpfuueuupmd7kaez7ganq3xs5usuqq`.
   - The mnemonics are only in `.local/x402/`.
2. **`.env`** exists, created by the user. Never read it. Its `COWORKER_ID`/`SOKOSUMI_ORGANIZATION_*` values are stale (not this account); `.local/live.env` overrides the org settings. Run compose through `npm run stack` (it loads `.local/sniffer-secrets.env`, which holds `POSTGRES_PASSWORD`).
3. **`npm audit`** went from 3 to 6 findings. The 3 new high ones are the zod <4.6.6 advisory via `@x402/core`. The fix is `@x402/*` 2.29.0, which is too new (< 2 weeks). Revisit before public deploy and update the README count.
4. `model::DecidedBy` has no `Seed` variant. Harmless today because seed rows are `low` and are never decided again.
5. Minor spec choices made by agents are listed in their reports. Examples: I-2 shows `new_wallet_limit_eur` when both branches hold. KO with missing BT-5 writes no invoices row (`currency NOT NULL`). Revisit if tests demand.

## Environment facts
- Since 2026-10-31: macOS, Node 25.5, Docker 29.3, cargo 1.94 (no host Java; Mustang runs inside the image). Sokosumi CLI 1.0.4 installed globally.
- Before that, Windows 11:
  - Node 24.22.2 (nvm).
  - Rust 1.99.1 (`backend/rust-toolchain.toml`).
  - Java 17.
  - Sokosumi CLI 1.0.4. It is a `.cmd` shim, so `execFileSync` needs special handling.
  - Docker Desktop **switched to Linux containers** with the user's approval. The user's Windows container `iris-erp-test` needs a switch back.
- Ports:
  - Postgres 127.0.0.1:5432.
  - Redis host port **6380**: an unrelated local `redis-server` owns 6379, so never touch it.
- Compose stack is running. Test DBs: `sniffer_t16` … `sniffer_t20`. Redis indexes used: 15 (store), 14 (sources), 13 (acceptance), 11 (cli), 10/9 (reserved for T19/T20).
- Test env examples:
  - `SNIFFER_IT_DATABASE_URL=postgres://sniffer:throwaway-test@127.0.0.1:5432/sniffer_t16`
  - Mustang tests: `SNIFFER_TEST_MUSTANG=1 MUSTANG_JAR=.local/mustang/Mustang-CLI-2.26.0.jar` (the JAR is downloaded and its SHA was verified).
- Cargo: parallel agents use `--target-dir target/<task>`, delete it afterwards, and run `rustfmt` on their own files only (never crate-wide `cargo fmt`).
