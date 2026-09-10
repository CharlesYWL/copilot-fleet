# Evidence-driven DRI investigations

See [automatic-routing delivery and validation](DRI_AUTO_ROUTING_VALIDATION.md)
for the automatic-routing release's gates and changed-file manifest.

The [deep-review repair report](DRI_REVIEW_FIXES.md) and
[initial report](DRI_VALIDATION.md) record the previous implementation's validation.
The automatic-routing delivery retains that evidence/lifecycle implementation.

DRI is an additive, typed domain linked one-to-one to an ordinary Fleet Run.
`packages/protocol/src/dri.ts` is the versioned, bounded Zod contract. The Host
coordinator executes **Intake → Collect → Analyze → Validate → Report**. The
browser's normal **New task** entry detects DRI requests automatically. A DRI
investigation requires an ICM ID or approved HTTPS incident URL. A validated report enters **Needs review**;
an operator can approve it or resume eligible incomplete collection.

**Shipped availability:** normal creation uses configured read-only MCP providers.
The built-in catalog adapter reuses Fleet's HTTP MCP contract and SDK discovery;
it requires an operator-approved capability manifest and normalized response
contract. It does not guess how to execute arbitrary stock tool schemas.
`/api/dri/profiles` advertises `liveRegistration: "mcp_catalog"`; investigation
heads expose their own last observed discovered availability. Missing or incompatible
providers produce a durable blocked/partial investigation, per-capability setup
guidance, and retained evidence. The Host never falls back to synthetic data.
No DRI environment flag or provider mode is required for normal creation or UI visibility.

## Automatic routing

**New task → Workflow** offers **Auto** (default), **Regular**, and
**DRI investigation**. The Host-owned generic classifier examines at most 4,000
characters plus bounded structured `dri.icm` / `dri.artifactRef` hints.
It returns `dri | regular | ambiguous`, confidence, fixed safe reasons, a canonical
incident reference when established, and suggested evidence. It never copies
request prose into its explanation or uses wording to select the DMS profile.

| Request | Auto behavior |
| --- | --- |
| `Investigate ICM 123456789, analyze the HAR and telemetry, and determine root cause.` | DRI; create/start typed investigation and linked Run/steps |
| `Update the README with instructions for investigating ICM incidents.` | Regular; unchanged orchestrator briefing and dispatch |
| `Investigate incident 123456789.` | Confirmation required; no Run or investigation created |
| The ambiguous request plus `dri: { "icm": "123456789" }` | DRI; structured input establishes ICM |
| Any valid request plus `workflow: "regular"` | Regular, even when DRI was detected |
| `workflow: "dri"` without a usable ICM reference | Ask for the reference; never invent an incident |

Auto displays its DRI/ambiguous explanation before submission. **Use Regular**
corrects a false positive; **Use DRI investigation** confirms an ambiguous ICM
candidate. The ICM field is keyboard accessible. Preview results are fenced to
the current input so a delayed reply cannot route a newer coding request.
The routed response opens `DriWorkbench` with the investigation ID and linked Run.
The optional dedicated DRI entry remains available, without a provider-mode picker.

`OrchestrationCreationService` is the single Host creation boundary for
`POST /api/orchestrators/:id/runs`, `POST /api/orchestrations`, and the standalone
`POST /api/runs`. `POST /api/orchestrations/preview` is side-effect free.
Creation reclassifies independently of preview; ambiguity/missing reference
returns HTTP 409 with `kind: "confirmation_required"` and the typed classification.
The generic/lead success response includes `kind: "created"`, `workflow`, `run`,
`classification`, `replayed`, and, for DRI, `investigation`. The standalone route
retains its legacy Run response (with `investigationId` when routed).

The browser retains one `requestId` across double-submit, reconnect/reload and
uncertain-response retries using session storage containing only an input digest
and opaque key, not request text. Edited input gets a new key; confirmed creation
clears it. Run creation, DRI state/steps, and a hashed
creation receipt commit together. An indexed key returns the same retained Run
on replay (HTTP 200; initial creation is 201); different input with the same key
returns 409. Replay does not resume stopped work. Receipts survive Host restart
and both backup formats. A restored receipt with omitted DRI source data returns
410, never a new investigation. DRI clients omitting a key get deterministic
request-content deduplication; legacy regular clients without keys retain
create-every-time behavior. Deduplication lasts as long as the Run is retained.
Regular tasks still require their existing live lead/online placement; Host-only
DRI does not need a Node. A supplied stopping/terminal lead cannot acquire new work.

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
3. For an embedding application, supply
   `buildServer({ dri: { liveProviders, profiles } })` at its composition root.
   The shipped CLI instead uses the declarative MCP catalog described below.
   No arbitrary module loading or request-selected configuration is implemented.
   The CLI server module auto-starts
   on import outside test mode; see the smoke's suppressed-start factory import,
   rather than importing it into a second production launcher unguarded.
   Operator authorization must precede each production invocation.
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
actual deployed MCP server. Deployment-specific raw ICM/source/telemetry envelopes still require verified
normalization. The shipped adapter accepts only the declared normalized page contract.

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

