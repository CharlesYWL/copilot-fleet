# Copilot Fleet Architecture

## Core ownership rules

1. **Host owns desired state and history.** It stores Nodes, Workspaces, Placements, Sessions, and ordered Session Events.
2. **Node owns execution.** Agent login, profiles, child processes, local paths, and ACP connections never leave the Node.
3. **Workspace is logical; Placement is physical.** A Workspace can be available on several Nodes, each with a different absolute local path. A Session is assigned to one Placement and therefore one Node.
4. **One Fleet Session owns one ACP agent process.** Copilot remains the worker backend; orchestrators may also use Hermes. This makes cancellation, permissions, isolation, and concurrent capacity predictable.
5. **Nodes only dial out.** Each Node registers with a Host URL and keeps one authenticated outbound WebSocket. No inbound firewall rule is required on Windows Nodes.

## Components

```text
Browser
  | REST + WebSocket
  v
Host Web App
  |- Fastify API and WebSocket gateways
  |- Scheduler/capacity checks
  |- SQLite event store
  `- React live-session UI
          |
          | authenticated outbound WebSocket
          v
Windows Node App
  |- registration + heartbeat
  |- capacity/command router
  |- one ACP bridge per Session
  `- process supervisor
          |
          | ACP NDJSON over stdio
          v
copilot --acp --stdio
or hermes -p <profile> acp (orchestrators only)
```

Agency mode is an opt-in Host setting applied at the common command-dispatch
boundary to every Copilot session start and resume. The executing Node resolves Agency
on its own PATH and uses `agency copilot --acp --stdio`, preserving the ACP
transport, permissions, and per-session Fleet MCP injection. Only a missing
Agency installation falls back to the Node's standard Copilot command, with a
session-log notice; Agency startup errors are not hidden by a fallback.
Already-running sessions keep their launcher until stopped and resumed.

Orchestrator backend selection is a separate Host preference. Auto means Copilot.
The Host prefers a compatible online workspace placement and falls back to
Copilot, with a transcript notice, only when creating a new lead with no available
Hermes installation. Each session persists its actual typed `agentParams`,
including the Hermes profile, through explicit/automatic resume, MCP process
replacement and Host backup. Profile/authentication errors are not fallback cases.
Host admission and Node slot reservation allow only one live Hermes lead per
profile per Node; profile memory is Node-local. A stopped lead never changes
backend merely because the preference or installed agents changed.

`apps/node/src/agent-kinds` isolates launch, usage and picker differences while
the shared ACP client retains transport, permissions, sequencing and process
cleanup. Hermes uses native model/mode ACP methods and auto-approval of offered
allow options for YOLO leads. It receives the full orchestrator briefing and
the same scoped HTTP MCP tools. Copilot-specific Agency/context/model defaults,
credit polling and CAPI rollover are not applied to Hermes. Hermes native
history is excluded from Copilot's automatic retention/deletion path.
See [the reviewed backend plan](docs/orchestrator-agent-backend-plan.md).

The execution backend remains ACP. Validate the upstream context-flag fix before
considering a separately approved migration of the Node-side adapter.

Approved remote commands are a separate, Host-approved Node execution path;
they do not replace ACP for Copilot sessions. The
[implementation plan](docs/remote-command-execution-plan.md) records the contracts
and review requirements.

### Approved command execution

The Host persists a dedicated execution record and immutable prepared target
before asking an administrator for once, session, or persistent approval. The three Fleet MCP tools
request, read, and cancel work; none grants approval or creates a synthetic
Copilot Session/RunStep. Requests and receipts use capability-gated messages on
the sealed outbound Node connection.

The Node is the permission authority. Preparation identifies a reusable
command/subcommand and canonical working folder where possible; recognized ordinary flags
do not form new rule keys. Once approval binds the exact request, session grants
live in Node memory, and persistent rules live in Node configuration. The Host
opens an approval popup for unmatched requests; it does not maintain an
independent allowlist or let the Orchestrator approve itself. Rules are rechecked
on the Node at execution. Other scripts use exact full-text hashes for explicit
Session/Always grants, never inferred command-family authority.
External-command rules pin the resolved executable identity and content, so
replacing or updating it does not silently inherit approval.
The Node settings page provides a persistent-only bulk JSON editor over readable
command/path/match fields, including removable directory-change defaults. Its
versioned entries API preserves unchanged private pins and Host scope. Explicit
wildcard command rules match argument-preserving simple invocations and canonical local folder
patterns, never compound scripts; exact-script rules preserve literal text.
Legacy script text is recovered only from hash-verified local journal evidence.
The prior opt-in/drain setup and
stop-all dialog are no longer part of this flow.

The Node journals launch/cancel identities and uses a command-specific Windows
supervisor with suspended process admission, independent deadlines, parent-loss
termination, and durable quiescence evidence. Windows PowerShell 5.1 receives
script files rather than an oversized encoded command line. Outcome, process
ownership, and output completeness are distinct facts; neither lost receipts nor
forced descendant cleanup are reported as ordinary success.

Per-stream output offsets commit atomically with journal events. Recovery reads
retained native bytes before deleting their files, without assigning new
sequences to already-journaled bytes. Host receipt time, not a skewed Node clock,
controls settled-history retention; the raw Node receipt remains evidence.

Physical repository roots use shared participation across agent
start/resume/additional roots and installations. Ordinary placement commands use
tracked command participation, which coexists with sessions and tolerates legacy
untracked shared session markers without removing them. Explicitly unresolved
ownership and exclusive maintenance still conflict. Managed task commands and
Fleet Git administration retain exclusive participation and checkout locks;
legacy Host requests retain their earlier exclusive behavior. Maintenance closes
admission before snapshots or updater mutations. Nonparticipating old installations and
arbitrary OS access remain deployment/trust constraints, not sandbox guarantees.

An incomplete update leaves a durable admission quarantine. Explicit retry forces
dependency installation and a rebuild; only a fresh process at the recorded
successfully built repository/revision clears the block. Restarting after a
failed mutation alone cannot admit new commands.

Completion delivery has a separate capability on the lead's Node and a persistent
per-lead prompt reservation across ticks. Competing command completions, ordinary
Run wakes, and human prompts cannot overwrite an in-flight handoff. Receiver-side
deduplication records admission and settlement, not exactly-once model consumption.
Only an `accepted` handoff holds the lead's native conversation. `uncertain` —
reached when the prompt returns without a current turn_complete, the session
ends, or the Node restarts mid-turn — means the turn is already over and only its
consumption is unknown. It stays as evidence and its delivery id is never
prompted again, but it releases the conversation: nothing ever settles it, and
when it held the lead a Node restart during a wake left that orchestrator unable
to resume, be prompted, or receive another handoff.
The browser receives bounded live output and reads retained bytes by cursor;
slow consumers recover explicitly instead of growing unbounded queues.

