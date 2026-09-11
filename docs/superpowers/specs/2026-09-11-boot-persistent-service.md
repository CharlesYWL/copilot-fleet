# Boot-persistent Host and Node: why the password path fails, and what to do instead

**Date:** 2026-09-11
**Status:** Brainstorm / options for review — no implementation
**Scope:** Register the Host and the Node so they start automatically after a reboot, on a machine where Task Scheduler password logon is structurally impossible.

## The question this answers

> I want Host/Node registered as a system service that boots automatically on reboot. The password logon approach does not work:
>
> ```
> Task 'CopilotFleetNode' registration failed.
> HRESULT=0x8007052E: The user name or password is incorrect.
> LastTaskResult=0x8007052E (2147943726); Win32 error 1326
> ```

The password is almost certainly not wrong. **This machine cannot do password batch logon at all**, and no amount of retyping will change that. Below is the evidence, the diagnosis, the constraint that rules out the obvious "run it as LocalSystem" fix, and a ranked set of mechanisms that *do* work here.

---

## 1. The diagnosis

### 1.1 What the error code means

`0x8007052E` is `HRESULT_FROM_WIN32(1326)` = `ERROR_LOGON_FAILURE`. Task Scheduler returns it from `LogonUser(..., LOGON32_LOGON_BATCH, ...)` when it tries to validate the credentials you would have it store. It is a *logon-type* failure surfaced as a *credential* failure, which is why it reads as "wrong password" when the password is fine.

### 1.2 What this machine actually is

Measured on the box, 2026-09-11:

| Probe | Value | Why it matters |
| --- | --- | --- |
| `whoami` | `redmond\charlesyin` | The principal Windows knows. **Not** `AzureAD\charlesyin@microsoft.com`. |
| `whoami /user` SID | `S-1-12-1-1368048135-1282688193-253369779-3463193993` | **`S-1-12-1` is the Entra ID (Azure AD) authority.** An on-prem AD account would be `S-1-5-21-…`. This is a *cloud* account. |
| `dsregcmd /status` | `AzureAdJoined: YES`, `DomainJoined: NO`, `EnterpriseJoined: NO` | Entra-joined, **not** domain-joined. |
| | `AzureAdPrt: YES`, `WamDefaultSet: YES` | Sign-in flows through the Cloud AP provider and yields a PRT. |
| | `NgcSet: NO` | Windows Hello for Business is *not* provisioned — so "it's a PIN, not a password" is **not** the explanation here. |
| `nltest /dsgetdc:redmond…` | `CO1-RED-DC-57` reachable | A DC is reachable, so "cannot reach a domain controller" is **not** the explanation either. |
| Elevation | `IsInRole(Administrator)` → **False**; `BUILTIN\Administrators` shown as *"Group used for deny only"* | The shell you ran the installer from was **not elevated**. |

### 1.3 Two independent reasons it failed

