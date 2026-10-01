# Orchestration lifecycle

Orchestration control uses separate persisted facts:

- The run and step state controls scheduling.
- The session state records the latest worker state reported by a Node.
- `stopRequested` records an unacknowledged Stop across disconnects and restarts.
- `dismissed` controls visibility only.
- `stoppedByOrchestrator` identifies unfinished steps that an older Host's
  orchestrator Stop cancelled, which Resume may continue.

## Operation contract

Stopping an orchestrator stops its own conversation and nothing it started. The
Host runs tasks without a live lead: dispatched steps finish, pending steps still
dispatch, and whatever settles is owed to the lead as a wake that Resume
delivers. Ending tasks is Archive's job, and Stop agents ends workers. Stop
pauses PR maintenance owned by the lead, as it always has, because maintenance
is driven by lead wakes.

| Existing state | Stop orchestrator | Dismiss | Resume orchestrator |
|---|---|---|---|
| Pending or dependency-waiting step | Unchanged; still dispatched when ready | No execution change | Unchanged |
| Starting, queued, or running step | Unchanged; its worker keeps running | Rejected while the task is live | Unchanged |
| Succeeded, failed, skipped, or cancelled step | Preserved | No execution change | Preserved |
| Offline worker | Unchanged | Rejected while the task is live | Unchanged |
| Worker with its own pending Stop | Unchanged; "Mark orchestrator stopped" confirms it too when its node is unavailable | Rejected until acknowledged | Does not wait for it |
| Live lead | The lead records `stopRequested` and receives Stop | Rejected | Rejected |
| Terminal lead | Idempotent | Allowed once its own tasks are finished or archived and their workers settled; visibility changes and history remains stored | Lead is reattached; owed wakes and held messages are delivered once it is idle |
| Task cancelled by an older Host's orchestrator Stop | — | Allowed once settled | Unfinished marked steps return to `pending` after their workers are terminal or idle and every Stop is acknowledged |

Dismiss and restore never change run, step, or worker state. A dismissed lead and
its tasks remain in persistence and continue accepting late terminal events.

An unexpected lead failure, including failure to restore MCP tools, and an
explicit Stop are handled the same way: Resume reattaches the existing lead
conversation while workers in ongoing tasks keep their sessions and progress.
A lead's own outstanding Stop blocks Resume; its workers' Stops do not, because
the scheduler parks settled workers while the lead is away.

A Resume or start that the Node refuses settles the session as `failed` with the
Node's reason, instead of leaving it `starting`. A refused launch leaves no
process to report on it, so `starting` would otherwise never end; `failed` keeps
the conversation resumable.

## Transferring a task

A task has exactly one owner, its run's `leadSessionId`: the conversation the
engine wakes, delivers owed prompts to and lists the task under, and the one
PR maintenance's heartbeat claims the task's registrations for. Transfer
reassigns that owner and nothing else, in one transaction.

| Existing state | Transfer |
|---|---|
| Open task | Moves; the receiving lead is owed a `<fleet-task-transfer>` brief ahead of any prompt already owed |
| Closed task | Moves without a brief; nothing is delivered to a closed task |
| Pending, starting or running step, idle retained worker | Unchanged; later settles wake the new owner |
| Run-prompt or wake queued to the previous lead and not yet sent | Orphaned there and carried into the brief; one already in flight cannot be recalled |
| PR maintenance registrations, including released history | Move to the new owner with a version bump; a pause the previous lead made itself becomes the new owner's |
| Pending maintenance proposal | Re-owned and still authorizable; a reauthorization pinned to the moved record follows its new version |
| Command executing or awaiting observation on the task's checkout | Refused until settled and observed |
| Unsettled command the previous lead requested for the task | Refused; its result is delivered to whoever requested it |
| Receiving lead stopped, stopping, dismissed or being deleted | Refused |