## Domain model

- **Node**: registered machine, capabilities, capacity, active count, and liveness.
- **Workspace**: logical project visible in the UI.
- **Chats**: one reserved Workspace, kind `chats`, id `chats`. It holds sessions
  that are not about a checkout — a question, a piece of research — and its
  Placements are derived rather than filed: every Node that reports a home
  directory gets one there, rewritten on each reconnect. It is a real Workspace
  row rather than a null `workspaceId` on the Session because that column is
  load-bearing in the sessions foreign key, run pinning, capacity accounting,
  the sidebar tree, and backup; making it optional would have touched all of
  those to express something only the UI cares about. It cannot be renamed,
  deleted, or have Placements added, moved, or removed by hand, and the seed
  moves an operator's own workspace aside if one already holds the name.
- **Placement**: `(workspaceId, nodeId, localPath)`. The source catalog identity;
  legacy sessions use its path, while managed tasks keep an immutable resolved
  execution binding to a task-owned worktree on the same Node.
- **Session**: one long-lived Copilot process bound to one Placement. Carries an
  optional operator-chosen name; empty means the UI labels it by its initial prompt.
- **Turn**: one initial or follow-up prompt. MVP permits one active Turn per Session.
- **SessionEvent**: ordered append-only normalized ACP output/state/tool/permission event.
- **Permission request**: ACP request waiting for an allow-once or deny browser decision; timeout/disconnect denies it.
- **Run**: one approved objective plus the budget it may spend. Owns its Sessions.
- **RunStep**: one unit of a Run's work, executed by one Session on one Placement.

### Session retention

The Host owns the retention decision (30 inactive days by default); the Node
owns the last activity check and Copilot deletion. `last_activity_at` is separate
from `updated_at`, so connectivity recovery cannot renew an abandoned session.
Real input/output uses Host receipt time; internally replayed history is tagged
and does not count. Existing records migrate conservatively and activity travels
in Host backups.

Only idle/terminal sessions qualify. Favorites, unfinished or recently updated
tasks, and orchestrators with protected workers are retained. No deletion is sent
until the Node has reconciled its inventory and buffered events. Expired sessions
are excluded from automatic resume.

`session_cleanup_requests` persists a correlated command before dispatch and
locks the affected session/task against new work. The `session-retention`
capability gates the command for mixed-version fleets. One deletion runs at a
time per Node, which rechecks inactivity and uses ACP listing/deletion rather
than manipulating Copilot's private files. Failed operations retain the Host
record and back off; lost acknowledgements replay the same idempotent request.
The Host deletes its record only on a matching `session_cleanup_result`, clears
references in terminal tasks, and publishes a fresh snapshot. Task outputs and
notes survive session expiry.

## Orchestration

A Run is an objective a human approved once, together with hard budgets. The
Host — not a model — owns the resulting state machine, so the whole thing
survives a restart.

Two properties do most of the work:

- **Propose / dispose.** Whoever plans the work only asks for a step; the Host
  decides whether it may run, where it runs, and when it is done. A planner is
  never trusted to report its own success.
- **Dispatch is two-phase.** A database transaction cannot hold a WebSocket
  send, so a step's receipt lands as `starting` before its command goes out. A
  send that fails rolls the step back to `pending`; a Node lost before it
  acknowledges is failed by a deadline sweep.

Three rules follow from problems that only appear in production:

- **`offline` means unknown.** A Host that just restarted has heard from nobody.
  It may not settle a step, finish a Run, or wake anything until Nodes report in.
- **Completion is two facts.** A step succeeds only on `turn_complete` _and then_
  `idle`. `command_result{ok:true}` means the command arrived, nothing more.
- **A Run is pinned to one Placement.** A Workspace has one Placement per Node,
  and those are separate checkouts. Re-picking between steps is exactly what
  would hand a reviewer a tree without the implementation in it.

Managed writer admission is scoped to a physical checkout, not a Workspace. Managed
tasks get distinct checkouts and can each hold one writer; all roles within a
task share its checkout and serialize shell-capable sessions. `readOnly` remains
a capacity label, not a filesystem guarantee. A separate canonical Git
common-directory administration lock protects worktree and integration operations.
Unbound legacy sessions retain Host placement-based admission and direct terminal
events; they never create managed checkout leases. Managed ACP uses Windows Job
Object supervision, releasing a lease only after verified process-tree termination.
Uncertain ownership is durably reconciliation-required without suppressing the
terminal event. Resume can rotate a Host fencing attempt on the same live
conversation through an atomic lease reattachment, never a second writer.
Host backups preserve read-only classification and each step's workspace identity,
state, and result metadata. Restored execution bindings remain quarantined until
their exact worktree and generation reconcile, for primary and derived workspaces.
See [Managed worktree isolation](docs/managed-worktree-isolation.md) for the
two-layer lock model, persisted mode resolution and recovery rules.

Timeouts are the absence of events, so the Host runs a low-frequency deadline
sweep alongside the heartbeat sweep. Every deadline is recomputed from stored
timestamps, so nothing about it needs to survive a restart.

### The orchestrator

A Run can be planned by hand, or driven by an **orchestrator**: an ordinary
Session, in a Workspace, that a human talks to and that starts other Sessions.

It differs from every other Session in exactly one way — it is handed an MCP
server on `session/new`, pointed at the Host, with a bearer token scoped to
itself. Workers are handed none. ACP injects tools per session, so a worker is
not denied the fleet tools; it is never given them and cannot ask for them,
which is what keeps orchestration one level deep.

The rhythm is the load-bearing part. `fleet_start_work` returns as soon as the
receipt is written, the orchestrator ends its turn, and the engine wakes it with
a bounded summary when the work settles — a plain prompt, not a new event type.
So an orchestrator costs nothing between dispatching and being woken, and the
conversation survives a restart because none of it is held in memory.

One orchestrator runs many **tasks**, each its own Run with its own budget. It
is long-lived and will be asked for unrelated things over its life, and one
bucket for all of them meant a survey of a second repository shared a budget —
and a checkout — with yesterday's review.

A task moves through **phases** the orchestrator names when it plans one, and
the orchestrator is what moves it: it dispatches the work for a phase, reads
what came back, and either advances or sends more work out. That judgement is
the job. A person is asked exactly once, at the end, when the task is handed
over — they approve it, or send it back with a note that arrives as the
orchestrator's next turn and is acted on rather than discussed.

