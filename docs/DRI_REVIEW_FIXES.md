# DRI deep-review repairs and validation

This report supersedes the initial delivery's validation claims in
[DRI_VALIDATION.md](DRI_VALIDATION.md). The current contract and extension guide
are in [DRI_INVESTIGATION.md](DRI_INVESTIGATION.md).

## Finding-by-finding disposition

| Finding                                      | Repair                                                                                                                                                                                                                                                                                                                                                                 | Regression evidence                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. DRI volume breaks all Host backups        | Select complete investigation partitions within count and encoded-size budgets. Never parse a cap+1 materialized array. Export `coverage.state`/reason/totals/included counts; isolate any DRI exporter/schema failure into a typed degraded section. Both backup routes expose the state header and both backup UIs warn.                                             | Actual 2,000/2,001 investigation boundary; exact 100,000/100,001 record/attempt selection boundaries; equivalent small-budget SQL materialization; both authenticated backup routes return 200 with explicit limited/degraded coverage. |
| 2. Inactive investigations never expire      | Age-gated expiry includes draft, blocked, partial and awaiting-review states as well as completed/failed/stopped. Honor legal hold, the longest raw/evidence/report policy, future artifact leases and current work/query activity. Bounded scanning progresses past active rows.                                                                                      | Each of seven inactive and five active states, legal hold, raw/evidence/report duration precedence, query liveness, write activity timestamps and batching.                                                                             |
| 3. Collection UI flaps on 412                | First pages are unpinned and obtain rows plus revision/generation atomically. Continuations require that fence. The hook performs at most one unpinned restart, retains valid visible snapshots, replaces rather than appends rows and coalesces hints without aborting in-flight hydration.                                                                           | Real authenticated Host routes and SQLite, not a mocked server: evidence and query hydration while the head advances; real 412 continuation restart; no duplicate rows; 20 continuous updates without blanking or request starvation.   |
| 4. Generic Run purge destroys retained DRI   | Route, lifecycle and store refuse any retained DRI Run purge before side effects. A durable Run marker also protects omitted/degraded restored partitions. Policy expiry emits a non-cascading tombstone, clears the marker and leaves the Run cancelled; only then may ordinary purge proceed.                                                                        | Active/awaiting/approved/stopped cases, evidence/report survival, legal hold, expired and non-DRI Runs, store/lifecycle/HTTP refusal, tombstone survival after Run deletion.                                                            |
| 5. Live CLI registration claim is inaccurate | Chose the explicitly permitted honest-deferral path: **production CLI live adapters are not shipped**. The generic boundary, SDK bridge, local HAR reader and telemetry compiler are embedding building blocks, not a shipped live integration. UI/API/docs expose `embedding_only`, disable unconfigured live selection and require explicit fixture choice.          | Availability schema/coordinator/API/component/doc tests; unconfigured live requests remain blocked with zero provider calls.                                                                                                            |
| 6. Proposal scope check was tautological     | Removed the claimed lead-ID authorization check. Caller authorization is the independent operator session/CSRF guard. Explicit Run/step/invocation/generation/invocation-attempt/step-attempt/producer-agent/session coordinates are checked against stored receipts and session ownership. The Run/lead relationship is a consistency check, not a caller credential. | Authenticated negative tests for another Run, another real session (including a misbound step), another step/agent, wrong invocation or step attempt; correct Host-worker coordinates succeed.                                          |

### Coupled fixes

- Initial profile-decision IDs were shared across investigations. Stored keys
  are now investigation-scoped while retaining legacy rows and payload identity.
  Creating two investigations with the same profile no longer conflicts or loses
  a decision; the 2,001-investigation test also exercises this.
- Count bounds alone could admit impractically large DRI payloads. The DRI
  section also uses an **8 MiB encoded-size estimate**, with per-row envelope and
  top-level reserve, before loading payloads. Whole-investigation selection
  preserves citation closure. Export verifies source record/attempt hashes.
- Limited/degraded restore preserves `runs.dri_id` even when the investigation
  rows were omitted, cancels its executable steps and marks attached sessions
  stopped. The session scheduler/general task tools cannot replay missing DRI
  work. Later backups continue to report an incomplete source.
- Both export and import UI surfaces warn about incomplete DRI coverage. Other
  Host data is retained under Fleet's existing backup contract rather than a DRI
  exception taking down both export endpoints.
