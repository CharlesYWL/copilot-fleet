# ADR: Managed worktree isolation for parallel orchestration

Status: implemented in stages; distributed execution is enabled with explicit
fail-closed limits described below.

**Problem / motivation:** independently writable orchestration tasks need to run
concurrently against one repository without sharing writable checkout state, while
implementation, review, testing and fix-up of each task must see the same committed
and uncommitted changes.

## Decision and two-layer lock model

A placement remains repository provenance and a materialization candidate
(workspace, Node and local path). Fleet does **not** add worktrees as duplicate
placements. A Run owns an immutable `RunWorkspaceSpec`; each physical checkout is
a generation-scoped `WorkspaceInstance`, and every integration retry creates or
updates a separately identified `IntegrationAttempt`. The legacy workspace binding
remains a compatibility projection for existing Runs and UI status.

1. **Managed checkout writer lease:** one shell-capable Fleet process at a time for a
   managed physical checkout. Managed tasks use different physical checkouts and can each
   hold one writer. Independent writable DAG steps receive separate worktrees; dependent
   roles receive a deterministic composed worktree containing committed predecessor
   results. `readOnly` remains a capacity label, never a filesystem guarantee. Manual
   launch, prompt, resume, automatic recovery and MCP process refresh use the same Node
   admission gate.
2. **Repository administration lease:** keyed by the physical Git common-directory
   identity, independently of worker capacity. Registry and private-ref mutations
   serialize there. Order is repository administration, then affected
   checkout keys in sorted order. An operation never waits for administration while
   holding a worker lease. Node-local administration queues avoid expected races;
   exclusive on-disk leases close cross-installation and manual-route races.

The Host reserves/schedules by the managed physical checkout key, retaining
placement-based legacy scheduling for unbound sessions on all Nodes. Legacy
sessions never acquire managed checkout leases or use deferred managed terminal
teardown, even when the Node supports the feature. A manual alias into a managed
checkout still requires its managed binding. For managed sessions the Node is authoritative:
Windows MachineGuid identity, real final paths and volume serial/file index (`stat` bigint) identify
physical directories, rather than placement ID or a lowercased path. Case,
separators, dot segments, junctions, short names and drive aliases therefore collide
on one lease. Unsupported/ambiguous identities and network/device paths fail closed.
Nested manual cwd paths resolve to the Git checkout root before admission.
Production lease files live in the shared Git common directory (or the resolved
nonrepository directory), not in a per-installation/per-user lock namespace.
Different Node installations therefore cannot bypass admission by choosing
different application data directories.

Leases include an incarnation, owner, attempt, exclusive token and recorded process
state. No elapsed-time unlock exists. Managed ACP is launched suspended into a
Windows Job Object before any agent code runs. Breakaway is disabled; an orphaned
grandchild remains owned. Both Stop and unsolicited root exit terminate the job's
remaining processes and require an empty-job proof before releasing the checkout.
The supervisor starts its proof on a separate stderr line. Before ACP diagnostic
handling, the Node consumes only that process's exact expected, newline-terminated
proof (LF or CRLF), including when split across chunks. Lookalike prefixes, partial
tokens, embedded tokens and unrelated diagnostics remain visible and cannot prove
quiescence. The consumed proof line never enters the session transcript or diagnostic tail;
buffering is bounded to a possible proof prefix.
Idle does not release a lease. A known live process retains its lease on Host loss.
Missing supervision proof (including supervisor loss) persists
`needs_reconciliation` on the worktree and a reconciliation reason in its lock.
The authoritative terminal event still reaches the Host exactly once and the
active slot is detached. Failed teardown promises are cleared: an explicit
quiescence retry may release the lock only after supervision verifies termination,
followed by worktree reconciliation. An ordinary reconcile never clears uncertain
worker ownership, including ownership from the current Node incarnation.
Administrative orphan leases can be reconciled only when recorded Node/Git
processes are no longer alive and no spawn ownership is unknown.

