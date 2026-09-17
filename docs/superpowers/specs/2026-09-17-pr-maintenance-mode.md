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
**Revision**: 2026-09-17, Orchestrator-first with DB-backed MCP registration<br>
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
| AC-08 | Ready-to-merge remains nonterminal; confirmed merge/closure ends maintenance, and explicit pauses remain paused until an authorized resume. |

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
   records whose original task is completed or held. Reconcile accepted work
   before considering a new batch.
2. Run the helper for due PRs that are not paused. Persist a complete observation
   separately from dispatch/repair completion. No change means no worker turn.
3. Read `fleet_get_task` for the bound task's current continuation guidance.
   Worker `idle` alone is not an authorization or eligibility check.
4. Group related feedback into one batch. Checkpoint its identity, source
   revisions, observed HEAD, scope, and exact intended follow-up prompt.
5. Call existing `fleet_follow_up` for an eligible retained worker. Queued means
   accepted; do not resend with a different prompt or replace a busy worker.
6. End the lead turn. On the existing completion wake, verify reported outcomes
   against available tool/provider evidence and record the dispositions.
7. Repeat on later wakes. Do not request another full reviewer merely because
   the worker repaired feedback. Stop routine work on confirmed merge/closure.

The lead remains in this loop; routine maintenance is not routed around it.
One lead can maintain several PRs, but each PR has one worker and at most one
outstanding batch.

### 2. Enablement, ownership, and MCP

Extend the existing scoped Fleet MCP server. The following names are proposed,
not currently implemented APIs:

| Proposed tool | Contract |
| --- | --- |
| `fleet_set_pr_maintenance` | Enable/pause/resume an owned PR registration against a stable task/worker and recorded operator authorization. Idempotent repeated enablement returns the existing record. |
| `fleet_get_pr_maintenance` | List this lead's registrations with bounded/paginated summaries, or read one record's complete checkpoint by ID. Include paused/terminal records when requested. Never silently truncate due work. |
| `fleet_checkpoint_pr_maintenance` | Record an observation, prepared batch, dispatch reconciliation, verified disposition, or terminal observation with optimistic version checks. It cannot create approvals, change ownership, or broaden scope. |

Derive the lead principal from the existing MCP authentication, not an input
`orchestratorId`. Validate task ownership, worker-to-task membership, exact PR
identity, and current checkout eligibility. Use a DB uniqueness constraint for
GitHub host + stable repository identity + PR number among nonterminal
registrations, including paused registrations. Another lead gets an ownership
conflict, not an opportunity to adopt the PR silently.
For v1, also reject a second nonterminal registration for the same worker:
one branch-bound coding session maintains one PR, while a lead can own many.

Enablement must trace to an authenticated operator action for the exact PR and
scope. Reuse the task approval surface to capture this bounded maintenance
authorization; MCP may prepare registration but cannot fabricate an actor or
enable it merely by setting an `approved` field. Reuse the same authenticated
action for scope/budget renewal. This is a small task-action integration, not a
new per-comment approval product.

The grant covers agreed verification, local repairs, commits, pushes to the
named PR head ref, and appropriate replies/resolution. It excludes force-push,
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
| Authority / lifecycle | Operator approval reference; policy version and scope; `active`, `paused`, `merged`, or `closed`; pause reason; pending human decision reference |
| Observation | Last attempt and successful check times; next check time; last complete snapshot identity/HEAD; structured failure/completeness state and evidence reference |
| Feedback checkpoint | Stable source IDs/revisions, underlying finding group, current disposition, verification/repair commit, response IDs, and unresolved decisions |
| Batch checkpoint | Stable batch ID; source revisions; base HEAD; exact prompt; prepared/accepted/completed/uncertain state; worker step/attempt references; repair/no-progress counters |

