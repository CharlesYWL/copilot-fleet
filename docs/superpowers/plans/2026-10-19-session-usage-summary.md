# Session usage summary implementation plan

**Goal:** Add live cumulative AI-credit and token reporting for all Fleet sessions, with durable history and machine/task/day filters.

**Approved design:** Session-level snapshots only. Copilot credits and combined Copilot/Hermes token consumption are separate measures. Shared Orchestrator usage is unallocated. Unknown metrics remain unknown. Snapshot differences, not sums of cumulative readings, produce period totals. Existing sessions enter as opening balances. Usage survives transcript retention. No telemetry exporter, model proxy, paid measurement prompts, new database dependency, or automatic agent restart.

**Runtime:** Preserve the repository's existing Node.js >=22.5 requirement and node:sqlite implementation; the available runtime is v22.22.3.

## Execution sequence

1. Define shared validated accounting snapshot and report types in `packages/protocol/src/usage.ts`, export them, and add optional `accounting` to the existing session-usage payload. Test unknown/zero, units, finite safe counters, and report boundaries before implementation.
2. Extend backend usage adapters to collect cumulative snapshots, including live credit checkpoints, optional Copilot checkpoint/shutdown token totals, and Hermes completion/persisted aggregate totals. Retain existing context indicators. Test actual sanitized formats, partial lines, unchanged reads, cancellation, resume, shutdown and unsupported data. Distinguish existing-session baselines from new-session zero baselines.
3. Add a private durable Node snapshot journal. Intercept accounting events independently of the bounded transcript outbox, persist stable sequence identities before transport, capability-gate transmission, acknowledge committed batches, and replay across reconnect/restart. Include lead sessions. Test duplicate batches and pending retention.
4. Add a separate Host usage store using the existing SQLite connection, with retained stream metadata and immutable snapshot rows. Insert and derive in a transaction. Calculate metric-specific differences before date filtering; preserve opening balances and source intervals, reject identity conflicts, flag counter regressions, and avoid retiming stale fields. Test offline/order/replay, initial baselines, metric independence, period boundaries, deleted sessions, and backups.
5. Add protected `GET /api/usage` reporting. Validate filter/group/timezone parameters. Return known subtotals, coverage, coarse/unallocated counts, retained filter options, and grouped rows from one canonical aggregation path. Bind Node identity on ingestion; never trust a Node to name another machine.
6. Build an accessible Fluent UI v9 Usage page and sidebar navigation. Offer rolling day/week/month, all and custom date ranges; machine/task/backend/role filters; day/machine/task/session grouping; separate credits/tokens; optional detail and coverage. Refresh while mounted, abort stale requests, preserve filters, and show errors explicitly. Test filters, N/A credits, missing tokens, custom range validation and navigation.
7. Integrate transport, server wiring, documentation and portable backup schema. Run focused Vitest suites, then formatting, lint, typecheck, unit tests and production build. Review final diff for duplicates, disclosure of transcript content, and accidental application behavior changes.

## Core algorithm

- A backend returns a cumulative snapshot with stable native counter scope, source time, optional credit/token values and optional source-reported detail.
- A new native session has an explicit zero baseline only when known; attaching to existing usage creates an opening balance.
- The Node journals only changed accounting values, assigns a durable revision and sends bounded batches to a capable Host. An acknowledgement removes only the named committed prefix.
- The Host resolves session/machine/task labels, stores the immutable reading once and computes each metric against its own previous valid reading in the same counter scope. Missing fields do not erase previous observations.
- All-time totals include opening balances once. Bounded periods include observed increments; intervals crossing a boundary are surfaced as coarse/unallocated rather than silently prorated. Running/idle/shutdown readings use the same counters.
- Workers/reviewers use their task binding. Lead sessions use the Shared Orchestrator bucket. No model-inferred allocation is introduced.

Implementation stays in this worktree. No commits or pushes are part of the requested change.
