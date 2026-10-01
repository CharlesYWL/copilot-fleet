# Azure DevOps maintenance helper v1

`ado-snapshot.mjs` is a **read-only** sibling of `github-snapshot.mjs`. Ship both
with the shared protocol and the provider-neutral wrapper. No personal skill,
Azure DevOps extension, new dependency, login, enumeration, or mutation is needed.

## Input and execution

Run `node "<package-root>/skills/pr-maintenance/ado-snapshot.mjs"` and send JSON
on stdin through an already-authorized command tool. Never interpolate provider
text into a shell command. Use a separate authorized helper placement, not the
retained maintenance checkout/task, whose independent commands are rejected.

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "pr": {
    "provider": "azure-devops",
    "organization": "example",
    "project": "Project",
    "repo": "Repo",
    "number": 7,
    "projectId": "11111111-1111-4111-8111-111111111111",
    "repositoryId": "22222222-2222-4222-8222-222222222222",
    "repository": "Project/Repo",
    "headRepositoryId": "22222222-2222-4222-8222-222222222222",
    "headRepository": "Project/Repo",
    "headRef": "refs/heads/FixCase",
    "baseRepositoryId": "22222222-2222-4222-8222-222222222222",
    "baseRepository": "Project/Repo",
    "baseRef": "refs/heads/main"
  },
  "budget": {
    "maxRequests": 40,
    "deadlineAt": "2030-01-01T00:00:00.000Z",
    "maxBytes": 262144
  },
  "knownEffects": [],
  "handledSources": [],
  "previousThreads": []
}
```

Use the real remaining deadline; the example date is not a default. Alternatively
replace `organization/project/repo/number` with `url`, a canonical
`https://dev.azure.com/org/Project/_git/Repo/pullrequest/7` or legacy
`https://org.visualstudio.com/[DefaultCollection/]Project/_git/Repo/pullrequest/7`
URL. URL parsing uses the shared `parsePrMaintenanceUrl`; conflicting explicit
fields are rejected. Credentials, alternate ports, non-HTTPS, query/fragment,
invalid path encodings, and unrecognized routes are not accepted.

Discovery may omit pins. Every registered maintenance read must carry **all**
returned project/repository/head/base GUID and display-name/ref pins. Names
preserve case, organization and GUIDs are lowercase, refs are case-sensitive.
`snapshot.identity` is exactly the shared Azure DevOps identity, using
`prNumber`, not `number`; `snapshot.url` is separate.
Same-project forks are supported only when `forkSource.repository.project`
proves the same project GUID and display name, with the exact source ref.
Cross-project or incomplete fork identity is not guessed.

### Proposal identity, not discovery input

`fleet_prepare_pr_maintenance.identity` accepts the complete `snapshot.identity`
unchanged. For independently read fresh metadata, use this same shape (all IDs
and names must be provider-observed, not inferred from this example):

```json
{
  "provider": "azure-devops",
  "host": "dev.azure.com",
  "organization": "example",
  "project": "Project",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "repository": "Project/Repo",
  "repositoryId": "22222222-2222-4222-8222-222222222222",
  "headRepository": "Project/Repo",
  "headRepositoryId": "22222222-2222-4222-8222-222222222222",
  "headRef": "refs/heads/FixCase",
  "baseRepository": "Project/Repo",
  "baseRepositoryId": "22222222-2222-4222-8222-222222222222",
  "baseRef": "refs/heads/main",
  "prNumber": 7
}
```

`project` is the display name, not a GUID. All three repository display names
include the exact case-preserved project prefix; a bare repo name is invalid.
The PR/base repository IDs and names must agree; a proven same-project fork may
have a different head repository. GUIDs/organization normalize to lowercase, not
project/repository display names or refs. Do not include discovery-only
`url`, `repo`, or `number` fields. `prUrl`, `headSha`, actual `observedAt`, method
and evidence are separate proposal fields. Field-specific validation errors
identify a bad pin; reconcile it against provider evidence instead of guessing.

## Authentication and limits

The helper invokes only this built-in Azure CLI command:

```text
az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798
  --query accessToken --output tsv --only-show-errors
```

