# Copilot Fleet Architecture

## Core ownership rules

1. **Host owns desired state and history.** It stores Nodes, Workspaces, Placements, Sessions, and ordered Session Events.
2. **Node owns execution.** Copilot login, child processes, local paths, and ACP connections never leave the Node.
3. **Workspace is logical; Placement is physical.** A Workspace can be available on several Nodes, each with a different absolute local path. A Session is assigned to one Placement and therefore one Node.
4. **One Fleet Session owns one Copilot ACP process.** This makes cancellation, permissions, isolation, and concurrent capacity predictable.
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
```

## Domain model

- **Node**: registered machine, capabilities, capacity, active count, and liveness.
- **Workspace**: logical project visible in the UI.
- **Placement**: `(workspaceId, nodeId, localPath)`. It is the only source of a Session working directory.
- **Session**: one long-lived Copilot process bound to one Placement. Carries an
  optional operator-chosen name; empty means the UI labels it by its initial prompt.
- **Turn**: one initial or follow-up prompt. MVP permits one active Turn per Session.
- **SessionEvent**: ordered append-only normalized ACP output/state/tool/permission event.
- **Permission request**: ACP request waiting for an allow-once or deny browser decision; timeout/disconnect denies it.
- **Run**: one approved objective plus the budget it may spend. Owns its Sessions.
- **RunStep**: one unit of a Run's work, executed by one Session on one Placement.

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

The parallel limit is therefore scoped to a Placement, not a Workspace: two
writing steps may not share a checkout, but a read-only reviewer may — and must,
or it cannot see the diff.

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

A settled worker is stopped at once. `idle` means "waiting for another turn",
not "finished", and an idle agent still reserves a slot on its node; nothing
reclaimed one until its whole Run ended, which for a long-lived orchestrator is
never. Three read-only errands were enough to fill a node with agents that had
nothing left to do, and the fleet reported itself full. That is asked of the
state rather than of the transition — a step is terminal only once, and
anything that missed the moment would otherwise hold its slot forever. A
follow-up after that point is refused rather than accepted, because no step is
tracking that turn: the prompt would land, and the wake it promised could never
come.

Where a step runs is decided once, in `decidePlacement`, and recorded on the
step. A Run pins to a checkout when it first writes to one, so later work that
must see those changes — a reviewer above all — is sent there. That pin says
where the changes are, not where the orchestrator lives: naming a workspace is
how it works on something else, read-only work never takes the write lock, and
a pin belonging to a Run that has written nothing is ignored outright.

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

`session/load` takes its own server list, so an orchestrator resumed without one
comes back unable to dispatch anything; the same config is supplied on both
paths.

The Host names only the path. Which address reaches the Host differs per Node —
tunnel, LAN, loopback — and the Node is the one that knows, because it is
connected on it. Left to the Host the address came from the same resolution
enrollment uses, which prefers a public tunnel, and an agent on the Host's own
machine would have been sent out to the internet to reach a port it was already
talking to.

## Browser UI

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

- authenticated hello and welcome
- heartbeat with active Session IDs, and which of them are mid-turn
- Host commands: start, prompt, cancel, stop, permission response
- Host address announcements when the Host's public URL changes
- Self-update instructions, and the progress a Node reports back
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

An update pulls fast-forward only, installs, and builds _before_ anything is
torn down, so a checkout that has diverged, or that no longer compiles, leaves
the machine running the code it already had. Only once the build succeeds does
the Node give up its place. A pull that changes nothing skips the restart
entirely rather than dropping every connection to arrive back where it started.

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

- The browser UI and `/api` sit behind an operator password (`FLEET_OPERATOR_PASSWORD`, or one generated on first boot). Sessions are `HttpOnly`, `SameSite=Strict` cookies, signed rather than stored: the key is persisted, so a restart does not sign anyone out, and the cookie names the password it was issued under, so changing the password invalidates every one of them. They do not otherwise expire. Signing out clears the cookie and refuses it for the life of the process — the only unconditional revocation is changing the password.
- A central `onRequest` guard covers `/api/*` and `/ws/*` so a route added later is protected by having been added at all. Unrecognised `Host`/`Origin` names are refused (DNS rebinding). Open paths are health, sign-in/out/status, and `/api/nodes/register` (enrollment token). `/ws/node` authenticates in the first frame instead.
- A tunnel (Cloudflare, Dev Tunnels, …) forwards to the Host process on `PORT` (default 8787): `/api`, `/ws/node`, `/ws/browser`, and the built UI. It authenticates a network path, not an operator. In `npm run dev` the page you click is Vite on 5173; the tunnel does not point at that.
- Enrollment token is exchanged once for a unique Node secret; Host stores only its hash. Node HTTP credentials reach only the catalog routes the config page relays, and a node can only place its own paths.
- Copilot credentials stay on the Node.
- Session creation references a Placement ID, never an arbitrary browser-supplied path.
- Child processes use an argument array and `shell: false`.
- Permission requests fail closed. YOLO is off unless the stored default is exactly `"1"`.
- Internet exposure should still use HTTPS/WSS. An access policy in front of the Host (for example Cloudflare Access) remains a good second layer. Shared-password SSO/RBAC is still an MVP non-goal.

## MVP non-goals

- Session migration or automatic resume after Node disconnect
- Git clone/worktree lifecycle
- Multi-user RBAC and billing
- Agent adapters other than Copilot CLI
- Kubernetes/Nomad scheduling