**Reason 1 — the principal string names nobody.**
The installer prompted for `AzureAD\charlesyin@microsoft.com`. The account Windows has is `redmond\charlesyin`. On an Entra-joined device the `AzureAD\` prefix is how *Entra-native* accounts are addressed, but this session's principal presents under the `redmond` domain name while carrying an Entra SID. Handing Task Scheduler a principal string that does not resolve produces exactly `1326` — indistinguishable from a bad password.

> **Design consequence:** never ask a human to type the account name. Read the SID from the live token (`whoami /user`) and **register the task principal by SID**. A SID is unambiguous and sidesteps the entire `AzureAD\` vs `redmond\` vs UPN naming problem.

**Reason 2 — Entra cloud accounts cannot do password batch logon.**
Interactive sign-in on an Entra-joined device is serviced by the Cloud AP provider and produces a PRT. Task Scheduler's *"run whether user is logged on or not, store the password"* mode does not use that path — it calls `LogonUser` with `LOGON32_LOGON_BATCH`, which is serviced by MSV1_0/Kerberos. There is no password-derived credential those packages can validate for a cloud account, so the answer is `1326` **whether or not the password typed was correct**. Tenant Conditional Access / MFA makes the outcome doubly certain.

> **Design consequence:** the "type your password" flow should not exist on an account whose SID starts `S-1-12-1`. The installer should detect it and say so, rather than prompting for a secret it knows cannot work.

**Reason 3 (latent) — no elevation.** Registering a task with a stored password, or with S4U, or granting `SeBatchLogonRight`, requires an elevated token. You did not have one. Even with a working credential this would have blocked at a later step, with a *different* error (`0x80070005`) that the script also does not currently explain.

### 1.4 The 30-second experiment that confirms it

Run in an **elevated** shell. If this fails identically, the cause is the platform, not the fleet script:

```powershell
# Expect the same 0x8007052E. If so: password batch logon is unavailable, full stop.
schtasks /Create /TN ProbeBatchLogon /SC ONCE /ST 23:59 `
  /TR "cmd /c exit 0" /RU "redmond\charlesyin" /RP "<password>"
schtasks /Delete /TN ProbeBatchLogon /F 2>$null
```

---

## 2. The constraint that rules out a "real" Windows service

The instinctive fix for "no password" is a Windows service running as `LocalSystem` — no credentials needed, starts before anyone logs on. **For the Node this cannot work**, because the Node is bound to the interactive user's profile in at least five independent ways. Measured on this machine:

| Dependency | Actual location | What `LocalSystem` gets instead |
| --- | --- | --- |
| **Node identity** — the only copy of the private key | `%APPDATA%\CopilotFleet\node.json` (556 B, mode `0600`) | `C:\Windows\System32\config\systemprofile\AppData\Roaming\…` — empty. The Node finds no identity, tries to re-enroll, needs a one-time grant, and fails. |
| **Copilot CLI auth + state** | `~/.copilot/` — `config.json`, `data.db`, `session-store.db`, `m-encryption-key.enc` | A different profile. Re-authenticating as SYSTEM means an interactive device-code login *as SYSTEM*, which is not a thing you can reasonably do. |
| **`copilot.exe`** | `C:\Users\charlesyin\AppData\Local\Microsoft\WinGet\Links\copilot.EXE` | **User-scoped PATH.** SYSTEM cannot see it. |
| **`devtunnel.exe`** | same WinGet Links directory | same |
| **Git credentials** | Windows Credential Manager (DPAPI, per-user vault) | Not decryptable outside that user's logon session. |
| **Instance lock** | `%APPDATA%\CopilotFleet\node.lock` | Different path ⇒ the "one Node per machine" guarantee silently stops holding. |

**Conclusion: whatever starts the Node must run as `redmond\charlesyin`, with that user's profile loaded.** That collapses the design space to logon types that do not require a stored password.

The **Host** is less constrained — it needs no Copilot auth, only `apps/host/data/fleet.db` and the repo-root `.env` — so it has one extra option the Node does not (see mechanism 5).

---

## 3. The option matrix

| # | Mechanism | Password? | Runs before logon? | Network creds? | DPAPI usable? | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Scheduled Task, `LogonType=Interactive`, trigger **At log on** | **No** | No | Yes (full token) | Yes | **Recommended default** |
| 2 | Scheduled Task, `LogonType=S4U` ("do not store password") | **No** | **Yes** | **No** | **Likely not** | Opt-in, for surviving logoff — must be proven, not assumed |
| 3 | Scheduled Task, stored password *(what was tried)* | Yes | Yes | Yes | Yes | **Impossible on this account** — §1.3 |
| 4 | Windows service as `LocalSystem` (NSSM / WinSW / `sc.exe`) | No | Yes | Machine account | No | **Rejected for Node** — §2 |
| 5 | Windows service as a **dedicated local account** | Yes — a *local* password works | Yes | Local only | Yes (that profile) | Viable for Host, or a dedicated lab box; Node needs a fresh Copilot login as that user |
| 6 | Startup folder shortcut / `HKCU\…\Run` | No | No | Yes | Yes | Simplest possible; no restart-on-crash, no logging, no control surface |
| 7 | Auto-logon (`AutoAdminLogon`) + mechanism 1 | No | Effectively yes | Yes | Yes | Dedicated kiosk box only; stores a password in LSA/registry and is very likely blocked by Intune policy |