`leaseAttempt` is a Host dispatch fencing token, not a process identifier. Resume
is authoritative reattachment: the Node validates the existing conversation owner,
immutable worktree/generation/canonical cwd/checkout and access class, then updates
the durable lease attempt and slot binding without yielding or creating a second
lease/process. Repeated current-attempt resume is idempotent and resynchronizes the
live state. Retired attempts, wrong identities and stale prompts remain rejected.
Host persists the rotated binding and dispatch receipt in one transaction.
Real-ACP existing-slot regression tests verify durable attempt changes, preserved
lease/process identity, retired-attempt fencing, same-attempt idempotency and
unchanged slot/holder attempts after failed save or compare-and-swap. Separate
lease tests cover failed staging writes and atomic replacement with retry.

Bulk Stop attempts every active or reconciliation-pending slot and aggregates
errors only after safe leases are released or uncertain ownership is persisted.
An unbound legacy process whose Stop fails without a terminal event stays active
and retryable; the Node does not fabricate a terminal receipt that would free the
Host's legacy placement reservation.
Backup import drains worktree operations and quarantines even after a Stop failure;
an unsuccessful drain aborts identity replacement. Shutdown always closes the
worktree database after settling operations, and reports cleanup errors rather
than returning successful shutdown.

## Defaults, binding and continuity

- `managedWorktreesEnabled` is persisted and **off by default**.
- New task creation accepts `workspaceMode: auto | legacy | managed`.
- Explicit Legacy/Managed wins. Auto resolves the app default once at creation.
  Historical/missing fields resolve to Legacy, including old backups.
- New managed tasks require an explicit source placement from the repository the
  user selected. Host does not substitute the first online copy. Historical tasks
  that predate source metadata retain a compatibility-only lookup during initial
  preparation; once resolved, the placement is pinned.
- Requested/effective mode, repository identity, source provenance, execution base,
  integration/publication policies and repository execution policy are stored in
  the immutable workspace spec. Resume, retries and later setting edits never
  rewrite resolved identity. Existing persisted bindings are migrated additively.
- Chats/nonrepository tasks allocate no worktree. Merely describing a shell-capable
  repository reviewer as read-only does not prove no-checkout capability.
- New capable-Node leads use nonrepository coordinator directories, not per-agent
  worktrees. Historical lead cwd bindings are retained on resume.
- A settled conversation is retained. A same-session follow-up keeps its context.
  A different task worker is queued while the previous settled process is parked;
  only the Node's quiescence/terminal receipt permits the handoff.

At creation, Host persists a reserve intent and asks the selected Node to verify
the repository and pin the exact resolved commit. Remote resolution fetches the
source ref by URL with `--no-write-fetch-head` into `refs/fleet/fetch/*`, verifies
the expected SHA, then pins it in `refs/fleet/pins/*`; user-visible remote-tracking
refs and `FETCH_HEAD` are not changed. Allocation occurs before the first checkout
step. Source HEAD may move, and the source may be dirty:
`git worktree add -b fleet/<safe-key> <owned-path> <stored-base-sha>` still uses the
original committed base. The target must start clean.

The original Run worktree remains a compatibility/control identity and is not an
agent execution surface. Every shell-capable step, including a nominally read-only
step, receives an isolated step workspace. A writable fan-in step receives a distinct
derived workspace,
pinned to the same Run base, whose provenance records predecessor step/worktree
identities and committed result SHAs in dependency/position order. Dispatch waits
until those fixed commits merge cleanly. Dirty predecessor output, changed SHAs,
source advancement, active Git state, or conflicts block the step without reset,
clean, branch switching, cherry-pick, rebase, or source-checkout fallback.

The safe key is a SHA-256-derived Host-installation/Run/generation key, not a task
title. Default paths are in a verified sibling `.fleet-worktrees` root with a
Node-installation/repository namespace and an ownership marker. The Node may use
`FLEET_WORKTREE_ROOT` for an explicitly configured external root. Fleet does not
edit the source `.gitignore`. Root containment, registration, branch, base and
physical identity are revalidated; unknown directories/ref collisions are never
overwritten or adopted.

## Logical repositories and distributed execution

A task owns a logical repository identity; Nodes own physical source checkouts,
managed worktrees and Fleet-private refs. The Run persists
`originatingPlacementId` separately from step execution placements. Historical
`sourcePlacementId` bindings parse as the originating placement, preserving
single-Node behavior.

Each Node derives identity from Git's object format, roots reachable from the pinned
base, and, when available, a normalized credential-free network origin. Local/file
remotes are excluded. The Host marks another placement eligible only after that Node
proves the same identity and possession of the exact base commit. A matching ref or
SHA alone never identifies a repository.