- Legal hold is operable through a revision-qualified, operator/CSRF-protected
  retention route and checkbox. Expiry tombstones are portable, bounded and
  independent of Run/investigation foreign-key deletion.
- A small validation-only SQLite preload rejects unintended store locations
  before `DatabaseSync` opens them, preventing a recurrence of the initial
  delivery's default-Host startup side effect.

## Validation environment and isolation

- Windows; Node `v24.14.0`, npm `11.9.0`, Vitest `3.2.7`.
- No packages or dependency manifests were changed for these repairs.
- Every DRI Host fixture explicitly uses `:memory:`; durable fixture files use
  repository-owned scratch directories. All provider fixtures and identities
  are synthetic.
- `scripts/dri-validation-guard.cjs` was verified with both CommonJS and ESM
  SQLite imports: memory opens succeed; a non-isolated synthetic path is
  rejected **before opening**, and no file is created.
- Allowed validation files are under `.dri-review-work`, `.dri-test-work`, or the
  existing `apps\host\data\test-scratch\legacy-*\fleet.db` test family. The guard
  does not permit the default `apps\host\data\fleet.db`.
- A second defense sets `DATABASE_PATH` to an unexpected-default-store sentinel
  under owned scratch. Root and baseline sentinels remained absent.
- No production providers were accessed. Live-provider testing was **not
  performed**, as explicitly prohibited for this repair task.

The first guarded full run rejected the existing legacy-enrollment test scratch
family. That was a validation allowlist issue, not an application failure. The
allowlist was narrowed to that exact existing fixture family; the real default
store remains blocked. Legacy-enrollment tests then pass.

## Commands and results

The process-local inherited `npm_lifecycle_event=dev` was removed for test runs,
as in the initial investigation. `TEMP`, `TMP`, `NODE_COMPILE_CACHE` and the
default-store sentinel were directed into the owned review directory. No global
environment or `.env` file was modified.

### Focused gate

```powershell
npx vitest run apps\host\src\dri apps\host\src\routes\dri.test.ts apps\host\src\routes\dri-review.test.ts apps\host\ui\src\hooks\useDri.test.tsx apps\host\ui\src\hooks\useDri.integration.test.tsx apps\host\ui\src\components\dri apps\host\ui\src\components\GeneralPanel.test.tsx apps\host\ui\src\components\PortableBackupCard.test.tsx
```

**PASS: 11 files, 116 tests, 21.18s, exit 0.**

This includes all original DRI coverage plus:

- `review-persistence.test.ts`: 29 tests;
- `availability.test.ts`: 2 tests;
- `routes/dri-review.test.ts`: 5 tests;
- `useDri.integration.test.tsx`: 4 real Host-plus-hook tests;
- new availability and backup-warning component tests;
- all existing coordinator, adapter, route and hydration tests.

The exact large record/attempt cap tests operate on the default selector's
100,000/100,001 metadata counts; equivalent small caps exercise the identical
SQL materialization path without allocating hundreds of megabytes of fixtures.
The 2,000/2,001 investigation test materializes actual SQLite rows and valid
backup sections at the real boundary. No boundary is tested only by mocking a
successful backup response.

### Static, production and smoke gates