It never invokes `az repos`, installs extensions, logs in, switches subscriptions,
copies credentials, or creates helper credential files. The existing Azure CLI
identity must already be suitable for the organization. A missing local CLI login
returns `local_auth_unavailable`; an already-authorized independent MCP may read
through the bounded recovery seam. Actual provider HTTP 401 remains `auth_required`
and pauses maintenance for operator reconciliation. No fallback changes credentials.
Token stdout is captured in memory, stderr is never surfaced, and every
diagnostic is fixed/sanitized. The bearer token is used only in Node HTTPS request
headers; it is never part of input, URLs, evidence, errors, continuation, or logs.

On Windows the standard MSI `az.cmd` is discovered on PATH, but **not executed
through a shell**. Its existing sibling `..\python.exe` is launched directly with
`-IBm azure.cli` and fixed arguments, matching the installed CLI launcher. An
installation without that entry point fails `cli_unavailable`; there is no
unsafe `cmd /c` fallback. Unix launches `az` directly with an argument array.
CLI dynamic extension installation and telemetry are disabled for that process.

Each wake has at most 40 attempted operations and 300 seconds (5 minutes).
Each helper invocation still clamps its own run to 120 seconds. Token acquisition
counts as one operation, including failure; fixture transports can inject
`acquireToken` to exercise the same charged authentication seam. Every
initiated HTTP read counts, including failed reads. Each operation is limited to
15 seconds or the remaining deadline, whichever is shorter. No automatic retries.
For a registered finite-command observation, pass the original Host deadline
unchanged. The approved Node runtime supplies the preparation-clock context;
the shared helper clock converts that instant conservatively, reserving the
existing five-second uncertainty and one-second drift bound. Token acquisition,
every GET and completeness use this same basis, including through the direct
ADO CLI. Do not provide offsets or copy runtime environment data. Standalone
discovery uses a Node-local deadline instead and grants no receipt authority.
See [the shared handoff contract](helper-contract.md#durable-evidence-handoff).
Only generated `https://dev.azure.com/<organization>/<project>/_apis/...` GET
URLs are requested. Node HTTPS does not follow redirects, and provider-supplied
links are never followed. Non-success response bodies are not retained.

`maxBytes` is 4096–1048576, default 262144. Input, individual responses,
accumulated checkpoints, and final CLI output are bounded. Normalized arrays and
provider arrays have a 200-item ceiling; all text comments together also fit that
ceiling. Oversize evidence returns incomplete rather than truncating evidence.
Collection `payload_overflow` carries sanitized `error.limit: {kind,stage,actual,maximum}`:
`kind` is `bytes`, `items`, or `depth` (maximum depth 32). The stage distinguishes
input, response, checkpoint, snapshot, observation, output, or continuation.
Item/depth ceilings cannot be raised. For byte overflow, a later authorized
attempt can use a larger `maxBytes` up to 1 MiB and the unchanged returned
continuation, if present. This is not a new request/time budget in the same wake.
If no continuation fits, retain the receipt and use manual evidence or a later
explicitly bounded fresh read; never trim comments/checks to manufacture success.
An entry/authentication failure may only carry code/message; do not assume an
unknown overflow is a recoverable evidence byte limit.

## Output and continuation

Exports:

- `observe(input, {request?, now?, acquireToken?})`: returns the result below **including**
  `observation`; fixture `request({method:"GET",url,timeoutMs,maxBytes})` returns
  `{status,headers?,body}` with object or JSON-text body. It receives no token.
- `runCli()`: reads bounded stdin, writes one JSON object, exits 0 for complete
  collection and 2 for incomplete collection. Exit 0 does **not** mean ready.
- `toAdoHostObservation(result,input,attemptedAt?)`, `contentHash`, `matchEffects`.
  Launcher/transport exports are deterministic-test seams, not worker mutation APIs.

```text
{
  schemaVersion:1, complete, requestsConsumed, elapsedMs,
  progress:{phase,pages,verifiedPages,cursor},
  observation:<PrMaintenanceObservationSchema>,
  snapshot?:{
    identity,url,generation,headSha,baseSha,iteration,state,title,body,
    mergeability,mergeStatus,mergeEvaluation,isDraft,autoComplete,
    threads,threadStates,reviewers,statuses,builds,policies,evaluations,
    checks,reviews,checksComplete,reviewsComplete,
    actionableSources,effects,actionableFingerprint
  },
  error?:{code,message,retryAfterSeconds?,limit?:{kind,stage,actual,maximum},
    diagnostic?:{stage,check,path}}
}
```

Incomplete results never contain a snapshot. Charge their requests/time but
retain the last successful observation. The raw fixture API also exposes
`result.resume`; the CLI removes this duplicate. Pass only
`observation.helperState.resume` back as `resume`, and persist
`observation.helperState.previousThreads`. Write `observation` directly to the
Host checkpoint; do not translate it using the GitHub-only adapter.
Byte accounting counts that continuation **once** in the actual serialized output,
not the raw API alias as well. A genuine snapshot/output byte overflow may also
retain a last-safe scan; any resumed attempt still repeats full verification.
If discovery has no registration, retain the incomplete receipt and continuation
in existing execution/task evidence, not a fabricated recordId checkpoint.
Fresh exact metadata from an independently authorized provider read may support
an unapproved **repair proposal** only with verified existing task and publication
authority. Observation-only enrollment is unsupported. Metadata alone cannot
establish checks/reviews completeness, triage or readiness, enable repair, or
clear access/design holds. Approval remains the authenticated operator's
separate action; registered recovery requires its existing claimed visit.

**Collection completeness is separate from readiness completeness.**
`complete:true` means exact identity/current refs, all bounded feedback and policy
API data, and the full stable second pass were verified. Unsupported or
unverifiable policy semantics do not discard that collected feedback:
`checksComplete:false` and/or `reviewsComplete:false` prevent automatic ready
while retaining comments, required voters, negative votes, pending/failed policy
obligations, and independently proven CI failure sources for bounded local triage.
The Host may prepare a repair batch from this complete observation, but requires
**both** readiness flags, passing obligations, and its other normal gates for ready.

Unknown policy types/settings/applicability clear **both** readiness flags. A
known build/status/comment evidence gap clears `checksComplete`; a known review
evidence gap clears `reviewsComplete`. These flags also live in the snapshot and
participate in its fingerprint. They are never inferred from raw approval counts.
This is not an exception fallback: actual authentication, permission, retrieval,
pagination, malformed data, PR/fork identity, current-source mismatch, ambiguous
effects, or second-pass inconsistency still produce `complete:false`, no snapshot,
and no triage.

Continuations are digest-checked and scoped to identity input, generation,
effects, handled sources, and previous thread states. They contain no executable
URL or credential. Digests detect corruption, **not malicious forgery**:
continuations are trusted registry/helper data, never PR text.
Every resumed wake rereads PR metadata. Previously verified pages receive **no
verification credit**: a full fresh pass rereads every collected page, the complete
thread/comment collection, evaluations, configurations, build, status, iteration,
and branch refs, then rereads PR metadata again. Edits invalidate the scan even if
PR metadata timestamps do not change. Verification starts only if the complete
pass fits this wake's remaining request allowance.

Collection may span wakes. If all verification pages plus metadata/token reads
cannot fit even a 40-operation wake, manual evidence is required; increasing
automation attempts cannot make this a complete snapshot. Ref continuation
tokens are encoded as query data and scoped to that exact ref/repository.
Evaluations use documented `$top=100`/`$skip` pages and probe the next page after
a full page. Endpoints documented as “all” collections have no invented
pagination: unexpected continuation/link/truncation signals fail closed.

The [REST 7.1 threads list contract](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1)
retrieves **all** threads; `GitPullRequestCommentThread.comments` contains the initial
comment and subsequent replies. There is no documented comment-preview or threads
pagination parameter. Both passes read this unfiltered list (not only active
threads), validating every comment ID/type/revision/body and thread state. They do
not issue an additional comments request per thread. Missing arrays, duplicate
IDs, unexpected continuation, overflow or a changed second pass fail closed.
The total comments across threads still has the 200-item limit.

A fixture with 40 mixed-state threads and 80 comments takes 19 initiated operations:
one token acquisition, two metadata reads, and eight collection reads on each
pass. Builds and documented ref/evaluation pages can increase that count; 39
operations remain the normal repair allowance and 40 operations/300 seconds the wake bounds.
New continuations carry `collectionVersion: 2`. Old per-thread continuations are
preserved as historical evidence but rejected as `invalid_resume`, never given
verification credit or converted to a write grant. A later authorized fresh
collection must use its actual remaining budget/deadline; do not repeatedly replay
an incompatible continuation or reset the allowance.

Failures distinguish auth, permission, rate limiting, network/timeouts, request
or deadline exhaustion, invalid input/resume, changed scope, changed/stale
evidence, overflow, unsupported pagination/policy API, and
ambiguous effects. Host failures map to `auth`, `permission`, `rate_limit`,
`network`, `capability`, `budget`, or `incomplete`; local CLI/login limitations map to `capability`,
not a false provider access denial. The exact sanitized error code/message remain
in `helperState.error`, together with bounded resume state, for recovery classification.
No error embeds raw CLI/API output.

Every `malformed_response` includes `error.diagnostic: {stage,check,path}`, also
preserved unchanged in `observation.helperState.error`. `stage` is `response`
or `snapshot`; `check` is a helper-owned stable identifier, such as
`status.state`, `evaluation.artifact_id`, `evaluation.fields`, `comment.fields`
or `list.envelope`. `path` uses only helper-owned schema names and numeric array
indices/IDs, for example `iterationStatuses[0].state` or
`evaluations[0].artifactId`. Composite checks identify the containing object.
Unclassified malformed evidence uses
`{stage:"response",check:"required_evidence",path:"$"}`. Diagnostics never include
provider values, arbitrary property names, PR text, identities, URLs, tokens,
exception messages or validator issue paths. This additive field changes neither
exit 2 nor the error code/message, failure mapping, receipt or checkpoint shape.
For `fallback.error`, keep the string `"code: message"`; do not pass the error object.

## Evidence and deliberate limitations

Active PRs require iteration support. The highest iteration supplies the source
SHA; the exact live source ref must match it. `iteration.targetRefCommit` remains
the historical target of that source iteration: target-only advances need not
create another iteration. `baseSha` is instead the exact current live target SHA.
`mergeEvaluation` preserves `{sourceSha,targetSha,mergeSha,current}` from the PR
merge fields. If `lastMergeSourceCommit`/`lastMergeTargetCommit` do not match the
current source/live target, feedback remains complete and actionable, but an
explicit pending merge-evaluation guard and unknown mergeability prevent ready.
After provider merge reevaluation catches up, the historical iteration target
may still differ from `baseSha`; that difference alone is not an error.
`mergeStatus=succeeded` alone is not readiness. Current conflicts remain
conflicting; other states are unknown.
Draft, auto-complete, queued completion, and bypass-policy intent create a pending
lifecycle guard. Completed/abandoned PRs are double-read terminal observations;
terminal settlement does not require a deleted source branch or historical
policies to remain readable.

The [status state contract](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/list?view=azure-devops-rest-7.1#gitstatusstate)
defines `notSet` as the default. Native REST may omit `state` for that default.
After full page verification, only an omitted `state` becomes `notSet` in PR and
iteration statuses. Current iteration `notSet` remains an **unknown** obligation,
never success or a repair source. Explicit null, numeric or unrecognized states,
missing IDs/contexts/dates, and changed second-pass evidence still fail closed.

The hierarchy-aware effective configuration endpoint uses repository and base
ref filters, including applicable inherited project policies. It is **not** the
legacy `policy/configurations?scope=...` query. Readiness for an enabled returned
policy requires a matching evaluation and exact config settings/type/revision.
Every retrieved evaluation must identify the exact project GUID and PR number in
`vstfs:///CodeReview/CodeReviewId/{projectGuid}/{PRid}`. Native REST also returns
the GUID/PR separator as `%2F` (or `%2f`); only that separator may be encoded.
Other escaping, double encoding, extra components and different project/PR pins
are rejected, not broadly URL-decoded. The PR's
different `vstfs:///Git/PullRequestId/...` artifact is never used for evaluations.
To contribute readiness proof, terminal evaluation timestamps must be no earlier
than the current iteration's updated time and no later than observation time.
Missing/stale proof lowers the appropriate readiness flag; malformed records or
an artifact identifying a different PR still invalidate collection.

Recognized policy types and readiness limits:

- **Build validation (diagnostics, not approval):** if a positive `context.buildId`
  hint is present, independently read that build and verify
  same project, configured definition, TfsGit repository, queue freshness, and
  either exact source repository/ref/SHA or exact base repository PR merge
  ref/SHA (`lastMergeCommit`) while source/target pins remain current. This is
  diagnostic evidence only: **build policies leave `checksComplete:false` even
  when the build succeeded on the exact current HEAD/merge commit**. The public
  evaluation schema does not define `context.buildId` or its binding semantics.
  A supported, independently verified policy-to-build contract is required before
  enabling build-policy readiness. Pending/rejected decisions remain obligations.
  A rejected evaluation plus independently validated current build
  source/ref/definition/queue evidence and a completed failing result can produce
  a precise CI repair source; the opaque hint never certifies policy freshness.
- **Status checks:** require exact name/genre, configured author GUID when set,
  reset-on-source-update enabled, and the latest unambiguous current-iteration
  status. Approval requires succeeded status with fresh timestamps and evaluation
  completed after the status. Missing proof sets `checksComplete:false` without
  losing feedback. A whole-PR status is not current-HEAD proof.
- **Comment resolution:** approval additionally requires all live text threads
  resolved in the complete discussion evidence; otherwise the check remains
  unknown and `checksComplete:false` while unresolved comments remain actionable.
- **Minimum/required reviewers:** queued/rejected/running decisions are preserved
  as policy obligations. Raw votes remain `10`, `5`, `0`, `-5`, `-10`; required
  voters and negative votes remain obligations. **Approved reviewer-policy
  evaluations leave `reviewsComplete:false`:** public `IdentityRefWithVote` has no commit identity,
  and evaluation `context` is documented only as opaque internal data. Neither
  positive vote counts, reset settings, dates, nor a guessed `context.iterationId`
  certify a current-HEAD review. Independently validated provider evidence is
  needed before extending this limitation.

Unknown enabled policies (even optional approved ones), unknown settings, and
unknown applicability/policy exemptions (`notApplicable`) clear **both** readiness
flags. Missing evaluations and stale config revisions clear the relevant known
policy category's readiness flag. All remain visible in collected evidence.
This helper does not invent path-filter applicability, work-item/merge-strategy
policy proofs, group membership, or an unknown-policy approval bypass. Readiness
on such PRs requires human reconciliation or a reviewed provider extension.
These conservative limits inhibit auto-ready, **not bounded local triage when
collection is complete**. Automated readiness is limited to PRs with no
unproven policy requirement, including the independently verified status/comment
policies above, and with no
remaining required voters, negative votes, lifecycle guards, or actionable sources.

Each text comment uses provider ID `<threadId>:<commentId>`, exact body hash,
author GUID (never display name/email), parent ID, edit dates, and a source
revision. Thread status/context transitions increment persisted
`{id,stateHash,revision}` monotonically: observed resolve→reopen cannot reuse an
old disposition even with unchanged text. Entire transitions between polls
remain unobservable.

`handledSources` entries are `{kind:"thread_comment",id,revision,headSha}`.
Suppress only exactly matching revisions verified on current HEAD, never stale
or missing HEAD verification. Comments are grouped in their original threads.

`knownEffects` retain the existing `{effectId,kind,id? or marker?,actor,contentHash}`
shape. The only automatically matched ADO kind is `thread_comment`. Matching
requires the exact provider ID, or a unique marker of at least 16 characters,
**plus** exact author GUID and exact canonical body hash. Both receipt→comment
and comment→receipt must be one-to-one. Unknown push, vote/reviewer change, and
resolution effects stay `unobserved`; no action actor is invented from comment
authors or current PR state. Ambiguity is incomplete, not permission to retry.
Failed build-policy and current-iteration status checks produce actionable CI
sources whose revision excludes transient run/status IDs and polling times.
The latest non-policy `pending` status remains a pending check; `notSet` remains
an unknown check. Neither can yield ready or create a repair source.
Status aggregation and failure source IDs use
`contentHash(JSON.stringify([genre ?? "", name]))`, not slash-joined names or a
direct array hash. The encoded tuple preserves field order and embedded slashes;
hashed source IDs stay within 512 characters even for long provider contexts.

Reads are not an atomic Azure DevOps transaction. Double reads detect observed
changes, not all changes after the last read. Recheck remotely immediately before
any separately authorized worker publication.

## Worker publication boundary

This helper never mutates. Any repair stays with the existing retained worker and
its authorized scope and budget:

1. Verify remote project/repository GUIDs, exact **registered head repository**
   and case-sensitive **full head ref**, current HEAD, and baseline. For a
   same-project fork do not substitute the target repository.
2. After tests and a committed repair, use ordinary Git with an explicit pinned
   remote and destination, e.g. `git push -- <registered-head-remote>
HEAD:refs/heads/FixCase`. The ref is the actual registered ref, not a guessed
   example. Never force-push, use a wildcard, or change the upstream to bypass
   the pin. An external update requires reconciliation.
3. Use an existing authorized provider tool **after discovering its live
   schema**, or an explicitly authorized REST write facility. An ADO reply
   belongs to the original thread:
   `POST .../repositories/{baseRepositoryId}/pullRequests/{PRid}/threads/{threadId}/comments?api-version=7.1`
   with JSON `{content:<exact reply>,parentCommentId:<original comment ID>,commentType:1}`.
   Do not create a new top-level thread or a disconnected PR comment.
4. Read back the reply ID/author/content and record its receipt. Resolve the
   original thread only after verified repair/evidence and the required reply
   are visible, with separate authorization and readback. A current resolved
   state alone cannot prove this worker performed the resolution.
5. Never approve/set reviewer votes, merge, set auto-complete, bypass policies,
   force-push, install tooling, or log in as part of maintenance. Unknown write
   outcomes require settlement, not blind retries.

## Public sources verified for this implementation

- [Azure CLI Entra token flow and resource ID](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens)
  and local Azure CLI 2.89 `az account get-access-token --help`; installed Windows
  MSI `az.cmd` was inspected without authentication.
- [PR get and fork/vote/merge schemas](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1),
  [iterations](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1),
  [refs](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/refs/list?view=azure-devops-rest-7.1).
- [Threads](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1),
  [all thread comments](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/list?view=azure-devops-rest-7.1),
  [reply request schema](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1).
- [Effective Git policy configurations (documented 5.0-preview.1)](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/policy-configurations/list?view=azure-devops-rest-5.0),
  [why legacy scope filtering is insufficient](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/configurations/list?view=azure-devops-rest-7.1),
  [evaluation artifact, paging, and opaque context](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1).
- [Build get](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/get?view=azure-devops-rest-7.1),
  [PR statuses](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/list?view=azure-devops-rest-7.1),
  [iteration statuses](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-statuses/list?view=azure-devops-rest-7.1),
  [status freshness/author/reset semantics](https://learn.microsoft.com/en-us/azure/devops/repos/git/pull-request-status).
- Public Microsoft provider [policy type GUIDs](https://github.com/microsoft/terraform-provider-azuredevops/blob/main/azuredevops/internal/service/policy/branch/common.go)
  and [status settings wire names](https://github.com/microsoft/terraform-provider-azuredevops/blob/main/azuredevops/internal/service/policy/branch/resource_branchpolicy_status_check.go);
  [Azure CLI extension policy settings](https://github.com/Azure/azure-devops-cli-extension/blob/master/azure-devops/azext_devops/dev/repos/policy.py)
  were consulted as public schema evidence, **not installed or invoked**.

No live/internal Azure DevOps probe, enumeration, or mutation was used to develop
or test this helper. `apps/node/src/pr-maintenance-ado.test.ts` uses synthetic
deterministic transports and fake subprocesses; it needs neither az nor auth.