Independent writable steps may use different eligible Nodes. Eligibility requires
the exact base to be present or securely materializable, repository/toolchain
compatibility, and result portability when transfer is needed. Retries of one
conversation and dirty/unsealed state remain Node-affine. Explicit DAG edges are
authoritative; a conservative phase barrier is retained only for legacy plans and
is recorded as fallback telemetry. Composition removes predecessor results already
covered by a descendant result. Multiple writable sinks create a durable synthetic
fan-in workspace instead of being treated as inherently ambiguous.

`originatingPlacement` is provenance and a locality hint only. Integration runs on
an eligible integration-capable Node in a Fleet-owned detached worktree. It never
selects, switches, cleans, resets, merges in, or otherwise depends on the user's
originating checkout.

## Portable results and transport

Writable-step finalization is infrastructure-owned. Fleet quiesces supervised
processes, inspects the checkout, blocks unknown untracked/unsafe data, and may
create an idempotent hook-disabled checkpoint for tracked modifications or
deletions. It records the included paths, final tree OID and checkpoint provenance,
then creates and verifies a Git bundle before marking the durable result available.
Agent execution success and sealing/transport success are distinct.

Artifact bytes live outside SQLite; SQLite stores ownership, lifecycle and integrity
metadata. Transfers use authenticated Host↔Node frames with 256 KiB chunks, a
512 MiB artifact limit, 64 results/2 GiB per task, and 20 GiB per Host. Uploads
are authorized against the exact pending finalize operation and immutable
worktree ownership; contiguous offsets and replayed bytes must match. Partial files are fsynced,
checksummed and atomically renamed. Reconnect repeats begin and resumes from the
Host's durable offset. Downloads are authorized against the pending composition or
materialization operation. Remote machines never supply Host storage paths.

Receivers verify SHA-256 and `git bundle verify`, import into collision-checked
`refs/fleet/imports/*` with hooks disabled, and verify the imported commit before
composition. Downloaded bundles are removed after import, and cleanup removes only
private refs recorded as owned by that workspace. Available Host artifacts get
a 24-hour post-completion debugging window before bounded expiry. Partial/corrupt
artifacts fail closed.

Placement capability proofs are keyed by placement, logical repository and pinned
base SHA, so concurrent Runs at different revisions do not invalidate one another.
Proofs are bound to the current Node/path, expire after five minutes, and are
invalidated when a placement is moved or repathed. Reconciliation backfills logical
repository identity for compatible worktrees created before portable results existed.

Git bundles do not make LFS objects or submodule repositories portable by
themselves. Until complete manifests and authenticated object transfer are
implemented, affected repositories are explicitly marked non-portable and may not
move sealed results across Nodes. They remain usable on one Node. A destination
may securely materialize a published exact base from the configured remote;
portable base artifacts for committed but unpushed bases are not yet supported.

Rejected alternatives are shared filesystems/worktrees (incompatible identity,
locking and failure domains) and ephemeral refs on user remotes (credential,
visibility, lifecycle and third-party recovery risks). Git conflicts remain
explicit and fail closed; Fleet does not blindly auto-resolve them.

## Durable state and recovery

Host SQLite has additive JSON-backed worktree, operation, integration, tombstone
and idempotency tables, plus Run/step/session bindings. Node SQLite independently
persists installation ownership, operation intents/receipts, trees, previews and
integrations. Metadata is committed before dispatch or Git mutation; receipt
identity/version/generation/paths/refs are checked before Host acceptance.
Duplicate operations replay their receipt. Per-worktree queues prevent concurrent
version races, and stable create keys converge after interrupted creation.

Lifecycle:

```text
reserved -> creating -> ready <-> retained -> removing -> removed
                       |
creation_failed / missing / unavailable / needs_reconciliation / quarantined
```

Workspace preparation is also a first-class blocking task step:

```text
pending -> running -> succeeded
                    \-> failed
```

The scheduler dispatches no task agent until the worktree reaches `ready`. A
reserve or create failure records a browser-safe failure class, moves the Run to
the nonterminal `blocked` state and keeps raw diagnostics only in workspace
details. Retry reuses the durable operation/worktree identity, returns to the
saved Run state while preparation continues, and resolves the block only after
physical checkout creation succeeds. Stop and cancellation remain available;
there is no source-checkout fallback.

