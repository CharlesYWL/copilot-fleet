# Reboot auto-start: the approach that can actually run here

**Date:** 2026-09-11  
**Status:** Proposed for **signed-out / before-logon** VMs only. If the operator accepts “we log into Windows first,” use `2026-09-11-logon-autostart-design.md` instead — that path reuses `gh`, Copilot, and Dev Tunnels and does not use LocalService.  
**Inputs:** `2026-09-11-boot-persistent-service.md`, `2026-09-11-windows-boot-service-approaches.md`, `2026-09-11-boot-service-failure-handoff.md`.

## Decision

**Register Host and Node as real Windows services under `NT AUTHORITY\LocalService`, start type Automatic, no Windows password.**

Do not use the Entra account, stored passwords, S4U, auto-logon, or “run at user logon” as the reboot path. Those either already failed on this VM (`0x8007052E`, SCM 1068) or start **after** someone signs in, which is not a signed-out reboot.

The wrapper is **WinSW launching `node.exe` directly**. Not PM2. Not the operator’s interactive profile.

This is the only password-free execution that has already reached `Running` / `Auto` / `S-1-5-19` on this machine (`CopilotFleetPm2Probe`). Task Scheduler LocalService *registered* a Fleet probe, then our ownership code crashed on omitted `RunLevel` XML and the action never ran. Identity was right; that backend is not the thing to bet reboot on.

## What comes up after reboot

```text
Windows boot (nobody logged on)
        |
        |  SCM Automatic
        v
 CopilotFleetHost   LocalService
   node.exe  apps/host/dist/server/server.js
   data: C:\ProgramData\CopilotFleet\host\
   bind: 127.0.0.1:8787
        |
        |  delayed ~30s, same identity
        v
 CopilotFleetNode   LocalService
   node.exe  apps/node/supervisor.mjs  (via existing runner + kill-on-close job)
   identity: existing %APPDATA%\CopilotFleet  via FLEET_NODE_CONFIG_DIR
   creds:    C:\private\fleet-credentials.env  (NTFS ACL, not the user vault)
   host URL: http://127.0.0.1:8787   (same box) or a file-token HTTPS tunnel
```

Private Dev Tunnels are **not** in this boot set. `devtunnel user login` lives in the human secure store. LocalService cannot host or `connect` that tunnel. If remote access before logon is required, add a **third** service later: `cloudflared` (or equivalent) with a **token file**. Until then, colocated Host+Node on loopback is enough for “the VM rebooted and agents come back.”

## Why this, given the three docs

| Claim in the older notes | What to keep |
| --- | --- |
| Never prompt for `AzureAD\…` password | Keep. Closed incident. |
| LocalService does not inherit `gh` / Copilot vault | Keep. That is why the env file exists. |
| Share the existing Node identity leaf, isolate HOME | Keep. |
| `supervisor.mjs` handles exit 75; the OS manager handles crash restart | Keep. SCM recovery replaces Task Scheduler `RestartOnFailure`. |
| Task Scheduler LocalService is HEAD’s installer | Do not use it as the reboot vehicle. Registration worked; execution was blocked by our XML check. README also retired WinSW after that bet. This design reverses that backend choice because WinSW is what actually ran here. |
| WinSW + PM2 heartbeat proved native service execution | Keep the **WinSW + LocalService + Auto** part. Drop PM2. Fleet already has a supervisor. |
| Interactive logon task would keep the user’s Copilot profile | True, and it is a different product: start-at-logon, not start-at-reboot. Do not ship it as a silent substitute. |

## Trade-offs you have to accept

These are not installer bugs. They are the cost of signed-out boot:

1. **`C:\private\fleet-credentials.env`** with `GH_TOKEN`/`GITHUB_TOKEN` and, if needed, `COPILOT_GITHUB_TOKEN`. Classic `ghp_` is not enough for Copilot. LocalService cannot decrypt Credential Manager or `~/.copilot`. Pointing `HOME` at the user profile is not a workaround.
2. **Fresh Copilot runtime profile** under the service’s isolated HOME. Interactive sessions, MCP customizations, and the user vault are not migrated.
3. **No `--devtunnel` on the Node service.** Direct Host URL only (loopback on this VM).
4. **Checkout on a volume present at boot.** `Q:\Repos\copilot-fleet` is recorded as a Dev Drive, not a SUBST. If `Q:` is late, use Automatic (Delayed Start) plus working-directory retry — do not bake a per-logon mapping.
5. **Elevation once**, to install. The services themselves stay LeastPrivilege LocalService, not SYSTEM.

If any of those are unacceptable, the requirement is no longer “up before anyone logs on.” Then the honest alternative is a logon-time InteractiveToken task that reuses your existing `gh` / Copilot login — and the fleet stays down on a signed-out reboot.

