# Port forwarding from worker Nodes (experimental)

Date: 2026-10-22, revised 2026-10-27. Status: **draft for review**. Nothing here
is implemented.

Revision 2 records Charles's decisions of 2026-10-26:

1. Use one new connection per forwarded stream (VS Code's model). Do not
   multiplex streams over the Node control channel.
2. Fleet opens the local listener itself. No connector command is run by hand.
   Revision 3 restricts the listener to the Host.
3. Local ports are reserved, and concurrent forwards must never conflict.
4. Orchestrators can request a forward. The request appears in the normal
   command approval places.
5. Add a new **Settings → Port forwarding (Experimental)** page to manage
   forwards, requests, rules and reserved ports.

Revision 3 (2026-10-26) records three more decisions:

- The local listener always runs on the Host. Nodes are never bind sides.
- Ports opened by a `fleet_run_command` execution count as owned by the
  orchestrator session that requested it.
- The Fleet UI stays on `localhost`. The current Microsoft sign-in flow uses
  that name: the registered redirect is `http://localhost:<port>` (see
  `codeLoginEndpoint` in `apps/host/src/routes/auth.ts`). Forwards advertise
  `127.0.0.1` by default, but that URL alone does not isolate credentials.

Revision 4 (2026-10-27) incorporates the design review:

- **Protected HTTP is the default.** Validate the browser's requested authority
  and filter Fleet cookies in both directions. Binding to `127.0.0.1` does not
  prevent a browser from using the same listener as `localhost`.
- **Raw TCP/HTTPS remains available as explicitly unsafe access**, as approved
  by Charles on 2026-10-27. Every new raw forward requires explicit human risk
  acceptance; reusable rules never authorize it. Credential isolation is a
  guarantee of protected HTTP only.
- Backpressure covers both directions and all application queues. Ownership
  applies to the actual endpoint and connected process, not a port number.
- Command-owned forwards use an execution ID, including when the command and
  its requesting session run on different Nodes.
- Deny actual Fleet control ports, revalidate approvals, revoke tickets and
  data connections on teardown, and make target switches require reconnection.

## Summary

Make a port that a session's process listens on, on a worker Node, available on
the operator's machine without any inbound port on the worker.

Motivating case: a worker VM builds the extension app and serves it on
`https://localhost:4200`. With forwarding, the Host listens on its own port
4200, and the operator tests from the Host machine's browser. This HTTPS case
uses raw passthrough and therefore requires the explicit unsafe-mode approval
in [Credential separation](#credential-separation). Ordinary HTTP development
servers use protected HTTP instead.

![Port forwarding transport: a browser on the Host machine connects to a Host loopback listener. For each connection the Host sends a sealed open-stream frame over the existing Node channel; the worker's Fleet Node connects to the permitted dev server endpoint, then dials a new outbound connection to the Host's stream endpoint.](../../port-forwarding-architecture.png)

_Source: [`docs/port-forwarding-architecture.html`](../../port-forwarding-architecture.html).
This illustrates the transport; the HTTP filtering, authorization and teardown
requirements below also apply._

## Goals

1. Fleet opens and owns the local listener, always on the Host. The operator
   never runs a connector command.
2. Each forwarded TCP connection gets its own Node→Host connection, carrying
   sealed bytes with bounded, bidirectional backpressure. Forwarded payloads
   never queue on the session control channel; shared CPU and network load are
   measured rather than promising zero effect on session-event latency.
3. Local ports are reserved and allocated without conflicts. An exact port can
   be pinned for apps that need a specific origin (`https://localhost:4200`).
4. Orchestrators can list owned endpoints and request a forward. A person
   approves, or a narrowly scoped protected-HTTP rule matches. Agents never
   approve.
5. A new experimental Settings page manages forwards, pending requests,
   always-allow rules and reserved ports. It is off by default.
6. **Protected HTTP** prevents forwarded servers from receiving Fleet cookies
   or setting protected Fleet cookies through forwarded responses. **Raw
   TCP/HTTPS provides no Fleet credential-isolation guarantee.** That exception
   is visible in requests, approvals, active forwards and audit history.
7. Forwards are tied to an owning session and, where applicable, a specific
   command execution. Their grants and streams end with that ownership.

## Non-goals (this design)

- Reverse forwarding (the worker reaching a port on the operator's machine).
- Listening anywhere other than the Host. Nodes are never bind sides; a remote
  operator uses the Host's own browser or a later connector (see [Later](#later)).
- UDP, or any target other than the worker's own loopback address.
- Forwarding to processes outside the authorized owner when an **agent**
  requests it. Only an operator can create an unowned forward.
- Terminating TLS, installing development certificates, or isolating arbitrary
  raw traffic from browser credentials.
- A browser preview served on a dedicated origin (see [Later](#later)).
- macOS and Linux ownership detection. Those Nodes forward manually entered
  ports as unowned forwards, still subject to the control-endpoint deny list.

## How Fleet works today (relevant facts)

| Fact | Where |
| --- | --- |
| Nodes only dial out. The Host cannot open a connection to a Node. | `docs/guide/how-it-works.md` |
| Host↔Node frames are AES-256-GCM sealed and strictly sequenced on one WebSocket. | `packages/protocol/src/node-auth.ts`, `apps/host/src/gateway/node-channel.ts` (`SealedNodeLink`) |
| New frame types are gated by a capability the Node advertises. | `packages/protocol/src/session-files.ts` (`SESSION_FILES_CAPABILITY`) |
| Nodes can authenticate HTTP requests to the Host with a signed node proof. | `apps/host/src/request-guard.ts` (`verifyNodeHttpProof`, `NODE_ID_HEADER`) |
| Each managed agent runs in a named Windows Job Object. Everything the agent spawns stays in that job. | `apps/node/src/windows-process-job.ts` |
| Command approvals have Allow once, Allow during session, Always allow on this Node, and Deny. Decisions check the request version and revalidate the lead and target. | `packages/protocol/src/command-execution.ts`, `apps/host/src/command-execution-service.ts` (`decide`) |
| Lead tools are served over a bearer-scoped MCP endpoint. Workers get no tools. | `apps/host/src/orchestrator/tools.ts`, `docs/guide/orchestration.md` |
| Experimental features ship off by default, behind a settings toggle. | `docs/superpowers/specs/2026-10-12-experimental-worker-model-routing.md` |
| The operator cookie `fleet_operator` is host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`, and has no `Secure` flag on loopback HTTP. | `apps/host/src/auth.ts` |
| The current Microsoft authorization-code flow completes on `localhost`; requests using another loopback name are directed to its localhost equivalent. | `apps/host/src/routes/auth.ts` (`codeLoginEndpoint`), `docs/guide/sign-in-and-access.md` |
| `fleet_run_command` executions have their own supervisor Job Object, `nodeId`, `leadSessionId` and deadline. Their Node can differ from the lead's Node; a task is optional. Permanent dev servers are not supported there. | `apps/host/src/command-execution-service.ts`, `apps/node/src/command-supervisor-native.ts`, `packages/protocol/src/command-execution.ts` |
| Sessions and command executions have separate Node inventories. | `apps/node/src/router.ts`, `apps/node/src/command-execution-manager.ts` |
| Task transfer changes its lead while retaining workers. | `apps/host/src/orchestrator/lifecycle.ts` |
| Default Fleet ports are 8786 (local-agent API), 8787 (Host), and 8788–8808 (Node configuration). The Host and local-agent API ports are configurable. | `apps/host/src/server.ts`, `packages/protocol/src/local-agent.ts`, `docs/guide/nodes.md` |
| The local-agent API publishes its actual bound port in a marker; existing tunnel protection checks that marker. | `apps/host/src/local-agent-marker.ts` (`localAgentTunnelConflict`) |

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

Fleet adopts the per-stream connection model, port-selection rules,
process-based ownership, exclusion of Fleet processes, and adaptive scanning.
URLs printed in output are hints, not ownership evidence.

Fleet adds approval, protected HTTP filtering and an explicit raw-mode warning.
Each stream is sealed with its own keys because Fleet treats tunnel relays as
untrusted. A reusable rule can approve only eligible protected-HTTP requests.

## Design

### Concepts

- **Owner**: the session whose lifetime permits a forward. For a command-owned
  port this is the command's requesting `leadSessionId`, not a worker session
  inferred from the machine where the command runs.
- **Target**: either `{kind: "session", sessionId}` or
  `{kind: "command", commandExecutionId}`. The Host derives the Node,
  workspace, optional task (`runId`), and owner from its own records. A command
  target also binds the current execution attempt; it never silently follows
  a replacement attempt.
- **Unowned target**: an administrator-only `{kind: "unowned", nodeId,
  sessionId}`. The named session must be live on that Node and supplies the
  lifetime, but its Job Object need not own the port. This variant is excluded
  from agent tool schemas and reusable rules.
- **Endpoint**: the literal loopback address, address family and `remotePort`.
  Current PID, process start time and job membership are checked separately;
  a PID or numeric port alone is insufficient authority.
- **Protocol**: `http` (protected HTTP, default), `https` (unsafe raw TLS
  passthrough), or `tcp` (unsafe arbitrary TCP). This is an explicit choice,
  not inferred from a URL hint or automatically downgraded after a parse error.
- **Forward**: one approved mapping, `Host localPort → target endpoint`.
- **Generation**: a monotonically increasing forward version. A stream and its
  ticket belong to one immutable generation and target; switching revokes the
  previous generation.
- **Reservation**: a Host port allocated to a forward, or pinned for a label.
  It survives restarts. An inactive pin is a logical Fleet reservation, not a
  promise that another program cannot bind that port.

### Data path: one connection per stream

![Opening a forwarded stream: the Host pauses the accepted connection, issues a ticket and stream secret for the current authorized target generation, and asks the Node to connect. The Node verifies the actual endpoint and process before opening the data connection. The Host checks the ticket and current authorization before forwarding bytes.](../../port-forwarding-stream.png)

_Source: [`docs/port-forwarding-stream.html`](../../port-forwarding-stream.html).
The generation, queue and revocation rules below are normative._

- **Control frames** use the existing sealed channel and capability
  `port-forward-v1`: `port_stream_open`, `port_stream_refused`, `port_scan` and
  `port_scan_result`. A refusal names `forbidden`, `refused`, `not_owned`,
  `limit`, `session_gone`, `execution_gone` or `revoked`.
- **Admission first.** The Host counts the connection against limits before
  allocating a ticket or waiter. Protected HTTP validates each request before
  forwarding its headers or body. The Node checks policy, connects to the
  permitted endpoint, and verifies the connected process before releasing any
  application bytes. Failure closes the target socket and reports a refusal.
- **Stream connection.** The Node dials `GET /ws/port-stream` through the same
  base URL as its control connection, with the existing signed node HTTP proof
  and a one-time ticket. Upgrades carrying an `Origin` header are refused.
  The route requires a currently enrolled, mutually authenticated Node;
  legacy shared-secret Nodes cannot use it.
- **Ticket binding.** Tickets are stored hashed, expire after 30 seconds, and
  bind `nodeId`, the control connection identity, `forwardId`, `generation`,
  `streamId` and the canonical target. Redemption atomically checks and consumes
  an unexpired ticket for a still-authorized generation. Stop, switch,
  disconnect or revocation invalidates it even if its expiry is in the future.
  An invalid or duplicate redemption must never attach to another stream.
- **Framing and keys.** Binary WebSocket messages carry at most 64 KiB of
  plaintext payload, plus bounded framing and authentication overhead. A fresh
  per-stream secret travels only over the sealed control channel. Derive
  directional AES-256-GCM keys with stream/forward/generation context, and use
  `direction || sequence` nonces. Authenticate the frame kind and binding;
  data, `eof` and `reset` share the direction's strict sequence. Replay, gaps,
  tampering and oversized messages terminate the stream. Disable WebSocket
  compression and bound receive-message allocation before decryption.
- **Half-close and errors.** An `eof` ends only that TCP write direction after
  preceding bytes drain. The other direction remains usable until its own EOF.
  A reset, failed authentication or timeout destroys both sockets and releases
  the ticket, queue and stream accounting. TCP sockets must support half-close;
  a WebSocket close is not used as a substitute for one directional EOF.

**Backpressure is required in both directions at both ends:**

1. TCP → WebSocket: pause the source when sending/framing queues reach their
   high-water mark. Resume on actual downstream capacity, using stream or send
   completion signals rather than an unbounded polling/write loop.
2. WebSocket → TCP: when the destination's `write()` returns `false`, pause
   incoming WebSocket reads until the TCP writer emits `drain`. Do not keep
   decrypting and enqueueing messages behind a blocked destination.
3. Count plaintext, ciphertext, transform and destination-write queues. Use
   a 1 MiB high-water mark, resume at or below 512 KiB, and enforce a 2 MiB hard
   application-queue limit per direction per stream. Also cap total queued
   application bytes at 64 MiB per process across forwards. Pause before these
   limits; reset an offending stream rather than growing past them. OS socket
   buffers are separately bounded by the platform and are not this accounting.

`WebSocket.bufferedAmount` measures outgoing WebSocket data only. It cannot
establish that a separate TCP destination's write queue is bounded. Prefer
existing stream primitives and bounded transforms, preserving the framing and
half-close contract above.

A new connection costs a control message, target validation/connect, and a
Node→Host WebSocket handshake. Measure first-byte latency through the supported
tunnels; do not assume browsers always use six connections or that new streams
never affect session latency. A small pre-warmed pool is optional later, with
fresh, generation-bound tickets and the same resource limits.

### Local listener and port reservation

The Host binds `127.0.0.1`. Exact-localhost mode also binds `::1` on the same
port. Bind addresses are not hostname restrictions: protected HTTP separately
validates the requested authority. Raw modes remain unsafe under either name.

**Any remote port can map to any free Host port.** For example, worker `:4200`
can be exposed on Host `:4200`, `:4201` or `:9000`. Matching numbers is a
default, not a requirement. Validate port ranges before allocation.

**Allocation order:**

1. Use a matching pinned reservation for the workspace and remote port.
2. Otherwise try the requested `localPort`, if supplied.
3. Otherwise try the remote port number.
4. If that preferred candidate is unavailable, scan upward by at most 100
   ports without exceeding 65535, then try the range `20000–20999`.

An exact request or pinned reservation never falls back. Exclusions cover
8786–8808, all actual Fleet control-listener ports on the Host, browser-restricted
ports, ports below 1024, and operator-configured exclusions. A rule cannot
remove an exclusion or take another forward's reservation.

**Allocation is atomic.** Serialize candidate allocation and enforce a unique
Host `localPort` reservation. The successful real bind becomes the listener:
never close a test socket and then attempt a second bind. Exact-localhost
allocation acquires both address families or closes the partial allocation and
reports a conflict. Commit the reservation and forward only after binding
succeeds; undo acquired sockets/reservations on failure.

A conflict names another Fleet holder, or an external PID/process when the
Host's own socket scan can identify it. Otherwise report the bind error or
system reservation without inventing a PID. Worker socket scans cannot identify
programs holding ports on the Host.

Reservations live in `port_reservations`:
`{localPort, forwardId?, pinned, label?, workspaceId?, remotePort?}`. Ending a
forward releases its listener and unpinned reservation. A pin keeps its logical
reservation but clears `forwardId`; another local program can use the port while
no forward is active. At startup, establish the Host's own control endpoints,
then rebind reservations for restorable forwards before admitting new forward
allocations. An external conflict remains a conflict; do not silently move an
existing forward to another port.

**Switch to this Node.** Keep the pinned listener and URL, but validate and
approve the proposed new target under the same creation policy. Commit the
switch with a generation check, revoke all old tickets/waiters, and reset all
old-generation streams, including HTTP keep-alive and hot-reload WebSockets.
Then admit connections to the new target. If validation or approval fails,
leave the old target unchanged.

The UI warns that switching interrupts connections and that the browser must
reload. TLS passthrough and TCP forwarding cannot migrate established HTTP/2 or
WebSocket connections, and keeping old connections would mix responses from
different Nodes. Raw or exact-localhost switches require fresh explicit human
approval. Old streams retain their original owner references until teardown
finishes; changing the forward row must not detach them from cleanup. A target
switch cannot change protocol, hostname mode or local-port policy; those changes
require stopping the old forward and obtaining approval for a new one.

While a forward holds port 4200, a local `ng serve` cannot bind it. The Settings
page and notification name the holder and offer **Stop forward**.

### Target policy (enforced by the Node on every stream)

1. **Literal loopback only.** An endpoint is `127.0.0.1` or `::1`, never a
   hostname or an arbitrary destination. When `remoteAddress` is omitted at
   creation, select an authorized endpoint from the fresh scan, preferring
   IPv4 and then IPv6. Check each candidate independently. Persist the resolved
   address/family with the approval; another address requires a new generation.
   An owned `[::1]:4200` never authorizes `127.0.0.1:4200`.
2. **Always deny Fleet control surfaces**, even for administrator-created
   unowned forwards. Include the actual Node configuration port and 8788–8808,
   the default and actual local-agent API port, the actual colocated Host port,
   and endpoints owned by Fleet Node, Host or helper processes. Use trusted
   local configuration/runtime advertisements and process identities, including
   the existing local-agent port marker, rather than only 8786/8787. Colocated
   Host listeners must advertise their actual endpoints where the Node cannot
   otherwise discover them. If a candidate cannot be classified safely, refuse
   it. Configuration changes revalidate affected active forwards.
3. **Ownership matches the exact target.** A session target requires membership
   in that session's current Job Object. A command target requires membership
   in that execution attempt's supervisor Job Object and a live, unexpired
   command journal record. The Host verifies that the command belongs to the
   requesting lead; its owner may be on a different Node. A worker session
   cannot substitute for the command's requesting `leadSessionId`.
4. **Validate the connected process.** Scans retain address family, listening
   address, port, PID and process start time, including wildcard/dual-stack
   listener semantics. Recheck current job membership and bind it to the actual
   connected peer socket before forwarding bytes. Cached PID lists or a second
   lookup of only the listening port do not prove which process accepted the
   connection. If the OS cannot provide unambiguous ownership evidence, refuse
   an owned forward rather than silently treating it as unowned.
5. **Explicit unowned exception.** Only an administrator can create it, with
   the Node, lifetime session and literal endpoint shown in the confirmation.
   The deny list and connection/resource checks still apply. Agents cannot
   request it, and reusable rules cannot grant it.
6. **Limits**, enforced on both Host and Node:
   - 8 forwards per owning session, including its command-owned forwards.
   - 32 streams per forward and 64 per Node, including opening connections,
     offline waiters and streams still being torn down.
   - The queue limits above, a 30-second connection-setup deadline, and a
     10-minute application-data idle timeout per established stream.

For command-owned ports, settlement, expiry or retirement of that execution
attempt ends the forward. A dev server restarted within the same authorized
session job can be accepted after fresh ownership checks; approval of a port
does not permanently approve a cached PID.

### Port detection

- **When scans run.** On demand: when a Ports view or Settings page is open,
  when a request/forward is created, and when `fleet_list_ports` is called.
  While a view stays open, rescan at `max(20 × average scan time, 2 s)`.
  No view means no discovery polling. Per-stream security checks still run.
- **On Windows:**
  1. List TCP listening endpoints with address family, address and owning PID
     (`netstat -ano` or `Get-NetTCPConnection`; choose by measurement).
  2. Obtain current process identities and the authorized session/command job
     PIDs with a new `FleetJob.List(name)` call using
     `QueryInformationJobObject(JobObjectBasicProcessIdList)`.
  3. Mark each endpoint, not each port number, as owned or unowned. Normalize
     wildcard/dual-stack entries without transferring ownership across distinct
     listeners. Preserve enough evidence to validate the connected socket.
  4. Exclude Fleet processes and actual control endpoints.
- **Output hints.** A loopback URL in session or command output triggers one
  scan and a notification. It never grants ownership or selects unsafe mode.
- **Results.** Include target identity, Node, address family, loopback address,
  port and process information. Agent results contain only endpoints of the
  authorized target. An administrator may inspect unowned candidates separately.

### Credential separation

Browsers scope cookies by hostname, not port. Fleet's host-only,
`HttpOnly`, `SameSite=Strict` cookie on `localhost` can therefore be sent to a
forward at another localhost port. A non-`Secure` cookie can also be sent over
HTTPS. `HttpOnly` prevents script reads, not receipt by the forwarded server.
A token received there can be replayed against Fleet; the current token is not
bound to the name or connection class where it was issued.

Binding a listener to `127.0.0.1` does **not** prevent a browser from reaching
that same socket as `localhost`. Advertising an IP URL is useful, but is not a
security boundary. Revision 4 retains the current localhost sign-in flow rather
than redesigning general Host authentication.

**Protected HTTP (`protocol: "http"`, default):**

1. Terminate and parse plain HTTP at the Host listener using the existing HTTP
   stack. Before forwarding headers or body bytes, accept only
   `127.0.0.1:<localPort>` in default mode, or `localhost:<localPort>` in
   exact-localhost mode. Reject missing, duplicate, malformed or unexpected
   authorities, including mismatched absolute-form request targets. Revalidate
   every keep-alive request and WebSocket upgrade, not just the first request.
2. Remove all reserved `fleet_*` request cookies before forwarding. Apply this
   to both allowed names, even if the numeric-IP case normally has no Fleet
   cookie. Only after validation, rewrite `Host` to `localhost:<remotePort>`
   for dev servers that need it. Preserve normal application cookies.
3. Filter every response `Set-Cookie` that targets a reserved Fleet cookie,
   including duplicate headers, redirects and WebSocket upgrade responses.
   Remove `Clear-Site-Data`, which could otherwise clear Fleet cookies across
   ports. Request-only filtering does not protect response cookie integrity.
4. Support ordinary HTTP and explicitly validated WebSocket upgrades. Refuse
   CONNECT, unsupported upgrades, TLS bytes and malformed HTTP; never fall
   back to an unfiltered raw splice. Stream request/response bodies with the
   same bounded backpressure policy as the underlying transport.
5. Keep Fleet's own complete-origin checks and CSRF protections intact. Cookie
   filtering is not permission to relax the Host API's browser-origin rules.
   Sharing localhost is not a sandbox or isolation of all browser storage.

**Raw HTTPS/TCP (`protocol: "https"` or `"tcp"`, unsafe):**

- Pass application bytes through unchanged. HTTPS is TLS passthrough, not TLS
  termination. Fleet cannot validate its HTTP Host header or filter cookies.
  Arbitrary TCP can also carry HTTP, regardless of the advertised URL scheme.
- Show this warning on creation, approval and the active forward:
  **“Unsafe raw forwarding: this server may receive or change Fleet's
  localhost cookies. This also applies when the suggested URL uses 127.0.0.1.”**
- Every new raw forward requires an authenticated administrator's explicit
  **Allow once** and `acceptCredentialRisk: true`. The operator creation form
  requires the same separate acknowledgement. Agents cannot supply that
  acknowledgement or approve. Session grants and always-allow rules never
  authorize a raw request, whether or not `exactLocalhost` is set.
- Exact-localhost requests also always need explicit human approval, including
  protected HTTP. The flag selects the advertised name and IPv6 bind; it is
  not how the system determines whether the protocol is safe.
- Recommend a separate browser profile that never signs in to Fleet. This is
  operator guidance, not an enforced credential-isolation guarantee. A restored
  forward may retain its recorded approval only for the same target, protocol
  and local-port policy after the lifecycle checks below; a new request or
  target switch cannot reuse that acknowledgement.

**HTTPS certificates.** The browser sees the worker's certificate. Trust on
the Host and hostname validity are separate requirements: the certificate must
include the actual URL host in its subject alternative names, including an IP
SAN for `127.0.0.1` when using that URL. Trusting or copying a localhost-only
certificate does not fix an IP-name mismatch. Fleet never installs certificates
or disables certificate validation.

Binding Fleet sessions to connection class remains optional defense in depth,
not a substitute for protected HTTP or raw-mode consent. Such a future design
must establish trustworthy connection provenance, not trust a caller-supplied
Host or forwarding header.

### Agent requests and approval

New lead MCP tools are offered only while the feature is enabled. `target`
accepts the session and command variants above, never the unowned variant.

| Tool | Effect |
| --- | --- |
| `fleet_list_ports({target})` | Read only. Returns authorized endpoint records with their Node, address family/address, port, process and current forwards. A command is inspected by execution ID, not by guessing a session on its Node. |
| `fleet_request_port_forward({target, remotePort, remoteAddress?, localPort?, exact?, exactLocalhost?, protocol?, reason, requestKey})` | Validates and creates a pending request, or an active protected-HTTP forward when a reusable grant matches. `protocol` defaults to `http`. Returns `{requestId, state, forwardId?, localUrl?}` and wakes the authorized lead when the decision settles. |
| `fleet_stop_port_forward({forwardId})` | Stops only a forward currently within the lead's authorized ownership scope. The historical requester ID is not sufficient authority after task transfer. |

`remoteAddress`, when supplied, must be `127.0.0.1` or `::1`. Otherwise resolve
it using fresh endpoint-specific ownership evidence before approval. A stable
`requestKey` is idempotent within the requesting lead: retrying the same payload
returns the same request/outcome; reusing it for different input is a conflict.

Agent scope is checked from current Host records:

- A session target must belong to a task currently owned by the lead.
- A command target must name a live execution requested by that lead. Its
  target Node comes from the execution record, not from the lead session.
  Standalone commands without a task are valid; task-associated commands also
  require the task's current ownership.
- Only owned endpoints qualify. Workers have no tools; they report ports to
  their lead. The MCP principal cannot approve or accept credential risk.

For example, a lead on Node A can request `target: {kind: "command",
commandExecutionId: ...}` for its server on B. A second command on C using the
same port is a different target. Neither requires inventing a worker session
on B or C, and neither is restored from A's session appearing in B's inventory.

**Approval flow:** validate feature/scope and fresh target evidence; resolve
protocol, endpoint and port policy; send raw or exact-localhost requests to a
human; otherwise check an eligible reusable grant; finally revalidate and
allocate. A permission decision never overrides a port conflict or deny rule.

Requests appear in `CommandPermissionPrompts`, `CommandExecutionsDialog` as
**Port forward** items, and **Settings → Port forwarding → Pending requests**.
Generalize `CommandApprovalActions` with kind-specific labels, but store these
requests in `port_forward_requests`, not `command_executions`.

Each request shows the requesting lead and reason; target Node and owner;
command execution/attempt where applicable; remote endpoint and process
identity; proposed Host URL and allocation policy; protected or unsafe protocol;
explicit raw warning when applicable; and its 30-minute expiry. A proposed
nonexact local port can change during allocation, and the final outcome reports
its actual URL. An exact or pinned port cannot change.

| Decision | Meaning |
| --- | --- |
| **Allow once** (`allow_once`) | This forward until its lifecycle ends. Raw access additionally requires explicit credential-risk acceptance. |
| **Allow for this session** (`allow_session`) | Protected HTTP without exact-localhost only. Also permits future requests with the same requesting lead, owning session, Node, workspace, task association, target kind, remote endpoint and local-port policy. New commands still need fresh ownership checks. |
| **Always allow** (`allow_always`) | Protected HTTP without exact-localhost only. Creates a workspace + remote endpoint + local-port-policy rule for future owned targets. A rule can constrain a local port but does not create, steal or bypass a pin. |
| **Deny** | No forward is created. |

**Approval-time revalidation is mandatory.** Obtain fresh Node ownership
evidence, then atomically check the pending request's version/digest, expiry,
requester liveness, current task/command ownership, target identity, feature
policy and any matching grant. The human decision payload is
`{decision, expectedVersion, digest, acceptCredentialRisk?}` and must identify
that exact request version and digest. Refuse stale cards or changed authority
rather than approving what the original request once permitted. Allocate under the
reservation lock; release resources if a concurrent cancellation wins. Streams
and ticket redemption recheck authorization again.

Approval requires an authenticated administrator and CSRF protection. Record
human decisions, credential-risk acceptance and automatic grant matches in
history. Raw and exact-localhost cards offer no reusable-approval actions.
Pending requests become invalid on requester Stop/cleanup, ownership transfer,
owner/task termination, target revocation or feature disablement. A former
lead must not receive a new forward URL after losing authority.

### Settings → Port forwarding (Experimental)

Add an administrators-only tab in `SettingsPanel`, with an **Experimental**
badge and Fluent UI v9 controls (`makeStyles`, keyboard reachable and labelled).

| Section | Contents |
| --- | --- |
| **Enable** | Off by default. While off: no listeners, tools are not offered, routes refuse, pending requests are cancelled, and all tickets/streams are revoked. **Allow orchestrators to request forwards** defaults to on; turning it off cancels pending agent requests and blocks new ones. |
| **Active forwards** | Target/owner, command ID where applicable, remote address and port, Host URL, protocol and hostname mode, state, stream/byte counts and approver. Unsafe raw forwards remain visibly warned. Actions: **Open** (HTTP/HTTPS), **Copy URL**, **Switch to this Node** (pinned), **Stop**. |
| **Pending requests** | The same versioned approval cards as the command dialogs, including explicit raw risk acceptance. |
| **Rules** | Protected-HTTP rules and session grants, their scope, creator, last use, and **Remove**. No raw or exact-localhost grants. |
| **Ports** | Pins, exclusions and fallback range. Show actual Fleet control-port exclusions, logical inactive pins, active holders and conflicts. |
| **New forward** | Pick a session or command target and an endpoint, or explicitly select an unowned target. Choose local-port policy, hostname mode and protocol. Default to protected HTTP; raw and unowned choices require separate confirmations. |
| **History** | Requested, approved, cancelled, created, switched, ended, refused and conflict events. |
| **Credential check** | List every raw forward as unsafe, even when its URL uses 127.0.0.1. Explain protected-HTTP filtering separately from the exact-localhost hostname choice. |

Each session view gets a compact **Ports** panel. Command-owned entries identify
their execution and actual Node, even when viewed under a lead on another Node.

### Data model

Canonical target fields are derived and validated by the Host, never accepted
as authoritative Node/workspace/owner claims from an agent.

- `port_forwards`: `{id, target, ownerKind(session|command|unowned),
  ownerSessionId, targetNodeId, workspaceId, runId?, commandExecutionId?,
  commandAttemptId?, remoteAddress, addressFamily, remotePort, localPort,
  protocol(http|https|tcp), exact, exactLocalhost, generation, state,
  requestId?, approvedBy, decision, credentialRiskAcceptedAt?, createdAt,
  endedAt?, endedReason?, bytesUp, bytesDown}`.
- `port_forward_requests`: `{id, leadSessionId, requestKey, version, digest,
  target, ownerSessionId, targetNodeId, workspaceId, runId?, remoteAddress,
  addressFamily, remotePort, localPort?, exact, exactLocalhost, protocol,
  reason, processInfo, state, expiresAt, decidedBy?, decision?,
  credentialRiskAcceptedAt?, forwardId?}`. Enforce uniqueness of
  `(leadSessionId, requestKey)`. Process info is a snapshot, not authority.
- `port_forward_rules`: `{id, workspaceId, remoteAddress, addressFamily,
  remotePort, localPort?, exact, protocol: http, exactLocalhost: false,
  createdBy, createdAt, lastUsedAt?}`.
- `port_forward_session_grants`: `{id, leadSessionId, ownerSessionId,
  targetNodeId, workspaceId, runId?, ownerKind(session|command), remoteAddress,
  addressFamily, remotePort, localPort?, exact, protocol: http,
  exactLocalhost: false, createdBy, createdAt, lastUsedAt?}`.
- `port_reservations`, as described above, uniquely keyed by Host local port.

Keep a bounded in-memory registry of pending/active streams keyed by
`streamId`, with immutable forward generation, target/owner, command attempt,
control connection, ticket expiry, sockets, timers and byte accounting. Stream
keys and tickets are not persisted or logged. A Host restart invalidates every
old ticket and stream; restoring a forward creates a fresh generation.

### Lifecycle

**A forward ends when:**

- an authorized person or lead clicks/calls **Stop**;
- its owning session stops or is cleaned up;
- its command execution settles, expires or retires the approved attempt;
- its associated task completes, is archived or is deleted;
- the target Node is deleted, unenrolled or evicted for a security reason;
- its endpoint becomes a forbidden Fleet control surface;
- the feature is disabled or the Host identity is reset.

**Ending means revocation, not just closing the listener.** First invalidate
the forward generation and its ability to redeem tickets. Cancel connection
waiters and pending opens, close both sides of every associated stream, release
keys/timers/queue counters, and release the listener and reservation association.
A delayed handshake after Stop must fail even inside its original 30-second
window. Node deletion/revocation must integrate this cleanup with
`FleetService.evictNode` and other bulk-eviction paths; closing the control
socket alone does not close independent data sockets.

**Task transfer.** Cancel affected pending requests and session grants. Existing
human-approved forwards may remain for the same live target, but list/stop
permissions follow the task's current owner. Historical requester IDs are audit
metadata, not continuing authority. New or switched forwards require the normal
current-scope checks and, for raw/exact-localhost, new human approval.

**Grant removal.** Removing a rule/grant prevents future automatic approvals;
it does not end an already active forward. Session grants expire with their
requesting or owning session, or when their task ownership changes. Revalidate
stored grants after restart rather than treating persistence as authorization.

**Node disconnect.** Keep the listener/reservation, revoke tickets and reset
existing streams tied to the lost sealed control connection. Show **waiting
for Node**. New connections occupy bounded admission slots and wait at most
10 seconds before reset. Reconnection requires fresh inventory/authorization
before creating streams; old tickets cannot attach to the new control link.

**Host restart.** After establishing actual control-port exclusions, rebind
restorable listeners before new allocation and wait for owner reconciliation:

- Session-owned and unowned forwards require the lifetime session to be live
  in the target Node's session inventory.
- Command-owned forwards require that exact execution attempt to be reconciled
  as live and unexpired in the executing Node's **command inventory**, plus a
  valid requesting session and any current task scope in the Host's records.
  The lead need not appear in that target Node's session inventory.
- Recheck endpoint policy, feature state, unchanged approval scope and recorded
  raw-risk consent. Uncertain/orphaned ownership cannot activate forwarding.
- A missing inventory is **waiting for Node**, not proof of `session_gone`.
  An authoritative absent/stopped owner or settled command ends the forward.
  Existing TCP streams are never resumed after a restart.

**Audit events:** `port_forward_requested`, `_approved`, `_denied`,
`_cancelled`, `_created`, `_switched`, `_ended`; `port_stream_refused` with its
code; and `port_reservation_conflict`. Record protocol, resolved endpoint,
owner/command, generation, approver or grant, and explicit raw-risk acceptance.
Never record ticket values, encryption keys, cookies or forwarded payloads.

### Security model

| Threat | Mitigation or explicit limitation |
| --- | --- |
| Forwarded HTTP server receives or changes Fleet cookies | Protected HTTP validates authority on every request/upgrade, strips reserved request cookies and response Set-Cookie, and removes Clear-Site-Data. Fleet API origin/CSRF checks remain intact. |
| Raw TCP/HTTPS server receives or changes Fleet cookies | Accepted risk, not a prevented threat. Per-forward human acknowledgement is mandatory under either hostname. Reusable grants cannot authorize raw forwarding. |
| Agent exposes an unowned endpoint | Agent target schemas exclude unowned access; Host scope and Node endpoint/process ownership are checked again at approval and on connection. |
| IPv4/IPv6 ownership confusion or port/PID reuse | Authorize the exact endpoint and validate the connected process with current job membership before forwarding bytes. |
| Stolen or delayed stream ticket | Short-lived single-use proof bound to Node/control connection, forward generation, stream and target; revocation wins over remaining TTL. |
| Relay reads or alters traffic | Directional per-stream AES-GCM keys delivered over the mutually authenticated sealed control channel. |
| Forwarding Fleet control surfaces | Dynamic Node-side deny list including actual configured Host/local-agent ports and Fleet processes; no unowned override. |
| Direct forwarding to other hosts | Literal loopback only. This does not sandbox a target application's own outbound/proxy behavior. |
| Slow reader exhausts memory | Bidirectional backpressure, bounded framing and TCP write queues, aggregate byte caps, and admission limits including pending connections. |
| Port conflicts or allocation races | Serialized unique reservations and retained real binds, with atomic dual-family acquisition and explicit conflict state. |
| Legacy shared-secret Node | Refused, with the same upgrade guidance used for file downloads. |

**This is trusted access, not a sandbox.** Protected HTTP limits Fleet cookie
exposure on the forwarding path. Raw TCP/HTTPS deliberately does not provide
that protection. Neither mode restricts what the target application can do
with its existing operating-system permissions or its own network access.

## Phasing

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **1** | Experimental toggle; protocol/capability; Windows endpoint and connected-process checks; command target identity; dynamic control-port exclusions; sealed per-stream transport with queue limits and revocation; retained-bind reservations; protected HTTP filtering; explicit unsafe raw consent; operator Settings/session Ports controls. | HTTP on a worker is reachable without leaking or overwriting Fleet cookies, including attempts through localhost aliases. HTTPS at localhost works only after explicit raw-risk acceptance. Stalled readers stay bounded; Stop invalidates pending tickets. Two Nodes resolve port conflicts correctly. |
| **2** | Lead tools; versioned/idempotent requests; command and standalone-lead scope; approval-time revalidation; reusable protected-HTTP grants; decision notifications and restart reconciliation. | Requests appear in all approval places. Cross-node command targets are unambiguous. Stale approvals after transfer/Stop fail. Rules never approve raw or exact-localhost requests. A live command forward restores from command inventory. |
| **3** | Pinned-target switching with explicit reconnect/reload behavior. Optional pre-warmed connections only after measurement. | Switching keeps the URL but closes old connections; reloaded HTTP/WebSocket clients use only the new target. Tickets from the old generation fail. |

## Later

- A preview served on a genuinely isolated origin, such as a suitable Dev
  Tunnels per-port URL, with its own reviewed authentication policy.
- General Fleet session binding to trustworthy connection provenance.
- A connector for operators browsing from a machine other than the Host.
- Per-workspace labels, protocol preferences and notification behavior. A
  preference must never bypass raw-mode approval.

## Testing

- **Protocol:** frame schemas and limits; ticket Node/control-link/target/
  generation binding; one-time redemption; expiry; replay, gap and tamper
  refusal; half-close and reset ordering; no nonce/key reuse after reconnect.
- **Node:** dynamic control ports and Fleet PIDs; refusal even for unowned
  requests; owned IPv6 plus unrelated IPv4 on the same port; wildcard and
  dual-stack endpoints; PID reuse and listener replacement between scan and
  connect; refusal before any application bytes reach the wrong process.
- **Host allocation:** preferred/scan/fallback selection; exclusions; retained
  binds; concurrent requests; partial IPv6 bind failure and rollback; exact
  conflicts; inactive pins; startup conflicts and rebind ordering.
- **Protected HTTP browser tests:** numeric-IP access; same-site navigation
  from Fleet to a localhost alias; redirects and subsequent requests; duplicate
  Host/absolute-form authorities; repeated keep-alive requests; request-cookie
  stripping; response-cookie overwrite/deletion through ordinary, redirect and
  upgrade responses; Clear-Site-Data removal; refusal of CONNECT, TLS and raw
  fallback. Use synthetic credentials in isolated test browser contexts.
- **Raw approval:** both numeric-IP and exact-localhost variants require human
  risk acceptance; neither session nor always rules bypass it; MCP cannot set
  acceptance; restoration applies only to the same approved target/protocol.
- **Lifecycle:** Stop, disablement, session/command termination and Node deletion
  during setup and transfer; delayed valid-ticket handshake after Stop; old
  generation after switch; cleanup of all data sockets and queued bytes;
  missing inventory versus authoritative owner absence; fresh keys on restart.
- **Command topology:** lead on A, commands on B and C listening on the same
  port; standalone lead without a task; exact execution-attempt matching;
  command deadline; Host restart with separate session/command inventories.
- **Approval:** administrator/CSRF requirements; agent owned-only scope;
  version/digest conflict; idempotent request retry; task transfer or requester
  Stop before approval; removed grant during approval; authorized outcome wake;
  session-grant expiry; current-owner list/stop permissions after transfer.
- **Transport integration:** real Host and Node, HTTP and WebSocket echo
  servers in a session job, two Nodes using one remote port, and a 50 MB
  transfer verified by SHA-256. Add slow and completely stalled readers in
  both directions, assert queue ceilings, and verify cancellation while paused.
- **Switching:** persistent HTTP connections, hot-reload WebSockets and raw TLS
  connections are closed on switch; new connections use only the new target;
  failed new-target approval leaves the previous target intact.
- **UI:** protocol/hostname distinction, persistent unsafe warning, explicit
  consent, command targets, all approval surfaces, conflict messaging,
  reconnect/reload messaging, labelled controls and keyboard accessibility.
- **Benchmarks:** new-stream first-byte latency through Dev Tunnels, scan and
  connected-owner verification costs, peak queued bytes/process memory under
  stalled readers, and session-event p95 latency during saturated forwards.
- **Manual:** Angular HTTPS with a correctly named/trusted development
  certificate; an IP-name mismatch despite certificate trust; Corp direct and
  Dev Tunnels Hosts; exact-localhost IPv4/IPv6 behavior.

## Open questions

1. **Connection-class binding for Fleet sessions:** a separate authentication
   design must define reliable provenance and compatibility across local,
   tunnel and Corp endpoints. It is not a prerequisite for the explicitly
   unsafe raw mode and must not be presented as complete browser isolation.
2. **`netstat` versus `Get-NetTCPConnection`:** choose by measuring scan latency
   and the ability to verify the connected process on supported Windows Nodes.

Resolved:

- The listener always runs on the Host.
- Command-owned ports belong to the requesting session, but are addressed and
  reconciled by execution ID and executing Node.
- The current Fleet UI/sign-in remains on localhost; protected HTTP forwards
  validate hostname and filter both directions instead of relying on an IP URL.
- Raw TCP/HTTPS remains an explicitly unsafe, human-approved exception, as
  accepted on 2026-10-27. Credential-isolation claims exclude it.
- Rules may constrain local-port selection but do not create or override pins.
- Switching a pinned target preserves the URL, not established connections.