The operator transfers from a task's page, a conversation's task panel or the
board (`POST /api/runs/:id/transfer`, `POST /api/orchestrators/:id/transfer`).
An orchestrator uses `fleet_transfer_task`, naming another conversation's task
by the ID `fleet_list_orchestrators` shows; owner permission is deliberately not
checked. A send-back, reopen or maintenance direction that arrives while the
brief is still owed is appended to it. Every transfer adds a lifecycle note with
any handoff note, so the record says where a task has been.

## Dependency rules

A step is runnable only when every prerequisite is `succeeded`. Failed,
cancelled, or skipped prerequisites block their direct and transitive
descendants. Independent branches remain eligible. Fan-in requires every branch
to succeed.

## Event precedence

1. Persisting run cancellation prevents all new dispatches.
2. A matching turn completion followed by `idle` or `completed` wins a race
   with Stop and preserves that step as `succeeded`.
3. A reported worker failure remains `failed`.
4. A Stop acknowledgement leaves unfinished work `cancelled`.
5. Nonterminal events received after Stop do not clear stop intent; Stop is
   reissued.
6. Nonterminal state events for dismissed sessions are recorded but cannot
   restore the session to a live UI state.
7. Event sequence watermarks prevent output from an earlier attempt from being
   attached to a resumed attempt.

## Recovery and compatibility

The control fields are additive SQLite columns with safe defaults, so older
databases remain active and visible. Backups preserve the fields. On reconnect,
a stopped session still present on the Node receives Stop again; a session no
longer present is confirmed `stopped`. Resume resets only steps explicitly
marked by an older Host's orchestration Stop transaction; current Hosts no
longer write that mark, so a database from before the change still resumes the
work it stopped.

### Task overview and checkpoints

The task detail page puts a brief current-stage summary first, then PR
maintenance and dispatched work in a responsive split layout. Decisions use
the existing version-guarded dialog flow and do not navigate to the lead's chat.
Full reports, receipts and worker responses are disclosed in **Workflow history**;
the objective, phases, criteria and workspace controls live in **Task details**.
The PR graph uses `prMaintenanceProgress`, including its current-head, freshness,
human-hold and unknown-effect rules. A failed status refresh invalidates displayed
readiness without dropping a retained decision or granting new authority.

`RunNote` remains the append-only task journal. Optional `summary`, `kind`,
`source` and `sessionId` metadata is persisted with each entry and round-trips
through backups. The Host supplies `createdAt`; old notes are not rewritten,
retimestamped or assigned a guessed author. Records with equal timestamps retain
append order. The full report remains separate from the short, single-line,
240-character summary.

The lead supplies `headline` on advance/submit/escalate, or uses
`fleet_record_task_checkpoint` for a meaningful in-phase milestone. The latter
does not advance a phase, dispatch work, authorize an action, resolve a human
hold or finish a task, and it is refused for closed tasks or pending human reviews.
Adjacent identical progress checkpoints are not duplicated. Human directions
are attributed to the operator by their existing authenticated write path.
Worker-attempt results are snapshotted by Fleet in the same transaction as the
first terminal step transition, so a retry cannot erase the previous response
and replaying a settlement does not append it again. Recording a worker result
does not make that result a whole-task handover or proof of deployment.

### MCP reconnect recovery

The Node restores retained MCP-equipped sessions without stopping their workers.
It waits for authentication and buffered-event reconciliation, then for five
seconds of connection stability. A busy lead finishes its current turn before
restoration begins.

An unsuccessful restoration retries after 5, 30, and 120 seconds, for at most
four attempts. Disconnection pauses recovery without consuming attempts, and
overlapping reconnects share the same recovery operation. The existing session
and conversation identifiers, attached directories, agent, and picker settings
are retained. Recovery does not replay the original prompt or dispatch worker
work. While recovering, the lead is reserved as busy with an explicit MCP
recovery activity; new prompts, resumes, and picker changes are refused.

