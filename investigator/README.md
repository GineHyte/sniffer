# Investigators (Task 25)

Each investigator role (`invoice`, `wallet`, `supplier`) runs three local processes:

| Process | Command | Default address |
|---|---|---|
| Eve model runtime | `node --env-file=.env investigator/eve-root.mjs <role>` | `EVE_URL_<ROLE>`, else `EVE_URL` |
| x402 API | `node --env-file=.env investigator/api.mjs <role>` | 127.0.0.1:21961 / 21962 / 21963 |
| Worker | `node --env-file=.env investigator/worker.mjs <role>` | none |

The role argument wins over `AGENT_ROLE`. Run one process of each kind per role. Lock files refuse a second API or worker for the same role.

## Why each Eve role has its own app root

Eve 0.71.0 allows one `eve dev` server per app root. Measured on 2026-10-31: a second role process started from the repo root exits at once with "A dev server is already running for this eve agent". `eve-root.mjs` therefore runs each role from `.local/eve-<role>/`. It copies `agent/` and `promts/` there on every start, links `node_modules`, and writes a renamed `package.json`.

Eve's bundler refuses prompt imports that resolve outside the app root, so `agent/` and `promts/` are copies, not links. Restart the role's Eve process after you change a prompt.

`.local/eve-<role>/` contains directory links (junctions on Windows), also inside Eve's own `.eve/dev-runtime/`. To delete it, use `node -e "require('fs').rmSync('.local/eve-invoice',{recursive:true,force:true})"`. Node removes links without following them.

## Flow and state

1. Main creates the Sokosumi task and pays `POST /pay/{sokosumiTaskId}`. The API only records a confirmed payment in `.local/investigator-<role>/gate-journal.json`.
2. The worker polls the role Coworker's tasks. It starts a READY task only if the gate journal holds a confirmed payment for that exact Sokosumi task ID.
3. The worker parses the task description with `contract.mjs`, asks the role's Eve process for the report, and completes the task with the report JSON.

Per-task journals are in `.local/investigator-<role>/tasks/<taskId>.json`. `start-pending` or `complete-pending` after a crash blocks that task for inspection. The worker never retries an uncertain Sokosumi write.

## Settings

| Variable | Used by | Notes |
|---|---|---|
| `AGENT_ROLE` | all | Fallback for the role argument |
| `INVESTIGATOR_<ROLE>_PORT` / `INVESTIGATOR_PORT` | API | Optional; defaults above |
| `INVESTIGATOR_<ROLE>_PRICE_LOVELACE` / `INVESTIGATOR_PRICE_LOVELACE` | API | Required |
| `INVESTIGATOR_<ROLE>_PAY_TO` / `INVESTIGATOR_PAY_TO` | API | Required, `addr_test1…` |
| `BLOCKFROST_API_KEY_PREPROD` | API | In-process facilitator |
| `COWORKER_ID_<ROLE>` | worker | Required |
| `SOKOSUMI_ORGANIZATION_ID`, `SOKOSUMI_ORGANIZATION_SLUG` | worker | Both or neither |
| `EVE_URL_<ROLE>` / `EVE_URL` / `EVE_PORT` | Eve, worker | Must be `http://127.0.0.1:<port>` |
| `INVESTIGATOR_POLL_MS` | worker | Default 5000 |
| `INVESTIGATOR_DEADLINE_MS` | worker | Default 900000, counted from `runtime start` |