The phases are a list rather than an enum because how many there are is part of
the planning. Plan / implement / review suits a change; a question wants one
phase and a sign-off. Fixing the set would have made the orchestrator invent
stages with no work in them to fill a shape it did not choose.

While a task waits on a person nothing new is dispatched and the orchestrator
is not woken — that would be the engine talking over the review it just asked
for. What already happened is still recorded, though: a step that settles in
that window is closed and its worker reclaimed, because otherwise an agent
would hold a slot for as long as the person took to look.

A message for the orchestrator is **owed, not sent**. Copilot refuses a prompt
while a turn is in flight, and refuses it as a transcript notice rather than as
an error the sender can see — so a route that dispatched directly had no way to
learn its message had been dropped. Opening a task recorded one nothing had been
told about; sending one back was worse, because leaving `awaiting_human` is what
takes the review controls away, and with no steps left to settle no wake could
ever be owed either. The message is therefore written on the run and handed over
on the first tick where the lead is idle. It outranks a wake and suppresses it
for that tick, since both are prompts and only one turn can be in flight; the
wake stays owed in `settleSeq`. One tick sends at most one prompt per lead: a
tick walks every run and re-reads sessions, but a lead just prompted still reads
`idle` until the Node says otherwise, so two tasks sharing an orchestrator would
otherwise both send and the second would be lost.

A settled worker conversation is retained for tracked follow-up. `idle` means
"waiting for another turn", not process quiescence: an attached worker still
holds capacity and, on an upgraded Node, its physical checkout lease. Before
another task worker or reviewer takes that checkout, the engine parks the
settled process and waits for the Node's verified terminal receipt. Follow-up
resumes the same Copilot conversation and immutable task binding, preserving
committed and uncommitted changes rather than constructing another worktree.