Each replacement must confirm that the previous process tree has stopped.
Windows MCP-equipped ACP sessions use the same Job Object containment as leased
sessions, even when the lead has no workspace lease. Failed startup cleanup
retains its process handle so a retry cannot create an overlapping replacement.

Stop and Node shutdown cancel recovery waits and startup, then stop the retained
process. Exhausted startup retries become a failed session with a manual Resume
action. If process shutdown cannot be verified, recovery instead reports
`MCP recovery blocked`, retains the process for reconciliation, and refuses a
replacement until safe shutdown is confirmed. Reconnect does not reset an
exhausted retry budget.

## MCP follow-up decisions

Task identity and worker identity are separate. `fleet_list_work` searches the
current orchestrator's open and closed tasks and returns stable task IDs, worker
session IDs, original checkouts, session states and continuation actions.
`fleet_get_task` reads the task's criteria, notes and worker context. Task tools
accept a stable ID or an exact, unambiguous name; a name lookup miss does not
establish that the conversation was deleted. Neither tool crosses into another
orchestrator's records.

For another revision of the same deliverable, reuse the worker with
`fleet_follow_up`. Reopen a closed or handed-over task first, unless maintenance admission reports a
human hold or retained-resource blocker. An accepted
follow-up is persisted in its existing step and passes through the scheduler,
including parallel limits and the original checkout's writer lock. Repeating
the same queued or in-flight prompt does not send another turn, and a different
prompt cannot overwrite it. Busy, stopping and offline are temporary states,
not evidence that the conversation must be replaced. A confirmed terminal
worker without a resumable conversation needs replacement with the retained
task context supplied explicitly.

## Queued follow-up admission and Resume now

The scheduler records why it leaves each pending step pending, in the same pure
pass that decides dispatch (`planNextActions` holds), so an explanation cannot
drift from what the engine did. Holds live in memory and are recomputed every
tick; a restarted Host reports `scheduling` until its first pass. Steps carry
the derived `admission` on REST reads and `run_steps` broadcasts, and the
orchestrator reads the same text in `fleet_list_work`, `fleet_get_task` and the
`fleet_follow_up` reply.

| State | Meaning | Codes |
|---|---|---|
| queued | Ordinary capacity or ordering; Fleet starts it by itself | `session_busy`, `parallel_limit`, `node_headroom`, `node_capacity`, `dependencies`, `workspace_not_ready`, `nodes_unknown`, `no_placement`, `scheduling` |
| blocked | Something other than capacity must change | `checkout_busy`, `node_offline`, `stop_pending`, `dismissed`, `cleanup_pending`, `task_held`, `maintenance_hold`, `command_fence` |
| awaiting_approval | A "Resume now" exception waits for a person | `resume_approval` |
| starting | Sent; the Node has not acknowledged the turn | `resuming`, `dispatched` |
| running | The Node acknowledged the turn | `running` |

Same-checkout and same-Node concurrency are distinct. `checkout_busy` names the
live sessions holding the worker's checkout (a Node with managed worktrees
treats every live non-lead session as holding its checkout; the legacy key is
the placement). A settled task worker occupying it is parked by the scheduler
before the handoff, so that wait clears by itself; a session no task manages
keeps the checkout until whoever uses it stops it. Sessions in different
checkouts on one Node never block each other while the Node has capacity.

**Resume now** (task page, worker transcript banner, `POST
/api/runs/:id/steps/:stepId/resume-now`, or `fleet_request_resume`) first runs an
ordinary scheduling pass. If that starts the worker, nothing else happens. The
only restriction it can ever turn into an exception is `node_headroom`: the Host
keeps the last slot of a multi-slot Node free, and a person may approve spending
it once while the Node's hard limit still has room. Every other reason is
returned as the answer with no request created.

