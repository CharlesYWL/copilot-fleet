# Approved remote command execution

Status: Draft implementation plan for review; no implementation changes made.
Date: 2026-09-16
Repository: copilot-fleet

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
| Target | An exact registered placement or existing managed task checkout. |
| Approval | Explicit allow-once or deny for every new execution, including Git reads. No inherited YOLO or blanket approval. |
| Working directory | Resolved and pinned by Fleet for each execution; no persistent shell state. |
| Output | Live browser output, bounded retained logs, and an Orchestrator completion notification. |
| Task association | Optional; standalone inspections do not create a Run or Session. |
| Platform rollout | Windows first, reusing existing verified Job Object supervision. Other Nodes report unsupported until an equivalent adapter is implemented and verified. |
| Node control | Local opt-in, default off. The Host cannot remotely turn this setting on. |
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

## 3. Existing code to build on

Paths below are relative to the repository root.

| Existing surface | Relevant behavior / planned integration |
| --- | --- |
| `packages\protocol\src\index.ts` | Separate Node-scoped messages already exist alongside session commands. Add capability-gated execution messages; do not add fake session IDs. |
| `apps\host\src\orchestrator\mcp-routes.ts` | Authenticates live lead principals; uses per-request stateless JSON responses. Register the new tools behind the same principal checks. |
| `apps\host\src\orchestrator\tools.ts` | Shared advertised/validated schemas and scoped task lookup. Add request/read/cancel methods and target discovery. |
| `apps\host\src\orchestrator\engine.ts` | Schedules prompts only for idle leads and prevents multiple prompts per tick. Extend scheduling for command completions, including leads without a Run. |
| `apps\host\src\store.ts` | SQLite transactions, durable transitions, security audit, and Run wake bookkeeping. Add execution-specific records and invariants. |
| `apps\host\src\gateway\node-socket.ts` | Authenticated message dispatch and Node receipt validation. Route execution events and reconciliation. |
| `apps\node\src\main.ts` | Already handles `repository_probe` outside Copilot sessions. Wire the command runner, inventory, settings, shutdown, and update coordination here. |
| `apps\node\src\process-quiescence.ts` and `windows-process-job.ts` | Existing strict process-tree ownership uses Windows Job Objects. Reuse the process supervision, not the Copilot session lifecycle. |
| `apps\node\src\checkout-locks.ts` and `canonical-path.ts` | Physical checkout identity, lease acquisition, revalidation, and release only after verified quiescence. |
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
  scheduling discipline, not synthetic worker completion events.

## 4. Proposed MCP contract

### `fleet_run_command`

Inputs:

- `target`: exactly one of `{ placementId }` or `{ worktreeId, generation }`.
- `command`: exact command/script text; bounded and NUL-free.
- `shell`: a supported identifier advertised by the target Node, initially
  `powershell` or `cmd` on supported Windows installations.
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

Example tool input:

```json
{
  "target": { "placementId": "placement-id-from-discovery" },
  "command": "npm run build",
  "shell": "powershell",
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
unsupported Nodes, forbidden ownership, and exhausted admission limits return
explicit errors. No process starts as part of this MCP request.

Idempotency is scoped to the authenticated Orchestrator and request key. Repeating
the same key and payload returns the existing execution. Reusing it with changed
execution-affecting input is a conflict. A deliberate rerun needs a new key and
new approval.

### `fleet_get_execution`

Input: `executionId`, optional `afterSeq`, and a bounded output limit.

Return status, target, timestamps, exit code or signal where known, failure reason,
pending cancellation/reconciliation information, stdout/stderr events, and
`nextSeq`, `hasMore`, and explicit dropped/truncated ranges. Exit code is nullable:
denial, spawn failure, and unknown completion are not successful zero exits.

Authorize ownership on every call. This is for retrieving additional evidence,
not a polling loop. Extend existing discovery/task details with recent execution
IDs so an Orchestrator can recover after losing a tool response.

### `fleet_cancel_execution`

Pending approval or queued work cancels without spawning. Started work records a
durable cancellation intent and returns `cancelling`; cancellation is complete
only after the Node verifies process-tree termination. Repeated cancellation is
idempotent. Operators can also cancel through the UI.

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

Connectivity is separate from outcome. An offline Node makes a running result
unobservable, not successful, failed, or safely cancelled. A late validated Node
receipt can resolve uncertainty. A cancellation arriving after proven completion
does not rewrite success as cancellation.

Persist in SQLite:

- `command_executions`: owner, optional task, pinned target, command digest,
  command/shell, limits, approval identity/version/expiry, dispatch attempt,
  cancellation intent, state, outcome, and timestamps.
- `command_execution_events`: execution ID, monotonic Node sequence, stream or
  event kind, timestamp, and bounded payload. Unique `(executionId, sequence)`.
- Completion-delivery state on the execution or a small dedicated delivery table:
  recipient, completion revision, delivery identity, attempt, and acknowledgment.

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
| Execution metadata/history | 30 days after settlement; unresolved ownership and delivery receipts are protected |

Apply aggregate Host/Node storage quotas as well as per-execution caps. Lifecycle
receipts must not be evicted to make room for noisy stdout. Pending, unapproved
requests consume admission budget but do not reserve checkout leases or processes.

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

Add one small execution manager and shell adapter using existing Node APIs and
process supervision. Avoid a generic job framework.

New capability: `remote-command-execution-v1`. Inventory reports local enablement,
supported shells, concurrency, and active execution identities. Gate new
Host-to-Node messages on this capability and transport authentication; unsupported
Nodes remain connected and receive no unknown frames.

Add execution-scoped target preparation, start, cancel, inventory/reconciliation, output,
acknowledgment, and final-result messages. Bind every message to the enrolled
Node, execution ID, dispatch attempt, and immutable request digest. Validate all
payloads with shared protocol schemas.

Runner requirements:

- Resolve supported shell identifiers to trusted local executables; never accept
  a caller-selected executable path as a shell. Pass cwd separately.
- Use noninteractive/no-profile invocation and closed stdin. Make shell exit-code
  behavior explicit, including propagation of a failing final npm/native command
  through PowerShell. Multi-command scripts remain responsible for their own
  chosen error handling.
- Support Windows paths, quoting, Unicode, and npm's `.cmd` launcher correctly.
  Do not concatenate cwd into shell text.
- Preserve needed OS/toolchain environment while not injecting Fleet session MCP
  credentials or control-plane tokens. No additional environment/secret input
  surface in this release. The process still has the Node OS user's privileges.
- Attach supervision before user code can run. Track descendants on natural
  exit as well as cancellation; release leases only after verified quiescence.
- Decode streamed output safely across UTF-8 chunk boundaries. Batch small
  chunks, enforce frame limits, apply backpressure, and keep heartbeats responsive.
- Continue draining pipes when retention is full; record a gap rather than
  deadlocking the command or silently presenting its output as complete.

Do not retain a shell between executions. Long-running jobs cannot outlive their
deadline by keeping child processes or streams open.

## 8. Recovery and delivery guarantees

Implement a small durable Node journal under its existing secured config/data
directory. Persist accepted execution identity and launch intent before spawning,
then process ownership and final receipt. Keep bounded output and unacknowledged
lifecycle receipts across Node restarts. The existing in-memory session outbox is
not sufficient.

Do not claim exactly-once arbitrary process execution across every crash window.
Prefer an unresolved operation over accidentally running it twice.

| Failure | Required behavior |
| --- | --- |
| MCP reply is lost | Same request key returns the persisted execution. |
| Approval races denial/cancellation | One versioned transition wins; no start after a winning cancellation. |
| Start acknowledgment is lost | Reconcile the same execution ID against the Node journal; do not create another process. |
| Host restarts | Reload approvals, deadlines, cancellation intents, and completion deliveries; reconcile before uncertain dispatch. |
| Connection drops while running | The Node continues the already-authorized bounded job, enforces its local deadline, and spools bounded output. No new offline starts. |
| Node crashes between launch intent and process evidence | Mark reconciliation required; never automatically relaunch. |
| Output/result is replayed | Sequence and identity checks deduplicate it; final receipts remain until acknowledged. |
| Output exceeds a quota | Show a known gap/truncation and preserve lifecycle evidence. |
| Cancellation cannot reach an offline Node | Show cancellation pending; do not free the checkout until reconciled. |
| Target is removed or rebound | Refuse new dispatch; retain history and reconcile existing execution ownership. |
| Backup is restored | Restore history, not executable authority: expire pending approvals and reconcile active attempts without starting them. |

Keep deduplication receipts at least through every possible dispatch/replay
window. Journal loss is uncertainty, not permission to retry an arbitrary script.
Transport reconnection alone must never replay side effects.

## 9. Orchestrator and checkout integration

Use existing lead token validation and explicit ownership checks for all three
tools. Extend discovery with eligible target IDs and shell capability. The tool
description tells the Orchestrator to end its turn after a pending receipt.

Persist a completion delivery when an execution settles, including denial and
expiry. Notify with ID, outcome, exit code, target, short bounded output, and a
cursor for more. Raw output is labeled untrusted command data, not instructions.

Extend the existing prompt scheduler so:

- Busy leads are not interrupted and only one prompt is admitted per lead/tick.
- Standalone commands can notify a lead without inventing a Run.
- Several completions may be combined into one bounded notification.
- Delivery carries a stable identity and uses a recorded prompt acceptance path.
  Add receiver-side deduplication/receipts for this path where required; existing
  Run wake counters alone do not provide it. Reconcile uncertain delivery rather
  than repeatedly sending prompts.
- Pending delivery is recoverable after Host restart. Do not simply mark it
  delivered before sending and assume it arrived.
- Stopped/deleted leads are not resurrected. Their outcomes remain visible in
  history; new dispatches and queued approvals are revoked.

Distinguish durable result availability, Node acceptance of a wake prompt, and
model consumption. Do not claim exactly-once model consumption across a crash.
If handoff cannot be proven, show delivery uncertainty and keep the result
discoverable rather than silently losing it or generating an unlimited retry loop.

Command completion does not imply task completion, successful review, or approval
to integrate/push. Exit code zero is evidence only.

General commands are shell-capable writers for admission purposes, even when
their text looks like a read. Acquire the selected checkout lease and coordinate
with existing Git administration locks; never allow an agent-supplied `readOnly`
label to bypass them. Do not forcibly evict an active worker. Queue/refuse with
the lease holder identified, and use existing explicit park/stop flows as needed.

Task-linked executions must block task handover, result sealing/integration,
worktree removal, or purge while their process ownership remains live/uncertain.
Invalidate stale observations/review evidence after command writes; do not allow
previously sealed results to silently stand for a modified checkout. This release
does not make command jobs portable DAG result-producing steps.

Arbitrary shell code can touch other checkouts or shared Git metadata. Leases
coordinate Fleet-admitted work on the declared target; they cannot police
undeclared filesystem access without a sandbox.

Wire cancellation into task/orchestrator stop and Node local opt-out. Block
destructive lifecycle operations until ownership is reconciled. Node shutdown
must stop and journal command outcomes; self-update must not mutate/restart under
an active command without explicit stop/quiescence coordination.

## 10. Browser, retention, and observability

Add an execution approval/detail surface reachable from the owning Orchestrator
and the notification center. It must work without a task or worker session.

Show status, exact target, approval identity, timestamps, cancel control, exit
code/error, live output, and clear offline/truncation/reconciliation indicators.
Pending requests must reappear after refresh. Fetch history/output by cursor;
send only recent metadata in a reconnect snapshot.

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

Each phase depends on the previous phase. Keep the feature disabled until the
end-to-end acceptance gates pass.

| Phase | Deliverable and likely files | Exit condition |
| --- | --- | --- |
| 1. Contracts and persistence | New `packages\protocol\src\command-execution.ts`, exports/message unions; `store.ts` migration and execution tests. | Schemas, state transitions, deduplication, approval versions, quotas, and restore behavior are defined and exercised. |
| 2. Node runner and recovery | New `apps\node\src\command-executor.ts` plus a small journal/shell module as justified; existing supervision/locks/settings/config integration. | Finite Git/npm jobs run without Copilot; natural exit, failure, timeout, cancellation, restart uncertainty, and replay are handled honestly. |
| 3. Host controller and transport | New `apps\host\src\command-execution-service.ts`, gateway/main message handling, inventory, capability checks, deadlines and acknowledgment. | Approved jobs run end to end; unauthorized, duplicate, expired, offline, and rebound-target cases cannot cause a new unintended process. |
| 4. MCP and wake integration | `orchestrator\tools.ts`, `mcp-routes.ts`, `engine.ts`, shared lifecycle/task gates. | All three tools are scoped; pending returns promptly; completion reaches idle standalone/task leads without polling or synthetic Sessions. |
| 5. Approval and live-output UI | New command routes and UI detail component; `useFleet`, snapshot/events, notifications, Node config page. | Human approval is usable and persistent; output/cancellation/recovery are visible and accessible. |
| 6. Compatibility and rollout | Regression coverage, recovery exercises, docs, retention/backup integration, feature enablement. | Mixed fleets work unchanged; enabled Windows Nodes satisfy every release-blocking scenario below. |

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
| `npm run build` | Actual stdout/stderr and exit code; failure stays failure, including through the Windows shell adapter. |
| Target preparation / permission pending, denied, or expired | Only fixed preparation metadata checks may run; no submitted command process or checkout lease is created. |
| Approval payload/target changes | Old approval cannot authorize the changed command, shell, limits, path, or generation. |
| Ownership/authentication | A different lead, worker token, revoked task, browser-origin MCP call, or unsupported/legacy connection cannot execute/read/cancel outside its authority. |
| Idempotent retries | Repeated MCP requests and start frames create no second process; changed payload with the same key conflicts. |
| Paths and shell behavior | Spaces, quotes, multiline scripts, Unicode, npm `.cmd`, and nonzero native exits behave according to the advertised shell. |
| Descendants | Timeout, cancel, shutdown, and natural parent exit leave no untracked descendants; unverifiable ownership preserves the lease and surfaces reconciliation. |
| Concurrent checkout usage | No command starts over a live worker/admin lease; task work targets its actual worktree, not a same-named source placement or an alias that bypasses binding checks. |
| Task lifecycle | Outstanding/uncertain commands block handover, sealing/integration, cleanup, and purge; stop revokes pending starts and requests termination. |
| Lost connection / Host restart / Node restart | Recoverable output and terminal receipts survive; uncertain launches do not rerun; restored backups do not launch historical work. |
| Noisy output | Output/frame/global quotas hold, heartbeats remain responsive, UTF-8 is intact, and truncation is visible. |
| Completion while lead is busy | One durable logical completion is queued and later delivered; no interrupt, log-line wake storm, or lost standalone completion. |
| Browser refresh and output rendering | Approval reappears, output resumes from cursor, and malicious-looking text remains inert data. |
| Older/disabled/non-Windows Node | Explicit unsupported/disabled status, no new protocol frame, and no connection disruption. |
| Retention and quota pressure | Settled history expires as documented; unresolved ownership, idempotency, and unacknowledged lifecycle receipts remain protected. |

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
5. Follow-on work, only when needed: POSIX supervision, human command composer,
   interactive PTYs/services, stronger OS isolation, or first-class command DAG
   steps.

Review should confirm the deliberate first-release choices: Windows-first
support, approval for every command, one active command per Node, bounded
noninteractive execution, and no persistent shell state. These are proposed
defaults for this plan, not settings that have already been changed.
