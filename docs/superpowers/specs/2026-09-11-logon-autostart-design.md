# Logon auto-start: run as the Windows user, keep every credential

**Date:** 2026-09-11  
**Status:** Proposed design after the operator accepted “we need to log in.”  
**Supersedes, for this machine:** signed-out LocalService / WinSW reboot design in `2026-09-11-reboot-autostart-design.md`. That path remains valid for a headless VM that must come up before anyone signs in. It is not this laptop’s path.

## Decision

After a reboot, **you sign into Windows once**. Task Scheduler then starts Host and Node as **you**, with `LogonType = Interactive`, principal **your SID**, **no password stored**.

That is the same identity as a normal terminal. Credential Manager, `gh`, Copilot `~/.copilot`, `devtunnel user login`, `%APPDATA%\CopilotFleet\node.json`, and `Q:` are all in play. There is **no** `fleet-credentials.env`. There is **no** isolated LocalService HOME.

This is Unix `--start-mode login` (already the Unix default). Windows does not implement it today; HEAD only has LocalService boot.

## What you get, and what you give up

| | Logon task (this design) | LocalService boot (previous design) |
| --- | --- | --- |
| Starts | After this user logs on | At Windows startup, signed out |
| Windows password in Task Scheduler | No | No |
| `gh` / Copilot already signed in | Reused | Separate env file required |
| Private Dev Tunnels | Yes, same `devtunnel user login` | No |
| Node identity | Existing `%APPDATA%\CopilotFleet` | Same leaf, but tools use a new profile |
| After full **Sign out** | Stops with the session | Keeps running |
| After **Lock** (`Win+L`) | Keeps running | Keeps running |

Accepting login means: the fleet is down at the lock screen of a cold boot until you unlock Windows. After that it should come up by itself.

## Mechanism

```text
Reboot → Windows logon (PIN / password / Hello, whatever you already use)
       → Task Scheduler AtLogOn (your SID)
            CopilotFleetHost   Interactive / LeastPrivilege
            CopilotFleetNode   Interactive / LeastPrivilege
            CopilotFleetTunnel optional, same identity (detached from Host)
```

Task XML essentials:

- **Principal:** `UserId = S-1-12-1-…` (live token SID). Never `AzureAD\…` or `redmond\…` as the stored name.
- **LogonType:** `Interactive`. Not Password, not S4U, not ServiceAccount.
- **RunLevel:** `LeastPrivilege`. An elevated task would *not* see the same user profile as `npm run start:node`.
- **Trigger:** `LogonTrigger` for that SID. Optional short delay (10–20s) so `Q:` and UserProfile are mounted.
- **Settings:** `ExecutionTimeLimit = PT0S` (default 3 days would kill the Node), `MultipleInstancesPolicy = IgnoreNew`, `RestartOnFailure` ~10× / 1 min, `StartWhenAvailable`, run on battery.
- **Action:** absolute `C:\Program Files\nodejs\node.exe` plus existing `supervisor.mjs` (Node) or built Host `dist`. Bake absolute `copilot` / `devtunnel` if PATH would miss WinGet Links — those binaries are user-scoped on this machine.

Do **not** require UAC elevation to *register* this, if we can put the tasks in the current user’s Task Scheduler namespace. Elevation is what LocalService ACLs needed. An elevated installer that then registers an Interactive task as HighestAvailable is the wrong shape.

WinSW / SCM is the wrong backend here. A service “running as you” either stores a password (the 0x8007052E path) or is LocalService. Interactive logon is Task Scheduler’s job.

## Credentials — what “all available” actually means

In the **logged-on session**, these work because they are already yours:

- GitHub CLI (`gh auth login` / Credential Manager)
- Copilot CLI (`~/.copilot`, including the encryption key)
- Dev Tunnels (`devtunnel user login` in the user secure store)
- Node key file `%APPDATA%\CopilotFleet\node.json`
- Git HTTPS via Git Credential Manager
- Host `.env` and `apps/host/data` on `Q:` once the profile is loaded

They still expire on their own schedules (`devtunnel` login lasts several days; GitHub tokens can be revoked). Login-mode does not mint a second copy of them and does not unlock them **before** you sign in.

Do not point a LocalService process at these stores. This design simply **does not start a second identity**.

## Host, Node, tunnel

**Node:** `npm run node:service -- install --existing-node --start-mode login`. Reuse identity. Allow `--devtunnel-id` again (Unix already allows it in login mode). No `--credential-file`.

**Host:** a sibling `host:service` / `copilot-fleet-host install --start-mode login`. Built `apps/host/dist`, not `tsx watch`. Data can stay in the checkout because you can read `Q:` after logon.

**Tunnel:** still do **not** parent `devtunnel` from the Host process if you want Host rebuilds not to drop the URL. Register `CopilotFleetTunnel` as a third AtLogOn task (or have Host start it via a Scheduled Task, which also escapes the terminal Job Object). Same user, so Dev Tunnels works. Settings on/off should start/stop **that task**, not a Host child.

`npm run host` / `npm run start:node` remain. Instance lock already refuses a second Node: stop the task (or let IgnoreNew skip) before a dev terminal, and the other way around.

## What we stop doing

- AzureAD password prompt / Password logon
- LocalService ACLs, isolated HOME, `fleet-credentials.env` for this mode
- Refusing `--devtunnel` on Windows (that refuse is LocalService-only)
- Treating WinSW heartbeat as the reboot design for this laptop
- Pretending S4U is a way to keep the user vault without logging in

## Proof sequence

1. Register a throwaway AtLogOn Interactive task as the current SID whose action writes `whoami`, `%APPDATA%`, and “does `node.json` exist?” to a file. Sign out and back in (or `schtasks /Run` while already logged on for a weaker check). Confirm it is `redmond\charlesyin` / the Entra SID and the real AppData.
2. Node logon task with `--existing-node`. Same node id. Copilot/`gh` work **without** an env file. No model prompt required for the gate: `gh auth status` and Copilot `auth.getStatus` as this user.
3. Host logon task. UI on `:8787` after logon.
4. Reboot, sign in, wait for the delay. Host + Node up with no extra terminal.
5. Lock vs Sign out: lock keeps them; sign out stops them.

## Review checks

- [ ] Success = automatic start **after Windows logon**, not at the pre-logon screen.
- [ ] No credential file in this mode.
- [ ] Dev Tunnels stays allowed.
- [ ] Register by SID, Interactive, LeastPrivilege, no elevation required to install if possible.