Integration has independent `not_requested`, `not_ready`, `ready`, `integrating`,
`validating`, `integrated`, `no_changes`, `conflicted`, `resolving`, `aborting`,
`aborted`, `uncertain` and `needs_reconciliation` states. Approval never implies
integration. `no_changes` is a reviewed terminal outcome, not an alias for
“already integrated.” For managed Runs, successful orchestration now enters the
nonterminal `aggregating` Run state. A Host-owned Integration Controller resumes
from durable Node operation receipts after restart/reconnect, and the Run becomes
`completed` only after exact-tree validation, publication, task-workspace
quiescence, retention and safe cleanup of primary, step, derived, synthetic fan-in
and integration workspaces.

Recovery checks `git worktree list --porcelain -z`, physical roots/marker, refs,
HEAD, status and lease/process inventory. Missing/moved directories, replacement
paths, registry mismatches, source loss and unknown process ownership block
execution. A managed session never falls back to the source checkout. On a Host
restart, correlated outstanding intents replay to the owning capable Node;
unavailable metadata is reconciled against that Node, not wall-clock assumptions.
An uncertain merge remains reserved for explicit reconciliation/continue/abort.

Backups carry metadata arrays, not worktree contents, actual lease files or
process ownership. Restored managed Runs, steps, sessions, worktrees, operations
and tombstones are quarantined. Neither automatic resume nor cleanup/integration
may act on them. Explicit reconciliation requires the original owning Node,
machine and installation; a different installation is not silently adopted.
Orphaned worker ownership that cannot be proved quiescent remains blocked.

## Automatic integration with escalation

The normal managed workflow requires no integration click. The Host records the
resolved remote/base and generates a privacy-safe branch such as
`dev/<short-user>/fleet-<stable-run-id>`. Fleet selects an eligible Node, creates a
detached integration worktree at the exact integration base, imports the immutable
reviewed result, composes it and validates the exact final tree. It then stops in
`await_publish_approval`; no shared remote state has changed.

The UI presents the publication base, proposed final commit, final `base..result`
diff, changed-file/commit counts, validation status and review status. **Publish
branch** records an immutable approval envelope binding the Run, integration,
remote, target ref, expected remote SHA, final result SHA and final tree SHA. The
Publication Controller revalidates that envelope and the local integration
workspace before pushing. A newly appeared or changed target ref invalidates the
approval and nothing is published. Publication uses expected-old-value semantics
and never overwrites an unapproved remote ref.

Integration, validation, approval and publication are separate durable phases.
Publication failure preserves the validated result for publish-only retry, but a
new approval is required when any approved identity changes. If the integration
base advanced beyond the execution base, Fleet currently stops with
`post_integration_validation_required`; repository-specific validation commands
are not yet configured, so Fleet does not claim the refreshed final tree is safe.

Fleet stops and quiesces task-owned sessions before integration so a completed
worker cannot keep the result checkout lease while the controller validates and
merges it. If fresh observations prove every task workspace is clean at its pinned
base, with no result SHA or published workspace result, target reservation and
merge preview are unnecessary and Fleet proceeds directly through retention and
cleanup. Unverified or changed workspaces fail closed into the normal preview and
integration path, where no committed target diff records `no_changes`. Cleanup
retries safely while process quiescence is pending; dirty/unknown state, conflicts
and reconciliation uncertainty move the Run to resumable `blocked` attention. One
generation-keyed notification identifies the target branch and phase without
exposing paths or commands. **Retry integration** starts a new durable attempt and
resolves that notification after success.

## Advanced recovery

An authenticated operator may inspect or retry a blocked Fleet integration attempt.
Preview shows the Fleet-owned integration path/ref/SHA, exact task SHA, a safely
bounded presentation diff, dirty state and ancestry. The bounded diff is never an
authoritative identity. Base/task/target/expected/final tree OIDs and the exact
expected parent graph define the reviewed result. An unchanged task is recorded
explicitly as `no_changes`; the base commit alone is never presented as completed
integration. These controls are hidden under Workspace details and never ask the
operator to select a user checkout.

