# Automatic DRI routing: delivery and validation

Validated on Windows on 2026-09-09 with Node `v24.14.0`, npm `11.9.0`,
Vitest `3.2.7`, and Vite `7.3.5`. This delivery extends, rather than replaces,
`d4ce5ab0aec704d00c322ce1c555807530f5aa4e` on
`dev/sihanwang/dri-investigation`.

## Architecture and behavior

`OrchestrationCreationService` is the Host boundary for the existing lead task
creation and standalone Run routes, plus the generic creation/preview API.
The generic DRI core owns deterministic, bounded classification. No UI regex
chooses the workflow, provider, or team profile.

Auto confidently routes operational ICM requests to the existing typed coordinator.
Regular requests retain their policy inheritance, pending lead briefing, approval
and scheduling behavior. Ambiguous requests return a typed HTTP 409 correction
without creating anything. Explicit Regular/DRI selections override detection;
DRI still requires a valid ICM reference. DMS selection follows verified ingested
service/component evidence, not request wording.

The normal creation dialog offers Auto, Regular and DRI investigation, with
accessible explanation/correction and stale-preview fencing. A routed request
opens the DRI workbench and its linked Run. Provider selection is not a normal
creation option. Unavailable capabilities remain visible in durable readiness
records and blocked/partial investigations.

Hashed creation receipts have a unique SQLite index and are committed with the
Run/investigation/steps. They survive restart and backup/restore. The browser
persists only a request digest and opaque retry key in session storage, not
request text. Replay returns the same retained Run without restarting stopped
work; changed input under the same key conflicts. Missing restored DRI source
data is not regenerated. Unkeyed legacy regular requests keep their original
create-every-time semantics.

The shipped read-only MCP catalog adapter reuses Fleet's HTTP MCP contract and
SDK discovery. Operator-installed `_meta["fleet/dri"]` manifests, exact tool
allowlists, input-schema compatibility and read-only/non-destructive annotations
must all agree. Authorization and discovery are rechecked before calls. HTTP/SSE
responses are byte-bounded before parsing; collection remains scoped by incident,
trusted query plan, pages, rows, bytes, timeout, concurrency and generation.
Discovery itself is bounded and interruptible, including when an injected
discovery implementation ignores abort.

Existing typed persistence, independent evidence/citation gates, safe notifications,
redaction, Stop/Resume, stale-result fencing, bounded backups, retention/legal
holds and retained-Run purge protection remain in place. Changes from several
declared source/pipeline readers retain a truthful aggregate outcome when the
last source is empty.

## Validation results

All final gates passed. No existing timing-sensitive UI assertion, timeout, skip,
or exclusion was relaxed.

| Gate | Exact invocation | Result |
| --- | --- | --- |
| Final read-bound/lifecycle/MCP target | `npx vitest run apps\host\src\dri\adapters.test.ts apps\host\src\dri\coordinator.test.ts apps\host\src\dri\mcp.test.ts --maxWorkers=2` | 3 files, 71 tests passed; 3.24 s |
| Complete feature suite | `npm test -- --maxWorkers=2` | 184 files, 2,499 tests passed; 519.03 s |
| Exact-main full control | `npm test -- --maxWorkers=2` | 170 files, 2,314 tests passed; 416.58 s |
| Lint | `npm run lint` | Exit 0 |
| Formatting | `npm run format:check` | Exit 0, after removal of generated test scratch |
| All workspace typechecks | `npm run typecheck` | Exit 0; protocol, Host server/UI/tests, Node/tests |
| Production build | `npm run build` | Exit 0; protocol, Host server/UI, Node |
| Normal-entry integration smoke | `npm run smoke:dri` | Exit 0 |
| Whitespace integrity | `git diff --check` | Exit 0 |

The complete feature suite includes the classifier, normal creation service/API,
UI correction/key persistence, backup/restart replay, missing-provider and
read-only MCP regressions, as well as all pre-existing tests. There are 82
additional tests compared with the preserved DRI commit.

Earlier development runs found an incomplete test socket's shutdown stub, an
accidentally nested test declaration, and an assertion assuming live readiness
was synchronous. These were corrected without weakening behavior checks.
One new backup/replay test exceeded its unchanged five-second timeout in an
expanded parallel run; it passed unchanged in isolation in 417 ms and in the
final complete feature run. Both final full-suite controls were green; the
previously documented legacy UI timing failures did not recur in those runs.

### Exact-main control and isolation

