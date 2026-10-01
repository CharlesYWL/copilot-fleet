# Helper contract v1

The Node ships `SKILL.md`, this contract, `snapshot.mjs`, `ado-snapshot.mjs`,
`ado-contract.md`, `github-snapshot.mjs`, and offline
evaluation assets and `host-observation.mjs` together in its package-root
`skills/pr-maintenance` directory.
`tsc` builds the Node code, not these already-runnable assets. Lead ACP prompts
advertise their resolved absolute paths, including fallback agents and rollover.
No personal skill installation, new runtime, registry mutation, or token copy.

Execute `node "<absolute path to snapshot.mjs>"`. Feed JSON through stdin
using the existing approved command tool's data input or a local JSON evidence
file; never interpolate PR/review text into executable command text.
For `fleet_run_command`, use a separate authorized helper placement, without the
maintenance task ID. The retained task and checkout reject independent commands,
including observation helpers; repairs stay with the retained worker.

## Provider routing (Azure DevOps first, GitHub compatible)

For enablement discovery, provide `pr: {"url":
"https://dev.azure.com/example/Project/_git/Repo/pullrequest/123"}` with the
same `schemaVersion`, `generation` and remaining `budget` as below. The router
also accepts `https://example.visualstudio.com/Project/_git/Repo/pullrequest/123`
(including the legacy `DefaultCollection` segment) and GitHub
`https://github.com/owner/repository/pull/123`. It rejects conflicting explicit
scope, credentials, query strings, fragments and non-HTTPS URLs.

After authorization, use **`pr: {...record.identity}`**: the router derives
provider-specific discovery fields while preserving all exact pins. ADO identities
include `provider: "azure-devops"`, `host: "dev.azure.com"`, organization, project
display name/GUID, repository GUIDs, display names, PR number and full refs.
See [ADO reads, policy limits and worker guidance](ado-contract.md). Reads use the
already authenticated Node-local `az` CLI, not a personal skill, copied token,
automatic login or extension installation. ADO normally reserves 39 requests
(or the remaining wake allowance), leaving one for repair continuation. Do not
override this to the GitHub default eight. Explicitly reserving all 40 leaves
no continuation capacity in that wake.

GitHub records without `provider` remain GitHub; explicit `"github"` is also
accepted. Existing schema-v1 records/backups and `github-snapshot.mjs` inputs
continue to work. The following detailed GraphQL contract applies **only to GitHub**.
Provider output always includes the shared schema-validated `observation`;
checkpoint it unchanged regardless of provider when a registration and claimed
visit exist. Before registration, retain it in the existing task/execution
evidence; see the skill's pre-enrollment recovery guidance.

### Durable evidence handoff

For a registered job, claim with `fleet_get_pr_maintenance({takeDue:true})`
(not `recordId` plus `takeDue`). Prepare the helper input and **dispatch immediately**,
before unrelated work. Use returned `observationAllowance.requests` and
`observationAllowance.deadlineAt` unchanged, the registered identity/generation,
and only the current stored continuation. For `fleet_run_command`, also pass
the exact returned `observationClaim` as `maintenanceObservation`:
`{recordId,generation,wakeId}`. This binds one execution/attempt to the original
persisted reservation at command creation, under normal finite-command approvals.
Do not include the maintained `taskId`, add a deadline to the claim reference,
or attach a prior execution retroactively.

**Clock basis:** `deadlineAt` above is the original **Host** instant, not a Node
wall-clock timestamp. Host adds the persisted deadline/request count to command
preparation (not caller-editable `fleet_run_command` input); it is included in the
normal approved descriptor digest. Node injects `FLEET_MAINTENANCE_CLOCK` from that
descriptor and its original preparation monotonic sample into the finite process.
Do not set/copy that environment variable, supply an offset in JSON, translate the
deadline yourself, or use an older helper that ignores the runtime contract.
Direct provider CLIs and the router share this budget check. Standalone discovery
without a Fleet reservation still uses an explicitly Node-local deadline; it is
not an alternate way to collect for a claimed finite-command receipt.

The command proof's offset is **Host send time minus Node receive time**. It is a
lower-bound mapping, not a synchronized-clock assertion. The local collection
deadline is `Host deadline - hostClockOffsetMs - 5000 ms uncertainty - 1000 ms drift`,
using the existing command tolerances. The helper checks wall time against the
original cross-process monotonic sample and uses the later of wall/monotonic
progress before every token acquisition/read and completion. It never samples a
new allowance at approval, launch or helper start. Constant positive/negative
offsets are supported; inconsistent/discontinuous context fails closed.