## MCP setup

Run the Host under an account with access to its existing Copilot MCP catalog:
`%USERPROFILE%\.copilot\mcp-config.json` on Windows (`~/.copilot/mcp-config.json`
elsewhere). Fleet reads this bounded catalog on DRI intake/Resume. Only HTTP
entries with operator-installed `_meta["fleet/dri"]` metadata are eligible.
Existing unrelated MCP servers remain untouched. Stdio processes, arbitrary
module loading, remote plain HTTP, credential-bearing URLs, query-string URLs,
redirects and unmanifested tools are not executed by this adapter.

Each manifest binds an exact allowlisted tool to one capability, a versioned
argument mapping, and **`provider-page-v1` normalized results**. For example,
this placeholder is a configuration shape, not a deployed endpoint or credential:

```json
{
  "mcpServers": {
    "approved-investigation-reads": {
      "type": "http",
      "url": "https://mcp.example.invalid/readonly",
      "headers": {},
      "_meta": {
        "fleet/dri": {
          "version": 1,
          "bindings": [
            {
              "capability": "incident.read",
              "tool": "get_incident_details_by_id",
              "arguments": { "scope": "scope" },
              "response": "provider-page-v1"
            },
            {
              "capability": "telemetry.query",
              "tool": "telemetry_query_readonly",
              "arguments": { "scope": "scope" },
              "response": "provider-page-v1"
            }
          ]
        }
      }
    }
  }
}
```

The server must expose the declared input schema (in this example, an object
with a `scope` object property) and annotate the tool `readOnlyHint: true`, without
`destructiveHint: true`. Both are checked during discovery and again before
each invocation. Catalog authorization is reread before each call; revocation,
credential/endpoint changes, missing tools and incompatible schemas fail closed.
Only the local catalog grants authorization: incident text and tool descriptions
cannot install a manifest or enable writes.

The exact capability/tool vocabulary is intentionally small:

| Capability | Exact permitted tools |
| --- | --- |
| `incident.read` | `get_incident_details_by_id`, `get_incident_discussion_entries_and_insights`, `get_incident_context` |
| `artifact.read` | `artifact_metadata_read`, `artifact_bounded_read` |
| `har.analyze` | `har_analyze_local` |
| `telemetry.query` | `telemetry_query_readonly` |
| `similar.search` | `get_similar_incidents`, `search_incidents` |
| `change.read` | `get_commit`, `get_file_contents`, `actions_get`, `actions_list` |

Source-control, pipeline and deployment evidence can use several declared change
tools; they are collected serially within the same page/query budgets. Any missing
declared source makes that capability unavailable rather than advertising partial
discovery as full coverage. No substring/prefix matching is used. An annotated
`update_incident`, admin tool or similarly named write tool is still rejected.

Argument values are selected only from `scope`, `incidentId`, `artifactRef`,
`timeRange`, `queryPlan`, `profileId`, `cursor`, `maxRows`, `maxBytes`, and
`timeoutMs`. `scope` packages these safe fields. It never includes the request
question, credentials, private customer bindings, a tool name, an endpoint or
arbitrary KQL. All bindings must carry incident scope; telemetry must carry the
trusted bounded query plan (directly or within `scope`). Mapping keys/types must
match the discovered tool's required schema. Unknown required arguments are not
filled with guessed values.

The server returns a `ProviderPageSchema` object in MCP `structuredContent` or
one JSON text content item. It declares `succeeded`, `no_results`, `access_denied`,
`unavailable`, `failed`, or `truncated`, a bounded summary, and normalized incident,
evidence, timeline, similar/change or artifact metadata for its capability.
Optional continuation tokens are bounded; repeated/undeclared pagination fails.
For an empty successful bounded read, for example:

```json
{
  "structuredContent": {
    "state": "no_results",
    "summary": "No results in the authorized bounded scope."
  },
  "content": []
}
```

**Verify normalization before adding the manifest.** Stock ICM/GitHub/Kusto tool
envelopes are not generally this contract. Where they differ, configure an
authorized read-only MCP facade that projects the deployed schema into
`ProviderPageSchema`; a manifest is an attestation of that verified mapping,
not permission to treat free-form text as evidence. For Kusto, implement the
allowlisted `telemetry_query_readonly` facade with installation-verified
table/column mappings, parameterized queries and the profile's bounded cohort
plan. The existing `compileTelemetryReadPlan` is available for this purpose.
Raw Kusto execution/management tools are not allowlisted. Incident ownership must
come from verified service/component fields, never a title or the request's DMS
wording. Normalize attachment references and timeline/discussion coverage honestly;
report partial coverage when any source is incomplete.

