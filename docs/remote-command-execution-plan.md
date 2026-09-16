# Approved remote command execution

Status: Review-amended implementation plan; feasibility gates remain open.
Date: 2026-09-16
Repository: copilot-fleet
Review baseline: `80a01c02a6990fcfde4b93abf3109b430ac7ed3c`.

This revision incorporates the source-checked Opus feedback R1-R6. It changes the
plan only: no execution feature, supervision guarantee, or migration described
below has been implemented or experimentally proven by this document.

## 1. Outcome

An Orchestrator can request a shell command on a registered Node and workspace
checkout, receive human approval, and inspect the actual result without starting
a Copilot worker. Examples include finding a branch, running Git commands,
installing dependencies, and running `npm run build` or `npm test`.

MCP is the agent-facing interface. The Host owns authorization, approvals,
execution history, scheduling, and completion delivery. The Node owns processes,
local paths, execution limits, and recovery evidence. The browser receives live
output over the existing Fleet WebSocket connection.

This is general remote code execution by a trusted operator, not a read-only
probe or a filesystem sandbox.

## 2. Scope and proposed decisions

| Area | First release |
| --- | --- |
| Agent interface | Three tools: request execution, read execution, cancel execution. |
| Commands | Noninteractive, finite shell commands/scripts, including Git and npm. |
| Target | An exact registered placement or eligible mutable managed checkout. Sealed, reviewed, composed, or integrating managed targets are excluded. |
| Shell | Windows PowerShell 5.1, explicitly named `windows-powershell-5.1`. PowerShell 7 and a direct cmd shell adapter are deferred, not silent fallbacks. |
| Approval | Explicit allow-once or deny for every new execution, including Git reads. No inherited YOLO or blanket approval. |
| Working directory | Resolved and pinned by Fleet for each execution; no persistent shell state. |
| Output | Live browser output, bounded retained logs, and an Orchestrator completion notification. |
| Task association | Optional; standalone inspections do not create a Run or Session. |
| Platform rollout | Windows execution first, after extending and proving Job Object supervision. The lead may be elsewhere, but its Node must independently support durable wake delivery. |
| Node control | Local opt-in, default off. The Host cannot remotely turn this setting on. |
| Admission | Every Fleet-admitted participant on an eligible repository must honor shared cross-installation exclusion, including legacy/source-placement sessions. |
| Public API names | Proposed names in this plan; not currently implemented. |

Out of scope: interactive terminals/PTYs, stdin conversations, permanent services
such as an indefinitely running dev server, SSH, a new MCP server on every Node,
arbitrary executable paths supplied as the shell, environment/secret injection,
new sandbox infrastructure, and automatic retries of commands. A human-facing
"Run command" composer can follow later; approval, inspection, and cancellation
UI are required in the first release.

A command can contain `cd` or invoke other programs. Target selection only fixes
its initial directory. Neither that directory nor a Fleet checkout lease contains
arbitrary code within the selected workspace.

Do not cut approval, local opt-in, supervision, durable evidence, or bounded
output to accelerate delivery. Cut optional shell editions, target states, and UI
breadth first.

## 3. Existing code to build on

Paths below are relative to the repository root.

| Existing surface | Relevant behavior / planned integration |
| --- | --- |
| `packages\protocol\src\index.ts` | Separate Node-scoped messages already exist alongside session commands. Add capability-gated execution messages; do not add fake session IDs. |
| `apps\host\src\orchestrator\mcp-routes.ts` | Authenticates live lead principals; uses per-request stateless JSON responses. Register the new tools behind the same principal checks. |
| `apps\host\src\orchestrator\tools.ts` | Shared advertised/validated schemas and scoped task lookup. Add request/read/cancel methods and target discovery. |
| `apps\host\src\orchestrator\engine.ts` and `fleet-service.ts` | Current per-tick prompt exclusion is not durable across ticks. Add a persisted per-lead in-flight reservation shared by all prompt producers, including leads without a Run. |
| `apps\host\src\store.ts` | SQLite transactions, durable transitions, security audit, and Run wake bookkeeping. Add execution-specific records and invariants. |
| `apps\host\src\gateway\node-socket.ts` | Authenticated message dispatch and Node receipt validation. Route execution events and reconciliation. |
| `apps\node\src\main.ts` | Already handles `repository_probe` outside Copilot sessions. Wire the command runner, inventory, settings, shutdown, and update coordination here. |
| `apps\node\src\process-quiescence.ts` and `windows-process-job.ts` | Existing Job Object helper starts suspended and kills descendants on root exit, but lacks an independent runtime deadline and Node-parent-loss policy. Extend it before reuse. |
| `apps\node\src\checkout-locks.ts`, `canonical-path.ts`, and `router.ts` | Physical identity and durable managed leases are useful; unbound sessions currently skip those leases, and checkout/admin keys are independent. Admission must change in both directions. |
| `apps\node\src\updater.ts` and `main.ts` | Update mutates Git/dependencies before shutdown. A maintenance barrier must precede the first mutation, not just the restart. |
| `apps\host\src\managed-worktree-service.ts` and `store.ts` | Finalization short-circuits on existing `resultSha`; sealed artifacts are immutable. Reject protected managed targets instead of clearing observations and promising resealing. |
| `apps\node\src\settings.ts`, `node-capabilities.ts`, and config-server surfaces | Add local opt-in and advertise actual supported shells and availability. |
| `apps\node\src\outbox.ts` | Existing buffered events are session-specific and in memory. Its acknowledgment pattern is useful, but it is not a durable command journal. |
| `apps\host\ui\src\hooks\useFleet.ts` and existing notification components | Add execution metadata updates and bounded live output without putting all logs in the initial snapshot. |
| `apps\host\ui\src\components\PermissionBanner.tsx` | Reuse visual conventions, but provide a full command approval detail view rather than an ellipsized command title. |