The control used a detached worktree at the exact remote main revision
`03435b71ccf7426a793c0fad5aadfc7c416b7683`, with unchanged tracked source and a
byte-identical lockfile. Installed vendor dependencies were reused through
temporary junctions, but every `@fleet` workspace pointed to the control's own
source. Protocol import resolution was verified to point into that control and
to contain neither the DRI investigation nor routing schema. This was not a
baseline test run accidentally importing the feature protocol.

Both full suites used two workers, the same SQLite validation guard, disposable
stores and process-local temporary/cache paths. The inherited development
lifecycle marker was removed for validation. Default-store sentinels remained
absent. No dependency manifest or installed dependency was changed.

After validation, the detached control, its dependency junctions and owned
repository scratch were removed. Shared dependency targets were not deleted.
Raw gate logs remain private session artifacts, not committed source.

### Smoke result

The smoke imports the Host factory with CLI auto-start suppressed, then runs a
production-mode Host on an ephemeral loopback port with an explicit in-memory
database. Its synthetic Node socket never executes commands or starts Copilot.
Fixtures are explicitly injected into that isolated harness; they are not
selected by an environment variable or by the submitted request.

```json
{
  "web": "curl 200",
  "browserAsset": 200,
  "unauthenticated": 401,
  "csrf": 403,
  "fixture": "DMS report and citations verified",
  "normalAutoRouting": "one linked synthetic Investigation+Run",
  "regularRouting": "legacy briefing and policy preserved",
  "ambiguous": "409; no creation",
  "idempotency": "same Run on replay",
  "stopResume": "passed",
  "completedCallsReplayed": 0,
  "genericPurge": 409,
  "backupCoverage": "complete",
  "liveProviders": "not_tested"
}
```

The production build retains Vite's existing large-chunk advisory; it is not a
build failure. The smoke checks the actual compiled browser asset. Browser
interaction/accessibility is covered by component tests, not a claimed external
browser automation run.

## Operator setup and manual use

See [MCP setup](DRI_INVESTIGATION.md#mcp-setup) for the manifest contract, exact
allowlists, input mappings, normalized page format and credential requirements.
The Host reads its account's `%USERPROFILE%\.copilot\mcp-config.json`.

Ordinary `npm run dev` exposes Auto routing without a DRI environment flag:
open **New task**, leave **Workflow: Auto**, and submit an authorized ICM request.
Without configured providers, expect a durable blocked investigation with
capability-specific setup guidance. Configure approved readers and Resume.
The README example remains regular; the bare incident example requires correction.
`npm run smoke:dri` exercises the synthetic, isolated route without manual flags.

**Limitations:** credentialed production providers were not tested. The generic
adapter requires a verified `provider-page-v1` normalization contract. Differing
stock ICM/GitHub/Kusto schemas need an operator-configured read-only MCP facade
and manifest; they are never guessed or treated as raw evidence. Facades must
resolve installation-specific private pivots and telemetry mappings within their
authorized incident scope. Stdio execution, arbitrary plugins, automatic OAuth
login and arbitrary KQL/management commands are not supported. Missing configuration
never enables synthetic success.

## Changed files

Paths are relative to the repository. Bare filenames in a row share the directory
of the preceding full path.

| Area | Files |
| --- | --- |
| Root documentation | `README.md`, `ARCHITECTURE.md` |
| Protocol | `packages\protocol\src\dri.ts`, `packages\protocol\src\index.ts` |
| DRI core | `apps\host\src\dri\classifier.ts`, `classifier.test.ts`, `coordinator.ts`, `coordinator.test.ts`, `profiles.ts`, `providers.ts`, `safety.ts` |
| MCP/read adapters | `apps\host\src\dri\mcp.ts`, `mcp.test.ts`, `adapters.ts`, `adapters.test.ts`, `availability.test.ts` |
| Creation domain | `apps\host\src\orchestrator\creation.ts`, `creation.test.ts`, `fleet-harness.ts` |
| Routes | `apps\host\src\routes\orchestration-creation.ts`, `orchestration-creation.test.ts`, `orchestrators.ts`, `runs.ts`, `dri-review.test.ts` |
| Composition/persistence | `apps\host\src\server.ts`, `apps\host\src\store.ts` |
| Browser shell/retries | `apps\host\ui\src\App.tsx`, `apps\host\ui\src\lib\orchestration-request.ts` |
| Normal creation UI | `apps\host\ui\src\components\orchestration\CreateOrchestrationDialog.tsx`, `CreateOrchestrationDialog.test.tsx` |
| Workbench | `apps\host\ui\src\components\dri\DriWorkbench.tsx`, `DriWorkbench.test.tsx` |
| Guide/report/smoke | `docs\DRI_INVESTIGATION.md`, `docs\DRI_AUTO_ROUTING_VALIDATION.md`, `scripts\dri-smoke.mjs` |
