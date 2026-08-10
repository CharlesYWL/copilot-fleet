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

## Protocols

### Browser to Host

REST performs CRUD and commands. WebSocket pushes snapshots, Node status, Session state, and Session Events.

### Node to Host

The Node WebSocket carries:

- authenticated hello and welcome
- heartbeat with active Session IDs
- Host commands: start, prompt, cancel, stop, permission response
- Host address announcements when the Host's public URL changes
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

- Enrollment token is exchanged once for a unique Node secret; Host stores only its hash.
- Copilot credentials stay on the Node.
- Session creation references a Placement ID, never an arbitrary browser-supplied path.
- Child processes use an argument array and `shell: false`.
- Permission requests fail closed.
- The MVP has no user authentication; internet exposure requires HTTPS/WSS plus an authenticated reverse proxy such as Cloudflare Access.

## MVP non-goals

- Session migration or automatic resume after Node disconnect
- Git clone/worktree lifecycle
- Agent-to-agent DAGs
- Multi-user RBAC and billing
- Agent adapters other than Copilot CLI
- Kubernetes/Nomad scheduling
