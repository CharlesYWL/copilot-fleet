# Port forwarding from worker Nodes (experimental)

Date: 2026-10-22, revised 2026-10-26. Status: **draft for review**. Nothing here
is implemented.

Revision 2 records Charles's decisions of 2026-10-26:

1. Use one new connection per forwarded stream (VS Code's model). Do not
   multiplex streams over the Node control channel.
2. Fleet opens the local listener itself, on the Host or on an enrolled Node.
   No connector command is run by hand.
3. Local ports are reserved, and concurrent forwards must never conflict.
4. Orchestrators can request a forward. The request appears in the normal
   command approval places.
5. Add a new **Settings → Port forwarding (Experimental)** page to manage
   forwards, requests, rules and reserved ports.

Revision 3 (2026-10-26) records three more decisions:

- The local listener always runs on the Host. Nodes are never bind sides.
- Ports opened by a `fleet_run_command` execution count as owned by the
  orchestrator session that requested it.
- The Fleet UI stays on `localhost`. Microsoft sign-in requires that name: the
  registered redirect is `http://localhost:<port>` (see `codeLoginEndpoint` in
  `apps/host/src/routes/auth.ts`). Credential separation is achieved instead by
  serving forwards on `127.0.0.1` by default (see
  [Credential separation](#credential-separation)).

## Summary

Make a port that a session's process listens on, on a worker Node, available on
the operator's machine without any inbound port on the worker.

Motivating case: a worker VM builds the extension app and serves it on
`https://localhost:4200`. Today the operator has to sign in to that VM to test
it. With forwarding, the Host listens on its own port 4200, and the operator
tests from the Host machine's browser.

![Port forwarding architecture: a browser on the Host machine connects to a Host port listener on 127.0.0.1:4200. For each connection the Host sends a sealed open-stream frame over the existing Node channel; the worker's Fleet Node connects to the dev server on loopback, then dials a new outbound connection to the Host's stream endpoint, which the Host splices to the browser's connection. Nothing listens on the worker.](../../port-forwarding-architecture.png)

_Source: [`docs/port-forwarding-architecture.html`](../../port-forwarding-architecture.html)._

## Goals

1. Fleet opens and owns the local listener, always on the Host. The operator
   never runs a command.
2. Each forwarded TCP connection gets its own Node→Host connection, carrying
   raw bytes with end-to-end TCP backpressure. Session events are never
   delayed by forwarded traffic.
3. Local ports are reserved and allocated without conflicts. An exact port can
   be pinned for apps that need a specific origin (`https://localhost:4200`).
4. Orchestrators can list a session's ports and request a forward. A person
   approves the request in the existing command approval places. Agents never
   approve.
5. A new experimental Settings page manages forwards, pending requests,
   always-allow rules and reserved ports. It is off by default.
6. Forwarded content cannot read or use the operator's Fleet credentials.
7. Forwards are tied to a session, end with it, and are audited.

## Non-goals (this design)

- Reverse forwarding (the worker reaching a port on the operator's machine).
- Listening anywhere other than the Host. Nodes are never bind sides; a remote
  operator uses the Host's own browser or a later connector (see [Later](#later)).
- UDP, or any target other than the worker's own loopback address.
- Forwarding to processes outside the session when an **agent** requests it.
  Only an operator can create an unowned forward.
- A browser preview served on a dedicated origin (see [Later](#later)).
- macOS and Linux ownership detection. Those Nodes forward manually entered
  ports as unowned forwards.

## How Fleet works today (relevant facts)

| Fact | Where |
| --- | --- |
| Nodes only dial out. The Host cannot open a connection to a Node. | `docs/guide/how-it-works.md` |
| Host↔Node frames are AES-256-GCM sealed and strictly sequenced on one WebSocket. | `packages/protocol/src/node-auth.ts`, `apps/host/src/gateway/node-channel.ts` (`SealedNodeLink`) |
| New frame types are gated by a capability the Node advertises. | `packages/protocol/src/session-files.ts` (`SESSION_FILES_CAPABILITY`) |
| Nodes can authenticate HTTP requests to the Host with a signed node proof. | `apps/host/src/request-guard.ts` (`verifyNodeHttpProof`, `NODE_ID_HEADER`) |
| Each managed agent runs in a named Windows Job Object. Everything the agent spawns stays in that job. | `apps/node/src/windows-process-job.ts` |
| Command approvals have Allow once, Allow during session, Always allow on this Node, and Deny, and appear in a prompt dialog and a command list. | `packages/protocol/src/command-execution.ts` (`CommandDecisionSchema`), `apps/host/ui/src/components/CommandPermissionPrompts.tsx`, `CommandExecutionsDialog.tsx`, `CommandApprovalActions.tsx` |
| Lead tools are served over a bearer-scoped MCP endpoint. Workers get no tools. | `apps/host/src/orchestrator/tools.ts`, `docs/guide/orchestration.md` |
| Experimental features ship off by default, behind a settings toggle. | `docs/superpowers/specs/2026-10-12-experimental-worker-model-routing.md` |
| The operator cookie `fleet_operator` is host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`, and has no `Secure` flag on loopback HTTP. | `apps/host/src/auth.ts` |
| Microsoft authorization-code sign-in only completes on `localhost`. A request arriving on `127.0.0.1` or `::1` is sent to the equivalent `localhost` URL. | `apps/host/src/routes/auth.ts` (`codeLoginEndpoint`), `docs/guide/sign-in-and-access.md` |
| `fleet_run_command` executions run in the command supervisor's own Job Object, record the requesting `leadSessionId`, and stop at their deadline (one hour at most). Permanent dev servers are not supported there. | `apps/node/src/command-supervisor-native.ts`, `packages/protocol/src/command-execution.ts`, `docs/guide/orchestration.md` |
| Ports reserved on a Fleet machine: 8786 (local agent API), 8787 (Host), 8788 and the next 20 ports (Node config page). | `docs/guide/nodes.md`, `docs/local-agent-api-plan.md` |

## Prior art: VS Code Remote-SSH

Read from `microsoft/vscode` `main` on 2026-10-22.

- **Data path** (`platform/tunnel/node/tunnelService.ts`;
  `server/node/remoteExtensionHostAgentServer.ts`): for each accepted local
  connection, the client opens a **new** authenticated connection to VS Code
  Server with `ConnectionType.Tunnel`. The server connects to the target and
  replies `ok`, and both sides then `pipe()` the raw sockets together.
- **Local port selection**: try the remote port first, then a free port. Ports
  that browsers refuse to open are avoided. `requireLocalPort` turns a busy
  port into an error instead.
- **Detection** (`workbench/api/node/extHostTunnelService.ts`):
  - On Linux it reads `/proc/net/tcp*` and maps sockets to processes.
  - It excludes VS Code Server's own processes.
  - It rescans after `max(20 × average scan time, 2 s)`.
  - On Windows and macOS it falls back to URLs printed in terminal output.

Fleet adopts:

- the per-stream connection model;
- the port-selection rules;
- process-based ownership, using URLs in output only as a hint;
- excluding Fleet's own processes;
- the adaptive scan interval.

Fleet differs in three ways:

- **No automatic forwarding.** A forward exposes another machine's software,
  so a person must approve it.
- **Fleet credentials are protected** (see [Credential separation](#credential-separation)).
- **Each stream is sealed with its own key**, because Fleet treats tunnel
  relays as untrusted.

## Design

### Concepts

- **Target**: the Node and session whose process listens on `remotePort`.
- **Forward**: one approved mapping, `Host localPort → target:remotePort`.
- **Reservation**: a Host port held for a forward, or pinned for a label.
  A reservation survives restarts.

### Data path: one connection per stream

![Opening one forwarded stream: the browser connects to the Host listener; the Host pauses the connection, mints a one-time ticket and stream key, and sends a sealed open-stream frame to the Node. The Node checks its policy and connects to the dev server on loopback. If the dev server accepts, the Node dials a new connection to the Host, which verifies the ticket and splices bytes both ways; otherwise the Node reports a refusal code and the Host resets the browser's connection.](../../port-forwarding-stream.png)

_Source: [`docs/port-forwarding-stream.html`](../../port-forwarding-stream.html)._

Details:

- **Control frames** use the existing sealed channel and are gated on the
  capability `port-forward-v1`:
  - `port_stream_open` (Host→Node).
  - `port_stream_refused` (Node→Host), with a code: `forbidden`, `refused`,
    `not_owned`, `limit` or `session_gone`.
  - `port_scan` and `port_scan_result`.
- **The Node checks the target before it dials.** It connects to the dev
  server first, so a refused or closed port fails fast with
  `port_stream_refused` and no data connection is made.
- **Stream connection.**
  - The Node dials `GET /ws/port-stream` at the URL its control socket uses,
    so it works through Dev Tunnels local forwards, Corp direct and public
    URLs alike.
  - The request carries the existing node HTTP proof headers plus the ticket.
  - The ticket is single use, valid for 30 seconds, and bound to `nodeId` and
    `streamId`. It is stored hashed.
  - Upgrades that carry an `Origin` header are refused.
- **Framing.**
  - Binary WebSocket messages carry up to 64 KiB of payload, sealed with
    AES-256-GCM.
  - The nonce is `direction || sequence`, the same construction the control
    channel uses.
  - Half-close (`eof`) and `reset` travel as small sealed control messages on
    the same stream.
  - Backpressure: each side stops reading from its TCP socket while the
    WebSocket's `bufferedAmount` is above 1 MiB, so TCP backpressure works
    end to end.
- **Latency.** A new TCP connection costs one control frame plus the Node's
  TLS and WebSocket handshake, roughly 2–3 tunnel round trips. Browsers reuse
  about 6 keep-alive connections per origin, so a page pays this about once.
  If measurement shows it matters, add a pre-warmed pool: the Node keeps up to
  2 idle, ticketed stream connections per active forward.

### Local listener and port reservation

The Host listens on `127.0.0.1` only. In exact-localhost mode it also listens
on `::1`, because a browser may resolve `localhost` to either address.

**Any remote port can map to any free Host port.** 4200 throughout this
document is only an example. The worker port (`remotePort`) and the Host port
(`localPort`) are independent. For example, worker `:4200` can be served on
Host `:4201`, `:9000`, or the same `:4200`. Matching numbers is a default, not
a requirement.

**Allocation order:**

1. Use a pinned reservation for this workspace and remote port, if one exists.
2. Otherwise use the requested `localPort`.
3. Otherwise use the remote port number.
4. Otherwise scan upward from there, up to 100 ports, then fall back to the
   range `20000–20999`.

**A candidate port is used only if all of these hold:**

- It is not reserved by another forward.
- It is not excluded. Exclusions cover the Fleet ports 8786–8808, browser-
  restricted ports (for example 6000 and 6665–6669), ports below 1024, and
  operator-configured exclusions.
- A real test bind succeeds, which catches ports another program already holds.

**Exact mode.** A request with `exact: true`, or a pinned reservation, never
falls back. It fails with a conflict that names the holder: another forward
(Node, session and remote port) or an external process (PID and process name,
from the same port scan). An HTTPS app that is registered as
`https://localhost:4200` needs exact mode.

**Persistence.**

- Reservations live in `port_reservations`:
  `{localPort, forwardId?, pinned, label?, workspaceId?, remotePort?}`.
- A forward's reservation is released only when the forward ends.
- At Host startup, reserved ports are rebound **before** any new allocation.
  Forwards whose session is still live after the Node reports its inventory
  are restored.

**Switch to this Node.** A pinned local port can be re-pointed at a different
target (another Node, session or remote port) without closing the listener.
Existing streams finish, and new connections go to the new target. The
browser tab and any product page that loads `localhost:4200` keep working.

**Conflicts with the operator's own tools.** While a forward holds 4200, a
local `ng serve` on the Host machine cannot bind 4200. The Settings page and
the forward's notification name the holder and offer **Stop forward**.

### Target policy (enforced by the Node on every stream)

1. **The target address must be literal loopback.** The Node tries `127.0.0.1`,
   then `::1`. Current Node.js and Angular dev servers often bind `localhost`
   to IPv6 only. Hostnames are never resolved.
2. **The deny list is always applied.** It covers:
   - the Node's actual config page port, plus 8788–8808;
   - 8786;
   - 8787, when a Host runs on the same machine;
   - any port owned by the Node process or its helpers.
3. **Ownership.** The owning PID must belong to the session. That means it is
   in one of:
   - the session's own Job Object;
   - the supervisor Job Object of a `fleet_run_command` execution whose
     `leadSessionId` is this session. The Node already holds that mapping in
     its command journal.

   Forwards to command-owned ports end when the command settles or reaches
   its deadline. An operator may create an unowned forward explicitly; an
   agent request never can.
4. **Limits.**
   - 8 forwards per session.
   - 32 concurrent streams per forward, and 64 per Node.
   - A 10-minute idle timeout per stream.

### Port detection

- **When scans run.** On demand: when a Ports view or the Settings page is
  open, when a forward or request is created, and when `fleet_list_ports` is
  called. While a view stays open, the rescan interval adapts to
  `max(20 × average scan time, 2 s)`. Nothing polls in the background.
- **On Windows:**
  1. List listening TCP sockets with their PIDs (`netstat -ano`, or
     `Get-NetTCPConnection`; choose by measurement).
  2. Get the PIDs of the session's job, and of the supervisor jobs of its
     active `fleet_run_command` executions, with a new `FleetJob.List(name)`
     call. It uses `QueryInformationJobObject(JobObjectBasicProcessIdList)`.
  3. Mark a port `owned` when its PID is in one of those jobs.
  4. Exclude Fleet's own processes and ports on the deny list.
- **Output hint.** A loopback URL in the session's tool output triggers one
  scan and a notification. The hint never makes a port owned.

### Credential separation

Browsers send cookies regardless of port. Non-`Secure` cookies are sent to both
`http` and `https`. The Fleet UI is served as `http://localhost:8787`, so
`fleet_operator` (the session token) is sent to anything served at
`localhost:<any port>`, including a forwarded dev server that an agent
controls. The token is not bound to the name it was issued for. A dev server
that logged it could therefore replay it against the Host through the tunnel.

Moving the Fleet UI to `127.0.0.1` is not possible. Microsoft authorization-code
sign-in completes only on `localhost`, and the Host already redirects
`127.0.0.1` to `localhost` for that reason. The protection works the other way
round:

1. **Default: serve forwards on `127.0.0.1`.** A forward's URL is
   `http(s)://127.0.0.1:<port>`. Host-only cookies set for `localhost` are
   never sent to `127.0.0.1`, so the dev server never sees Fleet cookies. Most
   dev servers accept this. Angular needs `--allowed-hosts`, or the `Host`
   rewrite below, for plain HTTP.
2. **Exact-localhost mode (opt-in, per forward).** For apps whose origin must
   be exactly `localhost`, such as an extension app registered as
   `https://localhost:4200`:
   - The listener also binds `::1`.
   - **Plain HTTP**: the listener parses requests and WebSocket upgrades. It
     removes the `fleet_*` cookies and rewrites `Host` to
     `localhost:<remotePort>`.
   - **HTTPS**: the listener cannot see headers. The forward card and the
     approval card show a warning, and the Settings page recommends a
     separate browser profile for testing the app. Agents may request
     exact-localhost mode, but it always needs explicit human approval, even
     when an always-allow rule matches.
3. **Optional hardening (open question 2).** Bind sessions to the
   connection class they were issued on (Host loopback, tunnel name, Corp
   direct). A token issued on loopback is then rejected when replayed through
   a tunnel.
4. **HTTPS dev servers.** Bytes pass through unchanged, so the browser sees the
   worker's development certificate. The guide documents two options: trust
   that certificate on the Host machine, or use the same development
   certificate on both machines. Fleet never installs certificates.

### Agent requests and approval

![Agent forward requests: a request is refused unless the feature is enabled and the port belongs to the session. Exact-localhost requests always go to the human approval prompt; other requests are approved automatically only when an always-allow rule matches. An approved request allocates a Host port and becomes an active forward, and the lead is told the outcome either way.](../../port-forwarding-approval.png)

_Source: [`docs/port-forwarding-approval.html`](../../port-forwarding-approval.html)._

New lead MCP tools, offered only while the feature is enabled:

| Tool | Effect |
| --- | --- |
| `fleet_list_ports({sessionId})` | Read only. Returns detected ports (port, owned, process name) and the session's forwards with their local URLs. |
| `fleet_request_port_forward({sessionId, remotePort, localPort?, exact?, exactLocalhost?, reason})` | Creates a pending request, or an active forward when an always-allow rule matches. `exactLocalhost` always needs human approval. Returns `{requestId, state, localUrl?}`. When the decision settles, the lead is woken with the outcome and local URL, as for command completions. |
| `fleet_stop_port_forward({forwardId})` | Stops a forward that this lead's tasks own. Stopping is always safe. |

Agent requests are restricted:

- They are allowed only for sessions under the lead's own tasks.
- They are allowed only for **owned** ports, including ports owned by the
  lead's own `fleet_run_command` executions.
- The MCP principal cannot approve.
- Workers have no tools. A worker reports its port in its normal turn, and
  the lead requests the forward.

**Approval surfaces.** Requests appear in three places:

- the prompt dialog that shows command approvals (`CommandPermissionPrompts`);
- the command list dialog (`CommandExecutionsDialog`), as a **Port forward**
  item;
- **Settings → Port forwarding → Pending requests**.

`CommandApprovalActions` is generalized to an approval kind with labels
specific to that kind. Requests are stored in their own table,
`port_forward_requests`, not in `command_executions`.

Each request shows:

- the requesting orchestrator and its reason;
- the target Node, session and remote port, and whether the owner is the
  session job or a named `fleet_run_command` execution;
- the owning process (name, PID and command line);
- the proposed Host URL (`127.0.0.1` or exact `localhost`), flagged when it
  differs from the requested port;
- an HTTPS exact-localhost warning, when it applies;
- the expiry, 30 minutes like commands.

| Decision | Meaning |
| --- | --- |
| **Allow** (`allow_once`) | This forward, until it is stopped or its session ends. |
| **Allow for this session** (`allow_session`) | This forward, plus later requests from the same session for the same remote port (for example, after the dev server restarts). |
| **Always allow** (`allow_always`) | A rule for workspace + remote port (and pinned local port, if any). Future owned-port requests matching it are approved automatically, except exact-localhost requests. Removable in Settings. |
| **Deny** | No forward is created. |

Approvals require an authenticated administrator with CSRF protection.
Automatic approval through a rule is recorded in history.

### Settings → Port forwarding (Experimental)

The page is a new tab in `SettingsPanel` with an **Experimental** badge. It is
administrators only and built with Fluent UI v9 (`makeStyles`, keyboard
reachable, labelled controls).

| Section | Contents |
| --- | --- |
| **Enable** | A toggle, off by default. While off: no listeners, no MCP tools offered, routes refuse, and existing forwards end. A second toggle, **Allow orchestrators to request forwards**, defaults to on. |
| **Active forwards** | One row per forward: target Node and session, `remotePort`, Host URL, mode (`127.0.0.1` or exact `localhost`), state (active, waiting for Node, conflict), open streams, bytes in and out, and who approved it. Actions: **Open**, **Copy URL**, **Switch to this Node** (for pinned ports), **Stop**. |
| **Pending requests** | The same cards as the approval dialog. |
| **Rules** | Always-allow rules, with created-by, last used, and **Remove**. |
| **Ports** | Pinned reservations (local port, label, workspace and remote port), excluded ports, and the fallback range. Each held port shows who holds it. |
| **New forward** | Pick Node, session and port from the detected list, or enter a port manually (unowned forwards need confirmation). Set the local port, exact mode and exact-localhost mode. |
| **History** | Recent created, ended, refused and conflict events. |
| **Credential check** | Shows which forwards use exact-localhost mode, and whether they are HTTPS (cookies cannot be stripped). |

Each session's view also gets a compact **Ports** panel with the same detected
list and forward actions for that session.

### Data model

- `port_forwards`: `{id, sessionId, targetNodeId, remotePort, remoteAddress,
  localPort, exact, exactLocalhost, mode(http|raw), ownerKind(session|command),
  commandExecutionId?, state, requestId?, approvedBy?, decision?, createdAt,
  endedAt?, endedReason?, bytesUp, bytesDown}`.
- `port_forward_requests`: `{id, leadSessionId, runId, sessionId, remotePort,
  localPort?, exact, exactLocalhost, reason, processInfo, state, expiresAt,
  decidedBy?, decision?}`.
- `port_forward_rules`: `{id, workspaceId, remotePort, localPort?, createdBy,
  createdAt, lastUsedAt?}`.
- `port_reservations`, as described above.

### Lifecycle

**A forward ends when any of these happens:**

- someone clicks **Stop**;
- the session stops or is cleaned up;
- for a command-owned port, the `fleet_run_command` execution settles or
  reaches its deadline;
- the task completes, is archived or is deleted;
- the feature is disabled;
- the Host identity is reset.

Removing a rule does not end forwards that are already active.

**Node disconnect.** The listener stays bound. New connections wait up to
10 seconds for the Node, then are reset. The forward shows "waiting for Node".

**Host restart.** Reserved ports are rebound first. Forwards are restored once
the target Node reports the session as live; otherwise they end with
`session_gone`.

**Audit events:**

- `port_forward_requested`, `_approved`, `_denied`, `_created`, `_ended`;
- `port_stream_refused`, with its code;
- `port_reservation_conflict`.

### Security model

| Threat | Mitigation |
| --- | --- |
| Forwarded page uses the operator's Fleet session | Forwards default to `127.0.0.1`, which never receives `localhost` cookies. Exact-localhost mode strips Fleet cookies on plain HTTP; on HTTPS it shows a warning and always needs human approval. Never served from the Host origin. |
| Agent exposes ports itself | Agents only request. A human approves, or a human-created rule matches. Owned ports only. |
| Stolen stream ticket | Single use, valid 30 s, bound to Node and stream, stored hashed, and requires the Node's signed proof. |
| Relay or tunnel reads or alters traffic | Each stream has its own AES-GCM key, delivered over the sealed control channel. |
| Forwarding Node control surfaces | Node-side deny list, checked on every stream. |
| Reaching other hosts from the worker | Literal loopback targets only. |
| Port squatting or conflicts | Reservations, a test bind, exact-mode conflicts that name the holder. |
| Legacy shared-secret Node | Refused, with the same message file downloads use. |

**This is trusted access, not a sandbox.** The operator chose to talk to
software an agent wrote. The design keeps that software away from Fleet
credentials and Node control surfaces.

## Phasing

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **1** | Experimental toggle. Protocol and capability. Node target policy, Windows detection (session and command jobs) and the stream dialer. Host `/ws/port-stream`, listener, splice, reservations, exact mode and exact-localhost mode. Operator-created forwards from Settings and the session Ports panel. | The `ng serve` app on a worker is reachable on the Host at `127.0.0.1:4200`, and at `https://localhost:4200` in exact-localhost mode. Two Nodes forwarding 4200 resolve to 4200 and 4201, or to a named conflict in exact mode. |
| **2** | Lead MCP tools, `port_forward_requests`, integration with the approval dialog and command list, rules, lead wake on decision. | An orchestrator request appears in the normal approval places. Approving wakes the lead with the URL. A matching rule approves automatically, except exact-localhost requests. |
| **3** | **Switch to this Node**, optional pre-warmed stream pool, optional session binding to connection class. | Switching a pinned port to another worker keeps the browser tab working. |

## Later

- A preview served on a dedicated origin, such as Dev Tunnels per-port URLs.
- A connector for operators browsing from a machine other than the Host.
- Per-workspace port attributes: label, protocol, and notification behaviour.

## Testing

- **Protocol**: frame schemas, ticket binding, stream sealing (replay, gap and
  tamper refusal).
- **Node**: the deny list, the `127.0.0.1` then `::1` fallback, ownership
  through fake session and command job PID lists, limits, half-close and
  reset, refusal before dialing.
- **Host**:
  - allocation (preferred, scan, fallback range, exclusions, test bind);
  - exact-mode conflicts that name the holder;
  - rebinding reservations on restart;
  - ending forwards on session stop, command settlement and disable;
  - ticket expiry and reuse;
  - refusal of upgrades that carry an `Origin` header;
  - `127.0.0.1` forwards never receive `localhost` cookies (browser test);
  - exact-localhost HTTP cookie stripping, and `::1` binding.
- **Approval**: the MCP principal cannot approve; owned-only for agents; rule
  matching; lead wake; the item appears in both approval dialogs.
- **UI**: settings sections, Switch to this Node, conflict messaging, and
  accessibility (labels and keyboard paths).
- **Integration**: real Host and Node processes. An HTTP and WebSocket
  (HMR-style) echo server inside a fake session job. Two Nodes on the same
  remote port. A 50 MB transfer checked by SHA-256.
- **Benchmarks**:
  - time to first byte for a new stream through a Dev Tunnel, with and without
    a pool;
  - session event p95 latency while a forward is saturated.
- **Manual**:
  - Angular `ng serve` over HTTPS with an exported development certificate;
  - Corp direct and Dev Tunnels Hosts.

## Open questions

1. **Should `allow_always` rules be allowed to pin exact local ports?** Pinning
   is convenient, but it can fail repeatedly with conflicts.
2. **Bind operator sessions to the connection class they were issued on?**
   This would stop a session cookie leaked through an exact-localhost HTTPS
   forward from being replayed through a tunnel. It changes general Host
   authentication, so it may belong in a separate design.
3. **`netstat` versus `Get-NetTCPConnection`**: choose by measuring scan
   latency on a busy machine.

Resolved on 2026-10-26:

- Listener location: **always the Host**.
- `fleet_run_command` ports: **owned by the requesting session**, ending with
  the command.
- `localhost` → `127.0.0.1` redirect for the Fleet UI: **dropped**, because it
  breaks Microsoft sign-in. Forwards use `127.0.0.1` by default instead.
