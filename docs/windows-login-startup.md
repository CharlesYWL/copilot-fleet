# Windows login startup

**Accepted:** 2026-09-11. Start after the operator signs into Windows, using the
existing interactive account and credentials. This is not signed-out boot startup.

## Install

Use normal PowerShell in an updated Fleet checkout with Node.js, GitHub CLI, and
Copilot installed. Sign in to Copilot first; missing or expired GitHub CLI
credentials can be renewed inline. Private-tunnel Nodes also need
`devtunnel user login`. Stop existing manual instances before switching launch
modes; the installer never terminates them for you.

The Host's **Nodes > Connect a machine** card displays both commands with separate
Copy buttons: `npm run start:node` for a terminal, and `npm run service -- node`
for login startup. Both use the same one-use grant for one machine; run either,
not both. The service variant installs dependencies and lets the installer build.

```powershell
# New Node: use the real values from the Connect card.
npm run service -- node --devtunnel="<tunnel-id>" --host-id="<host-id>" --host-fingerprint="<sha256>" --enrollment-grant="<id.secret>"

# Already enrolled: choose Node-only or Host+Node.
npm run service -- node install --existing-node
npm run service -- host+node install --existing-node
```

Use `--url="<host-url>"` instead of `--devtunnel` for direct connectivity.
`node --url=...` and `node install --url=...` are equivalent. Standard Node
connection/settings flags, including `--name`, `--max-sessions`, and
`--copilot-command`, use the existing Node parser. Legacy `--token` enrollment
remains supported; generated commands use a one-time grant and Host fingerprint.

| Install option | Meaning |
| --- | --- |
| `--existing-node` | Reuse an identity; cannot be combined with new enrollment credentials. |
| `--no-build` | Use an existing production build. |
| `--no-start` | Enable future login startup without starting immediately. |
| `--start-mode login` | Explicitly select the only supported startup mode. |
| `--devtunnel <id>` | Node's private-tunnel connection. |
| `--config-port <port>` | Preferred Node configuration port (default 8788); tries higher ports if occupied. |

Installation builds, checks GitHub authentication in the current terminal,
probes authentication in a temporary same-user task,
prepares/enrolls the Node, registers startup, and starts it. Initial enrollment
requires a reachable Host. Host+Node uses two independent tasks: if Node setup
fails, an installed Host is preserved, not rolled back. `host:service` and
`node:service` are aliases; `service -- host` manages only the Host.

The **Node config page starts at port 8788**, separate from the Host API's port
8787. On a collision it tries 8789, 8790, and so on, bound only to `127.0.0.1`.
Enrollment and new task starts/restarts print the actual address after the
listener is ready, for example:

```text
Config UI port 8788 is occupied; trying 8789.
Node config UI: http://127.0.0.1:8789
```

The URL is also in `runtime.log`. Startup waits up to 60 seconds for that
announcement; a missing URL or listener error is reported explicitly and does
not uninstall the task. Permission errors are not treated as port collisions,
and at most 20 consecutive ports are tried, without exceeding port 65535. If
that range is occupied, the error names it (for example, `ports 8788-8807 are
all in use`). Host API and tunnel ports are unchanged.

Startup detection uses shared `FLEET_CONFIG_UI` JSON events for starting,
retrying, readiness, and failure, not the wording or spacing of the human
banner. The normal readable messages remain in the log and installer output.

## Manage

```powershell
npm run service -- host+node status
npm run service -- node logs
npm run service -- host+node stop
npm run service -- host+node start
npm run service -- host+node restart
npm run service -- node uninstall
```

Use `node`, `host`, or `host+node` as needed. Start is idempotent. **Stop disables
future login/recovery starts** until start or reinstall reenables them. Stop a
task before reinstalling. Uninstall removes only the owned task, preserving the
checkout, identity, database, settings, credentials, logs, and management files.
Foreign or modified tasks are refused, never taken over.