Important distinctions:

- `repository_probe` checks registered workspace repositories, not just the Fleet
  source repository. Keep its managed-worktree behavior unchanged.
- `GitRunner` is specific to Git and buffers output. Do not turn it into a generic
  shell runner or route npm through it.
- Existing wake counters and envelopes are Run/worker-specific. Reuse the
  scheduling discipline, not synthetic worker completion events or the existing
  mark-before-send delivery helper unchanged.
- Modern lead startup uses `coordinator: true` and a private coordinator
  directory. Preserve this behavior; do not assume every standalone lead holds
  its source checkout or silently stop the requesting lead.
- The existing supervision crash test kills the helper, not the Node parent.
  That is not evidence that a silent command stays bounded after Node death.

## 4. Proposed MCP contract

### `fleet_run_command`

Inputs:

- `target`: exactly one of `{ placementId }` or `{ worktreeId, generation }`.
- `command`: exact command/script text; bounded and NUL-free.
- `shell`: the exact advertised edition, initially `windows-powershell-5.1`.
- `reason`: a short explanation shown to the approver.
- `timeoutMs`: bounded by Host and Node policy.
- `requestKey`: caller-generated idempotency key.
- `taskId`: optional existing task owned by this Orchestrator.

Resolve and record Node identity, physical checkout identity, generation, absolute
cwd, shell executable, script text, execution limits, and requester before asking
for approval. A subdirectory selector can be added later; an approved command may
use `cd` when needed.

The Host cannot canonicalize a remote path itself. Resolve the catalog entry on
the Host, then have the Node prepare a descriptor using fixed path/shell metadata
checks, without running the submitted command or acquiring a writer lease.
Only a successfully prepared descriptor can enter `awaiting_approval`; stale or
changed physical identity requires new preparation and approval.

A managed target implies its owning task even if `taskId` was omitted. Require
that task to belong to the requesting lead, and reject a conflicting explicit
task ID. A placement alias into a managed checkout must not bypass its binding,
ownership, or lease requirements.

Apply the managed-target eligibility rules in section 9 and check durable
delivery support on the lead's Node before accepting work. Never substitute a
source placement when the requested managed checkout is ineligible.

Example tool input:

```json
{
  "target": { "placementId": "placement-id-from-discovery" },
  "command": "npm run build",
  "shell": "windows-powershell-5.1",
  "reason": "Check whether the current workspace builds",
  "timeoutMs": 300000,
  "requestKey": "build-check-001"
}
```

The normal response is immediate:

```json
{
  "executionId": "execution-uuid",
  "status": "preparing",
  "nextAction": "End this turn; Fleet will notify you when the execution settles."
}
```

The response identifies the Node and requested catalog cwd; the approval view
shows the Node-verified physical cwd. `awaiting_approval` may be returned if
preparation has already completed. Invalid targets,
unsupported execution/delivery combinations, forbidden ownership, and exhausted
admission limits return explicit errors. No submitted command starts as part of
this MCP request.

Idempotency is scoped to the authenticated Orchestrator and request key. Repeating
the same key and payload returns the existing execution. Reusing it with changed
execution-affecting input is a conflict. A deliberate rerun needs a new key and
new approval. Retiring verbose history does not retire key identity; section 8
defines the retry horizon and compact tombstones.

### `fleet_get_execution`

Input: `executionId`, optional `afterSeq`, a bounded output limit, and optional
`format: "text" | "raw"` (default text).

Return status, target, timestamps, exit code or signal where known, failure reason,
process-ownership state, forced descendant cleanup, stdout/stderr events, and
`nextSeq`, `hasMore`, `finalOutputSeq`, and explicit dropped/truncated ranges.
Expose `outcomeKnown`, `outputComplete`, and text encoding/loss indicators
separately. Raw pages preserve retained bytes using bounded Base64 payloads.
Exit code is nullable: denial, spawn failure, and unknown completion are not
successful zero exits.

Authorize ownership on every call. This is for retrieving additional evidence,
not a polling loop. Extend existing discovery/task details with recent execution
IDs so an Orchestrator can recover after losing a tool response.

### `fleet_cancel_execution`

Undispatched work cancels without spawning. Once a start has been dispatched,
record durable cancellation intent and remain `cancelling` until the Node proves
either no launch or verified termination. Host cancellation cannot retroactively
retract a start already in flight. Repeated cancellation is idempotent; operators
can also cancel through the UI.

## 5. Host execution lifecycle

Use a dedicated execution record, not a Session or a fabricated worker RunStep.

