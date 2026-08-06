# Copilot Fleet

Copilot Fleet is a self-hosted control plane for supervising GitHub Copilot CLI
agents on multiple machines. The Host combines a Fastify API, WebSocket hub,
SQLite database, and React UI. Each Node makes one outbound connection and owns
an isolated ACP client and Copilot process per live session.

## Requirements

- Node.js 22.5 or newer and npm 10 or newer
- GitHub Copilot CLI installed and authenticated on each real Node
- An absolute local path for every workspace placement

## Mac/Linux Host

```bash
git clone <repository-url> copilot-fleet
cd copilot-fleet
npm install
cp .env.example .env
```

Set a strong random `ENROLLMENT_TOKEN` in `.env`, then start development mode:

```bash
npm run dev
```

This single command runs the Fastify API on `http://127.0.0.1:8787`, Vite on
`http://127.0.0.1:5173`, and the local Node service. The Node reads its
`FLEET_*` settings from `.env`.

For a production Host:

```bash
npm run build
NODE_ENV=production npm run start -w @fleet/host
```

Open `http://127.0.0.1:8787`. Fastify serves the built UI in production.

## Windows Node (PowerShell)

Install Node.js and authenticate Copilot CLI first. From a checked-out Fleet
directory:

```powershell
npm install
$env:FLEET_HOST_URL = "https://fleet.example.com"
$env:FLEET_ENROLLMENT_TOKEN = "replace-with-host-token"
$env:FLEET_NODE_NAME = "windows-workstation"
$env:FLEET_MAX_SESSIONS = "4"
npm run build -w @fleet/protocol
npm run build -w @fleet/node
npm run start -w @fleet/node
```

First registration exchanges the enrollment token for a unique node secret.
Credentials are persisted at
`$env:APPDATA\CopilotFleet\node.json`; subsequent starts do not need the
enrollment token. The service uses an outbound WSS connection, so no inbound
Node port is required.

## Exact proof of concept

Run the Host in terminal 1:

```bash
cp .env.example .env
npm install
npm run build -w @fleet/protocol
npm run dev -w @fleet/host
```

Run a deterministic no-login Node in terminal 2:

```bash
FLEET_HOST_URL=http://127.0.0.1:8787 \
FLEET_ENROLLMENT_TOKEN=change-me \
FLEET_NODE_NAME=mock-node \
FLEET_MAX_SESSIONS=2 \
FLEET_MOCK_AGENT=1 \
npm run dev -w @fleet/node
```

Then open `http://127.0.0.1:5173`:

1. Create a workspace under **Workspaces**.
2. Add a placement for `mock-node` using an existing absolute directory.
3. Start two sessions from **Dashboard**.
4. Open either card to observe independent streamed events, send a follow-up,
   cancel a turn, or stop the process.

The automated equivalent is:

```bash
npm test
```

`apps/node/src/router.test.ts` starts two mock sessions concurrently and proves
that each receives its own ordered event stream without Copilot authentication.

## Architecture and message flow

```text
Browser -- REST + WebSocket --> Fastify Host -- authenticated WebSocket --> Node
                                      |                               |
                                   SQLite                    ACP NDJSON/stdio
                                                                      |
                                                        copilot --acp --stdio
```

1. The Node registers once with the enrollment token and receives a node ID and
   secret.
2. The Node authenticates its outbound WebSocket. Heartbeats report active
   session inventory.
3. The browser creates a session from a stored placement. The Host never accepts
   a path in the session-create request.
4. The Host dispatches a deduplicated command. The Node validates and resolves
   the placement directory, enforces capacity, and starts one isolated ACP
   connection.
5. The official `@agentclientprotocol/sdk` performs `initialize`,
   `session/new`, prompt/update streaming, follow-up prompts, and
   `session/cancel`. Stop closes ACP and terminates the child.
6. Node events carry a UUID plus a per-session monotonic sequence. SQLite
   rejects gaps and duplicates; normalized sessions/events are broadcast to
   browsers and rebuild the transcript after refresh.
7. ACP permission requests become persisted events. Browser allow-once/deny
   decisions round-trip to the waiting ACP request. Timeout or Node/Host
   disconnect denies pending requests. Cancel also denies pending requests before
   `session/cancel`.
8. A WebSocket disconnect intentionally stops every local agent process. Host
   marks non-terminal sessions failed; there is no process resume in the MVP.
   After a Host restart, temporary `offline` rows are reconciled to failed when
   the Node reconnects with no matching active process.

## Security notes

- Production startup refuses a missing or default `change-me` enrollment token.
- A successful enrollment creates a unique high-entropy node secret; only its
  SHA-256 hash is stored by the Host.
- Copilot authentication and tokens remain on the Node and are never included
  in Fleet messages.
- Session requests reference preconfigured placement IDs. Nodes also require an
  existing absolute directory and resolve it before process creation.
- Copilot is spawned directly with argument arrays, `shell: false`, and the
  selected placement as `cwd`.
- Permissions are explicit and auditable. Allow-always is intentionally absent;
  unanswered and disconnected requests fail closed.
- The MVP has no user authentication. Put an internet-exposed Host behind an
  authenticated reverse proxy or access policy (for example Cloudflare Access)
  and use HTTPS/WSS.

## Commands

```bash
npm run dev
npm test
npm run typecheck
npm run build
```

Startup is seed-free. SQLite creates its schema and empty data file on first
launch.