### On mechanism 2 (S4U) — the tradeoff to take seriously

S4U ("Service for User") lets Task Scheduler construct a token for the account **without a password**, which is exactly why it survives where mechanism 3 dies. But the token it produces is identity-only: it carries **no network credentials**, and it is not derived from the user's password.

Two concrete consequences for this codebase:

- **Anything reaching a network resource as you** — SMB, Kerberos SSO — fails. Probably irrelevant here (Host is loopback, git is HTTPS).
- **DPAPI may not unwrap the user's master key**, which would break Git Credential Manager and possibly `~/.copilot`'s `m-encryption-key.enc`. This is the failure mode that does *not* show up at install time — it shows up a day later as a Copilot session that cannot authenticate.

So S4U is worth offering, but only behind an explicit **proof** step (§4.6), never as a silent default.

---

## 4. Recommended design: a two-tier installer with a real preflight

The script that failed had one structural flaw beyond the wrong principal: it **asked for a credential first and diagnosed afterwards**. Invert that.

### 4.1 Tier 1 — `--at-logon` (default)

Scheduled Task, principal **by SID**, `LogonType = Interactive`, trigger `AtLogOn` for that SID.

```powershell
# Illustrative only — for review, not to run as-is.
$sid       = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
                                     -Argument "apps\node\supervisor.mjs" `
                                     -WorkingDirectory "Q:\Repos\copilot-fleet"
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $sid
$settings  = New-ScheduledTaskSettingsSet `
               -MultipleInstances IgnoreNew `
               -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -StartWhenAvailable
Register-ScheduledTask -TaskName CopilotFleetNode `
  -Principal $principal -Action $action -Trigger $trigger -Settings $settings
```

Why each setting is load-bearing:

