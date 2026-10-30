# x402 on Cardano Preprod: spike notes (Task 21, research part)

Status: **research only.** No package installed in the repo, no wallet created, no external write, no payment made.
All facts were accessed on **2026-10-31**. Package facts come from npm registry metadata and from tarballs fetched with
`npm pack` into a temporary directory (README, `.d.mts` types and `dist` source read as data, nothing executed).
**UNVERIFIED** marks anything not confirmed by a primary source or by a measured run.

Still open for Task 21: one measured Preprod payment (tx hash) between two fresh test wallets, made with user approval.

---

## 1. Packages and pinned versions

Sources: `npm view <pkg> --json` against https://registry.npmjs.org/ (2026-10-31); tarballs
`https://registry.npmjs.org/@x402/<name>/-/<name>-2.28.0.tgz`.

| Package | Latest | Latest published | **Pin** | Pin published | Age on 2026-10-31 |
|---|---|---|---|---|---|
| `@x402/cardano` | 2.29.0 | 2026-10-28T18:31Z | **2.28.0** | 2026-09-29T19:10Z | 32 days |
| `@x402/core` | 2.29.0 | 2026-10-28T18:29Z | **2.28.0** | 2026-09-29T19:03Z | 32 days |
| `@x402/fetch` (client wrapper) | 2.29.0 | 2026-10-28T18:35Z | **2.28.0** | 2026-09-29T19:15Z | 32 days |
| `@x402/express` (only if Express is used) | 2.29.0 | 2026-10-28T18:35Z | **2.28.0** | 2026-09-29T19:14Z | 32 days |

- **2.29.0 is only 3 days old and fails the ≥ 2-week rule. Pin 2.28.0.** The `@x402/cardano` README is byte-identical in 2.28.0 and 2.29.0 (diffed locally).
- `@x402/cardano` history: first release 2.26.0 on 2026-09-18, then 2.27.0 (09-22), 2.28.0 (09-29) and 2.29.0 (10-28). The package is about 6 weeks old.
- Repo: https://github.com/x402-foundation/x402. Publisher: GitHub Actions OIDC with SLSA provenance. npm maintainers are Coinbase accounts (`carsonroscoe_cb`, `erik_cb`). License Apache-2.0.
- `@x402/cardano@2.28.0` dependencies: `@x402/core ~2.28.0`, `@evolution-sdk/evolution ^0.5.9`, `@noble/hashes ^2.2.0`, `lz-string ^1.5.0`.
  - The newest 0.5.x of `@evolution-sdk/evolution` is 0.5.19 (2026-10-07, 24 days old). Its latest tag is 0.8.0 (3 days old). The caret on 0.5 never resolves to 0.8.
  - Commit the lockfile so transitive deps stay pinned.
- `@x402/core@2.28.0` depends on `zod ^3.24.2`. The repo pins `zod 4.6.5`, so npm nests a zod 3 copy under `@x402/core`. This should work. UNVERIFIED until installed.
- `@x402/express@2.28.0` peers: `express ^4 || ^5`. The `@x402/paywall` peer is optional.
- **There is no `@x402/http` package (E404).** Plain-Node HTTP support is `x402HTTPResourceServer` in `@x402/core/http`, which needs no Express.
- Package exports for `@x402/cardano`: `.`, `./exact/client`, `./exact/server`, `./exact/facilitator`.
- Origin claim: secondary coverage credits the Cardano Foundation together with Masumi. The package does ship a `masumi` transfer method. Masumi's authorship of the package itself is **UNVERIFIED**.
  - https://www.mitrade.com/insights/news/live-news/article-3-2109374-20260923: "Cardano support is available only in the TypeScript package of the kit, @x402/cardano."

## 2. Facilitator (Preprod)

**No public hosted Cardano facilitator was found.**

- The SDK's default `HTTPFacilitatorClient` URL is `https://x402.org/facilitator`.
  - Source: `DEFAULT_FACILITATOR_URL` in the `@x402/core@2.28.0` dist.
