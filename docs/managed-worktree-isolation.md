# ADR: Managed worktree isolation for parallel orchestration

Status: implemented, conservative v1.

**Problem / motivation:** independently writable orchestration tasks need to run
concurrently against one repository without sharing writable checkout state, while
implementation, review, testing and fix-up of each task must see the same committed
and uncommitted changes.

## Decision and two-layer lock model

A placement remains the source catalog identity (workspace, Node and local path).
Fleet does **not** add worktrees as duplicate placements. A Run owns one immutable
resolved workspace binding; its steps, sessions and launch/prompt commands carry
the worktree ID, generation, canonical cwd/checkout key and lease attempt.

1. **Managed checkout writer lease:** one shell-capable Fleet process at a time for a
   managed physical checkout. Managed tasks use different physical checkouts and can each
   hold one writer. Every role in a task shares its checkout; `readOnly` is only a
   capacity label, never a filesystem guarantee. Manual launch, prompt, resume,
   automatic recovery and MCP process refresh use the same Node admission gate.
2. **Repository administration lease:** keyed by the physical Git common-directory
   identity, independently of worker capacity. Reserve/pin, create, remove and merge
   operations serialize there. Order is repository administration, then affected
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
- Requested/effective mode, resolution source, source placement, access intent,
  symbolic base ref, exact base SHA and setup state are stored. Resume, retries
  and later setting edits never recompute them. Existing sessions are not migrated.
- Chats/nonrepository tasks allocate no worktree. Merely describing a shell-capable
  repository reviewer as read-only does not prove no-checkout capability.
- New capable-Node leads use nonrepository coordinator directories, not per-agent
  worktrees. Historical lead cwd bindings are retained on resume.
- A settled conversation is retained. A same-session follow-up keeps its context.
  A different task worker is queued while the previous settled process is parked;
  only the Node's quiescence/terminal receipt permits the handoff.

At creation, Host persists a reserve intent and asks the selected Node to verify
the repository and pin HEAD's exact committed SHA. A private `refs/fleet/pins/*`
ref preserves that object until the task branch exists. Allocation occurs before
the first checkout step. Source HEAD may move, and the source may be dirty:
`git worktree add -b fleet/<safe-key> <owned-path> <stored-base-sha>` still uses the
original committed base. The target must start clean.

The safe key is a SHA-256-derived Host-installation/Run/generation key, not a task
title. Default paths are in a verified sibling `.fleet-worktrees` root with a
Node-installation/repository namespace and an ownership marker. The Node may use
`FLEET_WORKTREE_ROOT` for an explicitly configured external root. Fleet does not
edit the source `.gitignore`. Root containment, registration, branch, base and
physical identity are revalidated; unknown directories/ref collisions are never
overwritten or adopted.

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
`integrated`, `conflicted`, `resolving`, `aborting`, `aborted`, `uncertain` and
`needs_reconciliation` states. Approval never implies integration.

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

## Explicit integration: merge only

An authenticated operator chooses a catalog target on the same Node. The Node
checks that its canonical Git common directory matches. Preview shows target
path/ref/SHA, exact task SHA, complete bounded committed diff and its digest,
dirty state and ancestry. The operator separately approves that SHA/diff and
target; Fleet never selects or switches `main`, infers approval or pushes.

Start reacquires/revalidates administration and task/target checkout leases.
Task and target must be clean (including untracked and ignored data), with no
other Git operation, no active checkout session, and unchanged preview/review
identities. Active entries in the effective hooks directory are rejected by
default rather than silently bypassed; an empty or sample-only custom
`hooksPath` is supported. A task blocked by active hooks can proceed only after
an administrator explicitly confirms **Allow Git hooks and retry** on that task.
The consent is persisted on the managed binding and worktree, does not change
repository configuration, and applies to later integration operations for that
task. Git runs as argument arrays with deadlines, bounded output and
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

## Retention, cleanup and quotas

Stop, archive, approval, dismissal and retry do not delete worktrees. Purge first
persists a cleanup tombstone and refuses while filesystem ownership remains.
Tombstones and ownership records survive Run/session deletion and backup restore.

Defaults: seven-day retention for clean integrated inactive trees, eight owned
worktrees/repository, 32/Node, 1 GiB free-space floor, and an approximate 10 GiB
managed-byte budget. General settings and the defaults API configure these limits.
Retention sweeps perform at most two operations/minute. Quotas include reservations;
tracked-byte estimates and bounded filesystem observations are approximate, not
an OS disk quota. Dirty/unknown work is never evicted to make room.

Normal cleanup requires fresh ownership, registry and containment validation, no
active readers/writers or unresolved integration, and clean staged/unstaged/
untracked/ignored status. It uses `git worktree remove <verified-path>` without
force; there is no recursive-delete fallback and no repository-wide prune.
Branches are kept by default. Explicit deletion requires a reachable integration
result and `git branch -d`; a refusal keeps the branch.

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
GET  /api/runs/:id/worktree
POST /api/runs/:id/worktree/:action
```

Actions: `observe`, `reconcile`, `retry-create`, `retain`, `quiesce`,
`integration-preview`, `integration-start`, `integration-continue`,
`integration-abort`, `cleanup`, `abandon`. Reconcile first drains an outstanding
correlated acknowledgement before another filesystem transition is permitted.

General settings explain scope/quotas. Normal task creation names the selected
repository, current committed baseline and `Isolated worktree` mode. It does not
ask users to choose a filesystem destination. Generated branches, long paths,
internal identities and cleanup mechanics are hidden behind `Workspace details`.
Task detail keeps repository, base and `Preparing isolated workspace` state
visible; bindings, generation, base/HEAD, branch/path/Node, lifecycle, lock/dirty
observations, integration and cleanup controls remain progressively disclosed.
Dialogs use accessible labels, non-color status/error text, explicit confirmation
and focus restoration. A setup failure creates one error notification independent
of ordinary agent-notification preferences, increments unread count, names the
task, navigates to it and uses a stable generation key across replay/reconnect.
A successful retry resolves that notification. Creation failure and merge
conflict/reconciliation notifications use generic browser-safe text;
ordinary dependency completion remains quiet.

## Limitations / deferred

This is not a sandbox or a guarantee against arbitrary external programs or users
modifying a checkout. There are no per-agent worktrees and no intra-task
multi-writer execution. Node loss never proves cleanliness or process exit.
V1 rejects bare/unborn repositories, submodules, active sparse/worktree-specific
configuration and partial/promisor clones. Repositories with LFS attributes are
rejected; a globally installed but unused LFS filter is harmless.

Deferred: automatic push/PR, rebase, cherry-pick, automatic conflict resolution,
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
HTTP/WebSocket/Git smoke: two normal Runs execute concurrently, reviewers receive
their original trees and uncommitted changes, the source remains unchanged,
CSRF/revision gates reject invalid mutations, and conflict/abort/cleanup use real
Git. It also proves unsupported Nodes receive no worktree frames.
