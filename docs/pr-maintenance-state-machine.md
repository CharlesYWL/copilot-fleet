# PR maintenance state machine (v2)

This document replaces the overlapping PR maintenance (PRM) gates with one
effective state. It records why the previous model deadlocked, the new model,
its transition table, and the safeguards that remain.

## 1. The previous model and its circular dependencies

A v1 registration was governed by several partly independent state machines:

| Fact | Where | Values |
| --- | --- | --- |
| Lifecycle | `record.lifecycle` + `pauseReason` | `active`, `paused` (any string), `merged`, `closed` |
| Underlying task | `run.state` | `running`, `awaiting_human`, `completed`, ... |
| Decision | `record.decision.state` | `pending`, `directed`, `withdrawn` |
| Continuation | `record.continuation` | `checking`/`handback`/`consumed`/`cancelled` × `pinned`/`refresh_required` |
| Routine work | `record.workRequests[]` | `pending`/`completed`/`cancelled` |
| Budgets | `authorization.budgets` vs `counters` | repair / answer / mutation allowances |
| Stage (UI) | `prMaintenanceProgress()` | 15 values |
| Effective (UI) | `effectiveState()` | 6 values, computed by re-running admission |
| Admission | `admission(action)` | 30+ refusal reasons |

The reproduced failure (task `6a90f324…`, record `fee038d4…`) followed these
edges:

1. **Enrollment inherited the task hold.** `enable()` paused a new registration
   with `task_human_hold` because the task was `awaiting_human` for an unrelated
   product question.
2. **Resume changed only lifecycle.** `applyResume()` set `active`, but
   `effectiveState()` re-ran `admission("discover")`, which still refused.
3. **Refresh vs. task hold (the deadlock).** Continue created a continuation in
   `refresh_required`. Applying it required a fresh observation, but
   `admission("discover")` refused every read with `wait_for_human` while
   `run.state === "awaiting_human"`. Only a PRM decision could exempt the read,
   and this record had none.
4. **Orchestrator session vs. operator intent.** `dispatch()` paused every
   registration owned by a lead whose session was stopped, cancelled, or whose
   connection failed. `pause()` cancelled the continuation and, when a stop
   flag was set, the routine-work requests.
5. **Manual vs. scheduled work.** A manual Continue went through `takeDue()`,
   which charged a visit before admission, so a refused refresh still consumed
   the turn's allowance.
6. **Budgets as authorization.** Exhausted batch budgets required a separate
   Renew action before any further work.

## 2. The simplified model

One authoritative status is derived from durable record facts by
`prMaintenanceStatus(record)` in `@fleet/protocol`. The Host overlays only
facts it alone knows (retained-worker binding and pending session
permissions).

### Phases

| Phase | Meaning |
| --- | --- |
| `reviewing` | A review is requested or in progress: the orchestrator refreshes provider state and classifies feedback. |
| `working` | The retained worker is executing an accepted batch. |
| `idle` | No worker is active, no review is pending, and no decision is pending. |
| `waiting_for_decision` | The only normal human pause: a genuine design ambiguity, or the no-progress guard. |
| `merged` / `closed` | Detected provider terminal state. PRM records it and stops; it never merges. |

### Holds (exceptional, orthogonal to phase)

A hold stops **automatic** maintenance: worker dispatch and new effects. It never
refuses a person's or the orchestrator's direct turn on the worker, and it does
not stop read-only refresh unless noted. Queued maintenance work it cancels
settles at once with no effects and is never replayed.

| Hold | Set by | Cleared by |
| --- | --- | --- |
| `stopped` | Explicit Stop/cancel/delete of the retained **worker**, or cancel/archive of the **task** | Resume (operator) |
| `paused` | Explicit Pause (operator or owning lead) | Resume; newer operator direction |
| `access` | Provider authentication or permission denial | Resume (operator) |
| `identity` | Provider identity or pinned ref changed | Resume (operator) |
| `manual_control` (legacy) | Never set any more; a stored manual-control hold (v1 or v2) is read as `paused` | Resume (operator) |
| `reconciling` (derived) | Uncertain execution or external effect | Reconciliation evidence |

Stopping, cancelling, or losing the **orchestrator** session no longer changes
PRM. The record continues when the orchestrator next runs.

### Durable review request

`record.review` is the single durable "a review is owed" fact:

