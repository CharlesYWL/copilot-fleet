# Windows login startup

**Accepted:** 2026-09-11. Start after the operator signs into Windows, using the
existing interactive account and credentials. This is not signed-out boot startup.

## Install

Use normal PowerShell in an updated Fleet checkout with Node.js, GitHub CLI, and
Copilot installed and signed in. Private-tunnel Nodes also need
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

Installation builds, probes authentication in a temporary same-user task,
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

## Credentials and lifecycle

The tasks use the current user's SID, InteractiveToken, and normal privileges.
There is no Windows password, LocalService, S4U, auto-logon, elevation requirement,
credential export, or service token file. Manual commands and Unix behavior remain
unchanged.

Existing profiles, tool paths, Node identity/settings/lock, and Host data/tunnel
settings are retained. `FLEET_NODE_CONFIG_DIR` may select an existing absolute
identity directory. Only allowlisted nonsecret environment overrides are saved;
reinstall when captured paths change. PowerShell profiles are not executed.
The checkout's `.env` still loads as with manual startup.

Preflight uses `gh auth status --active` and Copilot `auth.getStatus` in the
actual task without printing raw output or sending a model prompt. Then
enrollment runs in the installer's same Windows user context, with any temporary
Dev Tunnel closed afterward. Grants/tokens remain in memory, not task arguments,
input files, or installed metadata. Only identity/settings and restart-safe
tunnel/port flags persist. A failed preparation registers no new long-running
task; retrying after enrollment reuses the saved key for that Host.

Host/Node logon delays are 15/25 seconds, with no execution time limit and ten
one-minute crash retries. The Node supervisor handles planned exit-75 updates.
A kill-on-close Windows job contains the task's descendants; application output
goes directly to its log file. The existing Host tunnel lifecycle is unchanged.

Locking Windows keeps tasks running while awake. RDP disconnection normally does
too, unless policy logs off the session. Do not expect execution during sleep or
after sign-out. Token expiry, MFA, SSH agents, proxies, and MCP-server logins still
follow their normal rules; same-user startup is not permanent authentication.

`status` reports native task state, not application health. An approved reboot
followed by sign-in is the final way to establish logon-trigger operation:
confirm the Host responds and the same Node reconnects without a terminal.
No installer command reboots or signs you out.

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