An exception is a durable, versioned request (`worker_resume_requests`) bound to
the step attempt, retained session and its Copilot conversation, Node,
placement and exact checkout, the queued prompt's digest, and the set of
sessions holding that Node's slots. Its dialog shows all of those, the
restriction and the risk, with **Approve once** and **Cancel request**; **Review
later** decides nothing. Only a signed-in browser operator may decide
(`POST /api/worker-resume-requests/:id/decision` with the displayed version and
fingerprint); Node, MCP and no-login principals are refused, and an
orchestrator cannot approve its own request. Chat text, tool arguments, YOLO
mode and other approvals are never consent.

Approval runs a fresh scheduling pass and recomputes the binding. A changed
binding — another session on the Node, a new writer in the checkout, an offline
Node, a replaced follow-up, a human or maintenance hold — makes the request
`stale` and launches nothing. The approved exception reaches the planner only
while that binding still holds, applies only where the reserved slot is the one
remaining obstacle, and is spent in the same transaction as the resume receipt,
so it launches at most once across repeated clicks, concurrent decisions,
scheduler races and Host restarts. The existing resume path then restores the
same conversation and sends the step's already-queued prompt exactly once; the
request becomes `launched` only when the Node acknowledges that turn, or
`failed` with the Node's reason. Cancellation and expiry (10 minutes to decide,
2 minutes to launch after approval) leave the follow-up queued; an orchestrator
whose request was cancelled or ignored is refused another for the same attempt
for 30 minutes. Requests, decisions and outcomes are written to the security
audit log; approvals, cancellations and launch outcomes are also task notes.
Requests are not carried in backups, and a restore clears them.

A person's own prompt into a worker that has a queued follow-up is stamped with
that follow-up's attempt; the engine forgets that turn's completion receipt
when it sends the queued prompt, so the earlier turn cannot settle the queued
one before the Node acknowledges it.

The manual session **Resume** control applies the scheduler's checkout rule to
task workers and reviewers: it refuses (`409 checkout_busy`, naming the holder)
while another live session holds the checkout the worker would write to.
Sessions no task manages, and orchestrators, keep the control unchanged.

## Worker delivery and publication

The orchestrator delegates, judges and coordinates rather than mutating the
repository itself. Its own restriction is not a ban on authorized writing
workers committing, creating source branches, pushing or creating/updating PRs
when the human requested that deliverable. Ordinary workers use their actual
checkout/provider permissions; the Host records their results and mediates
permission requests, rather than exclusively performing all publication.

Publication of a slice is not whole-task completion. `fleet_submit_task` neither
creates a PR nor grants worker publication authority, and is not a prerequisite
for an authorized worker to publish a slice. Keep its output recorded and the
parent open until every essential success criterion has evidence. Do not mark
unmet criteria met to obtain publication. Report the PR URL, provider-observed
source/head and base repositories, refs and commit SHAs, verification results
and limitations. On denial, keep the patch and report the exact refusal.

This does not grant read-only work publication authority, bypass managed-worktree
sealed-result/integration/publication approval gates, or replace authenticated
PR-maintenance authorization and prepared-batch admission. It does not change
checkout leases, access settings or provider policies.

Briefs specify deliverable, scope, authoritative links/paths, necessary decisions
and constraints, and observable acceptance. The worker chooses investigation,
implementation and commands from repository conventions. Necessary detail is
welcome; distinguish historical facts from current observations and avoid copied
histories or invented runbooks that contradict the deliverable.

Workers report completion or blockers in their normal response. Node ACP prompt
completion emits `turn_complete` followed by `idle`; the Host persists those
events and the existing engine settles the step and wakes its orchestrator.
A successful turn records the report, not proof that all task criteria are met.
There is no additional worker submission MCP or polling loop for this contract.

## PR maintenance lifecycle

Maintenance registration lifecycle (`active`, `paused`, `merged`, `closed`) and
batch settlement are independent of the implementation task's state. Discovery
includes completed-task registrations and terminal/paused work needing settlement.
Existing lead wakes handle due observation and reconciliation; there is no new
timer or direct-to-worker observer. A completed task is not reopened just to make
its lead eligible for a reminder. Idle-lead status checks fire on the operator's
orchestrator heartbeat schedule (cron, Host local time), and a PR's next routine
check is the first heartbeat at least half an hour after its last observation.
A PR whose retained worker is still running an accepted batch is not claimed;
the completed turn requests the next check.

