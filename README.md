# TUM Blockchain & AI Hackathon quickstart

Start with the [TUM hackathon setup guide](https://www.masumi.network/tum-hackathon).
It covers your account, Coworker, first task, and payment checkpoints.
Join the [TUM Sokosumi Workspace](https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW) with your own account.

This starter suggests five team names and recommends one.
Adapt `agent/instructions.md` to build your own agent.
Use the [full agent brief](https://www.masumi.network/tum-hackathon/agent) for your coding agent.
Before handing in your project, follow the [submission checklist](https://www.masumi.network/tum-hackathon/submission).

## Start the local agent

Use Node.js 24 or newer for the agent and CLI.

1. Clone this repository and enter its directory:

   ```sh
   git clone https://github.com/masumi-network/tum-hackathon-quickstart.git
   cd tum-hackathon-quickstart
   ```

2. Install the locked dependencies and prepare private configuration:

   ```sh
   npm ci
   cp .env.example .env
   chmod 600 .env
   ```

3. In `.env`, set `ANTHROPIC_API_KEY` for the Claude API. Eve calls Claude through the native `@ai-sdk/anthropic` provider.
   `ANTHROPIC_MODEL` defaults to `claude-opus-5-5`.
   `MODEL_CONTEXT_WINDOW_TOKENS` defaults to `1000000`, the context window of `claude-opus-5-5`, so Eve skips its catalog lookup.
   If you pick another model, set it to that model's documented context window as a positive whole number of tokens.
4. Keep `EVE_PORT` and `EVE_URL` consistent. Start the agent:

   ```sh
   npm start
   ```

The agent listens on `127.0.0.1` and loads `.env` automatically.
Keep this terminal open while you use the worker.

For extra protection, consider [Socket Firewall](https://socket.dev/products/socket-firewall) for package installs.
If installed, prefix an install command with `sfw`, such as `sfw npm ci`.

## Connect your Sokosumi Coworker

Install Sokosumi CLI `1.0.4`. This starter uses its runtime adapter.
Check compatibility before changing that version.

```sh
npm install --global @masumi_network/sokosumi@1.0.4
sokosumi --version
sokosumi skills
```

1. Follow the [setup guide](https://www.masumi.network/tum-hackathon) to sign in with your own Preprod account.
   Create your own Vendor and a private Coworker with task access.
2. Connect the Coworker to your Personal Workspace for the first test.
   Import its runtime key through the CLI's supported credential interface. Keep the key in the CLI vault.
3. Set the returned `COWORKER_ID` in `.env`.
   Keep `PAID_TASKS_ENABLED=false` until you complete the payment setup below.
4. Start the worker in a second terminal:

   ```sh
   npm run worker
   ```

5. Create a task in your Personal Workspace. Replace `YOUR_COWORKER_ID` with your Coworker ID:

   ```sh
   sokosumi --preprod tasks create --personal --coworker-id YOUR_COWORKER_ID --description "Suggest names for our hackathon team." --status READY --json
   ```

Open the task in Sokosumi and check that it reaches `COMPLETED` with an answer.
Run only one worker for this project. Keep both local services running.

For CLI options, use `sokosumi --help` and its [official documentation](https://github.com/masumi-network/sokosumi/tree/main/apps/cli).

## Switch to the TUM Workspace

Keep both organization settings blank for your first Personal Workspace test.
Finish active Tasks and pending seller receipt checks before you switch Workspaces.

1. Join the [TUM Sokosumi Workspace](https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW).
   Read its actual organization ID and slug:

   ```sh
   sokosumi --preprod workspaces list --json
   ```

2. Connect your existing Coworker to that Workspace. Replace each placeholder with your returned IDs:

   ```sh
   sokosumi --preprod coworkers connect YOUR_COWORKER_ID --vendor-id YOUR_VENDOR_ID --workspace-id YOUR_ORGANIZATION_ID --json
   sokosumi --preprod workspaces check YOUR_ORGANIZATION_ID --json
   ```

   If access is `PENDING`, ask a Workspace owner or admin to approve it, then run `connect` again.
   Continue only when access is `GRANTED` and your account is eligible to create tasks.
3. Stop the worker. In `.env`, set `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` to that Workspace's ID and slug.
   Set both together. The worker rejects incomplete settings and tasks from another Workspace.
4. Restart the worker:

   ```sh
   npm run worker
   ```

5. Create a task in the TUM Workspace:

   ```sh
   sokosumi --preprod tasks create --organization-slug YOUR_WORKSPACE_SLUG --coworker-id YOUR_COWORKER_ID --description "Suggest names for our hackathon team." --status READY --json
   ```

The worker uses the organization slug for task discovery and the organization ID for runtime execution.
Comments and paid tasks use the same Coworker and Workspace checks.
To return to Personal Workspace tasks, finish active work, clear both organization settings, and restart the worker.

## Optional Preprod payments

Prepare your own [Masumi Payment Service](https://github.com/masumi-network/masumi-payment-service) with its current setup instructions.
Use a dedicated database, encryption key, and selling wallet for this project.
Keep setup secrets, including that node's `ADMIN_KEY`, in `.local/mps.env` with permission `600`.
Fund your selling wallet with test ADA.

1. Create `docs/` and `.local/` if absent.
   Save your payment source's `sourceId`, selling wallet's `walletId`, and `sellerAddress` in `docs/payment-state.json`.
   Read these identifiers from your own MPS responses.
2. Set `MPS_URL`, `AGENT_API_PORT`, `AGENT_AUTHOR`, and `BLOCKFROST_API_KEY_PREPROD` in `.env`.
   Use your own name or team name for `AGENT_AUTHOR`.
3. Create the scoped runtime key, then register the agent:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
   ```

4. Check registration until it confirms:

   ```sh
   node --env-file=.env --env-file=.local/mps.env payment-registration.mjs
   ```

5. Complete `docs/registration-state.json` with the confirmed `agentIdentifier`, actual `supportedPaymentSourceIndex`, and selling wallet's `sellerVkey`.
   Read these from your own confirmed registry and wallet responses.
   Start `npm run api`, set `PAID_TASKS_ENABLED=true`, and restart the worker.

Enable payments only after registration confirms and the scoped runtime key is saved in `.local/mps-runtime.env`.
Never copy another project's wallet, registration, or task IDs.
If a payment or registration write has an uncertain outcome, inspect its saved state before retrying.
Complete a paid task and check the seller's net receipt before you submit payment evidence.

## Run the Sniffer end-to-end test (Preprod)

This runs one invoice through the whole pipeline: x402 intake payment, Initial Check, three paid investigators on Sokosumi, the Main decision and, if approved, a supplier payout. It spends test ADA only.

1. Start the backend stack: `npm run stack`. Set `VIES_MODE=mock` in `.local/live.env`; the fixtures use made-up VAT IDs that real VIES rejects.
2. Start one Eve runtime, one x402 API and one worker per investigator role, each in its own terminal (or in the background):

   ```sh
   npm run investigator:eve -- invoice    # also: wallet, supplier, main
   npm run investigator:api -- invoice    # also: wallet, supplier
   npm run investigator:worker -- invoice # also: wallet, supplier
   ```

3. Log in to the Sokosumi CLI (`sokosumi --preprod auth login`). Main creates the investigator tasks with this login.
4. Check everything with the read-only preflight. Repeat until it prints `Preflight passed.`:

   ```sh
   npm run preflight
   ```

5. Start Main. It pays investigators and suppliers with real Preprod tADA, so it needs an explicit flag:

   ```sh
   npm run main -- --confirm-live-payments
   ```

6. In another terminal, submit the test invoice `docs/fixtures/f1.xml` as the customer and follow the case to its decision:

   ```sh
   npm run demo -- --confirm-live-payment
   ```

   Running it again with the same invoice only resumes polling. For a new case, pass `--invoice-number <new number>`. Use `npm run demo -- --case <case_id>` to follow an existing case without paying.
   A second invoice from the same supplier loses S-9 (first invoice), scores low and is auto-approved without investigators. Add `--new-supplier` to swap the seller (VAT BT-31, name BT-27, open order BT-13) for the first VAT that `backend/data/vies-mock.json` marks valid and the backend has no invoice for. It reads `GET /v1/suppliers/{supplier_hash}/history` with `SNIFFER_HMAC_KEY` and `SNIFFER_API_TOKEN`. Without them, pass `--supplier-vat <VAT>` (and optionally `--supplier-name <name>`). `npm run preflight` reports whether the submitted supplier is still fresh.

## Check your changes

```sh
npm test
```

These tests check local logic. Test your own model connection, Coworker task, and seller receipt through the full setup flow.
The current `npm audit` reports three dependency findings: two high and one moderate, across `eve`, `undici`, and `zod`.
Review these before public deployment. Dependency versions stay pinned in `package-lock.json`.
Keep `.env`, `.local/`, wallet secrets, and generated resource state out of git.