## Host vs Node (do not copy-paste the Node installer)

| | Host | Node |
| --- | --- | --- |
| GitHub / Copilot env file | Not required | Required |
| `--access-path` | Not required | Required for each workspace directory the agent may touch |
| Data | Move SQLite/keys to `C:\ProgramData\CopilotFleet\host`, ACL: LocalService + you + SYSTEM + Administrators | Keep `node.json` / `node.lock` via `FLEET_NODE_CONFIG_DIR`; isolated HOME for tools |
| Binary | Built `apps/host/dist`, not `tsx watch` | `supervisor.mjs` → `dist/main.js` |
| Tunnel child | Must not spawn `devtunnel` | Must not run `devtunnel connect` |

`tsx watch` / `npm run host` stay for development. Stop the service before using them; the instance lock already forbids two Nodes.

## WinSW shape (no PM2)

One XML per service, installed under `C:\ProgramData\CopilotFleet\{host,node}\`:

- `serviceaccount` / `id`: LocalService (WinSW’s empty-password LocalService account; SCM ignores a password for this account).
- `onfailure`: restart, with a cap, so crash recovery is SCM’s job.
- `startmode`: Automatic, Host delayed ~10–15s, Node delayed ~30–45s so SQLite is listening.
- `<executable>`: absolute `C:\Program Files\nodejs\node.exe`.
- `<arguments>`: existing `node-service-runner.mjs` for Node (probe/prepare/run, job object, ACL check). Host gets a small sibling runner that only sets `NODE_ENV=production` and imports `apps/host/dist/server/server.js`.
- Logs under `C:\ProgramData\CopilotFleet\...\logs`, not the git checkout.
- Pin WinSW x64 by SHA-256 the way the retired path already did (`05B82D…`). Do not download at run time on a later start.

Keep the current CLI verbs: `install --existing-node`, `status`, `start`, `stop`, `restart`, `uninstall`. Change `backendKind` from `task-scheduler` to `winsw`. Uninstall still preserves identity, checkout, credentials, and logs.

## Auth gate (Node), before Automatic is enabled

Same gate the LocalService task already intended, run **as LocalService**, not as you:

1. Prove LocalService can execute and write the isolated directories (heartbeat or the existing probe mode).
2. Load the ACL-protected env file; refuse if LocalService cannot read it or can write it.
3. `gh auth status --active` and Copilot `auth.getStatus` under that identity. No model prompt. Never print `git credential fill`.
4. Confirm `node.json` is the existing identity (same node id). Do not mint a replacement grant because startup failed.
5. Only then set the service to Automatic and start it.

If step 3 fails, leave StartType Manual and print that the env file is wrong or Copilot-ineligible. Do not fall back to the user vault.

## Leftover machine state (do not ignore)

From the pause handoff, still on the box unless cleaned with user approval:

- `CopilotFleetPm2Probe` service may still be Running.
- Failed task `CopilotFleetNode-probe-5882eadacd8943ddb25dbdc40e0b2931` may still be registered, never run.
- Install metadata stage `preparing`.
- Real `CopilotFleetNode` task/service was not present.

Cleanup is scoped to those owned names. Do not delete `C:\private\fleet-credentials.env` or `%APPDATA%\CopilotFleet\node.json`.

## Proof sequence (stop if a gate fails)

1. Inspect current services/tasks; clean only the owned leftovers above.
2. WinSW LocalService heartbeat already proved execution — do not redo PM2.
3. **Host service only.** After install, `http://127.0.0.1:8787` answers with nobody logged on (lock the session or use a second admin to check). This is the cheapest Fleet proof: no Copilot.
4. **Node service** with `--existing-node --credential-file`. Same node id reconnects. `gh` + Copilot status pass as LocalService.
5. Stop / start / planned exit 75 / uninstall preserves identity.
6. **Signed-out reboot**, only when you approve the disruption. Success = Host listening and Node connected before anyone signs in.

Until step 6, do not claim reboot persistence.

## Explicitly out of scope for this pass

- Reintroducing the AzureAD password prompt.
- Private Dev Tunnels under LocalService.
- Making Task Scheduler XML ownership “good enough” so we can keep the retired-WinSW README story.
- Unix installers (already have systemd/launchd boot mode).
- Detached Dev Tunnel daemon (companion tunnel docs). That is how you keep a URL while **rebuilding the Host process**, not how you survive a **signed-out OS reboot**.

## Review checks

- [ ] Signed-out reboot (before logon) is still the success bar, not “starts when I log in.”
- [ ] Credential file is accepted as the Copilot/`gh` source for this mode.
- [ ] Colocated loopback Host is enough for v1; Cloudflare token-file tunnel can wait.
- [ ] WinSW + LocalService is accepted even though README currently calls WinSW retired.

No code until those are marked.