| Setting | Reason |
| --- | --- |
| `-UserId $sid` | Sidesteps `AzureAD\` vs `redmond\` naming entirely — §1.3 Reason 1 |
| `LogonType Interactive` | No password is requested, so §1.3 Reason 2 never applies |
| `ExecutionTimeLimit = 0` | Default is 3 days; the Node would be killed on day three |
| `MultipleInstances IgnoreNew` | Your `npm run dev` Node already holds `node.lock`; a second instance would exit with "Another fleet node is already running" |
| `RestartCount/RestartInterval` | **`supervisor.mjs` deliberately declines crash recovery** — its own comment says *"crash recovery belongs to PM2 or a service manager"*. The task must supply it. |
| `StartWhenAvailable` | Catches a missed trigger after a suspend/resume |

**Trade-off, stated plainly:** this runs at *logon*, not at *boot*. After a reboot the Node starts when you sign in. For a workstation you sign into anyway, that is usually the right answer; if you must survive a signed-out reboot, go to Tier 2.

### 4.2 Tier 2 — `--logged-off` (opt-in)

Identical, but `-LogonType S4U`, plus a trigger on `AtStartup` as well as `AtLogOn`. Requires elevation to register and requires `SeBatchLogonRight` on the account. Gate it behind the proof in §4.6 and print the network-credential/DPAPI caveat at install time.

### 4.3 Never offer Tier 3

If the SID starts `S-1-12-1`, the installer must **not** prompt for a password. It should print the diagnosis and the two working alternatives.

### 4.4 Preflight, before anything is written

1. **Account class** — read the SID, branch on `S-1-12-1` (Entra) vs `S-1-5-21` (AD/local).
2. **Elevation** — check `IsInRole(Administrator)` and name the operations that need it, rather than failing mid-way.
3. **`SeBatchLogonRight`** — probe via `secedit /export /areas USER_RIGHTS` (needs elevation); if absent and Tier 2 was requested, offer to grant it or fall back to Tier 1.
4. **Resolve every dependency to an absolute path** — `node`, `git`, `copilot`, `devtunnel`. A Scheduled Task does **not** inherit your shell's PATH, and on this machine `copilot.EXE` and `devtunnel.exe` live in a *user-scoped* WinGet Links directory. Bake absolute paths into the action and/or set `FLEET_COPILOT_COMMAND` explicitly.
5. **Conflict check** — is `node.lock` currently held? Is a dev Node running? Say so before registering something that will fight it.

### 4.5 Error-message contract

Map the HRESULT to an action instead of echoing Windows:

| Code | Meaning | Message to print |
| --- | --- | --- |
| `0x8007052E` (1326) | `ERROR_LOGON_FAILURE` | "This is an Entra ID cloud account (SID `S-1-12-1-…`). Windows cannot perform a password *batch* logon for it. Use `--at-logon`, or `--logged-off` for S4U." |
| `0x80070569` (1385) | `ERROR_LOGON_TYPE_NOT_GRANTED` | "The account lacks *Log on as a batch job*. Grant it, or use `--at-logon`." |
| `0x80070005` | `E_ACCESSDENIED` | "Re-run from an elevated PowerShell." |
| `0x41303` | Task never ran | "Registered but not yet triggered — sign out and back in, or `schtasks /Run`." |
| `0x1` / `0x2` from the action | Bad path | "Could not launch `<exe>`. Task PATH differs from your shell's; use an absolute path." |

### 4.6 Prove it before committing to it

Register a throwaway task with the *same principal and logon type*, whose action is a probe, and assert the output before registering the real one:

```powershell
# Probe action — must print redmond\charlesyin and C:\Users\charlesyin\AppData\Roaming
whoami > "$env:TEMP\fleet-probe.txt"
node -e "console.log(process.env.APPDATA)" >> "$env:TEMP\fleet-probe.txt"
node -e "console.log(require('fs').existsSync(process.env.APPDATA+'\\CopilotFleet\\node.json'))" >> "$env:TEMP\fleet-probe.txt"
```

For Tier 2 specifically, extend the probe to touch DPAPI (`git credential fill`, or a Copilot no-op) — that is the only way to find out whether S4U actually works here rather than discovering it a day later.

---

## 5. How this interacts with what already exists

- **`supervisor.mjs` is already the right shape.** It sets `FLEET_RESTART_MODE=exit`, waits for exit code `75`, and restarts the child in place. A self-update therefore never touches the task: node exits 75 → supervisor relaunches → the task sees one continuously-running process. **The task's action should be `supervisor.mjs`, not `dist/main.js`.**
- **`supervisor.mjs` explicitly declines crash recovery** (`updater.ts:21` names PM2/NSSM/systemd; the supervisor comment says the same). The task's `RestartCount/RestartInterval` is what fills that hole. Do not add a retry loop to the supervisor.
- **Instance lock is the collision point.** `acquireInstanceLock` (`instance-lock.ts:20`) rejects a second Node. Document a "dev mode wins" rule: `fleet-service stop` before `npm run dev`, and have the installer detect a live lock.
- **`--existing-node` is the right flag** and should stay the default: `%APPDATA%\CopilotFleet\node.json` already holds a keyed identity, so no clone and no enrollment grant are needed. The failure you hit was purely the logon type, not the identity model.
- **Tunnel convergence.** The companion doc (`2026-09-11-detached-tunnel-lifecycle.md`, Approach C) needs the *same* Scheduled Task machinery — and on Windows a Scheduled Task is also the most reliable way to escape a terminal's Job Object. Build the task helper once, use it for tunnel, Node and Host.

### Host-specific notes

The Host is easier: no Copilot auth, no user-bound agent state. It needs `Q:\Repos\copilot-fleet\.env`, `apps/host/data/fleet.db`, and port 8787. That makes mechanism 5 (a dedicated local service account) genuinely viable for the Host, which would give it true pre-logon boot start. Worth considering **only** if you want the Host reachable through the tunnel while nobody is signed in — otherwise Tier 1 is simpler and keeps one mental model for both.

---

## 6. Phasing

| Phase | Work | Outcome |
| --- | --- | --- |
| **P0** | Register **by SID**; default to Tier 1 (`--at-logon`); absolute-path resolution for `node`/`copilot`; the `ExecutionTimeLimit=0` + `MultipleInstances` + restart settings | Node comes back after every reboot-and-sign-in. Fixes your blocker. |
| **P1** | Preflight + the error-message contract + the probe task | The installer explains itself instead of surfacing raw HRESULTs |
| **P2** | `--logged-off` (S4U) behind the DPAPI/network-credential proof | Survives a signed-out reboot, with eyes open |
| **P3** | Same helper for Host and tunnel; `fleet-service status/start/stop/logs` | One command surface for all three processes |
| **P4** | macOS/Linux parity (appendix) | Cross-platform fleet |

## 7. Open questions

1. Is *"starts when I sign in"* (Tier 1) actually sufficient for your reboot-test loop, or do you genuinely need signed-out operation? This decides whether P2 matters at all.
2. Should the Host use a dedicated local service account (true pre-logon boot) even though the Node cannot?
3. Where should task logs go — `apps/host/data/logs/` (wiped by `git clean`) or `%LOCALAPPDATA%\CopilotFleet\logs\`?
4. Is Intune policy going to block `SeBatchLogonRight` on corporate devices? If so, Tier 1 is the *only* option on managed hardware and P2 is wasted effort.
5. `Q:` is a Dev Drive — confirm it is a fixed volume present at boot, not a mount that appears late. If it appears late, the task needs `StartWhenAvailable` plus a retry, or the working directory must move.

---

## Appendix A — non-Windows equivalents

**macOS — LaunchAgent** (`~/Library/LaunchAgents/com.copilotfleet.node.plist`). `RunAtLoad=true`, `KeepAlive=true`. Runs as the user with the full profile; the direct analogue of Tier 1. A *LaunchDaemon* would be the LocalSystem analogue and is rejected for the same reasons as §2.

**Linux — `systemd --user`** unit plus `loginctl enable-linger <user>`. Lingering is the piece that makes it the analogue of **Tier 2**: the unit starts at boot and survives logout, while still running as the user with the real `$HOME` — which is precisely what Windows S4U is trying and only partly managing to do.

## Appendix B — measured environment, 2026-09-11

```
whoami                 redmond\charlesyin
SID                    S-1-12-1-1368048135-1282688193-253369779-3463193993   (Entra ID authority)
AzureAdJoined          YES        DomainJoined NO        EnterpriseJoined NO
NgcSet                 NO         AzureAdPrt   YES       WamDefaultSet    YES
Tenant                 Microsoft (72f988bf-86f1-41af-91ab-2d7cd011db47)
Elevated               False      (BUILTIN\Administrators = "deny only")
DC reachable           CO1-RED-DC-57.redmond.corp.microsoft.com
CopilotFleet tasks     none registered
node                   C:\Program Files\nodejs\node.exe
git                    C:\Program Files\Git\cmd\git.exe
copilot                C:\Users\charlesyin\AppData\Local\Microsoft\WinGet\Links\copilot.EXE   <- user-scoped
devtunnel              C:\Users\charlesyin\AppData\Local\Microsoft\WinGet\Links\devtunnel.exe <- user-scoped
cloudflared            C:\Program Files (x86)\cloudflared\cloudflared.exe
bore / tailscale       not installed
Node identity          %APPDATA%\CopilotFleet\node.json (556 B) + node.lock (held)
```