Tasks are named `CopilotFleetHostLogin-...` / `CopilotFleetNodeLogin-...`.
Files live under `%LOCALAPPDATA%\CopilotFleet\login\host` and `...\node`.
`runtime.log` holds application output, `runtime.log.startup.log` holds launcher stderr,
and `logs` shows their last 80 lines. Large runtime logs rotate on startup to
`runtime.log.previous`. Treat logs as private: they can include claim information.

For a quick live view, use the Host's **Settings → Diagnostics** or the Node's
config page. Both show the latest 80 runtime entries, including normal activity,
with a **Problems only** filter and five-second refresh. This is a bounded
in-memory view cleared on application restart, not a download of the service log.
Use the `logs` command above for launcher/supervisor output or startup failures
that prevent the config page from opening.

## Credentials and lifecycle

The tasks use the current user's SID, InteractiveToken, and normal privileges.
There is no Windows password, LocalService, S4U, auto-logon, elevation requirement,
credential export, or service token file. Interactive manual Node startup on
Windows and Unix uses the same GitHub authentication recovery.

Existing profiles, tool paths, Node identity/settings/lock, and Host data/tunnel
settings are retained. `FLEET_NODE_CONFIG_DIR` may select an existing absolute
identity directory. Only allowlisted nonsecret environment overrides are saved;
reinstall when captured paths change. PowerShell profiles are not executed.
The checkout's `.env` still loads as with manual startup.

Before Node installation, start, or restart, the CLI checks
`gh auth status --active --hostname <host>` using the saved task profile and
checkout environment. `<host>` is `GH_HOST` or `github.com`. For missing/expired
credentials, an interactive terminal runs
`gh auth login --hostname <host> --web --skip-ssh-key`, then verifies the result
and continues the original operation. Restart checks occur before stopping the
running Node. Cancellation, failed login, or failed verification stop the command;
there is no repeated login loop.

The status command alone cannot distinguish invalid credentials from network
errors. On failure, an authentication-required result or an HTTP 401 from
`gh api user` permits recovery; other failures report an actionable error without
opening login. Status/diagnostic output is not printed or persisted. The login
itself owns the terminal so the operator can see its device code and prompts.

No login is attempted without terminal input/output, or when
`GH_PROMPT_DISABLED` is set. An invalid `GH_TOKEN`, `GITHUB_TOKEN`, or matching
enterprise token override must be replaced or unset; browser login cannot
override environment credentials. Shell-only tokens are not saved in task
metadata and cannot substitute for the scheduled task's own successful probe.
Copilot and Dev Tunnels still have independent authentication.

Preflight repeats the GitHub check and uses Copilot `auth.getStatus` in the
actual task without printing raw output or sending a model prompt. Then
enrollment runs in the installer's same Windows user context, with any temporary
Dev Tunnel closed afterward. Grants/tokens remain in memory, not task arguments,
input files, or installed metadata. Only identity/settings and restart-safe
tunnel/port flags persist. A failed preparation registers no new long-running
task; retrying after enrollment reuses the saved key for that Host.

Host/Node logon delays are 15/25 seconds, with no execution time limit. Both tasks
retain Task Scheduler's ten one-minute failure retries, but those are an outer
fallback, not the Node's in-process recovery mechanism.

The Windows Node login runner retries an unexpectedly failed supervisor **at most
four times per task invocation**, waiting **5, 15, 30, then 60 seconds**. The budget
does not reset after a long-running attempt. Each attempt, exit code/signal,
verified process-tree termination, backoff, and exhausted budget is recorded in
`runtime.log` with a `[login-recovery]` prefix, independently of Task Scheduler's
Operational history setting. Exit 0 is a clean stop, not a crash. SIGINT/SIGTERM
stop requests cancel backoff and prevent another attempt. Missing identity/config,
spawn failures, unsafe cleanup, or log failures halt recovery rather than looping;
launcher failures are also reported in `runtime.log.startup.log`.

