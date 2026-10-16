# Command reference

Run `node "<skill>/scripts/prm.mjs" <command> [options]`. Output is one JSON object with
`ok`, `command`, the result fields, and usually `next`. Exit code 0 means `ok: true`.

Global options:

- `--state <absolute dir>`: state directory. Default `PRM_STATE_DIR`, then `~/.prm/state`.
- `--op <id>`: operation ID for safe retries of mutating commands.

| Command                                                                                                                                                                                                       | Purpose                                                                                                      | Key result fields                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `init`                                                                                                                                                                                                        | Create the state store once (idempotent)                                                                     | `created`, `stateRoot`                                               |
| `add <pr-url> --mode m [--checkout d] [--verify c]... [--baseline t] [--resolve-threads] [--interval min] [--launcher name] [--session id] [--repair-batches n] [--answer-batches n] [--mutation-attempts n]` | Register a PR                                                                                                | `job.jobId`                                                          |
| `status`                                                                                                                                                                                                      | All jobs, active pass, carried scan                                                                          | `jobs[]`, `activePass`                                               |
| `show --job id`                                                                                                                                                                                               | One job in detail, including any outstanding work order                                                      | `obligations`, `holds`, `batches`, `outstandingWorkOrder`            |
| `begin [--label t]`                                                                                                                                                                                           | Start the single active pass (5 visits, 40 provider requests, 5 minutes)                                     | `pass.passId`, `due[]`, `attention[]`                                |
| `observe --pass p --job j [--requests n]`                                                                                                                                                                     | One bounded read-only provider visit                                                                         | `outcome`, `obligations[]`, `checks`, `reviews`, `readinessBlockers` |
| `triage --pass p --job j --input f`                                                                                                                                                                           | Record `no_action` / `needs_human` decisions that need no work batch                                         | `recorded`, `openObligations`, `readinessBlockers`                   |
| `plan --pass p --job j --input f`                                                                                                                                                                             | Turn triage into an immutable work order (needs a complete observation from this pass, under 30 minutes old) | `batchId`, `workOrder` or `refused`                                  |
| `report --batch b --input f`                                                                                                                                                                                  | Record the worker's report and remote effects                                                                | `batchState`, `holds`                                                |
| `cancel --batch b --reason t`                                                                                                                                                                                 | Cancel a batch that was never started (refunds its batch budget)                                             | `batchState`                                                         |
| `end --pass p`                                                                                                                                                                                                | Close the pass; unvisited due jobs are served first next time                                                | `visited`, `carriedToNextPass`                                       |
| `hold --job j --kind design\|human --reason t [--source id]...`                                                                                                                                               | Stop planning until the user decides                                                                         | `hold.holdId`                                                        |
| `pause --job j --reason t`                                                                                                                                                                                    | Stop observing a job                                                                                         |                                                                      |
| `resume --job j [--clear holdId]... --confirm-human "<user's words>"`                                                                                                                                         | **User decision only.** Clear holds and resume                                                               |                                                                      |
| `release --job j`                                                                                                                                                                                             | Stop maintaining a PR (after merge/close or on request)                                                      |                                                                      |
| `recover --pass p --confirm-stopped "<user's words>"`                                                                                                                                                         | **User only.** Retire a pass whose agent is gone                                                             |                                                                      |
| `recover --lock <lockId>`                                                                                                                                                                                     | **User only.** Remove a writer lock left by a crashed command                                                |                                                                      |

`observe` outcomes:

- `waiting`: nothing actionable (checks or reviews pending, or nothing new).
- `action_needed`: triage `obligations`.
- `needs_human`: open items are already waiting on the user.
- `blocked`: holds exist; see `job.holds`.
- `ready`: complete evidence, all checks passed, reviews approved, mergeable, no open items.
- `terminal`: merged or closed.

Other `observe` fields worth reporting:

- `changed`: the PR's actionable fingerprint differs from the previous complete observation.
- `readyChanged`: the PR became ready in this observation (tell the user once).
- `alreadySettled`: sources hidden because they were settled at their current revision.
- `obligations[].change`: `new`, `changed` (edited since you last saw it), or `carried`.
- `obligations[].awaitingPublication`: reported fixed and pushed, but the PR still shows the
  old head. Do not re-plan it; check the push.
- `readinessBlockers`: why the PR is not ready.

Common error codes:

| Code                                                                 | Meaning / what to do                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `state_uninitialized`                                                | Run `init`.                                                              |
| `state_busy`                                                         | Another prm command is writing. Retry in a moment.                       |
| `pass_active`                                                        | Another session is mid-pass. Tell the user; do not recover without them. |
| `pass_expired`, `visit_budget_exhausted`, `request_budget_exhausted` | End the pass; continue later.                                            |
| `observe_first`, `evidence_stale`                                    | Observe the job in this pass before `plan`.                              |
| `job_held`, `batch_outstanding`                                      | Resolve the hold with the user / report the batch first.                 |
| `invalid_report`, `invalid_plan`, `invalid_input`                    | Fix the JSON using `details`, then retry.                                |
| `operation_conflict`                                                 | You reused an `--op` ID for a different request; use a new ID.           |
| `state_corrupt`, `state_missing`, `state_root_changed`               | Stop and tell the user. Never delete or re-initialize.                   |

Schemas for plan input, work orders, work reports and the store are in `schemas/`.

## Scheduled use

A scheduler (cron, Task Scheduler, a CI job, or an agent loop) can start a headless agent with
this skill and a prompt such as "Run one prm maintenance pass and report". In unattended runs,
use `observe` mode or have the agent stop before any push or reply until a human approves.

Headless agents must be allowed to run `node` and to write the state directory:

- GitHub Copilot CLI: `copilot -p "<prompt>" --allow-tool "shell(node)" --add-dir <state dir>`
  (or `--allow-all-tools --add-dir <state dir>`).
- Claude Code: `claude -p "<prompt>" --allowedTools "Bash(node:*)" --add-dir <state dir>`.
- Codex CLI: `codex exec "<prompt>"` with a sandbox that permits writing the state directory.
