# Host and Node as boot-start services — approaches (no Entra password)

**Status:** Approaches for review. No implementation until this file is approved.  
**Date:** 2026-09-11  
**Companion:** [Detached tunnel process approaches](./2026-09-11-detached-tunnel-process-approaches.md)

## 1. What this is answering

You want the **Host** and the **Node** to come back automatically after a **machine** reboot, as something Windows will start without you opening a terminal. A previous attempt used Task Scheduler **Password** logon as `AzureAD\charlesyin@microsoft.com`. Registration failed with `0x8007052E` / Win32 1326 (username or password incorrect). You asked for a path that does **not** depend on that password prompt.

This is an OS-lifecycle problem. It is not the same as “keep the tunnel up while I rebuild the Host process” (companion doc), but the identity you pick here decides whether Dev Tunnels can run at all.

## 2. What the failure actually was

The log you captured:

```text
Windows Scheduled Task account: AzureAD\charlesyin@microsoft.com
Use the actual Windows/Microsoft account password, not a Windows Hello PIN or passkey.
Task account password: ***********
HRESULT=0x8007052E: The user name or password is incorrect.
Password batch logon can still be refused ... no SCM/Netlogon/S4U fallback is attempted.
```

Those strings **are not in the current tree**. HEAD’s installer never prompts for a Windows password. It registers `NT AUTHORITY\LOCAL SERVICE` (`S-1-5-19`) with Task Scheduler logon type **5** (`TASK_LOGON_SERVICE_ACCOUNT`) and a **null** password. The CLI help says so explicitly.

So the paste is from an **older Password-principal installer** (or a leftover task XML still using `<LogonType>Password</LogonType>`). Retrying that design against an Entra-joined, Windows Hello machine will keep failing. It is not a typo in the password field.

### 2.1 Why Password logon fails for `AzureAD\user@microsoft.com`

Task Scheduler “Run whether user is logged on or not” stores a password and performs a **batch logon**. That needs a password hash Windows can present locally.

On a Microsoft Entra–joined corp laptop that is typical:

- Sign-in is often **Windows Hello** (PIN, FIDO, WHfB). There is no password for Task Scheduler to store, even if you type the Microsoft account password into the prompt.
- CloudAP / PRT logon is not the same as a local password. `LogonUser` / batch logon returns **1326** (`ERROR_LOGON_FAILURE`) / **0x8007052E**.
- Conditional Access, “deny log on as a batch job”, and “protected users” / non-delegatable accounts can refuse the same API even when a password exists.
- Microsoft’s own Task Scheduler logon types: **Password** needs a password; **S4U** stores no password but **cannot use the network or encrypted files** (DPAPI, credential manager, `devtunnel` keychain, Copilot profile); **InteractiveToken** needs an already logged-on session.

Fleet already documented this conclusion in the current installer: *no personal password, SYSTEM, S4U, SCM, or Netlogon fallback is attempted.* That is a deliberate refusal, not a missing feature.

**Do not try to “fix” 0x8007052E by collecting the Entra password more carefully.** The logon type is the bug.

## 3. Current HEAD (Node only)

| Piece | Today |
| --- | --- |
| Node Windows | Task Scheduler boot task, **LOCAL SERVICE**, no Windows password. `npm run node:service -- install --existing-node` |
| Node Unix | systemd user unit or launchd agent at **login**; `--start-mode boot` is a system unit as the **same human user**, with `--credential-file` |
| Host | **No** service installer. `npm run host` / `npm run start:host` only |
| Tunnel | Child of Host, or sibling `tunnel-process` (not a task) |

Windows Node boot mode **requires**:

- Elevated PowerShell as the human owner (the task itself is not that account).
- `--credential-file` with `GH_TOKEN` / `GITHUB_TOKEN` and, if needed, `COPILOT_GITHUB_TOKEN`. Classic `ghp_` PATs cannot authenticate Copilot.
- Direct Host HTTPS. **`--devtunnel` / `FLEET_DEVTUNNEL_ID` is refused.** LOCAL SERVICE cannot use the operator’s Dev Tunnels login.
- Checkout and workspace paths on a **fixed local volume**, not SUBST, not network, not a reparse point. `Q:\Repos\...` fails if `Q:` is a per-logon SUBST.
- Node identity directory (`%APPDATA%\CopilotFleet` or `FLEET_NODE_CONFIG_DIR`) ACL’d to LocalService; Copilot/gh get an **isolated** `HOME` / `COPILOT_HOME`, not the interactive profile.
- Existing `CopilotFleetNode` task must be owned and not a leftover Password principal; otherwise install refuses to take it over.