- Its `GET https://x402.org/facilitator/supported` lists EVM, Solana, Algorand, Aptos, Stellar, Hedera and XRPL. **It lists no `cardano:*` network** (fetched 2026-10-31).
- The x402 Cardano spec lists no public facilitator URL.
  - Source: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md
- No hosted endpoint turned up in web searches, in the ODATANO README (https://github.com/ODATANO/x402) or in the CF demo.

Options:

| Option | What | Key / funds | Status |
|---|---|---|---|
| **A. In-process** (recommended) | `x402Facilitator` from `@x402/core/facilitator` with `ExactCardanoScheme` from `@x402/cardano/exact/facilitator` and `toFacilitatorCardanoSigner` | Blockfrost Preprod project ID only. No mnemonic, no funds. | Pattern from the README (§3). Passing `x402Facilitator` straight into `x402ResourceServer` as its `FacilitatorClient` is **UNVERIFIED** (see note below). |
| B. Local HTTP facilitator | CF demo `facilitator/src/facilitator.ts`: Express wrapper on `127.0.0.1:4022` with `POST /verify`, `POST /settle`, `GET /supported`, `GET /health` | `BLOCKFROST_PROJECT_ID` | Demo code, pinned to 2.26.0. https://github.com/cardano-foundation/x402-cardano-demo |
| C. CF Java facilitator | https://github.com/cardano-foundation/cardano-x402-facilitator (Spring Boot, Postgres journal, Docker compose `--profile light`) | `BLOCKFROST_PROJECT_ID`. "No built-in HTTP authentication or rate limiting", bound to loopback. | README: an earlier version was proven on Preprod; the current upgrade "has not repeated that live proof or run on mainnet". Last push 2026-10-27. |

Note on option A: `x402Facilitator.getSupported()` is synchronous, while `FacilitatorClient` expects a Promise. A small wrapper object with `verify`, `settle` and `getSupported` would cover the gap.

Endpoint shapes, from the CF repos and the core types:
- `POST /verify` and `POST /settle` take the body `{ x402Version, paymentPayload, paymentRequirements }`.
- `GET /supported` returns `{ kinds:[{x402Version, scheme, network, extra}], extensions, signers }`.
- Auth is optional, through `HTTPFacilitatorClient({ url, timeoutMs, createAuthHeaders })` with path-keyed headers.
- Default facilitator-client timeout is 90 s (`@x402/core` `FacilitatorConfig.timeoutMs`).

Repo fit: `.env.example` already has `BLOCKFROST_API_KEY_PREPROD`. The facilitator needs only that value plus the base URL `https://cardano-preprod.blockfrost.io/api/v0`.
- Base URL source: Blockfrost OpenAPI `servers`, https://raw.githubusercontent.com/blockfrost/openapi/master/openapi.yaml

## 3. API

### 3.1 PaymentRequirements (x402 v2, Cardano `exact`)

Sources: the spec above, the `@x402/core@2.28.0` README, and the types in `@x402/cardano@2.28.0`.

- **v2 uses `amount`, not `maxAmountRequired`** (that is the v1 name). v2 fields are `scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds` and `extra`.
- `resource` (url, description, mimeType) sits at the top level of `PaymentRequired`, not inside each requirement.
- The 402 is carried base64-encoded in the `PAYMENT-REQUIRED` header. The client retries with `PAYMENT-SIGNATURE`, and the server answers with `PAYMENT-RESPONSE`.

| Field | Value for our MVP | Source |
|---|---|---|
| `scheme` | `"exact"` | spec |
| `network` | `"cardano:preprod"`. CIP-34 alias `cip34:0-1` is accepted and normalized. Network ID 0. | `@x402/cardano` README "Networks" |
| `asset` | `"lovelace"` (`LOVELACE_ASSET`). Native tokens use `policyId.assetNameHex`. | README, types |
| `amount` | integer string in lovelace, e.g. `"2000000"` = 2 tADA | spec; CF demo `server/src/app.ts` |
| `payTo` | bech32 `addr_test1…` of the receiver | spec; CF demo `server.ts` checks the `addr_test1` prefix |
| `maxTimeoutSeconds` | `600` (spec and demo value). Sets the tx TTL. | spec, demo |
| `extra` | `{ assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: N } }`. `l1Confirmations` defaults to 1. `-1` (mempool) is refused unless the facilitator sets `acceptMempool`. | types `CardanoExtraDefault` / `CardanoExtraPolicies`; demo `app.ts` |

Route config takes `price: { amount: "2000000", asset: "lovelace" }`. A `"$0.10"` price resolves to USDM, not ADA (README).

### 3.2 Server snippets (copied, attributed)

From the `@x402/cardano@2.28.0` README, "Reference signers" (facilitator part):

```typescript
import { toClientCardanoSigner, toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as ExactCardanoClient } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as ExactCardanoFacilitator } from "@x402/cardano/exact/facilitator";

const provider = { blockfrost: { baseUrl: process.env.BLOCKFROST_PREPROD_URL!, projectId: process.env.BLOCKFROST_PROJECT_ID! } };

// Client (payer)
const clientSigner = toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider });
client.register("cardano:*", new ExactCardanoClient(clientSigner));

// Facilitator (verify + broadcast + confirm). Works out of the box against a
// Blockfrost or Koios provider; see "Phase-1 checks" and "Duplicate settlement guard".
const facilitatorSigner = toFacilitatorCardanoSigner({
  network: "cardano:preprod",
  provider,
  // Return on broadcast; the scheme polls for the confirmation policy's evidence.
  awaitConfirmation: false,
});
facilitator.register("cardano:preprod", new ExactCardanoFacilitator(facilitatorSigner));
```

From the `@x402/core@2.28.0` README, "Server Usage". This is the framework-agnostic path that fits our plain `node:http` APIs. The example is EVM; for Cardano, register `ExactCardanoScheme` from `@x402/cardano/exact/server` on `"cardano:preprod"`, as the CF demo does.

```typescript
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';

// Connect to facilitator
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator',
});

// Create resource server with payment schemes
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register('eip155:*', new ExactEvmScheme());

// Initialize (fetches supported kinds from facilitator)
await resourceServer.initialize();
...
// Create HTTP server wrapper
const httpServer = new x402HTTPResourceServer(resourceServer, routes);
```

CF demo (`server/src/app.ts`, paraphrased by fetch, not verbatim):
- `new x402ResourceServer(options.facilitator).register(network, new ExactCardanoScheme())`
- Route `"GET /api/message"`: `{ scheme:"exact", network:"cardano:preprod", payTo, price:{amount:"2000000", asset:"lovelace"}, maxTimeoutSeconds:600, extra:{ assetTransferMethod:"default", areFeesSponsored:false, confirmationPolicy:{ l1Confirmations: level } } }`
- The routes are wrapped with `paymentMiddlewareFromHTTPServer(...)` from `@x402/express`.

Plain-HTTP flow, from the `x402HTTPResourceServer` types in `@x402/core@2.28.0`:
1. Implement an `HTTPAdapter` with `getHeader`, `getMethod`, `getPath`, `getUrl`, `getAcceptHeader` and `getUserAgent`.
2. Call `processHTTPRequest(ctx)`. It returns `no-payment-required`, `payment-error` (send `response.status/headers/body`, i.e. the 402), or `payment-verified` with `paymentPayload` and `paymentRequirements`.
3. Call `processSettlement(paymentPayload, paymentRequirements)`. It returns `{ success, transaction, network, payer, extra, headers }`, or a failure carrying `errorReason` and a `response`.
4. Hooks: `onAfterSettle` on the server, and `onProtectedRequest` (which can return `{abort:true, reason}`) on the HTTP server.

**Flow-ordering caveat.** Cardano supports only the `authorization` flow (server types `paymentFlows`): verify, then the handler runs, then settle broadcasts.
- `@x402/express` buffers the handler response and discards it if settle fails (`dist/esm/index.mjs` around lines 227–386).
- The handler's **side effects still happen before settlement.**
- For `/pay/{taskId}` the handler must not start work. Mark the task paid only after `processSettlement` succeeds (§4).

### 3.3 Client: what signs and which key

- `ClientCardanoSigner` is an interface: `getAddress()` plus `buildAndSignPaymentTransaction({network, payTo, asset, amount, maxTimeoutSeconds, extra, resource})`, which returns `{ transaction: base64 CBOR, nonce: "txHash#index" }`.
  - The client **signs but never broadcasts.** The client pays the network fee (`areFeesSponsored` is always false on Cardano).
  - Source: `signer-*.d.mts` and `types-*.d.mts` in `@x402/cardano@2.28.0`.
- Server-side reference signer: `toClientCardanoSigner({ mnemonic, network, provider, accountIndex? })`.
  - It takes a **BIP-39 mnemonic** and derives keys through the Evolution SDK `withSeed` (Cardano HD/CIP-1852 derivation; that the scheme is CIP-1852 is UNVERIFIED).
  - It is **not** a raw private key or a Mesh wallet. A browser can implement the interface over **CIP-30** instead (CF demo `frontend/src/x402/cip30Signer.ts`).
  - It needs a Blockfrost (or Koios) provider to read UTXOs and protocol params.
- Spend controls: `x402Client` by default allows only USD-pegged default assets, capped at $1. **lovelace needs an explicit `spendControls.allowedAssets`** entry, e.g. `{ network:'cardano:preprod', asset:'lovelace', maxAmountPerPayment:'5000000' }`.
  - Source: `@x402/cardano` README bullet 4 and `@x402/core` README "Spend controls".

From the `@x402/fetch@2.28.0` README, "Using Builder Pattern" (EVM example; the Cardano client registers as shown in §3.2):

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
...
const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner));

