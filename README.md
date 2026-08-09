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

To keep a tunnel URL stable while you edit code, start the tunnel as its own
process instead:

```bash
npm run dev:tunnel
```

The tunnel then survives `tsx watch` reloads, so the public URL stops rotating
every time the Host restarts and remote nodes stay connected. The Host detects
it and leaves its lifecycle alone; the Settings toggle is disabled while it
runs. Stop everything with Ctrl+C as usual.

Open the UI → **Settings**:

- **Tunnel** — toggle a Cloudflare quick tunnel (requires `cloudflared` on PATH).
- **Nodes** — rename/delete machines and copy the enroll command.
- **Workspaces** — map projects to per-machine paths.

For production (built Host + local Node together):

```bash
npm run build
npm start
```

Or just the Host: `npm run start:host`. Open `http://127.0.0.1:8787` —
Fastify serves the built UI.

## Windows Node (PowerShell)

Install Node.js and authenticate Copilot CLI first. From a checked-out Fleet
directory (or paste the command from the Host's Nodes → Connect card):

```powershell
npm install
npm run build:node
npm run start:node -- --url="https://fleet.example.com" --token="replace-with-host-token"
```

The same three lines work in bash — flags avoid the `$env:` / `VAR=value`
split between shells.

The node name defaults to the machine hostname; rename it later from the Host's
Nodes tab. Pass `--max-sessions 8` if you want a capacity other than 4.

First registration exchanges the enrollment token for a unique node secret.
Credentials are persisted at
`$env:APPDATA\CopilotFleet\node.json`; subsequent starts do not need the
enrollment token. The service uses an outbound WSS connection, so no inbound
Node port is required.

### Node command-line flags

Anything the node reads from the environment can be given as a flag instead, and
a flag wins over both `.env` and the saved `settings.json` — which is what makes
it usable to point one run at a different Host without editing files on that
machine. Run `npm run start:node -- --help` for the current list.

| Flag                              | Replaces                 |
| --------------------------------- | ------------------------ |
| `--url`, `--host-url`             | `FLEET_HOST_URL`         |
| `--name`, `--node-name`           | `FLEET_NODE_NAME`        |
| `--token`, `--enrollment-token`   | `FLEET_ENROLLMENT_TOKEN` |
| `--max-sessions`                  | `FLEET_MAX_SESSIONS`     |
| `--copilot-command`               | `FLEET_COPILOT_COMMAND`  |
| `--permission-timeout-ms`         | `PERMISSION_TIMEOUT_MS`  |
| `--config-port`                   | `FLEET_NODE_CONFIG_PORT` |
| `--mock-agent`, `--no-mock-agent` | `FLEET_MOCK_AGENT`       |

Both `--flag value` and `--flag=value` are accepted. The `--` after the npm
script name is npm's own separator; without it npm eats the flags. The same
flags work on `npm run node` (watch mode), `npm run dev` and `npm start`, where
they are forwarded to the node process only:

```bash
npm start -- --url=https://fleet.example.com
```

Flags apply to that run; edits made later in the config page win until the
process restarts.

### Node config page

Each node serves a small settings page at `http://127.0.0.1:8788` (override the
port with `FLEET_NODE_CONFIG_PORT`). Use it to retarget the node when a tunnel
hands out a new URL — the node reconnects in place, so no restart is needed and
running sessions survive.

It also edits the node name, session capacity, Copilot executable path, and
permission timeout. Values are stored in `settings.json` beside the credentials
and take precedence over the environment variables, so an edit here is not
undone by a stale `.env` on the next start. Command-line flags outrank both.

The listener binds to loopback only and is deliberately not exposed: anything
that can repoint a node at a different Host can run commands on that machine.
Reach a remote node's page over SSH port forwarding rather than binding wider.

## Exact proof of concept

Run the Host in terminal 1:

```bash
cp .env.example .env
npm install
npm run host
```

Run a deterministic no-login Node in terminal 2:

```bash
npm run node -- --url=http://127.0.0.1:8787 \
  --token=change-me \
  --name=mock-node \
  --max-sessions=2 \
  --mock-agent
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
- Permissions are explicit and auditable in the UI (allow-once / deny only).
  For unattended runs, set `FLEET_YOLO=1` on the Node so Copilot starts with
  `--allow-all` (tools, paths, and URLs). Unanswered and disconnected requests
  still fail closed when YOLO is off.
- The MVP has no user authentication. Put an internet-exposed Host behind an
  authenticated reverse proxy or access policy (for example Cloudflare Access)
  and use HTTPS/WSS.

## Commands

```bash
npm run dev
npm run dev:tunnel
npm test
npm run typecheck
npm run build
```

Startup is seed-free. SQLite creates its schema and empty data file on first
launch.
