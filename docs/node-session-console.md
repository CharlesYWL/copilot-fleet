# Node session console and offline worker chat

The Node session console lets someone visiting a worker VM open a
Host-dispatched conversation and continue it without returning to Host. Both
surfaces use the existing Host chat components and the same Fleet session; opening
a view does not start or resume a second Copilot process.

This describes the implemented feature, not a proposal. See the
[live-streaming and reconnect sequence diagrams](node-session-streaming.html)
for message ordering. GitHub displays the HTML source; open the downloaded file
or `docs\node-session-streaming.html` from a checkout in a browser. It is a
self-contained, static page with no build or server requirement.

## Using it

1. Update Host and Node and connect them using mutually authenticated enrollment.
   The sealed connection negotiates `session-console-v1`; legacy shared-secret
   enrollment does not enable this bridge. Already-running eligible workers
   receive a continuation grant on their first compatible reconnect.
2. On the worker VM, open the Node's local config page, normally
   `http://127.0.0.1:8788`. If the port is occupied, use the actual URL printed by
   the Node.
3. Open **Sessions**, select the Fleet conversation, and chat with its existing
   worker. Online actions go through Host's existing admission and queueing
   services. The Node is not a second scheduler.
4. During an ordinary Host connection outage, continue from that Node page.
   Eligible running workers can execute local prompts immediately or queue them
   behind their current turn. On reconnect, wait for synchronization before
   submitting new local work.

**Permission approvals are always Host-only**, even when Node is online.
Offline continuation requires a granted, already-running non-lead worker and
continued access to the model provider. Host-backed tools are unavailable during
the outage; lead mutations and session resume require Host.

| Connection state | Conversation and control behavior |
| --- | --- |
| Online | Host owns the shared projection and normal control path. Opened Node views receive scoped updates from Host. |
| Offline | Node shows its locally journaled history and controls the existing eligible worker. Host cannot show new local output until reconnect. |
| Synchronizing | Recovery batches and local-control receipts are reconciled before ordinary Host work is admitted; new local submissions pause. |
| Conflict / unavailable | Evidence is retained and affected control is blocked. Inspect the reported identity, binding or storage error instead of starting a duplicate worker. |

A Node restart preserves journal data, not the running process. Host must use
current process inventory and normal resume rules after synchronization. A lost
acknowledgment is not permission to invoke the prompt again.

## Ownership and lazy loading

- **Host** owns Fleet history, transcript projections, task settlement, scheduling
  and permission decisions.
- **Node** owns the worker's ACP process, local execution, durable session journal
  and loopback console.
- **The shared React UI** receives data through the appropriate Host or Node
  transport adapter. There is no separate transcript renderer to keep in sync.

Settings and Diagnostics do not eagerly discover all conversations. Opening
Sessions requests paginated metadata; only the selected conversation loads
transcript pages and a live subscription. **Local Copilot history** starts native
discovery only when expanded. A native conversation already owned by Fleet offers
**Open chat**, not another resume.

Journaling is independent of whether anyone opens the UI: it covers events for
granted non-lead sessions both online and offline. Historical data from before
journaling began remains available from Host on demand; this feature does not
eagerly create a complete offline replica of every Host transcript. Fleet session
IDs and native Copilot session IDs are distinct.

## Low-latency live delivery

The original implementation reused a serial recovery loop for healthy traffic:
save a batch, send it, wait for its acknowledgment, then send the next batch.
That made network round trips delay unrelated workers.

The healthy path now works as follows:

1. `NodeSessionConsole.capture()` appends events to `SessionJournal`. Producer
   bursts flush at a microtask boundary instead of waiting for the offline
   batching timer. Publication follows the durable commit.
2. `pumpLive()` pipelines committed batches without waiting for earlier Host
   acknowledgments. Per-session sent cursors preserve ordering.
3. Host validates the current grant and workspace binding without rewriting the
   grant for every batch. It serializes ingestion, not network round trips, and
   publishes through the existing transcript/UI path.
4. Cumulative acknowledgments arriving together share a journal transaction.
   Connection generations prevent old replies from advancing a new connection's
   state. A validation failure fences subsequent packets.