Each Node supervisor attempt has its **own kill-on-close Windows Job Object**.
Before any retry, the runner requires proof that the previous attempt's entire
tree, including orphaned Copilot/MCP descendants, terminated. Missing proof is a
fatal error, never permission to spawn another writer. The runner never removes
checkout locks or identity files; stale Node-instance locks remain the Node
runtime's responsibility. Node stdout/stderr and job diagnostics are streamed to
the runtime log with backpressure; a log-write failure is fatal. Host behavior is
unchanged.

The Node supervisor still handles planned exit-75 updates inside one attempt.
Host-triggered Node updates include build-time development dependencies despite
`NODE_ENV=production`, rebuild when the running revision is behind an already
updated checkout, and restart through that supervisor. They do not need
`node install --existing-node` or alter the registered task, identity, or settings.
The Host confirms success only after the restart reports the expected revision.
If an older updater is stuck, stop the Node service, run
`npm install --include=dev` and `npm run build:node` in the updated checkout, then
`npm run service -- node start` to load this fix once.

**Installing runner changes is different from updating Node application code.**
The task runs a copied runner under `%LOCALAPPDATA%`, while the runner loads the
Node's production build from the checkout. Existing installations must stop the
task, update/build the checkout, and reinstall the runner to gain crash recovery:

```powershell
npm run service -- node stop
npm run build:node
npm run service -- node install --existing-node --no-build
```

Run these in the updated checkout, preserving any nondefault install flags such as
`--config-port`. A plain task start/restart or a Host-triggered application update
does not refresh the installed runner copy.

An outer kill-on-close Windows job still contains the entire task action and all
its descendants. The existing Host tunnel lifecycle is unchanged.

Locking Windows keeps tasks running while awake. RDP disconnection normally does
too, unless policy logs off the session. Do not expect execution during sleep or
after sign-out. Token expiry, MFA, SSH agents, proxies, and MCP-server logins still
follow their normal rules; same-user startup is not permanent authentication.

`status` reports native task state, not application health. An approved reboot
followed by sign-in is the final way to establish logon-trigger operation:
confirm the Host responds and the same Node reconnects without a terminal.
No installer command reboots or signs you out.

## Updating the Host from Settings

**Settings → General → Update Host** works for a login-service Host without
reinstalling anything. The Host cannot restart its own task from inside it —
everything it starts is in that task's kill-on-close job — so it registers a
one-off, on-demand task for the same user (`CopilotFleetSelfUpdate-...`,
InteractiveToken, least privilege, no triggers) and starts it. That task runs
`scripts/self-update.mjs` outside both Fleet tasks with the Host task's saved
environment: it fetches, resets, runs `npm install --include=dev` and
`npm run build`, then `npm run service -- host+node restart` — or `host restart`
when this checkout has no Node task or the Node task was stopped — and deletes
itself. A failed build restarts nothing. The task being active is not Fleet
serving in it, so the restarted Host records the result itself: once it is
listening on the new commit and this machine's Node has reconnected on it. The
restart runs noninteractively, so
expired GitHub CLI credentials fail it (the old processes keep running) rather
than prompting; renew them and update again. Output goes to `self-update.log`
and progress to `self-update.json`, both beside the Host database. The Host
recognises that it was started by this service because its output is the
manifest's `runtime.log`, so a Host started by hand never restarts the tasks.

## Historical references

These earlier experiments are retained as history, not the current CLI contract:

- [Boot-persistent service review](superpowers/specs/2026-09-11-boot-persistent-service.md)
- [Windows boot approaches](superpowers/specs/2026-09-11-windows-boot-service-approaches.md)
- [Failure handoff](superpowers/specs/2026-09-11-boot-service-failure-handoff.md)
- [Signed-out reboot proposal](superpowers/specs/2026-09-11-reboot-autostart-design.md)
- [Original logon proposal](superpowers/specs/2026-09-11-logon-autostart-design.md)
- [Detached tunnel lifecycle](superpowers/specs/2026-09-11-detached-tunnel-lifecycle.md)
- [Detached tunnel approaches](superpowers/specs/2026-09-11-detached-tunnel-process-approaches.md)
- [Microsoft task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)
- [GitHub credential storage](https://cli.github.com/manual/gh_auth_login)
