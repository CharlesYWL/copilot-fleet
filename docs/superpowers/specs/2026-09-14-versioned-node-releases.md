---
filepath: "docs/superpowers/specs/2026-09-14-versioned-node-releases.md"
tags:
  - copilot-fleet
  - versioned-updates
  - automated-releases
  - incremental-delivery
  - windows-login-startup
---

# Versioned Host and Node releases with incremental automated delivery

**Area**: Copilot Fleet / Distribution and Host/Node lifecycle\
**Engineer**: TBD  
**EM owner**: TBD  
**Architect**: TBD  
**Program Manager**: Not assigned  
**Date**: 2026-09-14  
**Updated**: 2026-10-12\
**Status**: Proposed incremental delivery plan; root-version declaration is implemented, but release production and managed-update phases below are not\
**Work item**: Not assigned  
**Source baseline**: `0757f34caf710404896f9800960a3b75be655da4`, historical workspace versions `0.8.0`; current version source is root `package.json` (`0.9.0`)

## Related documents

| **Document** | **Link** |
| --- | --- |
| **Feature Lifecycle Process** | [Template process reference](https://dev.azure.com/powerbi/AI/_wiki/wikis/AI.wiki/90809/Feature-Lifecycle-Process); Fleet release approval is defined below, not a Fabric deployment. |
| **PM Functional spec** | This document captures the agreed direction: automatic versioning and packaging without Actions, followed by incremental Node and Host bundle updates. |
| **UX Design** | No separate mockup; operator behavior is specified under Preferred option. |
| Current architecture | [ARCHITECTURE.md](../../../ARCHITECTURE.md) |
| Current update instructions | [README.md](../../guide/operations.md#keeping-nodes-up-to-date) |
| Supported service mode | [Windows login startup](../../windows-login-startup.md) |
| Earlier distribution proposal | [NPX distribution design](2026-08-21-npx-distribution-design.md) |
| Manual release creation | [GitHub CLI: release create](https://cli.github.com/manual/gh_release_create) |
| Publish a draft | [GitHub CLI: release edit](https://cli.github.com/manual/gh_release_edit) |
| Private authenticated CLI usage | [GitHub CLI: auth login](https://cli.github.com/manual/gh_auth_login) |
| Exact-tag asset downloads | [GitHub CLI: release download](https://cli.github.com/manual/gh_release_download) |
| Optional approved CI producer | [Azure Pipelines: GitHub Enterprise Server integration](https://learn.microsoft.com/en-us/azure/devops/pipelines/repos/github-enterprise?view=azure-devops); connection and agent choices depend on repository hosting/reachability. |

This proposal supersedes the earlier NPX proposal's SHA-based update comparison and
untargeted `@latest` update decisions for managed bundles. The October revision
extends the original Node-only/manual-publication proposal to automated production
and later Host updates. The October 12 revision makes the root manifest the sole
version source and separates release freshness from wire compatibility. It does not
implement NPX distribution, nor change the accepted login-start authentication model.

## Feature desired outcome

An approved release job can assign a Fleet version, build exact-source Host and Node
packages once, and publish verified assets without GitHub Actions. An operator can
then approve an exact release for deployment. Eligible Windows service Nodes, and
later a managed Host, update without compiling on each machine, interrupting
unapproved work, losing identities/data, or activating a partially prepared runtime.

**GitHub Actions is not a dependency.** The operator reports that Actions is
unavailable for this private Microsoft-internal repository. Start by running the
release scripts manually, then schedule the same scripts on a dedicated trusted
Windows build machine using Task Scheduler. An approved Azure Pipeline may replace
that producer later; it is not required for the initial delivery. This is not a
policy workaround: publication, automation credentials, scheduled jobs, and release
asset access each require the organization's approval.

Deliver this in small, separately reviewable changes. Packaging and automatic
publication must become useful before managed activation is complete. A phase must
not require all later phases to merge, and no early phase silently switches an
existing checkout to a new update mechanism. The Execution Plan defines dependencies,
completion gates, and explicit stop points.

The first managed-update combination remains:

- Host: existing checkout, built and started through npm; retain today's checkout
  updater until the later Host milestones.
- Node: prebuilt Windows x64 bundle, launched by the existing same-user login task
  through a stable, version-aware supervisor.
- Distribution: verified assets in the same private GitHub repository, first
  published manually and then by the approved scheduled producer.
- Update target: an explicitly approved, immutable release identity selected by the
  Host, not the newest branch commit or a moving `latest` alias.

The later supported combination is a managed Host plus managed Nodes. Artifacts
built together use one Fleet release version and component-specific archives;
compatible older Nodes may remain connected while the Host advances. Building a Host archive does
not enable Host activation; state migration, backup/recovery, launch ownership, and
verified restart are separate delivery gates.

This is a deterministic systems feature, not an AI evaluation. Its repeatable
evaluation is an isolated Host/Node update exercise with injected failures.

| Outcome | Repeatable evaluation | Required result |
| --- | --- | --- |
| Automatic version production | Run the producer twice, race two invocations, and resume after a failed build/upload. | One reserved version/release per source selection; no duplicate PR/tag, skipped verification, or same-version replacement. |
| Incremental adoption | Install each phase on an existing checkout-based fleet. | Existing startup/update paths remain usable; unsupported bundle actions stay unavailable. |
| Exact-version deployment | Publish/select A, then publish newer B during A's rollout. | Every operation for A installs A's pinned bytes, never B. |
| Mixed installation support | Checkout Host and managed Node exchange inventory, execute a mock session, and update. | Installation type does not prevent compatible protocol operation. |
| Mixed release support | Upgrade the Host first while an older Node remains connected, then update that Node to the approved target. | Report "update available, still compatible"; preserve baseline execution and gate unsupported features independently of freshness. |
| Safe automation | Attempt an automatic update with running, idle, and permission-waiting sessions. | Zero unapproved session termination; activation waits for zero live sessions. |
| Durable service restart | Update a real same-user login task and reconnect. | Same SID, task, `nodeId`, keys, settings, and workspace placements; no detached window. |
| Failure isolation | Fail download, verification, extraction, or preparation. | Active release and its dependencies are untouched and remain restartable. |
| Recovery | Crash the candidate or interrupt each journal transition. | A known-good release starts, or an explicit recoverable state is reported; no unbounded loop. |
| Honest completion | Reconnect an old/wrong build or restart the Host mid-operation. | No false success; operation state survives and requires matching release confirmation. |
| Safe Host replacement | Fail backup, state preflight, candidate startup, and post-restart verification. | Preserve Host identity/database; recover compatibly or report `needs_attention`, never discard acknowledged writes to claim rollback. |

All safety cases must pass. Proposed performance budgets and rollout gates appear
in the checklists below. No prototype results or performance measurements are
claimed by this design.

## Terminologies <!-- optional -->

| Term | Meaning |
| --- | --- |
| npm-run Host | A cloned checkout using the repository's npm scripts, not a published npm/NPX package. |
| Release version | Canonical SemVer declared only in root `package.json`, for example `0.9.0`; each artifact embeds the version from its selected source. |
| Release tag | Git reference `v0.9.1`, resolving to a recorded full source commit whose root version is `0.9.1`. |
| Protocol epoch | Explicit application wire-contract generation, independent of release SemVer; change it for a breaking contract, not every release. |
| Capability | A negotiated optional feature or update operation; peers must not send unsupported feature-specific messages. |
| Release producer | Approved manual command or scheduled job that plans versions, builds, verifies, and publishes; it never authorizes deployment. |
| Bundle | Compiled component code, production dependencies, assets, and metadata in an archive; not necessarily an executable. |
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
| Shared release scripts, first manual then scheduled on a trusted build machine | Exact Host/Node targets, no runtime build, same repository access model, no Actions dependency; incremental adoption. | Requires approved producer ownership/authentication, packaging, and durable release receipts. | **Preferred.** |
| Publish npm packages and use a persistent runtime prefix | Familiar version distribution; can support NPX onboarding. | Adds registry/package access and publication work unrelated to the immediate need. | Defer. |
| Approved Azure Pipelines producer | Runs the same scripts with CI scheduling and managed build history. | Requires access, an approved connection, and an agent that can reach the repository. | Optional replacement for the scheduled producer. |
| Self-hosted Actions runner | Could execute existing Actions workflows. | An unavailable Actions service is not fixed merely by supplying a runner; policy approval is separate. | Not the proposed route. |

## Preferred option

### 1. Scope and non-goals

Delivery has four usable milestones, not one large release:

1. Version planning, clean Node/Host packaging, and verified publication; existing
   updaters remain unchanged.
2. Exact-target manual Node updates and one-time service migration.
3. Opt-in automatic Node rollout of an approved target.
4. Managed Host state/launcher migration and safe exact-target Host updates;
   unattended Host activation is a separate, last opt-in.

Initial packaging targets Windows x64. Early releases may contain only the Node
artifact; a later new version adds the Host artifact after its packaging gate.
Do not append assets to an already published version. The catalog reports component
availability independently of whether that component supports managed activation.

It does **not** deliver:

- Automatic replacement of a development checkout, automatic approval/merge of a
  release PR, or bypass of repository branch protection.
- A signed-out Windows boot service, elevation, a different account, or credential
  export.
- Published npm/NPX packages, delta downloads, or an artifact proxy on the Host.
- Installation/updating of Node.js, GitHub CLI, Copilot CLI, Dev Tunnels, or other
  external tools.
- Automatic checkpoint/stop/resume of idle sessions, or a zero-downtime agent restart.
- Managed bundles for Unix or Windows ARM64 before those platforms are separately
  packaged and proven.
- Unattended update of the installed bootstrap itself.

Host bundle updates are in this plan but are not prerequisites for any Node
milestone. Host activation must wait for the state/backup/launcher gates in section
13; automatic production is never permission to restart either component.

### 2. Current behavior and changes required

| Source / symbol | Observed behavior | Required change |
| --- | --- | --- |
| Root/workspace manifests and root lockfile | Root `package.json` declares `0.9.0`; private Host, Node, and protocol manifests omit `version`; internal protocol dependencies use `*` and the lockfile links the local workspace. No release-planning/packaging scripts exist. | Plan root-version/lockfile changes through a release PR, followed by exact-tag packaging and publication; do not reintroduce manually synchronized workspace versions. |
| `packages/protocol/src/runtime.ts`: `packageVersion`, `gitRevision` | Reports the root release version and live checkout SHA separately; package-scoped asset/data anchors remain unchanged. | Add immutable build/release identity that belongs to the running artifact; preserve SHA as diagnostic information. |
| `packages/protocol/src/index.ts`: `nodeUpdateState` | Compares SHA equality and `self-update` capability. | Compare trusted release identity and SemVer against the approved target; distinguish ahead, unknown, incompatible, and legacy. |
| `packages/protocol/src/updater.ts`: `updateCheckout`; `apps/node/src/updater.ts`: wrapper | Shared checkout updater fetches, resets the tracking branch, installs, and builds in place; the Node wrapper selects `build:node`. | Preserve the legacy path; managed components stage pinned bundles without resetting/building their active runtime. |
| `apps/host/src/self-update.ts`, `scripts/self-update.mjs` | Existing launcher/login-service path performs a checkout update and verifies the restarted Host/colocated Node. | Retain that behavior while adding a separately gated managed-Host path with state-safe recovery. |
| `apps/node/src/main.ts`: `runSelfUpdate` | Saves settings, shuts down, and exits `75`; its updating flag only excludes another update. | Add local execution fencing, durable handoff, correlated readiness, and event-drain requirements. |
| `apps/node/supervisor.mjs`: `resolveTarget`, `start` | Resolves one checkout target; handles exit `75` and a restart-storm bound. | Keep checkout behavior; add a stable managed supervisor that re-resolves journal state on each start. |
| `scripts/login-service-runner.mjs`: `run` | Imports checkout modules, loads checkout `.env`, and starts the Node supervisor. | Add a managed launch path independent of checkout files and dependencies. |
| `scripts/login-service-cli.mjs`: `manage` | Copies launcher/controller files and records `repositoryPath` in a v1 manifest. | Explicit ownership-checked v1-to-v2 migration, preserving task state and identity. |
| `scripts/windows-login-task.ps1`: ownership validation and task action | Checks SID, exact action, working directory, and settings; stop disables recovery. | Support old/new manifest forms without weakening ownership checks. |
| `scripts/windows-login-job.ps1` | Contains descendants in a kill-on-close job. | Preserve containment; do not escape the job for updates. |
| `apps/host/src/fleet-service.ts`: `requestUpdate`, `settleUpdateOnReconnect` | Busy check occurs on the Host; in-flight updates are in memory and reconnect verifies the announced build/revision. | Persist correlated operations and require the actual target release and commit acknowledgement. |
| `apps/node/src/outbox.ts`: `EventOutbox` | Reconnect batches are bounded and retained in memory until acknowledged. | Drain/acknowledge before planned exit; do not claim they survive process termination. |
| `apps/node/src/config-assets.ts`, `agent-catalog.ts` | Config assets and shipped agents live outside `dist`. | Include `public` and `agents` in packaging and clean-machine checks. |
| `apps/host/src/config.ts`: `resolveDatabasePath` | Host database defaults relative to its package; an absolute configured path is supported. | Leave checkout behavior unchanged; require a stable absolute data path before managed Host migration/activation. |

The old updater leaves the previous process alive on a build failure, but may have
already changed its files/dependencies. A subsequent service restart can therefore
fail. Keeping the active release immutable is a core requirement, not just a
packaging convenience.

### 3. Ownership and compatibility

| Owner | Responsibility |
| --- | --- |
| Publisher / scheduled producer | Plan the root release version through the approved PR/tag process, build/check exact source, and publish complete releases under an explicit publication policy. |
| Host | Authenticate catalog reads, approve component targets, persist operations, gate dispatch, and verify Node completion; later request its own update through an external launcher. |
| Node application | Validate requests, prepare candidate files, fence local execution, drain events, and report correlated readiness. |
| Managed supervisor | Sole writer of its component's activation journal; own child lifetime, launch selection, promotion, and bounded compatible rollback. |
| Windows login task | Start after sign-in, preserve user context, contain descendants, and recover an unexpected launcher crash. |

Installation type is not protocol compatibility:

| Host | Node | Contract |
| --- | --- | --- |
| Compatible checkout Host | Managed bundle Node | Primary supported combination. |
| Compatible checkout Host | Checkout Node | Existing execution remains; versioned managed updates require migration. |
| Older Host | New managed Node | Execution only if the wire protocol remains compatible; no new update messages until negotiated. |
| Development Host | Managed release Node | Explicit compatible target allowed; unpublished changes are not treated as a published release. |
| Managed packaged Host | Managed bundle Node | Later milestone; same network contract plus Host state/launcher safety gates. |

Compatibility is explicit: declare an application protocol epoch, required
capabilities, certified peer version ranges, and an update-protocol version.
Capabilities continue gating feature-specific messages. SemVer alone does not prove
wire compatibility, particularly for `0.x` minor releases.

Release equality is not required for ordinary Host/Node communication. Each artifact
includes its own compiled protocol package from the tagged source; that package
is not a separately deployed service or a version the peer must load. The private
workspace dependency `*` is a build-time link, not permission to install an arbitrary
protocol library or declare any deployed release compatible.

On authenticated connection, each managed peer reports its immutable release identity,
application protocol epoch, and capabilities. The Host advertises its supported peer
epochs and evaluates the certified compatibility metadata. Optional inventory fields
must remain parseable by supported older peers. Missing release identity means legacy
or unknown freshness, not an invented release or proof of incompatibility.

Keep three decisions separate:

- **Freshness:** compare the running Node identity/version with the explicitly approved
  Node target, not automatically with the Host version or GitHub's moving `latest`.
- **Execution compatibility:** require a supported wire epoch and baseline contract;
  negotiate optional capabilities before sending new feature commands.
- **Update eligibility:** additionally require compatible target metadata, updater/
  launcher capabilities, installation kind, platform, credentials, and safe session state.

For example, a Host built as `1.0.1` and a Node built as `1.0.0`, both speaking a
certified epoch 1 contract, may execute ordinary work while the Node is behind the
approved `1.0.1` target. An unsupported feature stays disabled until its capability
appears. A wire-incompatible peer must not receive normal execution commands; an
update is possible only through a separately compatible negotiated management
contract, otherwise report a manual upgrade requirement. Never use an incompatible
application message as the way to repair that incompatibility.

Protocol epochs are a compatibility declaration backed by mixed-version fixtures.
A patch version, shared major number, or identical epoch alone is not test evidence.
Do not bump the epoch for an additive optional capability; do not keep an epoch
unchanged after a breaking message change without backward-compatible parsing.

A release Host defaults its target only when its build identity is verified as a
published release. A checkout with the same `package.json` version but extra or
uncommitted changes is a development build. Build metadata must record that fact;
live Git HEAD must not relabel an already-running build after files change.

Development Hosts need a deliberate target selection and a compatible declared
protocol. Untested development compatibility does not qualify for unattended rollout.

### 4. Release production and automation without Actions

#### 4.1 Version planning

All script names in this section are **proposed**, not commands implemented today.

Start with a manually invoked `release:plan`; schedule it only after its behavior is
proven. The initial rule is a patch increment for unreleased changes on `main`
(`0.9.0` to `0.9.1`), with an explicit reviewed choice for minor/major increments.
Do not infer breaking-change compatibility from commit wording. Protocol and data
compatibility remain independent release checks.

The planner updates only the root `package.json` version and its generated
`package-lock.json` metadata. The three private workspace manifests omit versions;
Host and Node keep `@fleet/protocol: "*"` resolved to the local workspace by the
lockfile. There is no version synchronization script or independent protocol release.
It opens a release PR through the normal protected-branch process.
It does not bump every developer commit or push directly to protected `main`.
Approval/merge is a human/repository-policy gate, not a side effect of scheduling.

Record the selected source baseline, reserved version, PR, merged version commit,
tag, build receipts, and eventual release identity in the producer's durable state.
Allow only one active release plan for this repository. Repeated invocations reuse
the pending plan rather than reserve another version. A merged version commit is
tagged at its exact full SHA; newer `main` commits belong to the next release, not
the build already selected. Recheck the root version, matching tag, lockfile, and
local workspace resolution at the selected commit.

The producer stamps the selected root version and full source commit into each
component's immutable build metadata. Protocol epoch/capabilities are separate
contract declarations. If an executable embeds everything, embed that metadata in
the executable; an archive may carry it inside its verified, immutable release
directory. Never derive the running release from a mutable checkout manifest, a
filename alone, Git HEAD after startup, or an environment version override. Verify
the stamped version agrees with the root manifest, tag, and release manifest before
publication. Any package versions required by future external packaging tooling
must be generated from that same root value, not manually maintained source copies.

An unchanged source selection is a no-op. Release-only version/lockfile commits are
not new application changes: compare against the recorded plan/published baseline
so the producer's own PR cannot trigger an endless sequence of patch releases.
Build/upload failures resume the recorded release attempt only when it is still
unpublished and its identity matches. Never overwrite a published version or advance
a publication-success marker on failure.

#### 4.2 Publisher sequence

1. Merge the root-version PR and create/push its matching release tag
   through the approved repository process; do not fabricate a tag from current
   `main` while publishing.
2. In a disposable clean build checkout, resolve that tag to a full commit and verify
   its root version and lockfile. Never build a release from the actively running Host tree
   or package a dirty workspace.
3. Run `npm ci`, the repository verification suite, and the platform-specific
   packaging checks. A script may create output only under an explicit build/output
   directory; it must not reset the operator's checkout.
4. Produce allowlisted component archives and `release.json`; record the commit,
   lockfile digest, build tool versions, timestamp, and artifact digests. Required
   components are explicit for this attempt, not whatever files happen to exist.
5. Run each unpacked bundle in an isolated test profile outside any checkout.
6. Use the GitHub web UI or `gh` to create a **draft** release for the existing tag
   and upload the required assets.
7. Re-download and verify the uploaded manifest and each required asset. Confirm
   the remote tag resolves to the recorded commit, not merely a branch named in
   `target_commitish`.
8. Publish the draft only after completeness checks and explicit publisher approval.
   After the scheduled-production gate, an approved publication policy may authorize
   this step without a prompt. Host/Nodes still ignore drafts and unsupported
   prereleases; publication never approves a deployment target.

Proposed entry points:

| Script | Inputs | Output / side effects |
| --- | --- | --- |
| `release:plan` | Source branch/baseline, default patch or reviewed increment, durable plan identity. | Root version/lockfile change and release PR; no branch-protection bypass or automatic merge. |
| `release:prepare` | Existing tag, component set, supported target platform, output directory. | Bundles, manifest, and local verification receipts; no remote writes. |
| `release:publish` | Prepared output, matching release receipt, explicit approval or approved publication policy. | Create/upload/verify draft, then publish; no automatic version bump, commit, or push. |
| `release:run` | Existing release plan/receipt and approved producer configuration. | Resume eligible planning/build/publication steps; wait visibly at unmet approval gates; no runtime deployment. |

The same scripts can be driven by an approved CI system later without changing
download or activation contracts. Manual invocation remains supported for recovery.

#### 4.3 Bundle contents

Illustrative asset names once both component packaging gates have passed:

- `release.json`
- `fleet-node-0.9.1-win32-x64.zip`
- `fleet-host-0.9.1-win32-x64.zip`

Node-only releases explicitly omit the Host artifact. When Host packaging becomes
available, publish it in a new version; never backfill the prior release.

GitHub's generated source-code archive is **not** either bundle. A managed component
must not run `npm install`, `npm ci`, or a compiler when activating it.

Retain a recognizable package layout inside the Node archive:

- Root runtime metadata and package manifest.
- `apps\node\package.json`, `apps\node\dist`, `apps\node\public`,
  `apps\node\agents`.
- The built `@fleet/protocol` package and the transitive production dependency closure.
- Applicable third-party licenses/notices and internal release/build metadata.

The Host archive contains `apps\host\package.json`, built server and UI output,
required runtime assets, the built protocol package, and its own transitive
production dependency closure/notices. Prove its server health endpoint and UI
asset loading from an isolated absolute data directory. A Host-only bundle does
not imply that the existing combined Host+Node launcher can start an unbundled Node.
Combined installation support must select separate verified component runtimes.

The same version/identity rules apply if a later packaging milestone produces
standalone executables instead of these archives. An `.exe` version tag is not a
replacement for embedded metadata, digest verification, or readiness confirmation.
Standalone executable packaging is not introduced by the root-version change.

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

#### 4.4 Release manifest

Illustrative schema; hash placeholders below are not valid release values:

```json
{
  "schemaVersion": 1,
  "repository": "charlesyin_microsoft/copilot-fleet",
  "version": "0.9.1",
  "tag": "v0.9.1",
  "sourceCommit": "<full 40-character commit>",
  "channel": "stable",
  "updateProtocolVersion": 1,
  "minimumLauncherVersion": "1.0.0",
  "compatibility": {
    "protocolEpoch": 1,
    "supportedProtocolEpochs": [1],
    "hostVersionRange": ">=0.9.0 <0.10.0",
    "nodeVersionRange": ">=0.9.0 <0.10.0",
    "requiredHostCapabilities": ["versioned-node-update-v1"],
    "requiredNodeCapabilities": ["versioned-node-update-v1"]
  },
  "artifacts": [
    {
      "component": "node",
      "platform": "win32",
      "arch": "x64",
      "name": "fleet-node-0.9.1-win32-x64.zip",
      "sizeBytes": 123456,
      "unpackedSizeBytes": 456789,
      "sha256": "<64-character lowercase hex digest>",
      "nodeEngine": ">=22.5.0",
      "entryPoint": "apps/node/dist/main.js"
    },
    {
      "component": "host",
      "platform": "win32",
      "arch": "x64",
      "name": "fleet-host-0.9.1-win32-x64.zip",
      "sizeBytes": 234567,
      "unpackedSizeBytes": 567890,
      "sha256": "<64-character lowercase hex digest>",
      "nodeEngine": ">=22.5.0",
      "entryPoint": "apps/host/dist/server/server.js"
    }
  ]
}
```

Schema paths use archive-relative separators; runtime resolution uses the platform's
path APIs. The entry point is a validated relative path, never a shell command.
Real runtime ranges must reflect validation evidence, not be copied blindly from
this example. Host/Node ranges certify candidate deployment against retained peers;
the required updater capabilities gate managed updates, not ordinary execution.
Protocol-epoch support and feature negotiation separately govern the wire contract.
Component/platform entries must be unique. The example illustrates
packaging, not activation authority: Host activation additionally requires certified
state-schema compatibility and backup/recovery evidence from section 13. Missing
Host activation metadata makes that artifact ineligible, not implicitly safe.

`release.json` is hashed as raw bytes. The Host pins that digest plus the GitHub
release/asset IDs returned by authenticated discovery. The archive contains internal
build metadata but not its own archive digest, avoiding a circular checksum.

Changing release contents requires a new version. If repository-supported release
immutability is available, enable it through the normal approval process; otherwise
enforce the rule in publishing and reject digest/ID drift in the updater.

#### 4.5 Scheduled producer

Use a dedicated trusted build machine and a separate clean disposable build checkout,
never the active Host/Node checkout. First prove the scripts manually. Then install
an approved Task Scheduler job under an explicitly authorized publisher identity
with existing repository access. Do not reuse a live Fleet task, widen its account
permissions, or store credentials in the repository or release assets.

Initially poll `main` every six hours and permit an operator-triggered run. Use a
repository-level producer lock and durable receipts so overlapping ticks, reboot,
and a retry cannot produce competing versions or publish partial output. Scheduling
is unattended orchestration of deterministic scripts, not an AI session.

Stop visibly when PR approval, policy, credentials, verification, or required
artifacts are missing. Preserve structured failure logs and retry only classified
transient failures with bounded backoff. A failed job must not report a published
release or schedule deployment. Keep the producer's run history and state outside
the disposable build tree, and retain enough receipts to reconcile remote tags,
drafts, and publication after a crash.

Once manual draft verification has passed, approve publication automation separately
from deployment automation. An approved Azure Pipeline can later run these same
commands with the same receipts/identity guarantees; its availability and network
access are gates, not assumptions.

#### 4.6 Trust boundary

For v1, trust is rooted in the fixed private GitHub repository, authenticated TLS,
approved publisher access, and the administrator's selected manifest digest.
A checksum detects corruption or replacement relative to that pinned manifest;
it does **not** independently authenticate a malicious publisher who can replace
both manifest and archive.

Do not claim locally scheduled bundles have CI attestations or independent code
signatures. Record the actual producer/provenance honestly. If policy requires publisher
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
- Host updates remain an explicit operation until the final Host-automation gate.
  Node automatic policy must not authorize a Host restart.
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

The Host returns/publishes release relation, execution compatibility, and update
eligibility independently so both the fleet UI and the Node's local status can
show "update available, still compatible". A Node never queries a moving `latest`
alias to choose its own target. Advancing the Host does not silently approve a new
Node target; existing publication/deployment approval gates remain in force.

Eligibility separately reports unsupported platform, incompatible protocol, old
launcher, legacy checkout, unavailable credentials, offline state, or live sessions.
This avoids a green "current" badge masking an unsupported updater.

### 6. Authenticated component downloads

Each component downloads directly from GitHub using its service user's existing
`gh` authentication. Fleet enrollment does not grant repository access and the
Host does not forward GitHub tokens to Nodes. The external Host updater uses the
Host account's approved access, not a Node's credentials.

Use authenticated release APIs to resolve the exact pinned release and assets, then
the CLI's authenticated asset-download path. An implementation may use exact-tag
`gh release download` with literal asset names, provided it verifies the pinned IDs,
manifest digest, and archive hash and refuses metadata drift.

Illustrative existing CLI command, after a release with these assets is published:

```powershell
gh release download v0.9.1 `
  --repo charlesyin_microsoft/copilot-fleet `
  --pattern "release.json" `
  --pattern "fleet-node-0.9.1-win32-x64.zip" `
  --dir ".\staging\0.9.1"
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

This section defines the Node layout/transaction. Host-specific state and activation
requirements are in section 13; a Node migration must never migrate Host data.

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
| Node inventory/register/ready | Optional installation kind, launch mode, immutable release identity, application protocol epoch, capabilities, launcher version, and pending/last update receipt. |
| Host welcome/status | Host release identity and supported protocol epochs, approved Node target, and independent freshness, execution compatibility, and update eligibility results. |
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
- Show a behind-but-compatible Node as "update available, still compatible", not
  disconnected or up to date. Show wire incompatibility and missing optional/updater
  capabilities separately; neither is inferred from release-version inequality.
- Provide target approval, per-Node update, safe bulk update, automatic-policy opt-in,
  pause rollout, and cancel-before-activation actions.
- Keep "stop sessions and update" behind the existing named-session confirmation.
- Display `waiting for idle`, `awaiting Host confirmation`, `rolled back`, and
  `launcher migration required` distinctly; none means "up to date".
- Browser reconnect/page refresh reconstructs progress from the Host, not in-memory
  client event history.
- Local config/status/log surfaces report actual running release, selected/pending
  release, launcher version, and last operation result.
- Later, extend Settings -> General with a separate managed-Host target, backup/state
  compatibility preflight, update operation, and verified post-restart outcome.
  Retain the legacy checkout action and label installation kinds explicitly.

First rollout: update the compatible checkout Host manually, migrate one Windows
x64 canary Node locally, perform one manually approved update, and observe recovery
and session behavior. Only then enable safe automatic rollout for that approved
target. Do not migrate every Node in one operation.

### 13. Later Host packaging and safe activation

Host packaging ships early as a build artifact; this section's behavior ships only
after the managed-Host gates. Do not fold it into the first Node update PR.

#### 13.1 Stable Host state and launcher migration

Before selecting a managed Host runtime, inventory and preserve its SQLite database,
identity/keys, configuration, persisted artifacts, and effective environment/tool
options. Keep all writable state and update records outside versioned code.

Proposed managed paths:

```text
%LOCALAPPDATA%\CopilotFleet\
  login\
    host\
      manifest.json
      managed-host-supervisor.mjs
  runtime\
    host\
      activation.json
      staging\
        <updateId>\
      releases\
        <version>-<artifact-digest-prefix>\
  host-state\
    data\
    backups\
    update-records\
```

Existing supported absolute paths may remain in use after ownership/containment
checks; migration need not move data just to match this example. Record the effective
absolute database/state paths in the stable launch configuration. Do not let
`resolveDatabasePath` create a fresh per-release database or inherit an unrelated
working directory's `.env`. Do not blindly copy a live database/WAL or package
credentials into the archive.

Migration is a separate explicitly approved local operation, with an ownership-
checked recovery set, consistent state backup, recorded task/launcher state, and
verification of the same Host identity and fleet records. Preserve bind settings,
public/tunnel URL configuration, and authentication; never reenroll Nodes to mask
a lost Host identity. The old checkout remains available for migration recovery.

Start with the owned same-user Host login service. Other launch modes remain on
their legacy updater until separately certified. A combined Host+Node installation
must first have an explicitly supported component launch plan: do not stop/rewrite
the colocated Node as an incidental effect of changing the Host runtime.

#### 13.2 Preparation, backup, and compatibility gate

Reuse exact-release discovery, authenticated downloads, archive validation, staging,
and durable operation conventions. Keep Host and Node approvals/operations distinct
even when their release version is the same. Deploy only a Host version compatible
with the Nodes that will remain connected; do not assume a simultaneous fleet switch.

Prepare the candidate without changing active code/data. Persist an update record
outside the application process/database migration boundary so the external
supervisor can recover after Host shutdown. Preflight checks disk space, launch
ownership, state paths, current schema, candidate schema/migration support, and the
certified recovery path.

Take and verify a consistent backup before candidate access to production state.
Certify the actual schema compatibility/migration against a restored isolated copy;
a SemVer range or a declarative "rollback safe" flag is not evidence. The first Host
activation milestone supports only releases whose state remains readable by the
previous known-good Host. Incompatible/destructive schema changes are refused and
require a separate operator-reviewed migration/recovery procedure.

#### 13.3 External activation and verified recovery

Settings requests the pinned update; the stable launcher/supervisor performs the
replacement outside the Host being stopped. It owns the Host activation journal,
retains the previous known-good runtime, and uses bounded attempt/rollback receipts
equivalent to the Node journal. A successfully launched process or scheduled task
is not completion.

Fence new work that the operation would interrupt and drain/shut down the Host
gracefully. Do not terminate remote Node sessions. If a supported combined launch
plan restarts a colocated Node, apply the existing named-session safety checks and
explicit-stop authorization; ordinary automatic updates defer instead.

Require candidate readiness to identify the exact operation, launch attempt,
release/manifest/artifact, Host identity, effective data path, usable database, and
listener/UI readiness. Reconcile required Nodes and preserve the configured tunnel
behavior before committing success. Network/tunnel delay is a dependency wait, not
proof that restoring an old database is safe.

Keep normal mutations and event acknowledgements fenced during provisional
activation. A restore of the pre-update backup is allowed only while no new writes
have been acknowledged since that snapshot. After accepting new writes, recovery
must use compatible code with the current state or report `needs_attention`; never
restore an older snapshot and silently lose acknowledged work.

Keep candidate/code rollback bounded. Restore service enabled-state semantics and
retain diagnostics on failure; never take over a foreign task or repeatedly cycle
Host/Node processes.

#### 13.4 Host automation is a separate last opt-in

First prove one explicitly approved manual managed-Host update and recovery on a
canary. Then, if desired, enable unattended Host activation only for an approved
exact target, a compatible idle installation, verified backups, and a certified
state-compatible recovery path. Pause on failure or unresolved confirmation.

No Node rollout policy, newly published package, or scheduled producer can enable
this policy. Host downtime and tunnel behavior must be visible to the operator.

### Premortem analysis

| **Risk** | **Likelihood** (L/M/H) | **Impact** (L/M/H) | **How the design addresses it** |
| --- | --- | --- | --- |
| Bundle contains credentials or misses runtime assets | M | H | Clean build, explicit inclusion list, license/secret checks, and unpacked isolated-profile verification of each component before publication. |
| Scheduled ticks race or publish the wrong `main` revision | M | H | One durable release plan, protected version PR, exact merged-commit tag, producer lock, and idempotent remote reconciliation. |
| Publisher uploads incomplete or replaced assets | M | H | Draft-first upload; re-download verification; pinned IDs/digests; no same-version replacement. |
| Service cannot read the private release | M | M | Same-user repository/asset preflight, explicit SSO/auth errors, no restart on download failure. |
| Node update damages a colocated checkout Host | M | H | Node-only immutable runtime; never reset/install/build the shared checkout. |
| Old Node silently ignores target version | M | H | New capability and distinct request; legacy updater excluded from versioned rollout. |
| New work starts after the Host's initial idle check | M | H | Atomic Host admission fence plus Node-local fence and final inventory check. |
| Outbox events vanish on process exit | M | H | Stop/event barrier before shutdown; refuse exit when acknowledgements are incomplete. |
| Crash during activation strands the machine | M | H | Stable dependency-free supervisor, single-writer journal, retained known-good release, bounded recovery. |
| Same version label reports success for wrong bytes | M | H | Verify full release identity and attempt, not only version/SHA or reconnect. |
| Root manifest changes relabel an older executable, or version inequality blocks compatible Nodes | M | H | Embed immutable selected-source metadata; compare approved-target freshness separately from certified wire epochs/capabilities and update eligibility. |
| Host/tunnel outage triggers rollback storm | M | H | Separate local readiness from connectivity; persist attempts and pause rollout. |
| Task migration breaks ownership or reenables a stopped service | M | H | Old-manifest validation, recoverable task migration, preserve enabled state, explicit start authority. |
| Host bundle starts against a fresh/wrong database or loses keys | M | H | Explicit stable data paths and owned migration; verify unchanged Host identity/database before promotion. |
| Host rollback restores stale data after accepting work | M | H | State-compatible initial scope; verified backup; provisional write fence; no snapshot restore after acknowledged writes. |
| Bad publisher or repository compromise distributes malicious code | L | H | Restricted publisher rights and fixed repository trust; checksums are not claimed to solve publisher compromise; signing/policy review is an open release gate. |

### Prototypes <!-- optional -->

No new runtime prototype was executed for this design document.

| **Prototype no** | **Evaluation description** | **Reference(s)** | **Learnings** |
| --- | --- | --- | --- |
| 1 | Package Windows x64 Node and run outside checkout without Git/npm/build tools in the launch path. | Existing package exports, config assets, agent catalog. | Pending; must prove dependency and asset closure. |
| 2 | Download a private draft/test release as the actual login-task user with approved access. | Existing same-user preflight and GitHub CLI. | Pending; must distinguish general login from asset access. |
| 3 | Switch releases and inject crashes after every journal transition inside the Windows job. | Existing login runtime tests and supervisor tests. | Pending; must prove no detached child or restart-budget reset. |
| 4 | Migrate an owned v1 task and recover from partial migration. | Existing task ownership/install tests. | Pending; must preserve disabled state and reject foreign tasks. |
| 5 | Race/retry release planning and interrupt draft uploads on the approved producer. | Proposed release scripts and durable receipts. | Pending; must prove one exact-source release without replacement or bypassed approval. |
| 6 | Run the Host bundle outside checkout, then inject backup, migration, readiness, and recovery failures. | Existing Host update/backup/startup surfaces. | Pending; must preserve identity/state and never discard acknowledged writes. |

## Tracking open questions

These are approval/implementation gates, not missing assumptions to silently fill.

| **Open question no** | **Open issue description** | **Findings and references** | **Resolution reached** |
| --- | --- | --- | --- |
| 1 | Does organization policy permit private release publication, an internal scheduled producer, and automated downloads? | Actions is reported unavailable; each of these permissions is separate. | Verify before installing a producer or publishing a pilot artifact. |
| 2 | Who is authorized to publish, and is signing/attestation required? | Approved producer provenance and repository trust are proposed, not independent signing. | Owner/security-policy decision before automatic publication/installation enablement. |
| 3 | Is Windows x64 sufficient for the first managed rollout? | Existing manual Host/Node modes support broader platforms. | Proposed initial scope; unsupported platforms stay manual. |
| 4 | What Host protocol/version range is certified for the first release? | `0.x` versions and capabilities do not automatically guarantee compatibility. | Establish compatibility fixtures for the actual release. |
| 5 | Which archive/dependency-materialization implementation meets Windows containment and packaging requirements? | No new package selected by this document. | Resolve in prototype 1; prefer an existing reviewed implementation. |
| 6 | Which existing `.env` options need migration beyond persisted settings? | Current runner loads the checkout `.env`. | Inventory supported options during migration implementation; fail explicitly on unresolved required values. |
| 7 | Are the initial download/startup/disk budgets appropriate on real machines? | Values above are proposed and unmeasured. | Measure with representative artifacts before expanding beyond canary. |
| 8 | When should idle sessions be checkpointed automatically? | Current sessions can remain live indefinitely. | Out of scope; safe automatic updates may remain deferred. |
| 9 | How should launcher updates be distributed later? | Application bundles must not overwrite the running stable bootstrap. | Manual compatible migration in v1; independent follow-up design. |
| 10 | Which machine/account owns the producer, and what scheduling/publication policy is approved? | Dedicated internal Windows machine with Task Scheduler is the initial recommendation; Azure Pipelines is optional. | Approve ownership/authentication and manual proof before the scheduled-production phase. |
| 11 | Which Host state/schema and launch-mode combinations permit safe recovery? | Checkout data defaults are package-relative; combined launch modes may also restart a Node. | Certify explicit stable state paths and owned Host service first; keep incompatible cases manual. |

# Common core checklist

**Quality(verification)** — Turn the desired outcomes into deterministic tests.

- [ ] Release planning: one root version and generated lockfile metadata, unversioned
  private workspace links, matching artifact/tag versions, explicit minor/
  major choice, protected PR flow, exact merged-commit tag, unchanged-source no-op,
  no release-commit feedback loop, concurrent invocations, and retry without
  duplicate versions.
- [ ] Publication: dirty-source refusal, required-component completeness, draft
  re-download verification, interrupted upload recovery, credential failure, and
  no replacement of a published version.
- [ ] Unit: SemVer precedence, invalid versions, prerelease channels, same-version
  different identity, no downgrade, target pinning, and compatibility checks.
- [ ] Mixed releases: an older compatible Node remains executable after a Host
  upgrade; freshness/status reaches both UIs; unsupported feature/update messages
  are withheld; a breaking epoch requires compatible management or manual recovery.
- [ ] Build identity: replacing a checkout root manifest or changing live HEAD
  cannot relabel an already-built managed archive/executable; internal metadata,
  root source version, tag, manifest, and selected artifact agree.
- [ ] Unit: manifest validation, absolute/traversal/case/ADS/link extraction rejection,
  byte/entry limits, path containment, and redaction.
- [ ] Unit: duplicate requests, stale status sequence, mismatched operation/attempt,
  and replay of commit/outcome acknowledgements.
- [ ] Integration: each real prepared component bundle outside the repository, with
  protocol exports, required runtime assets/dependencies/notices, Node config/agents,
  and Host server/UI loading against isolated state.
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
- [ ] Host: stable absolute state paths, consistent verified backup, owned launcher
  migration, schema-compatible candidate/previous release, exact-build readiness,
  bounded recovery, and refusal to restore stale state after acknowledged writes.
- [ ] Phase adoption: publication does not enable deployment, bundle presence does
  not enable activation, and legacy checkout paths remain separately usable.
- [ ] Regression: existing checkout startup, manual Node mode, enrollment, settings
  precedence, custom agents, private tunnels, and service ownership checks.
- [ ] Approved manual sign-out/reboot/sign-in exercise confirms startup occurs after
  sign-in. Automated tests never reboot or sign out the operator.

WSR/cluster-only Fabric environments are not applicable. Equivalent fleet-level
scenarios run in isolated local/mock environments and an approved Windows canary.
Mock sessions validate the transport/lifecycle without sending paid model prompts;
authentication probes remain nonprompting.

**External dependencies** — GitHub Releases/CLI, approved private repository access,
Node.js, Copilot CLI, the approved producer machine/account, and optional Dev Tunnels
remain external. Task Scheduler is the initial producer scheduler; Azure Pipelines
is optional, not a prerequisite. Publication/download
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

**Execution Plan** — Ship small PRs in dependency order, not all phases together:

The suggested scope below is a maximum, not a requirement to combine everything in
one PR. If a phase needs multiple PRs, keep its actions disabled until its completion
gate passes. Ship schemas/read-only status before actions; do not merge activation
with publication automation. Each PR records its phase/gate and preserves earlier
milestones. No phase in this table is claimed complete by this document.

| Phase | Scope and main surfaces | Depends on | Completion gate |
| --- | --- | --- | --- |
| P1 | Release/build identity, manifest/component schema, SemVer/compatibility fixtures, and optional inventory fields. No update actions. | None | Exact identity and mixed-version parsing pass; checkout behavior is unchanged. |
| P2 | `release:plan`: default patch increment, root version/generated lockfile, durable reservation, and reviewed release PR/tag flow. | P1 | Manual dry run/PR proof; races/retries reuse one plan and no protected-branch bypass occurs. |
| P3 | Node-only `release:prepare`, dependency/asset closure, and isolated Windows x64 bundle check. No remote writes. | P1 | Node runs outside checkout without Git/npm/build in its launch path. |
| P4 | Host `release:prepare`, server/UI/dependency closure, and isolated absolute-state smoke check. No installation changes. | P1 | Host artifact runs outside checkout; no production database/identity is accessed. |
| P5 | `release:publish`: exact-tag draft upload, re-download checks, completeness, receipts, and explicit manual publication. | P2, P3; P4 only for releases including Host | One verified private Node release; later Host assets require a new verified version, not backfill. |
| P6 | `release:run` and approved Task Scheduler producer; idempotent planning/build/publication with structured failures. | P5 | Duplicate/reboot/retry proof; publication policy approved; no runtime restart or automatic PR merge. |
| P7 | Read-only Host catalog, component availability, release relation/eligibility, and persisted exact-target approval. | P1, P5 | Operator can select a published compatible target; no activation commands are exposed yet. |
| P8 | Local managed Node staging, dependency-free supervisor, journal, structured readiness, and bounded compatible recovery. Split staging and activation into separate PRs if needed. | P1, P3 | Isolated local fault-injection proof; no active runtime mutation or detached replacement. |
| P9 | Owned v2 Node service manifest, stable management path, explicit one-time migration, and actual-user asset preflight. | P5, P8 | One locally migrated canary preserves identity/account/task enabled-state; checkout is no longer required. |
| P10 | New capability/messages, durable Host Node-update records, authenticated remote preparation/cancel, and read-only persisted progress. Activation stays disabled. | P7, P8 | Exact-target staging survives Host/Node interruption; duplicate/cancel/mismatch cases pass. |
| P11 | Node admission fences, final-event barrier, activation/commit receipt, and minimal per-Node manual action/recovery UI. | P9, P10 | One explicitly approved end-to-end canary update/recovery; no unapproved session termination or false success. |
| P12 | Safe bulk update and separate opt-in automatic Node rollout; bounded retry/pause, accessibility, and operator docs. | P11 | Approved target rolls one safe Node at a time and pauses on failure; no Host restart authority. |
| P13 | Managed Host stable state/launcher configuration and explicitly approved local service migration. No release-driven activation. | P4 | Isolated migration/recovery proof and one owned canary preserve database/keys/URL; combined-launch cases are certified or refused. |
| P14 | Host durable update record, exact-target staging, backup verification, schema/recovery preflight, and read-only General status. Activation stays disabled. | P7, P13 | Candidate passes against a restored isolated copy; missing/unsafe state compatibility blocks activation. |
| P15 | External managed-Host activation, provisional write fence, verified restart/promotion, compatible bounded recovery, and explicit General update action. | P14 | One manually approved canary update/recovery preserves state and never restores over acknowledged writes. |
| P16 | Optional, separately approved unattended Host activation policy and canary expansion. | P15 | Approved idle/state-compatible target, verified backup, visible downtime, and pause-on-failure proof; remains off by default. |

Usable stop points:

- **P5:** versioned, verified artifacts are publishable manually; no deployed machine
  changes update behavior.
- **P6:** version PR/build/publication orchestration runs automatically through its
  approved gates; deployment still requires separate approval.
- **P11/P12:** one manual Node update, then optional safe fleet rollout; checkout Host
  remains supported.
- **P15:** both components have exact-release update paths; Host activation is still
  explicit. P16 is optional, not a condition for shipping the rest.

P4 is independent of P3 and can be postponed without blocking Node-only publication.
Catalog/manual Node updates do not depend on the scheduled producer; manually
published releases use the same contracts. Host milestones do not block Node
rollout. Write contract and failure tests before each phase's implementation, and
update the relevant user documentation when that phase becomes usable.

**Engineering Wiki updates** — Update repository documentation, not a remote wiki
as part of this task: `README.md`, `README.zh-CN.md`, `ARCHITECTURE.md`,
`docs/windows-login-startup.md`, and the update flow documentation/diagram. Mark
the superseded NPX decisions clearly when implementation ships. Document publishing,
private authentication, migration, rollback, and the idle-session limitation.
Also distinguish release planning/publication from deployment, record producer
recovery commands, and document the managed Host's stable data/backup paths and
state-compatible recovery limits. Do not advertise future phases as shipped.

# Backend (workload) checklist <!-- optional -->

- **State/Metadata** — Host SQLite owns target approval and operation history; local
  activation journal owns actual executable selection. Neither can infer the other's
  success from a missing record. Reconcile by operation/attempt/release identity,
  retain bounded receipts, and validate versioned schemas before use.
  Producer receipts and Host external-update records must survive disposable build
  cleanup and application/database replacement respectively.
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
  service migration. Later Host surfaces also distinguish unavailable artifacts,
  unsafe state/schema compatibility, backup failure, unsupported launch modes, and
  recovery that requires operator attention.
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

These group the phases above by surface; they do not authorize combining the phases
into one large PR.

### Backend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Shared immutable identity/compatibility schema and root-version release planning. | P1, P2 |
| 2 | Independent Node/Host packaging, verified publication, then scheduled producer. | P3-P6 |
| 3 | Managed Node runtime/service migration and durable remote preparation. | P8-P10 |
| 4 | Node activation/commit handshake, fault tests, then safe rollout policy. | P11, P12 |
| 5 | Host stable state/service migration, backup/preflight, then external activation and optional automatic policy. | P13-P16 |

### Frontend example <!-- optional -->

| **Phase** | **Description & objective** | **Depends on** |
| --- | --- | --- |
| 1 | Read-only component catalog, release relation/eligibility labels, and exact-target approval. | P1, P7 |
| 2 | Persisted Node preparation/progress, without activation controls. | P10 |
| 3 | Per-Node manual action, verified outcome/recovery, and named-session confirmation. | P11 |
| 4 | Safe bulk update, Node automatic-policy opt-in, and rollout pause/errors. | P12 |
| 5 | Host backup/preflight status first, then explicit update/recovery, then separate optional automation. | P14-P16 |
| 6 | Keyboard/accessibility checks and English/Chinese operator documentation as each action ships. | P7, P10-P12, P14-P16 |
