# Copilot Fleet onboarding through Dev Box MCP

**Status**: Proposed design and implementation handoff; not implemented\
**Design date**: 2026-09-30\
**MCP package evaluated**: `@microsoft/devbox-mcp@0.0.3-alpha.4`

> Next agent: implement this in an isolated Copilot Fleet project session, not in
> the primary working copy. Start with the capability pilot in the Execution Plan.
> This document does not establish that the target tenant permits the required tasks.
> Proposed implementation files, profile fields, and script interfaces below remain
> new work; this published design does not implement them.
> No Dev Boxes, credentials, catalog entries, or Fleet configuration were changed
> while preparing this design. No tenant pilot has been performed.

Fleet behavior described below reflects design-time evaluation, not a
compatibility guarantee for every Fleet revision. Before implementation, check
the referenced documentation, command entry points, authentication behavior, and
version requirements against the exact target Fleet revision. The capability
pilot must establish the actual MCP/task schemas and execution contexts.

## Related documents

| Document | Link |
|---|---|
| Requested scope | Automate prerequisites and support different repositories for different users |
| UX design | No new Fleet UI in v1; agent-assisted setup plus existing Fleet screens |
| S1: Published MCP capabilities | [Package README](https://unpkg.com/@microsoft/devbox-mcp@0.0.3-alpha.4/README.md) and [package metadata](https://unpkg.com/@microsoft/devbox-mcp@0.0.3-alpha.4/package.json) |
| S2: Customization execution contexts and permissions | [Dev Box customizations](https://learn.microsoft.com/en-us/azure/dev-box/concept-what-are-dev-box-customizations) |
| S3: Native customization schemas | [Image definitions, task definitions, GitClone, PowerShell, WinGet](https://learn.microsoft.com/en-us/azure/dev-box/reference-dev-box-customizations) |
| S4: Reusable tasks and catalogs | [Configure customization tasks](https://learn.microsoft.com/en-us/azure/dev-box/how-to-configure-customization-tasks) |
| S5: Private repository authentication | [Key Vault and ADO token exchange](https://learn.microsoft.com/en-us/azure/dev-box/how-to-customizations-connect-resource-repository) |
| S6: Catalog Git clone task | [Microsoft sample task definition](https://github.com/microsoft/devcenter-catalog/blob/main/Tasks/git-clone/task.yaml) |
| F1: Fleet requirements, enrollment, placements, updates | [Repository README](../README.md); verify these design-time assumptions against the target revision |
| F2: Fleet Windows startup and credentials | [Windows login startup](windows-login-startup.md); verify the target revision's user/logon behavior |
| F3: Fleet command entry points | [package.json](../package.json): design-time commands `service`, `build:node`, `start:node`; inspect their implementations at the target revision before reuse |
| F4: Shared Host administrator model | [Repository README](../README.md), "Adding and removing administrators"; verify the target revision's access model |

## Feature desired outcome

An agent can prepare an authorized Dev Box as a Fleet worker using a repeatable
setup profile. Every user gets the same approved baseline tools but can select
different work repositories, branches, directory names, and optional approved
tool recipes. The agent stops at real authentication and policy boundaries
instead of reporting a partially prepared machine as ready.

**Per-user repository selection is supported.** Dev Box supports parameterized
repository cloning; it does not require every user to use the same repository.
The built-in GitClone task accepts `repositoryUrl`, `directory`, and `branch`.
A personal `devbox.yaml` applies to its associated box, while a shared image
definition supplies the team baseline. MCP exposes task discovery, validation,
execution, status, and logs. The proposed profile-to-task mapping supplies the Fleet-
specific behavior; there is no built-in "install Copilot Fleet" operation. [S1-S4]

### Scope and non-goals

V1 covers an existing authorized Dev Box, approved prerequisites, an initial
Fleet runtime checkout/build, per-user work repository clones, interactive
authentication handoff, existing Fleet enrollment/login startup, and a placement
handoff. Optional box creation uses an existing approved pool and requires
explicit authorization for the resulting cost.

V1 does not create Azure subscriptions, Dev Centers, pools, app registrations,
PATs, or service principals; change organization policy; automatically approve
MFA; sign a user into Windows; create a signed-out Windows service; or introduce
a Fleet provisioning daemon, new Host APIs, or multi-tenant authorization.
Project dependency installation/builds are opt-in approved recipes, not an
automatic consequence of cloning a repository.

### Outcome eval and release bar

Use two consenting pilot users on separate disposable Dev Boxes:

| Case | Expected result |
|---|---|
| User A: GitHub repository | Only A's requested repository appears in A's profile root; approved Fleet runtime is installed separately |
| User B: different Azure Repos repository | Only B's requested repository appears in B's root; branch resolves according to B's profile |
| Multiple repositories | Each has a distinct destination and placement candidate; identical repository basenames do not collide |
| Missing credentials or denied permissions | Explicit blocked state with a specific next action; no silent PAT fallback or login loop |
| Rerun after interruption | Completed steps are reconciled; no duplicate Node identity, enrollment, task, or clone |
| Unrelated work in a destination | Work remains untouched; mismatched or partially owned directories are reported, not deleted/reset |
| Ready | Intended user's login task is running, expected Node is online, placements exist, and a consented minimal session runs |

Ship only when every applicable acceptance case in the Quality section passes
on the supported Windows/pool configuration. Measure stage durations and
manual intervention counts; do not promise "fully unattended" or an arbitrary
time-to-ready until the pilot establishes a baseline.

## Terminologies

| Term | Meaning |
|---|---|
| Controller agent | MCP-capable client on the operator's machine; uses that caller's authorized Azure identity |
| Setup profile | Proposed nonsecret JSON input describing one user's desired installation and work repositories |
| Baseline | Operator-approved versions, package sources, installer code, and allowed setup recipes |
| Fleet runtime repository | Deployment checkout containing Fleet itself; not a user's coding workspace |
| Work repository | Source a user wants Copilot to work on; becomes a Fleet workspace placement |
| Catalog repository | Trusted distribution of Dev Box tasks/scripts; not automatically the runtime or a work repository |
| Fleet workspace / placement | Logical project / mapping to an existing absolute directory on a particular Node |
| Bound user | Intended Azure owner plus the actual Windows SID established during user-context setup; not a profile label |

## Design options considered

| Option | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Manual setup on each box | No new integration; existing Fleet flow | Repeated prerequisites, inconsistent setup | Fallback only |
| Agent issues ad hoc remote shell commands | Quick prototype | Hard to resume/audit; quoting and privilege mistakes | Use only for harmless capability probes |
| Shared baseline + per-user profiles + existing Fleet activation | Small change; supports A/B repos; keeps authentication and runtime responsibilities separate | Initial user action remains; requires task/context pilot | **Preferred** |
| Full Azure provisioner inside Fleet | Integrated machine management | New credential, cost, permissions, state, and lifecycle responsibilities | Defer |
| Golden image containing credentials and enrolled identity | Appears fast | Credential exposure and duplicated identity; wrong user context | Reject |

## Preferred option

### 1. Ownership and trust boundaries

Keep the Fleet Host on a stable machine. Treat Dev Boxes as workers.
Run Dev Box MCP on the controller; it need not be installed in every worker.
Prefer a separate caller session for each user's onboarding. One operator's
`users/me` scope does not become User B merely because a profile says "B".
Cross-user provisioning requires independently verified permissions and exact
target/owner selection; do not assume it from the README's resource examples.

Use one intended Windows user and one Fleet Node identity per box for the pilot.
Never copy credential caches or `node.json` from A to B. Persist the actual bound
Windows SID and reject user-stage execution as `LocalSystem` or a different SID.
Azure object IDs and Windows SIDs are different identifiers; do not infer one
from the other.

Different profiles are configuration separation, not a security boundary.
The design-time shared-Host model grants administrator access; verify the target
revision's access model before deployment. Do not advertise per-user
repository/session isolation on a shared Host. Use separate Hosts for
mutually untrusted users; share a Host only within an explicitly trusted operator
group. [F4]

### 2. Verified capability versus integration assumptions

| Operation | Documented support | Implementation boundary |
|---|---|---|
| Project/pool/box discovery | MCP tools [S1] | Discover under the actual caller; require an unambiguous target |
| Create/start a box | MCP resource/action tools [S1] | Creation is optional; do not start/stop arbitrary boxes |
| Install packages / execute commands | Run Tasks On Dev Box and customization groups [S1] | Exact input schema and user/system context must be established in the pilot |
| Parameterized cloning | Native GitClone task [S3]; catalog task [S6] | Native `directory` is the parent directory, not necessarily the final checkout path |
| Per-user repository choices | Personal customization files and task parameters [S2-S4] | Proposed profile JSON must be translated to actual task inputs; it is not an MCP-native schema |
| Task monitoring | Operation status and customization logs [S1] | Customization success alone is not Fleet readiness |
| ADO private clone without a stored PAT | Documented `{{ado://organization}}` token exchange in user customizations [S5] | Confirm support for the chosen task-submission path and identity; not proof of persistent CLI/MCP login |
| GitHub private clone before interactive setup | Key Vault secret references are supported [S5] | Optional later capability; no shared PAT or raw token in a v1 profile |
| Fleet enrollment/login startup | Design-time Fleet service command [F1-F3] | Not a Dev Box MCP feature; verify target-revision compatibility and retain current trust and preflight behavior |

Tool names in this document are the README's display names, not invented wire
identifiers. Next agent must inspect the installed server's tool list and input
schemas before writing an adapter. The alpha npm package and newer platform
documentation can differ; unsupported optional features must remain disabled.

### 3. Per-user configuration contract

Use JSON for the proposed Fleet setup profile so it can be read without adding a
YAML dependency. Shared baseline policy is operator-owned, versioned, and
separate from user data. The baseline selects exact tested package versions,
bootstrap revision/digest, allowed repository hosts, Fleet runtime sources, and
approved recipe IDs. Users cannot override policy with profile fields.

Illustrative profiles below are valid JSON, but identifiers and example work
repository URLs must be replaced. These are design inputs, **not working Dev Box
MCP requests or native customization YAML**.

**Public design context**: Fleet runtime examples use the public
`https://github.com/CharlesYWL/copilot-fleet.git`. Operators must approve the
actual runtime source and revision independently of the synthetic User A/B work
repositories below. This publication shares the design only; it does not
authorize publishing private runtime code, implementation history, credentials,
or user work repositories.

**User A: GitHub project, shared standard tools.**

```json
{
  "schemaVersion": 1,
  "profileId": "user-a",
  "baselineId": "fleet-windows-v1",
  "target": {
    "tenantId": "<tenant-id>",
    "project": "<devcenter-project>",
    "ownerObjectId": "<user-a-object-id>",
    "devBoxName": "alice-fleet"
  },
  "fleet": {
    "repositoryUrl": "https://github.com/CharlesYWL/copilot-fleet.git",
    "branch": null,
    "hostLabel": "alice-fleet-host",
    "transport": "private-devtunnel",
    "maxSessions": 4
  },
  "extraToolRecipes": [],
  "repositories": [
    {
      "id": "alice-web",
      "repositoryUrl": "https://github.com/example-user-a/web-app.git",
      "branch": null,
      "directoryName": "web-app",
      "workspaceName": "Alice Web",
      "authMode": "user-session",
      "setupRecipe": null
    }
  ]
}
```

**User B: different ADO project and an optional Azure CLI recipe.**

```json
{
  "schemaVersion": 1,
  "profileId": "user-b",
  "baselineId": "fleet-windows-v1",
  "target": {
    "tenantId": "<tenant-id>",
    "project": "<devcenter-project>",
    "ownerObjectId": "<user-b-object-id>",
    "devBoxName": "bob-fleet"
  },
  "fleet": {
    "repositoryUrl": "https://github.com/CharlesYWL/copilot-fleet.git",
    "branch": null,
    "hostLabel": "bob-fleet-host",
    "transport": "private-devtunnel",
    "maxSessions": 4
  },
  "extraToolRecipes": ["azure-cli"],
  "repositories": [
    {
      "id": "bob-api",
      "repositoryUrl": "https://dev.azure.com/example-org/ApiProject/_git/backend",
      "branch": "develop",
      "directoryName": "backend",
      "workspaceName": "Bob API",
      "authMode": "user-session",
      "setupRecipe": null
    }
  ]
}
```

Contract rules:

- Required: all shown fields, with empty arrays permitted. Reject unknown fields
  and unsupported schema/baseline/recipe IDs. Example placeholders must fail
  execution validation.
- `profileId` and repository `id` are labels, not authorization. Match the
  resolved resource/owner to `target`; bind Windows SID at user setup.
  Require these IDs to match `[a-z0-9][a-z0-9-]{0,62}` and be safe Windows
  directory leaves, excluding reserved device names. Apply containment/reparse
  checks to the profile state directory too, not only repository destinations.
- `branch: null` means discover the remote's default branch, not assume `main`.
  Resolve and record the resulting branch and commit. An explicit branch must
  exist and pass Git ref validation. Initial Fleet clone must track its branch
  so the existing updater can work.
- `fleet.repositoryUrl` must be operator-approved. A user can request a Fleet
  fork, but approval is required because this is executable deployment code.
  Selecting a work repository must never replace the Fleet runtime source.
- V1 accepts approved HTTPS Git hosts only, without embedded credentials,
  query/fragment tokens, local paths, or executable Git remote helpers. Preserve
  meaningful case/path information; do not lowercase entire repository URLs.
  Legacy ADO URL forms and SSH require explicit support, not guessed rewrites.
- Resolve runtime path under `%LOCALAPPDATA%\CopilotFleet\devbox\runtime`.
  Resolve work paths under `%USERPROFILE%\source\repos\<directoryName>`.
  `directoryName` is a unique Windows-safe leaf, not an arbitrary path. Reject
  traversal, absolute/UNC paths, reserved names, alternate data streams,
  trailing-dot/space aliases, and case-insensitive collisions.
- Recheck actual filesystem containment and reparse points before writes.
  No work repository may overlap the runtime checkout, state, or credentials.
- `maxSessions` is an integer from 1 through 10 for this pilot; higher values
  require a revised capacity baseline. This is a proposed setup limit, not a
  statement of Fleet's global supported maximum.
- `transport` is `private-devtunnel` or `direct-https`. `hostLabel` is descriptive,
  not a trusted Host identity or an enrollment credential.
- `authMode: user-session` is the v1 default: use the intended user's authorized
  Git credential flow. `setupRecipe: null` means clone only. An approved,
  versioned recipe may opt into additional dependency installation.
- ADO token exchange is a later opt-in mode after the pilot proves support for
  the chosen submission path. It must not silently replace `user-session`.

V1 supports at most 10 repositories per profile and one active setup run per
box. These are conservative proposed pilot limits; increase only after measuring
runtime, disk, and customization service behavior.

### 4. Stage-by-stage onboarding

| Stage | Executor / identity | Actions | Completion condition |
|---|---|---|---|
| Plan | Controller, authorized Azure caller | Validate profile/baseline, discover target, show package/repository changes, inspect task definitions and context | Exact box and owner approved; tasks supported; costs explicit |
| Prepare | Approved Dev Box tasks; system context only where required | Install baseline tooling from trusted sources; stage reviewed bootstrap and nonsecret profile | Required tools detected in their intended installation scope |
| Await user | Intended Windows user | Sign into Windows; complete required GitHub/Copilot/Dev Tunnels/Git credential flows | User-context preflights can succeed |
| Configure user | Intended user, normal privileges | Resolve profile paths; clone approved Fleet source; install/build Fleet; clone work repos; run opt-in user recipes | Correct runtime build and requested repositories exist without overwrites |
| Activate | Intended user in an interactive terminal for v1 | Obtain a fresh Fleet Connect command; invoke existing login-service installer | Task/runtime use the intended SID and Node reconnects to the expected Host |
| Register work | Authorized Fleet operator | Create/reuse workspaces and add placements using existing Fleet UI | Each placement points to the requested existing path on the intended Node |
| Ready | Fleet operator plus user-context status | Confirm identity, Node connection, placements, and a consented minimal session | End-to-end result, not merely completed customization |

If a permitted remote task can run as the actual user, it can perform Configure
user. If it cannot, stage the same script and have the user invoke it in their
Dev Box terminal. Do not relabel a SYSTEM process as a user process or promise
interactive authentication through an asynchronous customization log.

### 5. Baseline prerequisites and runtime installation

Design-time compatibility floors: Node.js >=22.5, npm >=10, Git, GitHub CLI,
Copilot CLI >=1.0.69, and PowerShell compatible with the chosen bootstrap.
Recheck these requirements against the target Fleet revision before pinning a baseline.
Install Dev Tunnels only when selected. Azure CLI/ADO extensions and project
toolchains are optional recipes, not mandatory for every ADO Git repository.
The baseline must select concrete package versions and package-manager sources;
the minimum versions above are compatibility floors, not installation pins.

Prefer native WinGet/PowerShell tasks and approved catalogs. Standard users
cannot run arbitrary built-in system tasks; do not elevate to evade this. An
already installed compatible tool is reused. Unsupported versions, locked
installations, reboot requirements, or missing package sources become actionable
states, not permission to uninstall software or reboot automatically. [S2-S4]

Execute package checks again in the actual user's environment. Installing a
binary as SYSTEM does not prove it is on the user's PATH or has user credentials.
Use fresh processes after PATH changes.

In the approved runtime checkout, reuse the existing Fleet entry points:
`npm install --include=dev`, `npm run build:node`, and the service activation
flow in F2. Do not introduce a second supervisor or construct scheduled tasks by
hand. Initial installation is separate from future application updates.

The Fleet deployment checkout must not contain user work: the design-time
updater behavior resets that checkout onto its tracking branch; verify this at
the target revision. Work repositories stay in the separate user repository root
and are never targets of that updater. [F1]

### 6. Repository customization and authentication

Native GitClone's `directory` is a parent directory. For arbitrary destination
leaf names, same-basename repositories, and safe reruns, prefer one reviewed
user-context bootstrap that calls Git with an explicit destination and validates
the result. Reuse the native task for cases where its destination/timing contract
is sufficient; do not assume catalog `git-clone` and built-in `~/gitclone` are
identical just because they have similar parameters.

S3/S6 document that cloning without the task's `pat` input is queued for first
user sign-in. Therefore neither public cloning nor private cloning through that
path is a reliable pre-sign-in readiness signal. Queueing is not authentication.
Wait for the actual checkout or use the explicit user-stage clone.

| Authentication concern | Required treatment |
|---|---|
| Dev Box MCP access | Authenticate controller and verify Azure permissions; this does not transfer credentials into a worker |
| GitHub repository / CLI | Establish the correct user's authorized account and repo access on the box; do not assume Copilot login proves Git access |
| Copilot CLI | Use Fleet's existing actual-user authentication preflight; subscription/organization access remains required |
| Private Dev Tunnel | User sign-in plus access to the particular Host tunnel; a successful login alone is insufficient |
| ADO Git repository | Use approved user credential flow; separately confirm repository access |
| ADO token exchange | Platform supports `{{ado://organization}}` for user customization clones without storing a PAT [S5]; opt in only after compatibility and log-safety proof |
| Azure CLI or ADO MCP | Check the tool's own authentication when needed; successful clone is not proof of a reusable CLI/MCP credential |

Device-code approval can occur in the user's local browser where the relevant
tool and tenant policy support it. The login process still belongs on the Dev
Box under the intended user. No blanket claim that every login needs RDP, or
that one login authenticates every tool, is valid.

Key Vault references can support noninteractive private clones when explicitly
approved, but **resolved secrets are not guaranteed masked in customization
logs**. V1 does not introduce PAT distribution. A future secret-based path must
prove least privilege, per-user/resource scope, safe handling, retention, and
rotation with nonproduction credentials before enablement. [S5]

### 7. Enrollment, startup, and workspace handoff

Keep enrollment out of shared profiles and remote customization arguments.
An authorized Fleet operator generates a fresh Connect command only after
the build and required credentials are ready. The design-time grant is single-use,
lasts 15 minutes, and binds one Node key; verify the target revision's contract
and preserve the supplied Host ID/fingerprint.
V1 uses the existing interactive user-terminal flow from F2. Do not paste real
grants into agent transcripts, YAML, task output, status JSON, or source control.
Use the existing trusted Host UI and local terminal for this sensitive step.

A remote activation optimization is explicitly deferred until a reviewed secret
delivery mechanism exists; this design does not invent an undocumented Fleet
enrollment API or a secret-safe MCP argument.

If already enrolled to the intended Host, reuse the existing identity and
service installer's `--existing-node` flow. On timeout, inspect persisted
identity and the Host before retrying; a consumed grant may mean enrollment
succeeded. Never automatically delete `node.json`, generate a replacement
identity, or repoint an enrolled Node to another Host.

Startup is same-user logon startup, not signed-out boot startup. Lock/RDP
disconnection normally leaves it running, subject to policy; sign-out, sleep,
or shutdown prevents execution. Starting a powered-off box is not the same as
logging in or bringing its Fleet Node online. [F2]

Workspaces/placements do not clone repositories. Produce a nonsecret placement
handoff listing workspace name, returned Node ID, and resolved absolute path.
V1 has the operator register it with existing Fleet screens. A future adapter
may use a discovered supported interface with proper operator authentication,
but must not write Host SQLite directly or invent endpoints. Do not reuse a
workspace across unrelated repositories just because display names match. [F1]

### 8. Idempotency, error handling, and local state

Proposed state location:
`%LOCALAPPDATA%\CopilotFleet\devbox\profiles\<profileId>\state.json`.
This is setup metadata, not Fleet's Node settings/identity store. Version and
write it atomically under user-scoped permissions. Machine prerequisite status
is discovered from the machine; never trust a user-writable "done" marker to
authorize privileged operations.

Persist only profile/baseline hashes, actual box identity, bound Windows SID,
resolved repository URLs without credentials, paths, revisions, stage results,
operation/group IDs, timestamps, and a Node ID after activation. Repository
names and paths can be sensitive; keep them local and permission-controlled.
Never persist tokens, grants, device codes, credential-cache contents, or raw
authentication output.

Use per-stage states: `not-started`, `running`, `waiting-user`, `blocked`,
`failed`, and `complete`. Overall `ready` requires all required stages and the
end-to-end postconditions; optional work cannot conceal required failures.
Report structured error codes such as `wrong-user`, `policy-denied`,
`auth-required`, `path-conflict`, `reboot-required`, `operation-unknown`,
`host-unreachable`, and `enrollment-needs-reconciliation`.

Before retrying, query any stored remote operation ID and inspect real
postconditions. A lost response is not evidence that a create/clone/install
did not happen. Do not issue duplicate box creation or customization groups
blindly. Restrict concurrent setup to one run per box with an owned lock.
Treat stale locks as reconciliation problems, not permission to kill processes.

For existing directories, verify ownership marker, Git remote, branch, and
requested disposition without modifying them. Preserve dirty files and local
commits. Never use hard reset, clean, force checkout, or recursive deletion to
make user repositories match a profile. Interrupted managed clones require
explicit recovery; foreign directories are left alone. Profile changes produce
a new plan, not automatic removal of old repos or credentials.

Use finite, documented deadlines: proposed pilot defaults are 30 minutes per
install/clone/build step and 120 minutes for optional new-box provisioning,
subject to supported service limits. Poll at the service's recommended interval,
or 15-60 second backoff when none is supplied. On observation timeout, record
`operation-unknown` and reconcile; do not declare that Azure work was canceled.

### Premortem analysis

| Risk | Likelihood (L/M/H) | Impact (L/M/H) | How the design addresses it |
|---|---|---|---|
| SYSTEM install appears successful but Fleet cannot authenticate | H | H | Split machine/user stages; bind SID; preserve Fleet's scheduled-task preflight |
| Per-user profile targets someone else's box | M | H | Resolve owner under actual Azure caller; exact target approval; no identity from labels |
| User repo parameters become elevated shell execution | M | H | Fixed privileged recipes; no freeform system commands; pass validated data as arguments, never evaluate it |
| ADO token/Key Vault secret appears in logs | M | H | User-session default; native token exchange gated; no claim of automatic masking; no raw auth logs |
| Same basename or malicious path overwrites work | M | H | Explicit leaf names, containment/reparse checks, conflict result, no destructive reconciliation |
| Fleet updater destroys a work checkout | M | H | Dedicated runtime directory; verify no overlap with work placements |
| Grant expires during provisioning | H | M | Generate only at activation; reconcile existing identity before replacement |
| Dev Box starts but no Windows user is signed in | H | M | Separate machine-running, user-ready, and Fleet-ready states |
| Shared Host exposes another user's work | M | H | Separate Hosts for untrusted users; profiles are not ACLs |
| Alpha MCP lacks a newer platform capability | M | M | Pin pilot version; discover schemas; capability gate; documented manual fallback |
| Automatic stop interrupts agents or repository changes | M | H | No lifecycle automation in v1; require active-session awareness and explicit approval later |

### Prototypes

No Dev Box execution prototype was performed for this document.

| Prototype no | Evaluation description | References | Learnings |
|---|---|---|---|
| 1 | Read-only tool/schema discovery and authorized-box task probe | S1-S4 | Required before implementation; establish available commands and exact execution identity |
| 2 | Separate A/B profiles and safe rerun on disposable boxes | Profile examples and outcome eval | Required to prove parameterization and isolation of setup state |
| 3 | ADO token exchange through the selected submission path | S5 | Optional; prove source access and log safety, not just successful schema validation |

## Tracking open questions

| Open question no | Open issue description | Findings and references | Resolution reached |
|---|---|---|---|
| 1 | Which Dev Center/project/pool and customization permissions are available? | Tenant not inspected | Pilot gate; no assumed resource creation rights |
| 2 | Does the pinned MCP expose user-context execution for existing boxes? | README advertises Run Tasks; exact schema not inspected | Probe; fall back to the same local user script |
| 3 | Does ADO placeholder hydration work for the chosen MCP invocation? | Documented for user customizations [S5] | Optional gate; default remains user-session authentication |
| 4 | Which package versions/sources are approved? | Design-time Fleet minimums require target-revision review; tenant policy unknown | Baseline owner must pin them before rollout |
| 5 | Which Fleet runtime source and branch should deployments follow? | Examples use public `CharlesYWL/copilot-fleet`; deployment source and revision require operator approval | Discover the default branch and verify user access; explicit branches and alternate sources remain configurable under baseline policy |
| 6 | Are A/B mutually trusted Fleet administrators? | Design-time documentation describes full administrators [F4]; verify the target revision | Separate Hosts unless trusted-group sharing is explicitly approved |
| 7 | Is secret-safe remote enrollment needed later? | No secure delivery path established | Out of v1; local activation is intentional |
| 8 | Should project-specific install/build scripts run? | Per-user repository selection is in scope, not arbitrary code execution | Clone-only default; opt-in approved user recipes |

## Common core checklist

- **Quality (verification)**: Implement the acceptance matrix below using the
  repository's existing test infrastructure and isolated pilot machines.
  Keep Windows user/logon testing explicit.
- **External dependencies**: Pin MCP and bootstrap/baseline revisions. Azure
  RBAC, catalog policy, package feeds, Git hosts, Copilot entitlement, proxies,
  Windows logon policy, and tunnel access are independently fallible.
- **Supportability**: Surface the failing stage, safe operation ID, error class,
  and exact human next action. Offer resume/replan, not "start over" deletion.
  Retain bounded redacted logs with an operator-approved retention period.
- **Performance**: Record provisioning, tool install, authentication wait,
  clone/build, and Node-online durations separately. Reuse compatible tools;
  do not parallelize unbounded installs or clone more repos than requested.
- **Fundamentals**: Require least privilege, credential isolation,
  auditable consent, integrity-checked installer distribution, safe logs, and
  organization policy compliance.
- **Execution Plan**: Follow the phases below; capability validation precedes
  implementation of optional native features.
- **Documentation updates**: Add approved baseline ownership, per-user
  profile examples, actual supported MCP/task versions, authentication
  boundaries, recovery procedures, and the logon limitation to Fleet docs.

### Acceptance matrix

| ID | Scenario | Required result |
|---|---|---|
| A01 | Plan only | No downloads, installations, clones, enrollment, or Azure mutations |
| A02 | A GitHub / B ADO profiles | Correct box, owner, URL, branch, and destination for each; no credential/state sharing |
| A03 | Two repos with the same basename | Distinct requested leaves; no collision or implicit nested checkout |
| A04 | Null and explicit branches | Actual remote default used for null; nonexistent explicit branch fails clearly |
| A05 | Wrong Windows SID / SYSTEM user phase | Refuse before credential use or user filesystem mutation |
| A06 | Compatible prerequisite already installed | Reuse; no forced downgrade, reinstall, or lost PATH |
| A07 | No auth / wrong account / denied repo / no Copilot entitlement | Specific blocked state; no retries that trigger repeated MFA or switch accounts silently |
| A08 | Rerun after each stage interruption | Reconcile existing operation and filesystem; no duplicate identities/tasks/repos |
| A09 | Dirty, foreign, or partial destination | Preserve contents; require explicit recovery when needed |
| A10 | Traversal, reparse path, credential URL, shell metacharacters | Reject unsafe inputs; validated supported refs/URLs remain data, not executed text |
| A11 | Missing/policy-denied native task | Explain capability gap; no privilege escalation or substitute remote-execution bypass |
| A12 | Expired/consumed enrollment grant or lost response | Preserve identity; reconcile Host; request fresh grant only if actually required |
| A13 | Host/tunnel unreachable or caller lacks tunnel access | Node not declared ready; diagnose connection independently of GitHub login |
| A14 | Logon / lock / disconnect / signed-out restart | Behavior matches F2; powered-on box never reported as proof of Node readiness |
| A15 | Optional ADO exchange | Only enable after actual target path works and no raw credential appears in captured output |
| A16 | Secret handling | Synthetic secret markers absent from manifests, setup state, MCP transcripts, and logs; do not use real secrets in tests |
| A17 | Placement registration | Correct existing repo path and online Node; mismatched repo/workspace names do not merge automatically |
| A18 | End-to-end readiness | Consented minimal Copilot session runs in the expected workspace using the intended Node |
| A19 | No-op rerun | No unnecessary fetch/reset/build/re-enrollment; unchanged requested state stays intact |
| A20 | Untrusted users | Separate Host boundary; never describe profile separation as access control |

### Execution Plan

1. **Capability pilot**: In an authorized disposable box, pin the MCP version,
   inspect actual tools/schemas and task definitions, and run a harmless identity
   and tool-version probe. Establish system versus user execution and log
   visibility. Record only redacted results. Do not invoke lifecycle mutations
   merely to discover capabilities.
2. **Profiles and baseline**: Add schema validation, deterministic planning,
   owner/path/ref checks, and A/B fixtures. Use existing repo test tools; add no
   testing framework just for the design.
3. **Prepare / configure-user bootstrap**: Build repeatable prerequisite
   installation and user-context runtime/repository setup with bounded status,
   safe arguments, owned state, and interruption reconciliation.
4. **Agent runbook / MCP mapping**: Map the validated plan to discovered native
   task inputs, retain operation IDs, and document the user-terminal fallback.
   Use existing native operations rather than introducing a background service.
5. **Activation / placements**: Reuse Fleet's current service CLI and its auth
   preflights. Provide a nonsecret placement handoff; keep the real grant in the
   local activation flow. Do not change Node identity or Host auth protocols.
6. **A/B end-to-end pilot**: Exercise all applicable acceptance cases, then
   document supported pool configuration, pins, measured times, and limitations.
7. **Optional enhancement**: Separately evaluate ADO token exchange, approved
   project recipes, or supported placement automation. Each remains disabled
   until its own capability/authentication requirements are met.

### Proposed repository changes for the next agent

This design is published at the path below; other listed additions remain
proposals, not implemented files.

| Repository path | Responsibility |
|---|---|
| `docs\devbox-fleet-onboarding-design.md` | Maintain/reconcile this published design in the implementation branch |
| `docs\devbox-onboarding.md` | Operator/user instructions and agent runbook with actual tested tool names |
| `scripts\devbox\profile.schema.json` | Strict nonsecret profile schema |
| `scripts\devbox\profiles\user-a.example.json` | Synthetic GitHub profile |
| `scripts\devbox\profiles\user-b.example.json` | Synthetic ADO profile |
| `scripts\devbox\Setup-FleetDevBox.ps1` | Small reusable setup entry point; proposed phases `Plan`, `Prepare`, `ConfigureUser`, `Activate`, `Verify` |
| `scripts\devbox\baselines\windows-v1.json` | Approved package/source/recipe pins and limits; no secrets |
| Existing test locations, selected after repository inspection | Profile/planning/error-state coverage using the existing runner |

Discover reusable helpers in `scripts\login-service-cli.mjs`, its imports,
`package.json`, and current Node enrollment/startup code before adding new
logic. The new script should invoke supported existing entry points, not
duplicate authentication, task registration, supervision, or Node identity code.
Adapt file boundaries to actual repository conventions after inspection.

## Backend checklist

- **State/Metadata**: Versioned local setup journal, remote operation IDs, and
  actual postcondition reconciliation. Existing Fleet identity/settings remain
  owned by Fleet; no new Host database or schema.
- **Config options and resource consumption**: Baseline-owned bounds, 10-repo
  pilot limit, one active setup per box, explicit deadlines and log limits.
  New-box creation requires cost authorization; do not implement automatic scale-out.
- **Remote operations**: Customization is already long-running: retain its
  operation handle rather than pretending it is a synchronous completion.
- **Integration**: Reuse existing Fleet command boundaries.
- **Public/Other APIs**: No new public API. Actual Dev Box MCP and task schemas
  are authoritative; no guessed fields or direct Host database writes.
- **Error handling**: Use the explicit setup error/state contract and
  preserve current Fleet errors without swallowing them.

## Frontend checklist

- **Corner cases**: Distinguish installed, waiting for user, Node online, and
  ready. Explain wrong account, wrong target, stale grant, existing checkout,
  pending operation, and stopped/sign-out states.
- **Error-handling**: Provide a safe next action and resumable state; do not
  expose raw logs containing credentials or display success on partial work.
- **Telemetry**: No new extension in v1. Any future UI must emit
  approved nonsecret stage outcomes, not prompts, tokens, or private URLs.
- **Config options and resource consumption**: No new browser storage or
  credential cache; setup profile remains data under operator/user control.
- **Feature switches**: Optional provisioning/auth features are
  controlled by explicit baseline capabilities and pilot approvals.
- **Accessibility**: Human instructions and status must work without color-only
  indicators.

## Appendix A - Examples of feature execution plans

### Backend example

| Phase | Description & objective | Depends on |
|---|---|---|
| 1 | Establish actual MCP/task capabilities and execution identity | Authorized disposable Dev Box |
| 2 | Profiles, baseline, planner, validation, fixtures | Phase 1 |
| 3 | Repeatable preparation and user setup | Phase 2 |
| 4 | Activation handoff, logs, recovery, placements | Phase 3 and existing Fleet CLI |
| 5 | A/B pilot and supported-configuration documentation | Phases 1-4 |

### Frontend example

| Phase | Description & objective | Depends on |
|---|---|---|
| 1 | Clear agent runbook and user action/status messages | Backend phases 1-2 |
| 2 | Existing Fleet UI enrollment and placement walkthrough | Backend phase 4 |
| 3 | New wizard, if separately requested | Out of scope; requires a separate UX decision |

## Appendix B - Ready-to-use next-agent handoff

Implement staged Dev Box onboarding for Copilot Fleet from this design. First
inspect the target Fleet revision and reconcile its actual behavior with the
design-time assumptions and linked documentation. Work only in an isolated
project session. Start with a read-only capability plan; actual Azure mutations
and model-consuming pilot sessions require user-approved resources and scope.

Use the smallest solution: one nonsecret per-user profile, one operator-owned
baseline, reusable setup scripts, Dev Box's existing customization tools, and
Fleet's existing activation flow. Support User A and User B with different work
repositories without changing installer code. Keep the runtime checkout separate.

Do not introduce another provisioner service, shared PAT store, Azure privilege
escalation, custom Node enrollment protocol, signed-out Windows startup, direct
Host DB changes, automatic destructive repository sync, or arbitrary elevated
project setup commands. Do not assume private repository cloning authenticates
every downstream CLI.

Report actual delivered capabilities separately from unresolved tenant gates.
The completion evidence is the applicable A01-A20 matrix, including separate
A/B profiles, safe reruns, correct Windows user, actual Fleet readiness, and
documented manual authentication/activation boundaries.