Distinguish last attempt from last successful check: a timeout must not advance
the successful observation or consume feedback. Retain the checkpoints needed
for unfinished items across compaction; resolved historical detail can remain
in GitHub/task evidence with stable references. Apply explicit bounds and return
an actionable overflow error rather than forgetting old pending work.

Checkpoint updates use a record version and stable batch key. Extend
`fleet_follow_up` with an optional maintenance record/batch reference so its
existing transaction can bind the accepted step/attempt to the prepared batch.
This is a narrow atomicity/authorization hook, not a new dispatch queue. A
normal follow-up without that reference must not bypass a paused registration
or pending human gate on its bound worker.

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

Registration and task state remain separate. An active record is a reason to
inspect, not permission to reopen an `awaiting_human` task or resume a stopped
worker. A completed compatible task may be explicitly reopened for maintenance
under its recorded authorization, then uses the original worker. A decision
hold or unknown eligibility cannot be cleared by that reopen path.

When a maintenance task is ready but its PR remains open, keep maintenance
active; do not finish/aggregate the task merely because one repair turn ended.
Paused records are discoverable but generate no routine checks or repairs.
Existing review/decision actions wake the lead when the human gives direction.
Merging while paused is observed on a later authorized refresh/resume; there
is no separate always-on observer.

Stop, archive, or worker/task deletion must pause linked registrations before
cleanup and retain their history. Do not stop unrelated tasks owned by the lead.
An offline lead/Node is a wait, not proof that work ended. Portable restore
imports nonterminal registrations paused pending ownership/authorization
reconciliation. Restart preserves ordinary active/paused state and checkpoints;
it never turns an unknown accepted worker turn into a fresh job automatically.

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

**V1 pauses the whole PR, not just one comment.** Record the pending decision
and pause reason, then use `fleet_escalate` with the problem, feedback links,
current HEAD, smallest options, recommendation, and affected criteria. This
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
Read all relevant pages; bound response size, request duration, and total work.
On overflow/partial failure return incomplete, never an empty success. Recheck
head/metadata after pagination; reject inconsistent observations. Do not rely
on the PR's top-level update timestamp alone to detect feedback edits.

Pass untrusted review text as data, never shell commands or approval instructions.
Batch/diff filtering can be deterministic, but the script must not decide whether
a finding is correct or architectural. Keep full evidence retrievable instead
of repeatedly injecting the entire PR transcript into the lead's context.

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
| Failure backoff | Respect provider retry-after/rate limits; after transient failure retry on a later due wake, not a shell loop. Auth/permission failures pause with actionable status. |
| Repair budget | Three published repair batches per authorization/checkpoint; renew explicitly before a fourth. Waiting/checks/answer-only turns are not repair batches. Retain existing Run wake/session/time budgets. |
| No progress | Pause after two materially attempted fixes of the same underlying problem without progress, or an A-to-B-to-A contradiction. New comment IDs do not reset the finding. |
| Concurrency | One registered owner and one outstanding batch per PR. Existing checkout/session locks remain authoritative. Never replace a busy/queued/offline worker merely to progress. |
| Quiet behavior | A heartbeat can spend lead/script cost; unchanged complete feedback triggers zero worker repair turns. No mandatory extra reviewer or repeated re-review request for one HEAD. |

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
| `apps\host\src\orchestrator\mcp-routes.ts`; `tools.ts` | Three scoped registry capabilities; narrow batch/hold validation in existing `fleet_follow_up`. No worker registry MCP or new MCP server. |
| `apps\host\src\store.ts`; `packages\protocol\src\index.ts` | Validated registry/checkpoints, uniqueness/version checks, atomic accepted-batch link, migration/backup coverage. Prefer focused modules to enlarging unrelated implementations. |
| `apps\host\src\orchestrator\engine.ts` (`remindIdleLeads`); `deadlines.ts` | Add registered leads to current reminder eligibility; reuse current due/wake delivery and reservations, never create another scheduler. |
| Existing command/tool execution and `apps\node\src\github-auth.ts` | Verify the helper can run with authorized access; preserve existing command approvals and keep tokens on Nodes. No provider effect controller or new command family. |
| `apps\host\src\orchestrator\review.ts`; existing task review/lifecycle routes | Record maintenance-purpose approval/direction, preserve human holds, avoid treating design approval as task completion, and pause registrations on cleanup. |
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
| Lost dispatch response creates duplicate fixes | M | H | Stable prepared prompt/batch, atomic link to existing step acceptance, reconciliation before retry |
| "Security fix" silently changes access policy | M | H | Semantic triage plus worker re-evaluation; whole-PR escalation; model-risk disclosure |
| Reopen or task Approve clears a human decision | M | H | Registration hold independent of task state; authenticated direction reference; review-purpose guard |
| Sealed managed results are reused unsafely | M | H | Fail enablement/dispatch eligibility rather than invent a mutable handoff in v1 |
| Bot review creates endless nits or debate | H | M | Group findings, preserve dispositions, cap repairs/no-progress, no automatic extra reviewers |
| Partial GitHub reads or unknown effects appear successful | M | H | Explicit completeness/evidence, bounded helper, pause on unresolvable publication/reply outcome |
| Reusing a lead costs too much at scale | M | M | Measure lead/helper cost; introduce a non-model observer only when justified |