The operation revalidates task and integration workspace physical identity,
cleanliness, exact SHAs and repository execution policy. That policy fingerprints
active hooks and content, filters/LFS configuration, executable submodule helpers,
fsmonitor and credential-helper configuration. Unsupported executable surfaces fail
closed. Hook approval is bound to exact content and is invalidated when content
changes. Git runs as argument arrays with deadlines, bounded output and a
noninteractive environment:

```text
git merge --no-ff --no-commit <approved-task-sha>
```

An ancestry check detects already-integrated work. A successful staged merge keeps
the target reserved until explicit commit confirmation (or the explicitly chosen
commit-on-success policy). Missing identity or required signing leaves the merge
staged: Fleet does not bypass signing. Conflict paths and the exact operation are
persisted. Resolve/stage in the target yourself, then explicitly Continue. Abort
uses `git merge --abort` only when the operation, physical target, ref, HEAD and
MERGE_HEAD still match. No reset/clean fallback exists; the task worktree is kept.
After commit, integration enters `validating`: Fleet requires the exact expected
parents, merge tree, integration trailer and final tree. Reachability alone is
insufficient. Hook-modified trees and post-commit extra commits stop publication
and become reconciliation/validation failures; they are not accepted because the
reviewed SHA remains an ancestor. Validation outcome and timestamp are persisted.

## Retention, cleanup and quotas

Stop, archive, dismissal and retry do not delete worktrees. Managed approval starts
automatic integration and safe cleanup; failures retain all work for recovery. Purge first
persists a cleanup tombstone and refuses while filesystem ownership remains.
Tombstones and ownership records survive Run/session deletion and backup restore.

Defaults: seven-day retention for clean integrated inactive trees, eight owned
worktrees/repository, 32/Node, 1 GiB free-space floor, and an approximate 10 GiB
managed-byte budget. General settings and the defaults API configure these limits.
Retention sweeps perform at most two operations/minute. Quotas include reservations;
tracked-byte estimates and bounded filesystem observations are approximate, not
an OS disk quota. Dirty/unknown work is never evicted to make room.
Node reconciliation triggers an immediate bounded sweep. A terminal task's valid,
inactive checkout is first marked as a retained orphan candidate, with durable
reason and timestamp, rather than deleted. The normal retention window remains
available for review and crash debugging before safe cleanup is considered.

Normal cleanup requires fresh ownership, registry and containment validation, no
active readers/writers or unresolved integration, and clean staged/unstaged/
untracked/ignored status. It uses `git worktree remove <verified-path>` without
force; there is no recursive-delete fallback and no repository-wide prune.
Temporary Fleet worktrees and owned private refs are removed only after sealed
results and receipts make recovery safe. Cleanup never deletes adopted or
user-created refs.

**Abandon ownership** is deliberately nondestructive v1: an exact branch/path
confirmation relinquishes Fleet management while keeping files and branch.
It still verifies ownership, containment, no active session and no unresolved
integration. The operator assumes responsibility for those files; it does not
turn a dirty checkout into a force-delete operation.

## API and UI

Existing authentication, administrator authority and CSRF middleware protect all
routes. Managed defaults use an operation ID and expected settings revision.
Managed Run creation uses a persisted idempotency receipt. Worktree actions
require an operation UUID and expected worktree revision; mismatches return
structured 409 codes. Old Nodes without `managed-worktrees-v1` receive no new
frames and show an upgrade-required block, never a silent Legacy fallback.

```text
GET  /api/defaults
POST /api/defaults
POST /api/runs                         # workspaceMode, operationId
POST /api/orchestrators/:id/runs        # normal task creation
GET  /api/worktrees/capabilities?workspaceId=...
GET  /api/worktrees/metrics
GET  /api/runs/:id/worktree
POST /api/runs/:id/worktree/:action
```

Actions: `observe`, `reconcile`, `retry-create`, `retry-integration`, `retain`, `quiesce`,
`integration-preview`, `integration-start`, `integration-continue`,
`integration-abort`, `publish`, `cleanup`, `abandon`. Reconcile first drains an outstanding
correlated acknowledgement before another filesystem transition is permitted.