Host receipt validation independently uses the persisted accepted preparation
proof, descriptor digest, original reservation and raw Node settlement receipt.
No stdout/PR/caller-supplied offset is authoritative. Raw observation timestamps,
elapsed time and stdout stay unchanged. Host-derived `observationHostAt` and
`lastAttemptAt` are earliest possible Host attempt times; optional
`lastAttemptLatestAt` is the latest bound. Freshness uses the earliest bound,
ordering refuses overlapping older evidence, and readiness/UI expiry uses the
same basis. These bounded derived fields are not permission for collection.
Paired updated Host/Node/helper code is required; missing old preparation budget
or revoked/restored clock proof cannot be retroactively manufactured.

End the turn after dispatch. On Fleet's automatic completion wake, read the
current record and **all** `fleet_get_execution` pages for that execution.
Use `format:"raw"` and concatenate decoded base64 stdout bytes in sequence before
UTF-8/JSON decoding (an event can split a character). Require known quiescence,
complete output, no gaps and helper exit 0 or 2. Persist with
`{recordId,expectedVersion,executionId,checkpoint:{kind:"observation",observation}}`.
The Host checks the exact observation against persisted, approved execution stdout,
not caller claims or a file path. This correlation survives a different Host
lead turn and same-database restart; repeating the same saved receipt is idempotent.

Pass the **whole `result.observation` object** from parsed helper stdout as
`checkpoint: {kind: "observation", observation: result.observation}` to
`fleet_checkpoint_pr_maintenance` with the claimed record ID and current version.
Exit 2 still has an observation: preserve its actual timestamp, usage, sanitized
error and opaque resume. `fallback.error`, when needed, is a string, not the
provider error object. A reconciliation note or path/hash is not an observation.
Do not copy only the displayed summary or rebuild/trim the continuation.

ADO `malformed_response` errors add a stable sanitized
`diagnostic: {stage,check,path}` to both `result.error` and
`observation.helperState.error`. Stage is `response` or `snapshot`, check is a
helper-owned ID, and path contains only fixed schema names and numeric indices/IDs
(for example `iterationStatuses[0].state`). Composite checks name the object;
unclassified failures use `response` / `required_evidence` / `$`. Provider text,
arbitrary keys/values, exception details and validator issue paths are never
copied into diagnostics. Exit codes, messages, Host receipts and checkpoint
schemas are unchanged. When supplying `fallback.error`, use the string
`"${result.error.code}: ${result.error.message}"`, not the error object.
See the ADO contract for omitted default status states and encoded artifact
separators; neither compatibility case weakens completeness or readiness gates.

The exposed MCP route accepts the supported large object inline (32 MiB
transport bound; helper state at most 1 MiB; total durable record at most 2 MiB).
No filesystem-import capability or arbitrary path read is provided. A synthetic
291,675-byte helper observation is covered from native CLI stdout through this
authenticated, claimed MCP checkpoint, exact readback and SQLite restart.
Read the record back and compare the serialized observation before treating
the handoff as durable; a rejected request is not saved evidence and does not
authorize another helper call. Owner/version/claim checks remain in force,
including for large payloads. Genuine overflow stays incomplete/rejected.

The async native fixture crosses command completion, a second accepted Host turn,
raw execution pagination, checkpointing and SQLite restart with 291,675 observation
bytes (291,959 CLI stdout bytes). A 590-byte, zero-operation deadline failure follows
the same path. The original reservation stays charged even when actual usage is
zero. An expired deadline can admit this evidence, **not** new provider I/O:
creation after expiry is refused; a helper still awaiting approval expires at the
deadline and never starts; a dispatched helper delayed past expiry fails closed.
Caller construction delay is not a collector performance failure.
Never re-date the observation, reset the deadline at launch, or reclaim a visit to
ingest an old result.

An already-started bounded request may settle after its timeout/deadline (for example,
ADO token acquisition plus one GET started with 50 ms left and returned after 51 ms).
Its **incomplete** exit-2 receipt still saves the exact timestamp, elapsed time, usage,
error and continuation. Nonzero usage requires an attempt begun before the original
deadline and within the reservation; elapsed time must fit the known command lifetime.
There is no grace period for collecting more data: a complete snapshot finishing after
the deadline is refused. A late incomplete receipt is attempt-only and does not consume
findings, update readiness, refresh the allowance or revive a held job. The CLI records
collection start before invoking the provider, not at result mapping.

Evidence older than the normal freshness window is retained only as `lastAttempt`,
not promoted to a current snapshot/readiness. A fresh complete receipt can make the
job due for action, but preparing/dispatching a repair still requires a **new current
bounded visit and remaining allowance**. Under a pause, release or human hold, an
otherwise exact same-scope receipt can update only `lastAttempt`, not lifecycle,
current observation, findings or decisions. Owner/binding/authorization/generation or
manual-control scope changes still refuse admission. Portable restore revokes the
local accepted-preparation receipt and cannot acquire active receipt authority; raw
command evidence and already-saved attempts remain readable under existing retention.
Unbound historical commands cannot acquire this authority retroactively. Same-turn
non-command observations retain the original claimed-visit checkpoint contract.