Normal lifecycle:
`preparing`, then `awaiting_approval`, `queued`, `starting`, `running`, and finally
`succeeded` or `failed`.

Additional outcomes:

- `denied` and `expired`: nothing started.
- `cancelled`: cancelled before start or confirmed stopped after a cancellation.
- `timed_out`: deadline exceeded and termination confirmed.
- `cancelling`: termination requested, not yet established.
- `reconciliation_required`: dispatch or process ownership is uncertain; not
  equivalent to a terminal state and never a reason to release a lease.
- `interrupted`: terminal only with proven quiescence; outcome evidence was lost,
  the Node parent died, or root exit required forced cleanup of descendants.
  Preserve a known root exit code as evidence, otherwise use null. Never infer
  success from an absent receipt or zero root exit with forced child cleanup.

Track ownership independently as `not_started`, `active`, `quiescent`, or
`unknown`. A lost outcome with proven quiescence releases the lease and settles
as interrupted. A missing or reused PID is not quiescence proof. A known root exit
with unproven descendant termination remains reconciliation-required.

Connectivity is separate from outcome. An offline Node makes a running result
unobservable, not successful, failed, or safely cancelled. A late validated Node
receipt can resolve uncertainty. A cancellation arriving after proven completion
does not rewrite success as cancellation.

Persist in SQLite:

- `command_executions`: owner, optional task, pinned target, command digest,
  command/shell, limits, approval identity/version/expiry, dispatch attempt,
  cancellation intent, state, ownership, outcome, final output watermark, and
  timestamps.
- `command_execution_events`: execution ID, monotonic Node sequence, stream or
  event kind, timestamp, and bounded payload. Unique `(executionId, sequence)`.
- Compact request/launch/cancel tombstones separate from verbose execution history.
- Durable per-lead prompt reservation and delivery receipts: recipient, logical
  delivery ID, represented completion revisions, native session/attempt identity,
  handoff state, and acknowledgment. Do not overload a single overwriteable
  session dispatch-attempt field.

Use transactional compare-and-set transitions for approve/deny/cancel/dispatch.
Persist dispatch intent before sending. A socket send or acceptance receipt is
not process completion.

Proposed initial limits, centralized and tested:

| Limit | Initial value |
| --- | --- |
| Command text | 16 KiB |
| Approval/start authorization lifetime | 30 minutes from request creation; queued work cannot start after expiry |
| Runtime | 5 minutes default, 1 hour maximum; measured from actual start |
| Node command concurrency | One running command per Node, separate from Copilot session counts |
| Unsettled request admission | 10 per Orchestrator and 32 per Node |
| Retained output | 10 MiB per execution, with explicit truncation markers |
| MCP output page | At most 64 KiB |
| Request-key retry horizon | 24 hours; older known keys return `request_expired`, never create another execution |
| Reconnect receipt/output replay horizon | 7 days for settled, quiescent jobs; unresolved identities stay protected |
| Transport/browser output queue | 1 MiB per connection, independently of log retention; pause live delivery and recover by cursor |
| Aggregate verbose-log storage | 512 MiB on Host, 128 MiB per Node; reserve 16 MiB separately for lifecycle evidence on each |
| Execution metadata/history | 30 days after settlement; unresolved ownership and delivery receipts are protected |

Count command text in UTF-8 bytes, not JavaScript characters; wire/Base64 overhead
has separate limits. Bound in-memory browser rendering independently of retained
logs. Coalesce gap ranges instead of creating unbounded per-chunk gap records.
Lifecycle receipts must not be evicted to make room for stdout. If the lifecycle
reserve cannot be maintained, close admission and surface storage pressure.
Pending requests consume admission budget, not checkout leases or processes.

## 6. Approval and authorization

Approval UI must show the full command, resolved shell, Node, cwd, task/worktree
when applicable, requester, reason, runtime limit, and expiry. Keep the command
visually separate from the agent-authored reason. Do not hide additional lines or
executable text behind truncation.

Allow-once and deny use a browser-authenticated administrator route with existing
request/CSRF protections. They are not MCP tools. Approval binds to the immutable
execution digest and expected record version; changed targets or commands need a
new request. Log requester, approver, decision, target, and execution identity.

Recheck immediately before dispatch and again on the Node:

- The requesting lead and optional task still exist and are authorized/active.
- The Node identity, local opt-in, supported shell, and policy remain valid.
- The target still resolves to the approved physical checkout and generation.
- Start authorization is unexpired, cancellation has not won, and the required
  checkout lease is available.

The Host remains authoritative for approval expiry. Preparation must establish a
bounded estimate of Host time over the authenticated channel; reject start if
clock-offset uncertainty exceeds five seconds, clock discontinuity is detected,
or the conservative expiry cannot be established. Subtract the uncertainty when
converting expiry to a Node-local deadline; never restart the authorization
lifetime on receipt/reconnect. A separate supervisor-local monotonic timer limits
runtime after release of the suspended process.

Only advertise/use the new protocol over the existing mutually authenticated,
sealed channel. Do not add execution support to legacy secret-only connections.

The Node owner enables the feature locally. Disabling it blocks new starts and
stops its active command executions using the same verified cancellation path.
Host session YOLO and task approval never substitute for command approval.

