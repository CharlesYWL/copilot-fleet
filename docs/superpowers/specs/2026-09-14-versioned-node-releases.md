---
filepath: "docs/superpowers/specs/2026-09-14-versioned-node-releases.md"
tags:
  - copilot-fleet
  - versioned-updates
  - manual-releases
  - windows-login-startup
---

# Versioned Node releases and service-safe automatic updates

**Area**: Copilot Fleet / Distribution and Node lifecycle  
**Engineer**: TBD  
**EM owner**: TBD  
**Architect**: TBD  
**Program Manager**: Not assigned  
**Date**: 2026-09-14  
**Status**: Proposed; local design for review, not an implementation contract  
**Work item**: Not assigned  
**Source baseline**: `caa1bf0ae04043de6b2933939d300bf7a8d2bb0f`, workspace versions `0.5.0`

## Related documents

| **Document** | **Link** |
| --- | --- |
| **Feature Lifecycle Process** | [Template process reference](https://dev.azure.com/powerbi/AI/_wiki/wikis/AI.wiki/90809/Feature-Lifecycle-Process); Fleet release approval is defined below, not a Fabric deployment. |
| **PM Functional spec** | This document captures the local discussion: manually published private GitHub releases, an npm-run Host, and bundle-installed service Nodes. |
| **UX Design** | No separate mockup; operator behavior is specified under Preferred option. |
| Current architecture | [ARCHITECTURE.md](../../../ARCHITECTURE.md) |
| Current update instructions | [README.md](../../../README.md#keeping-nodes-up-to-date) |
| Supported service mode | [Windows login startup](../../windows-login-startup.md) |
| Earlier distribution proposal | [NPX distribution design](2026-08-21-npx-distribution-design.md) |
| Manual release creation | [GitHub CLI: release create](https://cli.github.com/manual/gh_release_create) |
| Publish a draft | [GitHub CLI: release edit](https://cli.github.com/manual/gh_release_edit) |
| Private authenticated CLI usage | [GitHub CLI: auth login](https://cli.github.com/manual/gh_auth_login) |
| Exact-tag asset downloads | [GitHub CLI: release download](https://cli.github.com/manual/gh_release_download) |

This proposal supersedes the earlier NPX proposal's SHA-based update comparison and
untargeted `@latest` update decisions for managed bundle Nodes. It does not implement
NPX distribution, nor change the accepted login-start authentication model.

## Feature desired outcome

An operator can build and publish an exact Fleet version manually, approve that
version on a Host running from a checkout, and update eligible Windows service Nodes
without compiling on each machine, interrupting unapproved work, losing their
identities, or leaving the service pointed at a partially replaced installation.

**GitHub Actions is not a dependency.** The operator reports that GitHub-hosted
Actions runners are disabled for this private repository. Release publishing and
release asset access must be checked separately against organization policy; this
design does not assume that disabling runners disables Releases.

The initial supported combination is:

- Host: existing checkout, built and started through npm, updated manually.
- Node: prebuilt Windows x64 bundle, launched by the existing same-user login task
  through a stable, version-aware supervisor.
- Distribution: manually published assets in the same private GitHub repository.
- Update target: an explicitly approved, immutable release identity selected by the
  Host, not the newest branch commit or a moving `latest` alias.

This is a deterministic systems feature, not an AI evaluation. Its repeatable
evaluation is an isolated Host/Node update exercise with injected failures.

| Outcome | Repeatable evaluation | Required result |
| --- | --- | --- |
| Exact-version deployment | Publish/select A, then publish newer B during A's rollout. | Every operation for A installs A's pinned bytes, never B. |
| Mixed installation support | Checkout Host and managed Node exchange inventory, execute a mock session, and update. | Installation type does not prevent compatible protocol operation. |
| Safe automation | Attempt an automatic update with running, idle, and permission-waiting sessions. | Zero unapproved session termination; activation waits for zero live sessions. |
| Durable service restart | Update a real same-user login task and reconnect. | Same SID, task, `nodeId`, keys, settings, and workspace placements; no detached window. |
| Failure isolation | Fail download, verification, extraction, or preparation. | Active release and its dependencies are untouched and remain restartable. |
| Recovery | Crash the candidate or interrupt each journal transition. | A known-good release starts, or an explicit recoverable state is reported; no unbounded loop. |
| Honest completion | Reconnect an old/wrong build or restart the Host mid-operation. | No false success; operation state survives and requires matching release confirmation. |

All safety cases must pass. Proposed performance budgets and rollout gates appear
in the checklists below. No prototype results or performance measurements are
claimed by this design.

## Terminologies <!-- optional -->

| Term | Meaning |
| --- | --- |
| npm-run Host | A cloned checkout using the repository's npm scripts, not a published npm/NPX package. |
| Release version | Canonical SemVer without a leading `v`, for example `0.6.0`. |
| Release tag | Git reference `v0.6.0`, resolving to a recorded full source commit. |
| Bundle | Compiled Node code, production dependencies, assets, and metadata in an archive; not necessarily an executable. |
| Release identity | Repository, version, tag, source commit, release ID, manifest digest, and selected asset ID/digest. |
| Managed installation | Fleet-owned, side-by-side runtime directories with a stable launcher and activation journal. |
| Launcher | Installed bootstrap/supervisor that survives application restarts and selects the child release. |
| Service mode | Current Windows same-user InteractiveToken login startup, not an SCM/LocalService boot service. |
| Live session | Any locally owned, nonterminated agent session, including an idle chat or a pending permission request. |
| Maintenance fence | Host and Node admission guards that prevent new execution during activation. |
| Local readiness | The candidate process initialized correctly; distinct from authenticated Host confirmation. |
| Approved target | A published release explicitly selected for this fleet; approval is separate from publication. |

## Design options considered

| Option | Advantages | Disadvantages | Decision |
| --- | --- | --- | --- |
| Compare SemVer but still reset to an upstream branch | Small change to today's implementation. | Selected version does not identify installed bytes; in-place build failures remain. | Reject. |
| Build a pinned Git tag in a separate directory on every Node | Avoids branch drift and active-tree mutation. | Every Node needs Git, a dependency restore, and a successful build; repeated compute and network cost. | Viable fallback, not the initial managed path. |
| Manually publish prebuilt Node bundles to private GitHub Releases | Exact targets, no runtime build, same repository access model, no Actions dependency. | Publisher owns build discipline; requires bundle packaging and a trusted release process. | **Preferred.** |
| Publish npm packages and use a persistent runtime prefix | Familiar version distribution; can support NPX onboarding. | Adds registry/package access and publication work unrelated to the immediate need. | Defer. |
| Self-hosted Actions runners or another CI service | Could automate the same publication process later. | Requires separate policy approval and operations; hosted-runner prohibition does not establish permission for alternatives. | Optional future producer, not a prerequisite or workaround. |

## Preferred option

### 1. Scope and non-goals

The first release delivers manual bundle publication, exact-target Node updates,
one-time service migration, private authenticated downloads, durable operations,
and opt-in automatic rollout to safe Nodes.

It does **not** deliver:

- Host bundles or Host self-update, Host database migration/rollback, or automatic
  replacement of the Host's checkout.
- A signed-out Windows boot service, elevation, a different account, or credential
  export.
- Published npm/NPX packages, delta downloads, or an artifact proxy on the Host.
- Installation/updating of Node.js, GitHub CLI, Copilot CLI, Dev Tunnels, or other
  external tools.
- Automatic checkpoint/stop/resume of idle sessions, or a zero-downtime agent restart.
- Managed bundles for Unix or Windows ARM64 before those platforms are separately
  packaged and proven.
- Unattended update of the installed bootstrap itself.

Host self-update remains a follow-up because database consistency, compatible
migrations, graceful shutdown, and tunnel continuity require their own design.

### 2. Current behavior and changes required

| Source / symbol | Observed behavior | Required change |
| --- | --- | --- |
| `packages/protocol/src/runtime.ts`: `packageVersion`, `gitRevision` | Reports package version and live checkout SHA separately. | Add build/release identity that belongs to the running artifact; preserve SHA as diagnostic information. |
| `packages/protocol/src/index.ts`: `nodeUpdateState` | Compares SHA equality and `self-update` capability. | Compare trusted release identity and SemVer against the approved target; distinguish ahead, unknown, incompatible, and legacy. |
| `apps/node/src/updater.ts`: `updateCheckout` | Fetches, resets the tracking branch, installs, and builds in the active checkout. | Never invoke this path for a managed Node; stage a pinned bundle separately. |
| `apps/node/src/main.ts`: `runSelfUpdate` | Saves settings, shuts down, and exits `75`; its updating flag only excludes another update. | Add local execution fencing, durable handoff, correlated readiness, and event-drain requirements. |
| `apps/node/supervisor.mjs`: `resolveTarget`, `start` | Resolves one checkout target; handles exit `75` and a restart-storm bound. | Keep checkout behavior; add a stable managed supervisor that re-resolves journal state on each start. |
| `scripts/login-service-runner.mjs`: `run` | Imports checkout modules, loads checkout `.env`, and starts the Node supervisor. | Add a managed launch path independent of checkout files and dependencies. |
| `scripts/login-service-cli.mjs`: `manage` | Copies launcher/controller files and records `repositoryPath` in a v1 manifest. | Explicit ownership-checked v1-to-v2 migration, preserving task state and identity. |
| `scripts/windows-login-task.ps1`: ownership validation and task action | Checks SID, exact action, working directory, and settings; stop disables recovery. | Support old/new manifest forms without weakening ownership checks. |
| `scripts/windows-login-job.ps1` | Contains descendants in a kill-on-close job. | Preserve containment; do not escape the job for updates. |
| `apps/host/src/fleet-service.ts`: `requestUpdate`, `settleUpdateOnReconnect` | Busy check occurs on the Host; in-flight updates are an in-memory Node ID set; reconnect settles success. | Persist correlated operations and require the actual target release and commit acknowledgement. |
| `apps/node/src/outbox.ts`: `EventOutbox` | Reconnect batches are bounded and retained in memory until acknowledged. | Drain/acknowledge before planned exit; do not claim they survive process termination. |
| `apps/node/src/config-assets.ts`, `agent-catalog.ts` | Config assets and shipped agents live outside `dist`. | Include `public` and `agents` in packaging and clean-machine checks. |
| `apps/host/src/config.ts`: `resolveDatabasePath` | Host database defaults relative to its package. | Leave Host code/data placement unchanged in v1. |

The old updater leaves the previous process alive on a build failure, but may have
already changed its files/dependencies. A subsequent service restart can therefore
fail. Keeping the active release immutable is a core requirement, not just a
packaging convenience.

### 3. Ownership and compatibility

| Owner | Responsibility |
| --- | --- |
| Publisher | Build/check exact source, produce artifacts, publish a complete release. |
| Host | Authenticate catalog reads, select/approve one release, persist operations, gate dispatch, and verify Node completion. |
| Node application | Validate requests, prepare candidate files, fence local execution, drain events, and report correlated readiness. |
| Managed supervisor | Sole writer of activation journal; own child lifetime, launch selection, promotion, and bounded rollback. |
| Windows login task | Start after sign-in, preserve user context, contain descendants, and recover an unexpected launcher crash. |

Installation type is not protocol compatibility:

| Host | Node | Contract |
| --- | --- | --- |
| Compatible checkout Host | Managed bundle Node | Primary supported combination. |
| Compatible checkout Host | Checkout Node | Existing execution remains; versioned managed updates require migration. |
| Older Host | New managed Node | Execution only if the wire protocol remains compatible; no new update messages until negotiated. |
| Development Host | Managed release Node | Explicit compatible target allowed; unpublished changes are not treated as a published release. |
| Future packaged Host | Managed bundle Node | Same network contract; Host packaging is outside v1. |

Compatibility is explicit: declare an application protocol epoch, required
capabilities, a supported Host version range, and an update-protocol version.
Capabilities continue gating feature-specific messages. SemVer alone does not prove
wire compatibility, particularly for `0.x` minor releases.

A release Host defaults its target only when its build identity is verified as a
published release. A checkout with the same `package.json` version but extra or
uncommitted changes is a development build. Build metadata must record that fact;
live Git HEAD must not relabel an already-running build after files change.

Development Hosts need a deliberate target selection and a compatible declared
protocol. Untested development compatibility does not qualify for unattended rollout.

### 4. Manual release production

#### 4.1 Publisher sequence

All script names in this section are **proposed**, not commands implemented today.

1. Commit synchronized workspace versions and lockfile references. Create and push
   the matching release tag through the approved repository process.
2. In a disposable clean build checkout, resolve that tag to a full commit and verify
   its package versions. Never build a release from the actively running Host tree
   or package a dirty workspace.
3. Run `npm ci`, the repository verification suite, and the platform-specific
   packaging checks. A script may create output only under an explicit build/output
   directory; it must not reset the operator's checkout.
4. Produce an allowlisted runtime archive and `release.json`; record the commit,
   lockfile digest, build tool versions, timestamp, and artifact digests.
5. Run the unpacked bundle in an isolated test profile outside any checkout.
6. Use the GitHub web UI or `gh` to create a **draft** release for the existing tag
   and upload the required assets.
7. Re-download and verify the uploaded manifest and each required asset. Confirm
   the remote tag resolves to the recorded commit, not merely a branch named in
   `target_commitish`.
8. Publish the draft only after completeness checks and explicit publisher approval.
   Nodes must ignore drafts and unsupported prereleases.

Proposed entry points:

| Script | Inputs | Output / side effects |
| --- | --- | --- |
| `release:prepare` | Existing tag, supported target platform, output directory. | Bundle, manifest, and local verification receipt; no remote writes. |
| `release:publish` | Prepared output and explicit publish approval. | Create/upload/verify draft, then publish; no automatic version bump, commit, or push. |

The same scripts can be driven by an approved CI system later without changing the
Node download or activation contract.

#### 4.2 Bundle contents

Initial asset names:

- `release.json`
- `fleet-node-0.6.0-win32-x64.zip`

GitHub's generated source-code archive is **not** this bundle. The Node must not run
`npm install`, `npm ci`, or a compiler when activating it.

Retain a recognizable package layout inside the archive:

- Root runtime metadata and package manifest.
- `apps\node\package.json`, `apps\node\dist`, `apps\node\public`,
  `apps\node\agents`.
- The built `@fleet/protocol` package and the transitive production dependency closure.
- Applicable third-party licenses/notices and internal release/build metadata.

Materialize workspace packages as real in-archive directories at runtime-resolvable
locations. No symlink/junction may point to the publisher's workspace. Packaging
must preserve nested dependency versions and verify every `@fleet/protocol` export,
including its Node-only entry points.

Exclude `.git`, `.env`, credentials, data directories, logs, caches, tests, source-only
files, and dev dependencies. Use an inclusion list; zipping the repository and
excluding a few obvious secret filenames is insufficient.

Node.js remains an external prerequisite. Build on the supported target platform
and validate the actual Node.js/runtime range; do not label a Windows x64 dependency
tree as universally portable.

#### 4.3 Release manifest

Illustrative schema; hash placeholders below are not valid release values:

```json
{
  "schemaVersion": 1,
  "repository": "charlesyin_microsoft/copilot-fleet",
  "version": "0.6.0",
  "tag": "v0.6.0",
  "sourceCommit": "<full 40-character commit>",
  "channel": "stable",
  "updateProtocolVersion": 1,
  "minimumLauncherVersion": "1.0.0",
  "compatibility": {
    "protocolEpoch": 1,
    "hostVersionRange": ">=0.6.0 <0.7.0",
    "requiredHostCapabilities": ["versioned-node-update-v1"]
  },
  "artifacts": [
    {
      "component": "node",
      "platform": "win32",
      "arch": "x64",
      "name": "fleet-node-0.6.0-win32-x64.zip",
      "sizeBytes": 123456,
      "unpackedSizeBytes": 456789,
      "sha256": "<64-character lowercase hex digest>",
      "nodeEngine": ">=22.5.0",
      "entryPoint": "apps/node/dist/main.js"
    }
  ]
}
```

Schema paths use archive-relative separators; runtime resolution uses the platform's
path APIs. The entry point is a validated relative path, never a shell command.
Real runtime ranges must reflect validation evidence, not be copied blindly from
this example.

`release.json` is hashed as raw bytes. The Host pins that digest plus the GitHub
release/asset IDs returned by authenticated discovery. The archive contains internal
build metadata but not its own archive digest, avoiding a circular checksum.

Changing release contents requires a new version. If repository-supported release
immutability is available, enable it through the normal approval process; otherwise
enforce the rule in publishing and reject digest/ID drift in the updater.

#### 4.4 Trust boundary

For v1, trust is rooted in the fixed private GitHub repository, authenticated TLS,
approved publisher access, and the administrator's selected manifest digest.
A checksum detects corruption or replacement relative to that pinned manifest;
it does **not** independently authenticate a malicious publisher who can replace
both manifest and archive.

Do not claim manual bundles have CI attestations or independent code signatures.
Record manual provenance honestly. If organization policy requires publisher
signing or provenance attestations, that becomes a release gate and must be designed
before automatic installation is enabled.

The installer pins the allowed GitHub host/repository. Update messages cannot choose
an arbitrary URL, repository, executable, or install command.

### 5. Discovery, approval, and automatic policy

The Host reads published release metadata through `gh` using its own approved
repository-read authentication. This is an additional Host prerequisite for release
discovery; a Fleet browser login is not a GitHub repository credential.

Recommended initial policy:

- Poll on demand and every six hours with jitter; respect rate limits and backoff.
- Show only complete, schema-valid stable releases supported by the fleet.
- Cache metadata and display its last successful refresh time.
- Publication alone never changes the approved target.
- Automatic Node updates are **off by default** and can follow only the approved
  exact target. They do not select `latest` independently.
- Once enabled, update one eligible Node at a time and pause on a failed operation
  or unresolved post-restart confirmation.
- Skip busy/offline Nodes and retry eligibility later. A staged waiting Node is
  still available for ordinary work until activation acquires its maintenance fence.
- No automatic downgrade, prerelease switching, or same-version artifact replacement.
- Explicit target changes do not silently retarget an existing operation. Cancel
  pre-activation work or finish/reconcile an activation already in progress first.

Use a maintained SemVer parser rather than lexicographic comparison. Invalid
versions become an explicit unknown/invalid state, never silently `0.0.0`.

Keep release relation separate from update eligibility:

| Release relation | Meaning |
| --- | --- |
| `current` | Running the approved release identity. |
| `behind` | Older version; update still requires compatible metadata and updater support. |
| `ahead` | Newer than the target; no automatic downgrade. |
| `different_build` | Same SemVer but different/unverified release identity. |
| `unknown` | Missing or invalid identity information. |

Eligibility separately reports unsupported platform, incompatible protocol, old
launcher, legacy checkout, unavailable credentials, offline state, or live sessions.
This avoids a green "current" badge masking an unsupported updater.

### 6. Authenticated Node downloads

The Node downloads directly from GitHub using the service user's existing `gh`
authentication. Fleet enrollment does not grant repository access and the Host
does not forward GitHub tokens to Nodes.

Use authenticated release APIs to resolve the exact pinned release and assets, then
the CLI's authenticated asset-download path. An implementation may use exact-tag
`gh release download` with literal asset names, provided it verifies the pinned IDs,
manifest digest, and archive hash and refuses metadata drift.

Illustrative existing CLI command, after a release with these assets is published:

```powershell
gh release download v0.6.0 `
  --repo charlesyin_microsoft/copilot-fleet `
  --pattern "release.json" `
  --pattern "fleet-node-0.6.0-win32-x64.zip" `
  --dir ".\staging\0.6.0"
```

Service code uses a unique operation staging directory, not this illustrative
relative directory. Pass structured arguments to the executable; do not interpolate
release names into a shell command.

Preflight must check actual repository/asset access, not only `gh auth status`.
Account SSO, token expiry, proxies, and network policy still apply. No login prompt,
credential export, permission widening, or token file is introduced.

Classify authentication, authorization, missing release, policy/network, and integrity
errors separately. Redact command output and never log tokens, authenticated headers,
credential-store contents, or signed download URLs.

### 7. Stable runtime and local state

Proposed Windows layout:

```text
%LOCALAPPDATA%\CopilotFleet\
  login\
    node\
      manifest.json
      login-service-runner.mjs
      managed-node-supervisor.mjs
      windows-login-task.ps1
      windows-login-job.ps1
      runtime.log
  runtime\
    node\
      activation.json
      staging\
        <updateId>\
      releases\
        <version>-<artifact-digest-prefix>\

%APPDATA%\CopilotFleet\
  node.json
  settings.json
  node.lock
  agents\
```

An existing absolute `FLEET_NODE_CONFIG_DIR` continues to override the identity
directory. Runtime storage and profile/state storage have different purposes.

The stable supervisor must start using Node.js standard-library functionality even
when both application releases are broken. It must not import the active bundle's
dependencies merely to select or roll back a child.

The managed runner selects explicit runtime/identity/config paths. It does not infer
the runtime from `cwd`, read an unrelated working-directory `.env`, or depend on the
original checkout remaining present.

For migration, first persist editable Node settings using the existing precedence
rules. Preserve required runtime options such as the tunnel ID and config port.
If the original checkout `.env` contains still-required options not represented in
settings or the existing nonsecret environment allowlist, report them for explicit
configuration; do not silently drop them or copy the entire `.env`.

Preserve the existing Windows account, PATH/tool overrides, HOME/profile paths,
Copilot authentication, custom agents, enrollment identity, and Host fingerprint.
Do not copy or migrate the Host database, Host `.env`, or Host task.

Each release directory is immutable after verification. Keep the active release,
previous known-good release, and at most one staged candidate. Cleanup acts only on
validated Fleet-owned release/staging directories not referenced by a child or the
journal; never recursively delete a runtime root or traverse reparse points.

#### 7.1 Activation journal

The supervisor is the sole journal writer. Application update code communicates
through a parent-owned Node IPC channel; no new remotely reachable control endpoint
is needed.

Persist at least:

- Schema version, installed launcher version, and Node identity reference.
- Active and previous known-good release identities.
- Pending operation ID, candidate identity, expected prior release, and phase.
- Launch attempt ID, bounded attempt counts, deadlines, and last structured error.
- Last completed operation receipt for replay after reconnect.

Use write-to-temporary, flush, and same-volume atomic replacement, retaining a
previous valid journal for recovery. Validate schema, path containment, artifact
identity, and expected phase before every transition. Reject a corrupt/unrecognized
journal explicitly; never guess the highest version directory.

A machine-local supervisor lock prevents concurrent manual/service launchers from
activating different releases. Keep the existing Node identity lock as a separate
last line of defense; neither lock authorizes killing an unrelated process.

### 8. Wire and durable Host contracts

Names below are proposed. Add a capability such as `versioned-node-update-v1` and
new discriminated messages; do not append a target field to today's `update_node`
and send it to older Nodes that may ignore the field and update a branch anyway.

| Surface | Proposed additions |
| --- | --- |
| Node inventory/register/ready | Optional installation kind, launch mode, verified release identity, launcher version, and pending/last update receipt. |
| Host-to-Node request | `update_node_release`: `updateId`, pinned target identity, compatibility metadata, and explicit session policy. |
| Host-to-Node activation request | `activate_node_update`: matching ID/target after the Host has persisted its admission fence. |
| Final-event barrier | Node sends `node_update_drained` after its final events; Host persists those events and replies `restart_node_update` on the same authenticated connection, correlated to the operation/barrier. |
| Host-to-Node cancellation | `cancel_node_update`: matching ID, accepted only before the supervisor's activation handoff is committed. |
| Node-to-Host progress | `release_update_status`: matching ID/target, monotonic phase sequence, stage, structured reason, bounded safe detail. |
| Host-to-Node final acknowledgement | `commit_node_update`: matching ID, target, and candidate launch attempt. |
| Node-to-Host durable outcome | `release_update_result`: committed/rolled-back/failed, actual release identity, attempt, and reason. |
| HTTP operation API | Extend existing update routes to return `202` plus operation ID; add durable operation reads and target/policy configuration. |
| Browser snapshot/events | Current release, target, eligibility, and persisted operation status, not only transient WebSocket progress. |

Only send the new messages after capability negotiation. Managed Nodes must not
advertise the legacy untargeted `self-update` behavior. They can parse an obsolete
request to return a clear refusal, but must never call `updateCheckout`.

Checkout Nodes retain their existing execution path. The versioned rollout excludes
them and labels migration required; any retained legacy branch-update action must
be explicitly separate from exact-release "Update all".

Persist one active operation per Node in SQLite, with target approval recorded
before dispatch. Suggested fields:

`id`, `node_id`, `target_identity`, `expected_prior_identity`, `policy`,
`stage`, `stage_seq`, `created_at`, `updated_at`, `deadline_at`, `attempt`,
`actual_identity`, `error_code`, `error_detail`, `requested_by`.

Use an atomic active-operation constraint and normal repository transaction patterns.
On reconnect, reconcile the local receipt with the durable Host record. Duplicate
requests/statuses replay the same operation; mismatched IDs or stale phase sequences
must not complete or overwrite another operation.

Record the operation before sending any WebSocket message. A failed send leaves a
visible queued/retryable operation, not a fabricated started/succeeded result.
Restore scheduling/fence state before normal dispatch when the Host starts.

Validate operation and launch IDs as canonical UUIDs before deriving local paths.
Cancellation races the activation handoff through the supervisor's serialized
journal transition: either cancellation wins and is acknowledged, or activation
wins and cancellation returns a conflict. Never clear a fence merely because the
browser requested cancellation.

### 9. Update transaction and service restart

The main progression is:

`queued -> preparing -> staged -> waiting_for_idle -> draining -> restarting ->
verifying -> succeeded`

Pre-activation failures end as `failed` or explicit cancellation. Candidate failures
enter `rolling_back -> rolled_back` or `needs_attention`. Connectivity-only delay
enters `awaiting_host`; it is not proof of a bad executable.

#### 9.1 Prepare while continuing normal work

1. Validate capability, target, platform, launcher, runtime, and downgrade rules.
2. Deduplicate the operation locally and check the supervisor owns this installation.
3. Download manifest/artifact to the unique staging directory without blocking the
   Node event loop or heartbeat.
4. Verify repository/release identity, manifest digest, byte length, and archive hash.
5. Extract with bounded size/count and safe path handling. Reject absolute/drive/UNC
   paths, parent traversal, Windows alternate data streams, case-insensitive path
   collisions, device/reserved paths, and links/reparse points.
6. Validate internal metadata, complete file layout, dependency resolution, and the
   supported Node.js range. Do not create a second live Node to perform this check.
7. Finalize the candidate directory and ask the supervisor to record it as staged.

Select a reviewed archive implementation in the packaging prototype; a raw shell
unzip command without containment and resource checks is not sufficient.
No network data becomes an executable command or an arbitrary filesystem target.

#### 9.2 Establish a safe activation point

Automatic and ordinary manual updates require zero live sessions. "No busy turns"
is not enough: idle chats, orchestrators, and pending permissions still own processes.

Stage first; do not indefinitely fence a busy Node while waiting for idle. When the
Host observes an eligible Node, atomically fence new dispatch and request local
draining. The Node sets its own fence before checking actual process/session inventory.
If either side finds live work or work starts in the race window, defer and release
the fence rather than kill it.

Enforce the Host fence at the common dispatch boundary, covering session start,
resume, prompt/adoption, orchestration, automatic resume, and other operations that
can create execution. Stop/cancel and required event delivery remain allowed.
Check the Node fence in its command router too, including concurrent message handlers.

The existing explicit "stop sessions and update" UI remains an operator choice for
one named Node. Acquire the fence, stop the identified work, and wait for correlated
stop results and local child termination. Sending stop commands is not confirmation.
If stopping times out, abort activation; bulk and automatic updates never force it.

Flush/acknowledge buffered events before exit. For this versioned path, require the
acknowledged-outbox capability. Add an update-specific drain barrier over the existing
ordered socket so the Host confirms it persisted all preceding final events. If
connectivity is lost before that acknowledgement, remain on the old process.

The current general shutdown closes the socket before stopping agents. The update
path must finish intentional stops and their event barrier before calling final
shutdown. A durable general-purpose disk outbox is not silently assumed or included.

#### 9.3 Handoff without stopping the task

Save current settings. The supervisor durably records the ready-to-activate candidate
and acknowledges the handoff before the application exits `75`.

The supervisor waits for the child to exit and release its identity lock, re-reads
the journal, and launches the selected candidate. Keep stdio directed to the existing
logs and retain the same profile/environment.

Routine activation must **not**:

- Invoke the task's stop/restart management action.
- Disable/re-register the task or edit its account.
- Spawn a detached replacement process.
- Overwrite the active runtime or its dependencies.

The controller, Windows job guard, runner, and stable supervisor survive the planned
child restart. Task Scheduler remains responsible for an unexpected launcher crash;
the launcher handles intentional application replacement.

#### 9.4 Readiness and promotion

Pass a unique launch attempt over the parent-owned IPC channel. A candidate signals
local readiness only after identity/config initialization, instance-lock ownership,
and config-server readiness. Reuse the existing structured config-UI readiness
mechanism; a PID or a generic HTTP `200` is not sufficient proof.

Separate external prerequisite waits from local initialization. Today `main` awaits
the private tunnel before loading settings/starting the config server. The managed
startup path must expose a structured dependency-wait state and separate local
configuration readiness from establishing the tunnel connection. A tunnel network
or authentication delay is `awaiting_host`/dependency-blocked, not a local executable
failure that spends rollback attempts. The local-readiness deadline applies to
bounded local work; external waits use the confirmation alert/backoff policy.

The candidate reconnects normally, presenting the same `nodeId`, verified target
identity, operation ID, and attempt. Keep execution fenced while verifying.

The Host must establish all of:

1. The reconnect authenticated as the expected Node.
2. Version, source commit, manifest/artifact identity match the pinned request.
3. Required inventory/outbox reconciliation completed.
4. The candidate reports local readiness for the expected attempt.

Then persist authorization to promote and send `commit_node_update`. The candidate
asks its supervisor to promote the journal, receives its durable receipt, and sends
`release_update_result`. Only then does the Host mark success and release its fence.

If an acknowledgement is lost, replay the journal receipt. If the Host restarts,
re-send its persisted promotion authorization. A normal reconnect, a progress string,
or a stale process with the same package version never proves completion.

### 10. Failure recovery and bounds

| Failure point | Required response |
| --- | --- |
| Missing release, denied repository access, wrong digest, unsafe archive, incompatible target | Explicit failure; do not modify active files or restart. Integrity failures are not automatically retried as success. |
| Transient download/rate-limit/network failure before activation | Bounded backoff, with the old process serving work. Respect server retry guidance. |
| Live sessions or unacknowledged events | Remain staged/deferred; do not terminate the old process. |
| Old child refuses graceful exit or lock remains owned | Do not launch a competing Node. Report the owning process/phase and stop activation. |
| Candidate crashes on local initialization before readiness | Roll back once to the previous verified, locally compatible release; classify external dependency failures separately. |
| Candidate is locally ready but Host/tunnel is unavailable | Report `awaiting_host`; continue bounded/backoff connection attempts. Do not infer a bad release or repeatedly reinstall. |
| Wrong authenticated release identity or protocol incompatibility after launch | Fail verification and use compatible local rollback; preserve a receipt for the Host. |
| Rollback also fails | `needs_attention`; retain both releases/logs, stop the tight loop, and require operator action. |
| Power loss before activation handoff | Restart the last committed release; reconcile staged work later. |
| Power loss after activation begins but before commit | Read the journal, count the interrupted attempt, and resume verification or execute the one allowed rollback. |
| Explicit stop/sign-out | Respect task disablement/session lifecycle. Recovery happens only on the next permitted start, never by re-enabling the task. |
| Host crashes during the operation | Restore its record/fence and reconcile the Node's durable receipt before scheduling work. |

Proposed conservative defaults, subject to prototype measurements:

| Limit | Initial value / behavior |
| --- | --- |
| Concurrent activations | One per Node and one Node per fleet rollout. |
| Release polling | Six hours plus jitter; manual refresh available. |
| Transient preparation retries | Up to three retries with bounded backoff; no interactive credential recovery. |
| Download attempt | Ten-minute bound, cancellable before activation. |
| Maximum archive / expanded payload | 512 MiB / 2 GiB and 50,000 entries; reject before activation. |
| Free-space preflight | Space for archive plus declared expanded payload plus 25% margin; retained releases remain protected. |
| Stop/event-drain wait | 60 seconds, then defer/fail without activation. |
| Local startup readiness | 60 seconds; one candidate start plus one rollback per operation. |
| Host confirmation alert deadline | Ten minutes; pause fleet rollout and report attention required, without declaring success or forcing a connectivity-based rollback. |
| Retained code | Active, previous known-good, and one pending candidate. |

After the confirmation alert deadline, the candidate remains fenced but able to
reconnect; a later matching authorization/receipt can finish the operation. A user
can stop or explicitly roll back through local management. Network uncertainty is
not a reason to cycle versions or restart the task forever.

Attempt counters must survive launcher and Task Scheduler retries. Otherwise the
task's existing ten one-minute retries would reset the supervisor's budget each time.
After exhaustion, a subsequent recovery start emits the persisted error and does not
retry candidate activation automatically; use bounded idle/error behavior or an
explicit management reset, not a hot retry loop.

Node settings/credentials must remain readable by the previous supported release
during the rollback window. Any incompatible local-state migration makes that release
ineligible for unattended activation until a separate migration strategy exists.
Rollback never means deleting identity or copying old credentials over new ones.

### 11. One-time migration of existing service Nodes

Current installed files are copies, so an application update cannot upgrade them by
changing the checkout. Migration is an explicit local operation, not a hidden side
effect of the legacy branch updater.

1. Confirm same-user identity, task ownership, original manifest, existing Node key,
   effective settings, and target repository access. Record whether the task was
   enabled/running. Require live sessions to be stopped by their owner.
2. Prepare and validate the selected bundle without touching the existing runtime.
3. Preserve the old manifest/controller set as a local recovery set. Validate task
   ownership against that old configuration before changing any ownership inputs.
4. Stop the old Node through the approved local management path. Do not stop a
   colocated Host or rewrite its files.
5. Install the stable managed launcher and a v2 manifest. The v2 manifest distinguishes
   checkout from managed runtime and uses a stable task working directory.
6. Update the **owned** task action/working directory and ownership marker as one
   recoverable migration. Never weaken `Assert-FleetOwned` to accept arbitrary tasks.
7. Reuse the same identity/configuration, run same-user preflight, and start only if
   the recorded state or explicit user instruction authorizes it.
8. Verify the existing `nodeId` reconnects from the selected release. If migration
   fails, restore the old owned task/manifest and permitted enabled state.

A disabled task stays disabled unless the user explicitly requests start. If a task
was changed concurrently, refuse takeover and surface the conflict.

Initial onboarding can continue using the checkout's installer, extended to provision
a managed runtime. It need not introduce NPX or a bootstrap download-and-execute
one-liner. New enrollment still uses the existing one-use grant; grants are not saved
in release metadata or task arguments.

New service management must work after migration even if the original checkout is
removed. Install the minimal management entry point beside the stable launcher;
the checkout npm aliases may delegate to it.

### 12. Operator UX and rollout

Extend existing Nodes/settings surfaces rather than building a separate update UI.

- Show Host build identity and install kind, selected Node target, catalog freshness,
  and release notes.
- In each Node row show running version first, source SHA in details, install/launch
  kind, eligibility reason, target, and durable operation stage.
- Provide target approval, per-Node update, safe bulk update, automatic-policy opt-in,
  pause rollout, and cancel-before-activation actions.
- Keep "stop sessions and update" behind the existing named-session confirmation.
- Display `waiting for idle`, `awaiting Host confirmation`, `rolled back`, and
  `launcher migration required` distinctly; none means "up to date".
- Browser reconnect/page refresh reconstructs progress from the Host, not in-memory
  client event history.
- Local config/status/log surfaces report actual running release, selected/pending
  release, launcher version, and last operation result.

First rollout: update the compatible checkout Host manually, migrate one Windows
x64 canary Node locally, perform one manually approved update, and observe recovery
and session behavior. Only then enable safe automatic rollout for that approved
target. Do not migrate every Node in one operation.

### Premortem analysis

| **Risk** | **Likelihood** (L/M/H) | **Impact** (L/M/H) | **How the design addresses it** |
| --- | --- | --- | --- |
| Manual bundle contains credentials or misses runtime assets | M | H | Clean build, explicit inclusion list, license/secret checks, and unpacked isolated-profile verification before publication. |
| Publisher uploads incomplete or replaced assets | M | H | Draft-first upload; re-download verification; pinned IDs/digests; no same-version replacement. |
| Service cannot read the private release | M | M | Same-user repository/asset preflight, explicit SSO/auth errors, no restart on download failure. |
| Node update damages a colocated checkout Host | M | H | Node-only immutable runtime; never reset/install/build the shared checkout. |
| Old Node silently ignores target version | M | H | New capability and distinct request; legacy updater excluded from versioned rollout. |
| New work starts after the Host's initial idle check | M | H | Atomic Host admission fence plus Node-local fence and final inventory check. |
| Outbox events vanish on process exit | M | H | Stop/event barrier before shutdown; refuse exit when acknowledgements are incomplete. |
| Crash during activation strands the machine | M | H | Stable dependency-free supervisor, single-writer journal, retained known-good release, bounded recovery. |
| Same version label reports success for wrong bytes | M | H | Verify full release identity and attempt, not only version/SHA or reconnect. |
| Host/tunnel outage triggers rollback storm | M | H | Separate local readiness from connectivity; persist attempts and pause rollout. |
| Task migration breaks ownership or reenables a stopped service | M | H | Old-manifest validation, recoverable task migration, preserve enabled state, explicit start authority. |
| Bad publisher or repository compromise distributes malicious code | L | H | Restricted publisher rights and fixed repository trust; checksums are not claimed to solve publisher compromise; signing/policy review is an open release gate. |

### Prototypes <!-- optional -->

No new runtime prototype was executed for this design document.

| **Prototype no** | **Evaluation description** | **Reference(s)** | **Learnings** |
| --- | --- | --- | --- |
| 1 | Package Windows x64 Node and run outside checkout without Git/npm/build tools in the launch path. | Existing package exports, config assets, agent catalog. | Pending; must prove dependency and asset closure. |
| 2 | Download a private draft/test release as the actual login-task user with approved access. | Existing same-user preflight and GitHub CLI. | Pending; must distinguish general login from asset access. |
| 3 | Switch releases and inject crashes after every journal transition inside the Windows job. | Existing login runtime tests and supervisor tests. | Pending; must prove no detached child or restart-budget reset. |
| 4 | Migrate an owned v1 task and recover from partial migration. | Existing task ownership/install tests. | Pending; must preserve disabled state and reject foreign tasks. |

## Tracking open questions

These are approval/implementation gates, not missing assumptions to silently fill.

| **Open question no** | **Open issue description** | **Findings and references** | **Resolution reached** |
| --- | --- | --- | --- |
| 1 | Does organization policy permit private release publication and automated asset downloads? | Hosted Actions runners are reported disabled; that is a separate permission. | Verify before publishing a pilot artifact. |
| 2 | Who is authorized to publish, and is signing/attestation required? | Manual provenance and repository trust are the v1 proposal, not independent signing. | Owner/security-policy decision before automatic enablement. |
| 3 | Is Windows x64 sufficient for the first managed rollout? | Existing manual Host/Node modes support broader platforms. | Proposed initial scope; unsupported platforms stay manual. |
| 4 | What Host protocol/version range is certified for the first release? | `0.x` versions and capabilities do not automatically guarantee compatibility. | Establish compatibility fixtures for the actual release. |
| 5 | Which archive/dependency-materialization implementation meets Windows containment and packaging requirements? | No new package selected by this document. | Resolve in prototype 1; prefer an existing reviewed implementation. |
| 6 | Which existing `.env` options need migration beyond persisted settings? | Current runner loads the checkout `.env`. | Inventory supported options during migration implementation; fail explicitly on unresolved required values. |
| 7 | Are the initial download/startup/disk budgets appropriate on real machines? | Values above are proposed and unmeasured. | Measure with representative artifacts before expanding beyond canary. |
| 8 | When should idle sessions be checkpointed automatically? | Current sessions can remain live indefinitely. | Out of scope; safe automatic updates may remain deferred. |
| 9 | How should launcher updates be distributed later? | Application bundles must not overwrite the running stable bootstrap. | Manual compatible migration in v1; independent follow-up design. |

# Common core checklist

**Quality(verification)** — Turn the desired outcomes into deterministic tests.

- [ ] Unit: SemVer precedence, invalid versions, prerelease channels, same-version
  different identity, no downgrade, target pinning, and compatibility checks.
- [ ] Unit: manifest validation, absolute/traversal/case/ADS/link extraction rejection,
  byte/entry limits, path containment, and redaction.
- [ ] Unit: duplicate requests, stale status sequence, mismatched operation/attempt,
  and replay of commit/outcome acknowledgements.
- [ ] Integration: real prepared bundle outside the repository, with protocol exports,
  config assets, shipped agents, runtime dependencies, and notices present.
- [ ] Integration: Host operation persistence, dispatch fences across every entry
  point, stop acknowledgement, final-event barrier, and outbox reconciliation.
- [ ] Integration: crash/cancel/power-loss simulation at every activation-journal
  boundary, wrong-build reconnect, failed rollback, and bounded attempts.
- [ ] Windows service: actual same-user download, task migration, job containment,
  exit-75 activation, disabled-state preservation, log rotation, and no orphan child.
- [ ] Fleet: npm-run Host plus bundled Node, one canary at a time, busy/offline skips,
  catalog auth failure, and Host restart during an update.
- [ ] Co-location: updating a managed Node leaves Host checkout, dependencies, database,
  listener, and task unchanged.
- [ ] Regression: existing checkout startup, manual Node mode, enrollment, settings
  precedence, custom agents, private tunnels, and service ownership checks.
- [ ] Approved manual sign-out/reboot/sign-in exercise confirms startup occurs after
  sign-in. Automated tests never reboot or sign out the operator.

WSR/cluster-only Fabric environments are not applicable. Equivalent fleet-level
scenarios run in isolated local/mock environments and an approved Windows canary.
Mock sessions validate the transport/lifecycle without sending paid model prompts;
authentication probes remain nonprompting.

**External dependencies** — GitHub Releases/CLI, approved private repository access,
Node.js, Copilot CLI, and optional Dev Tunnels remain external. Publication/download
restrictions, SSO expiry, unavailable release assets, TLS/proxy failures, platform
dependency differences, and disk policy must produce classified errors. No service
silently installs missing external tools.

**Supportability** — Persist structured operation records and supervisor receipts.
Logs include operation ID, version/commit/digests, stage, attempt, durations, exit
codes, and safe failure codes, not credentials. Support must distinguish preparation
failure, local startup failure, connectivity delay, rollback, and launcher migration
failure. Extend existing status/log commands with both task state and application
release/readiness; native task "running" alone is not health.

**Performance** — Measure bundle compressed/expanded size, stage duration, heartbeat
gaps while downloading, drain time, and activation-to-readiness/reconnect latency.
In the isolated no-network-delay test, heartbeat cadence must remain within the
existing Host liveness allowance and local readiness within the proposed 60-second
budget. Verify bounded memory streaming rather than loading archives into memory.
If a target exceeds limits, fail preparation rather than consume unbounded resources.

**Fundamentals** — Fabric-specific assessment/deployment gates are not applicable to
this standalone project. Apply least privilege, authenticated transport, explicit
trust, bounded resource usage, rollback safety, sensitive-log handling, dependency
license review, and accessible status/error messaging. Organization requirements
override the proposed publisher trust model.

**Execution Plan** — Implement in dependency order:

| Phase | Scope and main surfaces | Depends on | Completion gate |
| --- | --- | --- | --- |
| P1 | Release identity/schema and fixtures in protocol/runtime; version comparison and compatibility contracts. | None | Exact identity semantics and mixed-version tests defined. |
| P2 | Proposed prepare/publish scripts, runtime dependency packaging, clean bundle checks, and private-release runbook. | P1 | Manually produced/re-downloaded artifact runs outside checkout. |
| P3 | Managed runtime/supervisor/journal, local activation/rollback, and structured readiness. | P1, P2 | Fault-injection recovery passes without modifying active files. |
| P4 | v2 login manifest, installed management path, one-time migration, and actual-user preflight. | P3 | Canary task migrates/restarts with same identity and disabled-state semantics. |
| P5 | New protocol requests, durable Host operations, Node updater, fences/event barrier, and verified commit. | P1, P3 | One end-to-end exact-target update survives Host/Node interruptions. |
| P6 | Existing Nodes UI/hooks, release approval, eligibility, durable progress, and local diagnostics. | P5 | Operator can understand/drive update and recovery without guessing. |
| P7 | Opt-in automatic polling/rollout, bounded retry, docs, accessibility, and canary expansion. | P2, P4, P5, P6 | Approved target rolls through safe Nodes and pauses on failures. |

Write contract and failure tests before implementation. Manual publication and a
single manual Node update are usable milestones; do not make Host self-update a
prerequisite.

**Engineering Wiki updates** — Update repository documentation, not a remote wiki
as part of this task: `README.md`, `README.zh-CN.md`, `ARCHITECTURE.md`,
`docs/windows-login-startup.md`, and the update flow documentation/diagram. Mark
the superseded NPX decisions clearly when implementation ships. Document publishing,
private authentication, migration, rollback, and the idle-session limitation.

# Backend (workload) checklist <!-- optional -->

- **State/Metadata** — Host SQLite owns target approval and operation history; local
  activation journal owns actual executable selection. Neither can infer the other's
  success from a missing record. Reconcile by operation/attempt/release identity,
  retain bounded receipts, and validate versioned schemas before use.
- **Config options and resource consumption** — Limits are listed in section 10.
  Validate bounds centrally and expose only operator-relevant policy controls.
  Keep runtime roots local, explicit, writable by the service user, and separate
  from identity and project workspaces.
- **MWC DMS workload - Coding Best Practices** — MWC/DMS is not used. Apply the
  relevant asynchronous-operation principle: HTTP requests validate and persist
  quickly, return `202`/operation ID, and do not hold a request open for download,
  draining, or service restart.
- **Warehouse MWC workloads - Integration** — Not applicable. Reuse Fleet's shared
  protocol schemas, authenticated Node channel, SQLite transaction conventions,
  existing dispatch boundary, and Windows task/job infrastructure.
- **Public/Other APIs** — Fleet APIs remain protected by existing authentication and
  request guards. Use schema-validated policy/target inputs and machine-readable
  errors. No unauthenticated update endpoint or arbitrary artifact URL is added.
- **MWC Error handling** — MWC-specific framework is not applicable. Use Fleet logging
  and explicit result conventions: no broad catch with a success-shaped fallback,
  silent invalid-version default, or unverified "update finished" response.

# Frontend (UX) checklist <!-- optional -->

- **Integration with Fabric Platform** — Not applicable; integrate with Fleet's
  existing Settings/Nodes components and catalog/fleet hooks.
- **Impact on external Fabric UX artifacts/extensions** — None. No shared Fabric UX
  package or extension changes are proposed.
- **Corner cases** — Cover unknown/development builds, ahead-of-target Nodes,
  unsupported platforms, a deleted/changed release, stale catalog, offline Nodes,
  indefinitely live idle sessions, expired credentials, Host restart, and partial
  service migration.
- **Error-handling** — Show the failed stage, retained running version, whether work
  is fenced, and the allowed next action. Do not label rollback as success or hide
  `awaiting_host` behind an endless generic restart spinner.
- **UX extension telemetry** — No Fabric extension events. Record Fleet actions and
  operation transitions with bounded structured fields; do not send private release
  or credential information to a new analytics service.
- **Config options and resource consumption** — Browser keeps presentation state
  only; persist update policy/history on the Host. Bound progress details and
  operation history responses.
- **Fabric UX Feature Switches** — Fabric switches are not applicable. Ship protocol
  parsing/storage and managed capability first; enable UI/actions only when supported.
  Keep automatic rollout explicitly opt-in.
- **Accessibility** — Use existing components, keyboard-reachable actions, descriptive
  labels, focus-safe confirmations, and announced progress/error text. Do not rely
  on color alone. Run the repository-appropriate accessibility checks before broad
  enablement; Fabric MSIT enablement is not part of this project.

## Appendix A – Examples of feature execution plans <!-- optional -->

These are the concrete backend/frontend breakdowns for the phases above.

### Backend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Protocol release/operation schemas, compatibility tests, and durable Host records. | P1 |
| 2 | Packaging scripts and verified direct download/staging implementation. | P1, P2 |
| 3 | Stable supervisor, recovery journal, and ownership-safe service migration. | P3, P4 |
| 4 | Admission fences, event barrier, activation/commit handshake, and fault tests. | P5 |
| 5 | Rollout policy, retry/retention bounds, operational metrics, and canary proof. | P7 |

### Frontend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Release relation/eligibility fixtures and labels. | P1 |
| 2 | Approved-target picker and per-Node exact-target operation UI. | P5 |
| 3 | Persisted progress/recovery states and session-stop confirmation. | P5, P6 |
| 4 | Automatic-policy opt-in, rollout pause, and catalog/auth errors. | P7 |
| 5 | Keyboard/accessibility checks and English/Chinese operator documentation. | P6, P7 |
