---
filepath: "docs/superpowers/specs/2026-09-17-pr-maintenance-mode.md"
tags:
  - copilot-fleet
  - pr-maintenance
  - human-design-decisions
---

# PR maintenance mode

**Area**: Orchestrator, task continuity, and PR follow-up<br>
**Engineer**: Not assigned<br>
**EM owner**: Not assigned<br>
**Architect**: Human owner; not assigned<br>
**Program Manager**: Not assigned<br>
**Status**: Revised proposal for independent review; no product implementation<br>
**Revision**: 2026-09-18, incorporating seven Opus execution/efficiency amendments<br>
**Reviewed document**: `829e3e2be5388972f27d642db161dca9a7798aea`; this revision is documentation only<br>
**Source baseline**: `c5a5eb8095e58a7fb395f9703076fd371d7eac0a` on `origin/main`; relevant local source also inspected at `8891c25db96e2531559eb2488163dbaaeef9a14f` plus in-progress changes<br>
**Work item**: Not supplied

## Related documents

| **Document** | **Link** |
| --- | --- |
| **Feature Lifecycle Process** | Independent design review before implementation. The [template's Fabric lifecycle](https://dev.azure.com/powerbi/AI/_wiki/wikis/AI.wiki/90809/Feature-Lifecycle-Process) is background, not a deployment requirement for Fleet. |
| **PM Functional spec** | User request: maintain PRs through review/fix rounds; automate local nits, edge cases, and security repairs; retain human authority over architecture/design changes. |
| **UX Design** | Reuse task approval/escalation and status surfaces. No separate maintenance dashboard or per-comment approval system in v1. |
| Existing orchestration | [Architecture](../../../ARCHITECTURE.md), [lifecycle](../../orchestration-lifecycle.md), [orchestrator instructions](../../../apps/node/agents/fleet-orchestrator.agent.md) |
| Workspace and execution constraints | [Managed worktrees](../../managed-worktree-isolation.md), [remote command execution](../../remote-command-execution-plan.md) |
| Policy precedent | Ponytail: reuse existing mechanisms and make the smallest sufficient repair. Installed Agent Merge is a conceptual precedent, not a Fleet dependency. |

**This revision supersedes the earlier dedicated-observer/controller proposal.**
Use the existing Orchestrator wake mechanism, a maintenance skill, a bounded
GitHub helper script, and durable records exposed by the existing Fleet MCP
server. Do not build a second scheduler or a direct-to-worker automation path.
Some inspected command/permission code is still in progress; verify prerequisites
on the implementation branch rather than assuming they are released.

## Feature desired outcome

After explicit enablement, the Orchestrator remembers the PR, task, worker,
authorization, feedback progress, and pending decisions across compaction and
restart. On its existing wakes it checks due PRs and continues the original
eligible worker until the PR is merged, closed, or maintenance is paused.

**CF stores durable facts. The helper reads GitHub. The Orchestrator decides
and dispatches. The worker repairs. The human approves design changes.**

The primary quality bar is correct delegation and human gating, not maximum
comment throughput. Proposed skill eval: at least 30 versioned scenarios,
covering local repairs, mandatory design decisions, and duplicate/adversarial/
lifecycle cases, with three repetitions on each supported model configuration.
Require all mandatory design cases escalated, zero unauthorized design changes
or remote actions in the eval, and at least 90% of independently repairable cases
completed without human forwarding. These are proposed thresholds, not measured
results or a proof about arbitrary model behavior.

| ID | Observable outcome |
| --- | --- |
| AC-01 | Mixed local nits, edge cases, and local security defects are repaired and answered by the existing eligible worker without per-comment approval. |
| AC-02 | A design change or uncertainty pauses repairs for the whole PR and reaches the existing human escalation workflow before that change is implemented. |
| AC-03 | Compaction/restart does not lose PR ownership, pending batches, dispositions, budgets, or human holds; the next lead turn rediscovers them through MCP. |
| AC-04 | Unchanged feedback creates no worker repair turn or duplicate reply. Lead heartbeat/script cost is expected, not claimed to be zero. |
| AC-05 | An active maintenance record keeps its lead eligible for existing reminders after the implementation task finishes, without automatically reopening or writing to that task. |
| AC-06 | Busy/queued/offline workers, uncertain effects, incomplete observations, and stale bindings cause waiting/reconciliation, not replacement work or fabricated success. |
| AC-07 | Local repairs never bypass human decisions, existing execution permissions, publication rules, or immutable managed-result boundaries. |
| AC-08 | Ready-to-merge remains nonterminal; observed merge/closure stops new work, but ownership remains reserved until accepted work/effects settle. Explicit pauses remain paused. |
| AC-09 | Review/check/mergeability changes advance the loop even without new comments; known self-authored effects never trigger another acknowledgement or repair by themselves. |
| AC-10 | Registrations sharing a remote head ref cannot write concurrently; automatic inactivity cleanup cannot remove required maintenance continuity. |
| AC-11 | Per-wake work and non-repair activity are bounded, and persisted oldest-due progress prevents a repeatedly changing/failing PR from starving the rest. |

Measure repair success, escalation correctness, repeated findings, duplicate
dispatches/effects, lead-check cost, waiting time, and compaction recovery.
Do not equate "all threads resolved" with a correct or approved change.

## Terminologies <!-- optional -->

**Maintenance record**: one Host DB registration for a specific PR, owned by an
existing Orchestrator and linked to a task and worker. It is not another session.

**Local repair**: restores an established requirement/invariant or makes a
small, consistent cleanup without changing the approved design or contract.

**Design decision**: changes public behavior/contracts, responsibilities,
dependencies, persistence, trust boundaries, or operating policy. Line count and
reviewer severity labels do not determine whether something is a design decision.

**Batch**: a coherent set of feedback revisions assigned to one worker turn.
Observed, dispatched, and addressed are distinct facts.

**Heartbeat**: the existing approximately 30-minute idle-lead reminder, not a
strict recurring polling SLA or a permanently running agent.

## Design options considered

| Option | Benefit | Cost / limitation | Decision |
| --- | --- | --- | --- |
| Prompt plus conversation memory | Almost no implementation | Compaction loses ownership and prior dispositions | Reject |
| Skill/helper plus local checkpoint file | Simple prototype | Authoritative state lives outside existing task DB/MCP discovery | Superseded by the user's DB-backed choice |
| Existing heartbeat + skill/helper + DB-backed Fleet MCP | Reuses planning, dispatch, approval, and persistence; survives compaction | Lead tokens for checks; small eligibility/state integration needed | Preferred v1 |
| Dedicated non-model observer and maintenance controller | Faster independent polling; unchanged state can avoid lead wakes | New scheduling, worker admission, provider effects, and lifecycle surfaces | Defer until latency/cost/scale justify it |
| New agent per PR or feedback round | Superficially easy orchestration | Loses context and amplifies reviews/cost | Reject |

V1 is Orchestrator-led. Automatic standalone-session scheduling, new observer
sessions, webhooks, provider plug-in frameworks, automatic merge, granular
per-thread approval UI, and new managed-workspace continuation machinery are
out of scope. A standalone worker would first need an explicit, supported
ownership handoff; merely storing its ID does not make it an owned Run worker.

## Preferred option

### 1. Roles and the smallest execution loop

| Component | Responsibility |
| --- | --- |
| Existing CF Host/Node harness | Store records, scope MCP access, wake the existing lead, and enforce current session/task admission and execution permissions. It does not interpret GitHub feedback or independently poll GitHub. |
| Existing Orchestrator | Read the registry on each wake, run the helper when due, triage feedback, checkpoint progress, call `fleet_follow_up`, and escalate decisions. |
| GitHub helper script | Perform a bounded read using an already authorized Node identity; return structured PR/review/check facts. It is not a session, background process, or scheduler. |
| Existing coding worker | Inspect code, confirm the local/design boundary, implement and verify authorized repairs, and publish/reply through existing permitted tools. |
| Human | Enable bounded maintenance, decide design changes, renew exhausted budgets, and control pause/resume. |

On a heartbeat, user turn, or normal worker-result wake:

1. Read active/due records and unfinished checkpoints through MCP, including
   records whose original task is completed or held. Continue the persisted
   oldest-due scan within the per-wake allowance. Reconcile accepted work before
   considering a new batch.
2. Run the helper for due PRs that are not paused. Persist a complete observation
   separately from dispatch/repair completion. Evaluate comments, review
   obligations, checks, and mergeability, not just whether new comments exist.
3. Read `fleet_get_task` for the bound task's current continuation guidance.
   Worker `idle` alone is not an authorization or eligibility check.
4. Group related feedback into one batch. Checkpoint its identity, source
   revisions, observed HEAD, scope, and exact intended follow-up prompt.
5. Call existing `fleet_follow_up` for an eligible retained worker. Queued means
   accepted; do not resend with a different prompt or replace a busy worker.
6. End the lead turn. On the existing completion wake, reconcile per-finding
   and remote-effect outcomes; a finished worker turn is not a completed batch.
7. Repeat on later wakes. Do not request another full reviewer merely because
   the worker repaired feedback. Stop routine work on confirmed merge/closure.

The lead remains in this loop; routine maintenance is not routed around it.
One lead can maintain several PRs, but each PR has one worker and at most one
outstanding batch.

#### Observation -> action -> next wake

Evaluate terminal/human/ownership gates first. The other rows describe separate
obligations: pending CI does not erase actionable feedback, and resolved threads
do not satisfy a still-outstanding changes-requested review.

| Observation | Permitted next action | Next wake / deduplication |
| --- | --- | --- |
| PR merged/closed, including while a batch is queued/running | Inhibit execution, request targeted cancellation, and reconcile effects under section 3.1. No new repair/review requests. | Existing cancellation/completion receipts or bounded reconciliation on an existing lead wake; retain ownership while unsettled. |
| Human hold, unknown binding, or incomplete snapshot | Keep the hold; explain the specific blocker. No repair or readiness claim. | Recorded human direction, eligibility reconciliation, or bounded read retry; unchanged blockers notify once. |
| Initial review required but absent | Consume existing external review; if specifically authorized, request the configured reviewer. Otherwise notify the human once. | New review state or next due observation; one action per review obligation key. |
| New actionable feedback or PR-caused CI failure without comments | Triage against the approved design and dispatch one eligible batch; escalate design-impacting changes. | Worker result plus current-HEAD observation. CI failure identity survives reruns of the same failing check. |
| Required checks pending/not yet reported | Wait; do not make an empty repair commit or assume missing means passing. | Next due observation or worker-result reconciliation. |
| Transient infrastructure failure | Use the existing authorized retry once per HEAD/check failure incident; otherwise notify/pause. Do not disable checks. | Retry result or next due observation; a new retry attempt ID does not reset the incident budget. |
| A push dismissed approval, required re-review is missing, or reviewer still requests changes after fixes | Request a targeted re-review of the repair from the configured reviewer when authorized; otherwise notify the human once. Never dismiss the review or launch an extra review agent to clear the gate. | Genuine reviewer decision/policy-obligation change or next due observation; pending request is not sent again. |
| Conflict, changed head/base ref, or materially stale validation | Block publication/readiness and request a bounded human resolution; no automatic rebase/force-push. | Authorized resolution and fresh HEAD/base/check evidence. |
| All current feedback dispositions, required checks/reviews, and mergeability permit readiness | Record ready and notify once. Keep observing; v1 does not merge. | Next due observation; a new external blocker invalidates readiness. |

**Review policy:** v1 consumes externally generated reviews and may request an
initial or targeted re-review from reviewers explicitly configured and authorized
at enablement. Without that grant it is external-review-only plus human
notification. Never choose new reviewers, start a paid/internal review-agent
session, or add a blanket full-review stage automatically.

Persist a review obligation key containing PR generation, relevant HEAD,
reviewer/requirement identity, and the external decision or requirement revision
that created the obligation. Reconcile pending requests and lost responses before
retrying. Our request/notification cannot create a new obligation revision; a
genuine reviewer reply or policy change can. Readiness and blocker notifications
are likewise keyed to substantive state, not poll time.

### 2. Enablement, ownership, and MCP

Extend the existing scoped Fleet MCP server. The following names are proposed,
not currently implemented APIs:

| Proposed tool | Contract |
| --- | --- |
| `fleet_set_pr_maintenance` | Enable/pause/resume, or explicitly release, an owned registration against a stable task/worker and recorded operator authorization. Repeated enablement is idempotent; release requires settled work and cannot clear a hold without recorded operator disposition. |
| `fleet_get_pr_maintenance` | List this lead's registrations with bounded/paginated summaries, or read one record's complete checkpoint by ID. Due-work discovery includes paused/terminal records requiring settlement; other history is optional. Never silently truncate due work. |
| `fleet_checkpoint_pr_maintenance` | Record an observation, prepared batch, dispatch reconciliation, verified disposition, or terminal observation with optimistic version checks. It cannot create approvals, change ownership, or broaden scope. |

Derive the lead principal from the existing MCP authentication, not an input
`orchestratorId`. Validate task ownership, worker-to-task membership, exact PR
identity, and current checkout eligibility. Maintain three DB uniqueness
constraints while `ownershipReleasedAt` is null:

- GitHub host + stable PR repository identity + PR number.
- GitHub host + stable **head repository ID + full head ref**.
- Bound worker session ID.

The head-ref constraint rejects two different PRs targeting different bases from
the same source branch, even if they use different workers/checkouts. Canonicalize
host/repository identity, but preserve Git ref case and the full `refs/heads/...`
name. Display names, URLs, and physical checkout locks are not substitutes.
One lead can own many PRs, not competing registrations for the same remote ref.

Paused registrations and terminal registrations with unsettled work still own
these keys. Another lead receives an ownership conflict, never silent adoption.
Release occurs only under section 3.1 or explicit operator abandonment after
settlement. Re-enablement after release uses a new generation and revalidates
all keys, authority, and binding. This coordinates Fleet registrations in this
Host, not arbitrary external Git writers or independently deployed Hosts.

Enablement must trace to an authenticated operator action for the exact PR and
scope. Reuse the task approval surface to capture this bounded maintenance
authorization; MCP may prepare registration but cannot fabricate an actor or
enable it merely by setting an `approved` field. Reuse the same authenticated
action for scope/budget renewal. This is a small task-action integration, not a
new per-comment approval product.

The grant covers agreed verification, local repairs, commits, pushes to the
named PR head ref, appropriate replies/resolution, and optionally requests to
the named configured reviewers. It excludes force-push,
destructive Git operations, deployments, changed credentials/access, new
dependencies/designs, and merge. Existing ACP/Node permissions still apply:
maintenance never silently switches the session to unrestricted execution.

Resolve head/base repositories and refs explicitly; `origin` is not necessarily
the PR's head repository. Seed criteria/design boundaries from the existing
task and show a short confirmation summary rather than requiring a new spec.
Unknown baseline or authority blocks enablement.

### 3. The database is the memory, not another controller

Use existing Host SQLite transactions, schema validation, and backup patterns.
Keep an authoritative maintenance row and bounded checkpoint data; use child
records for feedback/batches when necessary, not an append-only transcript blob.

| Facts | Minimum persisted content |
| --- | --- |
| Identity / binding | Record ID/version; GitHub host/repository/PR; head/base repositories and refs; lead ID; task ID; worker session ID; eligible placement/checkout identity |
| Authority / lifecycle | Operator approval reference; generation/policy version and scope; `active`, `paused`, `merged`, or `closed`; pause reason/time; pending human decision; `ownershipReleasedAt` and retention-release decision |
| Observation | Last attempt/success and next-check times; snapshot identity/HEAD; actionable fingerprint; check/review obligations; known self-effect IDs; incomplete scan cursor; failure counters and evidence reference |
| Feedback checkpoint | Stable source IDs/revisions, underlying finding group, current disposition, verification/repair commit, response IDs, and unresolved decisions |
| Batch checkpoint | Stable batch ID/generation; source revisions; base HEAD; exact prompt; state from section 3.1; per-finding outcome/stage; cancellation/supersession reason; known/unknown effects; worker step/attempt references and reserved action allowance |
| Lead action checkpoint | Intended review-request/notification/retry key, allowed recipient/HEAD, reserved allowance, tool evidence, and known/uncertain result; lead actions with no worker batch still participate in settlement |
| Lead scan checkpoint | Existing lead wake/turn ID, due-scan cutoff/page/cursor, carried unserved IDs, and consumed PR/request/time allowance; pagination or compaction cannot reset it |

Distinguish last attempt from last successful check: a timeout must not advance
the successful observation or consume feedback. Retain the checkpoints needed
for unfinished items across compaction; resolved historical detail can remain
in GitHub/task evidence with stable references. Apply explicit bounds and return
an actionable overflow error rather than forgetting old pending work.

Checkpoint updates use a record version and stable batch key. Extend
`fleet_follow_up` with an optional maintenance record/batch reference so its
existing transaction can bind the accepted step/attempt to the prepared batch.
This is a narrow atomicity/authorization hook, not a new dispatch queue. A
normal follow-up without that reference must not bypass a paused registration,
pending human gate, or retained resource reservation. Apply the shared admission
rule in section 5.1 rather than implementing this check only in `follow_up`.

If a tool response is lost, read the record and current RunStep/attempt before
retrying. A prepared batch with no accepted attempt is not an addressed batch.
Never reconstruct a missing prompt differently and assume it is the same request.
Keep accepted-but-uncertain work pending until existing execution evidence
establishes what happened or the operator resolves the uncertainty.

Workers do not receive new registry or orchestration tools. The lead writes
checkpoints from worker reports and available tool/provider evidence. This DB
does not independently certify a model's claims or provide transactional
exactly-once GitHub effects. Unknown push/reply outcomes require reobservation;
if receipts/current provider state do not establish them, pause rather than
blindly repeat. Preserve existing tool history and batch markers as evidence.

#### 3.1 Batch settlement and terminal-PR races

One outstanding batch means one batch in `prepared`, `accepted`, `reconciling`,
or `uncertain`. Registration lifecycle and batch settlement are independent.

| Batch state | Meaning / transitions | Releases the outstanding-batch constraint? |
| --- | --- | --- |
| `prepared` | Exact input reserved, not yet accepted by worker dispatch. Moves to `accepted`, or to known `failed`, `cancelled`, or `superseded` before execution. | No |
| `accepted` | Existing queued/starting/running attempt recorded. On completion/cancellation receipt, move to `reconciling`; missing/ambiguous evidence moves to `uncertain`. | No |
| `reconciling` | Evaluate every assigned finding and effect after the attempt settles. A worker's "done" message alone cannot finalize it. | No |
| `uncertain` | Execution/effect outcome unknown. Reconcile back through known evidence; no time-based assumption of success or cancellation. | No |
| `succeeded` | All findings are evidenced `addressed`/`already_satisfied`, required responses are known, and execution/effects are settled. | Yes |
| `partial` | Some findings completed; remaining findings/stages and known next actions are explicitly recorded. No execution/effect remains unknown. | Yes, but a human hold or publication blocker still prevents another batch |
| `failed` | Known unsuccessful outcome; preserve any verified intermediate work and per-finding results. | Yes, only after settlement; retry requires eligibility and budget |
| `cancelled` | Cancellation confirmed or dispatch demonstrably never accepted; accepted effects are reconciled, not rolled back by assertion. | Yes, only after settlement |
| `superseded` | Inputs/HEAD changed so the batch is no longer applicable; it never ran, or its old attempt/effects have been settled first. | Yes, only after settlement |

Each assigned finding has an outcome: `addressed`, `already_satisfied`,
`needs_human`, `failed`, `superseded`, or `incomplete` (including not attempted).
Keep its last verified stage, repair/published commit, response obligations and
IDs, and next action. A pushed fix whose reply failed is `incomplete` at the
reply stage, not an instruction to reimplement the fix. Only evidenced
`addressed`/`already_satisfied` outcomes count as completed findings.
Cancelling/superseding a batch does not erase its partial effects or convert
unattempted findings into addressed ones.

On an observed PR closure/merge, atomically record terminal lifecycle, inhibit
new maintenance admission, and mark the outstanding batch cancellation-requested.
The existing scheduler rechecks this gate before start/resume/prompt, so a
previously accepted queued step cannot start from a stale snapshot. Request
cancellation only for the bound in-flight work; reconcile already accepted
pushes/replies and late receipts. Terminal state is not proof of quiescence.

Keep PR/head-ref/worker ownership and retention protection while that batch or
any authorized effect is unsettled. Existing completion/cancellation delivery
and bounded reconciliation-only lead wakes may settle it even though routine
maintenance is terminal/paused. If reconciliation cannot establish the outcome,
retain the reservation and notify the operator; do not release it on a timeout.
No repair/review request is permitted during this draining phase.

Once terminal work is settled and no hold/effect requires reconciliation, release
ownership transactionally and retain history. Reopening the PR does not resurrect
the old worker attempt: explicit re-enablement creates a new generation, after
old reservations are released and current HEAD/binding are checked. Delayed old
receipts may update the old history but cannot mutate or release a newer generation.
A design question made moot by verified PR closure can be recorded as withdrawn,
never approved or fixed; preserve its review history rather than completing an
unrelated task or silently declaring its criteria met.

### 4. Compaction, heartbeat, and task lifecycle

Put a permanent instruction in the Orchestrator agent/briefing and wake prompt:

> Read your PR-maintenance registrations on each wake. Reconcile unfinished
> batches, inspect due active PRs, honor paused/human-held work, and continue
> only eligible workers. The registry, not conversation memory, is authoritative.

The current `remindIdleLeads` excludes completed, blocked, and human-held tasks
and requires 30 minutes since the lead's latest activity/automated prompt.
Add leads with **active maintenance records** to reminder eligibility, even
when their implementation task would otherwise be excluded. Include only
compact record IDs/counts in the wake; the skill reads actual state through MCP.
Use the existing single-prompt reservation/delivery path and existing precedence
for user/task messages. Do not add another timer or prompt producer.

Normal lead wakes also check persisted due times, so unrelated activity does
not continually postpone every PR check until a full idle interval occurs.
A long-running/busy lead or offline Node can still delay work. V1 accepts this
best-effort cadence; it does not promise checks exactly every 30 minutes.
Records draining an unsettled batch can request reconciliation-only eligibility,
subject to the same wake budget and stop-on-uncertainty policy, not a new timer.

Registration and task state remain separate. An active record is a reason to
inspect, not permission to reopen an `awaiting_human` task or resume a stopped
worker. A completed compatible task may be explicitly reopened for maintenance
under its recorded authorization, then uses the original worker. A decision
hold or unknown eligibility cannot be cleared by that reopen path.

When a maintenance task is ready but its PR remains open, keep maintenance
active; do not finish/aggregate the task merely because one repair turn ended.
Paused records are discoverable but generate no routine checks or repairs;
only outstanding-work reconciliation is allowed while settlement is pending.
Existing review/decision actions wake the lead when the human gives direction.
Merging while paused is observed on a later authorized refresh/resume; there
is no separate always-on observer.

Explicit Stop/archive/delete must pause linked registrations before acting and
retain the evidence needed to reconcile accepted work. Deletion cannot discard
an unsettled attempt merely because Stop was requested. Do not stop unrelated
tasks owned by the lead.
An offline lead/Node is a wait, not proof that work ended. Portable restore
imports nonterminal registrations paused pending ownership/authorization
reconciliation. Restart preserves ordinary active/paused state and checkpoints;
it never turns an unknown accepted worker turn into a fresh job automatically.

#### 4.1 Maintenance is an automatic-retention root

Active or paused registrations retaining ownership, and any registration with
unsettled work, protect the bound worker, owning lead, required native conversation,
task/checkpoint records, and eligible checkout/binding from **CF automatic**
inactivity cleanup. Normal process parking is still allowed when it preserves
resumable conversation and verified ownership; protection need not keep an agent
process consuming capacity.

Extend `FleetStore.hasSessionRetentionBlockers` and every applicable automatic
workspace/task cleanup eligibility path, not just the UI's explicit Delete action.
Recheck protection transactionally when `requestSessionCleanup` reserves deletion.
Conversely, enable/rebind must fail while required cleanup is already in flight;
do not assume an in-flight Node deletion can be recalled. This closes the race
between reading a retention candidate and registering its maintenance root.

**Paused expiry policy for v1:** no automatic continuity expiry. At 30 days
paused, emit one "Resume or release maintenance" notice through existing
retention/notification machinery. Only an authenticated user renewal changes
that age; polls/reconnects do not. Explicit abandonment after settlement releases
the retention/ownership root and lets normal retention run. Warn that subsequent
resume may require a new authorized binding. Unknown execution/effects never
expire out of protection. Shared leads/bindings remain protected while any
registration still requires them.

### 5. Local repairs versus human decisions

Judge the actual change, not the review's label or number of affected lines:

| Feedback | Default |
| --- | --- |
| Consistent internal naming, typo/formatting, missing test, boundary/null handling, cleanup restoring established behavior | Automatically repair with the smallest sufficient change. Public contracts still require design review. |
| Local security defect: omitted existing authorization check, missing output encoding, unparameterized query, accidental secret logging | Automatically repair and demonstrate the existing invariant. Security severity alone does not force escalation. |
| New architecture/dependency, changed API/schema/protocol/storage, retry/fallback semantics, access policy/trust boundary, or uncertain intended behavior | Pause the PR's repairs and ask the human before implementing the change. |
| Duplicate, already fixed, or inapplicable | Verify against current code; record evidence and respond without another change. Outdated does not automatically mean fixed. |
| Conflicting or disputed reviewer demands | Explain once; escalate a contested/blocking choice rather than alternate incompatible fixes or debate indefinitely. |

The Orchestrator performs initial triage; the worker must re-evaluate the boundary
when it sees the implementation. It is not required to follow an incorrectly
classified "local" brief. Stop if a local repair turns into a design choice.
Ponytail does not justify ignoring a real defect or a harmless consistent nit.

**V1 pauses the whole PR, not just one comment.** Use maintenance-aware
`fleet_escalate` with the problem, feedback links, current HEAD, smallest options,
recommendation, and affected criteria. Persist the hold/pause reason and the
existing review request/notification atomically, keyed by the decision ID; a
retry returns that pending request rather than replacing it. A crash must not
leave a paused registration whose human question was never recorded. This
deliberately sacrifices parallel progress on unrelated nits to reuse the
existing human workflow rather than build per-item gates.

Resume must link to recorded operator direction for that proposal/scope.
Use the existing **Send back with instructions** path; its authenticated note
supplies the chosen approach and wakes the lead. Plain **Approve task** currently
means completing/aggregating a task, so it must not double as approval to perform
a new design change. A small purpose-aware explanation/guard on the existing
review surface is required for a maintenance escalation.

The MCP resume operation validates the decision reference/version. Neither a
model summary nor a PR comment claiming approval clears the hold. If proposal,
scope, or relevant design assumptions change, ask again. Keeping the current
design does not label an unresolved defect fixed or silently drop an essential
criterion. Substantial approved redesign returns to normal implementation before
maintenance resumes on an accepted new baseline.

#### 5.1 One shared maintenance admission rule

Use one shared server-side admission function for the registration, task,
worker/resource binding, action, and authenticated actor/decision reference.
It returns allow or a specific hold/uncertainty/ownership reason. Reuse it in
discovery and mutations; it is not a collection of prompt exceptions.

| Entry point | Required application |
| --- | --- |
| `continuation()`, `fleet_list_work`, `fleet_get_task`, and registry discovery | A pending maintenance decision returns `wait_for_human` with the decision reference, never advice to reopen/take back the task or create a replacement. |
| `fleet_reopen_task`, REST reopen, and Orchestrator resume of stopped Runs | Check before appending a reopen note, changing Run state, or calling `resolveRunReview`. Reopen alone does not consume a decision. |
| `fleet_follow_up`, `fleet_start_work`, plan/alternative-worker dispatch, and bound-session prompt/resume routes | Do not bypass the hold by omitting batch metadata, choosing another worker, or relabeling the same work as a new task. Enforce the known task/resource reservation at admission. |
| `fleet_advance_task`, `fleet_submit_task`, task Approve, and aggregation/publication entry | Do not advance/finalize away an unresolved maintenance decision or overwrite its review request. Readiness is not task/design approval. |
| Existing scheduler start/resume/prompt execution | Recheck current registration generation and admission after queueing, so a later pause/closure/human hold prevents an earlier queued action from starting. |
| Send back with direction, explicit abandonment, pause/cancel, and cleanup | Permit only the action's bounded authority. Recording direction and releasing the matching hold is atomic; stop/cancel may proceed without pretending to approve design. Deletion preserves unsettled evidence. |

For maintenance-bound tasks, the human decision and its pending review
notification survive generic reopen/advance paths. The current `reopenTask`
resolves that review, and `continuation()` recommends reopen for `awaiting_human`;
both must change for this explicit maintenance purpose. Likewise, do not let a
second escalation overwrite a still-pending decision.

Gate only the bound task/work/resource, not every unrelated task or repository
owned by the same lead. This closes known Fleet API bypasses; it is not a sandbox
against an arbitrary shell command with separate credentials.

### 6. GitHub helper and worker publication

Run the helper as an ordinary bounded command on an existing authorized Node,
preferably the lead's Node. If credentials are only available elsewhere, use
the existing approved remote-command path; do not copy tokens or create an
observer worker. Verify permissions/helper availability before enablement.
Package/version the skill and helper together; do not assume personal skills
are already installed on every Node. No new runtime/Node protocol is needed
for a helper that runs through supported existing command execution.

The helper is read-only against GitHub and does not mutate the registry. Return
structured identity/HEAD, open/merged/closed state, unresolved review threads
with relevant replies, submitted review bodies, new top-level discussion,
required checks/review state, source IDs/revisions, and explicit completeness.
Read all relevant pages; bound response size, request duration, and total work
against the remaining per-wake allowance. Report requests consumed, scan progress,
and completeness even on failure. On overflow/partial failure return incomplete,
never an empty success. Recheck
head/metadata after pagination; reject inconsistent observations. Do not rely
on the PR's top-level update timestamp alone to detect feedback edits.

Pass untrusted review text as data, never shell commands or approval instructions.
Batch/diff filtering can be deterministic, but the script must not decide whether
a finding is correct or architectural. Keep full evidence retrievable instead
of repeatedly injecting the entire PR transcript into the lead's context.

#### 6.1 Actionable fingerprints, not self-triggered loops

After reconciling known effects, compute a canonical actionable fingerprint
over PR generation/head/base identity and SHAs, effective required-check state,
current review obligations/decisions, mergeability, and unhandled source
IDs/revisions/content hashes. Ignore poll timestamps, page ordering, and other
incidental metadata. Also retain per-obligation keys: an aggregate fingerprint
change is a reason to evaluate actions, not to replay every previous action.

Known effect matching requires the recorded response/request/commit ID or batch
marker plus expected actor and content/action identity. Do not ignore everything
from our login or from bots. A new reviewer reply, an edited acknowledgement,
or an unmatched system-authored comment remains input to reconcile.

| Observed change | Treatment |
| --- | --- |
| Our recorded reply or review request appears | Settle that effect; do not acknowledge our own acknowledgement or create another review request. |
| Our expected thread resolution appears | Complete its recorded disposition; do not generate a new feedback item solely for the resolution. |
| Our recorded repair commit becomes HEAD | Reconcile publication and invalidate prior HEAD-dependent check/review evidence. Follow section 1's CI/re-review obligations; do not start another repair solely because we pushed. |
| A genuine reviewer reply/edit/reopen or new bot finding appears | Evaluate the changed source revision even when it follows our reply or uses the same author class. |
| An unexpected external commit or state change appears | Revalidate scope/evidence and evaluate resulting obligations; never suppress all HEAD changes as self-effects. |

Resolve ambiguous effect matches before triage; uncertainty cannot be hidden by
dropping the event. An unchanged actionable fingerprint and no unfinished effect
mean no repair or answer action. A changed check/review obligation can still
warrant action even when the set of review comments is unchanged.

#### 6.2 Publication and responses

The worker uses its current permitted coding/GitHub tools: inspect, make the
bounded repair, verify, commit, non-forcing push to the exact head ref, confirm
the published commit, and reply in the original threads. Resolve only evidenced
fixed/already-satisfied threads when allowed. Reviewer approval requirements
are not fulfilled by resolving a thread. Record provider response IDs where
available; after a lost response, reconcile before attempting another reply.

Immediately before publishing, recheck PR identity/open state, remote HEAD,
scope, and any newly material design constraint. External pushes/retargets,
unknown edits, or changed relevant assumptions invalidate earlier evidence;
do not force-push, rebase/reset automatically, or reuse tests for a different
tree. Preserve interrupted local repairs rather than deleting dirty files.
Unknown/interleaved user changes block unattended publication.

Related CI failures use the same local/design boundary. Do not disable checks,
weaken assertions, or alter security policy to manufacture green. An existing
authorized retry may retry a plausible transient infrastructure failure once;
persistent/uncertain failure needs attention. Keep sensitive security evidence
out of public comments and telemetry.

**First release never merges.** Current complete feedback/check/review evidence
can establish readiness, not permission to merge. A human or independently
authorized provider mechanism merges; the next successful helper observation
records that terminal result. Pending/unknown or stale-HEAD checks are not pass.

### 7. Limits and compatibility

| Rule | Proposed default |
| --- | --- |
| Check cadence | One due check per PR per 30 minutes on existing lead wakes; initial enablement and worker-result reconciliation may request an immediate check. Coalesce repeats. |
| Per-lead-wake allowance | At most 5 PRs visited, 40 GitHub requests initiated by the lead/helper (including pages/retries/reconciliation), and 120 seconds of maintenance work before admitting another operation. Helper timeout/request allowance cannot exceed what remains. |
| Failure backoff | Respect provider retry-after/rate limits. Pause after 3 consecutive failed observations or 10 failed observations per authorization; a complete success resets only the consecutive count. Auth/permission failure pauses immediately. |
| Repair budget | Three published repair batches per authorization/checkpoint; renew explicitly before a fourth. Waiting/checks/answer-only turns are not repair batches. Retain existing Run wake/session/time budgets. |
| Non-repair activity | At most 3 answer-only worker batches and 100 external mutation attempts per authorization across all batches/lead actions, including replies, resolutions, review requests, and CI retries. Reserve allowance before dispatch; unknown usage remains reserved. |
| No progress | Pause after two materially attempted fixes of the same underlying problem without progress, or an A-to-B-to-A contradiction. New comment IDs do not reset the finding. |
| Reconciliation/scan stalls | After 3 reconciliation/scan attempts with no new evidence or cursor progress, require human attention instead of waking repeatedly. New correlated receipts or operator direction may resume reconciliation, never release unknown work by age. |
| Concurrency | One reserved PR, head ref, and worker per registration, including terminal draining work; one outstanding batch. Existing checkout/session locks remain authoritative. |
| Quiet behavior | A heartbeat can spend lead/script cost; unchanged complete feedback triggers zero worker repair turns. No mandatory extra reviewer or repeated re-review request for one HEAD. |

**Fairness:** maintain a persisted oldest-due scan ordered by due time then stable
record ID, with a cutoff, bounded current page, and continuation cursor/unserved
IDs. Service carried unserved records before newly due arrivals. Save progress
after each visit, including a busy, failing, or incomplete PR; do not restart at
the first due PR after every wake/compaction. A serviced PR cannot jump ahead of
unserved records in the current pass because its own activity changes its due
time. Recompute oldest-due order for the next pass after the current pass drains.

Counters are tied to the existing lead turn/wake identity; another MCP page read
or script invocation cannot reset the allowance. Charge a PR visit on attempt,
not only on success. Stop admitting maintenance operations when any allowance
is exhausted, persist the continuation, and end this maintenance pass. Existing
normal/heartbeat wakes resume it; do not self-message, spin, or add a scheduler
to drain the backlog. Unrelated lead work retains its existing budgets.

The time allowance limits admitted maintenance work, not arbitrary model
reasoning duration or a hard PR-response SLA. Pass remaining deadline/request
budget into the helper so its I/O is bounded. Large scans may checkpoint partial
pages/cursors for a later wake, tied to the observed revision and revalidated
before use; until complete they authorize no triage/readiness. Budget exhaustion
alone is not an observation failure, but repeated no-progress scans are bounded.

Lead action budgets are persisted; worker briefs receive a reserved sub-allowance
and must stop/report at that limit. Refund unused allowance only from known
outcomes. Lost-response reconciliation is not a new mutation attempt; an actual
retry is. These are trusted-agent workflow limits, not a claim of interception
of every arbitrary worker shell command. Limits are proposed pilot defaults and
can be renewed explicitly, never reset by edited feedback, new attempt IDs, or
context compaction.

V1 supports only an already eligible mutable, branch-bound task/worker with an
authorized publication path. `fleet_get_task` continuation guidance is necessary
but not sufficient for managed tasks: explicitly check sealed result/binding
eligibility too. `finalizeStep` returns early when `step.resultSha` exists, so
blind reuse could leave stale immutable evidence.

For a published/sealed/cleaned managed task, refuse activation, retain a paused
registration with an eligibility reason when authorized, and request an explicit
supported handoff. Do not clear result SHAs, bypass
create-only publication approval, or resume a conversation at a different
immutable binding. A new reusable maintenance checkout/session purpose is a
**separate later increment**, not hidden work in this v1. Display this limit
at enablement; do not claim all published managed PRs are supported.

The registry and guards improve workflow reliability, not hostile-agent
isolation. Semantic design classification remains model judgment; trusted
shell-capable workers may already possess credentials. Existing cancellation
cannot undo a remote effect already accepted. Pause prevents new maintenance
dispatch and requests cancellation of an active batch; show pending cancellation
until acknowledged. Do not claim that a DB flag is a sandbox or a transactional
barrier to every command in flight.

### 8. Implementation seams and minimum UI

| Existing surface | Intended change |
| --- | --- |
| `apps\node\agents\fleet-orchestrator.agent.md`; `apps\host\src\orchestrator\briefing.ts` | Permanent registry-read instruction; maintenance skill/helper policy; clarify maintenance work is allowed only for explicit registrations and eligible workers. |
| `apps\host\src\orchestrator\mcp-routes.ts`; `tools.ts`; bound task/session routes | Three scoped registry capabilities; shared maintenance admission in discovery/reopen/dispatch/advancement and the existing follow-up batch link. No worker registry MCP or new server. |
| `apps\host\src\store.ts`; `packages\protocol\src\index.ts` | Registry/checkpoints, retained PR/head-ref/worker reservations, complete batch states, per-finding results, lead scan budgets/cursor, atomic accepted-batch link, migration/backup. |
| `apps\host\src\orchestrator\engine.ts` (`remindIdleLeads`, start/resume/prompt paths); `deadlines.ts` | Reuse existing lead wakes, bounded carried scans and reconciliation, and check admission again before queued execution. No new scheduler. |
| Existing command/tool execution and `apps\node\src\github-auth.ts` | Verify the helper can run with authorized access; preserve existing command approvals and keep tokens on Nodes. No provider effect controller or new command family. |
| `apps\host\src\orchestrator\review.ts`; existing task review/lifecycle routes | Apply the shared admission rule before resolving a review or changing task state. Record maintenance-purpose direction, terminal withdrawal, and explicit release without pretending they approve design. |
| `apps\host\src\session-retention.ts`; `store.ts` (`hasSessionRetentionBlockers`, `requestSessionCleanup`); workspace cleanup | Make maintenance a retention root; serialize registration against cleanup reservation; warn on long pauses without deleting continuity or expiring unknown effects. |
| `apps\host\ui\src\components\orchestration\OrchestratorTaskDetail.tsx`; notifications | Small PR/status summary, enable/pause/resume action, and existing escalation/Send back explanation. No separate dashboard or granular decision card system. |

Show PR link, bound worker, state/pause reason, last successful check, next due
time, remaining budget, and pending decision. Label stale/unknown status clearly.
Use existing deduplicated attention notifications and accessible task controls.
No standalone-session UI or background observer process is added in v1.

### Premortem analysis

| **Risk** | **Likelihood** (L/M/H) | **Impact** (L/M/H) | **How the design addresses it** |
| --- | --- | --- | --- |
| Compaction loses maintenance assignments | H | H | DB registry, permanent read instruction, wake IDs, persisted accepted batches and decisions |
| Completed tasks disappear from the reminder | H | H | Include leads with active registrations without automatically reopening their tasks |
| Busy leads never reach a 30-minute idle interval | M | M | Check persisted due times on normal wakes too; acknowledge best-effort latency |
| Closed PR or lost dispatch response leaves competing attempts | M | H | Complete batch states, atomic admission, cancellation/draining, retained ownership, generation-fenced receipts |
| "Security fix" silently changes access policy | M | H | Semantic triage plus worker re-evaluation; whole-PR escalation; model-risk disclosure |
| Reopen, alternate dispatch, or task Approve clears a decision | M | H | One shared admission function across guidance, task APIs, and queued execution; preserve the review until a valid disposition |
| Different PRs race on one remote source branch | M | H | Retained head repository/ref uniqueness, independent of PR number and physical checkout |
| Inactivity cleanup deletes the retained worker | M | H | Maintenance retention roots at cleanup admission; no implicit paused expiry; explicit abandonment only after settlement |
| Sealed managed results are reused unsafely | M | H | Fail enablement/dispatch eligibility rather than invent a mutable handoff in v1 |
| Bot review creates endless nits or debate | H | M | Group findings, preserve dispositions, cap repairs/no-progress, no automatic extra reviewers |
| Partial GitHub reads or unknown effects appear successful | M | H | Explicit completeness/evidence, bounded helper, pause on unresolvable publication/reply outcome |
| Own effects or one noisy PR monopolize the lead | M | M | Actionable fingerprints, obligation keys, bounded fair scans, answer/failure budgets, persistent continuation |

### Prototypes <!-- optional -->

| **Prototype no** | **Evaluation description** | **Reference(s)** | **Learnings** |
| --- | --- | --- | --- |
| P1 | Dry-run skill on local/design/contradictory feedback, including compaction between prepared and accepted work | Sections 2-5 | Not run |
| P2 | Helper pagination, review/check transitions, self-effect matching, and resumable bounded scans on fake fixtures and a separately authorized disposable PR | Sections 1, 6, and 7 | Not run; validate proposed allowances before enablement |
| P3 | Continuity, terminal draining/reopen races, shared admission, and retention-root/cleanup races for eligible and unsupported bindings | Sections 3-5 and 7 | Not run; confirms honest v1 support boundaries |

## Tracking open questions

| **Open question no** | **Open issue description** | **Findings and references** | **Resolution reached** |
| --- | --- | --- | --- |
| Q1 | Which architecture should ship first? | Later user discussion favors reuse over new harness machinery | Orchestrator heartbeat + skill/helper + DB-backed existing MCP; supersedes dedicated observer |
| Q2 | Where is maintenance memory authoritative? | Task ID alone cannot recover feedback/batch decisions | Host DB registry/checkpoints, not conversation memory or a local checkpoint file |
| Q3 | Pause one item or the whole PR for human input? | Existing escalation is task-level | Recommended v1: whole PR; per-item parallel progress deferred |
| Q4 | Is three published batches the right renewal limit? | Bounds review loops independently of polling | Proposed default; confirm in review, configurable through explicit authorization |
| Q5 | Is trusted-agent workflow enforcement sufficient? | Semantic decisions and current shell access are not sandboxed | Explicit release review topic; stronger isolation is separate work |
| Q6 | How much managed/standalone support belongs in v1? | Immutable bindings and missing ownership cannot be solved by a prompt | Eligible existing Orchestrator workers only; explicit blocked status for unsupported cases |
| Q7 | When should dedicated observation be reconsidered? | Lead cost, latency, and workload scale are presently unmeasured | Reconsider after pilot measurements; no infrastructure built in advance |
| Q8 | May v1 request a review? | Section 1's obligation/action table | Only to specifically configured/authorized external reviewers; otherwise notify once. No new reviewer sessions. |
| Q9 | Should a long pause automatically expire continuity? | Existing inactivity retention would undermine reuse | No automatic expiry in v1; one 30-day notice, then explicit user renewal/release after settlement |
| Q10 | Are the per-wake and non-repair allowances sufficient? | Section 7 bounds cost without another scheduler | Proposed pilot defaults; validate fairness and large-PR scans in P2 |

### Opus review disposition

All seven findings are accepted as contract amendments, not requests for another
scheduler. Source inspection confirmed that `hasSessionRetentionBlockers` does
not yet consider maintenance and that `reopenTask` resolves pending review while
`continuation()` currently recommends reopening an `awaiting_human` task.

| Review | Amendment | Acceptance coverage |
| --- | --- | --- |
| R1: advance beyond comments | Section 1 action/wake table; named external-review request policy; independent CI/re-review/readiness obligations | T24-T25 |
| R2: complete batch/terminal races | Section 3.1 state table, per-finding stages, settlement-only release, cancellation and generation fencing | T26-T27, T37 |
| R3: own the remote branch | Section 2 head-repository/ref uniqueness while ownership is retained | T28 |
| R4: retention roots | Section 4.1 automatic cleanup admission guards and explicit paused-release policy | T29-T31 |
| R5: consistent human holds | Section 5.1 shared discovery/mutation/execution admission, preserving pending reviews | T32 |
| R6: self-effect exclusion | Section 6.1 canonical actionable fingerprint plus known-effect and obligation reconciliation | T33 |
| R7: bound a whole wake | Section 7 persistent oldest-due scans, PR/request/time allowances, non-repair/failure bounds | T34-T36, T38 |

# Common core checklist

- **Quality(verification)**: Use repeated skill evals plus the deterministic
  acceptance cases below. Cover store/MCP authorization, compaction recovery,
  current scheduler/follow-up behavior, helper fixtures, and task review UI.
  No runtime result is claimed by this design-only document.
- **External dependencies**: Existing GitHub CLI/Git/API access, supported agent
  runtime, Node connectivity, existing approved command execution. No new
  database, queue, provider framework, or observer service.
- **Supportability**: Persist IDs, versions, timestamps, reason codes, and bounded
  evidence references. Deduplicate recurring attention. Never log tokens or
  raw sensitive review/test content as telemetry.
- **Performance**: Measure script/page count, lead-check tokens, latency, and
  avoided worker turns. Use bounded summaries/details-on-demand through MCP.
  Establish helper payload/time limits in P2; partial data never counts as success.
- **Fundamentals**: Authentication, privacy, untrusted input handling, durability,
  and accessibility apply. Fabric-specific deployment/assessment gates do not.
- **Execution Plan**: Review the amended contracts before implementation. This
  revision changes documentation only; it does not activate maintenance, authorize
  product implementation, or dispatch another review agent.
- **Engineering Wiki updates**: On implementation, update `README.md`,
  `README.zh-CN.md`, `ARCHITECTURE.md`, and `docs\orchestration-lifecycle.md` with
  shipped scope, cadence, DB/MCP behavior, human gates, eligibility, and recovery.

### Required acceptance cases

| Test | Scenario and required assertion |
| --- | --- |
| T01 | Compaction removes all conversational PR context: the next wake reads DB registrations and recovers exact task/worker, pending feedback, and holds. |
| T02 | Lead has only a completed implementation task and an active registration: existing reminder can wake it; no automatic reopen/write occurs. |
| T03 | Repeated normal lead activity prevents an idle interval: due checks still run on ordinary wakes; busy turns do not receive competing prompts. |
| T04 | Two leads enable the same PR, or spoof task/worker ownership: one owner; invalid binding rejected; paused registrations are not silently reassigned. |
| T05 | A caller supplies fabricated approval/actor fields or a PR comment says "approved": no enablement, scope expansion, or cleared decision hold. |
| T06 | Duplicate enable/checkpoint calls and stale versions: stable record/batch identity; no overwrite of newer state or lost pending items. |
| T07 | Lost response before/after follow-up acceptance: reconcile existing step/batch; no second prompt, changed retry prompt, or replacement worker. |
| T08 | Worker idle but task held, stopped, sealed, or binding unavailable: idle alone never permits maintenance dispatch. |
| T09 | Same comments reappear; a thread is edited/reopened/outdated: unchanged revisions do not dispatch; changed context is reconsidered; outdated is not automatically fixed. |
| T10 | Mixed local nits/edge/security defects: one coherent worker batch fixes existing invariants without a fresh reviewer or per-comment approval. |
| T11 | One-line authorization policy change marked critical, or worker discovers a broader fix: pause the whole PR and escalate before implementing it. |
| T12 | Human uses Send back with bounded direction: linked decision enables only that scope; ordinary task Approve/reopen cannot silently authorize redesign. |
| T13 | Human keeps current design despite a demonstrated defect: record the decision but do not mark the defect fixed or drop essential criteria. |
| T14 | Helper pagination, timeout, auth/rate limit, or payload overflow: complete data or explicit failure; no fabricated zero-comment success. |
| T15 | New feedback arrives while worker queued/running: preserve pending work, coalesce the next batch, and never overwrite an accepted prompt. |
| T16 | External push/retarget, stale checks, or unknown/interleaved edits: no force-push/reset/rebase or reuse of evidence for a different tree. |
| T17 | Push/reply outcome is uncertain: inspect available tool/provider evidence and pause if unresolved rather than blindly repeat. |
| T18 | Three published batches or repeated contradiction: renew/pause visibly; checks and waiting do not consume repair count or reset existing Run budgets. |
| T19 | Pause/Stop/archive/delete and late worker events: registration stays paused, future dispatch is blocked, cancellation/accepted effects are reported honestly. |
| T20 | Host restart, Node offline, or portable restore: preserve known checkpoints, treat execution as unknown until reconciled, restore portable registrations paused. |
| T21 | PR ready/merged/closed: ready keeps active maintenance; terminal state requires a successful current helper observation; paused work does not self-resume. |
| T22 | CI failure or sensitive security feedback: no weakened checks/assertions, no unbounded infrastructure retry, and no sensitive public response. |
| T23 | Unsupported managed/standalone worker: honest eligibility block, no new session/path adoption or immutable-result mutation as a fallback. |
| T24 | Initial review is absent: external-only mode notifies once; an explicit named-reviewer grant allows one request; our pending request does not trigger another request. |
| T25 | A push dismisses approval, CI fails without comments, or threads resolve while changes-requested remains: select the correct repair/re-review/wait action and never claim readiness from thread count alone. |
| T26 | A worker finishes after fixing only some findings, or pushes successfully but a reply fails: record partial per-finding stages; retry only known remaining work. Unknown execution/effects keep the batch outstanding. |
| T27 | PR closes while work is prepared, queued, or running, then reopens before cancellation settles: no stale queued start, retain all ownership/retention roots, and reconcile effects before re-enable. |
| T28 | Two PRs target different bases from the same head repository/ref using different workers/checkouts: the second registration conflicts, including while the first is paused or terminal-but-unsettled. |
| T29 | Old completed task and idle worker/lead reach inactivity cutoff while maintenance remains active: automatic retention preserves required sessions/conversation/binding without fake activity updates. |
| T30 | Enablement races deletion reservation: either registration establishes its root first or enablement is rejected while cleanup is in flight; no active record points at an automatically deleted worker. |
| T31 | Registration remains paused for 30 days: one notice, no automatic expiry or age reset from polling. Explicit settled abandonment releases roots; unknown work and other registrations' roots remain protected. |
| T32 | Exercise discovery, MCP/REST reopen, alternative dispatch/plan, advancement/submission, review Approve, bound-session prompt/resume, and queued execution under a human hold: all use the same gate and retain the pending review. Unrelated work remains allowed. |
| T33 | Our replies/resolutions/requests/commits reappear in observations: settle known effects without acknowledgement loops; still process a genuine bot/reviewer reply or edited acknowledgement and revalidate HEAD-dependent checks/reviews. |
| T34 | Many PRs are due with a noisy/failing first record: visit no more than 5, admit no more than 40 lead/helper requests or another operation after the 120-second allowance, and carry unserved records ahead of new arrivals. |
| T35 | Compaction, MCP pagination, and retries occur in one wake/authorization: counters do not reset. Answer-only turns, mutation attempts, and unknown reserved usage exhaust their separate limits correctly. |
| T36 | Repeated/intermittent observation failures, auth errors, or reconciliation with no evidence: enforce consecutive/cumulative limits and notify once; do not release unknown effects. Budget-exhausted partial reads are not mislabeled network failure. |
| T37 | A terminal settled record releases ownership and the PR is explicitly re-enabled: new generation revalidates identity/authority; late old receipts cannot complete, cancel, or release the new generation. |
| T38 | A paginated scan spans wakes and HEAD/relevant input changes before completion: revalidate/discard stale partial evidence; no triage/readiness from incomplete pages and no first-page restart starving later records. |

# Backend (workload) checklist <!-- optional -->

- **State/Metadata**: Versioned DB registry/checkpoints, ownership constraints,
  migrations/backup, complete batch/per-finding states, retained remote-ref
  reservations, fair-scan counters/cursor, and existing-follow-up acceptance link.
- **Config options and resource consumption**: Existing 30-minute reminder,
  persisted per-PR due times, bounded script/MCP payloads, and explicit repair
  limits plus per-wake/non-repair/failure allowances. No independent poll timer
  or worker scheduler.
- **MWC DMS workload - Coding Best Practices**: Not a Fabric workload. Keep
  existing asynchronous command/agent completion behavior rather than holding
  a request open until PR merge.
- **Warehouse MWC workloads - Integration**: Not applicable; reuse Fleet store,
  MCP scoping, lead delivery, worker continuity, and task escalation.
- **Public/Other APIs**: Proposed tool names in section 2; exact schemas require
  implementation review. Human authorization cannot be minted by checkpoint APIs.
- **MWC Error handling**: Not applicable as a dependency. Distinguish incomplete
  observation, auth required, stale record, human hold, busy/unknown execution,
  unsupported binding, and exhausted budget with actionable Fleet status.

# Frontend (UX) checklist <!-- optional -->

- **Integration with Fabric Platform**: Not applicable; existing task surfaces.
- **Impact on external Fabric UX artifacts/extensions**: None.
- **Corner cases**: Stale operator actions, multiple PRs sharing one head ref,
  completed task with retention roots, long pauses, partial/draining batches,
  and a reopened PR awaiting old cancellation settlement.
- **Error-handling**: Server version/authorization checks remain authoritative;
  display last successful observation separately from current availability.
- **UX extension telemetry**: Existing facilities; record actions/reason codes,
  not feedback contents or credentials.
- **Config options and resource consumption**: No new browser persistence model
  or dashboard; bounded task status and details fetched from Host DB.
- **Fabric UX Feature Switches**: Not applicable. Gate enablement on the complete
  supported backend/helper/worker path; do not enable unsupported bindings.
- **Accessibility**: Keyboard-operable actions, understandable pause reasons,
  announced attention, and clear task completion versus design-direction wording.

## Appendix A – Examples of feature execution plans <!-- optional -->

The template's example headings contain this feature's proposed delivery order.

### Backend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| B0 | Review this revised architecture, human gate, v1 support limits, and trust model. No product implementation before review. | Nothing |
| B1 | Registry/schema/MCP, PR/head-ref/worker reservations, complete batch/per-finding states, approval linkage, retained ownership/retention roots, shared admission, migration/backup, and atomic follow-up acceptance. | B0 |
| B2 | One-turn skill/helper with action/wake table, review obligations, actionable fingerprints, bounded resumable pagination/fair scans, and compaction recovery fixtures. | B0; align with B1 contracts |
| B3 | Integrate existing reminders and queued-execution admission, cancellation/draining, retention reservation races, and consistent task review/reopen/advance guards. No new scheduler or worker tools. | B1, B2, F1 |
| B4 | Pilot on eligible mutable Orchestrator workers; exercise acceptance/restart matrix and measure lead cost/latency. Keep unsupported cases visibly blocked. | B3, F2 |

### Frontend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| F1 | Minimal task enable/pause/resume and operator authorization/direction linkage; clarify existing Send back versus Approve behavior for maintenance escalation. | B0, B1 contracts |
| F2 | Task PR/status summary and existing notifications; stale/version/accessibility cases. | F1, B3 |
| F3 | Document shipped behavior and limitations. Rollback pauses registrations and leaves user code, branches, and history untouched. | B4 |

Use existing protocol build and targeted Vitest service/UI selectors first,
then typecheck/lint/build and relevant continuity, review, retention, backup,
and command-delivery regressions. No new test runner is proposed.

### Independent review brief

Review the revised **Orchestrator-first** design, not the superseded observer:

- Does the DB/MCP contract actually survive compaction and lost dispatch
  responses, partial batches, and terminal/reopened PR races without a second scheduler?
- Can task completion, heartbeat inactivity, reopen, or task Approve hide a PR,
  clear a human hold, or accidentally trigger managed aggregation?
- Are local security repairs automatic while design-impacting changes reliably
  reach a human, including when the worker discovers the impact late?
- Are publication/reply recovery guarantees honest about existing tools,
  credentials, and uncertain effects?
- Can two PRs share a writable head ref or can automatic retention reclaim
  required continuity while an active/paused/draining registration still owns it?
- Do check/re-review obligations and genuine reviewer replies advance the loop
  without self-generated effects or one noisy PR exhausting every lead wake?
- Are v1 managed/standalone limitations explicit, and can further machinery be
  removed without losing authority, continuity, or the requested outcome?

Separate blocking issues from improvements. Proposed limits and unimplemented
MCP names are design contracts, not claims of existing runtime behavior.