The [technical flow diagrams](pr-maintenance-technical-flow.html) show the MCP tools
and REST actions that start, change and end maintenance, the per-wake observation
and repair sequences, the registration and batch lifecycles, and the stage
projection precedence.

V1 permits one retained PR registration per task, including paused registrations.
Task and MCP reads include historical terminal/released jobs. A later PR can reuse
the same existing worker only after prior ownership is explicitly released or
verified terminal work is fully settled. History is not erased.
A known new publication invalidates the pre-push observation for new work and
readiness. Finding dispositions are scoped to their verified code HEAD; after an
external commit, unchanged feedback can be revalidated without losing its history.

Azure DevOps and GitHub share this lifecycle. Schema-v1 GitHub identities/backups
remain readable; ADO adds a provider discriminator, canonical `dev.azure.com`
organization, project GUID and repository GUIDs. Ownership keys include the ADO
organization, so equally named projects/PRs in another organization cannot collide.
Full branch refs remain case-sensitive. Same-project forks are supported when
their identity can be pinned; unsupported topology requires human handling.
The packaged `snapshot.mjs` routes canonical/legacy PR URLs without manual JSON
translation. Azure CLI authentication is Node-local and distinct from Host sign-in;
no personal skill, automatic login, extension installation or credential transfer.
Unknown/incomplete policy evaluations and raw positive reviewer votes cannot prove
ADO readiness. The [ADO contract](../apps/node/skills/pr-maintenance/ado-contract.md)
describes bounded reads and supported evidence. Ready never completes a PR or sets
auto-complete. The original diagrams' GitHub labels represent either provider;
the authorization/repair flow has not changed.
Readiness always requires both check-policy and review-policy completeness,
including when some visible checks/reviews already pass. Complete collection
with unknown policy approval may still support bounded local feedback triage;
it cannot certify ready. Retrieval, identity or consistency failures cannot
be treated as complete collection.

The authenticated task action surface is
`GET/POST /api/runs/:id/pr-maintenance`. Enablement names the exact PR, stable
head/base repository IDs and full refs, owned worker, baseline, verification,
publication scope, budgets and current prerequisite evidence. Pause/resume/release
use `recordId` and `expectedVersion`; stale input is a conflict, not permission to
overwrite newer state. MCP may propose bounded maintenance but cannot fabricate
the browser operator's authorization. Maintenance is repair-only: enablement
requires verified observation and publication prerequisites. Legacy
observation-only grants and proposals remain readable but authorize no writes and
cannot be approved, resumed or renewed; they need a new pinned repair proposal and
authenticated authorization. Unsupported immutable/standalone bindings still fail closed.

The default task action sends a preparation request (optional PR URL only) to its
existing Orchestrator through the existing prompt delivery mechanism. Durable
deliveries deduplicate while pending; a settled request can be deliberately retried.
`fleet_prepare_pr_maintenance` validates fresh provider metadata against the URL,
derives the owned task baseline and sole coding worker, and returns explicit
choices rather than guessing when ambiguous. `fleet_propose_pr_maintenance`
retains the advanced exact-scope capability. Both save a durable, unapproved
proposal for an existing eligible worker. They change neither task state nor
maintenance authority and dispatches no worker. The operator receives an existing
task notification and reviews the prefilled authorization dialog. Approval uses
`authorize_proposal` with the captured proposal ID/version, then revalidates the
binding through normal operator enablement. A changed proposal requires review
again; task approval is not maintenance approval. Proposals survive backup and
restart without acquiring authority. Read them through
`fleet_get_pr_maintenance(taskId)` or the existing task discovery surfaces.
Preparation is repair-only; there is no observation-only default and an explicit
observe mode is unsupported. `publicationEvidence` for verified existing task and
publication authority is required; without it preparation is refused
(`publication_evidence_required`) and no proposal or write grant is created.
Replies, thread resolution, named reviewer requests and CI retries default off and
must be requested separately. The returned mode and action flags mirror the stored
proposal. Operator approval cannot silently reinterpret read-only scope as repair authority.

