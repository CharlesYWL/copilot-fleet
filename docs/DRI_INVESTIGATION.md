# Evidence-driven DRI investigations

See [the deep-review repair report](DRI_REVIEW_FIXES.md) for current validation
and [the historical initial report](DRI_VALIDATION.md) for the original delivery.

DRI is an additive, typed domain linked one-to-one to an ordinary Fleet Run.
`packages/protocol/src/dri.ts` is the versioned, bounded Zod contract. The Host
coordinator executes **Intake → Collect → Analyze → Validate → Report**. The
browser's **DRI investigations → Create DRI Investigation** entry requires an ICM
ID or approved HTTPS incident URL. A validated report enters **Needs review**;
an operator can approve it or resume eligible incomplete collection.

**Shipped availability:** the synthetic fixture workflow is implemented.
**Production CLI live adapters are not shipped.** There is no CLI/settings/env
manifest for installing live providers. The typed provider boundary, MCP bridge,
local HAR reader and telemetry compiler are building blocks for an embedding
application; deployment-specific live normalization and authorization remain
deferred. `/api/dri/profiles` and investigation heads advertise
`liveRegistration: "embedding_only"` and whether an embedding supplied providers.
The UI disables unconfigured live selection and requires explicit fixture choice.
Unconfigured live API requests remain blocked without provider calls.

## Authority and execution

- `DriStore` uses FleetStore's SQLite connection, foreign keys, additive schema
  initialization, and synchronous transactions. No external database is required.
- Investigations, profile decisions, incident snapshots, timeline, evidence,
  artifact metadata, invocations, attempt receipts, work, hypotheses/relations,
  similar incidents, changes, reports and audits have dedicated tables/indices.
- RunSteps are execution/progress receipts, not evidence or report storage.
  Their outputs stay empty. A RunNote contains only a safe navigation/review
  notice. Query parameters, raw artifacts and conclusions are never hidden in
  prompts, markdown notes or step outputs.
- Provider workers execute on the Host under capability scopes. They are **not
  ordinary ACP sessions**: giving a nominally read-only agent the CLI's ambient
  write tools would violate this boundary. There are no synthetic worker Sessions
  or unnecessary Copilot processes. An optional existing leadSessionId links the
  investigation to its conversation; the provider work does not need a Node.
- The ordinary session scheduler and general fleet task mutation tools cannot
  take over a DRI Run. The DRI coordinator owns dispatch. HAR, telemetry and
  change collection run concurrently within the budget, after intake establishes
  scope. Similar search follows telemetry to use technical rather than wording
  signatures. Missing capabilities are recorded without dispatch.
- Profile causal rules declare required independent evidence types, technical
  signals, contradicting signals and falsification requirements. A generic
  coordinator evaluates these rules; adding a team does not require `if (team)`
  logic. A similar match or preceding deployment is never sufficient causal proof.

## Identity, replay, lifecycle and persistence

Stable logical work/query keys derive from the investigation, provider, profile,
template and binding fingerprint. Evidence has a stable dedupe key and source
hash. Immutable IDs with different content conflict; exact replay is a no-op.
Reports are immutable revisions with hashes and validated citations. Old evidence
can be addressed by ID for historical report citations.

Each invocation and result has an attempt and generation. Mutable invocation
progress is separate from immutable attempt receipts and result records. Head
indices expose only accepted results. Stop atomically cancels unfinished RunSteps,
normalizes running attempts to incomplete and advances the generation; completed
work remains completed. Resume does not duplicate completed queries or worker
identities. Retrying interrupted pagination can reread pages in that _unfinished_
query; completed logical queries are not replayed. Raw continuation tokens are
not persisted in public state.