The scheduling pass that leaves a follow-up pending also records why, and that
reason — never a separate guess — is what the task page, the worker's banner and
the orchestrator's tools report, distinguishing same-checkout from same-Node
concurrency. "Resume now" lets ordinary scheduling act first; the one
restriction it can turn into a one-time exception is a Node's reserved
scheduling slot, and only through a durable request bound to the exact attempt,
conversation, Node, checkout, queued prompt and slot holders that a signed-in
operator approves in a dialog. The planner spends it at most once and only while
that binding holds; checkout exclusivity, budgets and holds are never
overridden. See [Queued follow-up admission and Resume now](docs/orchestration-lifecycle.md#queued-follow-up-admission-and-resume-now).

Where a step runs is decided once, in `decidePlacement`, and recorded on the
step. A Run pins to a checkout when it first writes to one, so later work that
must see those changes — a reviewer above all — is sent there. That pin says
where the changes are, not where the orchestrator lives: naming a workspace is
how legacy work targets something else, and a legacy pin belonging to a Run
that has written nothing is ignored. Managed Runs select and pin their source
and exact committed base at creation; their implementation/review/fix-up steps
cannot switch repositories or physical worktree generations.

Naming **Chats** is how it asks for the one destination that is not a checkout,
and the only place the decision loses a candidate rather than gaining one: a
writing or reviewing step drops every Chats Placement before ranking, and is
refused if nothing else is left. The cost of not doing that is not a step that
fails — it is a step that succeeds in a home directory and takes the Run's pin
with it, sending the review that follows to a tree the work was never in.

Its token is signed rather than stored: an HMAC over the session id, keyed from
settings, so nothing about it has to survive in memory and a restart changes
nothing. An earlier version kept hashes in a map and that was wrong in a way
worth recording — an orchestrator its Node keeps alive never settles, so nothing
resumes it and nothing hands it a replacement. It carried on with a token the
restarted Host no longer knew, and Copilot's response to a server it cannot
authenticate against is to drop that server's tools from the list entirely. The
symptom was "the fleet tools are unavailable", three steps removed from the
cause.

Revocation is therefore the state of the session rather than the presence of a
row: a call must resolve to a session that still exists, is still a lead, and is
not terminal. Stopping an orchestrator takes its tools away on the next call.

Stopping it ends that conversation and nothing else. Its tasks keep running —
steps already dispatched finish and pending ones still dispatch — and each
settle is owed to the lead as a wake, delivered once Resume brings it back. It
used to archive every task as well, so stopping a lead that had wedged threw
its in-flight work away with it.

`session/load` takes its own server list, so an orchestrator resumed without one
comes back unable to dispatch anything; the same config is supplied on both
paths.

The Host names only the path. Which address reaches the Host differs per Node —
tunnel, LAN, loopback — and the Node is the one that knows, because it is
connected on it. Left to the Host the address came from the same resolution
enrollment uses, which prefers a public tunnel, and an agent on the Host's own
machine would have been sent out to the internet to reach a port it was already
talking to.

### Handing tasks to another orchestrator

A task belongs to exactly one orchestrator: its run's `leadSessionId`. The owner
is what the engine wakes when the task's work settles, what its owed prompts go
to, whose conversation panel lists it, and what PR maintenance's heartbeat
claims the task's registrations for. One owner per task is what keeps two
heartbeats off one PR.

Ownership moves; the work does not. An orchestrator has one context window —
ACP offers no long-context tier — so a long-lived conversation fills, and
starting a fresh one only helps if the work in flight can follow it.
`transferRun` reassigns a task in one transaction: the run, its maintenance
registrations (a pause the previous lead made itself goes with them) and a
pending maintenance proposal. Workers, steps, checkout, budget and notes stay
where they are, and a step already running settles to the new owner.

The new owner has none of the task's history, so it is owed a
`<fleet-task-transfer>` brief — held on the run like any owed prompt, together
with anything the previous owner was owed and never sent — telling it to read
the record and continue rather than re-plan. A closed task moves without one,
because nothing is delivered to a closed task and an owed prompt there would
only hold its sessions back from retention. A send-back, reopen or maintenance
direction that arrives before the brief is read is appended to it, not
substituted for it.

Who may transfer is deliberately not restricted. The operator moves tasks from a
task's page, a conversation's task panel or the board, and an orchestrator hands
work on or takes it over with `fleet_transfer_task`; `fleet_list_orchestrators`
is the one read that crosses conversation scope. What is refused is an unsafe
move: to a conversation that is stopped, stopping or dismissed; while a command
may still be changing the task's checkout; or while a command the previous owner
requested for the task is unsettled, since its result goes to whoever asked. A
registration's observation scope includes its owner, so a reservation the
previous lead held cannot be checkpointed after the move.

### Opt-in PR maintenance

Maintenance is durable task continuity, not a second scheduler: the existing
Orchestrator discovers scoped registrations through Fleet MCP, reads the provider with
the packaged bounded helper on an authorized Node, and dispatches the retained
eligible worker through the existing follow-up path. Browser task actions supply
human authorization; MCP cannot mint an operator principal or approve its own
scope. Node credentials and provider tokens stay on their existing boundary.

Conversational enablement uses `fleet_prepare_pr_maintenance` to resolve the owned
task baseline and existing coder from fresh URL-matched provider metadata.
Ambiguity returns choices, never an invented worker or binding. The task panel
sends only an optional URL to its existing lead; registration JSON is not a human
workflow. Preparation (or the advanced `fleet_propose_pr_maintenance`) saves one versioned,
unapproved proposal per task and publish an existing task notification. The task
dialog is prefilled, and the authenticated operator approves the stored ID/version.
Proposal creation never dispatches a worker or reserves PR ownership; activation
reuses normal enablement checks and consumes the proposal atomically.

Registrations separately retain identity/binding, lifecycle, optimistic version,
authorization, decisions, observations, batches, per-finding outcomes, remote
effects and budgets. A terminal PR is not a settled batch. PR, remote head-ref and
worker ownership remain reserved while work/effects are unsettled; active/paused
owners are automatic-retention roots. Cleanup admission rechecks those roots.

Helper failures additionally retain bounded incidents and exact sanitized errors.
Existing lead delivery deduplicates the recovery wake; alternate provider evidence
requires a pre-I/O reservation tied to the Host turn and a stable resolution receipt.
Source/method/evidence references and freshness accompany that receipt. Recovery
does not reset request/attempt budgets or clear access, identity, Stop, design or
unknown-effect holds. The UI derives its single current stage and settled-round
count from these records and separates released/terminal PR history.

Shared maintenance admission applies to task completion/reopen, dispatch and
queued execution, bound-session prompt/resume, and publication. Human holds are
task/resource scoped, not lead-wide. Send back records the exact decision version
and bounded operator direction in the same transaction as its task note/review
transition. Generic approval/reopen never consumes a pending maintenance decision.
Stop and archive pause first, preserving review/effect evidence; deletion cannot
discard unsettled continuity.

This is an eligible-worker pilot. Sealed/published/cleaned managed continuation,
standalone handoff, automatic merge, paid reviewer sessions, and an independent
provider observer remain unsupported. Helper observations and model reports are
evidence, not transactional exactly-once remote effects or hostile-shell isolation.
The proposed model-evaluation success thresholds remain unmeasured by deterministic
tests.

## Browser UI

Nothing renders until the Host says who is asking. `AuthGate` holds the whole
app behind one card — a security checkpoint rather than a login form: the
brand, a trust rail naming the three separate facts (Host → Microsoft identity
→ Nodes) and which of them currently hold, and exactly one question at a time.
The states are named after what the Host is, not after what failed:
`entra-unconfigured`, `unclaimed`, signed-out, `forbidden`, device-blocked, and
"this address cannot sign you in". A refusal that happens at the Microsoft
callback redirects back into the app with a closed-set reason code rather than
leaving a JSON body in the address bar, and the app supplies its own words for
it — so a crafted link cannot put a stranger's sentence on the sign-in screen.

Three destinations: the **Orchestrator**, the **sessions** it and the operator
have started, and Settings. The orchestrator sits above the workspace tree
rather than inside it, because it is fleet-wide — filing it under whichever
workspace its process happens to occupy made it read as one project's tool, and
that is the opposite of what it is.

Sessions are arranged as a tree or as a wall; the orchestrator's tasks as a
stage board, a list, or a dependency graph. These are two different levels, and
the top bar shows whichever belongs to the current destination. Collapsing them
into one setting is what once made switching to the wall silently drop the
orchestrator: there was no way to be in "overview" and "orchestrator" at once.

The board's four stages — planning, in progress, validation, done — are derived
from Run state and its steps, not stored. A Run's own `phases` are named per
task, so they cannot be columns; two tasks would disagree about what the board
was. What is stored stays per-task, and the board reads across it.

**Attention** is the one interrupt. It cannot be read from Run state alone: a
permission belongs to a session event, and is joined to a task through the step
that owns that session. It is the only use of amber, it sorts to the front of
every list, and it is counted once in the top bar and beside the Orchestrator
row.

Opening a worker's transcript from a task remembers the task, so leaving is a
return rather than a fresh navigation. Composer drafts are held above all of
this, keyed by session, because half of what an operator does unmounts the
terminal view.

The UI does not offer a way to pause and resume a task. Nothing in the protocol
resumes one, and a stop that looked reversible would be a lie about what the
engine can do. Abandoning cancels and keeps the record.

## Scheduling

MVP uses explicit placement selection:

1. User chooses a Workspace Placement in the browser.
2. Host verifies that its Node is online and below `maxSessions`.
3. Host creates a queued Session and sends `start_session` to that Node.
4. Node canonicalizes the stored path, enforces its own capacity again, and starts Copilot.

A later automatic scheduler can select the least-loaded eligible Placement without changing the model.

## Session and turn semantics

```text
queued -> starting -> running -> idle -> running ...
                     |           |
                     v           v
                 cancelling     stopped
                     |
                     v
                    idle
```

Terminal states are `stopped`, `completed`, and `failed`. A transport disconnect
causes the Node to stop all local processes, so Host records affected sessions
as `failed`. `offline` is only a temporary Host-restart reconciliation state;
the reconnecting Node's empty inventory converts stale rows to `failed`.

- **Cancel** sends ACP `session/cancel` for the active Turn and keeps the process available for follow-up.
- **Stop** closes ACP and terminates the Copilot process.
- ACP updates may still arrive after Cancel until the prompt returns its final stop reason.
- Cancel denies every pending permission request before sending
  `session/cancel`, preventing the ACP turn from hanging on a permission promise.

### Reconnecting mid-turn

A dropped transport says nothing about the agent behind it. The Copilot process
keeps working, so a Node that reconnects two seconds later still owns a Turn the
Host stopped hearing about.

The Host therefore cannot infer what a returning Session is doing, and it must
not guess: assuming `idle` unlocks the browser composer over an agent that is
still mid-Turn, and ACP permits only one active prompt per Session. Every
follow-up sent into that window was refused by the Node and — because the
command had already been acknowledged and the rejection discarded — vanished
without an event, an error, or a state change.

So the Node reports which Sessions are busy alongside the ones it holds, on both
hello and heartbeat, and the Host restores those to `running` rather than
`idle`. Nodes that predate the `session-activity` capability report none, and
keep the old landing state.

Refusal is also made visible rather than silent. A command the Node declines
without anything being broken — a prompt arriving mid-Turn — comes back as a
non-fatal `command_result`, which tells the operator why while leaving the
Session alone; failing it would destroy a healthy run over a mistimed message.
The Node re-announces the Session's true state behind the refusal, so a composer
opened over a wrong guess closes on its own.

A refused start or resume is the exception: no process started, so nothing will
ever re-announce it, and the `starting` the Host recorded would stand forever —
shown as running, with Cancel disabled. When the refused command is the launch
the Session is still waiting on, the Host settles it `failed` with the Node's
reason, which keeps it resumable.

### Turns Copilot starts on its own

Not every Turn begins with a prompt. A backgrounded shell finishing wakes the
Copilot process, which reads the output and carries on working — tool calls,
reasoning, and a reply all arrive as ordinary `session/update` notifications
with no `session/prompt` behind them.

Session state was read off that request alone, so the fleet reported `idle`
throughout and meant it: the composer stood open over an agent mid-Turn, Cancel
was disabled for the whole of it, and the chime that announces a finished
Session had already sounded — in one observed case fourteen minutes before the
agent stopped.

The Node therefore treats updates arriving while it is not prompting as a Turn
of the agent's own, and reports `running` for it. ACP has no notification that
starts or ends such a Turn, so its end is inferred from the stream going quiet
(`UNPROMPTED_QUIET_MS`), with an unfinished tool call holding it open for a
bounded while longer (`UNPROMPTED_TOOL_GRACE_MS`) — a tool says nothing between
starting and ending, which is the one silence that means the opposite of
finished. Cancel settles such a Turn directly, because there is no prompt
response to carry a stop reason back.

## Protocols

### Browser to Host

REST performs CRUD and commands. WebSocket pushes snapshots, Node status, Session state, and Session Events.

### Node to Host

The Node WebSocket carries:

- a mutually authenticated handshake — `client_hello`, signed `host_challenge`,
  `node_proof` — after which every frame is an AEAD-sealed, sequenced envelope.
  The legacy `hello` first frame is still accepted while machines that predate
  Node keys are being migrated. They are migrated by re-running a Connect
  command, not over that connection: a shared secret has already reached
  whatever relayed it, so nothing sent back can prove which Host is answering.
- heartbeat with active Session IDs, and which of them are mid-turn
- Host commands: start, prompt, cancel, stop, permission response
- Host address announcements when the Host's public URL changes
- Self-update instructions, and the progress a Node reports back
- Session file reads for browser downloads, each answered by one chunk
- Node command results and ordered Session Events

Commands use unique IDs for deduplication. Events use an event UUID and a monotonically increasing per-Session sequence.
Host accepts Session Events and command results only when their Session belongs
to the authenticated Node. Malformed or cross-Node frames close the connection.
Missing heartbeats also close the connection and trigger terminal reconciliation.

A Node holds events it raises while the Host is unreachable and replays them once
authenticated, so an agent that keeps working through a Host restart still has
its output recorded. The buffer is bounded, and the Host stores an event whose
sequence runs ahead of the next expected one rather than refusing it: the missing
events are gone with the outage, and a Host that insists on them refuses
everything after them too, which leaves the Session unable to report its own
state ever again.

### Session file downloads

A browser download of a file on a session's machine is pulled through the Host,
because Nodes only dial out. `GET /api/sessions/:id/files/stat` and `/download`
send `session_file_read` over the Node's sealed channel — never a legacy one, and
only to Nodes advertising `session-files-v1` — and each `session_file_data`
answers exactly one read. Reads are stateless: each names the file, offset and
length again and carries the `version` (device, file id, size and modification
time) the first read reported, so an abandoned download leaves nothing open on
the Node and a file that changes mid-download fails instead of arriving spliced.
The Host keeps two 256 KiB reads in flight per download and at most three
downloads per Node, answers the browser only once the first chunk is in hand so
a refusal is still an HTTP error, and fails pending reads when the Node
disconnects or 30 seconds pass without an answer.

The Host names the session's roots — its working directory (execution binding,
else placement), additional directories, whether it is an orchestrator, its
Copilot session id, and the Host's own data directory as protected — and the
Node decides. It resolves the path through links and junctions, requires it to
lie inside a root, and refuses its own configuration directory, Copilot's home
and whatever the Host marked protected, unless the root granting the file sits
strictly inside them: an orchestrator's scratch directory, the session's own
`session-state` folder. Responses are `application/octet-stream` attachments
with no HEAD route, because Fastify would drain the whole file across the Node's
connection to answer one.