This protects trusted administration from unwanted agent requests. A compromised
Host can still act as the trusted controller when Node execution is enabled.
Approval of a command does not freeze the scripts/dependencies that it may load.
Neither parameter checks nor cwd restriction creates a sandbox.

## 7. Node runner and wire protocol

Add a focused execution manager, durable journal, and shell adapter. Reuse the
Job Object foundation but extend its supervision protocol; MCP registration and
`spawn` alone are not the difficult part. Avoid a generic job framework.

New capability: `remote-command-execution-v1`. Inventory reports local enablement,
exact shell edition, supervisor readiness, admission-protocol version,
concurrency, and active execution identities. Gate new
Host-to-Node messages on this capability and transport authentication; unsupported
Nodes remain connected and receive no unknown frames.

Add target preparation, start, cancel, reconciliation, output, acknowledgment,
and final-result messages. Bind each to Host/enrolled Node identity, execution ID,
attempt, and immutable request digest; validate with shared schemas.

### 7.1. Crash-independent supervision (R1)

Keep command-specific deadline, parent-loss, and outcome reporting behind an
explicit helper mode. Do not silently change ACP session lifetime or completion
semantics while extending the shared supervision foundation.

- The independent supervisor owns the job, its runtime deadline, and a handle to
  the Node parent with creation identity, not just a PID. Parent loss terminates
  the job; a silent command cannot outlive its limit because Node died.
- Persist execution/attempt ID, journal namespace, random job identity, supervisor
  identity, and parent identity. Create the root suspended, assign it to the job,
  configure deadline/parent monitoring, and return a readiness receipt over a
  control channel that is not submitted-command stdout/stderr.
- Node durably records that receipt and arbitrates launch versus cancellation
  before sending a one-time release. Supervisor rechecks parent liveness and
  start expiry before resuming. An outer ChildProcess `spawn` event is not proof.
- Supervisor writes a durable terminal/quiescence receipt even if Node is gone.
  Missing receipts keep outcome or ownership explicitly uncertain; reuse no PID
  to infer an old process's identity.
- On natural root exit, terminate any remaining job descendants immediately,
  then verify emptiness. Expose `descendantCleanupForced`, reason, and root exit
  code. Forced cleanup settles as interrupted, not ordinary success.
- Runtime/termination timers and parent monitoring do not depend on JavaScript
  callbacks, stdout traffic, or the Host connection. If quiescence cannot be
  proven, retain ownership and block reuse.

### 7.2. Windows transport, readiness, and encoding (R6)

- Initially support only trusted absolute Windows PowerShell 5.1 and a trusted
  absolute supervisor launcher. Do not resolve bare `powershell.exe` from cwd,
  substitute `pwsh`, or weaken execution/language policy.
- Before advertising readiness, run a fixed non-user-controlled fixture that
  proves the actual helper can establish and empty a Job Object. Installed shell
  presence is insufficient: the current C# `Add-Type` path can be policy-blocked.
- Store the exact approved script body in a per-attempt, access-controlled `.ps1`
  file encoded as UTF-8 with BOM for 5.1. Pass a short quoted file path, separate
  cwd, closed stdin, and noninteractive/no-profile arguments. Do not embed user
  script text in the helper's Base64 command line. Use file/short-control-channel
  transport for the helper too, and check every generated command-line length.
- Preserve the approved script bytes/line endings in its digest. Clean up exact
  script paths only after proven quiescence and durable receipt persistence;
  uncertain attempts are quarantined for recovery.
- Propagate explicit script exits and exact final native/npm failure codes.
  Capture shell error/native exit state before wrapper housekeeping alters it.
  Multi-command scripts remain responsible for their chosen error handling.
- Invoking npm `.cmd` remains supported through the approved PowerShell script.
  Nested cmd execution still has an 8,191-character expanded-line constraint;
  script files do not remove it. Dynamic shell expansion cannot be fully
  prevalidated: surface runtime errors, and never truncate accepted input.
- Script encoding is not output encoding. Preserve raw stdout/stderr bytes,
  request UTF-8 for controlled shell output, and label native decoding as an
  assumption unless established. Report invalid/lossy decoding and offer retained
  raw pages; a UTF-8 decoder cannot repair arbitrary legacy-codepage output.
- Preserve necessary OS/toolchain environment without injecting Fleet control
  tokens. Batch output, bound buffers, and keep draining pipes after retention
  fills, recording gaps. No persistent shell state or secret-input surface.

## 8. Recovery and delivery guarantees

Implement a small durable Node journal under its existing secured config/data
directory, shared with the independent supervisor through its defined receipt
protocol. Persist launch/cancel identities before side effects, then supervision,
release, and final evidence. Keep bounded output and lifecycle receipts across
Node restarts. The existing in-memory session outbox is not sufficient.

Do not claim exactly-once arbitrary process execution across every crash window.
Prefer an unresolved operation over accidentally running it twice.

