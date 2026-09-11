# Boot-persistent Host and Node: reviewed startup options

**Date:** 2026-09-11
**Status:** Brainstorm reviewed against the current implementation; the original two-tier proposal below is not the selected Windows default.
**Scope:** Unattended restart after reboot, without relying on the operator's Windows password or an interactive sign-in.

## Review outcome — 2026-09-11

Keep the implemented **LocalService boot mode** for the Node. Changing the default
to an interactive logon task would not satisfy the requested signed-out reboot
behavior. Do not introduce S4U, auto-logon, a new Windows account, or policy changes
as a fallback.

There is now direct evidence that a password-free service can run on this VM:
`CopilotFleetPm2Probe` was registered through normal UAC elevation, reports
`Running` / `Auto` / `NT AUTHORITY\LocalService`, and its PM2 child produced
advancing heartbeats with SID `S-1-5-19` after the installer exited. This proves
native service execution, **not** a completed reboot test or Fleet/Copilot
authentication. The production Node installer uses Task Scheduler's
`TASK_LOGON_SERVICE_ACCOUNT`, with its own task-context probe and auth preparation.

The profile constraints in section 2 are real but not an absolute ban on a
different service identity. The implementation shares the exact Node
identity/settings/lock leaf through `FLEET_NODE_CONFIG_DIR`, isolates the runtime
profile, and consumes an explicitly provisioned ACL-protected GitHub token file.
It does not decrypt or copy the human user's Copilot/gh vault or migrate their
Copilot session store and MCP customizations.

Accepted improvements from this review:

- Retain SID-based identity checks, absolute executable paths, an early live-lock
  check, native execution proof before credential import, and full `gh`/Copilot
  auth preparation before enabling boot startup.
- Run Windows scheduled-task workloads through the existing
  `apps/node/supervisor.mjs`. It handles planned exit-75 updates immediately;
  Task Scheduler remains responsible for boot and bounded crash recovery.
  This avoids consuming crash retries or waiting at least one minute per update.
  Unix native-manager behavior remains unchanged.
- Distinguish action-process exit codes from Windows HRESULTs. A bare exit `1`,
  `2`, `10`, or `11` is not proof of a Windows path or logon failure.
- Preserve upstream's session-retention capability in the shared Node/service
  capability list when rebasing this feature.

The recent `Refusing a filesystem ... access grant: Q:\Repos\copilot-fleet`
failure was also an installer bug, not a policy result: trimming `Q:\` to `Q:`
made .NET resolve the drive-relative path as the current checkout. The guard now
retains absolute roots and still rejects actual drive roots and credential-store
scopes.

Host service installation and shared tunnel lifecycle machinery remain separate
follow-ups; the Node work does not change the running Host, private tunnel access,
or the user's authentication stores.

## The question this answers

> I want Host/Node registered as a system service that boots automatically on reboot. The password logon approach does not work:
>
> ```
> Task 'CopilotFleetNode' registration failed.
> HRESULT=0x8007052E: The user name or password is incorrect.
> LastTaskResult=0x8007052E (2147943726); Win32 error 1326
> ```

Windows rejected the supplied credentials for that requested logon. The error
alone does not establish whether the cause was the password, account resolution,
authentication-provider support, or device/tenant policy. Repeatedly prompting
for the same secret is not a useful recovery strategy; the selected path no
longer requests a Windows account password.

---

## 1. The diagnosis

### 1.1 What the error code means

`0x8007052E` is `HRESULT_FROM_WIN32(1326)` = `ERROR_LOGON_FAILURE`. It reports
rejected logon credentials, not a uniquely identified root cause. It does not
prove that the password is correct or that every password batch logon for every
Entra-backed account is unsupported.

### 1.2 What this machine actually is

Measured on the box, 2026-09-11:

| Probe | Value | Why it matters |
| --- | --- | --- |
| `whoami` | `redmond\charlesyin` | Display name of the current token, not proof that another account alias cannot resolve to its SID. |
| `whoami /user` SID | `S-1-12-1-1368048135-1282688193-253369779-3463193993` | **`S-1-12-1` is the Entra ID (Azure AD) authority.** An on-prem AD account would be `S-1-5-21-…`. This is a *cloud* account. |
| `dsregcmd /status` | `AzureAdJoined: YES`, `DomainJoined: NO`, `EnterpriseJoined: NO` | Entra-joined, **not** domain-joined. |
| | `AzureAdPrt: YES`, `WamDefaultSet: YES` | Sign-in flows through the Cloud AP provider and yields a PRT. |
| | `NgcSet: NO` | Windows Hello for Business is *not* provisioned — so "it's a PIN, not a password" is **not** the explanation here. |
| `nltest /dsgetdc:redmond…` | `CO1-RED-DC-57` reachable | Reachability in this probe does not establish domain membership or a usable domain logon in another context. |
| Elevation | `IsInRole(Administrator)` → **False**; `BUILTIN\Administrators` shown as *"Group used for deny only"* | This measured shell was not elevated; it does not establish the token of a separate installer invocation. |

### 1.3 What the evidence does and does not establish

**Account aliases:** `AzureAD\charlesyin@microsoft.com` was checked again during
this review and resolves to the **same SID** as the current `redmond\charlesyin`
token. The earlier installer also checked SID equality before using that alias.
Therefore "the principal string names nobody" is not supported by the evidence.
Successful SID resolution does not, by itself, prove password-based service or
batch logon will work.

> **Design consequence:** never ask a human to type the account name. Read the SID from the live token (`whoami /user`) and **register the task principal by SID**. A SID is unambiguous and sidesteps the entire `AzureAD\` vs `redmond\` vs UPN naming problem.

**Logon support:** interactive sign-in and noninteractive password logon are
different capabilities. The attempted personal-account service and task logons
failed on this machine. That is sufficient reason to retire this installer's
password path, but not to infer a universal rule from an SID prefix or claim to
have identified a particular Conditional Access policy.

> **Design consequence:** the selected LocalService flow never requests the
> operator's Windows password and does not retry personal logon under another alias.

**Elevation:** the current controller requires an elevated human token before
installation and lifecycle changes. Its account prompt was after that check, so
an unrelated non-elevated probe is not evidence that the user's failed invocation
was unelevated. During this review, the agent's ordinary token was denied SCM
create-service access; normal UAC elevation subsequently installed the
LocalService PM2 probe successfully.

### 1.4 Prefer a credential-free execution probe

Do not put a Windows password in a `schtasks /RP` command line or repeat that
experiment as if a second `1326` would uniquely diagnose the platform. On this
machine the isolated probe can be inspected without authentication changes:

```powershell
Get-CimInstance Win32_Service -Filter "Name='CopilotFleetPm2Probe'" |
  Select-Object Name, State, StartMode, StartName