### Host address changes

Both sides validate every frame against the message union, so a Node closes the
connection on a message type it does not know. New message types are therefore
gated on a capability the Node advertises in its hello: `host_url` is sent only
to Nodes reporting `host-url-sync`, which keeps a mixed-version fleet working.

The Host polls its own public URL — a tunnel it started, a tunnel running as its
own process, or `FLEET_PUBLIC_URL` — and announces a change to connected Nodes.
Loopback fallbacks are never announced, since they name the recipient's own
machine rather than the Host.

A Node adopts the announced address, keeps the one it was using as a fallback,
and leaves the live socket alone: it learns where the Host went without losing
the sessions running on that connection. A dial that never reaches `welcome`
rotates to the next known address, and whichever one authenticates becomes the
primary, so an announcement that is wrong for a particular machine cannot strand
it. This helps every Node whose path to the Host outlives the change; a Node
reached through the tunnel that just rotated loses that socket with it and
recovers through the same rotation on reconnect.

Announcement only reaches Nodes that are connected when the address changes,
which is exactly the set that is empty across a Host restart. A Host that comes
back on a new quick-tunnel hostname is therefore unreachable and unable to say
so: every Node dials the addresses it knows, all of them stale, and the fleet
has to be repointed by hand. That is a property of the tunnel, not of this
protocol — `cloudflared tunnel --url` and free ngrok domains are documented as
rotating on every restart. A fleet that restarts its Host needs an address that
survives it: a named Cloudflare tunnel, a Tailscale Funnel hostname, or
`FLEET_PUBLIC_URL` in front of a stable reverse proxy.

### Reaching a private Dev Tunnel

A private Dev Tunnel cannot be dialed directly, so a Node started with
`--devtunnel=<id>` holds a `devtunnel connect` for its whole run and reaches the
Host through the loopback port that forwards. The port is read back from the
CLI's output rather than assumed, because the CLI quietly picks another when the
one it wants is taken.