The proposal tool's `identity` is **not** the discovery `pr` object: pass a complete
helper's `observation.identity` unchanged, or construct the same strict provider
identity from fresh, independently authorized metadata. ADO uses
`repository/headRepository/baseRepository: "Project/Repo"` (case preserved),
separate provider GUIDs, full `refs/heads/...` refs, and `prNumber`. Do not pass
helper-only `url`, `repo`, or `number` fields in proposal `identity`.

Native GitHub `snapshot.identity` retains `{number,prId,url,...pins}`; native ADO
uses the shared provider identity. The GitHub observation mapper and Host receipt
boundary share one strict native-to-shared adapter (`number` to `prNumber`, with exact
PR URL/pin validation). The service-wide identity schema is unchanged and rejects
native snapshot fields. Host also matches generation, HEAD/base SHAs, state, draft
and fingerprint between snapshot and observation. Do not rewrite helper stdout to
make an incompatible identity appear to pass.

## GitHub compatibility helper

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "pr": {
    "host": "github.com",
    "owner": "owner",
    "repo": "repository",
    "number": 123,
    "repositoryId": "R_graphqlNodeId",
    "headRepositoryId": "R_forkNodeId",
    "headRepository": "fork-owner/repository",
    "headRef": "refs/heads/FixCaseSensitive",
    "baseRepositoryId": "R_graphqlNodeId",
    "baseRef": "refs/heads/main"
  },
  "budget": {
    "maxRequests": 20,
    "deadlineAt": "2030-01-01T00:00:00.000Z",
    "maxBytes": 262144
  },
  "knownEffects": [],
  "handledSources": [],
  "previousThreads": []
}
```

Use the real remaining deadline (example date is not a default). The helper
clamps work to 120 seconds and requests to 40. Individual reads time out after
15 seconds or the remaining deadline, whichever is smaller. maxBytes is 4096
through 1048576, default 262144; input, provider pages, accumulated checkpoint
and returned evidence are bounded. Larger evidence fails explicitly for manual
inspection or a larger bounded allowance. All initiated requests count even if
they fail; there are no hidden CLI pagination/retry loops. `gh api` uses the
already-active Node identity, never login or permission escalation.

At enablement discovery only, the five ID/ref pins may be omitted. Registration
then records the returned GraphQL **node IDs** (not numeric database IDs), head
and base refs, and the authorized scope. Every maintenance read must supply all
five pins. The PR repository is the base repository, which may differ from the
head repository. Host/names are case-insensitive; Git refs are not.
Also pass the registered `headRepository` name. If GitHub confirms closure/merge
after deleting the fork, the helper retains that pinned ID/name for terminal
settlement. An open PR with a missing head repository still blocks observation.

Every outcome is one JSON object; exit 0 means complete, exit 2 incomplete:

```text
{schemaVersion:1, complete, requestsConsumed, elapsedMs, observation,
 progress:{phase,pages,verifiedPages,cursor},
 snapshot?:{identity,generation,headSha,baseSha,state,title,body,mergeable,
   threads,threadStates,reviews,discussions,checks,requiredChecks,reviewPolicy,rules,reviewRequests,
   reviewDecision,actionableSources,effects,obligationKeys,actionableFingerprint},
 error?:{code,message,retryAfterSeconds?},
}
```

Incomplete output never has a snapshot. Record attempts/progress and charge
requests even when the command fails. Last successful observation must remain
unchanged. `budget_exhausted`/`deadline_exhausted` are bounded deferrals, not
network/authentication failures. Other codes distinguish authentication,
permissions, rate limits, timeout, unavailable CLI/ref, malformed/partial API
data, unsupported branch-rule API, changed scope, inconsistent snapshot, and
payload overflow. Diagnostic text is sanitized; raw provider errors/credentials
are not echoed.

ADO overflow diagnostics include `error.limit: {kind,stage,actual,maximum}`.
`kind` distinguishes bytes from the fixed 200-item/32-depth ceilings; `stage`
identifies input, response, checkpoint, snapshot, observation, output or continuation.
A byte allowance may be raised within 1 MiB, not beyond; this does not reset the
current wake's request/deadline allowance or remove item limits. A returned
continuation preserves the pending page and must be passed unchanged on a later
authorized bounded attempt. A null continuation means there is no resumable
checkpoint, not that evidence was complete. Use manual evidence when the hard
limits cannot accommodate the scan; never truncate obligations.

The CLI's `observation` conforms to the shared `PrMaintenanceObservationSchema`.
Write it through `fleet_checkpoint_pr_maintenance` without hand-translating fields.
Opaque GraphQL repository IDs preserve case; repository names and hosts do not.
`observation.helperState.resume` contains the bounded continuation once, rather
than duplicating the full checkpoint at the top level. Pass it unchanged as
`resume` on a later wake; `observation.helperState.previousThreads` holds the
last complete thread state. Usage, policy completeness, and CI-only failure
sources survive Host restart. A complete scan with no required checks/reviews
records that policy explicitly, not a missing-evidence pass.
The exported `observe()` fixture API retains its raw top-level `resume` result.

Persist `observation` in the Host checkpoint and pass its continuation unchanged on a later wake.
It is versioned and tied to exact input identity and generation. Revalidated
metadata must match before continuing; the second pass rereads **every** page,
including nested thread replies, review bodies, discussion, review-request
events and effective branch rules. Body edits invalidate scans even when the PR
update timestamp did not change. Changed inputs discard stale progress.
Checkpoint digests detect accidental corruption, not malicious forgery: accept
resume data only from the trusted registry/helper, never from a PR comment.
Collection may span wakes, but page verification starts fresh on every resumed
wake; previously verified text can have been edited without changing PR metadata.
Reserve enough of the current wake's request allowance for that complete
verification pass. If it cannot fit even the 40-request maximum, retain incomplete
evidence and request human attention instead of certifying a stale snapshot.

Reads use GraphQL connections and the effective REST branch-rules endpoint.
REST rule pages follow validated next-page links through the same bounded,
resumable scan and fresh consistency pass as GraphQL pages.
No required checks reported is not the same as missing expected checks passing:
expected contexts from branch protection/rules appear with `MISSING/UNKNOWN`.
Unknown review decision/mergeability or unsupported policy requirements prevent
readiness. API access must expose all evidence; permission/unsupported-endpoint
failures are deliberately fail-closed, including on older GitHub Enterprise.
Strict base-update policies require a `CLEAN` GitHub merge state; behind or
unknown status blocks readiness. Required team reviews and GitHub's aggregate
`REVIEW_REQUIRED` decision remain obligations even with a zero general approval count.

`handledSources` entries are `{kind,id,revision,headSha}` from verified dispositions.
Only `addressed` or `already_satisfied` findings belong here; incomplete reply
obligations remain unhandled.
Use the registry finding's `verifiedHeadSha` (or its explicit `publishedCommit`
for an older record) as `headSha`. Suppression applies only when that SHA is the
current PR HEAD; missing or changed verification HEADs require revalidation.
Unmatched source revisions remain input even for the current login or bots.
Persist each successful `snapshot.threadStates` and pass it as `previousThreads`
on the next observation. Entries `{id,stateHash,revision}` keep observed thread
state transitions monotonic: GitHub threads have no edit timestamp, and a
resolved→reopened thread with unchanged text must not reuse an old disposition.
As with all polling, transitions entirely between observations are not observable.
Reuse handled source dispositions only while their code/HEAD verification remains
valid; unexpected external commits require revalidation by the lead/worker.
`knownEffects` entries are:

```text
{effectId, kind, id? or marker?, actor, contentHash}
```

Kinds are `thread_comment`, `discussion`, `review`, `review_request`,
`thread_resolution`, `commit`. Use the exact provider ID or a unique batch marker
(at least 16 characters), expected login (case preserved), and SHA-256 of
canonical exact content/action. No same-login wildcard matching. `contentHash`
is exported for fixture/tool use; canonical JSON sorts keys/array order.
For text effects hash the exact body string; review requests hash
`{reviewerId:<GraphQL node ID>}`; resolution hashes `{threadId,isResolved:true}`;
commit hashes `{oid,message}` and matches the commit author's linked login.
Unknown/unlinked actors cannot settle an effect automatically.

`effects` has `matched`, `ambiguous`, `unobserved`, `remaining`. An ambiguous
match does not consume a source. Unobserved/unknown mutations require receipt
reconciliation, not retries. Review-request events establish actor/ID while
current reviewRequests establish pending recipients. Our request does not change
the external review decision revision. Check keys omit retry/run IDs, and the
actionable fingerprint omits polling times, page order and known effect sources.
Changes in checks/reviews advance obligations independently of comment changes.

GitHub reads are not an atomic provider transaction. Repeated page comparisons
detect observed changes, not every concurrent edit after its last read.
Publication still requires an immediate remote recheck; lost/ambiguous mutations
require settlement. The helper does not classify findings, approve design,
certify model reports, or promise exactly-once remote effects.