Run archive/cancel also pauses DRI. DRI Resume explicitly reopens eligible work;
ordinary Run plan/approve/reopen/**DELETE** routes cannot bypass domain policy.
Generic purge is refused in the route, lifecycle service and store before any
session or review side effect, for **every retained DRI Run**, even if its nominal
age has expired. Only policy-based retention cleanup releases that restriction.
Profile
correction pauses, retains history, invalidates prior derived heads and requires
explicit Resume. Host restart and portable restore pause rather than replay.
A persistent generation clock, intentionally outside the backup payload, fences
in-flight results even when restoring an older backup over a live Host.

Portable and ordinary Host backup include bounded normalized state, evidence/report
metadata, profile decisions, invocation receipts and retention tombstones.
The DRI section selects **whole investigations** in a deterministic prefix, never
part of a report's citation graph. Limits are up to 2,000 investigations, 10,000
decisions, 100,000 records, 100,000 attempts and 10,000 tombstones, additionally
bounded by an 8 MiB encoded-size estimate (including wrapper reserve).
Metadata lookahead/counting is not materialized as an over-limit payload.

`dri.coverage` explicitly reports `complete`, `limited` or `degraded`, the reason,
known total counts and included counts. A DRI exporter/schema/hash failure produces
a typed **degraded** section rather than failing the entire Host export. Both
routes return `x-fleet-dri-backup-state`; both download/import UIs warn about
incomplete DRI data. No omission is advertised as a complete investigation backup.
Other Host data continues to use Fleet's existing backup/size policies.

Hash/redaction validation occurs inside restore. Raw HAR, credentials, private
query bindings and local artifact files are **not included**. A durable Run marker
survives even when its DRI partition was omitted: its Run/steps and any attached
sessions remain stopped/paused, cannot enter the ordinary scheduler or generic
purge path, and require complete source data. A subsequent export retains an
incomplete-source signal. Preserve the source Host when exporting a limited or
degraded archive. Available report bodies are restored, not regenerated.

Default limits: 30 invocation attempts, 10 pages/query, 200 rows/query,
512 KiB/query or artifact read, 15 seconds/call, four concurrent roles,
three-minute investigation deadline, 500 evidence records and 3,000 records per
collection. All limits have hard schema ceilings. These are operator/domain
configuration, never incident instructions.

Retention defaults are one day for a raw-artifact reference, 90 days for normalized
evidence and 365 days for reports. This implementation never writes raw artifacts:
approved local originals are owned by the operator, and expired manifest entries
are refused. Scheduled bounded cleanup ages inactive `draft`, `blocked`, `partial`,
`awaiting_review`, `completed`, `failed` and `stopped` states using last activity
and the **longest raw/evidence/report policy**. Active phases and current running
queries/work, future artifact leases, and `legalHold` exclude deletion. Result and
state writes update activity timestamps. `PATCH /api/dri/:id/retention` sets or
releases a legal hold with operator authentication, CSRF, If-Match and audit.

Expiry writes a non-cascading, non-sensitive audit tombstone and clears the Run
marker in the same transaction as deleting the expired investigation. The Run
stays cancelled and may subsequently be purged normally; the tombstone survives
that purge. Report/evidence citation closure is retained until the entire
investigation expires. Local original raw files remain operator-owned and are
not deleted by this service. Explicit whole-Host backup replacement remains
Fleet's separate destructive administrator operation, not a selective DRI purge.

## Provider and profile extension

1. Register an `InvestigationProfile` with a version, terminology, ownership
   mappings, identifier relationships, query-template metadata, causal rules,
   capability requirements, time-window policy and provenance/freshness.
2. Implement `InvestigationProvider.read(ProviderContext)` for the needed
   capabilities. Return a bounded `ProviderPage`: technical normalized facts,
   safe metadata, explicit completion/error state and an optional continuation.
   Do not return untrusted customer prose or raw tool envelopes as findings.
3. **Embedding/development integration only:** an application can supply
   `buildServer({ dri: { liveProviders, profiles } })` at its composition root.
   This is **not an operator configuration path in the shipped production CLI**.
   No arbitrary module loading, runtime plugin registration or live adapter
   credential configuration is implemented. The CLI server module auto-starts
   on import outside test mode; see the smoke's suppressed-start factory import,
   rather than importing it into a second production launcher unguarded.
   Operator authorization must precede each future production invocation.
   Optional `limits` configure bounded policy. Optional `resolvePrivateBindings`
   reacquires authorized private parameters after restart. Initial operator hints
   and adapter-recorded correlation/environment pivots are retained only in
   expiring Host memory; their public plans carry names/fingerprints, not values.
   Binding resolution shares the invocation timeout and abort signal.
4. Add fixture, capability, redaction, bounds, pagination and report-gate tests.
   Never widen the general coordinator or grant a worker broad CLI/MCP access.

The capability vocabulary is `incident.read`, `artifact.read`, `har.analyze`,
`telemetry.query`, `similar.search`, and `change.read`. Definitions must declare
`readOnly: true`. Results are checked against their invocation's capability:
an incident provider cannot forge a telemetry finding to manufacture corroboration.

`DeclaredMcpProvider` uses a trusted, versioned argument mapper and normalized
projection, explicit authorization and exact allowlisted tool names.
`SdkMcpReadClient` reuses the installed MCP SDK's paginated discovery and calls.
Discovery/readOnlyHint alone never grants access; both declared capability and
authorization must also pass. No update, post, mitigate, close, transfer, or
arbitrary tool-name path exists. Tool schema mappers must be verified against the
actual deployed MCP server. No deployment-specific live ICM/source/telemetry
adapter is claimed as implemented or validated by these interfaces.

Incident adapters should normalize all pages of details, discussion, handoffs,
linked incidents/resources and attachment metadata; they must report partial
coverage, not silently claim completeness. This contract is exercised by the
two-page synthetic incident provider.

Telemetry metadata selects a trusted profile template, early environment/UTC
filters, selected columns, row limits and failed/success/affected/unaffected
comparisons. `compileTelemetryReadPlan` only interpolates schema-validated
installation mapping names and a bounded integer. Binding values remain external
parameters. It cannot compile arbitrary query text or management commands.
Verified live cluster/database/table/column mappings are required; none were
borrowed from reference examples. `no_results`, `access_denied`, `unavailable`,
`failed`, `truncated` and `incomplete` are different outcomes.

`LocalArtifactReader` resolves only manifest-listed relative references under an
approved root, rejects traversal/links/expired entries, and bounds file reads.
`LocalHarProvider` parses in memory and emits request order, redirect/retry
relationships, first meaningful failure, HTTP/app failures, cancellation/stalls,
CORS/auth/cookie-presence signals, timing phases and hashed correlation IDs.
Neither raw URLs, cookie values, credential headers nor response bodies survive.
There is no upload endpoint or browser-supplied filesystem path.

## DMS provenance and reference decisions

This implementation uses the reference investigation supplied for this task; it
does not modify or re-fetch either reference repository.

| Capability                           | drifus                                        | LimnMCP                                           | Fleet baseline                     | Decision implemented                                           |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| DMS terminology / operational pivots | Strong runbook semantics, mapping/query drift | Generic discovery                                 | Durable generic Runs               | Versioned DMS profile; verified semantics only                 |
| Authority                            | Prompt/runbook-driven, weak typing            | Prompt-only SuperDRI state                        | Typed execution receipts           | Separate Zod/SQLite domain authority                           |
| Tools / access                       | IcM procedures and evidence gates             | Discovery, authorization, scoped agents           | MCP/ACP infrastructure             | Exact read-only capability/tool allowlists                     |
| HAR                                  | No HAR engine/tests in inspected reference    | Not adopted as HAR authority                      | No DRI HAR domain                  | Bounded local parser, central redaction, deterministic tests   |
| Partial failure                      | Operational guidance                          | Failure isolation / partial results               | Stop/resume/attempt lifecycle      | Independent providers, explicit limitations, generation fences |
| Reports / evaluation                 | Operational report semantics                  | Immutable reports, read-only evaluation/proposals | Run notes and review notifications | Immutable typed report revisions with citation validation      |
| Production mappings                  | Hardcoded identifiers and stale selectors     | Discovery infrastructure                          | No DMS binding                     | Operator-installed schema-verified mappings; none copied       |
| UI / persistence                     | Prompt/runbook oriented                       | Not adopted as state store                        | SQLite, REST, websocket, review UI | Bounded DRI pages and revision hints                           |

Reference identities:

- **drifus** active inspected commit:
  `60db3bc63fc230f1940e3b48ae8d8720108191a8`; cached newer origin `7dc68dbb`;
  inaccessible live reference `949677bc`. The latter two are context, **not**
  verified source revisions for imported semantics.
- **LimnMCP** inspected main:
  `28cf3fced3e5914d0df518e81e21352cc40be925`.
- **Fleet** fetched implementation baseline:
  `03435b71ccf7426a793c0fad5aadfc7c416b7683`.

DMS auto-selection requires exact **verified ICM owning-service and component**
matches. Question text, title wording, operator hints and a similar incident do
not select a team. The browser explains confidence and permits correction.
Every DMS heuristic carries source commit, review timestamp, sensitivity,
applicability and freshness. Query selectors require live verification. No
customer IDs, people, queue IDs, credentials, fixed incident windows, portal
locators or concrete reference examples were copied. Fixture identifiers and
dates are synthetic, independent of those repositories.

## Transport, proposals and browser behavior

All routes inherit the existing Host administrator authentication, origin/Host
guard and session CSRF policy. Mutation endpoints use a quoted numeric
`If-Match: "revision"`; missing revisions return 428, stale revisions 412.
Unknown or over-budget inputs fail with bounded generic errors, not raw Zod/tool
envelopes.

| Route                                                                                                            | Purpose                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET/POST /api/dri`                                                                                              | Bounded listing / create and start                                              |
| `GET /api/dri/profiles`                                                                                          | Profile catalog; fixture flag and embedding-only live availability              |
| `GET /api/dri/by-run/:runId`                                                                                     | One-to-one Run lookup                                                           |
| `GET /api/dri/:id`                                                                                               | Bounded investigation / worker / readiness head                                 |
| `GET/PATCH /api/dri/:id/profile`                                                                                 | Decision history / correction and pause                                         |
| `GET /api/dri/:id/{evidence,timeline,queries,hypotheses,similar,changes,reports,artifacts,incidents,audit,work}` | First page unpinned; continuations require returned `revision` and `generation` |
| `GET /api/dri/:id/evidence/:evidenceId`                                                                          | Scoped citation navigation                                                      |
| `GET /api/dri/:id/reports/:reportId`                                                                             | Immutable typed report and derived Markdown                                     |
| `POST /api/dri/:id/{stop,resume,complete}`                                                                       | Atomic lifecycle / reviewed approval                                            |
| `POST /api/dri/:id/proposals`                                                                                    | Operator-authorized, receipt-bound proposal validation                          |
| `PATCH /api/dri/:id/retention`                                                                                   | Set/release `legalHold` with revision and audit                                 |
| `POST /api/dri/:id/fixture/execute`                                                                              | Await fixture completion; never targets a live investigation                    |

Proposal **caller authorization is the independently authenticated operator
session and CSRF guard**, not a claimed lead ID. `leadSessionId` is a Run
relationship, not a caller credential. The request supplies `{scope, record}`;
scope names Run, step, invocation, invocation attempt, step attempt, generation,
producer agent and producer session (empty for a Host provider worker). These are
validated against independent stored Run/step/invocation receipts and, when
present, the producer session's owning Run/role. A forged/cross-Run/session/attempt
binding is refused. There is no shipped worker-token/lead-authenticated proposal
RPC. Host providers return bounded results to the internal typed ingestion path.
Current profile, capability, redaction and citations are also validated;
unsupported causal conclusions cannot be promoted by naming a lead.

Websocket `dri_changed` carries only investigation ID, Run ID and revision.
Snapshots/notifications do not carry evidence, queries, HAR or report payloads.
The first REST page obtains rows and its revision/generation in one SQLite
transaction without pinning to a separately fetched head. Continuations require
that fence and return 412 when it changed (428 when omitted). The browser performs
at most one immediate unpinned restart, replaces rather than appends restarted
rows, and does not turn 412 into a durable error. A valid older collection snapshot
stays visible with its own label while a newer head is collected. Change hints
coalesce and wait for an in-flight request instead of repeatedly aborting it.
Navigation still aborts superseded requests; generation/revision ordering rejects
stale head responses. Citations load on demand. It offers Overview, UTC Timeline, Evidence,
Queries, Hypotheses, Similar incidents, Changes/deployments and Report, plus
provider/worker progress, Stop/Resume, profile correction, loading/error/retry and
empty states. Report text is rendered as React text, not raw incident HTML.

Only top-level finish/fail and actionable Needs review produce notifications.
Ordinary provider dependency completion remains silent. Notification labels and
Run prompts are generic, never incident/customer data.

## Validation and deployment limitations

Use only disposable SQLite stores during validation. The validation preload below
rejects SQLite paths outside the repository-owned scratch directories and the
existing `apps\host\data\test-scratch\legacy-*\fleet.db` test fixture family **before
opening them**, including accidental CLI/default-store startup. It does not permit
`apps\host\data\fleet.db`. Do not load it in
the ordinary Host process.

```powershell
New-Item -ItemType Directory -Force .dri-review-work | Out-Null
$env:TEMP = Join-Path (Get-Location) '.dri-review-work'
$env:TMP = $env:TEMP
$env:DATABASE_PATH = Join-Path $env:TEMP 'unexpected-default.db'
$guard = (Join-Path (Get-Location) 'scripts\dri-validation-guard.cjs').Replace('\', '\\')
$env:NODE_OPTIONS = '--require "' + $guard + '"'
Remove-Item Env:npm_lifecycle_event -ErrorAction SilentlyContinue
npm run build -w @fleet/protocol
npx vitest run apps\host\src\dri apps\host\src\routes\dri.test.ts apps\host\src\routes\dri-review.test.ts apps\host\ui\src\components\dri apps\host\ui\src\hooks\useDri.test.tsx apps\host\ui\src\hooks\useDri.integration.test.tsx
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run smoke:dri
if (Test-Path $env:DATABASE_PATH) { throw 'Unexpected default store access' }
```

The smoke launches a real ephemeral loopback production Host, fetches the actual
HTML with curl and its browser asset, checks authentication/CSRF, runs fixture DMS
collection, stops/resumes without replaying completed intake, and verifies report
citations and change/similar conclusions. It closes the Host afterward. It does
not require browser E2E dependencies or a Node/Copilot login.

For a manual synthetic browser demonstration, set `FLEET_DRI_FIXTURES=true` on a
local Host and select fixture mode. It is disabled by default. Any valid numeric
ICM input in fixture mode selects **synthetic data only**, not a real incident.

**Live validation: not_tested.** No authorized non-sensitive live incident or
production credentials were supplied. The MCP transport/authorization boundary,
local HAR adapter and telemetry compiler are tested; deployment-specific ICM
schema projection, telemetry/environment bindings, source/pipeline mapping and
credentialed live adapters **are not shipped**. They require an embedding
implementation plus authorized read-only validation of permissions, attachment
retrieval and service freshness. Missing implementation/configuration blocks collection.
No production or ICM mutations are performed.
