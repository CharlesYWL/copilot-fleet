# DRI implementation: local worker report

> Historical initial-delivery report. The deep-review fixes and current validation
> are recorded in [DRI_REVIEW_FIXES.md](DRI_REVIEW_FIXES.md). Initial claims about
> backup caps, retention/purge, pagination, proposal scope and live registration
> are superseded by that report and the current architecture guide.

## Outcome and branch

Implemented the typed investigation domain, persistence, read-only provider
boundary, fixture orchestration, authenticated transport, browser experience,
tests and documentation. The fixture workflow and static/build/web gates pass.
**The repository-wide test gate is not green:** its remaining failures are in
unchanged SecurityPanel tests, with repeated exact-main controls below.
**Live providers are `not_tested`.**

- Branch: `dev/sihanwang/dri-investigation`.
- Fetched baseline and current HEAD:
  `03435b71ccf7426a793c0fad5aadfc7c416b7683`.
- Local commits created: **none**. Consequently no commit trailer is applicable.
  No commit lacking the required Copilot trailer was created.
- Original local `main` remains
  `c120e98489c5dc15001df13fe80709aa764b42d7`.
- Original notification branch remains
  `ad8e9cb8d9787518fe3beee79f9b29364e39004f`.
- Initial tracked/untracked working tree was clean. No stash or overwrite of
  pre-existing source changes was needed.
- Normal `git fetch origin` encountered an already-deleted notification remote
  branch in the pre-existing fetch refspec. Retried with
  `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`; configuration was not
  changed. Latest fetched main was the baseline above.
- Created the exact local branch using `git switch --no-track -c
dev/sihanwang/dri-investigation origin/main`.
- `git ls-remote --heads origin refs/heads/dev/sihanwang/dri-investigation`
  returned no rows both before implementation and during final verification.
- `git for-each-ref` reports an empty upstream for the DRI branch.
  `git log origin/main..HEAD` is empty.
- No push, upstream-setting, PR creation/update, patch publication, main rewrite
  or force-push command/tool was executed. Neither reference repository was
  modified. The detached exact-main control worktree was removed.
- Source changes remain local and uncommitted. New files have intent-to-add
  entries so ordinary `git diff` includes them; no staged content commit exists.

## Architecture and boundaries

See [DRI_INVESTIGATION.md](DRI_INVESTIGATION.md) for the architecture, extension
guide, DMS provenance, API catalog, read-only/redaction policy, retention,
deployment limitations and the **drifus / LimnMCP / Fleet / implementation
decision capability matrix**. It records the supplied reference commits:
drifus `60db3bc63fc230f1940e3b48ae8d8720108191a8` (with cached/inaccessible
revision limitations), LimnMCP `28cf3fced3e5914d0df518e81e21352cc40be925`,
and the Fleet baseline above.

The domain is one-to-one with a Run. Host-executed capability-scoped provider
workers use durable RunSteps, not ACP sessions with ambient write tools.
Evidence, queries, hypotheses and reports are never authoritative in prompts,
RunStep outputs or RunNote prose. Typed profile causal rules permit team
extensions without coordinator conditionals.

SQLite uses additive tables, bounded indexed pages, immutable result/report
hashes, conflict rejection, attempt receipts, optimistic revisions and a
restore-safe generation clock. Stop, recovery and catastrophic budget failure
fence old results and normalize unfinished work. Completed calls are not replayed.
UTC timeline pages are chronological; browser pagination restarts when its
revision changes. Portable restore validates normalized hashes and pauses;
raw artifacts/private bindings are excluded.

Production tool dispatch requires exact read-only capabilities/tool names,
discovery annotations and explicit authorization. The installed MCP SDK,
trusted schema mapper boundary, local manifest-only HAR adapter and parameterized
telemetry compiler are reused rather than granting workers broad tools.
Credential headers, cookies, raw URLs/bodies and raw correlation IDs do not
survive HAR analysis. Private hints/pivots are separated from public state.
No production ICM/tool invocation or incident mutation was performed.

The browser provides creation, profile confidence/correction, Run linkage,
provider/worker progress, Stop/Resume/review and all requested evidence/report
sections. REST payloads are paginated; websocket messages are revision hints.
Citations load on demand. Notifications contain generic top-level/review text
only; dependency completion remains muted.

## Exact validation results

Environment: Windows; Node `v24.14.0`, npm `11.9.0`, Vitest `3.2.7`.
The initial Host typecheck found a missing existing `@azure/msal-node`
installation. Restored the unchanged lockfile using
`npm ci --ignore-scripts --no-audit --no-fund`. No dependency was added.
Installation warned that jsdom 30 requires a newer supported Node patch level;
that warning is retained as an environment limitation, not asserted as the
proven cause of the SecurityPanel failures.