| Failure | Required behavior |
| --- | --- |
| MCP reply is lost | Same request key returns the persisted execution. |
| Approval races denial/cancellation | Host arbitration prevents undispatched work; after dispatch, Node launch arbitration and durable cancel tombstones decide no-start versus termination. |
| Start acknowledgment is lost | Reconcile the same execution ID against the Node journal; do not create another process. |
| Host restarts | Reload approvals, deadlines, cancellation intents, and completion deliveries; reconcile before uncertain dispatch. |
| Connection drops while running | The Node continues the already-authorized bounded job, enforces its local deadline, and spools bounded output. No new offline starts. |
| Node crashes before readiness or during a silent job | Independent parent-loss/deadline enforcement bounds the job. Recover ownership separately from outcome; never relaunch. |
| Root exit is known, but descendants remain | Supervisor terminates descendants and reports forced cleanup; zero root exit is not ordinary success. |
| Outcome receipt is lost, but quiescence is proven | Release proven-quiescent leases; settle interrupted with a null exit code rather than blocking reuse forever or inventing success. |
| Output/result is replayed | Sequence/identity checks deduplicate it; lifecycle acknowledgment follows durable Host persistence, not receipt in memory. |
| Output exceeds a quota | Show a known gap/truncation and preserve lifecycle evidence. |
| Cancellation cannot reach an offline Node | Show cancellation pending; do not free the checkout until reconciled. |
| Target is removed or rebound | Refuse new dispatch; retain history and reconcile existing execution ownership. |
| Lead/task/catalog is deleted | Preserve immutable ownership snapshots and unresolved journal/tombstone identities; no cascading deletion of process evidence. Revoke dispatch and deliver no wake to a deleted lead. |
| Backup is restored | Use existing quarantine patterns. Expire approvals, rotate command-request namespace, retain dedup identities, and reconcile active attempts without executing history. |

Define a durable Node-local launch boundary: serialize release authorization and
cancel tombstones for the same attempt. A cancelled execution whose start frame
arrives later is rejected, even after reconnect. If release already won,
cancellation remains pending until verified termination; do not claim it never
started.

Final receipts include `finalOutputSeq` and skipped ranges. Outcome may be known
before output replay finishes. `outputComplete` means every sequence through the
watermark is received or accounted for as an explicit gap. Acknowledge lifecycle
receipts only after durable persistence. Reaching the seven-day output replay
horizon records missing ranges instead of pretending logs are complete.

Keep compact request-key tombstones for the lifetime of the owning principal and
any outstanding dispatch authority, beyond the 30-day verbose history. Past the
24-hour retry window return `request_expired`; require a new key and approval.
After owner deletion, retire tombstones only when its authority is revoked and
all attempts are quiescent/reconciled. Restore does not reuse the old request
namespace. If tombstone capacity fills, refuse admission instead of forgetting
keys. Journal loss is uncertainty, never permission to retry.

Bound Node transport queues, Host persistence queues, and individual browser
buffers separately. Pause a slow browser's live output and let it resume from a
cursor, with visible gaps where retention expired. Reserve capacity for control
and lifecycle messages. Disk-pressure failure must not prevent supervisor
termination or produce an acknowledgment for an unpersisted receipt.

## 9. Orchestrator and checkout integration

### 9.1. Shared admission and lock ordering (R2)

On command-eligible repositories, introduce a cross-installation participation
barrier keyed by canonical Git common-directory identity (canonical directory
identity for non-Git placements). All Fleet session start/resume/additional-root
paths participate, including unbound, read-only-labelled, and aliased paths.

Agent processes hold shared participation for their lifetime plus any existing
managed checkout lease. General commands and control-plane Git mutations acquire
exclusive repository participation. Existing per-checkout writer rules remain.
This deliberately serializes a command against Fleet work in sibling worktrees;
it is a conservative opt-in tradeoff, not a claimed sandbox or a new global
serialization rule for unrelated repositories.

Acquire in one order: Node admission ticket, repository participation barriers
sorted by canonical key, existing Git administration locks sorted by key, then
checkout leases sorted by key. Release in reverse after proven quiescence. Never
wait for an upper-level lock while holding a lower-level one or upgrade a shared
participation in place. Preparation resolves identities without mutation; after
locking, revalidate them. Maintenance drains outside the acquisition path.

Register admission tickets under a short Node-local critical section; do not
hold that mutex while waiting for repository locks or draining processes.
Maintenance can close admission while existing tickets remain visible in its
snapshot. Cancellation and quiescence reporting do not require a new start ticket.

Every installation permitted to share an eligible checkout must support this
protocol. Activation requires drain/reconciliation of pre-feature participants;
known older, inaccessible, or untracked Fleet ownership makes the target
ineligible. Absence from one Node's memory is not proof. A second upgraded
installation must observe the same physical barrier, not a private config lock.

Noncooperating old installations and arbitrary non-Fleet OS processes cannot be
excluded merely by a new lock file; keeping them off an eligible checkout is an
explicit deployment prerequisite. Where that prerequisite cannot be established,
refuse the feature for that target. Do not silently rewrite legacy admission
semantics everywhere else.

Preserve private coordinator directories. Never implicitly Stop the requesting
lead to make a command fit: Stop revokes its requests. If explicit process parking
is needed, it must preserve the live logical lead identity and be separate from
operator Stop; otherwise return busy and keep completion delivery possible.

### 9.2. Conservative managed-target policy (R4)

