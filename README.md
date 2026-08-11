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

Connected nodes are told when the Host's public URL changes, so a rotated tunnel
does not strand them — see
[Following the Host to a new URL](#following-the-host-to-a-new-url).

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

The node name defaults to the machine hostname, and can be changed from either
end — the Host's Nodes tab or the node's own config page. Renaming keeps the
machine's identity, so its placements and sessions come with it; the Host owns
the name, so if both ends changed while the node was offline, the Host's name
wins and is pushed back down. Pass `--max-sessions 8` if you want a capacity
other than 4.

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

Note that `--url` takes effect by restarting the node, which ends the sessions
running on it — they settle as "Node reconnected without this session", and
anything that reached the agent can be picked up again with **Resume**. To
follow a rotated tunnel URL without losing live sessions, retarget from the node
config page instead: it reconnects in place.

`--name` is not a display detail: the Host keys a node by name, so starting under
a different one enrolls a _new_ machine and leaves the old node's placements and
sessions behind. Starting again under the previous name reclaims the same node
id and brings them back.

### Recovering sessions after a restart

Sessions survive both processes going down. The Host keeps them in its SQLite
file and the node keeps its identity in `node.json`, so after both come back:

1. The Host marks everything it had running `offline` ("Host restarted").
2. The reconnecting node reports which sessions it still has. A restarted node
   has none, so the rest settle as "Node reconnected without this session".
3. **Resume** re-attaches through Copilot's `session/load`, and the transcript
   continues where it stopped rather than starting over.

A session in that state is shown as **resumable** rather than failed, stays in
the sidebar, and is skipped by **Clear ended** — that button only removes
sessions with nothing left to re-attach to. Use **Dismiss** on a session to drop
a resumable one deliberately.

Three things have to hold for that to work: the Host's `DATABASE_PATH` file is
intact, the node starts under the same name, and Copilot on that machine still
has the agent session on disk. A session that died before its agent ever started
has nothing to re-attach to — it settles as "it never reached the agent" and
offers no Resume.

A node keeps its agents running while the Host is away and buffers the events
they produce, so a Host restart mid-turn no longer costs that part of the
transcript. If the outage outlasts the buffer the Host records the gap and keeps
going; it never refuses the events that follow, because a session that cannot
report its own state again is a session nobody can use.

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

### Following the Host to a new URL

When the Host's public address changes — a tunnel comes up, rotates, or is
switched to another provider — it tells the nodes that are still connected. Each
one records the new address, keeps the old one as a fallback, and **does not drop
the connection it already has**: the running sessions on it are unaffected, and
the new address is what the next reconnect dials.

This closes the gap where a rotated tunnel URL left every node dialing an
address that had stopped existing, with no way back except editing
`settings.json` on each machine.

What it does and does not cover:

- A node reached over an address that outlives the change — a LAN address, a
  named tunnel — is told and follows along.
- A node reached _through_ the tunnel that just rotated cannot be told: that
  socket died with the tunnel. It keeps retrying its known addresses, so it
  recovers on its own if one of them still answers.
- Loopback is never announced. When no tunnel is up and no `FLEET_PUBLIC_URL` is
  set, the Host's idea of its own address is `http://127.0.0.1:8787`, which on
  another machine points at that machine. Nodes are left on the address they
  have instead.
- A node running an older agent is skipped rather than sent a message it would
  reject, so a mixed fleet keeps working.

If an announced address turns out to be unreachable from a particular machine,
that node dials it, fails, and rotates to the previous address on the next
attempt — so an announcement can never strand a machine. Whichever address
answers becomes the one it leads with. The node config page lists the fallbacks
under the Host URL field.

## Keeping nodes up to date

The Nodes tab compares each machine's commit with the Host's and marks it **Up
to date**, **Update available**, or **Manual update**. **Update** on a row — or
**Update all** above the table — tells those machines to `git pull --ff-only`,
`npm install`, `npm run build:node`, and restart into the new build. Progress
appears in the row as it happens.

The commit is compared, not the package version: `0.1.0` never moves between
deploys, so comparing it would report every machine as current no matter how far
behind it was.

What it will not do:

- **Update a machine that is running sessions.** A restart takes every agent on
  that node with it, so a busy node is refused with a reason rather than
  silently costing someone their turn. Stop its sessions and click again.
- **Move a checkout that has diverged.** `--ff-only` means a machine with local
  commits, or a dirty tree in the way, stops and reports it instead of inventing
  a merge nobody asked for.
- **Restart into a build that does not compile.** `npm run build:node` runs
  before anything is torn down; if it fails the node stays up on the code it
  already had and reports the error.
- **Update a node whose agent predates this feature.** It has no `update_node`
  in its copy of the message union and would close the connection on receiving
  one, so it is marked _Manual update_ and skipped. Update those machines by
  hand once — with the three commands under Windows Node — and every update
  after that can be done from the Host.

A node reports `""` for its commit when its directory is not a git checkout — a
tarball deploy, say. Those show as **Unknown** rather than being guessed at, and
are left out of **Update all**.

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
3. Start two sessions from **Dashboard**. Give one a name in the dialog; the
   other is listed by its prompt until you rename it from the session header.
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