| Gate / command                                     | Result                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run lint`                                     | PASS, exit 0, no lint errors/warnings                                             |
| `npm run format:check`                             | PASS on cleaned source, exit 0                                                    |
| `npm run typecheck`                                | PASS for protocol, Host server/UI/tests, and Node/tests                           |
| `npm run build`                                    | PASS for protocol, production Host UI/server and Node                             |
| DRI-focused service/adapter/route/UI/hook coverage | **60 tests pass** on final source; all pass in the final full run                 |
| Final `npm test`, clean lifecycle environment      | **174 files pass, 1 fails; 2,368 tests pass, 6 fail; 2,374 total; 133.07s**       |
| `npm run smoke:dri` on final production build      | PASS, exit 0                                                                      |
| `git diff --check`                                 | PASS                                                                              |
| Live ICM/telemetry/source/deployment smoke         | **not_tested**: no authorized non-sensitive live incident or credentials supplied |

Production build: 2,571 modules; final browser asset
`index-C6nG7rG1.js`, 1,343.59 kB (381.87 kB gzip).
Vite reports its large-chunk advisory; the build succeeds. No unrelated bundler
redesign or browser E2E dependency was added.

Focused coverage is in:

- `coordinator.test.ts`: 45 tests, including ICM validation, generic/DMS/other
  profiles, ownership-based auto-selection/correction, complete pagination, HAR,
  query bounds/outcome taxonomy, dedupe/conflicts, partial providers, hypotheses,
  citations, stop/resume/restart/restore/late results, budgets, retention, private
  bindings, read-only enforcement and fixture orchestration.
- `adapters.test.ts`: 4 tests for SDK discovery/allowlists, capability isolation,
  parameterized telemetry and bounded local artifact reads.
- `routes/dri.test.ts`: 4 authenticated/CSRF/revision/fixture/live-unavailable
  integration tests.
- `DriWorkbench.test.tsx`: 4 component tests.
- `useDri.test.tsx`: 3 revision/navigation/pagination tests.

### Full-suite baseline controls

No SecurityPanel or authentication test/source file was changed, and no failing
test was disabled, skipped in the full gate, or relaxed to obtain a green result.

1. Initial full run with inherited `npm_lifecycle_event=dev`: 172 files passed,
   3 failed; 2,363 tests passed, 8 failed (2,371 total at that point).
2. The three failing suites in isolation, branch and detached **exact main**:
   both produced **5 failures / 86 passes / 91 total**, with identical failures.
3. Removing the inherited dev lifecycle variable eliminated the four
   authentication redirect failures on **both** trees. The same isolated suites
   then produced **1 SecurityPanel failure / 90 passes** on each tree.
4. The isolated SecurityPanel case `lets an administrator explicitly enable
password sign-in` passed alone on exact main (1 pass, 55 other cases skipped
   only for this diagnostic).
5. Full exact-main run in the clean environment: **169 files pass, 1 fails;
   2,311 tests pass, 3 fail / 2,314 total; 259.13s**. Its failures were the
   reset-confirmation, non-JSON response and missing-verification-URL cases in
   SecurityPanel.
6. Repeated branch-wide runs had varying SecurityPanel-only failures. The final
   run's six are reset confirmation, refused reset, rejected CSRF proof, recent
   authentication retry, and blank-tab cleanup for 403/200 responses.

These controls reproduce the existing order/timing failure family, including
exact matching cases. They do not make the full gate green. The final run has no
DRI, other UI, service, protocol or Node failures.

The clean-environment invocation removed only the process-local inherited
`npm_lifecycle_event` before running the ordinary test script. Test scratch was
redirected under the repository's `.dri-test-work`. Existing tunnel tests leave
deliberately invalid JSON fixtures there; a formatting attempt correctly
reported those generated files. They were removed before the successful final
format gate; source checks were not weakened.

### Real web and fixture smoke

The final smoke starts an in-memory Host on an ephemeral loopback port, uses
**curl** against its production HTML, verifies the actual bundled DRI entry point,
checks unauthenticated access (401) and missing CSRF (403), then runs fixture
intake/HAR/telemetry/similar/change/report collection. It stops and resumes an
unfinished telemetry attempt, verifies that completed intake is not repeated,
checks strong/false similar matches, temporal-only deployment correlation and
evidence-linked report retrieval, and closes the Host.

Final result:

```json
{
  "web": "curl 200",
  "browserAsset": 200,
  "unauthenticated": 401,
  "csrf": 403,
  "fixture": "DMS report and citations verified",
  "stopResume": "passed",
  "completedCallsReplayed": 0,
  "liveProviders": "not_tested"
}
```

**Important initial-smoke side effect:** the first smoke imported the existing
CLI module directly outside test mode. That module enters default Host startup
on import, opens its configured default local store, and then encountered the
already-occupied `127.0.0.1:8787`. Normal startup includes schema/connectivity
reconciliation, so ignored local Host runtime data must not be assumed unchanged.
No unsafe rollback of shared runtime state was attempted, and no pre-existing
listener/process was stopped. The corrected smoke suppresses CLI auto-start
during factory import, then explicitly uses production mode, `:memory:` and port 0. Repeated corrected/final smokes pass without opening the default store.

## Complete changed-file inventory

```text
ARCHITECTURE.md
README.md
apps\host\src\dri\adapters.test.ts
apps\host\src\dri\adapters.ts
apps\host\src\dri\coordinator.test.ts
apps\host\src\dri\coordinator.ts
apps\host\src\dri\fixtures.ts
apps\host\src\dri\har.ts
apps\host\src\dri\profiles.ts
apps\host\src\dri\providers.ts
apps\host\src\dri\reports.ts
apps\host\src\dri\safety.ts
apps\host\src\dri\store.ts
apps\host\src\orchestrator\engine.ts
apps\host\src\orchestrator\tools.ts
apps\host\src\routes\dri.test.ts
apps\host\src\routes\dri.ts
apps\host\src\routes\runs.ts
apps\host\src\server.ts
apps\host\src\store.ts
apps\host\ui\src\App.tsx
apps\host\ui\src\components\TopBar.tsx
apps\host\ui\src\components\dri\DriWorkbench.test.tsx
apps\host\ui\src\components\dri\DriWorkbench.tsx
apps\host\ui\src\hooks\useDri.test.tsx
apps\host\ui\src\hooks\useDri.ts
apps\host\ui\src\hooks\useFleet.ts
docs\DRI_INVESTIGATION.md
docs\DRI_VALIDATION.md
eslint.config.js
package.json
packages\protocol\src\dri.ts
packages\protocol\src\index.ts
scripts\dri-smoke.mjs
```

The validation worktree and generated scratch files/logs are removed after these
results are recorded. Built distribution files and restored dependencies are
ignored repository outputs, not published artifacts.
