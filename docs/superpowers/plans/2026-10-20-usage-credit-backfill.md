# Usage credit backfill button

## Approved scope

Provide an English `Backfill old credits` button on the dark Usage report. It previews a one-time import per native Copilot conversation from saved terminal Fleet sessions. It never starts/resumes agents, queries a provider, mutates session records, estimates tokens, or assigns historical consumption to today. Repeating an import does not charge existing balances again; later newly eligible conversations can be previewed independently.

## Workflow and boundaries

- `GET /api/usage/backfill` returns a dry-run fingerprint, eligible conversation/session counts, total credits, and skipped-reason counts. It is restricted to Microsoft administrators, or the existing deliberately enabled local no-auth operator mode.
- `POST /api/usage/backfill` accepts only the preview fingerprint. The server recomputes eligibility, refuses changed previews with HTTP 409, and uses the server's saved counters only. Existing CSRF and origin protections apply.
- Create a consistent SQLite `VACUUM INTO` backup in the Host's protected data directory before mutation. Use an exclusive, server-generated filename and restrictive file permissions. Fail before importing if backup creation fails. In-memory test stores have no persistent database to back up.
- Recompute the plan inside a write transaction, then insert immutable accounting records through the existing Usage store. Return imported counts and the backup filename. Log the action through the existing authorization audit.
- The dialog explains fleet-wide scope, terminal-only sessions, undated history, and skipped reasons. Confirmation is disabled while loading/applying or when nothing is eligible. It never posts until the user confirms. On success, show a receipt and display all recorded Copilot history.

## Eligibility and identity

Read retained Fleet session metadata, saved `usage.aiCredits`, native `agentSessionId`, and state. Consider stopped/completed/failed Copilot sessions only. Validate finite nonnegative counters and safe native identities. Group by authenticated Node identity and native conversation identity; active aliases block the whole conversation. Collapse equal cumulative balances with matching task/role attribution; conflicting balances or attribution are skipped. Missing counters/identities are skipped, not invented as zero. A stored accounting native identity must agree with the session mapping.

Skip scopes already containing AI-credit snapshots, including prior backfill records. Token-only snapshots do not block missing credit imports. Create deterministic `legacy-credit-backfill-v1` snapshot IDs from Node/native identity, with the real native counter ID, an explicit Host-only source tag, baseline=true, and no startedAt. Credit-only imports preserve token totals.

## Reporting safety

Backfill increments always remain undated opening balances, including when older native readings arrive after import. Use cumulative differences for reconciliation: import 100 followed by a fresh 112 means 112 all-time, not 212. An older native 80 followed by imported 100 contributes only the undated remaining 20. Ignore an inferred backfill lower than an earlier authoritative reading; later lower native readings still produce a regression warning. Backfill insertion must not claim to be a fresh provider observation. Real live deltas retain the existing period/boundary rules.

## Implementation and verification

1. Add protocol preview/result types and request validation; implement `UsageBackfillStore` for planning, fingerprinting, conflict handling, transactional application, and stable IDs.
2. Wire it to FleetStore's session metadata and SQLite backup facility. Extend UsageStore's reporting treatment of the explicit backfill source.
3. Add protected endpoints and audit logging, with route tests for validation/authorization/stale previews.
4. Add the UI button/dialog with tests proving confirmation, loading/errors, repeat safety, and all-time report refresh.
5. Update the guide/design docs. Run focused protocol, store, migration, route, authorization, backup, and UI tests; lint, typecheck, and production build. Exercise only synthetic test databases, never the user's live database.

Work directly in the existing worktree without delegation. Do not restart Nodes, apply a live import, bump the version, or publish without a separate request.