The stage rail is a projection of current durable facts, not another scheduler or
agent-maintained status string. It distinguishes observation/recovery, triage,
addressing feedback, check/review waiting, readiness, holds and terminal history.
Completed maintenance rounds count executed, settled batches only; reservations,
cancelled-before-dispatch batches and provider review iterations do not count.

Failed/partial reads retain the exact sanitized error, bounded helper continuation,
20-incident history and monotonic incident cursor. One unresolved capability incident
queues one deduplicated prompt through existing lead delivery. Recovery requires a
claimed visit and a pre-I/O `alternate_attempt` reservation (stable resolution ID,
source/method/evidence reference, charged requests), followed by `alternate_observation`.
Three attempts per incident survive restart; lost/unused reservations stay charged.
The Host pins identity, bounds freshness and stores the resolution receipt.
Fresh complete alternative evidence may resolve a helper capability limitation;
partial evidence remains incomplete. Actual provider access denial, identity drift,
Stop, design holds and unknown execution/effects are never cleared by alternate reads.
No new polling service or credential changes are introduced.

| Action | Maintenance effect |
|---|---|
| Task Approve / aggregate | Reject a pending design decision; readiness does not authorize completion or redesign |
| Generic task reopen, bound worker prompt/resume | Check shared admission before mutation or dispatch; cannot clear a decision |
| Send back with instructions | Require exact record/decision versions and a nonempty bounded note; atomically preserve direction, task history and review resolution |
| Pause or Stop/archive | Inhibit new repairs and request targeted cancellation; preserve accepted work/effects and pending human question |
| Delete/cleanup | Pause first; reject while ownership or unsettled work still protects the task/session |
| Resume maintenance | Revalidate current binding/authorization and matching direction; does not undo an explicit worker Stop |
| Release | Explicit operator disposition after settlement; retain history and require a new generation for later enablement |
| Observed merge/closure | Stop new work, drain accepted work/effects, then release only when settlement is established |

`prepared`, `accepted`, `reconciling`, and `uncertain` batches remain outstanding.
Worker “done”, Node offline, timeout, and a Stop request alone cannot settle
publication or replies. Per-finding stages preserve a verified/published fix whose
reply remains incomplete. An explicit pause does not silently resume on reconnect.
Unknown execution/effects do not expire out of retention protection.
Paused ownership has no automatic expiry. The 30-day reminder asks an operator to
resume or release; polling and reconnects do not renew that age.

The small task panel displays last successful observation separately from the
next due time, exact worker/provider/ref binding, remaining budgets and pending
direction. Refresh after a stale-version error before reviewing another action.
Mounted maintenance panels refresh on existing fleet snapshots independently of
task timestamps. An open Send-back dialog retains its original decision and
proposal; a changed reference requires reviewing the new decision explicitly.
No-login mode cannot provide an authenticated maintenance authorization.

This pilot supports only an already eligible mutable Orchestrator worker.
Published/sealed/cleaned managed results and standalone ownership handoff are not
made mutable by maintenance. V1 never merges or force-pushes. Cadence and workflow
budgets are best effort, not a hard SLA or shell sandbox; production repair rates
and the proposed repeated model evaluations have not been established by unit
tests.
Pilot defaults are three repair batches, three answer-only batches and 100
external mutation attempts per authorization. An existing lead wake admits at
most five PR visits, 40 provider requests and 120 seconds of maintenance work,
with persisted carried scan progress. **Renew maintenance budgets** authorizes
another allowance for the same scope; it neither changes design authority nor
automatically resumes paused work.