```text
review = { id, source, requestedAt, actorId?, wakeKey?, wakeQueuedAt?,
           claimedAt?, concludedAt?, outcome?, summary? }
source  ∈ enable | heartbeat | manual | worker_result | direction | resume |
          handback | recovery | migration
outcome ∈ working | decision | idle | terminal | failed | held | abandoned
```

Requests coalesce: while a review is open, another request records nothing
new, so a heartbeat and a manual trigger cannot produce two reviews or two
batches. Manual requests never write `nextCheckAt`.

## 3. Transition table

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| — | Operator authorizes proposal | owned task + writing worker | `reviewing` | review(`enable`) queued; no task-state inheritance |
| `idle` | Heartbeat | `nextCheckAt ≤ now`, no hold | `reviewing` | review(`heartbeat`) claimed by `takeDue` |
| any non-terminal | Manual **Review now** (UI or orchestrator) | no stored hold | `reviewing` | review(`manual`); bypasses `nextCheckAt` without changing it |
| `reviewing` | Complete observation, merged/closed | — | `merged`/`closed` | pending decision withdrawn as moot |
| `reviewing` | Lead prepares a work order and worker accepts it | no hold, no pending decision, fresh evidence for that head, no direct work running | `working` | review concluded `working` |
| `reviewing` | Lead escalates a genuine design decision | — | `waiting_for_decision` | notification; review concluded `decision`; task state untouched |
| `reviewing` | Lead records `review_done` | — | `idle` | review concluded `idle` |
| `reviewing` | Observation fails (non-access) | — | `idle` | review concluded `failed`; heartbeat retries; capability recovery wake if applicable |
| `reviewing` | Lead turn ends without outcome | no helper command in flight | `idle` | review concluded `abandoned` |
| `working` | Worker step settles | — | `reviewing` | Host settles the batch from the worker's `prm.work-report/1`; review(`worker_result`) woken immediately. An unreadable report leaves the batch `reconciling` with `settlementError` (recovered only by `work_report`) |
| `working` | Same finding group: 3 attempts without progress, or flips back to an earlier state | — | `waiting_for_decision` | Host-raised decision (no cap on total batches) |
| `waiting_for_decision` | Direction recorded (PRM panel or orchestrator chat in a user turn) | matches pending decision | `reviewing` | review(`direction`); clears a `paused` hold; no second Resume |
| any | Explicit Pause | — | hold `paused` | undispatched batch settled `cancelled` with no effects (never replayed); in-flight attempt asked to stop; queued operator work kept |
| any | Explicit worker/task Stop | — | hold `stopped` | as above |
| any | Direct turn on the worker or checkout | no maintenance turn running there | unchanged | undispatched batch yields: settled `cancelled` (`direct_work`), never replayed; no hold |
| any | Release (operator) | always | `released` | history kept; pending decision withdrawn; queued work cancelled; nothing new starts; a running attempt is asked to stop but is still admitted, settled (automatically or `work_report`) and blocks direct writes and cleanup until it settles |
| any | Provider auth/permission denial | — | hold `access` | — |
| any | Provider identity change | — | hold `identity` | — |
| hold | Resume (operator; lead only for its own pause) | binding intact, task not cancelled | hold cleared → `reviewing` | review(`resume`) |
| `working` | Uncertain effect | — | derived `reconciling` | new effects refused until reconciled |

### Admission

| Action | Refused only when |
| --- | --- |
| `discover` (read-only refresh) | released, terminal or `stopped` |
| Prepare/accept a batch | any hold, pending decision, unsettled work, broken binding, stale or mismatched evidence for the batch head, draft, unplanned conflict, direct work running on the worker (`direct_work_active`) |
| Execute an accepted batch | any hold, pending decision, broken binding, uncertain execution, direct work running |
| Direct write to the worker/checkout (prompt, follow-up, new step, resume, command) | only while a dispatched maintenance turn is still executing there (`maintenance_in_flight`); never for a hold, pause, release, decision or awaiting-human task |
| Approve/advance/submit/aggregate the task | in-flight maintenance work |
| Reopen the task | never |
| Cleanup of retained resources | always (`maintenance_retention`) until released |

The underlying task's `awaiting_human` or `completed` state no longer affects
admission. Maintenance batches dispatch even while the task waits for an
unrelated review, and never change the task state.

## 4. Safeguards that remain