SQLite uses **WAL with `synchronous=FULL`**. This is not a save-later optimization
and does not weaken crash durability. The Host renderer and its existing browser
flush are unchanged.

The live window is bounded at **128 batches / 8 MiB**. Normal event selection
uses at most 512 events / 512 KiB; an individually oversized event can travel
alone, within protocol limits. When the window fills, additional event bodies
stay in SQLite instead of building an unbounded in-memory queue. These are
current implementation limits, not operator settings.

## Offline operations and reconnect ordering

Local actions have stable operation IDs, a grant identity, a control epoch and
the sequence boundary after which they apply. Node records admission before
invocation. Accepted operations without a proven completion become **uncertain**
after restart and are never automatically re-prompted.

On reconnect:

1. Exchange current process inventory and validate session grants.
2. Replay the recovery boundary in successive bounded batches, including
   local-control receipts before the events they govern. Do not send events past
   an omitted control receipt when either batch limit is reached.
3. Import events idempotently and acknowledge the committed boundary. The journal
   retains a sequence high-water mark even when acknowledged bodies are trimmed;
   a resumed worker starts above both Host's and Node's offsets.
4. Confirm the final synchronization boundary. Host sends that acknowledgment
   before releasing ordinary command reconnect, prompt pumps, retention,
   worktree mutations or auto-resume. Safety stop/cancel and Host permission
   resolution remain possible without deleting outstanding history.

If an inactive journal session no longer exists on Host, initialization identifies
it separately instead of blocking the entire Node. Its local events and control
receipts remain unacknowledged and retained; they are not replayed, discarded or
executed. That session is read-only with a scoped conflict diagnostic, while
known sessions finish synchronization and unrelated orchestrators can resume.
Missing live sessions, foreign ownership and changed grants still block
synchronization.

Replay imports evidence; it does not execute the recorded prompt. Original task
completion must be settled from its own events before a local follow-up starts a
separate attempt.

| Concurrent change or failure | Required behavior |
| --- | --- |
| Lost or reordered live ACK | Retain unacknowledged evidence; merge cumulative receipts and replay safely after reconnect. |
| Host stop or deletion during an outage | Preserve/import pending history; deletion requires synchronization and worker quiescence. Safety stop is not blocked as ordinary new work. |
| Host messages pending or being delivered when local control intervenes | Hold affected messages with a needs-confirmation diagnostic; do not silently resend them. |
| Local queued messages | Keep them Node-owned until dispatched or cancelled, with shared queue controls after reconnect. |
| Host identity, session grant or workspace binding changes | Treat as a conflict; keep local evidence and block unsafe continuation. |
| Journal write or capacity failure | Report the storage failure and close admission rather than dropping older unacknowledged output. |

## Authority, privacy and cleanup

Local access deliberately permits local programs to use chat. Origin and Fetch
Metadata checks harden browser requests; a shell-capable process can forge those
headers, so they are not proof of a human operator or an OS security boundary.
There is no local permission-approval endpoint or permission-policy expansion.
Console provenance is a typed `node_console` actor, not a fabricated `operatorId`.
Intervening in a retained maintenance worker does not grant publication approval
or human-only handback authority.

The journal lives in `session-history\sessions.db` under the Node configuration
directory, not a worktree. It uses the existing private-directory permissions.
Tool output and attachment payloads can contain sensitive data. The default
serialized-record budget is 256 MiB; it is not an exact cap on SQLite files,
indexes or WAL size, and unacknowledged history is not silently evicted to fit it.