```

---

## 2. What a different Windows service identity does not inherit

Simply launching the existing Node as `LocalSystem` is not a valid migration:
it is unnecessarily privileged and does not inherit the interactive user's
profile or authentication. The original dependencies were:

| Dependency | Actual location | What `LocalSystem` gets instead |
| --- | --- | --- |
| **Node identity** — the only copy of the private key | `%APPDATA%\CopilotFleet\node.json` (556 B, mode `0600`) | `C:\Windows\System32\config\systemprofile\AppData\Roaming\…` — empty. The Node finds no identity, tries to re-enroll, needs a one-time grant, and fails. |
| **Copilot CLI auth + state** | `~/.copilot/` — `config.json`, `data.db`, `session-store.db`, `m-encryption-key.enc` | A different profile. Re-authenticating as SYSTEM means an interactive device-code login *as SYSTEM*, which is not a thing you can reasonably do. |
| **`copilot.exe`** | `C:\Users\charlesyin\AppData\Local\Microsoft\WinGet\Links\copilot.EXE` | Not discoverable through that user's PATH; resolve an accessible absolute path or provision a managed executable. |
| **`devtunnel.exe`** | same WinGet Links directory | same |
| **Git credentials** | Windows Credential Manager (DPAPI, per-user vault) | Not decryptable outside that user's logon session. |
| **Instance lock** | `%APPDATA%\CopilotFleet\node.lock` | Different config paths would bypass the lock for the same Node identity; share the exact config/lock leaf. |

**Conclusion:** retaining the original user's vault and Copilot session profile
requires a compatible user logon context. It is also possible to use
**LocalService with explicit credentials and profile/configuration separation**,
accepting that the original vault and native Copilot session state are not
automatically migrated. This is the implemented before-logon path.

The **Host** does not need Copilot agent authentication, but a service design must
still account for its database, `.env`, keys, and any tunnel-provider credentials.
It is a separate scope, not evidence that a dedicated account is possible only
for Host and impossible for Node.

---

## 3. The option matrix

| # | Mechanism | Password? | Runs before logon? | Network creds? | DPAPI usable? | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Scheduled Task, `LogonType=Interactive`, trigger **At log on** | **No** | No | Yes (full token) | Yes | Alternative when login-time startup is sufficient, not the chosen boot default |
| 2 | Scheduled Task, `LogonType=S4U` ("do not store password") | **No** | Intended | **No** | Not guaranteed; encrypted-file access is unsupported | Not adopted; a warm-session probe is not cold-boot proof |
| 3 | Scheduled Task, stored password *(what was tried)* | Yes | Yes | Depends on logon | Depends on logon | Failed here; removed from the new installer |
| 4 | Windows service as `LocalSystem` (NSSM / WinSW / `sc.exe`) | No | Yes | Machine account | Not the human vault | Rejected default: excessive privilege and different profile |
| 5 | Windows service as a **dedicated local account** | Yes — a *local* password works | Yes | Local only | Yes (that profile) | Viable for Host, or a dedicated lab box; Node needs a fresh Copilot login as that user |
| 6 | Startup folder shortcut / `HKCU\…\Run` | No | No | Yes | Yes | Simplest possible; no restart-on-crash, no logging, no control surface |
| 7 | Auto-logon (`AutoAdminLogon`) + mechanism 1 | No | Effectively yes | Yes | Yes | Dedicated kiosk box only; stores a password in LSA/registry and is very likely blocked by Intune policy |
| 8 | LocalService startup task or Windows service | No Windows password; explicit app tokens | Yes by design | No personal Windows credentials; HTTPS app tokens are separate | Own profile, not the human vault | Selected Node boot mode; native service execution demonstrated |

### On mechanism 2 (S4U) — the tradeoff to take seriously

S4U ("Service for User") requests a noninteractive logon without a stored
password. It must not be assumed to work for this account merely because another
logon type failed. Microsoft documents no network or encrypted-file access for
`TASK_LOGON_S4U`.

Two concrete consequences for this codebase:

- **Anything reaching a network resource as you** — SMB, Kerberos SSO — fails. Probably irrelevant here (Host is loopback, git is HTTPS).
- **DPAPI may not unwrap the user's master key**, which would break Git Credential Manager and possibly `~/.copilot`'s `m-encryption-key.enc`. This is the failure mode that does *not* show up at install time — it shows up a day later as a Copilot session that cannot authenticate.

S4U is not offered by the current installer. Even a successful probe while the
user is signed in would not establish that their cached DPAPI/keychain state is
available after a cold signed-out boot.

---

## 4. Original alternative: a two-tier user-logon installer

The useful principle is to prove the execution context before importing
credentials. The implementation already does this for LocalService. The
`--at-logon` / `--logged-off` flags below remain proposals, **not implemented CLI
options or the selected default**.

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

**Trade-off, stated plainly:** this runs at *logon*, not at *boot*. After a reboot
the Node starts when you sign in. That can be useful for a workstation, but the
current signed-out requirement is served by LocalService, not this tier.

### 4.2 Tier 2 — `--logged-off` (opt-in)

Identical, but `-LogonType S4U`, plus a trigger on `AtStartup` as well as `AtLogOn`. Requires elevation to register and requires `SeBatchLogonRight` on the account. Gate it behind the proof in §4.6 and print the network-credential/DPAPI caveat at install time.

### 4.3 Never offer Tier 3

The selected installer does not prompt for a personal Windows password. It
explains the LocalService execution context instead of presenting S4U as an
already-proven alternative.

### 4.4 Preflight, before anything is written

1. **Account class** — read the SID, branch on `S-1-12-1` (Entra) vs `S-1-5-21` (AD/local).
2. **Elevation** — check `IsInRole(Administrator)` and name the operations that need it, rather than failing mid-way.
3. **Logon rights** — explain a native rights/policy failure if encountered. The implemented LocalService installer does not grant rights, change GPO, or fall back to another identity. A future S4U design would need its own explicit policy decision.
4. **Resolve every dependency to an absolute path** — `node`, `git`, `copilot`, `devtunnel`. A Scheduled Task does **not** inherit your shell's PATH, and on this machine `copilot.EXE` and `devtunnel.exe` live in a *user-scoped* WinGet Links directory. Bake absolute paths into the action and/or set `FLEET_COPILOT_COMMAND` explicitly.
5. **Conflict check** — is `node.lock` currently held? Is a dev Node running? Say so before registering something that will fight it.

### 4.5 Error-message contract

Map the HRESULT to an action instead of echoing Windows:

| Code | Meaning | Message to print |
| --- | --- | --- |
| `0x8007052E` (1326) | `ERROR_LOGON_FAILURE` | "Windows rejected this logon. Do not infer a bad password or unsupported provider from this code alone; the current installer uses LocalService without a Windows password." |
| `0x80070569` (1385) | `ERROR_LOGON_TYPE_NOT_GRANTED` | "The account lacks *Log on as a batch job*. Grant it, or use `--at-logon`." |
| `0x80070005` | `E_ACCESSDENIED` | "Re-run from an elevated PowerShell." |
| `0x41303` | Task never ran | "Registered but not yet triggered — sign out and back in, or `schtasks /Run`." |
| Bare `0x1` / `0x2` from the action | Application exit code | "Inspect the action log. This is not, by itself, a Win32 path or logon error." |

### 4.6 Prove it before committing to it

Register a throwaway task with the *same principal and logon type*, whose action is a probe, and assert the output before registering the real one:

```powershell
# Probe action — must print redmond\charlesyin and C:\Users\charlesyin\AppData\Roaming
whoami > "$env:TEMP\fleet-probe.txt"
node -e "console.log(process.env.APPDATA)" >> "$env:TEMP\fleet-probe.txt"
node -e "console.log(require('fs').existsSync(process.env.APPDATA+'\\CopilotFleet\\node.json'))" >> "$env:TEMP\fleet-probe.txt"
```

That illustrative probe proves only identity/profile visibility. It does not
prove GitHub or Copilot authentication. Do not log `git credential fill`, which
can print credential material, or rely on an ACP initialize/no-op response.
The implemented auth gate uses `gh auth status --active` and the Copilot SDK's
`auth.getStatus`, under the actual task identity, without sending a model prompt.

---

## 5. How this interacts with what already exists

- **`supervisor.mjs` is already the right shape for Windows scheduled tasks.** It handles exit `75` inside the task. The task action remains the managed runner, which establishes the kill-on-close job and launches the supervisor. Custom PM2/NSSM and the existing Unix native managers can continue supervising `dist/main.js` directly.
- **`supervisor.mjs` explicitly declines crash recovery** (`updater.ts:21` names PM2/NSSM/systemd; the supervisor comment says the same). The task's `RestartCount/RestartInterval` is what fills that hole. Do not add a retry loop to the supervisor.
- **Instance lock is the collision point.** `acquireInstanceLock` (`instance-lock.ts:20`) rejects a second Node. Document a "dev mode wins" rule: `fleet-service stop` before `npm run dev`, and have the installer detect a live lock.
- **`--existing-node` is the right explicit conversion flag**: reuse the stored keyed identity without a clone or new enrollment grant. It is not silently made the default for fresh-VM enrollment. The observed failures did not require replacing the Node's identity.
- **Tunnel convergence.** The companion doc (`2026-09-11-detached-tunnel-lifecycle.md`, Approach C) needs the *same* Scheduled Task machinery — and on Windows a Scheduled Task is also the most reliable way to escape a terminal's Job Object. Build the task helper once, use it for tunnel, Node and Host.

### Host-specific notes

The Host is easier: no Copilot auth, no user-bound agent state. It needs `Q:\Repos\copilot-fleet\.env`, `apps/host/data/fleet.db`, and port 8787. That makes mechanism 5 (a dedicated local service account) genuinely viable for the Host, which would give it true pre-logon boot start. Worth considering **only** if you want the Host reachable through the tunnel while nobody is signed in — otherwise Tier 1 is simpler and keeps one mental model for both.

---

## 6. Original alternative phasing — not the selected implementation plan

| Phase | Work | Outcome |
| --- | --- | --- |
| **P0** | Register **by SID**; default to Tier 1 (`--at-logon`); absolute-path resolution for `node`/`copilot`; the `ExecutionTimeLimit=0` + `MultipleInstances` + restart settings | Covers login-time recovery, not the current signed-out reboot requirement. |
| **P1** | Preflight + the error-message contract + the probe task | The installer explains itself instead of surfacing raw HRESULTs |
| **P2** | `--logged-off` (S4U) behind the DPAPI/network-credential proof | Survives a signed-out reboot, with eyes open |
| **P3** | Same helper for Host and tunnel; `fleet-service status/start/stop/logs` | One command surface for all three processes |
| **P4** | macOS/Linux parity (appendix) | Cross-platform fleet |

## 7. Open questions

1. Signed-out operation is the current requirement; logon-only startup is not the selected default.
2. Should a separate Host service be added later, with explicit database, configuration, and credential ownership?
3. Where should task logs go — `apps/host/data/logs/` (wiped by `git clean`) or `%LOCALAPPDATA%\CopilotFleet\logs\`?
4. Which device policies apply to each execution context? Do not infer that logon-only startup is the only option: LocalService native service execution has now succeeded on this device.
5. `Q:` is a Dev Drive — confirm it is a fixed volume present at boot, not a mount that appears late. If it appears late, the task needs `StartWhenAvailable` plus a retry, or the working directory must move.

---

## Appendix A — non-Windows equivalents

**macOS — LaunchAgent** (`~/Library/LaunchAgents/com.copilotfleet.node.plist`) is
the login-time analogue of Tier 1. A LaunchDaemon is not necessarily a root
process: the existing boot backend specifies the non-root user and requires a
protected headless credential file and direct Host connectivity.

**Linux — `systemd --user`** normally follows the user's login lifecycle.
Lingering can keep a user manager running across logout, but does not unlock a
login keyring. The implemented explicit boot mode uses a system unit running as
the non-root Node user with a protected credential file; it does not equate HOME
visibility with usable unattended authentication.

References: [Microsoft task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type),
[LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account).

## Appendix B — measured environment, 2026-09-11

Historical snapshot, before the successful LocalService service probe. It is not
a current inventory or proof of the token used by another shell.

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
