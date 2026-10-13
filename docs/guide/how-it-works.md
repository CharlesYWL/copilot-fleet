# How it works

[← README](../../README.md) · [Guide index](README.md)

The Host/Node split, the message flow, and the session state machine. For the full design, see [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Architecture and message flow

![Copilot Fleet architecture: a browser drives the Fleet Host, which owns SQLite state and sends commands over a Node-initiated WebSocket; each Node buffers events in an outbox, runs one Copilot ACP process per session, and is restarted by a supervisor after it updates itself.](../architecture.png)

The vertical split is the whole design: the Host owns desired state and history,
the Node owns execution. Copilot credentials, child processes, and local paths
never cross it, and the Node is the side that dials out.

1. The Node generates its own key pair, pins the Host fingerprint, and enrols
   with a one-time grant; the Host stores only its public key.
2. The Node authenticates its outbound WebSocket by signing the whole
   handshake, and both ends derive per-direction AEAD keys for it. Heartbeats
   report active session inventory.
3. The browser creates a session from a stored placement. The Host never accepts
   a path in the session-create request.
4. The Host dispatches a deduplicated command. The Node validates and resolves
   the placement directory, enforces capacity, and starts one isolated ACP
   connection.
5. The official `@agentclientprotocol/sdk` performs `initialize`,
   `session/new`, prompt/update streaming, follow-up prompts, and
   `session/cancel`. Stop closes ACP and terminates the child.
6. Node events carry a UUID plus a per-session monotonic sequence. SQLite ignores
   duplicates and records sequence gaps rather than rejecting everything after
   an outage; normalized sessions/events are broadcast to browsers and rebuild
   the transcript after refresh.
7. ACP permission requests become persisted events. Browser allow-once/deny
   decisions round-trip to the waiting ACP request. Timeout or Node/Host
   disconnect denies pending requests. Cancel also denies pending requests before
   `session/cancel`.
8. A transient Host WebSocket disconnect leaves local agent processes running.
   The Node buffers their events and re-announces active and busy sessions when it
   reconnects. The Host keeps them `offline` meanwhile and settles only sessions
   missing from the returning inventory as failed-but-resumable. An explicit Node
   shutdown still stops its local agents.

### The states a session moves through

![The session state machine: queued, starting, running and idle form the live loop; cancel drops a turn and returns to idle with the process intact; stop is terminal; a Host restart parks everything in offline, from which a session either comes back or settles as failed-but-resumable.](../session-lifecycle.png)

Two distinctions carry the model. **Cancel** ends the turn and keeps the process,
so the session lands back on `idle` ready for a follow-up; **stop** ends the
process and is terminal. And `failed` is not one thing: a session that reached
the agent keeps its agent session id and is offered as **resumable**, while one
that never got that far is simply over.