| Gate                                  | Result                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run lint`                        | PASS, exit 0                                                                   |
| `npm run format:check`                | PASS on cleaned source; generated invalid-JSON test fixtures are removed first |
| `npm run typecheck`                   | PASS for protocol, Host server/UI/tests and Node/tests                         |
| `npm run build`                       | PASS for protocol, production Host UI/server and Node                          |
| `npm run smoke:dri` with SQLite guard | PASS, exit 0                                                                   |
| `git diff --check`                    | PASS                                                                           |

The production build retains Vite's large-chunk advisory
(`index-D2OrnHlJ.js`, 1,347.00 kB / 383.01 kB gzip); it is not a build failure.
The installed Node patch level remains below jsdom 30's stated engine range,
as recorded in the initial report; no claim is made that this is the proven
cause of the legacy UI timing failures.

The smoke uses a production-mode, ephemeral-loopback Host with an explicit
in-memory store after suppressing CLI auto-start during factory import. It checks
curl HTML, the actual DRI browser asset, authentication, CSRF, fixture collection,
stop/resume/no completed-call replay, citations, fenced continuation pages,
generic purge refusal, backup completeness metadata and embedding-only availability.
It closes the Host and stops no pre-existing process.

```json
{
  "web": "curl 200",
  "browserAsset": 200,
  "unauthenticated": 401,
  "csrf": 403,
  "fixture": "DMS report and citations verified",
  "stopResume": "passed",
  "completedCallsReplayed": 0,
  "genericPurge": 409,
  "backupCoverage": "complete",
  "liveProviders": "not_tested"
}
```

### Full-suite results and exact-main controls

**The full repository gate is not green. No test assertion, timeout, exclusion
or skip was changed to conceal a failure.**

- Ordinary `npm test`, after correcting the guard's legitimate scratch family:
  **177 files pass / 2 fail; 2,410 tests pass / 7 fail out of 2,417; 151.12s**.
  Six failures are in SecurityPanel; one is TunnelPanel's operational-refusal
  notification assertion.
- Additional full run `npm test -- --maxWorkers=2` (no filters, skips or changed
  assertions): **178 files pass / 1 fails; 2,416 tests pass / 1 fails out of 2,417;
  417.52s**. The failure is GeneralPanel's existing loading-error notification
  assertion, observing zero calls immediately after the inline text appears.
- The unchanged security/navigation/legacy-enrollment suites pass in isolation:
  **3 files, 75 tests, exit 0**.
- Detached exact-main full control at
  `03435b71ccf7426a793c0fad5aadfc7c416b7683`, same installed lockfile dependencies
  and SQLite isolation: **169 files pass / 1 fails; 2,310 tests pass / 4 fail out
  of 2,314; 266.75s**. All four are matching SecurityPanel failures.
- Two further runs of unchanged exact-main GeneralPanel, TunnelPanel,
  SecurityPanel and SettingsNavigation:
  - run 1: **77 pass / 1 fails out of 78; 222.42s** (SecurityPanel);
  - run 2: **69 pass / 9 fail out of 78; 137.96s**. This reproduces the exact
    GeneralPanel loading-error and TunnelPanel operational-refusal assertions,
    the earlier SettingsNavigation failures, and SecurityPanel failures.

The baseline controls therefore reproduce the remaining notification/lazy-UI
timing failure families rather than merely assuming they are pre-existing.
GeneralPanel's loading-error path, TunnelPanel, SettingsNavigation and SecurityPanel
assertions were not changed. The review work only adds backup-limit UI warnings
to GeneralPanel/PortableBackupCard. All DRI/review regressions pass in full runs.

## Local Git and preservation evidence

- Branch remains exactly `dev/sihanwang/dri-investigation`.
- HEAD and baseline remain `03435b71ccf7426a793c0fad5aadfc7c416b7683`.
- Local `main` remains `c120e98489c5dc15001df13fe80709aa764b42d7`.
- The pre-existing notification branch remains
  `ad8e9cb8d9787518fe3beee79f9b29364e39004f`.
- Initial repair worktree matched the prior uncommitted delivery: 34 changed
  files, 7,371 insertions, 19 deletions. Existing work was preserved and repaired
  in place, not reset or replaced.
- No commit was created; no commit trailer is applicable. No push, upstream
  configuration, PR operation, patch publication, main rewrite or reference
  repository mutation was performed.
- Final ref/status checks confirm no DRI upstream and no remote
  `refs/heads/dev/sihanwang/dri-investigation`.
- New files remain intent-to-add entries so the local diff includes them.
  The detached validation worktrees and owned scratch/logs are removed after
  these results are recorded. No default runtime store was opened in this repair.

### Review-specific file groups

- Protocol: bounded backup coverage/counts/tombstones, availability, legal hold,
  producer-scope coordinates and page-generation fencing.
- Persistence/execution: `dri/backup.ts`, `dri/store.ts`, `dri/coordinator.ts`,
  `store.ts`, `orchestrator/{engine,lifecycle,tools}.ts`.
- Transport: `routes/{dri,runs,system,portable-backup}.ts`.
- Browser: `useDri.ts`, `DriWorkbench.tsx`, GeneralPanel and PortableBackupCard.
- Tests: the new review persistence, availability, route and real Host/hook
  integration files, plus focused extensions to existing DRI/backup UI tests.
- Validation/docs: `scripts/dri-validation-guard.cjs`, enhanced `dri-smoke.mjs`,
  its lint configuration, README and the DRI architecture/historical/current reports.