V1 permits an explicitly bound mutable managed generation only before its task
has any sealed result/result SHA, dependent composition, review evidence,
publication approval, or integration attempt. The task must be active, not in
handover, aggregation, cleanup, or reconciliation. This conservative task-wide
test intentionally excludes many post-implementation build/review commands.

Check eligibility during preparation and atomically again before dispatch.
Install a task/workspace command fence and advance its mutable-evidence revision
before the command could write. While fenced, block worker admission,
finalization/sealing, composition, review/publication, handover, and removal.
Failed, cancelled, interrupted, and timed-out jobs can all leave changes; none
restores the old evidence revision merely because it did not succeed.

After proven quiescence, obtain a fresh observation before releasing the
execution-only fence to ordinary phase scheduling. Keep handover/publication
blocked until required verification records refer to the new evidence revision;
do not block the verification work needed to establish that evidence. Failed
observation leaves the task blocked. A proven no-start can clear the execution
fence without claiming a write occurred. Existing historical observations never
become current merely because the fence was removed.

Protected targets return `managed_target_not_mutable`. Do not clear `resultSha`,
overwrite immutable artifacts, or invalidate a few fields and call it resealing.
Future support needs a separately designed revision/reopen operation that creates
new result identities, dependent compositions, reviews, and publication approvals.
The existing reopen operation is not assumed to supply that behavior.

### 9.3. Durable completion delivery (R5)

Use existing lead authentication and ownership checks. Independently negotiate
`durable-lead-delivery-v1` on the Node hosting the lead, regardless of execution
Node capability or OS. V1 rejects unsupported combinations before execution;
there is no silent history-only fallback to a promised automatic wake.

Persist a stable logical delivery ID, its bounded set of completion revisions,
and a per-lead in-flight reservation across ticks and restarts. Every prompt
producer, including Run wakes, queued task briefs, status checks, and human
prompts, must respect the same reservation. Do not overwrite an existing
delivery's session attempt with a newly generated command ID.

The lead Node deduplicates deliveries and durably reports `accepted`,
`rejected_busy`, or `uncertain`, bound to the native conversation/attempt.
Acceptance is not model consumption. Keep the prompt slot reserved until the
accepted turn settles, a definitive refusal permits release, or reconciliation
establishes the state. Expiry alone cannot release an uncertain reservation.
On busy refusal, preserve the owed result and retry only after an eligible idle
transition; never let an unrelated wake disappear behind the refusal.

Notify with execution ID, outcome, target, output-completeness/cleanup flags,
short bounded output, and a cursor. No polling or log-line wake storm. Standalone
commands use the same delivery path without fake Runs. Deleted/stopped leads are
not resurrected. Uncertain ACP handoff remains visible with discoverable results;
do not claim exactly-once model consumption or retry indefinitely.

### 9.4. Maintenance barrier and lifecycle (R3)

Use one Node-local admission/maintenance controller for command starts, existing
session admission, update, opt-out, shutdown, and identity/backup restore. Close
admission atomically before taking the active/launch-in-progress snapshot, so an
asynchronous WebSocket handler cannot admit a concurrent start.

Self-update refuses while relevant Fleet processes or uncertain ownership remain;
it does not automatically stop them. This check and exclusive maintenance
ownership precede `updateCheckout`, including its Git fetch/reset, npm install,
and build. Hold the barrier through mutation/restart and obey the shared
repository barrier across installations.

Opt-out and shutdown first close admission, then cancel/drain and persist
supervisor/final receipts locally before closing storage, even if the socket is
already closed. Identity/backup restore refuses mutation until drain is proven,
then quarantines restored authority. If maintenance fails before mutation and
ownership is known, explicitly reopen prior admission; after uncertain drain or
partial mutation, remain maintenance-blocked with a recovery action, not a silent
permanent busy flag or unsafe automatic reopening.

Task/orchestrator Stop revokes pending work and requests termination. Purge and
target removal cannot destroy unresolved ownership records. Command completion
does not complete a task or authorize integration/push.

These barriers coordinate declared Fleet work, not arbitrary script access to
unlisted checkouts or other OS resources.

## 10. Browser, retention, and observability

Add an execution approval/detail surface reachable from the owning Orchestrator
and the notification center. It must work without a task or worker session.

Show status, exact target, approval identity, timestamps, cancel control, exit
code/error, live output, and clear offline/truncation/reconciliation indicators.
Pending requests must reappear after refresh. Fetch history/output by cursor;
send only recent metadata in a reconnect snapshot. Show interrupted outcome
separately from unknown ownership, forced descendant cleanup, incomplete output,
decoding assumptions, and pending/uncertain lead delivery.

Use existing Fluent UI/theme patterns. Keep keyboard focus predictable, label
allow/deny/cancel controls, avoid announcing every stdout chunk to screen
readers, and render commands/output as inert text. Do not interpret terminal
escape sequences as browser actions or render output as trusted HTML.

Reuse current access controls and secure data permissions for command text and
logs. They may contain sensitive data. Do not copy raw output into global
diagnostics/security audit, and do not promise automatic secret redaction.
Backup/export and cleanup need explicit handling for these new records, bounded
logs, and protected unresolved receipts.

Record queue time, execution duration, exit outcome, cancellation/timeout,
approval latency, output bytes/dropped ranges, and reconciliation failures using
existing diagnostics/audit facilities. No new telemetry service is required.

