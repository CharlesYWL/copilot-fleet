# Windows boot persistence: failed attempts and fresh-agent handoff

**Date:** 2026-09-11, UTC+08:00  
**Status:** Implementation paused at the user's request. This is an evidence record, not approval to resume a particular design.  
**Requested destination:** `Q:\Repos\copilot-fleet\docs\superpowers\specs\`

## 1. Bottom line

**A reboot-persistent, authenticated, real Fleet Node has not been demonstrated
end to end.** Do not interpret the amount of installer code, passing unit tests,
or the PM2 experiment as proof that this goal was completed.

What has been demonstrated is narrower: an isolated **WinSW + PM2 heartbeat
Windows service** runs as `NT AUTHORITY\LocalService`, with automatic startup
configured. It does not run Fleet, use GitHub/Copilot credentials, enroll a Node,
or prove startup after an actual reboot. No reboot test was performed.

The latest real Fleet attempt successfully registered a temporary LocalService
Scheduled Task, but failed in **our ownership-validation code** before that task
ran. Windows omitted the default `RunLevel` XML element; our code required the
element to exist. A tentative patch is uncommitted and unvalidated. The user
stopped work before its new native validation script was run.

## 2. User requirements and the unresolved trade-off

The original request was to recover a Node after VM/Windows Update reboots,
without someone noticing an offline Node and manually starting it.

- Prefer one command to install/build/configure/start an existing or new Node.
- Preserve an existing Node's identity, Host association, settings, and instance
  lock; do not enroll a replacement merely because startup fails.
- Preserve manual `npm run build` / `npm run start:node` usage.
- Provide status/start/stop/restart/uninstall management.
- Support an existing checkout, specifically `Q:\Repos\copilot-fleet`.
- Eventually support Windows, Linux, and macOS.
- The user expected existing `gh` and Copilot sign-in to remain usable and has
  questioned why a separate `fleet-credentials.env` is necessary.
- The important distinction is **before interactive login** versus **after the
  user logs in**. Do not silently substitute the latter for the former.

These are separate decisions: startup mechanism, Windows identity, application
credential source, and filesystem/profile access. PM2 or an EXE wrapper does not
automatically solve the other three.

## 3. Attempts and actual outcomes

| Attempt | What was tried | Observed result | What can actually be concluded |
| --- | --- | --- | --- |
| Initial Windows service | WinSW/SCM service under the existing human Windows account | Installation and logon failures described below | The personal-account route did not produce a working Fleet service here. This does not prove Windows services are generally blocked. |
| Credential dialog repair | Replaced `Get-Credential`, which returned an opaque marshaled credential identifier, with a secure console prompt for the current account | The account-resolution failure was bypassed; later startup still failed | This repaired an installer interaction bug, not noninteractive logon support. No credential values are reproduced in this handoff. |
| Git helper retry repair | Replaced repeated GitHub helper entries using repository-local `git config --replace-all`, then `--add` | Fixed `cannot overwrite multiple values with a single value` on retry | This was an idempotency bug in our setup code, unrelated to Windows policy. |
| SCM startup diagnostics | Exposed nested native startup errors instead of only `Cannot start service` | Win32 **1068**, dependency service/group failed | A dependency failure was real. The evidence did not justify changing unrelated services or assuming a bad password. |
| Entra-qualified account alias | Changed `REDMOND\charlesyin` to `AzureAD\charlesyin@microsoft.com`, after checking SID equality | The alias resolved to the same SID, but SCM startup still failed with **1068** | Name normalization was not a solution to the service-logon failure. |
| Password-based Scheduled Task | Boot-trigger task with password batch logon under the human account | Registration failed with **0x8007052E / Win32 1326** | Windows rejected that logon. The code alone does not establish whether the password, provider support, account policy, or another condition was responsible. |
| LocalService Scheduled Task | Switched to SID **S-1-5-19**, logon type **5**, null password; added isolated profile, explicit app credentials and scoped ACLs | First real attempt rejected `Q:\Repos\copilot-fleet` in our path guard | The failure was our path-normalization bug, not evidence of an OS policy block. |
| Drive-root fix | Stopped trimming `Q:\` into drive-relative `Q:` before comparing forbidden paths | Fix was delivered; the next attempt got as far as native task registration | .NET had resolved `Q:` to the current checkout, so the guard had falsely classified that checkout as a drive root. Actual root exclusions remain necessary. |
| Isolated PM2 experiment | WinSW **2.12.0** launches PM2 **7.0.4** in foreground/runtime mode, which runs only a heartbeat | Native service **Running**, startup **Auto**, account **LocalService**; child SID **S-1-5-19**; heartbeat continued after the installer exited | A password-free native Windows service can execute this workload on this VM. This is not Fleet authentication or reboot proof. |
| Latest real Fleet attempt | `npm run node:service -- install --existing-node --credential-file "C:\private\fleet-credentials.env"` | Failed temporary-probe ownership check: **`The property 'RunLevel' cannot be found on this object`** | Registration itself succeeded. Our code mishandled persisted XML defaults, and its cleanup failed for the same reason. |

### Relevant machine observations

Historical probes showed an Entra-backed human SID (`S-1-12-1-...`),
`AzureAdJoined=YES`, and `DomainJoined=NO`. Both account-name forms above resolve
to the same SID. Do not repeat the earlier claim that the `AzureAD\...` alias
"names nobody."

NETLOGON event **3095** was observed with the original SCM attempts: this machine
is not domain-joined. Netlogon was stopped/manual. We did **not** enable Netlogon,
join a domain, create a Windows user, or change logon-rights/GPO policy.

The agent's ordinary token could not create services: a native
`OpenSCManager(..., SC_MANAGER_CREATE_SERVICE)` access check returned **5 / Access
denied**. Later, the normal Windows UAC flow successfully elevated the isolated
PM2 installer. The ordinary agent token was not proof that the user's separate
installer terminal lacked elevation or that the VM could not register services.

## 4. Latest failure: exact native evidence

The failed probe is:

```text
CopilotFleetNode-probe-5882eadacd8943ddb25dbdc40e0b2931
```

Read-only inspection after the failure returned:

| Field | Observed value |
| --- | --- |
| Task state | **3 / Ready** |
| Last task result | **267011 / 0x00041303**, task has not yet run |
| Native `Definition.Principal.RunLevel` | **0** |
| Native `Definition.Principal.LogonType` | **5 / ServiceAccount** |
| Principal user ID | **S-1-5-19 / LocalService** |
| Persisted `RunLevel` XML element | **Absent** |
| Action | Node executable -> managed runner -> `probe --result ...` |
| Working directory | `Q:\Repos\copilot-fleet` |

The principal XML was:

```xml
<Principal id="FleetUser" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <UserId>S-1-5-19</UserId>
</Principal>
```

The committed `Assert-TaskOwnership` directly accessed `$principal.RunLevel`
under PowerShell strict mode. An in-memory task definition had retained the
explicit element, while a **registered** task did not.

The tentative patch introduces a principal-value reader, interprets an omitted
`RunLevel` as `LeastPrivilege`, and retains rejection of explicit elevated,
invalid, empty, or duplicate values. It also changes test fixtures to model
registered XML normalization. **Those edits have not been tested, committed, or
delivered.** They are a hypothesis for review, not a proven fix.

Do not solve this by deleting ownership checks or taking over every task with a
matching name. Owner SID, principal identity, marker, executable, working
directory, arguments, and probe trigger/recovery restrictions still matter.

## 5. Why the credential file appeared

The human user's sign-in is not equivalent to a LocalService sign-in.

`gh auth login` normally stores its token in the system credential store, with a
plaintext-file fallback in some configurations. Copilot also has user-profile
authentication/state. A different Windows account has a different profile and
cannot be assumed to decrypt or inherit the original user's protected secrets.
Pointing `HOME` or `APPDATA` at the original folders is not a general solution.

The LocalService implementation therefore chose:

- Explicit `GH_TOKEN` or `GITHUB_TOKEN`, and optional separate
  `COPILOT_GITHUB_TOKEN`, supplied by the operator.
- An installed **plaintext** credential file protected by a restrictive NTFS ACL;
  this is **not** an encrypted vault.
- An isolated runtime HOME/COPILOT_HOME/GH_CONFIG_DIR.
- Sharing only the original Node configuration/identity/lock leaf through
  `FLEET_NODE_CONFIG_DIR`.
- Explicit additional workspace access instead of granting the whole user
  profile or an entire drive.

This is a design choice in the current installer, not a universal requirement
of `gh` or Copilot. Manual/current-user startup still uses the user's existing
sign-in. A different design could provision a service-owned credential store,
but that was **not implemented or proven** here.

The original personal Copilot profile, native session stores, and MCP
customizations were not automatically migrated. Host-side history is a separate
thing. Token expiry, organization authorization, private Dev Tunnel
authentication, and cold-boot availability remain separate concerns.

The intended auth gate uses `gh auth status --active` and the Copilot SDK's
`auth.getStatus`. Earlier ACP initialize/authenticate/no-op responses were not
reliable proof of a valid sign-in. Do not print `git credential fill`, export
vault contents, or copy credentials into a handoff log.

## 6. What was proven, and what was not

**Proven within the stated scope**

- Repository-local Git helper repair and repeated installer calls were exercised.
- Argument quoting, Unicode paths, identity/lock reuse, scoped ACL handling and
  data-preserving lifecycle behavior have targeted coverage.
- Real temporary NTFS file/directory ACL operations were exercised.
- Windows job-object tests demonstrated termination of the supervised Node and
  normal descendants when the action runner is killed.
- The existing Node supervisor handled planned exit-75 updates in a real
  temporary process fixture; the Windows task runner now uses it so planned
  updates do not consume Task Scheduler's crash-retry budget.
- The real isolated WinSW/PM2 service was installed and started as LocalService.
- The latest real LocalService Scheduled Task registration succeeded, but its
  action did not run because our ownership check failed.

**Not proven**

- A successful end-to-end installation/start of the **actual Fleet Node** under
  LocalService with working GitHub and Copilot authentication.
- Recovery after an actual reboot before anyone logs in.
- Reuse of the human user's protected GitHub/Copilot sign-in by LocalService.
- Migration/resume of the original native Copilot profile/session state.
- S4U cold-boot authentication, private Dev Tunnel authentication under a service
  identity, or a new dedicated service account.
- Native Linux/macOS service installation on those operating systems.
- The latest uncommitted `RunLevel` patch.

## 7. Where my implementation process failed

1. I built and repeatedly revised a large installer before establishing the
   smallest native account/registration/execution proof on this exact machine.
2. I asked the user to retry successive fixes without sufficiently separating
   local code bugs from Windows logon limitations.
3. Account-name normalization and diagnostic improvements were real changes, but
   did not establish that personal-account unattended logon would work.
4. The path tests did not initially reproduce the user's **current-directory**
   scenario. The mock task tests retained input XML instead of persisted,
   normalized XML. Both omissions let tests pass while real installs failed.
5. The ordinary agent token's lack of elevation was initially treated too much
   like a platform blocker; normal UAC later worked.
6. The PM2 heartbeat proved native service execution only. It was not sufficient
   evidence to claim a working Fleet boot/authentication solution.
7. The switch to LocalService introduced a significant credential/profile
   trade-off. That needs an explicit decision with the user, not an assumption
   that a separate plaintext env file meets their expectation of retaining login.

The next agent should independently reassess the design rather than treating
this branch or my edited proposal as the accepted architecture.

## 8. Runtime state at the pause

Read-only checks made for this handoff showed:

| Resource | State |
| --- | --- |
| Windows service `CopilotFleetPm2Probe` | **Running**, **Auto**, `NT AUTHORITY\LocalService` |
| Its installed directory | `C:\ProgramData\CopilotFleetPm2Probe` |
| Its heartbeat/state directory | `C:\ProgramData\CopilotFleetPm2Probe\data` |
| Its management script | `C:\ProgramData\CopilotFleetPm2Probe\control\probe.ps1` |
| Failed temporary task named in section 4 | Still registered, **Ready**, has not run |
| Real Scheduled Task `CopilotFleetNode` | Not present |
| Legacy Windows service `CopilotFleetNode` | Not present |
| Installed Fleet metadata stage | **`preparing`** |

**No runtime cleanup was performed for this handoff.** "Stopped for now" means
implementation is paused; it does not mean the PM2 diagnostic service was stopped
or that the failed probe was deleted.

Inspection commands:

```powershell
Get-Service -Name CopilotFleetPm2Probe
& "$env:ProgramData\CopilotFleetPm2Probe\control\probe.ps1" status
```

The diagnostic controller supports `stop` and `uninstall`, but the new agent
should not perform cleanup or reboot the VM merely because those operations are
listed here. Any cleanup must be scoped to owned resources and preserve evidence,
user work, and credentials.

## 9. Code and document state

| Location | State at pause |
| --- | --- |
| `Q:\Repos\copilot-fleet` | Branch **`windows-node-service-local`**, HEAD **`91933b7847c603fe1cd270512799c1b82db0d351`** |
| Canonical feature worktree | `C:\Users\charlesyin\.copilot\repos\copilot-worktrees\copilot-fleet\charlesyin-microsoft-reimagined-winner` |
| Canonical branch / committed HEAD | `charlesyin-microsoft-windows-node-service-options` / **`23144c67fe4bee9426145876a24ec9a722653b87`** |
| Rebase base | `origin/main` at **`4fe9b53e2e2b74a995c50b351d8808aa57ad13cc`** |

The committed tips have equivalent tracked content. The current working trees
are **not** identical or clean:

- Canonical worktree: uncommitted tentative edits in
  `scripts\windows-node-service.ps1` and
  `scripts\windows-node-service.test.js` for the `RunLevel` failure.
- Local `Q:` checkout: an existing tracked modification to `package-lock.json`
  was reported. Its contents/attribution were not investigated for this handoff.
  Preserve it.
- Local `Q:` checkout: two pre-existing untracked design notes are preserved:
  `2026-09-11-detached-tunnel-process-approaches.md` and
  `2026-09-11-windows-boot-service-approaches.md`, both in this specs directory.
- This handoff is an additional documentation file. It does not deliver the
  tentative code patch.

Important code:

| File | Purpose |
| --- | --- |
| `scripts\windows-node-service.ps1` | Bootstrap, Task Scheduler XML/registration, ownership checks and lifecycle |
| `scripts\windows-local-service.ps1` | Scoped ACLs, isolated profile, explicit credentials, native probe and preparation |
| `scripts\node-service-runner.mjs` | Runtime identity checks, credential loading, Windows job guard, probe/run/prepare dispatch |
| `scripts\windows-task-job.ps1` | Kill-on-close job containment |
| `scripts\windows-credential-acl.ps1` | Credential ACL validation without reading token contents |
| `apps\node\src\service-setup.ts` | Authentication/enrollment preparation and existing identity preservation |
| `apps\node\src\config.ts` | Shared `FLEET_NODE_CONFIG_DIR` override |
| `apps\node\supervisor.mjs` | Planned update restart handling, not general crash recovery |

The reviewed `2026-09-11-boot-persistent-service.md` originated from another
agent, but **I subsequently edited it** to record observations and change
conclusions. It is not an untouched independent opinion. The version in
`origin/main` at `4fe9b53` is the pre-review document.

History was rebased; do not replay the old attempt commits indiscriminately.
Backup refs retain the pre-rebase tips:

```text
refs/copilot/backups/windows-service-pre-main-20260911
refs/backup/windows-node-service-local-before-main-rebase-20260911
```

No changes were pushed during these service experiments.

### Session artifacts

Artifact root:

```text
C:\Users\charlesyin\.copilot\session-state\3f1f60b8-58ab-4a23-984d-5b3acab96847\files
```

- `pm2-boot-probe\foreground-result.json`: ordinary human-account PM2 execution
  only, not a Windows service result.
- `pm2-boot-probe\check-controller.ps1`: controller test with SCM/elevation
  mocked, not native registration proof.
- `pm2-boot-probe\native-install-78200a0ac38f43a990735fd108db4a6a.json`
  and matching `.log`: actual successful elevated WinSW/PM2 LocalService install.
- `pm2-boot-probe\probe.ps1`: standalone diagnostic controller and staged payload.
- `check-native-task-ownership.ps1`: newly prepared **UNRUN** validation/cleanup
  script for the tentative ownership patch. It would request native registration
  and remove the specifically identified failed probe. Do not mistake its
  existence for a passed test or run it as an automatic continuation.

## 10. Two candidates for an independent fresh review

These are **not selected or implemented for the actual Fleet Node**. The new
agent should also review the other design notes directly.

### Candidate A: a native WinSW LocalService service for the actual Node

Use the native-service mechanism demonstrated by the heartbeat instead of the
Task Scheduler backend. Decide whether the existing Node supervisor plus SCM
recovery is sufficient; PM2 is not automatically necessary just because the
diagnostic used it.

**Potential benefit:** true boot semantics, no personal Windows password, and
less dependence on Task Scheduler XML normalization.

**Unresolved:** actual Node identity/lock access, workspace permissions, planned
updates, process-tree shutdown, Host availability, GitHub/Copilot authentication,
and cold-boot proof. It still does **not** inherit the human user's vault.
Separately evaluate explicit token provisioning versus a service-owned protected
credential store if the env-file requirement is unacceptable.

### Candidate B: an interactive-user task at logon

Run under the existing logged-in user, by SID, and retain their profile and
ordinary `gh`/Copilot authentication rather than provisioning another account's
credentials.

**Potential benefit:** better alignment with the user's expectation of keeping
their existing sign-in and native Copilot state; no personal password stored for
batch logon.

**Hard limitation:** it starts **after login**, not on a signed-out reboot.
It is only acceptable if the user explicitly relaxes that requirement. Do not
represent S4U or auto-logon as a proven, credential-free way to remove this
limitation.

## 11. Suggested evidence gates for any new design

1. Reconcile the user's required startup time and credential/profile preference
   before choosing a mechanism.
2. Inspect current branch/worktree and runtime state. Preserve the local
   `package-lock.json` change, design notes, Node identity, and private stores.
3. Prove the smallest native registration/start/stop/delete cycle under the exact
   intended identity, using a heartbeat and the OS-returned definition.
4. Prove the needed file access without granting a whole profile/drive.
5. Prove `gh` and Copilot authentication under that identity without printing
   secrets or relying on a warm interactive session as cold-boot proof.
6. Only then prepare/start the actual existing Node and verify the same Node ID.
7. Verify stop, planned update, crash recovery and data-preserving uninstall.
8. Perform a signed-out reboot test only when the user approves the disruption.

References:

- [Microsoft: task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)
- [Microsoft: task RunLevel element](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-runlevel-principaltype-element)
- [Microsoft: LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)
- [GitHub CLI: authentication storage](https://cli.github.com/manual/gh_auth_login)