That connect is retried, including the very first attempt. It used to be retried
only after it had succeeded once, which drew the line in the worst possible
place: a machine that had just rebooted raced its own network, lost that race,
and exited — permanently, since the supervisor forwards a crash rather than
looping on it. Its already-connected neighbours were never asked to resolve
anything and carried on working, so the fleet looked healthy while the one
machine that needed to come back was the one that could not. Retrying is now the
default and the ready timeout is the deadline.

Two failures are reported immediately instead, because no wait improves them: a
CLI that is not signed in, and a tunnel this account cannot see. They are told
apart by what the CLI said, not by its exit code alone — the codes are reused
across causes, and an unrecognised message falls through to the retry loop,
which is the safe way to be wrong.

Whatever the CLI printed is quoted in every one of these errors. It used to be
read into a buffer and dropped, leaving an exit code and a fixed suggestion to
run `devtunnel user login` — which is a different failure with a different exit
code, so the one line that explained the problem (`Tunnel not found: <id>`) was
discarded in favour of a guess that sent operators to a machine that was already
signed in.

#### Naming one tunnel rather than one name

A Dev Tunnel is identified by `<name>.<cluster>`, and the cluster is chosen by
the service at creation time from wherever the creating machine reached it. A
bare `fleet-abc` is therefore not an identifier: it is a name that can exist
once in every cluster, and `devtunnel create fleet-abc` from a machine that now
resolves elsewhere reports no conflict, because in that cluster the name is
free. It quietly mints a second tunnel.

That is what a Host reboot did. The Host came back hosting `fleet-abc.usw3`
while every Node still dialed the `fleet-abc` that resolved to `.usw2`, and the
fleet was split in half by a name both halves agreed on. Nothing failed loudly:
the Nodes' tunnels came up and forwarded a port to a tunnel with no host behind
it, which looks exactly like a Host that is down.

The Host now records the name the CLI reports rather than the one it asked for.
`devtunnel host` prints `Ready to accept connections for tunnel: <name>.<cluster>`
— the tunnel it actually hosted — and that fully-qualified name is adopted and
persisted, so every later start, and every `--devtunnel` command handed to a
Node, names one tunnel from any machine in any cluster. The parsing already
existed and was already correct; its result was thrown away, because the id was
seeded from settings before the spawn and only filled in `if` it was still
missing.

### Keeping Nodes current

A Node reports the git revision of the checkout it runs from, and the Host
reports its own. Semver never moves between deploys, so the commit is the only
value honest enough to compare, and the Nodes view marks a Node stale when its
revision differs from the Host's. A Node built from a tarball reports no
revision at all and is simply never called stale, since there is nothing to
compare and no checkout to pull into.

An update fetches, resets the checkout hard onto its tracking branch, installs,
and builds _before_ anything is torn down, so a build that no longer compiles
leaves the machine running the code it already had. Only once the build succeeds
does the Node give up its place. A reset that changes nothing skips the restart
entirely rather than dropping every connection to arrive back where it started.
The reset is deliberate: a Node's checkout is a deployment, not somewhere to
keep work, and `--ff-only` meant one stray local commit on a machine nobody logs
into froze it behind the rest of the fleet forever. Untracked files survive, so
the `.env` that names the Host is not swept away with the divergence.

A Node does not replace itself. It exits with status 75 and a supervisor
(`apps/node/supervisor.mjs`, or PM2/NSSM/systemd) starts the new build. The
version that did replace itself spawned a detached successor, which is only
sound if the successor reliably wins the instance lock — and on Windows it also
arrives with a console window of its own. Under `tsx watch` it lost that race
every time: the pull changed the source, the watcher restarted its own child
first, and the successor found the lock taken and exited. The Node came back,
but by the watcher's accident rather than by the update's design, so the failure
was invisible until the watcher was not there. Doing the restart from a process
that took no part in the update removes the race, the window, and the guesswork
about which entry point to relaunch. The self-replacing path survives for a Node
launched with no supervisor at all, and waits for its predecessor's exit before
taking the lock.

Status 75 rather than 0 is what lets a supervisor tell an update apart from a
stop; without the distinction, Ctrl-C would bring the Node straight back. The
built-in supervisor restarts on that status and forwards every other exit, so a
crash stays a crash instead of becoming a loop.

Nodes running Sessions are refused rather than queued. An update restarts the
process and every agent it hosts dies with it, so the choice of when to lose
that work belongs to a person, not to a retry loop.

The successor is launched from saved settings rather than from the flags its
predecessor was started with. A flag outranks settings.json, which is what the
operator wants on the run they typed it on and the opposite of what they want
afterwards: a Node started with `--url=<quick tunnel>` persists that address,
and when the tunnel rotates the operator moves it from the config page. Replaying
the original flag into the successor reverted that edit, so the Node came back on
an address that no longer existed — unreachable, and therefore impossible to
tell where the Host had gone. Settings-backed flags are dropped and the current
settings are written to disk before the Node exits; flags with no home in
settings, such as the enrollment token and the config port, are passed through.

### Keeping the Host current

The Host updates itself with the same procedure (`@fleet/protocol/updater`:
fetch, hard reset onto the tracking branch, `npm install --include=dev`, build),
building everything with `npm run build` because the Node started beside it runs
from the same checkout. That module is the one place the update strategy lives,
so replacing commits with released versions later is a change there rather than
in both services.

Unlike a Node, the Host never runs the steps itself. Under `npm run dev` the file
watcher restarts the Host the moment the reset rewrites its source, killing the
update halfway; and as a Windows login service, everything the Host starts sits
in the task's kill-on-close job, so a process it spawned to run
`npm run service -- host+node restart` would die at the step that stops the Host
task. The work therefore belongs to something that survives the restart:

- `npm run dev`, `npm run dev:tunnel` and `npm start` run their commands
  (`<script>:bare`) under `scripts/launcher.mjs`. The Host asks it over a local
  socket (endpoint and token in the environment it hands down, which the Node
  strips before starting agents); the launcher updates, then stops the whole
  process tree and runs the same command again in the same terminal.
- A login-service Host registers a one-off scheduled task for the same user
  (`scripts/self-update.mjs`), which Task Scheduler runs outside both Fleet
  tasks. It updates, runs `npm run service -- host+node restart` (or `host`
  when the Node task was stopped on purpose or is not installed), and deletes
  itself. The Host recognises that it was started by the login service because
  its standard output is the log file the service manifest names.

