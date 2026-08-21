# Copilot Fleet — MVP Product Contract

## Goal

A self-hosted browser control plane for running and supervising multiple GitHub Copilot CLI agents across multiple Windows-first worker nodes.

## Topology

- **Host Web App**: one deployable service containing REST API, WebSocket endpoints, SQLite persistence, and a React web UI.
- **Node App**: a cross-platform Node.js CLI/service, first-class on Windows. Each node registers to a Host URL and maintains one outbound WebSocket connection. No inbound port is required on the node.
- **Agent process**: each live session owns one `copilot --acp --stdio` child process on its assigned node.

## Domain model

- **Node**: a registered machine. Has name, OS/arch, version, capabilities, max concurrent sessions, last heartbeat, and online/offline state.
- **Workspace**: a logical project/repository shown in the UI.
- **Workspace placement**: `(workspace, node) -> localPath`. Paths belong to nodes, not workspaces, because the same project may live at different Windows paths on different machines.
- **Session**: one agent run assigned to exactly one workspace placement and one node. A node may run many sessions up to its configured capacity.
- **Event**: ordered, persisted session output/state/tool/permission events used to rebuild the transcript after refresh.

## MVP user flows

1. Start Host, sign in with the operator password, and open the browser dashboard.
2. Start Node with Host URL + enrollment token + node name. Node registers and appears online.
3. Create a Workspace, then add one or more node placements with local paths.
4. Start a Copilot session by selecting Workspace, eligible Node/placement, and initial prompt.
5. Dashboard shows all live sessions side-by-side as compact cards with node, workspace, state, latest activity, and elapsed time.
6. Open a session detail drawer/page to see streamed ACP events and transcript.
7. Send follow-up prompts to an idle live session.
8. Cancel the active ACP prompt, or stop the entire agent process.
9. Handle ACP permission requests from the browser with allow-once or deny. Default is deny on timeout, cancel, or disconnect.
10. Node heartbeat/disconnect updates status without deleting session history.

## Session state model

`queued -> starting -> running -> idle -> running ...`

Terminal states: `stopped | completed | failed`.

Transient states: `cancelling | offline`.

- `cancel` means ACP `session/cancel` for the active prompt; the process remains alive and returns to `idle`.
- `stop` terminates the Copilot child process and makes the session terminal.
- If the Node/Host WebSocket disconnects, the Node fail-closes permissions and
  stops all local agent processes. Host marks their non-terminal sessions
  `failed`; MVP does not migrate, resume, or auto-restart them. `offline` is only
  a temporary Host-restart reconciliation state until Node inventory arrives.

## Transport boundaries

- Browser <-> Host: REST for CRUD/commands, WebSocket for live state/events.
- Node <-> Host: one authenticated outbound WebSocket for heartbeats, inventory, commands, events, and permission round-trips.
- Node <-> Copilot: ACP NDJSON over stdio using `@agentclientprotocol/sdk`.

Every command has `commandId`; every node event has `eventId`, `sessionId`, and monotonic `sequence`. Duplicate commands/events must be safe to ignore.

## Security baseline

- Operator password gates the web UI and `/api`. Set `FLEET_OPERATOR_PASSWORD`, or let the Host generate one on first boot and print it to its console. A tunnel only proves the Host is reachable.
- Host answers only to names it knows (loopback, `FLEET_PUBLIC_URL`, live tunnel URLs, `FLEET_ALLOWED_HOSTS`). Cross-origin requests and rebound DNS names are refused. `FLEET_ALLOWED_HOSTS=*` turns that check off.
- Host creates an enrollment token; successful registration returns a unique node ID and node secret.
- Node stores credentials in a user-local config file and uses them for reconnects. Those credentials reach only the catalog routes the node's config page relays, and a node can only create or repoint placements on itself.
- Workspace paths are never accepted from arbitrary session-create payloads; Host may only select a preconfigured placement.
- Node validates the resolved working directory and enforces concurrency.
- Copilot authentication stays on the node. Tokens are never uploaded to Host.
- Permission requests are explicit and auditable; deny by default. YOLO is off unless explicitly enabled.
- Cloudflare Tunnel may expose Host HTTP/WSS (the process on `PORT`, not the Vite dev server). Nodes only need outbound HTTPS/WSS.

## UI MVP

- Header: online nodes, running sessions, waiting permissions.
- Main live grid: horizontally/vertically responsive cards for all non-terminal sessions.
- Session card: status color, workspace, node, current activity, last text chunk, elapsed time, Open button, Cancel/Stop actions.
- Session detail: timeline/transcript, permission banner, prompt composer, Cancel active turn, Stop process.
- Nodes page: online/offline, capacity, active count, OS, version, last seen.
- Workspaces page: workspace metadata and per-node local path placements.

## Non-goals for MVP

- Automatic Git clone/worktree creation.
- Session migration between nodes.
- Multi-user RBAC/SSO.
- Kubernetes/Nomad scheduling.
- More agents than Copilot CLI.
- Billing, model usage accounting, mobile app, or agent-to-agent messaging.

## Acceptance test

On a Windows node with authenticated Copilot CLI, a user signs in with the operator password, registers the node, maps a workspace path, starts two Copilot ACP sessions on the same node, watches both stream in the live grid, opens either session, sends a follow-up, approves or denies a permission request, cancels the active turn without killing the session, and stops the process. Without that password, `/api/snapshot` and `/api/enrollment` refuse the caller. Host restart preserves nodes, workspaces, placements, sessions, and event history, and signs the operator out.