// Wrap the fetch function with payment handling
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

Reading the receipt, from the same README:

```typescript
const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
if (paymentResponse) {
  const decoded = decodePaymentResponseHeader(paymentResponse);
```

## 4. Idempotency and replay (our `/pay/{taskId}` gate)

Facts:
- **Nonce:** `payload.nonce` is a UTXO ref (`txHash#index`) that must be one of the tx inputs. The facilitator checks that it and all inputs are unspent before submit (spec rule 5).
  - The reference client signer takes **`utxos[0]` of the wallet** as nonce (`dist/esm/index.mjs`, `toClientCardanoSigner`).
- **Duplicate-settlement guard:** settle is keyed by tx id. One tx is broadcast at most once, and a concurrent second settle gets `duplicate_settlement`.
  - **A retry of an already-broadcast tx "resumes observation instead of submitting again".**
  - The store is in-memory by default, holds 4096 entries and evicts the oldest.
  - Source: `@x402/cardano` README "Duplicate settlement guard".
- Spec rule 5: once evidence shows the ledger accepted *this exact* tx, the unspent check "no longer applies".
- **Explicit statement:** for the `default` and `script` methods, "binding a settled transaction to a single protected operation is the integrating server's concern" (`@x402/cardano` README, "Masumi quotes").
  - Only the `masumi` method binds a payment to one operation, via `termsDigest` and `inputCommitment`.