If you run **current** `npm run node:service -- install --existing-node` without `--credential-file`, you should **not** see an AzureAD password prompt. You should get a LocalService probe and then a stop asking for the env file. If you still see the password prompt, the shell is not running this checkout’s scripts (old `copilot-fleet-node` on PATH, or an old copy under `%LOCALAPPDATA%\CopilotFleet`).

## 4. The constraint that drives every option

Three things want **different Windows identities**:

| Workload | Needs at boot | Identity that works |
| --- | --- | --- |
| Host API + SQLite + Microsoft **operator** sign-in | Filesystem + bind `PORT`. MSAL does **not** persist tokens on disk; browsers sign in to the Host, the Host does not need your Hello PIN. | LOCAL SERVICE is viable **if** the data directory is ACL’d to it |
| Node + Copilot CLI + `gh` | Tokens. Interactive profile is DPAPI-bound to **you**. | LOCAL SERVICE only with an explicit credential file (already designed). Interactive user if you want the keychain. |
| Dev Tunnels `devtunnel host` / `devtunnel connect` | Login cached in the **user** secure store; CLI login lasts several days. Host tokens from `devtunnel token` expire ~**24h** and can only be refreshed by a real user. Microsoft: you cannot host anonymously. | **The logged-on user** (or a refreshable user token). LOCAL SERVICE cannot host a creator-private Dev Tunnel. S4U cannot read that encrypted store. |

So this combination is **impossible** as a single LOCAL SERVICE task:

> Machine boots, nobody has logged on yet, Host is reached only through a **creator-private Dev Tunnel**, Node uses `--devtunnel <id>`, no credential files, no Entra password.

You have to pick an option in section 6. Pretending Password logon will glue those three identities together is how you got 0x8007052E.

## 5. Decision criteria (before options)

| Criterion | Weight | Must-have? |
| --- | --- | --- |
| No Entra / Hello password stored in Task Scheduler | High | Yes |
| Starts after **machine** reboot | High | Yes — but “before anyone logs on” vs “when this user logs on” must be explicit |
| Host and Node both covered | High | Yes (Host is missing today) |
| Private Dev Tunnels remain usable | High | Only if you accept **login-time** start |
| Unattended VM / no interactive logon | Medium | Conflicts with private Dev Tunnels |
| Least privilege (not SYSTEM) | High | Yes |
| Same CLI shape as Unix (`login` vs `boot`) | Medium | Strongly preferred |
| No extra third-party service wrapper (NSSM/WinSW) unless Task Scheduler is blocked | Medium | Prefer first |

## 6. Options

### Option 0 — Do nothing (status quo)

Node: current LocalService task, if install succeeds. Host: manual terminal. Tunnel: dies with Host or with `concurrently`.

Fails the request. Included because Host-as-service is new work; we should not pretend it already exists.

### Option 1 — Password / S4U as `AzureAD\user` (“run whether logged on or not”)

The attempt you already made, or S4U (“Do not store password”) as a supposed fix.

| Pros | Cons |
| --- | --- |
| Feels like “run as me” | Password logon is **broken** for Hello/Entra accounts (`0x8007052E`) |
| | S4U: no network, no DPAPI — Copilot, `gh`, `devtunnel`, and often `Q:` network/SUBST all fail |
| | Stores or impersonates a corp identity in a scheduled task; worse security than LocalService + scoped tokens |
| | Current code **rejects** this principal on purpose |

**Verdict: reject.** Do not reintroduce the password prompt.

### Option 2 — LOCAL SERVICE Task Scheduler at startup (current Node design), plus a **Host** twin

Same backend the Node installer already uses: BootTrigger, 30s delay, IgnoreNew, restart-on-failure, kill-on-close Job for **that** process’s children, LocalService, no Windows password.

Add `npm run host:service` (or `copilot-fleet-host`) modelled on `node:service`:

- Data directory moved or ACL’d so LocalService can read/write SQLite (`apps/host/data` inside a SUBST checkout will not do).
- Production Windows DACL already wants the **running** account + SYSTEM + Administrators; running as LocalService fits that if the operator’s SID is also granted for backup/export.
- `--credential-file` is **not** required for the Host (no Copilot). Optional only if you later attach a named Cloudflare token.
- Tunnel: **do not** parent `devtunnel` from this task. Either no tunnel (loopback-only Host), or a public HTTPS provider with a **file-based** token (Cloudflare named tunnel), or a **separate** login-time tunnel task (Option 3 / companion daemon).

Node stays as today: `--credential-file`, no `--devtunnel`, `--access-path` for workspaces, refuse SUBST.

| Pros | Cons |
| --- | --- |
| No password; proven pattern in this repo | Private Dev Tunnels **out** |
| True pre-logon start | `Q:\Repos\...` must be a real volume or you reinstall from `C:\...` |
| Host is actually easier than Node (no Copilot) | Leftover Password task named `CopilotFleetNode` must be removed first |
| Least privilege | Group Policy can still deny LocalService batch logon; then you diagnose **that**, not Entra passwords |

**Verdict: recommended for unattended / VM / “up before I log in”, with tunnels that are not creator-private.**

### Option 3 — Login-time task as the interactive user (no password) — Windows analog of Unix `--start-mode login`

Task Scheduler **LogonTrigger** + **InteractiveToken** (or a per-user Startup folder / `HKCU\...\Run` as a weaker variant). No password stored. Runs as `AzureAD\charlesyin@microsoft.com` **after that user logs on**. Can read DPAPI, `devtunnel user login`, Copilot keychain, `Q:` SUBST that is created at logon.

Host, Node, and the tunnel daemon from the companion doc can all use this identity.

Does **not** start at the lock screen before logon. If BitLocker + no auto-logon, nothing Fleet runs until you unlock Windows. That is the honest trade for private Dev Tunnels.

| Pros | Cons |
| --- | --- |
| No password; Entra/Hello compatible | Not “system service before logon” |
| Dev Tunnels + Copilot profile work | SUBST `Q:` exists only after logon — acceptable here, fatal for Option 2 |
| Matches Unix default | If the user never logs on (server SKU / auto-logon disabled), fleet stays down |

**Verdict: recommended default for a corp laptop that uses Dev Tunnels.** This is the missing Windows `--start-mode login`.

### Option 4 — Real SCM Windows Service (WinSW / NSSM / `sc.exe`) as LocalService or LocalSystem

A `services.msc` service instead of Task Scheduler.

| Pros | Cons |
| --- | --- |
| Familiar “system service”; recovery options | Extra binary to vendor and sign |
| LocalService/LocalSystem still **no password** | LocalSystem is far too privileged; do not use it |
| | Does **not** solve Dev Tunnels: the identity problem is the same as Option 2 |
| | Current installer explicitly does not use SCM; adding it is a second backend to test |

**Verdict: only if Task Scheduler LocalService registration is blocked by policy** (the error would then mention LocalService, not 0x8007052E). Do not add WinSW to paper over the Entra password issue.

### Option 5 — Split identities (likely production shape)

Three processes, two identities:

```text
Boot (nobody logged on yet)
  Host task     → LOCAL SERVICE     → SQLite + :8787
  Tunnel task   → (not started) or cloudflared named tunnel + token file

User logon
  Tunnel daemon → InteractiveToken  → devtunnel host <persisted id>
  Node task     → InteractiveToken  → Copilot + optional --devtunnel
                 or LOCAL SERVICE   → credential-file, direct HTTPS only
```

Settings still talks to the tunnel daemon (companion doc). After reboot-before-logon, the Host is up on loopback; after you log on, the private URL appears and Nodes follow the broadcast.

| Pros | Cons |
| --- | --- |
| Host can be up for local debugging without Dev Tunnels | Two installers / two start modes to explain |
| Private tunnel only runs with a real user | Nodes that are other machines still cannot `--devtunnel` until *their* user session exists |
| No Entra password anywhere | |

**Verdict: recommended overall architecture** if you want both “Host at boot” and “Dev Tunnels when I am logged on.”

## 7. Recommendation

**Never restore Password logon.** Treat 0x8007052E as a closed incident.

Give Windows the same two start modes Unix already has, and add a Host installer:

| Mode | Flag | Principal | When it starts | Tunnel | Node Copilot |
| --- | --- | --- | --- | --- | --- |
| **login** (laptop default) | `--start-mode login` | Interactive user, **InteractiveToken**, no password | At logon | Dev Tunnels OK (via detached daemon) | User profile / existing `copilot login` |
| **boot** (VM / unattended) | `--start-mode boot` | LOCAL SERVICE, no password | At startup, 30s delay | Direct HTTPS or token-file provider only; **no** `--devtunnel` | `--credential-file` required |

Ship:

1. **Host service CLI** (`host:service` / `copilot-fleet-host`) with those two modes. Boot mode ACL’s a stable data dir (not a SUBST checkout).
2. **Node Windows `--start-mode login`**, which does not exist today (Windows only has the LocalService boot path). That is how you keep `--devtunnel` on a laptop without a password.
3. **Tunnel as its own task** running the daemon from the companion doc, same start-mode as the Host’s tunnel needs. Host must not parent it.
4. **Install diagnostics** that detect leftover Password tasks and tell you to `uninstall` / delete `CopilotFleetNode` before migrating, instead of attempting a password re-register.

### What to try on this machine *before* any code (operational)

These are checks, not a new design:

1. Confirm the scripts you run are this checkout (`Get-Command copilot-fleet-node`, `git status` in `Q:\Repos\copilot-fleet`). An old PATH shim will still prompt for AzureAD passwords.
2. Elevated PowerShell as **you**, not `sudo`-equivalent of SYSTEM.
3. If a `CopilotFleetNode` task exists from the password era, stop/uninstall it first.
4. `--credential-file` on a **fixed** `C:` path, ACL’d as README describes.
5. If `Q:` is SUBST, pass `--repository-path` to the real drive (or clone there). LocalService at boot cannot see a SUBST that is created at logon.
6. Drop `--devtunnel` / `FLEET_DEVTUNNEL_ID` for boot mode. Point the Node at a direct HTTPS Host URL, or use login mode instead.

If **current** LocalService registration fails, the HRESULT will say LocalService, not “Task account password”. That is a policy/ACL/volume problem and is solvable without Entra credentials. If the password prompt appears, you are not on HEAD.

## 8. Host-specific notes (why a copy-paste of the Node installer is wrong)

- Host has **no** Copilot, **no** `gh`, **no** workspace `--access-path`. Do not require a GitHub credential file for Host boot.
- Host **does** have SQLite, Host private keys, and the production Windows DACL. The service account must own that tree. A Host that still writes `apps/host/data` under a developer SUBST will lose the database at reboot.
- Operator Microsoft sign-in is browser → Host. The Host process does not need your Hello PIN. LOCAL SERVICE Host is therefore reasonable.
- `devtunnel user login` is **not** a Host API concern; it is a tunnel-daemon identity concern. Do not start `devtunnel` inside the Host service just because the Node installer once had a `--devtunnel-id` flag (and now refuses it for LocalService).
- `tsx watch` / `npm run host` must remain for development. The service should run **built** `apps/host/dist`, same as `npm run start:host`, so a service restart is not a TypeScript watch loop.

## 9. How this relates to the tunnel doc

| Goal | Which process | Which identity |
| --- | --- | --- |
| Rebuild Host all day, URL stable | Detached tunnel daemon | Same as whoever started it (usually you, interactive) |
| Reboot PC, Host API comes back | Host task | login → you; boot → LocalService |
| Reboot PC, private Dev Tunnel comes back | Tunnel task | **login / InteractiveToken only** |
| Reboot PC, Node agents come back | Node task | login → you; boot → LocalService + credential file, no private tunnel |

If you only implement boot LocalService Host+Node and keep in-process Dev Tunnels, you will either fail install (today’s refuse) or fail at first `devtunnel host` under LocalService.

## 10. Decisions to confirm

Please mark these when you review:

1. For **this laptop**, is success **at user logon** (Option 3 / `--start-mode login`) enough, or must Host be up **before** Windows logon (Option 2 / boot)?
2. Is **creator-private Dev Tunnels** still non-negotiable for remote Nodes? If yes, boot-before-logon cannot include that tunnel; we split (Option 5). If no, Cloudflare/Tailscale named endpoints + LocalService is simpler.
3. Should the first Host installer be **login-mode only** (faster, unblocks laptop reboot) with boot-mode in a second PR?
4. Confirm we **never** reintroduce the AzureAD password prompt, even as a hidden fallback.

No code until this file is accepted.