## 11. Implementation sequence

Start with the Windows feasibility spike, then preserve the six-phase delivery
shape. Admission and maintenance are prerequisites to dispatch, not rollout
cleanup. Prove one disabled end-to-end slice before expanding UI/history. Do not
enable the feature until all release-blocking gates pass.

| Phase | Deliverable and likely files | Exit condition |
| --- | --- | --- |
| 1. Feasibility and contracts | Disposable supervisor/shell fixtures; `windows-process-job.ts`; proposed `packages\protocol\src\command-execution.ts`. | R1/R6 parent-death, deadline, release-handshake, script-size, encoding, and restricted-policy cases pass before contracts are finalized. |
| 2. Persistence and admission | `store.ts`, Node journal/runner, `router.ts`, shared physical barriers, `main.ts`/updater/settings lifecycle. | R2/R3 bidirectional admission and pre-mutation maintenance gates work before any public command can dispatch; cancellation/dedup/restore identities are durable. |
| 3. Disabled vertical slice | Command controller, Node transport, minimal MCP request, browser allow/deny, result persistence, and durable lead reservation/receiver receipts. | One approved Git/npm job returns to the lead; delayed/busy/lost acknowledgments and different lead/execution Node capabilities exercise R5 immediately. |
| 4. Complete command and task contracts | Read/cancel/discovery tools, bounded replay, retention/tombstones, standalone delivery, and conservative managed eligibility/fences. | R4 rejects protected targets and restores eligible mutable tasks through fresh evidence; output completeness and unknown ownership remain distinct. |
| 5. Operational UI and history | Approval/detail UI, notification navigation, Node config, slow-consumer recovery, accessibility, and diagnostics. | Refresh, cancellation, gaps, decoding loss, maintenance, and uncertain delivery are understandable without fake Sessions. |
| 6. Compatibility and rollout | Full failure matrix, backup/delete/retention exercises, targeted regressions, docs, and controlled enablement. | The pilot meets the gates below; unsupported combinations are refused explicitly and unrelated existing fleets remain unchanged. |

The source filenames proposed above are candidates, not a requirement to create
a framework or duplicate existing helpers. Keep runtime code in focused modules
and only extend existing surfaces where their behavior must change.

Update `README.md`, `README.zh-CN.md`, and `ARCHITECTURE.md` alongside the shipped
feature: opt-in, trust boundary, approval behavior, shells/platform support,
limits, MCP usage, recovery, cancellation, and log retention.

## 12. Release-blocking acceptance scenarios

| Scenario | Expected evidence |
| --- | --- |
| Branch inspection on a workspace other than Fleet | Correct Node/checkout result, including detached/unborn behavior, with zero Copilot worker launches. |
| `npm run build` | Actual stdout/stderr and exact exit code; final native failures and explicit script exits survive wrapper bookkeeping. |
| Target preparation / permission pending, denied, or expired | Only fixed preparation metadata checks may run; no submitted command process or checkout lease is created. |
| Approval payload/target changes | Old approval cannot authorize the changed command, shell, limits, path, or generation. |
| Ownership/authentication | A different lead, worker token, revoked task, browser-origin MCP call, or unsupported/legacy connection cannot execute/read/cancel outside its authority. |
| Idempotent retries and expiry | Repeated requests/start frames create no second process; conflicting payloads fail; retry after verbose history removal still cannot turn an old key into new work. |
| Cancellation launch boundary | Race cancel before/after dispatch and supervisor release; delayed starts meet durable tombstones, or report termination pending rather than false no-start. |
| Paths and near-limit scripts | UTF-8 byte limits, near-16-KiB multiline files, Unicode paths, quoting, and nested cmd limits behave explicitly without truncation or Base64 command-line overflow. |
| Shell/readiness policy | Missing exact edition or policy-blocked supervisor fails before submitted code; no edition substitution or execution/language-policy bypass. |
| Native output encoding | Split UTF-8, legacy codepages, and binary/invalid bytes retain recoverable raw data with honest display-decoding indicators. |
| Node-parent death (R1) | Kill Node before start acknowledgment and during a silent command with grandchildren, not just the helper. Supervisor independently bounds lifetime, journals evidence, and never relaunches. |
| Outcome versus ownership | Proven quiescence with lost outcome settles interrupted/null exit and releases the lease; unknown ownership blocks reuse. Forced cleanup is visible even with root exit zero. |
| Bidirectional admission (R2) | Race command versus agent start/resume in both directions across unbound/read-only-labelled sessions, extra roots, junction aliases, and a second installation. Unknown old participation is refused. |
| Coordinator continuity | Private coordinator placement stays intact; no implicit operator Stop of the requesting lead; its completion remains deliverable. |
| Maintenance before mutation (R3) | Concurrent starts cannot slip into update/opt-out; failed quiescence prevents the first updater Git/npm mutation. Failed maintenance reopens only when safe; shutdown retains receipts after socket loss. |
| Managed evidence policy (R4) | Reject sealed/reviewed/composed/integrating tasks. Fence eligible targets before possible writes; failures/cancellation/timeouts cannot restore stale evidence. No immutable result overwrite or source-target substitution. |
| Task lifecycle | Outstanding/uncertain commands block handover, sealing/integration, cleanup, and purge; stop revokes pending starts without cascading away recovery evidence. |
| Lost connection / Host restart / Node restart | Recoverable output and terminal receipts survive; uncertain launches do not rerun; restored backups do not launch historical work. |
| Noisy output / slow browser / full disk | Independent retained-log, transport, renderer, and aggregate quotas hold. Lifecycle reserve closes admission when unavailable; outcome watermarks and gaps remain honest. |
| Outcome before output completion | Persist/ack terminal outcome with a final watermark, then replay delayed output; status does not falsely imply complete logs. |
| Lead delivery races (R5) | Delay acknowledgment across multiple ticks with ordinary Run wakes and several completions; repeat after Host restart/lost ack. A persistent reservation prevents distinct deliveries from colliding; busy rejection loses nothing. |
| Lead/execution version mismatch | An upgraded Windows execution Node with an old or non-Windows lead Node is supported only if the lead independently advertises durable delivery; otherwise reject before command execution. |
| Browser refresh and output rendering | Approval reappears, output resumes from cursor, and malicious-looking text remains inert data. |
| Older/disabled/non-Windows Node | Explicit unsupported/disabled status, no new protocol frame, and no connection disruption. |
| Retention, deletion, restore, and clocks | Tombstones/owner snapshots survive history removal; restored authority is quarantined; bounded start-time uncertainty and supervisor monotonic runtime prevent expiry extension. |