General settings explain scope/quotas. Normal task creation names the selected
repository, current committed baseline and `Isolated worktree` mode. It does not
ask users to choose a filesystem destination. Generated branches, long paths,
internal identities and cleanup mechanics are hidden behind `Workspace details`.
Task detail keeps repository, base, preparation and the automatic integration and
validation checklist visible. Publication displays **Waiting for you** until the
exact final result is approved. Completed Runs show
the integrated branch and final cleanup summary; attention states show the concise
reason and **Retry integration**. Bindings, generated refs, generation, base/HEAD,
branch/path/Node, observations, Fleet integration attempts, conflict continue/abort,
reconcile, retain, quiesce, abandon and cleanup controls are progressively
disclosed under Workspace details/Advanced recovery.
Dialogs use accessible labels, non-color status/error text, explicit confirmation
and focus restoration. A setup failure creates one error notification independent
of ordinary agent-notification preferences, increments unread count, names the
task, navigates to it and uses a stable generation key across replay/reconnect.
A successful retry resolves that notification. Creation failure and merge
conflict/reconciliation notifications use generic browser-safe text;
ordinary dependency completion remains quiet.

`/api/worktrees/metrics` exposes path-free aggregate task, preparation, queue,
implementation, integration, validation, cleanup, retry, conflict, reconciliation
and compatibility measurements. It separates managed and Legacy task duration so
setup and parallelism changes can be evaluated against wall-clock outcomes rather
than inferred from worktree counts.

## Repository compatibility and setup performance

Only the selected committed revision is inherited; staged, unstaged and untracked
source-checkout state is never copied. Cone and non-cone sparse definitions are
captured at reservation and applied before checkout materialization, preventing a
sparse source from silently expanding into a full managed checkout. A changed
repository feature configuration invalidates the reservation and requires a fresh
retry.

Submodules are initialized recursively with noninteractive Git and setup remains
blocked if their committed URLs or objects cannot be resolved. Repositories using
Git LFS require `git-lfs` for the Node service account; missing tooling is reported
before dispatch. Partial/promisor clones are admitted only after the pinned commit
is locally verifiable; any later bounded object fetch failure remains an explicit
setup failure. Feature flags and estimate reliability are durable and visible only
under `Workspace details`.

Immutable revision scans used for submodule/LFS detection and tracked-byte
estimation are cached by source path and base SHA for the Node process lifetime.
Package download caches already supplied through the Node service environment may
be shared, but Fleet does not share repository-local `node_modules`, build output,
generated files or bootstrap-mutated directories between worktrees.

## Limitations / deferred

This is not a sandbox or a guarantee against arbitrary external programs or users
modifying a checkout. Writable DAG steps receive durable per-step worktrees, and
multi-predecessor dependents receive a deterministic derived workspace that merges
the recorded predecessor commits in dependency/position order. Read-only steps keep
their existing behavior. Node loss never proves cleanliness or process exit.
Bare/unborn repositories remain unsupported. Submodule and partial-clone setup can
still require network access configured outside Fleet, and LFS object size is not
included in the approximate preflight byte estimate.

Deferred: automatic publication policy, PR creation, rebase, cherry-pick,
automatic conflict resolution,
cross-Node migration, clone lifecycle, user-worktree adoption, signing automation,
network-volume identity and advanced repository configurations. Large Git output
or an unprovable physical/process identity fails closed rather than weakening
admission or treating incomplete observations as clean.
Managed ACP process supervision currently requires Windows Job Objects; on other
platforms managed ACP launch fails closed instead of relying on an escapable
process group. Unmanaged ACP launch is unchanged.

## Verification

`managed-worktrees.test.ts` exercises real Windows Git repositories, two
barrier-controlled independent writers, same-checkout exclusion/manual aliases,
review/fix-up continuity, exact-base pinning, duplicate/create crash recovery,
dirty cleanup and real merge/conflict/abort. Canonical identity tests include
Windows case/separators/dot segments/junctions, symlinks (or OS refusal), short names
and drive aliases. Protocol, store, scheduler, Host receipt and accessible UI tests
cover defaults, restoration, revisions, ownership and safe controls.

`scripts/managed-worktrees.integration.test.js` is the local authenticated
HTTP/WebSocket/Git smoke: two normal Runs execute concurrently, dependent roles receive
the correct task-owned workspace state, the source remains unchanged before integration,
CSRF/revision gates reject invalid mutations, and conflict/abort/cleanup use real
Git. It also proves unsupported Nodes receive no worktree frames.