- Never merge or enable auto-complete. History is rewritten only to resolve a
  straightforward merge conflict in a `conflictResolution` batch: the worker
  rebases onto the current base and force-pushes to the same PR branch with
  `--force-with-lease` on the exact HEAD the batch was prepared from. Workers
  report the head each push replaced (`expectedRemoteSha`). Any other forced
  push, or a push that replaced an unexpected head, is recorded as a fact
  (`batch.lineage` `rewritten`), the batch settles, and a system `paused` hold
  asks a person to look. It replaces an orchestrator pause (which the orchestrator then
  cannot clear); a person's hold keeps its kind and gains the reason. Either
  way an attention notification is raised, also for released records.
  The next observation after a published batch records `reported` (or
  `leased_rewrite`) when the new head is the commit the batch reported
  pushing, even without `expectedRemoteSha`, and maintenance continues;
  `fast_forward` needs provider compare evidence (`headLineage`). A move
  nothing recorded explains is `unverified` and pauses until a person
  resumes. Fleet does not check ancestry itself. Unknown remote changes,
  user work, ambiguous conflicts and design questions stop the worker without
  pushing.
- Maintenance dispatch only: a Node advertising `checkout-precondition`
  refuses the batch prompt unless the checkout is clean and HEAD is the
  batch's head; an older Node is never sent the prompt
  (`node_upgrade_required`). Either way the batch settles unsent with zero
  effects and a design decision asks a person. A refusal counts only for the
  exact dispatched command while its step is still starting.
- Exact provider/repository/PR/source-ref identity and retained worker binding.
- Explicit Stop, authentication and identity holds.
- Uncertain effects are reconciled before new effects or retries.
- Untrusted PR text is data, never instructions (work-order rules).
- Readiness is not task acceptance; PRM never approves the task.
- Genuine semantic changes still escalate to `waiting_for_decision`.
- Idempotent operator actions (`requestId`), exact immutable batch prompts.
- Full audit: observations, decisions, review history, hold history, batches,
  effects and findings.
- Per-turn read limits (5 visits, 100 requests, 5 minutes) bound one
  orchestrator turn; a manual review is always delivered in its own turn.

Removed: batch/mutation budgets and Renew, continuation objects, `task_human_hold`,
lead-session pause, the coupling between task review and PRM decisions, and the
observation-failure/scan-stall pauses (failed reviews return to `idle` and the
next heartbeat retries).

## 5. Simplifications (2026-10)

- **Direct work is never blocked.** PRM reserves nothing against an explicit direct turn, whether the record is
  active, paused or released. One writer runs at a time: direct work goes first and queued maintenance yields to it;
  only a maintenance turn already executing makes a direct write wait. Direct turns set no hold.
- **Pause and Release are simple.** Pause stops automatic actions only; undispatched batches settle as cancelled
  with zero effects and never replay; operator work survives. Release always succeeds (idempotent, no version or
  decision reference needed) and keeps history, including unsettled evidence.
- **One editable grant.** *Maintain this PR* covers code repairs, normal pushes, replies and resolving addressed
  threads by default. The operator edits permissions in place (`scope` action, recorded in `scopeHistory`);
  narrowing cancels queued, unsent batches so they are re-prepared, and a no-op edit changes nothing.
- **Host-owned ingestion and settlement.** The Host ingests claim-bound helper output and settles work-order
  batches from the worker's report. The lead tool refuses large observation relays, alternate evidence, hand-built
  `prepare_batch` and per-finding `batch` settlement of work orders. `work_report` is the single settlement recovery
  path; re-running the helper on the next review is the single observation recovery path. The report is read
  only from the attempt's own event range (`eventSeqFrom`..`eventSeqTo`, fixed when execution settles).
- **Conflicts.** A `conflictResolution` work order rebases onto the current base and force-pushes with an exact
  lease; see Safeguards.

## 6. Migration (registry schema 3 → 4, record v1 → v2)

Each stored v1 registration is converted once on Host start, and v1 records in
portable backups are converted on import:

- `lifecycle: paused` becomes `active` plus a stored hold. `stopped` → `stopped`;
  `authorization_failed` → `access`; `remote_identity_changed` and
  `continuation_identity_changed` → `identity`; anything else, including
  `manual_control`, → `paused` with the original reason. A stored v2
  `manual_control` hold is also read as `paused`.
  A pending decision becomes `waiting_for_decision` without an extra hold.
- Paused records stay held until the operator presses **Resume** once.
- `continuation`, `continuationHistory`, `resumeHistory` and `pauseOrigin` move to
  `legacyAudit`. Work requests keep their recorded state.
- Budgets are retained on the grant for audit but no longer enforced.