- Matching: `findMatchingRequirements` deep-equals `scheme/network/asset/amount/payTo/maxTimeoutSeconds` and checks that the route's `extra` is a subset of `accepted.extra` (`@x402/core` dist `paymentRequirementsMatchAccepted`).
  - **`resource` (the URL with the taskId) is not compared**, and the signed tx does not commit to it.

Consequence (inferred from the facts above; the replay behaviour is **UNVERIFIED by test**):
- If every task's `/pay/{taskId}` has the same `payTo` and `amount`, a `PAYMENT-SIGNATURE` already settled for task A can be replayed to `/pay/B`.
- Verify skips the unspent check for an accepted tx, and settle "resumes" and reports the same `transaction`.
- **The x402 layer alone would accept it.**

Required gate design (Task 22):
1. Decode the tx id from the payload before settlement: `decodeCardanoPayload` / `decodeCardanoTransaction` are exported from `@x402/cardano`, and the CF demo does this.
2. Keep a journal with **UNIQUE(txHash) → taskId**. If a txHash is already bound to another taskId, reject (409) and do not run the task.
3. Mark `paid` only after `processSettlement` returns `success:true` with `l1Confirmations ≥ 0`, never on mempool.
4. `settlement_pending` is non-terminal: keep the journal state `pending`, and on retry use the same payload.
5. One payment per taskId: if a task is already `paid`, return 200 with the stored txHash and no new 402.

