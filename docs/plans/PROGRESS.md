# Sniffer MVP: Progress Journal

Read this first when resuming. The full plan is in `docs/plans/2026-10-30-sniffer-mvp.md` (decision log §0 and agent-assignment table).
Last update: 2026-10-31. Branch: `feat/mvp`, 30 commits ahead of `main`, working tree clean.
Overall: **about 70%.** The Rust backend (Initial Check, payouts, supplier history), the x402 gate and payer, and the payout transfer are done; a live x402 payment is measured. The agent orchestration (T25, T26), live provisioning and E2E are not done yet.

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

## Next: wave 7
Wave 6 (T19, T20, T22, T27) is done and committed.
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
2. **`.env`** now exists, created by the user. Never read it. It lacks `POSTGRES_PASSWORD`, so `docker compose` fails to interpolate. Until the user adds it, prefix commands with `POSTGRES_PASSWORD=throwaway-test` (the running containers use that password).
3. **`npm audit`** went from 3 to 6 findings. The 3 new high ones are the zod <4.6.6 advisory via `@x402/core`. The fix is `@x402/*` 2.29.0, which is too new (< 2 weeks). Revisit before public deploy and update the README count.
4. `model::DecidedBy` has no `Seed` variant. Harmless today because seed rows are `low` and are never decided again.
5. Minor spec choices made by agents are listed in their reports. Examples: I-2 shows `new_wallet_limit_eur` when both branches hold. KO with missing BT-5 writes no invoices row (`currency NOT NULL`). Revisit if tests demand.

## Environment facts
- Windows 11:
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
