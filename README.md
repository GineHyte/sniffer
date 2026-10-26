# TUM Blockchain & AI Hackathon quickstart

REPORTED: Organizers list October 30 to 31, 2026 at the House of Communication in Munich.
Source: [official event website](https://hackathon.tum-blockchain.com/).

VERIFIED: Agent instructions request five team names and one recommendation. Adapt `agent/instructions.md` for your project.
Evidence: `agent/instructions.md:1` and `agent/instructions.md:2`.

VERIFIED: Source snapshot: `live-demo-name-finder`, commit `ff35ea7957b243f2e740ab4d726117a933dbed9a`, directory `live-team-names-20261006/`.
Source: [original implementation](https://github.com/masumi-network/demo-agent-token2049/tree/ff35ea7957b243f2e740ab4d726117a933dbed9a/live-team-names-20261006).

## Start the local agent

Use Node.js 24 for the agent and CLI.

VERIFIED: The starter requires Node.js 24 or newer. Dependency versions remain pinned in `package-lock.json`.
Evidence: `package.json:6` and `package-lock.json:9`.

1. Clone this repository and enter its directory.
2. Install the locked dependencies and prepare private configuration:

   ```sh
   sfw npm ci
   cp .env.example .env
   chmod 600 .env
   ```

3. Set `ZAI_API_KEY`, `ZAI_BASE_URL`, and `ZAI_MODEL` to your authorized model connection.
4. Keep `EVE_PORT` and `EVE_URL` consistent. Start the agent:

   ```sh
   npm start
   ```

VERIFIED: The start command loads `.env` and binds Eve to `127.0.0.1`.
Evidence: `package.json:9` and `start.mjs:21`.

## Connect your Sokosumi Coworker

Install the compatible CLI version. See the [official CLI instructions](https://github.com/masumi-network/sokosumi/tree/main/apps/cli).
Read its supported setup flow before you create resources:

```sh
sfw npm install --global @masumi_network/sokosumi@1.0.4
sokosumi --version
sokosumi skills
sokosumi --preprod auth --help
sokosumi --preprod vendors --help
sokosumi --preprod coworkers --help
```

1. Sign in with your own Preprod account. Use the CLI's supported account interface to check your identity.
2. Create a fresh Vendor and a private Coworker with task access. Connect it to your Personal Workspace.
3. Import its runtime key through the supported CLI credential interface. Keep the key in the CLI vault.
4. Set the returned `COWORKER_ID` in `.env`. Keep `PAID_TASKS_ENABLED=false` for execution without payments.
5. Start the worker in a second terminal. Create a task for your Coworker through Sokosumi:

   ```sh
   npm run worker
   ```

VERIFIED: The worker reads `COWORKER_ID` and polls Sokosumi through its Preprod CLI interface.
Evidence: `worker.mjs:7` and `worker.mjs:11`.
VERIFIED: The runtime adapter imports installed CLI modules. The source README requires Sokosumi CLI `1.0.4`.
Evidence: `sokosumi-runtime.mjs:11` and the [source README](https://github.com/masumi-network/demo-agent-token2049/blob/ff35ea7957b243f2e740ab4d726117a933dbed9a/live-team-names-20261006/README.md#run).
Check compatibility before using another CLI version.

## Optional Preprod payments

Prepare a fresh [Masumi Payment Service](https://github.com/masumi-network/masumi-payment-service) with its current setup instructions.
Create a dedicated database, encryption key, and selling wallet. Keep generated secrets in `.local/mps.env` with permission `600`.
Include that dedicated node's `ADMIN_KEY` in `.local/mps.env` for setup.
Fund the dedicated wallet with test ADA. Use current MPS API documentation to read its actual identifiers.

1. Create `docs/` and `.local/` if absent. Save fresh `sourceId`, `walletId`, and `sellerAddress` in `docs/payment-state.json`.
2. Set `MPS_URL`, `AGENT_API_PORT`, `AGENT_AUTHOR`, and `BLOCKFROST_API_KEY_PREPROD` in `.env`. Use your own author name.
3. Create the scoped runtime key, then register this agent:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
   ```

4. Check registration until it confirms. Keep uncertain writes pending for manual inspection:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs
   ```

5. Start `npm run api`. Enable `PAID_TASKS_ENABLED=true` only after confirmed registration and scoped runtime-key setup. Restart the worker.

Before the last step, complete `docs/registration-state.json` with the confirmed `agentIdentifier`, actual `supportedPaymentSourceIndex`, and selling wallet's `sellerVkey`.
Read these values from your own confirmed registry and wallet responses. Do not assume a source index or copy demo values.

VERIFIED: Registration reads `docs/payment-state.json`, saves `docs/registration-state.json`, and requires `AGENT_AUTHOR` for `register`.
Evidence: `payment-registration.mjs:3`, `payment-registration.mjs:4`, and `payment-registration.mjs:20`.
VERIFIED: The scoped token is saved to `.local/mps-runtime.env`. The worker checks registration before paid tasks.
Evidence: `payment-registration.mjs:17` and `paid-task.mjs:27`.
VERIFIED: Setup uses `ADMIN_KEY`. Seller receipt verification reads `BLOCKFROST_API_KEY_PREPROD` from the worker environment.
Evidence: `payment-registration.mjs:8`, `package.json:10`, and `settlement.mjs:12`.
Verify a real paid task and the seller's net receipt before you claim payment readiness.

## Check your changes

```sh
npm test
```

Keep local services running while you use the Coworker. Do not commit secrets or generated resource state.

## Known dependency findings

VERIFIED: `npm audit --json` reported `3` vulnerabilities: `1 moderate` and `2 high`, across `eve`, `undici`, and `zod`.
VERIFIED: Source comparison returned `package.json: byte-identical to source snapshot` and `package-lock.json: byte-identical to source snapshot`.
INFERRED: Local tests do not establish live model, Coworker, or payment readiness.