Optional extra defence: put the taskId into the route `extra` (e.g. `extra.taskId`), so a payload made for A fails matching on B.
- The `PaymentOption.extra` type is static per route, so this needs a per-request route config. Feasibility is UNVERIFIED.

## 5. Settlement evidence

- `SettleResponse` (`@x402/core` types) is `{ success, transaction, network, payer?, errorReason?, extra? }`. `transaction` is the **Cardano tx hash (hex)**.
- Cardano `extra`: `{ status: "mempool"|"confirmed"|"pending", confirmations }`, where `-1` means mempool, `0` means included, and `n` counts newer blocks (spec and README).
- The server gets this from `processSettlement` or `onAfterSettle`. The client reads it from the `PAYMENT-RESPONSE` header (`decodePaymentResponseHeader`).
- Pending result shape (README): `{ "success": false, "errorReason": "settlement_pending", "transaction": "<tx id>", "extra": { "status": "pending", ... } }`.
  - Core retries settle once.
  - Settle waits up to 75 s by default (`confirmationTimeoutMs`). Keep that below the 90 s facilitator-client timeout.
  - Preprod averages about one block per 20 s (CF demo README).

Independent check on Blockfrost Preprod (base `https://cardano-preprod.blockfrost.io/api/v0`, header `project_id`; paths confirmed in the OpenAPI spec):
- `GET /txs/{hash}`: the tx exists and is included; take `block_height`. `valid_contract` must not be false; the package treats `valid_contract:false` as not paid (signer types).
- `GET /txs/{hash}/utxos`: one output to `payTo` with `lovelace ≥ amount`.
- `GET /blocks/latest`: confirmations = `latest.height − tx.block_height`.
- Field names inside `tx_content` other than `valid_contract` and `block_height` are **UNVERIFIED** (that part of the OpenAPI file was truncated in the fetch).

## 6. Wallets for MVP flows

| Wallet | Role | Key material | Where | tADA (suggested, UNVERIFIED sizing) |
|---|---|---|---|---|
| Customer (demo payer) | pays Sniffer intake | mnemonic (client signer) | demo client's `.local/` or `.env`, never committed | 20 |
| Main Sniffer | `payTo` for intake **and** payer of 3 investigators | mnemonic (client signer) on Main; address in Main API config | `.local/` | 30 |
| Invoice / Wallet / Supplier investigator ×3 | `payTo` only | API needs **only the address**. Mnemonic kept offline in `.local/` so funds can be recovered. | `.env` (address) | 0 (receive only) |
| Facilitator (in-process) | verify + broadcast | **none**, Blockfrost Preprod project ID only | `.env` `BLOCKFROST_API_KEY_PREPROD` | 0 |
| Payout wallet (D5, separate) | supplier payout via Mesh | as planned in Task 27 | `.local/` | per A9 caps |

- Prices: e.g. 2 tADA for intake (the demo uses 2 tADA) and 1–2 tADA per investigator.
- Each output must meet the live min-UTxO. For a plain ADA output this is about 1 ADA; the exact figure is **UNVERIFIED** and is read live by the facilitator.
- The fee is about 0.2 tADA per tx (**UNVERIFIED**).
- **Serial payments:** the reference signer picks `utxos[0]` as nonce from confirmed wallet UTXOs. Three parallel payments from Main would collide on one nonce.
  - Pay the three investigators **one after another**, each waiting for settle `confirmed`.
  - Or pre-split Main into ≥ 3 UTXOs. The signer's UTXO selection cannot be configured, so splitting alone may not prevent the collision (**UNVERIFIED**).
- Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet/ (select "Preprod Testnet"; an API key is optional). Per-request amount and rate limit are **UNVERIFIED**; the page does not state them.
- Per AGENTS.md: create all wallets fresh for this project, with user authorization (`payments-registrar`, Task 28). Copy no IDs or keys from other projects.

## 7. Risks, gaps, go/no-go

| # | Risk / gap | Impact | Mitigation |
|---|---|---|---|
| R1 | No public Cardano facilitator | We operate one | In-process facilitator (option A). It needs only Blockfrost. |
| R2 | Package is about 6 weeks old with 4 releases. CF Java facilitator: live proof not repeated after its upgrade. | API churn, bugs | Pin 2.28.0 with a lockfile. Measure one Preprod tx before building Task 22. |
| R3 | Replay across taskIds is possible at the protocol layer (§4) | Double use of one payment | UNIQUE(txHash) journal; grant only after confirmed settle |
| R4 | Authorization flow: the handler runs before settle | Work done without payment | `/pay` only records intent. The worker starts on `paid`. |
| R5 | Settlement latency ~20–75 s per payment at `l1Confirmations` 0–1; Main pays 3 investigators serially | ~1–4 min per MEDIUM case | Use `l1Confirmations: 0` for the demo; raise the facilitator client timeout (demo uses ≥ 120 s) |
| R6 | `masumi` method locks cannot be driven by `masumi-payment-service` (README) | No reuse of the existing MPS code with x402 escrow | Use the `default` method. MPS stays as a separate fallback (D1). |
| R7 | zod 3 (nested) alongside repo zod 4; `@evolution-sdk` is pre-1.0 | Install/size issues | Check on install. Keep x402 code in `x402/` only. |
| R8 | In-memory settlement store is lost on restart | A pending settle cannot resume after a crash | Our journal keeps the txHash, and recovery checks Blockfrost (§5). Plan journal `unknown` → never auto-retry. |
| R9 | Windows and Node 24 untested with Evolution SDK | Unknown | Spike install in a scratch dir first. UNVERIFIED. |

**Recommendation: CONDITIONAL GO** for x402 on Preprod with `@x402/*@2.28.0`, the `default` transfer method, lovelace, `cardano:preprod`, and an in-process facilitator on Blockfrost.

Conditions before Task 22 is coded:
1. With user approval: create two fresh wallets, fund one from the faucet, and run one measured payment (protected route → 402 → pay → `PAYMENT-RESPONSE` with tx hash). Confirm it on Blockfrost. Record the tx hash here.
2. Add the replay test from Task 22 (same payload on `/pay/B` → rejected by the txHash journal).

**No-go triggers, which fall back to Masumi MPS (already in the repo, `PAID_TASKS_ENABLED`):**
- The measured payment fails to settle within 10 minutes of trying.
- Install fails on Windows / Node 24.
- The facilitator cannot verify a reference-signer tx.

Stop and ask the user per the Task 21 gate.

## Sources (accessed 2026-10-31)

- npm registry: https://registry.npmjs.org/@x402/cardano, https://registry.npmjs.org/@x402/core, https://registry.npmjs.org/@x402/fetch, https://registry.npmjs.org/@x402/express, https://registry.npmjs.org/@evolution-sdk/evolution
- Tarball contents (README, types, dist) of `@x402/cardano@2.28.0` / `2.29.0`, `@x402/core@2.28.0`, `@x402/fetch@2.28.0`, `@x402/express@2.28.0`
- Spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md
- CF facilitator: https://github.com/cardano-foundation/cardano-x402-facilitator (README)
- CF demo: https://github.com/cardano-foundation/x402-cardano-demo (README, `server/src/app.ts`, `server/src/server.ts`, `facilitator/src/facilitator.ts`)
- x402.org facilitator supported list: https://x402.org/facilitator/supported
- ODATANO: https://github.com/ODATANO/x402
- Coverage (secondary): https://www.mitrade.com/insights/news/live-news/article-3-2109374-20260923
- Blockfrost OpenAPI: https://raw.githubusercontent.com/blockfrost/openapi/master/openapi.yaml
- Faucet: https://docs.cardano.org/cardano-testnets/tools/faucet/