Session retirement requires acknowledged events/control and no active local
operations. Trimming, retirement and purge checkpoint/truncate WAL history, but
do not promise forensic secure erasure. **Move this node** must first settle
history with the original Host; session history is excluded from identity
exports. Service uninstall preserves files. The explicit, Host-scoped purge
contract and its destructive-discard option are documented in the
[README](guide/nodes.md#shared-worker-chat-and-offline-continuation).

## Code map for contributors and agents

| Surface | Entry points |
| --- | --- |
| Protocol and capability | [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts): `ConsoleGrantSchema`, `ConsoleRequestSchema`, `ConsoleActionSchema`, `SESSION_CONSOLE_CAPABILITY`. |
| Node controller and local API | [`apps/node/src/session-console.ts`](../apps/node/src/session-console.ts): `capture`, `pumpLive`, `flushToHost`, `connected`, `hostCommand`, `route`. Local routes are scoped below `/api/fleet-sessions`. |
| Durable storage | [`apps/node/src/session-journal.ts`](../apps/node/src/session-journal.ts): `append`, `flush`, `acceptOperation`, `beginOperation`, `acknowledgeBatch`, `retire`, `purge`. |
| Node runtime / loopback boundary | [`main.ts`](../apps/node/src/main.ts) wires the journal and connection; [`config-server.ts`](../apps/node/src/config-server.ts) serves and guards the local API. |
| Host bridge and receipts | [`session-console-service.ts`](../apps/host/src/session-console-service.ts) handles scope, ingestion and admission; [`session-console-store.ts`](../apps/host/src/session-console-store.ts) persists grants and operation receipts. |
| Reconnect producers | [`gateway/node-socket.ts`](../apps/host/src/gateway/node-socket.ts), [`fleet-service.ts`](../apps/host/src/fleet-service.ts), [`command-execution-service.ts`](../apps/host/src/command-execution-service.ts) and [`session-messages.ts`](../apps/host/src/session-messages.ts). Keep the barrier at producers as well as dispatch. |
| Local shared-UI adapter | [`apps/node/ui/src/App.tsx`](../apps/node/ui/src/App.tsx), [`api.ts`](../apps/node/ui/src/api.ts) and [`session-connection.ts`](../apps/node/ui/src/session-connection.ts). Reuse Host components instead of forking the renderer. |
| Build / update contract | [`apps/node/package.json`](../apps/node/package.json), [`config-assets.ts`](../apps/node/src/config-assets.ts) and [`updater.ts`](../apps/node/src/updater.ts): include and validate the Node UI manifest/revision in update quarantine. |

When changing this feature, preserve durable-before-publish and
admission-before-invocation ordering, stable IDs/high-water marks, Host-only
approvals, bounded live buffering, lazy views, and the reconnect barrier. Do not
replace the live pipeline with the recovery loop or infer a live worker from
replayed idle events.

## Focused checks and performance reproduction

From a checkout with dependencies installed:

```powershell
npm run build -w @fleet/protocol
npx vitest run scripts\session-console.integration.test.ts apps\node\src\session-journal.test.ts apps\host\src\session-console-store.test.ts apps\host\src\gateway\node-socket.test.ts apps\node\src\main.test.ts --no-file-parallelism
npm run typecheck
npm run build:node
```

The integration suite covers online/offline control, local queues, reconnect
backlogs beyond 2,000 events, oversized events, restart recovery, upgrade grants,
permission isolation, count/byte backpressure, ACK failures, per-session
retirement and control receipts spanning more than one batch. Its opt-in browser
scenario uses the built Node UI and a mock model agent:

```powershell
$env:FLEET_CONSOLE_BROWSER_SMOKE = "1"
npx vitest run scripts\session-console.integration.test.ts -t "real browser" --no-file-parallelism
Remove-Item Env:FLEET_CONSOLE_BROWSER_SMOKE
```

The browser scenario defaults to installed Microsoft Edge; set
`FLEET_E2E_BROWSER` to a supported Chromium executable when needed.

```powershell
npm run benchmark:session-stream -- --rtt 50 --duration 4000 --max-regression-ms 15
npm run benchmark:session-stream -- --rtt 100 --duration 4000 --max-regression-ms 15
```

[`scripts/benchmarks/session-stream.ts`](../scripts/benchmarks/session-stream.ts)
compares direct and journaled forwarding in separate Host/Node processes using
real loopback WebSockets and SQLite. Defaults cover 1, 4 and 8 workers at 50
chunks/second each. `--sessions`, `--rtt`, `--duration` and `--output` select the
workload and optional JSON report. The regression budget compares journaled p95
with the direct baseline in the same run.

These timings measure normalized event creation to Host publication, not model
generation, encryption or browser painting. Durable writes have a small local
cost; results depend on disk and scheduling load. The benchmark does not contact
running Fleet installations or model services.
