# OpenAPI specs

OpenAPI 3.1 descriptions of the project's three HTTP servers. They are written from the source code (routes, handlers, serde structs, the x402 gate) and from `docs/initial-check-spec.md`. Where the two disagree, the spec files follow the code. If you change a route, status code or body shape, update the matching file.

- **`main-api.yaml`: Main API** (`main/api.mjs`, default `http://127.0.0.1:21951`, set with `MAIN_HOST`/`MAIN_PORT`). This is the customer-facing intake. `POST /v1/invoices` takes one e-invoice XML, either as JSON `{"xml": "..."}` or as raw `application/xml`. The route is behind x402 on Cardano Preprod. The first call returns `402` with an empty body, and the payment requirements come base64-encoded in the `PAYMENT-REQUIRED` header. The client then retries with `PAYMENT-SIGNATURE`. The answer is `202 {case_id, status, status_url, payment_tx_hash}` with a `PAYMENT-RESPONSE` receipt header. It comes as soon as the payment is verified and submitted. Main confirms it in the background (`intake.state` in the case view), and no money moves before `intake.state` is `confirmed`. A case can be `completed` with `payout.state: submitted` until its payout confirms. When `MAX_UNCONFIRMED_INTAKES` (default 5) intakes are unconfirmed, a new submission gets `503 too_many_unconfirmed_intakes` before any payment. `GET /v1/cases/{case_id}` returns the public case view, and `GET /health` reports liveness. The x402 payment is the only auth. Error bodies are `{"error": "<code>"}`.
- **`backend.yaml`: Rust backend** (`backend/src/api.rs`, `payouts.rs`, `history.rs`). It binds `SNIFFER_BIND_ADDR` (default `0.0.0.0:8080`), and clients call `http://127.0.0.1:8080`. It covers the initial check, stored checks and their XML, agent decisions, the payout policy and intent journal (spec §12.4/§12.5), and the supplier history (§12.6). Every route except `/health` needs `Authorization: Bearer <SNIFFER_API_TOKEN>`. Error bodies are `{"error", "message"}` (FR-09). The spec sections cited in the file refer to `docs/initial-check-spec.md`.
- **`investigator-api.yaml`: Investigator API** (`investigator/api.mjs`). One process runs per role on `127.0.0.1`: invoice on `21961`, wallet on `21962`, supplier on `21963`. `GET`/`HEAD /health` returns `{ok, role}`. `POST /pay/{taskId}` is x402-gated with the same 402 / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` flow as the Main API. It only records a confirmed payment for that Sokosumi task, and the role's worker then starts the task. The payment is the only auth.

Each file is self-contained, so the x402 components (`X402PaymentRequired`, `X402PaymentPayload`, `X402SettleResponse`, the 402/409 responses) appear in both `main-api.yaml` and `investigator-api.yaml`. Keep the two copies in sync with `x402/gate.mjs`.

## Lint and view

Use the pinned Redocly CLI through `npx`. It is not a project dependency.

```sh
# Lint all three (the repo has no license, so the info-license warning is skipped)
npx --yes @redocly/cli@2.64.1 lint --skip-rule info-license docs/openapi/*.yaml

# Render one spec to a standalone HTML page and open it in a browser
npx --yes @redocly/cli@2.64.1 build-docs docs/openapi/main-api.yaml -o /tmp/sniffer-main-api.html
```

Redocly CLI 2.x has no `preview-docs` command, so use `build-docs` instead. Any other OpenAPI 3.1 viewer works too, for example Swagger Editor with the file pasted in.
