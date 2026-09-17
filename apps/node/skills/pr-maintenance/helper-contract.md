# Helper contract v1

The Node ships `SKILL.md`, this contract, `github-snapshot.mjs`, and offline
evaluation assets and `host-observation.mjs` together in its package-root
`skills/pr-maintenance` directory.
`tsc` builds the Node code, not these already-runnable assets. Lead ACP prompts
advertise their resolved absolute paths, including fallback agents and rollover.
No personal skill installation, new runtime, registry mutation, or token copy.

Execute `node "<absolute path to github-snapshot.mjs>"`. Feed JSON through stdin
using the existing approved command tool's data input or a local JSON evidence
file; never interpolate PR/review text into executable command text.

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
No required checks reported is not the same as missing expected checks passing:
expected contexts from branch protection/rules appear with `MISSING/UNKNOWN`.
Unknown review decision/mergeability or unsupported policy requirements prevent
readiness. API access must expose all evidence; permission/unsupported-endpoint
failures are deliberately fail-closed, including on older GitHub Enterprise.

`handledSources` entries are `{kind,id,revision}` from verified dispositions.
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