Either updater writes every stage to `self-update.json` in the Host's data
directory, rewriting it every thirty seconds while a long step runs, and takes
`.fleet-update.lock` in the checkout for as long as git and npm are working in it
— the same lock a Node's own update takes, created whole and touched as it
works, so the Host and the Node beside it never update one checkout at once,
even across a restart. The Host relays the record to browsers while it lasts,
and the Host that comes back reads it. Neither restart can see its own outcome —
the launcher only launches a command, and the login CLI only checks that the
tasks are running — so the restarted Host finishes the record: once it is
listening, on the commit the update built, and with the Node beside it back on
that commit (within three minutes) if this Host knows that Node. Any other
unfinished record whose updater has gone quiet is a failure. As with a Node, a
build that fails restarts nothing. The Host additionally refuses a checkout with
uncommitted changes to tracked files — often somebody's working copy — asking
when the operator clicks and again in the updater just before the reset, and
treating a checkout git cannot read as dirty. It refuses while the Node beside
it is running sessions unless the operator agrees to stop exactly the ones
listed, and until the restart it refuses to start or resume anything new there.

At the restart-confirmation handoff, the updater stops rewriting its heartbeat
record, so it cannot overwrite the new Host's final outcome. Browsers likewise
keep newer live update status and complete snapshots when an older REST response
arrives.

git is never run through a shell. A tracked branch may legally be called
`release&x`; joined into a Windows command line, that was a second command.

### Node to Copilot

The official `@agentclientprotocol/sdk` connects to `copilot --acp --stdio` and performs:

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/update` streaming
- `session/request_permission` round trips

ACP support in Copilot CLI is still public preview, so protocol/package versions are pinned and should be upgraded deliberately.

## Security boundary

Five separate facts: a tunnel decides who can **reach** the Host, optional Entra plus this Host's administrator table decides who may **operate** it, a live lead token decides which orchestrator may call `/mcp`, a Node key decides which **machine** is connected, and the Host signing key decides whether a command came from the real Host. In explicit no-auth mode, reachability also grants operator access.

### Who may operate a Fleet

- **Optional Microsoft setup.** `POST /api/auth/skip` consumes a browser-bound console bootstrap grant and persists `auth.mode=no-auth`, only when no administrator or password protection exists. The operator guard permits loopback or a known private Dev Tunnel, retains Host/Origin checks and HMAC CSRF proof, and leaves Node and lead authentication unchanged. Public tunnel providers are refused at the API and transport layers. No Microsoft identity is invented: node-management actions are audited as operators; Microsoft administrator actions remain restricted. The setup tour opens immediately. Settings reuses console-protected setup, keeping no-auth access until a successful Microsoft claim closes all anonymous browser streams. Keep the listener on loopback and never grant anonymous Dev Tunnel access.
- **Two proofs to claim.** A fresh Host prints a 128-bit one-time claim code to its own stdout (bypassing the HTTP-readable log buffer), keeps only its hash in memory, and expires it in 30 minutes. Claiming needs that code **and** a Microsoft sign-in. Neither alone is sufficient, and the claim is one `BEGIN IMMEDIATE` transaction, so two identities racing produce one administrator and one `409`.
- **An upgraded Host proves the same thing with the password it already had.** `POST /api/auth/bootstrap/password` (`apps/host/src/routes/auth.ts`) issues the identical short, browser-bound bootstrap grant to a live password or recovery session on a Host with no administrators, and is audited as `bootstrap_password_granted` rather than as a console redemption. It is an ordinary operator route — live session plus CSRF — and additionally refuses a Microsoft session and a Host that already has an administrator. The console code is neither required nor revealed; `ClaimCodeService.grantTrusted` mints the grant without touching it, so an operator session never becomes console-equivalent knowledge.
- **Authentication is not authorization.** Entra says who somebody is; this Host's `administrators` table says whether they may drive it. A valid account from the configured tenant that nobody added receives a named `403` and no session at all. Identity is keyed on immutable `(tid, oid)` — never email, which can be reassigned.
- **Adding another account** is an explicitly preauthorized operation, separate from shareable invitations. `POST /api/auth/administrators/add/start` requires a live administrator session, CSRF, and recent authorization-code reauthentication. Its single-use PKCE transaction binds the initiating administrator/session, browser, and registration; completion rechecks those proofs before adding the identity returned by Microsoft. The new-tab account picker leaves the original Fleet session intact and issues no session for the added account. Ordinary invitation redemption still creates only a candidate requiring approval.
- **No source-address trust.** Every supported tunnel relays into `http://127.0.0.1:<port>`, so `request.ip`, apparent loopback, `x-forwarded-proto` and the `Host` header describe the relay, not the browser. None of them is a security input. The only trustworthy witness to a scheme is the set of URLs this Host published for itself (`apps/host/src/auth/external-scheme.ts`).
- **Seven named states** (`no-auth`, `entra-unconfigured`, `unclaimed`, `legacy-password`, `hybrid`, `microsoft-only`, `recovery`) rather than a pair of booleans, because each asks the browser for something different and the gate has to say which. Existing administrators or passwords take precedence over a stale no-auth setting.
- **Login flows.** Optional authorization code + PKCE requires an approved operator/publisher-owned app registration with a public/native `http://localhost:<port>/api/auth/entra/callback` redirect. Fresh installs never borrow the Visual Studio client; legacy claimed Hosts retain pinned configurations. Device code is an optional fallback that stays off until an administrator has watched one complete on this Host. MSAL performs all protocol and token validation; Fleet hand-rolls no JWT checking and persists no Microsoft token.
- **Sessions** are opaque 256-bit values stored as SHA-256 digests, `HttpOnly`/`SameSite=Strict`, `Secure` on a published HTTPS endpoint, seven-day idle and 30-day absolute. CSRF is `HMAC(csrfKey, sessionTokenHash)` — derived, so there is no per-session secret to leak. Removing an administrator revokes their sessions and closes their live browser sockets in the same operation; a 60-second sweep re-checks every socket against the live rows.
- **High-impact actions** — adding or removing an administrator, enabling or disabling the password, exporting a portable backup — additionally require an authorization-code sign-in within ten minutes. A device sign-in does not satisfy it: an attacker can start a device flow and have an administrator finish it.
- **Connect commands** require a live Microsoft administrator session and CSRF in Microsoft mode, not recent reauthentication. Both authorization-code and device sign-ins may mint the single-use, fifteen-minute enrollment grant. In no-auth mode, reachable operators with CSRF proof may mint the same grants.
- **Legacy password** is opt-in, warned about, and automatically retired by the first successful Microsoft claim: the verifier is deleted and its sessions are revoked before the Microsoft session is issued. `auth.passwordEnabled=0` keeps a stale `FLEET_OPERATOR_PASSWORD` from re-enabling it. A recently reauthenticated Microsoft administrator may explicitly enable a new 16-character-or-longer password in Settings, returning the Host to `hybrid`; a local console command can issue a temporary recovery password.

### The guard