Use the existing Vitest setup: protocol/controller/runner tests with deterministic
process fixtures, UI tests for approval and replay, and real temporary-repository
Git/npm checks on Windows. Include targeted regressions for existing ACP
permissions, checkout leases, Node reconnect, Run wakes, and session retention.
No new test framework is needed.

## 13. Rollout and review checkpoints

1. Land the backend and UI disabled; upgrade the Host first. Do not send new
   frames until an opted-in Node advertises capability on a sealed connection.
2. Pilot one Windows Node against disposable test workspaces, covering approval,
   Git/npm failures, descendants, and disconnect/restart recovery.
3. Enable additional Nodes locally after the pilot meets the acceptance gates.
   Expose command availability independently of Copilot session capacity.
4. Roll back by disabling admission, cancelling/reconciling active jobs, and
   leaving history readable. Never delete journals to force a clean appearance.
5. Follow-on work, only when needed: PowerShell 7/direct cmd editions, POSIX
   execution supervision, protected managed-result revision flows, human command
   composer, interactive PTYs/services, stronger OS isolation, or command DAG steps.

Review should confirm the deliberate first-release choices: Windows-first
execution with explicit PowerShell 5.1, independent lead-delivery capability,
approval for every command, repository-wide exclusion for opted-in targets,
mutable-only managed tasks, one active command per Node, and no persistent shell
state. These are proposed defaults, not settings already changed.

## 14. Review disposition and evidence

All six review amendments are accepted as design requirements, not claims of
already reproduced runtime failures. Current code was checked against the review
baseline and the subsequent UI-only commit `9c48cd3`.

| Review | Disposition and source |
| --- | --- |
| R1 | Independent supervisor deadline, Node-parent-loss termination, suspended-release handshake, and outcome/ownership separation are release blockers. `windows-process-job.ts` (`FleetJob.Run`) currently waits indefinitely; `process-quiescence.test.ts` kills the helper rather than Node. |
| R2 | Add shared cross-installation admission before dispatch. `CommandRouter.initializeSession` acquires managed leases only for bound sessions; `managed-worktrees.test.ts` explicitly preserves unbound concurrency. `CheckoutLocks.acquire` separates admin and checkout keys. |
| R3 | Maintenance ownership precedes all update mutations. `main.ts` (`runSelfUpdate`) calls `updateCheckout` before shutdown; `updater.ts` mutates Git, dependencies, and build outputs first. |
| R4 | Narrow v1 to mutable, unsealed/unreviewed tasks; reject protected targets rather than promise implicit resealing. `ManagedWorktreeService.finalizeStep` returns on `step.resultSha`; `FleetStore.putWorkspaceResult` rejects changing immutable result identity. |
| R5 | Persist one per-lead in-flight reservation across all producers and negotiate delivery on the lead Node separately. `engine.ts` resets `promptedThisTick`; `FleetService.dispatch` generates prompt command IDs/attempts; ordinary success receipts are not durable consumption proof. |
| R6 | One named shell edition, file transport, readiness probe, and separate script/output encoding contracts. `spawnWindowsJob` currently embeds its target command line in UTF-16LE Base64 helper text. |

Official Windows contracts consulted:

- [CreateProcessW command-line limit](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw):
  32,767 characters including terminator. A 16,384-byte ASCII script expands to
  43,692 Base64 characters after UTF-16LE encoding, before helper overhead.
- [cmd command-line and batch expansion limits](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation):
  8,191 characters; file transport does not remove per-expanded-command limits.
- [Windows PowerShell 5.1 character encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1):
  non-ASCII script files need the appropriate BOM; native output has a separate encoding contract.
- [PowerShell language modes](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes?view=powershell-5.1):
  application-control policy can constrain the helper; never weaken policy to advertise readiness.
