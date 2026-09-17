# Orchestration lifecycle

Orchestration control uses separate persisted facts:

- The run and step state controls scheduling.
- The session state records the latest worker state reported by a Node.
- `stopRequested` records an unacknowledged Stop across disconnects and restarts.
- `dismissed` controls visibility only.
- `stoppedByOrchestrator` identifies unfinished steps that Resume may continue.

## Operation contract

| Existing state | Stop | Dismiss | Resume |
|---|---|---|---|
| Pending or dependency-waiting step | Run becomes `cancelled`; step becomes `cancelled` and is marked resumable | No execution change | Marked step returns to `pending`; dependencies are re-evaluated |
| Starting, queued, or running step | Same persisted cancellation; worker receives Stop and remains in its reported state until acknowledgement | Rejected while the lead is live | Rejected until every Stop is acknowledged |
| Succeeded step | Preserved | No execution change | Preserved and never dispatched again |
| Failed step | Preserved | No execution change | Preserved; descendants remain blocked |
| Skipped or independently cancelled step | Preserved | No execution change | Preserved |
| Offline worker | Stop intent remains persisted and is reissued if the Node reports the session after reconnect | Rejected until the lead is terminal | Rejected while execution is unknown |
| Terminal worker | Preserved | No execution change | Reattached only when its step was marked by orchestration Stop |
| Live lead | Owned runs are cancelled before any stop command is sent; the lead records `stopRequested` | Rejected | Rejected |
| Terminal lead | Idempotent; any still-live owned run is cancelled | Allowed only after owned work settles; visibility changes and history remains stored | Lead is reattached, then eligible stopped runs reopen |

Dismiss and restore never change run, step, or worker state. A dismissed lead and
its tasks remain in persistence and continue accepting late terminal events.

An unexpected lead failure, including failure to restore MCP tools, does not
require stopping its workers before Resume. Resume reattaches the existing lead
conversation while workers in ongoing tasks keep their sessions and progress.
Outstanding Stop requests still block Resume. Runs cancelled by orchestration
Stop additionally wait for their workers to be terminal or idle before reopening.

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
marked by the orchestration Stop transaction.

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

## PR maintenance lifecycle

Maintenance registration lifecycle (`active`, `paused`, `merged`, `closed`) and
batch settlement are independent of the implementation task's state. Discovery
includes completed-task registrations and terminal/paused work needing settlement.
Existing lead wakes handle due observation and reconciliation; there is no new
timer or direct-to-worker observer. A completed task is not reopened just to make
its lead eligible for a reminder.

The authenticated task action surface is
`GET/POST /api/runs/:id/pr-maintenance`. Enablement names the exact PR, stable
head/base repository IDs and full refs, owned worker, baseline, verification,
publication scope, budgets and current prerequisite evidence. Pause/resume/release
use `recordId` and `expectedVersion`; stale input is a conflict, not permission to
overwrite newer state. MCP may propose bounded maintenance but cannot fabricate
the browser operator's authorization. Unknown helper/credentials/publication
evidence and unsupported immutable/standalone bindings fail closed.

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