Use existing secure catalog headers and least-privilege credentials managed by the
operator; Fleet does not hardcode, issue or persist provider credentials in Runs,
backups or browser state. Automatic OAuth login and arbitrary transport setup are
not implemented. HTTP is permitted only for local loopback facades; otherwise use
HTTPS. Catalogs are capped at 256 KiB, 20 servers and 20 bindings/server; SDK
discovery is bounded to 10 pages of at most 200 tools. Raw HTTP JSON/SSE bytes are
bounded before parsing. Discovery shares the call timeout and Stop signal; a
hung discovery becomes blocked and cannot hold Host shutdown indefinitely.
Each read also inherits the DRI call, row, byte, page,
concurrency and deadline limits.

After configuration, create a normal DRI request or **Resume unfinished work**.
The durable **Capability readiness** list names every required/optional capability,
its state, safe reason and setup instructions. An unavailable incident reader
blocks intake; missing later evidence produces a partial report, not corroboration
or fixture success. Fix configuration and Resume; completed accepted queries,
citations, reports, generation fencing and stop semantics remain intact.

Discovery registries and issues are scoped to one investigation execution and
generation. Concurrent investigations never replace each other's readers,
readiness or evidence provenance. Only the constructor's static embedding/fixture
providers are shared through read-only registry views. Each live execution
captures its own discovered overlay and copies its issues; role collection,
profile/readiness decisions and proposal checks use that scoped snapshot.
Snapshot cleanup is identity-qualified so an older execution cannot clear a newer
retry's context.

Provider clients are released when their execution finishes. Persisted readiness
remains the **last observed** result, not a reusable authorization grant. Stop,
Resume and Host restart do not carry live discovery clients forward: Resume
rediscovers for the new generation while preserving completed accepted work.
The global profile catalog lists only static provider definitions; the
investigation head exposes its active snapshot (or static registrations when
inactive) and its own persisted readiness.

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
| `GET /api/dri/profiles`                                                                                          | Profile catalog; static provider definitions and explicit test/demo availability |
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
npx vitest run apps\host\src\dri apps\host\src\orchestrator\creation.test.ts apps\host\src\routes\dri.test.ts apps\host\src\routes\dri-review.test.ts apps\host\src\routes\orchestration-creation.test.ts apps\host\ui\src\components\dri apps\host\ui\src\components\orchestration\CreateOrchestrationDialog.test.tsx apps\host\ui\src\hooks\useDri.test.tsx apps\host\ui\src\hooks\useDri.integration.test.tsx
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run smoke:dri
if (Test-Path $env:DATABASE_PATH) { throw 'Unexpected default store access' }
```

The smoke launches a real ephemeral loopback production Host, fetches the actual
HTML with curl and its browser asset, checks authentication/CSRF, automatically
routes an ordinary request using explicitly injected synthetic test providers,
keeps a regular request on its legacy path, stops/resumes without replaying completed intake, and verifies report
citations and change/similar conclusions. It closes the Host afterward. It does
not require browser E2E dependencies or a Node/Copilot login.

### Manual use without environment flags

Run ordinary `npm run dev`, sign in, open **New task**, and leave **Workflow: Auto**.
Use a real authorized ICM request to open its DRI workbench; without configured
providers it must become blocked with explicit MCP setup guidance. Try the README
example above to keep a regular task, then the ambiguous incident example to
exercise **Use Regular** / **Use DRI investigation** correction. Inspect the linked
Run, readiness, evidence and queries. Stop and Resume via DRI controls, not ordinary
Run planning or purge.

Fixtures are test/demo-only composition: the smoke injects
`buildServer({ databasePath: ":memory:", dri: { allowFixtures: true, fixtures },
testDriRouting: true, mcp: { catalog: { mcpServers: {} } } })`.
`testDriRouting` is not an API input and is refused without an in-memory store and
explicit fixture providers. Enabling fixtures alone does **not** change normal
Auto routing from live to synthetic. A test/demo Host may expose a separate
**Synthetic DRI demo** action; every such investigation is labeled synthetic.
The production launcher has no environment switch for fixture selection.

**Live validation: not_tested.** No authorized non-sensitive live incident or
production credentials were supplied. The MCP transport/authorization boundary,
local HAR adapter and telemetry compiler are tested; deployment-specific ICM
schema projection, telemetry/environment bindings, source/pipeline mapping and
credentialed production mappings **have not been validated**. The shipped generic
MCP catalog adapter is exercised with mock discovery and an actual synthetic
loopback HTTP MCP server. Authorized production normalization, permission,
attachment, Kusto mapping and freshness checks remain the operator's responsibility.
Missing implementation/configuration blocks collection.
No production or ICM mutations are performed.