- A central `onRequest` guard covers `/api/*` and `/ws/*`, so a route added later is protected by having been added at all. Rules are ordered **method + anchored regex** naming an expected principal (`anonymous`, `bootstrap`, `transaction`, `operator`, `node-protocol`, `enrollment`, `lead`), not a literal set of open paths — which is how a parameterized route such as `/api/auth/device/poll/:flowId` would otherwise be left out or let in wholesale. Anything unmatched is an operator route.
- Unrecognised `Host`/`Origin` names are refused (DNS rebinding). A session or bootstrap grant is issued only over loopback or a published HTTPS endpoint; a plain-HTTP relay such as `bore` is refused by the Host for the operator console, not merely greyed out in the panel.
- `/mcp` is a second machine principal, not an operator-cookie exception: a signed lead token bound to a live lead session, run and node, with browser `Origin` rejected and every failure audited without recording the bearer.
- A tunnel (Dev Tunnels, Cloudflare, …) forwards to the Host process on `PORT` (default 8787): `/api`, `/ws/node`, `/ws/browser`, and the built UI. It authenticates a network path, not an operator. In `npm run dev` the page you click is Vite on 5173; the tunnel does not point at that.

### Machines

- New enrollment sends no reusable credential to an unauthenticated Host. A one-time grant (256 bits, 15 minutes, one machine, stored only as the digest that is also its HMAC key) authorises exactly one Node public key. The Node generates its Ed25519 pair first, pins the Host fingerprint from the Connect command, and completes only against a Host that can sign for it.
- Each connection authenticates ephemeral X25519 keys with both persistent identities and derives directional AES-256-GCM keys over the transcript, with a per-direction monotonic sequence. A relay can carry the traffic but cannot read, forge, or replay it.
- The fleet-wide `ENROLLMENT_TOKEN` exists only for machines that predate Node keys. A fresh Host never has one: it does not require one to start, does not persist one, and refuses token registration outright. An upgrade is recognised by evidence — a stored token, or Nodes still authenticating with a shared secret — and mints one for itself if the settings table lost it. There is no automatic upgrade off a shared secret: that secret has by definition reached whatever terminates the Node's connection, so a key request sent back over it proves only that the asker has seen it. A legacy machine migrates by running a fresh Connect command, which carries a one-time grant and the Host fingerprint out of band and reclaims that machine's own row: the Node obeys that command over its own stored credentials — enrolling under the name the Host knows it by, unless it is already key-enrolled against that same Host id and fingerprint, in which case a re-run spends no grant — and refuses a partial command rather than quietly keeping the secret it was meant to retire. Settings reports the remaining count; enforcement deletes the stored secrets, retires the token, and is refused while any Node still needs one.
- The Host database holds the Host private key, the administrator table, and the CSRF and lead-token keys, so its file permissions are part of the boundary. The data directory is `0700` and the database plus its `-wal`/`-shm` journals are `0600` on Unix; on a production Windows Host every item in the tree gets a complete replacement DACL — built from nothing, inheritance broken, and exactly three entries granting full control to the running account, SYSTEM (`S-1-5-18`) and local Administrators (`S-1-5-32-544`) — written in one `powershell.exe` invocation over the directory and everything already in it, with the directory's entries inheritable so later journals land inside them. The running account is resolved to a SID by the script itself rather than read from `USERDOMAIN`/`USERNAME`, and there is no intermediate state: the two-call `icacls /reset` shape it replaced left the whole tree inheriting the parent's "Users: read" in between. A production Host that cannot apply either refuses to start.
- Nothing that carries a credential crosses a plain-HTTP address that is not loopback. The tunnel manager refuses to start an ineligible provider however the request arrives — route, persisted settings at boot, or unattended restart — and refuses to adopt one started outside the Host, so such a URL never enters the allowlist, the scheme map, or enrollment. The request guard refuses `/mcp` and the enrollment routes over an address this Host published as HTTP, and a Node refuses to enrol by either protocol — grant or fleet-wide token — to dial, or to rebase an agent's MCP endpoint onto one.
- Node HTTP credentials reach only the catalog routes the config page relays, and a node can only place its own paths.
- Copilot credentials stay on the Node.

### Everything else

- Session creation references a Placement ID, never an arbitrary browser-supplied path.
- Child processes use an argument array and `shell: false`.
- Permission requests fail closed. YOLO is off unless the stored default is exactly `"1"`.
- A version 1 data restore preserves the security envelope of the Host it lands in — administrators, auth mode, Entra config, Host identity, CSRF and lead-token keys — and can never return a secured Host to `unclaimed`. It carries no Node keys either, so a key-based Node keeps the public key this Host already holds for that row; an archive naming one this Host has no key for is refused with the whole restore rolled back, rather than restoring a `mutual-auth-v1` row with nothing to verify against. A version 2 portable backup moves that envelope deliberately, encrypted with `scrypt` + AES-256-GCM under an operator passphrase, atomically, revoking every session on restore; its sealed section supplies the Node keys to the data half inside the same transaction. Whether mutual Node authentication is enforced travels in the sealed section, so a fleet that had retired the shared Node secret does not come back accepting it — and the fleet-wide enrollment token that enforcement retired is not written back. After the transaction commits, the Host reloads its identity service, adopts the archive's lead-token and CSRF keys, and only then publishes: nothing observes a Host that is half of each.
- Both Host archive versions carry the enabled-provider list and stable Dev Tunnel IDs, including the region suffix, but no tunnel-provider login credentials. Restoring reconciles managed tunnel processes after the data/security transaction; an incompatible externally owned tunnel is refused before restoring, and a later setup failure is reported as an already-applied restore with the archived ID retained for retry. Older archives without IDs retain the destination's existing ID rather than guessing one from the public URL.
- A bounded local `security_audit` (newest 10,000 rows, 500-character sanitized detail) records the decisions. Claim codes, authorization codes, device codes, Microsoft tokens, cookies, invitations, grants, lead tokens and private keys are never written to it.
- Internet exposure should still use HTTPS/WSS. An access policy in front of the Host (for example Cloudflare Access) remains a good second layer.

## MVP non-goals

- Viewer/operator/admin role differences — every administrator is a peer with full authority
- Cross-tenant administrators for one Fleet, and Graph-based user search
- Hardware-backed Host or Node keys
- End-to-end encryption of Node payloads against a malicious tunnel relay
- Session migration or automatic resume after Node disconnect
- Git clone lifecycle and adoption of user-owned worktrees (task-owned managed
  worktree lifecycle is supported; no automatic push, PR or cross-Node migration)
- Multi-user RBAC and billing
- Agent adapters other than Copilot CLI
- Kubernetes/Nomad scheduling