### Prototypes <!-- optional -->

| **Prototype no** | **Evaluation description** | **Reference(s)** | **Learnings** |
| --- | --- | --- | --- |
| P1 | Dry-run skill on local/design/contradictory feedback, including compaction between prepared and accepted work | Sections 2-5 | Not run |
| P2 | Helper pagination, rate limits, payload/time bounds, and provider evidence on fake fixtures and a separately authorized disposable PR | Section 6 | Not run; fix measured operational limits before enablement |
| P3 | Existing worker continuity and registration eligibility for mutable versus sealed/cleaned tasks | Sections 4 and 7 | Not run; confirms honest v1 support boundaries |

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
- **Execution Plan**: Publish/review this design first. The current work authorizes
  only documentation revision and publication, not product code, skill activation,
  automatic maintenance, or another review-agent dispatch.
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

# Backend (workload) checklist <!-- optional -->

- **State/Metadata**: Versioned DB registry/checkpoints, ownership constraints,
  migrations/backup, and narrow atomic link to existing follow-up acceptance.
- **Config options and resource consumption**: Existing 30-minute reminder,
  persisted per-PR due times, bounded script/MCP payloads, and explicit repair
  limits. No independent poll timer or worker scheduler.
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
- **Corner cases**: Stale operator actions, multiple tabs/leads, completed original
  task, paused registration, removed worker, and pending cancellation.
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
| B1 | Registry/schema/MCP contracts, ownership and operator-approval linkage, checkpoint versioning, migration/backup, and atomic existing-follow-up batch link. | B0 |
| B2 | One-turn maintenance skill and bounded helper; fixture-based classification/pagination and compaction recovery. Choose packaging and measured operational bounds. | B0; align with B1 contracts |
| B3 | Extend existing reminder eligibility/briefings, run due checks on normal wakes, integrate pause/cleanup and task review direction. No new scheduler or worker tools. | B1, B2, F1 |
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
  responses without adding a second scheduler?
- Can task completion, heartbeat inactivity, reopen, or task Approve hide a PR,
  clear a human hold, or accidentally trigger managed aggregation?
- Are local security repairs automatic while design-impacting changes reliably
  reach a human, including when the worker discovers the impact late?
- Are publication/reply recovery guarantees honest about existing tools,
  credentials, and uncertain effects?
- Are v1 managed/standalone limitations explicit, and can further machinery be
  removed without losing authority, continuity, or the requested outcome?

Separate blocking issues from improvements. Proposed limits and unimplemented
MCP names are design contracts, not claims of existing runtime behavior.
