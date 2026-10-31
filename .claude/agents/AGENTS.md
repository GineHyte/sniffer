
## Agent roster

Subagent definitions live in `.claude/agents/`. Split each big task into small tasks, one owning agent each.
Start with `task-planner`. Run independent tasks in parallel. Finish with `test-verifier`, then `safety-reviewer`.

| Agent | Scope |
|-------|-------|
| `task-planner` | Read-only. Breaks a brief into ordered small tasks and assigns owners. |
| `agent-builder` | `agent/`, agent purpose and instructions, model config. |
| `worker-integrator` | `worker.mjs`, task target, comments, paid task, settlement, runtime adapter. |
| `sokosumi-provisioner` | `sokosumi` CLI: Vendor, Coworker, workspace connection, live tasks. Asks before writes. |
| `payments-registrar` | Payment service, registration, wallets, paid-task enablement. Needs `AGENT_AUTHOR`. |
| `test-verifier` | `npm test` and live-check evidence. No source edits. |
| `safety-reviewer` | Diff audit: secrets, ignored state, foreign IDs, pinned deps, unevidenced claims. |

Rules for all agents: ask the user before external writes, resource creation, funds transfers, publishing, deployment.
Only one agent edits a given file at a time.
