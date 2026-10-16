# prm-skill

Portable PR-maintenance skill (`prm`) for any coding agent (GitHub Copilot CLI, Claude
Code, Codex, Cursor). It is the standalone binding of the design in
[`docs/superpowers/specs/2026-09-21-portable-pr-maintenance-skill.md`](../../docs/superpowers/specs/2026-09-21-portable-pr-maintenance-skill.md)
(Appendix D: lead and worker roles, work orders and work reports).

The installable skill folder is generated at `dist/prm/`:

```text
prm/
  SKILL.md              entry point the agent loads
  references/           triage policy, worker contract, command reference
  schemas/              JSON Schemas generated from src/contracts.ts (z.toJSONSchema)
  scripts/prm.mjs       single bundled helper: state store + read-only GitHub/ADO reader
```

`scripts/prm.mjs` bundles zod, `@fleet/protocol` and Fleet's existing read-only provider
helpers (`apps/node/skills/pr-maintenance/*.mjs`), so an installed skill needs only Node 22+
and an authenticated `gh` (GitHub) or `az` (Azure DevOps). It never imports Fleet at run time.

## Build and test

```powershell
npm run build -w @fleet/prm-skill      # writes dist/prm
npx vitest run packages/prm-skill      # state, pass, plan/report contract tests
```

## Install

Copy `dist/prm` to the agent's skill folder:

| Agent              | Project skill folder | Personal skill folder   |
| ------------------ | -------------------- | ----------------------- |
| GitHub Copilot CLI | `.github/skills/prm` | `~/.copilot/skills/prm` |
| Claude Code        | `.claude/skills/prm` | `~/.claude/skills/prm`  |
| Codex              | `.agents/skills/prm` | `~/.codex/skills/prm`   |

State defaults to `~/.prm/state` (override with `PRM_STATE_DIR` or `--state`). It must live
outside the skill folder so reinstalling the skill never erases it.

## What v0.1 does

- One authoritative `store.json` per state directory: exclusive lock directory, temp file
  plus flush plus rename, idempotent `--op` receipts, no automatic stale-lock takeover.
- Bounded passes (5 visits, 40 provider requests, 5 minutes), oldest-due scan order with
  carry-over, one active pass per state directory.
- Modes `observe`, `answer`, `repair`. Repair and answer run in the current agent session:
  `plan` produces an immutable `prm.work-order/1`, the agent works it with
  `references/worker.md`, and `report` validates a `prm.work-report/1` against the order.
- Holds (design, human, auth, repeated failures, no progress, uncertain effects, permission
  violations, budget, head-branch ownership conflicts) that only a user can clear.
- Per-job budgets (3 repair batches, 3 answer batches, 100 mutation attempts).

Not yet: scheduled `dispatch` that resumes a recorded native session headlessly, and the
40-scenario model evaluation. See the spec's Appendix D.

## Fleet binding

`@fleet/prm-skill/fleet` (built to `dist/lib` by `npm run build:lib`, and by the root
`build:shared`) is the Fleet wrapper. Fleet keeps its own authority, admission and settlement
guards; the wrapper only translates:

- `fleetWorkOrder` turns a lead's plan plus the registration (current sources, grant, pins,
  budgets) into a `prm.work-order/1` and the immutable worker prompt the Host persists.
- `fleetSettlement` validates a `prm.work-report/1` against the stored order and maps it to
  Fleet's existing finding/effect settlement shape.

The Host exposes this through `fleet_checkpoint_pr_maintenance` kinds `prepare_work_order` and
`work_report`, and `fleet_follow_up` with only a maintenance reference. Legacy hand-written
`prepare_batch` / `batch` checkpoints remain accepted for existing records.

The `PRM_PROVIDER_FIXTURE` environment variable replaces the live provider read with a JSON
file. It exists only for rehearsals and tests.
