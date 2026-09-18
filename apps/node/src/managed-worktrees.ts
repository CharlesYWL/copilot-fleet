import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  GitShaSchema,
  IntegrationPreviewSchema,
  ManagedWorktreeSchema,
  RepositoryExecutionPolicySchema,
  RepositoryFeaturesSchema,
  RepositoryIdentitySchema,
  WorktreeConflict,
  WorktreeIntegrationSchema,
  WorktreeObservationSchema,
  WorktreeOperationRequestSchema,
  WorktreeOperationResultSchema,
  type CheckoutIdentity,
  type ExecutionBinding,
  type IntegrationPreview,
  type ManagedWorktree,
  type RepositoryFeatures,
  type RepositoryExecutionPolicy,
  type RepositoryIdentity,
  type RepositoryProbeRequest,
  type RepositoryProbeResult,
  type WorkspaceResult,
  type WorktreeIntegration,
  type WorktreeObservation,
  type WorktreeOperationRequest,
  type WorktreeOperationResult,
} from "@fleet/protocol";
import {
  assertIdentity,
  canonicalPath,
  containedPath,
  identityHash,
} from "./canonical-path.js";
import { CheckoutLocks, type CheckoutLease } from "./checkout-locks.js";
import {
  GitRunner,
  parseWorktreeRegistry,
  type WorktreeRegistryEntry,
} from "./git-runner.js";

export class WorktreeCrash extends Error {}
export type ManagedWorktreeOptions = {
  directory: string;
  nodeId: () => string;
  locks?: CheckoutLocks;
  git?: GitRunner;
  root?: string;
  quiesce?: (worktreeId: string, targetPath?: string) => Promise<void>;
  checkpoint?: (
    stage: "intent" | "git" | "receipt",
    request: WorktreeOperationRequest,
  ) => void;
  uploadArtifact?: (result: WorkspaceResult, path: string) => Promise<WorkspaceResult>;
  downloadArtifact?: (
    result: WorkspaceResult,
    path: string,
    operationId: string,
  ) => Promise<void>;
};
const now = () => new Date().toISOString();
const unresolved = new Set([
  "integrating",
  "validating",
  "ready",
  "conflicted",
  "resolving",
  "aborting",
  "uncertain",
  "needs_reconciliation",
]);

export class ManagedWorktrees {
  readonly locks: CheckoutLocks;
  readonly git: GitRunner;
  readonly installationId: string;
  private readonly db: DatabaseSync;
  private readonly inFlight = new Map<string, Promise<WorktreeOperationResult>>();
  private readonly queuedRequests = new Map<string, WorktreeOperationRequest>();
  private readonly worktreeTails = new Map<string, Promise<void>>();
  private readonly integrationLeases = new Map<string, CheckoutLease>();
  private readonly repositoryScans = new Map<
    string,
    Promise<{ submodules: boolean; gitLfs: boolean; estimatedBytes: number }>
  >();
  private readonly adminQueues = new Map<string, Promise<void>>();
  private paused = false;
  private closed = false;

  constructor(private readonly options: ManagedWorktreeOptions) {
    mkdirSync(options.directory, { recursive: true });
    this.db = new DatabaseSync(join(options.directory, "managed-worktrees.db"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trees (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      DROP INDEX IF EXISTS idx_trees_run_generation;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trees_owner_generation
        ON trees(
          json_extract(data,'$.runId'),
          COALESCE(json_extract(data,'$.ownerStepId'),''),
          COALESCE(json_extract(data,'$.workspaceKind'),'primary'),
          json_extract(data,'$.generation')
        );
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO identity (id,value) VALUES (1,?)")
      .run(randomUUID());
    this.installationId = String(
      this.db.prepare("SELECT value FROM identity WHERE id=1").get()!.value,
    );
    this.locks = options.locks ?? new CheckoutLocks();
    this.git = options.git ?? new GitRunner();
  }

  private remoteBranch(
    baseRef: string,
    configuredRemote: string,
  ): { remote: string; branch: string } {
    const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(baseRef);
    const remote = configuredRemote || match?.[1] || "";
    const branch = match?.[2] || "";
    if (!remote || !branch || branch.startsWith("-"))
      throw new WorktreeConflict(
        "integration_base_invalid",
        "A materializable base must be a validated remote-tracking ref.",
      );
    return { remote, branch };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  async shutdown(): Promise<void> {
    this.paused = true;
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(this.inFlight.values());
      errors.push(
        ...results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        ),
      );
    } finally {
      this.close();
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Managed worktree operations failed during shutdown.",
      );
  }

  async quarantine(): Promise<void> {
    this.paused = true;
    const errors: unknown[] = [];
    try {
      const results = await Promise.allSettled(this.inFlight.values());
      errors.push(
        ...results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        ),
      );
      for (const row of this.db.prepare("SELECT data FROM trees").all()) {
        try {
          const tree = ManagedWorktreeSchema.parse(JSON.parse(String(row.data)));
          if (tree.state !== "removed" && !tree.abandonedAt)
            this.save({
              ...tree,
              state: "quarantined",
              error: "Node identity was restored; explicit reconciliation is required.",
            });
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.paused = false;
    }
    if (errors.length)
      throw new AggregateError(errors, "Worktree quarantine encountered failures.");
  }

  requireReconciliation(binding: ExecutionBinding, reason: string): void {
    const tree = this.get(binding.worktreeId);
    if (!tree || tree.generation !== binding.generation) return;
    this.save({
      ...tree,
      state: tree.state === "quarantined" ? "quarantined" : "needs_reconciliation",
      error: reason,
      version: tree.version + 1,
      updatedAt: now(),
    });
  }

  get(id: string): ManagedWorktree | undefined {
    const row = this.db.prepare("SELECT data FROM trees WHERE id=?").get(id);
    return row ? ManagedWorktreeSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  private save(tree: ManagedWorktree): void {
    this.db
      .prepare(
        "INSERT INTO trees (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(tree.id, JSON.stringify(ManagedWorktreeSchema.parse(tree)));
  }

  private integration(id: string): WorktreeIntegration | undefined {
    const row = this.db.prepare("SELECT data FROM integrations WHERE id=?").get(id);
    return row
      ? WorktreeIntegrationSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }

  private saveIntegration(value: WorktreeIntegration): void {
    this.db
      .prepare(
        "INSERT INTO integrations (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, JSON.stringify(WorktreeIntegrationSchema.parse(value)));
  }

  private integrations(treeId: string): WorktreeIntegration[] {
    return this.db
      .prepare("SELECT data FROM integrations")
      .all()
      .map((row) => WorktreeIntegrationSchema.parse(JSON.parse(String(row.data))))
      .filter((entry) => entry.worktreeId === treeId);
  }

  execute(input: WorktreeOperationRequest): Promise<WorktreeOperationResult> {
    if (this.paused || this.closed)
      return Promise.reject(
        new WorktreeConflict(
          "node_draining",
          "Managed worktree operations are paused for Node teardown.",
        ),
      );
    const request = WorktreeOperationRequestSchema.parse(input);
    const pending = this.inFlight.get(request.operationId);
    if (pending) {
      if (!isDeepStrictEqual(this.queuedRequests.get(request.operationId), request)) {
        return Promise.reject(
          new WorktreeConflict(
            "idempotency_mismatch",
            "Operation ID was reused with different arguments.",
          ),
        );
      }
      return pending;
    }
    const prior = this.worktreeTails.get(request.worktreeId) ?? Promise.resolve();
    this.queuedRequests.set(request.operationId, request);
    const promise = prior
      .then(() => this.runOperation(request))
      .finally(() => {
        this.inFlight.delete(request.operationId);
        this.queuedRequests.delete(request.operationId);
      });
    const tail = promise.then(
      () => undefined,
      () => undefined,
    );
    this.worktreeTails.set(request.worktreeId, tail);
    void tail.then(() => {
      if (this.worktreeTails.get(request.worktreeId) === tail)
        this.worktreeTails.delete(request.worktreeId);
    });
    this.inFlight.set(request.operationId, promise);
    return promise;
  }

  private async runOperation(
    request: WorktreeOperationRequest,
  ): Promise<WorktreeOperationResult> {
    let result: WorktreeOperationResult;
    try {
      if (request.nodeId !== this.options.nodeId()) {
        throw new WorktreeConflict("wrong_owner", "This Node does not own that request.");
      }
      const previous = this.db
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(request.operationId);
      if (previous) {
        const previousRequest = WorktreeOperationRequestSchema.parse(
          JSON.parse(String(previous.request)),
        );
        if (!isDeepStrictEqual(previousRequest, request)) {
          throw new WorktreeConflict(
            "idempotency_mismatch",
            "Operation ID was reused with different arguments.",
          );
        }
        if (previous.result)
          return WorktreeOperationResultSchema.parse(JSON.parse(String(previous.result)));
      } else {
        this.db
          .prepare("INSERT INTO operations (id,request) VALUES (?,?)")
          .run(request.operationId, JSON.stringify(request));
      }
      this.options.checkpoint?.("intent", request);
      const payload = await this.perform(request);
      result = WorktreeOperationResultSchema.parse({
        operationId: request.operationId,
        worktreeId: request.worktreeId,
        generation: request.generation,
        nodeId: request.nodeId,
        hostInstallationId: request.hostInstallationId,
        ok: true,
        ...payload,
        acknowledgedAt: now(),
      });
    } catch (error) {
      if (error instanceof WorktreeCrash) throw error;
      const candidate = this.get(request.worktreeId);
      const code = error instanceof WorktreeConflict ? error.code : "git_failed";
      const tree = [
        "binding_mismatch",
        "idempotency_mismatch",
        "wrong_owner",
        "stale_revision",
      ].includes(code)
        ? undefined
        : candidate;
      const message =
        error instanceof Error ? error.message : "Worktree operation failed.";
      if (tree && this.ownedBy(tree, request)) {
        tree.error = message;
        if (tree.state === "creating") tree.state = "creation_failed";
        if (tree.state === "removing") tree.state = "needs_reconciliation";
        tree.updatedAt = now();
      }
      result = WorktreeOperationResultSchema.parse({
        operationId: request.operationId,
        worktreeId: request.worktreeId,
        generation: request.generation,
        nodeId: request.nodeId,
        hostInstallationId: request.hostInstallationId,
        ok: false,
        code,
        error: message,
        retryable: code === "checkout_busy" || code === "artifact_transport_failed",
        ...(tree && this.ownedBy(tree, request) ? { worktree: tree } : {}),
        acknowledgedAt: now(),
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (result.worktree) {
        result.worktree.version += 1;
        result.worktree.updatedAt = now();
        this.save(result.worktree);
      }
      this.db
        .prepare("UPDATE operations SET result=? WHERE id=?")
        .run(JSON.stringify(result), request.operationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.options.checkpoint?.("receipt", request);
    return result;
  }

  private ownedBy(tree: ManagedWorktree, request: WorktreeOperationRequest): boolean {
    return (
      tree.nodeId === request.nodeId &&
      tree.hostInstallationId === request.hostInstallationId &&
      tree.nodeInstallationId === this.installationId &&
      tree.runId === request.runId &&
      tree.generation === request.generation &&
      tree.sourcePlacementId === request.sourcePlacementId &&
      tree.originatingPlacementId === request.originatingPlacementId &&
      (!request.repositoryIdentity ||
        tree.repositoryIdentity === request.repositoryIdentity) &&
      tree.workspaceId === request.workspaceId
    );
  }

  private async perform(request: WorktreeOperationRequest): Promise<{
    worktree: ManagedWorktree;
    preview?: IntegrationPreview;
    integration?: WorktreeIntegration;
    workspaceResult?: WorkspaceResult;
  }> {
    let tree = this.get(request.worktreeId);
    if (tree) {
      if (
        !this.ownedBy(tree, request) ||
        (request.expectedPath && request.expectedPath !== tree.path) ||
        (request.expectedBranchRef && request.expectedBranchRef !== tree.branchRef) ||
        (request.expectedBaseSha && request.expectedBaseSha !== tree.baseSha)
      ) {
        throw new WorktreeConflict(
          "binding_mismatch",
          "Node ownership, generation, path, ref or base SHA did not match.",
        );
      }
      if (
        request.expectedVersion !== tree.version &&
        !(request.kind === "reconcile" && request.expectedVersion < tree.version)
      ) {
        throw new WorktreeConflict(
          "stale_revision",
          "Worktree revision changed. Refresh before retrying.",
        );
      }
      if (tree.abandonedAt && request.kind !== "observe") {
        throw new WorktreeConflict(
          "abandoned",
          "Ownership was explicitly abandoned. Fleet cannot adopt or modify these files.",
        );
      }
      await this.verifyRoots(tree);
      if ((await canonicalPath(request.sourcePath)).key !== tree.repository.key) {
        throw new WorktreeConflict(
          "source_changed",
          "The source placement no longer names the pinned repository.",
        );
      }
    } else if (request.kind !== "reserve" || request.expectedVersion !== 0) {
      throw new WorktreeConflict(
        "unknown_worktree",
        "This installation has no ownership record; existing files will not be adopted.",
      );
    }
    const source = tree?.repository ?? (await this.repository(request.sourcePath));
    const common = tree?.commonDirectory ?? (await this.commonDirectory(source.path));
    this.locks.bindScope(common, common);
    if (tree && request.kind === "quiesce") {
      if (
        request.targetPath &&
        (await this.commonDirectory(request.targetPath)).key !== common.key
      )
        throw new WorktreeConflict(
          "target_repository",
          "Target is not in the task repository.",
        );
      if (!this.options.quiesce)
        throw new WorktreeConflict(
          "quiescence_unavailable",
          "Session supervision is unavailable.",
        );
      await this.options.quiesce(tree.id, request.targetPath);
    }
    if (request.kind === "reconcile") this.locks.reconcileAdmin(common);
    const leaveQueue = await this.enterAdminQueue(common.key);
    let admin: CheckoutLease | undefined;
    try {
      if (tree) {
        tree = this.get(tree.id)!;
        if (
          tree.version !== request.expectedVersion &&
          !(request.kind === "reconcile" && request.expectedVersion < tree.version)
        ) {
          throw new WorktreeConflict(
            "stale_revision",
            "The worktree changed while repository administration was queued.",
          );
        }
      }
      admin = this.locks.acquire(common, {
        owner: `operation:${request.operationId}`,
        attempt: request.operationId,
        kind: "admin",
      });
      await admin.revalidate();
      if (!tree) {
        tree = await this.reserve(request, source, common, admin);
        return { worktree: tree };
      }
      if (request.kind === "reserve") return { worktree: tree };
      if (request.kind === "create")
        return { worktree: await this.create(tree, request, admin) };
      if (request.kind === "compose")
        return { worktree: await this.compose(tree, request, admin) };
      if (request.kind === "materialize")
        return { worktree: await this.materialize(tree, request, admin) };
      if (request.kind === "finalize") {
        const finalized = await this.finalize(tree, request);
        return {
          worktree: finalized.worktree,
          ...(finalized.result ? { workspaceResult: finalized.result } : {}),
        };
      }
      if (request.kind === "cleanup" && tree.state === "removing")
        return await this.reconcile(tree, request, admin);
      if (request.kind === "reconcile") return await this.reconcile(tree, request, admin);
      if (
        tree.state === "quarantined" ||
        tree.state === "unavailable" ||
        tree.state === "needs_reconciliation"
      ) {
        throw new WorktreeConflict(
          "reconciliation_required",
          "Explicit reconciliation is required before operating on this checkout.",
        );
      }
      if (tree.state === "removed") {
        if (request.kind === "cleanup" || request.kind === "observe")
          return { worktree: tree };
        throw new WorktreeConflict(
          "removed",
          "This task's checkout was removed. It will not fall back to the source checkout.",
        );
      }
      if (request.kind === "abandon" && !(await exists(tree.path))) {
        const entries = await this.registry(tree);
        const owned = tree;
        if (
          entries.some(
            (entry) =>
              (entry.branch === owned.branchRef && !samePath(entry.path, owned.path)) ||
              (samePath(entry.path, owned.path) && entry.branch !== owned.branchRef),
          )
        ) {
          throw new WorktreeConflict(
            "registry_mismatch",
            "The absent checkout's registration no longer matches its owner.",
          );
        }
        if (tree.checkout && this.locks.holder(tree.checkout.key)) {
          throw new WorktreeConflict(
            "process_unknown",
            "A missing checkout still has process ownership; abandonment is blocked.",
          );
        }
        if (this.integrations(tree.id).some((entry) => unresolved.has(entry.state))) {
          throw new WorktreeConflict(
            "integration_unresolved",
            "Reconcile the merge before abandonment.",
          );
        }
        this.confirmAbandon(tree, request);
        return { worktree: tree };
      }
      await this.verifyTree(tree);
      if (
        request.kind === "observe" ||
        request.kind === "retain" ||
        request.kind === "quiesce"
      ) {
        tree.observation = await this.observe(tree);
        if (request.kind === "retain") {
          tree.state = "retained";
          tree.retainedAt = now();
          if (request.actor === "bounded-retention") {
            tree.orphanedAt ||= tree.retainedAt;
            tree.orphanReason ||= "The owning task is terminal and no session holds it.";
          }
          tree.expiresAt =
            (tree.workspaceKind !== "primary" ||
              ["integrated", "no_changes"].includes(tree.integrationState)) &&
            tree.observation.dirty === false
              ? new Date(
                  Date.now() + request.policy.retentionDays * 86_400_000,
                ).toISOString()
              : "";
        }
        return { worktree: tree };
      }
      if (request.kind === "cleanup" || request.kind === "abandon") {
        return { worktree: await this.cleanup(tree, request, admin) };
      }
      return await this.integrate(tree, request, admin);
    } finally {
      try {
        admin?.release();
      } finally {
        leaveQueue();
      }
    }
  }

  private async enterAdminQueue(key: string): Promise<() => void> {
    const prior = this.adminQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate);
    this.adminQueues.set(key, tail);
    await prior;
    return () => {
      release();
      if (this.adminQueues.get(key) === tail) this.adminQueues.delete(key);
    };
  }

  private async repository(path: string): Promise<CheckoutIdentity> {
    const source = await canonicalPath(path);
    const root = await this.git.run(source.path, ["rev-parse", "--show-toplevel"]);
    const repository = await canonicalPath(root.stdout.trim());
    if (repository.key !== source.key)
      throw new WorktreeConflict(
        "repository_root_required",
        "Managed mode requires a placement at the repository root, not a nested directory.",
      );
    const bare = await this.git.run(source.path, ["rev-parse", "--is-bare-repository"]);
    if (bare.stdout.trim() !== "false")
      throw new WorktreeConflict(
        "bare_repository",
        "Bare repositories are not supported.",
      );
    return repository;
  }

  private async commonDirectory(path: string): Promise<CheckoutIdentity> {
    return canonicalPath(
      (
        await this.git.run(path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).stdout.trim(),
    );
  }

  private async supportedRepository(
    path: string,
    base: string,
    allowGitHooks = false,
  ): Promise<{
    features: RepositoryFeatures;
    executionPolicy: RepositoryExecutionPolicy;
    estimatedBytes: number;
  }> {
    const config = await this.git.run(
      path,
      [
        "config",
        "--get-regexp",
        "^(extensions\\.(partialclone|worktreeconfig)|core\\.(sparsecheckout|sparsecheckoutcone)|remote\\..*\\.(promisor|partialclonefilter))$",
      ],
      { allowedExitCodes: [0, 1] },
    );
    const sparseCheckout =
      (
        await this.git.run(path, ["config", "--bool", "core.sparseCheckout"], {
          allowedExitCodes: [0, 1],
        })
      ).stdout.trim() === "true";
    const sparseCone =
      sparseCheckout &&
      (
        await this.git.run(path, ["config", "--bool", "core.sparseCheckoutCone"], {
          allowedExitCodes: [0, 1],
        })
      ).stdout.trim() !== "false";
    const sparsePaths = sparseCheckout
      ? (
          await this.git.run(path, ["sparse-checkout", "list"], {
            maxBytes: 1_000_000,
          })
        ).stdout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    const scanKey = `${path}\0${base}`;
    let scan = this.repositoryScans.get(scanKey);
    if (!scan) {
      scan = (async () => {
        const files = await this.git.run(path, ["ls-tree", "-r", "-l", base], {
          maxBytes: 2_000_000,
        });
        const attributes = await this.git.run(
          path,
          ["grep", "-I", "-l", "-e", "filter=lfs", base, "--", "*.gitattributes"],
          { allowedExitCodes: [0, 1] },
        );
        return {
          submodules:
            /^160000 /m.test(files.stdout) || /\t\.gitmodules$/m.test(files.stdout),
          gitLfs: Boolean(attributes.stdout.trim()),
          estimatedBytes: files.stdout
            .split("\n")
            .reduce(
              (sum, line) =>
                sum + (Number(/^\d+ \w+ [a-f0-9]+ +(\d+)\t/.exec(line)?.[1]) || 0),
              0,
            ),
        };
      })().catch((error: unknown) => {
        this.repositoryScans.delete(scanKey);
        throw error;
      });
      this.repositoryScans.set(scanKey, scan);
    }
    const scanned = await scan;
    if (scanned.gitLfs) {
      const lfs = await this.git.run(path, ["lfs", "version"], {
        allowedExitCodes: [0, 1],
      });
      if (lfs.exitCode !== 0)
        throw new WorktreeConflict(
          "git_lfs_required",
          "This repository uses Git LFS. Install git-lfs for the Node service account before retrying.",
        );
    }
    const features = RepositoryFeaturesSchema.parse({
      sparseCheckout,
      sparseCone,
      sparsePaths,
      submodules: scanned.submodules,
      gitLfs: scanned.gitLfs,
      partialClone: /(?:promisor|partialclone)/i.test(config.stdout),
      estimatedBytesReliable: !scanned.submodules && !scanned.gitLfs,
    });
    return {
      features,
      executionPolicy: await this.repositoryExecutionPolicy(
        path,
        features,
        allowGitHooks,
      ),
      estimatedBytes: scanned.estimatedBytes,
    };
  }

  private async repositoryExecutionPolicy(
    path: string,
    features: RepositoryFeatures,
    allowGitHooks: boolean,
  ): Promise<RepositoryExecutionPolicy> {
    const hooksPath = (
      await this.git.run(path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "hooks",
      ])
    ).stdout.trim();
    const hookNames = (
      await readdir(hooksPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      })
    ).filter((name) => !name.endsWith(".sample"));
    const hookIdentity: string[] = [];
    for (const name of hookNames.sort()) {
      const body = await readFile(join(hooksPath, name));
      hookIdentity.push(`${name}:${createHash("sha256").update(body).digest("hex")}`);
    }
    if (!allowGitHooks && hookIdentity.length)
      throw new WorktreeConflict(
        "unsupported_hooks",
        `Managed mode refuses active Git hooks in ${hooksPath} unless their exact content is approved.`,
      );
    const filterConfig = (
      await this.git.run(
        path,
        ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
        { allowedExitCodes: [0, 1] },
      )
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    const unsupportedFilters = filterConfig.filter(
      (entry) => !/^filter\.lfs\./i.test(entry),
    );
    if (unsupportedFilters.length)
      throw new WorktreeConflict(
        "unsupported_git_filter",
        "Managed mode refuses repository filters other than verified Git LFS.",
      );
    const fsmonitor = (
      await this.git.run(path, ["config", "--get", "core.fsmonitor"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout.trim();
    if (fsmonitor && !/^(false|no|off|0)$/i.test(fsmonitor))
      throw new WorktreeConflict(
        "unsupported_fsmonitor",
        "Managed mode requires core.fsmonitor to be disabled.",
      );
    const submoduleUpdates = (
      await this.git.run(path, ["config", "--get-regexp", "^submodule\\..*\\.update$"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    if (submoduleUpdates.some((entry) => /\s!/.test(entry)))
      throw new WorktreeConflict(
        "unsupported_submodule_helper",
        "Managed mode refuses executable submodule update commands.",
      );
    const credentialHelpers = (
      await this.git.run(path, ["config", "--get-all", "credential.helper"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    const hooksDigest = createHash("sha256")
      .update(hookIdentity.join("\n"))
      .digest("hex");
    const filtersDigest = createHash("sha256")
      .update(filterConfig.join("\n"))
      .digest("hex");
    const credentialHelpersDigest = createHash("sha256")
      .update(
        credentialHelpers
          .map((value) => createHash("sha256").update(value).digest("hex"))
          .join("\n"),
      )
      .digest("hex");
    const configurationDigest = createHash("sha256")
      .update(
        JSON.stringify({
          hooksDigest,
          filtersDigest,
          fsmonitor: fsmonitor || "false",
          submoduleUpdates,
        }),
      )
      .digest("hex");
    return RepositoryExecutionPolicySchema.parse({
      hooks: hookIdentity.length ? "approved_exact" : "disabled",
      hooksDigest,
      filters: features.gitLfs ? "git_lfs" : "disabled",
      filtersDigest,
      submodules: features.submodules ? "node_local" : "disabled",
      credentialHelpersDigest,
      configurationDigest,
    });
  }

  private workspacePolicyMatches(
    expected: RepositoryExecutionPolicy,
    observed: RepositoryExecutionPolicy,
    options: { ignoreHooks?: boolean } = {},
  ): boolean {
    const {
      credentialHelpersDigest: _expectedCredentialHelpersDigest,
      ...expectedWorkspacePolicy
    } = expected;
    const {
      credentialHelpersDigest: _observedCredentialHelpersDigest,
      ...observedWorkspacePolicy
    } = observed;
    if (isDeepStrictEqual(expectedWorkspacePolicy, observedWorkspacePolicy)) return true;
    return this.workspacePolicyMismatches(expected, observed, options).length === 0;
  }

  private workspacePolicyMismatches(
    expected: RepositoryExecutionPolicy,
    observed: RepositoryExecutionPolicy,
    options: { ignoreHooks?: boolean } = {},
  ): string[] {
    const mismatches: string[] = [];
    if (expected.version !== observed.version) mismatches.push("policy version");
    if (
      !options.ignoreHooks &&
      (expected.hooks !== observed.hooks || expected.hooksDigest !== observed.hooksDigest)
    )
      mismatches.push("Git hooks");
    if (
      expected.filters !== observed.filters ||
      expected.filtersDigest !== observed.filtersDigest
    )
      mismatches.push("Git filters");
    if (expected.fsmonitor !== observed.fsmonitor) mismatches.push("fsmonitor");
    if (expected.submodules !== observed.submodules) mismatches.push("submodule mode");
    if (expected.credentialHelpers !== observed.credentialHelpers)
      mismatches.push("credential-helper policy");
    if (
      expected.submodules !== "disabled" &&
      expected.configurationDigest !== observed.configurationDigest
    )
      mismatches.push("submodule helper configuration");
    return mismatches;
  }

  private async verifyRepositoryExecutionPolicy(
    tree: ManagedWorktree,
    path = tree.repository.path,
    options: {
      adoptCredentialHelpers?: boolean;
      strictCredentialHelpers?: boolean;
      ignoreHooks?: boolean;
    } = {},
  ): Promise<void> {
    const observed = await this.repositoryExecutionPolicy(
      path,
      tree.repositoryFeatures,
      tree.allowGitHooks,
    );
    if (!this.workspacePolicyMatches(tree.repositoryExecutionPolicy, observed, options)) {
      const scope = samePath(path, tree.repository.path)
        ? "source repository"
        : "integration workspace";
      const mismatches = this.workspacePolicyMismatches(
        tree.repositoryExecutionPolicy,
        observed,
        options,
      );
      throw new WorktreeConflict(
        "repository_execution_policy_changed",
        `Repository execution policy changed in the ${scope}: ${mismatches.join(", ")}.`,
      );
    }
    if (
      options.strictCredentialHelpers &&
      observed.credentialHelpersDigest !==
        tree.repositoryExecutionPolicy.credentialHelpersDigest
    )
      throw new WorktreeConflict(
        "publication_credential_policy_changed",
        "Git credential-helper configuration changed after integration preview. Review the refreshed publication result before retrying.",
      );
    if (
      !tree.repositoryExecutionPolicy.credentialHelpersDigest ||
      (options.adoptCredentialHelpers &&
        observed.credentialHelpersDigest !==
          tree.repositoryExecutionPolicy.credentialHelpersDigest)
    ) {
      tree.repositoryExecutionPolicy = observed;
      this.save(tree);
    }
  }

  private async noninteractivePolicy(
    path: string,
    committing: boolean,
    allowGitHooks = false,
  ): Promise<boolean> {
    const hooksPath = (
      await this.git.run(path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "hooks",
      ])
    ).stdout.trim();
    const hookNames = await readdir(hooksPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (!allowGitHooks && hookNames.some((name) => !name.endsWith(".sample"))) {
      throw new WorktreeConflict(
        "unsupported_hooks",
        `V1 refuses active Git hooks in ${hooksPath}; remove or disable them before retrying Managed mode, or use Legacy mode. No hooks are bypassed silently.`,
      );
    }
    if (!committing) return true;
    const signing = await this.git.run(path, ["config", "--get", "commit.gpgSign"], {
      allowedExitCodes: [0, 1],
    });
    if (/^(true|yes|on|1)$/i.test(signing.stdout.trim())) return false;
    for (const who of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
      const identity = await this.git.run(path, ["var", who], {
        allowedExitCodes: [0, 128],
      });
      if (identity.exitCode !== 0) return false;
    }
    return true;
  }

  private async disabledHooksPath(): Promise<string> {
    const hooks = join(this.options.directory, "empty-hooks");
    await mkdir(hooks, { recursive: true });
    return hooks;
  }

  private async registry(
    tree: Pick<ManagedWorktree, "repository">,
  ): Promise<WorktreeRegistryEntry[]> {
    return parseWorktreeRegistry(
      (
        await this.git.run(tree.repository.path, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ])
      ).stdout,
    );
  }

  private async reserve(
    request: WorktreeOperationRequest,
    repository: CheckoutIdentity,
    commonDirectory: CheckoutIdentity,
    admin: CheckoutLease,
  ): Promise<ManagedWorktree> {
    const sourceHead = GitShaSchema.parse(
      (
        await this.git.run(repository.path, ["rev-parse", "--verify", "HEAD^{commit}"])
      ).stdout.trim(),
    );
    let base = request.expectedBaseSha
      ? GitShaSchema.parse(request.expectedBaseSha)
      : sourceHead;
    let fetchedBase: { ref: string; sha: string } | undefined;
    if (request.expectedBaseSha && !(await this.hasCommit(repository.path, base))) {
      const resolved = this.remoteBranch(
        request.expectedBaseRef,
        request.integrationRemote,
      );
      const materialized = await this.fetchIntegrationBase(
        repository.path,
        {
          ...request,
          integrationBaseRef: request.expectedBaseRef,
          integrationRemote: resolved.remote,
        },
        admin,
        "execution-base",
      );
      if (materialized.sha !== base)
        throw new WorktreeConflict(
          "execution_base_mismatch",
          "The remote execution base no longer resolves to the pinned SHA.",
        );
      fetchedBase = materialized;
    }
    if (!request.expectedBaseSha && request.integrationBaseRef) {
      fetchedBase = await this.fetchIntegrationBase(
        repository.path,
        request,
        admin,
        "reservation",
      );
      base = GitShaSchema.parse(fetchedBase.sha);
    }
    if (
      request.sourcePlacementId === request.originatingPlacementId &&
      sourceHead !== base &&
      !request.integrationBaseRef
    )
      throw new WorktreeConflict(
        "source_advanced",
        "The source checkout advanced after the Run base was pinned. Fleet will not silently change the composition base.",
      );
    const localBaseRef = (
      await this.git.run(repository.path, ["symbolic-ref", "-q", "HEAD"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout.trim();
    const baseRef = request.integrationBaseRef
      ? request.integrationBaseRef
      : request.sourcePlacementId === request.originatingPlacementId
        ? localBaseRef
        : request.expectedBaseRef;
    const repositoryIdentity = await this.repositoryIdentity(repository.path, base);
    if (
      request.repositoryIdentity &&
      request.repositoryIdentity !== repositoryIdentity.id
    )
      throw new WorktreeConflict(
        "repository_identity_mismatch",
        "This placement is not the task's logical repository.",
      );
    if (
      request.repositoryObjectFormat &&
      request.repositoryObjectFormat !== repositoryIdentity.objectFormat
    )
      throw new WorktreeConflict(
        "repository_object_format",
        "This placement uses a different Git object format.",
      );
    const compatibility = await this.supportedRepository(
      repository.path,
      base,
      request.allowGitHooks,
    );
    await this.registry({ repository });
    const trees = this.db
      .prepare("SELECT data FROM trees")
      .all()
      .map((row) => ManagedWorktreeSchema.parse(JSON.parse(String(row.data))))
      .filter((entry) => entry.state !== "removed" && !entry.abandonedAt);
    if (
      trees.length >= request.policy.maxPerNode ||
      trees.filter((entry) => entry.commonDirectory.key === commonDirectory.key).length >=
        request.policy.maxPerRepository
    ) {
      throw new WorktreeConflict(
        "worktree_quota",
        "Managed worktree quota reached. Retain dirty work; clean up an inactive owned checkout or raise the limit.",
      );
    }
    const parent = await canonicalPath(dirname(repository.path));
    const outer = this.options.root ?? join(parent.path, ".fleet-worktrees");
    await mkdir(outer, { recursive: true });
    if ((await lstat(outer)).isSymbolicLink())
      throw new WorktreeConflict(
        "root_alias",
        "The managed root may not be a symlink or junction.",
      );
    const outerIdentity = await canonicalPath(outer);
    if (
      containedPath(repository.path, outerIdentity.path) ||
      outerIdentity.key === repository.key ||
      containedPath(commonDirectory.path, outerIdentity.path)
    ) {
      throw new WorktreeConflict(
        "nested_root",
        "The managed root must be outside the source repository and Git common directory.",
      );
    }
    const rootPath = join(
      outerIdentity.path,
      identityHash(`${commonDirectory.key}:${this.installationId}`).slice(0, 24),
    );
    const marker = join(rootPath, ".fleet-owner.json");
    const owner = {
      nodeInstallationId: this.installationId,
      hostInstallationId: request.hostInstallationId,
      commonDirectory: commonDirectory.key,
    };
    if (await exists(rootPath)) {
      const recorded: unknown = JSON.parse(await readFile(marker, "utf8"));
      if (!isDeepStrictEqual(recorded, owner))
        throw new WorktreeConflict(
          "root_collision",
          "The managed root belongs to another owner.",
        );
    } else {
      await mkdir(rootPath);
      await writeFile(marker, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    }
    if ((await lstat(rootPath)).isSymbolicLink())
      throw new WorktreeConflict("root_alias", "The managed root may not be a junction.");
    const managedRoot = await canonicalPath(rootPath);
    const safeKey = identityHash(
      request.workspaceKind === "primary"
        ? `${request.hostInstallationId}:${request.runId}:${request.generation}`
        : `${request.hostInstallationId}:${request.runId}:${request.workspaceKind}:${request.ownerStepId}:${request.generation}`,
    ).slice(0, 32);
    const path = join(managedRoot.path, safeKey);
    const branchRef = `refs/heads/fleet/${safeKey}`;
    const pinRef = `refs/fleet/pins/${safeKey}`;
    if (
      (await exists(path)) ||
      (await this.ref(repository.path, branchRef)) ||
      (await this.ref(repository.path, pinRef))
    ) {
      throw new WorktreeConflict(
        "path_ref_collision",
        "The deterministic task path or ref already exists without this operation's ownership receipt.",
      );
    }
    const estimate = compatibility.estimatedBytes;
    const free = await statfs(managedRoot.path);
    const freeBytes = free.bavail * free.bsize;
    if (
      freeBytes - estimate < request.policy.freeSpaceFloorBytes ||
      trees.reduce(
        (sum, entry) => sum + (entry.observation?.approximateBytes ?? 0),
        estimate,
      ) > request.policy.byteBudget
    ) {
      throw new WorktreeConflict(
        "disk_quota",
        "The free-space floor or approximate managed-byte budget would be exceeded.",
      );
    }
    const tree = ManagedWorktreeSchema.parse({
      id: request.worktreeId,
      runId: request.runId,
      taskKey: safeKey,
      sourcePlacementId: request.sourcePlacementId,
      originatingPlacementId: request.originatingPlacementId || request.sourcePlacementId,
      executionPlacementId: request.sourcePlacementId,
      repositoryIdentity: repositoryIdentity.id,
      repositoryObjectFormat: repositoryIdentity.objectFormat,
      workspaceId: request.workspaceId,
      nodeId: request.nodeId,
      hostInstallationId: request.hostInstallationId,
      machineId: repository.machineId,
      nodeInstallationId: this.installationId,
      repository,
      commonDirectory,
      managedRoot,
      generation: request.generation,
      version: 0,
      path,
      branchRef,
      pinRef,
      baseSha: base,
      baseRef,
      workspaceKind: request.workspaceKind,
      ownerStepId: request.ownerStepId,
      composition: request.composition,
      repositoryFeatures: compatibility.features,
      repositoryExecutionPolicy: compatibility.executionPolicy,
      allowGitHooks: request.allowGitHooks,
      state: "reserved",
      createdAt: now(),
      updatedAt: now(),
      observation: WorktreeObservationSchema.parse({
        generation: request.generation,
        observedAt: now(),
        approximateBytes: estimate,
        freeBytes,
      }),
    });
    this.save(tree);
    await this.git.run(
      repository.path,
      ["update-ref", pinRef, base, "0".repeat(base.length)],
      { lease: admin },
    );
    if (
      fetchedBase &&
      (await this.ref(repository.path, fetchedBase.ref)) === fetchedBase.sha
    )
      await this.git.run(
        repository.path,
        ["update-ref", "-d", fetchedBase.ref, fetchedBase.sha],
        { lease: admin },
      );
    this.options.checkpoint?.("git", request);
    return tree;
  }

  private async verifyRoots(tree: ManagedWorktree): Promise<void> {
    await assertIdentity(tree.repository);
    await assertIdentity(tree.commonDirectory);
    await assertIdentity(tree.managedRoot);
    this.locks.bindScope(tree.commonDirectory, tree.commonDirectory);
    if (tree.checkout) this.locks.bindScope(tree.checkout, tree.commonDirectory);
    if (
      (await this.commonDirectory(tree.repository.path)).key !== tree.commonDirectory.key
    )
      throw new WorktreeConflict(
        "repository_changed",
        "Git common-directory identity changed.",
      );
    const marker: unknown = JSON.parse(
      await readFile(join(tree.managedRoot.path, ".fleet-owner.json"), "utf8"),
    );
    if (
      !isDeepStrictEqual(marker, {
        nodeInstallationId: this.installationId,
        hostInstallationId: tree.hostInstallationId,
        commonDirectory: tree.commonDirectory.key,
      })
    )
      throw new WorktreeConflict("wrong_owner", "Managed-root ownership changed.");
    if (
      dirname(tree.path) !== tree.managedRoot.path ||
      !containedPath(tree.managedRoot.path, tree.path)
    ) {
      throw new WorktreeConflict(
        "containment_failed",
        "Task path escaped the owned managed root.",
      );
    }
  }

  private async verifyTree(tree: ManagedWorktree): Promise<void> {
    await this.verifyRoots(tree);
    if (!(await exists(tree.path))) {
      tree.state = "missing";
      this.save(tree);
      throw new WorktreeConflict(
        "missing",
        "The task worktree is missing. Fleet will not recreate over unknown files or use the source checkout.",
      );
    }
    if ((await lstat(tree.path)).isSymbolicLink())
      throw new WorktreeConflict(
        "path_alias",
        "The owned task directory was replaced with a symlink or junction.",
      );
    const physical = await canonicalPath(tree.path);
    if (tree.checkout && physical.key !== tree.checkout.key)
      throw new WorktreeConflict(
        "identity_changed",
        "The task checkout directory was replaced.",
      );
    if ((await this.commonDirectory(tree.path)).key !== tree.commonDirectory.key)
      throw new WorktreeConflict(
        "registry_mismatch",
        "The task belongs to a different repository.",
      );
    const entries = await this.registry(tree);
    const entry = entries.find((candidate) => samePath(candidate.path, tree.path));
    if (!entry || entry.branch !== tree.branchRef || entry.bare || entry.prunable)
      throw new WorktreeConflict(
        "registry_mismatch",
        "Git's worktree registry, path and task branch disagree.",
      );
    if ((await canonicalPath(entry.path)).key !== physical.key)
      throw new WorktreeConflict(
        "registry_identity",
        "Registry and checkout refer to different physical directories.",
      );
    if (entry.locked)
      throw new WorktreeConflict(
        "registry_locked",
        "Git has locked this worktree; Fleet will not force-remove or unlock it.",
      );
    const ref = (
      await this.git.run(tree.path, ["symbolic-ref", "-q", "HEAD"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout.trim();
    if (ref !== tree.branchRef)
      throw new WorktreeConflict(
        "ref_mismatch",
        "The task's branch changed. Fleet never switches it back automatically.",
      );
    tree.checkout = physical;
    this.locks.bindScope(physical, tree.commonDirectory);
  }

  private async create(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<ManagedWorktree> {
    if (tree.workspaceKind !== "primary") await this.assertPinnedSource(tree);
    if (tree.state === "ready" || tree.state === "retained") {
      await this.verifyTree(tree);
      return tree;
    }

    if (!["reserved", "creating", "creation_failed"].includes(tree.state))
      throw new WorktreeConflict(
        "not_creatable",
        "This checkout needs explicit reconciliation, not recreation.",
      );
    await this.git.run(tree.repository.path, [
      "rev-parse",
      "--verify",
      `${tree.baseSha}^{commit}`,
    ]);
    const compatibility = await this.supportedRepository(
      tree.repository.path,
      tree.baseSha,
      tree.allowGitHooks,
    );
    if (!isDeepStrictEqual(tree.repositoryFeatures, compatibility.features))
      throw new WorktreeConflict(
        "repository_features_changed",
        "The repository checkout configuration changed after reservation. Retry setup from a fresh reservation.",
      );
    const disk = await statfs(tree.managedRoot.path);
    if (
      disk.bavail * disk.bsize - (tree.observation?.approximateBytes ?? 0) <
      request.policy.freeSpaceFloorBytes
    ) {
      throw new WorktreeConflict(
        "disk_quota",
        "Free space fell below the configured floor before physical creation.",
      );
    }
    const registered = (await this.registry(tree)).find((entry) =>
      samePath(entry.path, tree.path),
    );
    if (registered || (await exists(tree.path))) {
      if (tree.state === "reserved" || !registered)
        throw new WorktreeConflict(
          "path_ref_collision",
          "An unexpected target path or registration exists.",
        );
      await this.verifyTree(tree);
      if ((await this.ref(tree.path, "HEAD")) !== tree.baseSha)
        throw new WorktreeConflict(
          "unexpected_head",
          "Interrupted creation did not leave the pinned base checked out.",
        );
    } else {
      if (await this.ref(tree.repository.path, tree.branchRef))
        throw new WorktreeConflict(
          "ref_collision",
          "The task branch exists without its registered checkout.",
        );
      const pin = await this.ref(tree.repository.path, tree.pinRef);
      if (pin && pin !== tree.baseSha)
        throw new WorktreeConflict("pin_collision", "The task pin changed.");
      if (!pin)
        await this.git.run(
          tree.repository.path,
          ["update-ref", tree.pinRef, tree.baseSha, "0".repeat(tree.baseSha.length)],
          { lease: admin },
        );
      tree.state = "creating";
      this.save(tree);
      const addArguments = [
        "worktree",
        "add",
        ...(tree.repositoryFeatures.sparseCheckout ? ["--no-checkout"] : []),
        "-b",
        tree.branchRef.slice("refs/heads/".length),
        tree.path,
        tree.baseSha,
      ];
      await this.git.run(tree.repository.path, addArguments, {
        timeoutMs: 120_000,
        lease: admin,
      });
      if (tree.repositoryFeatures.sparseCheckout) {
        await this.git.run(
          tree.path,
          [
            "sparse-checkout",
            "set",
            tree.repositoryFeatures.sparseCone ? "--cone" : "--no-cone",
            "--stdin",
          ],
          {
            timeoutMs: 120_000,
            stdin: `${tree.repositoryFeatures.sparsePaths.join("\n")}\n`,
          },
        );
        await this.git.run(tree.path, ["read-tree", "-mu", "HEAD"], {
          timeoutMs: 120_000,
        });
      }
      if (tree.repositoryFeatures.submodules)
        await this.git.run(
          tree.path,
          ["submodule", "update", "--init", "--recursive", "--checkout"],
          { timeoutMs: 600_000 },
        );
      this.options.checkpoint?.("git", request);
      await this.verifyTree(tree);
    }
    tree.observation = await this.observe(tree);
    this.requireClean(tree.observation);
    const pin = await this.ref(tree.repository.path, tree.pinRef);
    if (pin === tree.baseSha)
      await this.git.run(
        tree.repository.path,
        ["update-ref", "-d", tree.pinRef, tree.baseSha],
        { lease: admin },
      );
    tree.state = "ready";
    tree.error = "";
    return tree;
  }

  private async assertPinnedSource(tree: ManagedWorktree): Promise<void> {
    if (tree.sourcePlacementId !== tree.originatingPlacementId) {
      await this.git.run(tree.repository.path, [
        "rev-parse",
        "--verify",
        `${tree.baseSha}^{commit}`,
      ]);
      return;
    }
    const sourceHead = GitShaSchema.parse(
      (
        await this.git.run(tree.repository.path, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ])
      ).stdout.trim(),
    );
    if (sourceHead !== tree.baseSha)
      throw new WorktreeConflict(
        "source_advanced",
        "The source checkout advanced after this Run was pinned. Composition is blocked.",
      );
    if (tree.baseRef) {
      const sourceRef = (
        await this.git.run(tree.repository.path, ["symbolic-ref", "-q", "HEAD"], {
          allowedExitCodes: [0, 1],
        })
      ).stdout.trim();
      if (sourceRef !== tree.baseRef)
        throw new WorktreeConflict(
          "source_ref_changed",
          "The source checkout changed branches after this Run was pinned.",
        );
    }
  }

  private async compose(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<ManagedWorktree> {
    if (tree.workspaceKind !== "derived" || !tree.composition || !request.composition)
      throw new WorktreeConflict(
        "composition_required",
        "Only a derived workspace with durable composition provenance can be composed.",
      );
    const provenance = (composition: NonNullable<ManagedWorktree["composition"]>) => ({
      baseSha: composition.baseSha,
      baseRef: composition.baseRef,
      predecessors: composition.predecessors,
    });
    if (!isDeepStrictEqual(provenance(tree.composition), provenance(request.composition)))
      throw new WorktreeConflict(
        "composition_changed",
        "The predecessor set or pinned result SHAs changed after reservation.",
      );
    await this.verifyTree(tree);
    if (tree.composition.state === "ready") return tree;
    await this.assertPinnedSource(tree);
    if (tree.composition.state === "conflicted") return tree;
    await this.noGitOperation(tree.path, true);
    const gitDirectory = (
      await this.git.run(tree.path, ["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    if (await exists(join(gitDirectory, "MERGE_HEAD"))) {
      tree.composition.state = "conflicted";
      tree.composition.conflicts = await this.conflicts(tree.path);
      tree.composition.error =
        "An interrupted predecessor merge requires explicit resolution or abandonment; Fleet did not reset or clean the workspace.";
      tree.error = tree.composition.error;
      tree.observation = await this.observe(tree);
      return tree;
    }
    tree.observation = await this.observe(tree);
    this.requireClean(tree.observation);
    await this.importWorkspaceResults(tree, request, admin);
    if (tree.observation.head !== tree.baseSha) {
      const expected = new Set(
        tree.composition.predecessors.map((predecessor) => predecessor.resultSha),
      );
      const history = (
        await this.git.run(tree.path, [
          "rev-list",
          "--first-parent",
          "--parents",
          `${tree.baseSha}..${tree.observation.head}`,
        ])
      ).stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      if (
        history.some((line) => {
          const [, , ...otherParents] = line.split(" ");
          return (
            otherParents.length === 0 || !otherParents.some((sha) => expected.has(sha))
          );
        })
      )
        throw new WorktreeConflict(
          "composition_head_changed",
          "The derived workspace contains commits outside its recorded predecessor composition.",
        );
    }
    tree.composition.state = "composing";
    tree.composition.startedAt ||= now();
    tree.composition.error = "";
    this.save(tree);
    for (const predecessor of tree.composition.predecessors) {
      const sourceTree = this.get(predecessor.worktreeId);
      if (sourceTree && sourceTree.nodeId === tree.nodeId) {
        const primarySource =
          sourceTree.workspaceKind === "primary" && !sourceTree.ownerStepId;
        if (
          sourceTree.runId !== tree.runId ||
          (!primarySource &&
            (sourceTree.ownerStepId !== predecessor.stepId ||
              sourceTree.resultSha !== predecessor.resultSha))
        )
          throw new WorktreeConflict(
            "predecessor_changed",
            `Predecessor ${predecessor.stepKey} no longer matches its recorded workspace result.`,
          );
        await this.verifyTree(sourceTree);
        const observed = await this.observe(sourceTree);
        this.requireClean(observed);
        if (observed.head !== predecessor.resultSha)
          throw new WorktreeConflict(
            "predecessor_changed",
            `Predecessor ${predecessor.stepKey} changed after completion.`,
          );
      }
      if (await this.ancestor(tree.path, predecessor.resultSha, tree.observation.head))
        continue;
      const merge = await this.git.run(
        tree.path,
        ["merge", "--no-ff", "--no-edit", predecessor.resultSha],
        { allowedExitCodes: [0, 1], timeoutMs: 120_000, lease: admin },
      );
      this.options.checkpoint?.("git", request);
      if (merge.exitCode !== 0) {
        tree.composition.conflicts = await this.conflicts(tree.path);
        tree.composition.state = "conflicted";
        tree.composition.error = `Merging predecessor ${predecessor.stepKey} conflicted. Resolve or abandon explicitly; Fleet did not reset or clean the workspace.`;
        tree.error = tree.composition.error;
        tree.observation = await this.observe(tree);
        return tree;
      }
      tree.observation = await this.observe(tree);
      this.save(tree);
    }
    await this.noGitOperation(tree.path);
    tree.observation = await this.observe(tree);
    this.requireClean(tree.observation);
    tree.composition.state = "ready";
    tree.composition.resultSha = tree.observation.head;
    tree.composition.conflicts = [];
    tree.composition.error = "";
    tree.composition.completedAt = now();
    tree.error = "";
    return tree;
  }

  private async finalize(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
  ): Promise<{ worktree: ManagedWorktree; result?: WorkspaceResult }> {
    await this.verifyTree(tree);
    await this.verifyRepositoryExecutionPolicy(tree);
    await this.noGitOperation(tree.path);
    tree.observation = await this.observe(tree);
    const status = await this.status(tree.path);
    if (status.staged || status.unstaged || status.untracked) {
      const changed = new Set(
        (
          await this.git.run(tree.path, ["diff", "--name-only", "-z", "HEAD", "--"])
        ).stdout
          .split("\0")
          .filter(Boolean),
      );
      for (const path of (
        await this.git.run(tree.path, [
          "diff",
          "--cached",
          "--name-only",
          "-z",
          "HEAD",
          "--",
        ])
      ).stdout
        .split("\0")
        .filter(Boolean))
        changed.add(path);
      for (const path of (
        await this.git.run(tree.path, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
        ])
      ).stdout
        .split("\0")
        .filter(Boolean))
        changed.add(path);
      if (
        [...changed].some((path) =>
          /(^|[\\/])(?:\.env(?:\.|$)|credentials?|secrets?)(?:[\\/]|\.|$)/i.test(path),
        )
      )
        throw new WorktreeConflict(
          "sensitive_checkpoint_path",
          "Fleet refuses to checkpoint a path that appears to contain credentials or secrets.",
        );
      const hooks = join(this.options.directory, "empty-hooks");
      await mkdir(hooks, { recursive: true });
      await this.git.run(tree.path, ["add", "--all", "--"]);
      if (!(await this.noninteractivePolicy(tree.path, true, tree.allowGitHooks)))
        throw new WorktreeConflict(
          "checkpoint_identity_required",
          "Fleet cannot create a controlled checkpoint without noninteractive Git identity and signing policy.",
        );
      await this.git.run(tree.path, [
        "-c",
        `core.hooksPath=${hooks}`,
        "commit",
        "-m",
        `Fleet checkpoint for ${tree.runId}\n\nFleet-Checkpoint: ${request.operationId}`,
      ]);
      tree.fleetCheckpointSha = GitShaSchema.parse(await this.ref(tree.path, "HEAD"));
      tree.sealedFiles = [...changed].sort();
      tree.observation = await this.observe(tree);
    }
    this.requireTrackedClean(tree.observation);
    tree.resultSha = GitShaSchema.parse(tree.observation.head);
    tree.resultRecordedAt = now();
    tree.error = "";
    if (!tree.repositoryIdentity || !tree.repositoryObjectFormat)
      throw new WorktreeConflict(
        "repository_identity_missing",
        "The workspace predates portable repository identity and must be reconciled.",
      );
    if (tree.resultSha === tree.baseSha) return { worktree: tree };
    if (tree.repositoryFeatures.gitLfs || tree.repositoryFeatures.submodules)
      return { worktree: tree };
    if (!this.options.uploadArtifact) return { worktree: tree };
    const started = Date.now();
    const directory = join(this.options.directory, "workspace-result-artifacts");
    await mkdir(directory, { recursive: true });
    const privateRef = `refs/fleet/results/${tree.taskKey}`;
    const bundlePath = join(directory, `${request.operationId}.bundle`);
    await rm(bundlePath, { force: true });
    const existingResultRef = await this.ref(tree.repository.path, privateRef);
    if (existingResultRef && existingResultRef !== tree.resultSha)
      throw new WorktreeConflict(
        "result_ref_collision",
        "The Fleet result ref already names different content.",
      );
    if (!existingResultRef)
      await this.git.run(tree.repository.path, [
        "update-ref",
        privateRef,
        tree.resultSha,
        "0".repeat(tree.resultSha.length),
      ]);
    this.options.checkpoint?.("git", request);
    try {
      const args = ["bundle", "create", bundlePath, privateRef];
      if (tree.resultSha !== tree.baseSha) args.push(`^${tree.baseSha}`);
      await this.git.run(tree.repository.path, args, { timeoutMs: 120_000 });
      await this.git.run(tree.repository.path, ["bundle", "verify", bundlePath], {
        timeoutMs: 120_000,
      });
      const artifactSize = (await stat(bundlePath)).size;
      const artifactSha256 = await sha256File(bundlePath);
      const result = {
        id: request.operationId,
        runId: tree.runId,
        ownerStepId: tree.ownerStepId,
        repositoryIdentity: tree.repositoryIdentity,
        baseSha: tree.baseSha,
        baseRef: tree.baseRef,
        headSha: tree.resultSha,
        finalTreeOid: await this.treeOid(tree.path, tree.resultSha),
        includedFiles: tree.sealedFiles,
        checkpointCreated: Boolean(tree.fleetCheckpointSha),
        purpose:
          request.actor === "host-finalization-controller"
            ? ("recovery" as const)
            : ("task_result" as const),
        sourceWorktreeId: tree.id,
        sourceNodeId: tree.nodeId,
        sourcePlacementId: tree.sourcePlacementId,
        sourceGeneration: tree.generation,
        state: "sealing" as const,
        artifactId: artifactSha256,
        artifactRef: privateRef,
        artifactSha256,
        artifactSize,
        objectFormat: tree.repositoryObjectFormat,
        portability: "portable" as const,
        portabilityReason: "",
        createdAt: now(),
        verifiedAt: "",
        expiresAt: "",
        error: "",
        sealDurationMs: Date.now() - started,
        uploadDurationMs: 0,
        downloadDurationMs: 0,
        materializeDurationMs: 0,
      };
      try {
        const available = await this.options.uploadArtifact(result, bundlePath);
        return { worktree: tree, result: available };
      } catch {
        throw new WorktreeConflict(
          "artifact_transport_failed",
          "The result was sealed locally, but artifact transfer did not complete.",
        );
      }
    } finally {
      await this.git.run(tree.repository.path, [
        "update-ref",
        "-d",
        privateRef,
        tree.resultSha,
      ]);
      await rm(bundlePath, { force: true });
    }
  }

  private async materialize(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<ManagedWorktree> {
    if (request.workspaceResults.length !== 1)
      throw new WorktreeConflict(
        "workspace_result_required",
        "Final materialization requires exactly one sealed result.",
      );
    await this.verifyTree(tree);
    await this.noGitOperation(tree.path);
    tree.observation = await this.observe(tree);
    this.requireClean(tree.observation);
    const result = request.workspaceResults[0]!;
    await this.importResult(tree, result, request.operationId, admin);
    if (!(await this.ancestor(tree.path, result.headSha, tree.observation.head))) {
      const merge = await this.git.run(
        tree.path,
        ["merge", "--no-ff", "--no-edit", result.headSha],
        { allowedExitCodes: [0, 1], timeoutMs: 120_000, lease: admin },
      );
      if (merge.exitCode !== 0)
        throw new WorktreeConflict(
          "materialize_conflict",
          "The final sealed result conflicted with the pinned integration workspace.",
        );
    }
    tree.observation = await this.observe(tree);
    this.requireClean(tree.observation);
    tree.resultSha = GitShaSchema.parse(tree.observation.head);
    tree.resultRecordedAt = now();
    return tree;
  }

  async probeRepository(request: RepositoryProbeRequest): Promise<RepositoryProbeResult> {
    try {
      const repository = await this.repository(request.localPath);
      const baseAvailable =
        (
          await this.git.run(
            repository.path,
            ["cat-file", "-e", `${request.baseSha}^{commit}`],
            { allowedExitCodes: [0, 1, 128] },
          )
        ).exitCode === 0;
      const identityBase = baseAvailable
        ? request.baseSha
        : GitShaSchema.parse(await this.ref(repository.path, "HEAD"));
      const identity = await this.repositoryIdentity(repository.path, identityBase);
      let baseMaterializable = false;
      if (!baseAvailable && request.baseRef) {
        const { remote, branch } = this.remoteBranch(request.baseRef, request.remote);
        const remoteUrl = (
          await this.git.run(repository.path, ["remote", "get-url", remote])
        ).stdout.trim();
        const advertised = (
          await this.git.run(
            repository.path,
            ["ls-remote", "--heads", remoteUrl, `refs/heads/${branch}`],
            { allowedExitCodes: [0, 2, 128] },
          )
        ).stdout
          .trim()
          .split(/\s+/)[0];
        baseMaterializable = advertised === request.baseSha;
      }
      const compatibility = baseAvailable
        ? await this.supportedRepository(repository.path, request.baseSha, false)
        : undefined;
      const portableResultsSupported = Boolean(
        compatibility &&
        !compatibility.features.gitLfs &&
        !compatibility.features.submodules,
      );
      if (
        request.expectedRepositoryIdentity &&
        request.expectedRepositoryIdentity !== identity.id
      )
        throw new WorktreeConflict(
          "repository_identity_mismatch",
          "This placement is not the task's logical repository.",
        );
      return {
        operationId: request.operationId,
        runId: request.runId,
        placementId: request.placementId,
        nodeId: this.options.nodeId(),
        ok: true,
        capability: {
          placementId: request.placementId,
          nodeId: this.options.nodeId(),
          localPath: request.localPath,
          repositoryIdentity: identity,
          baseSha: request.baseSha,
          baseAvailable,
          baseMaterializable,
          portableResultsSupported,
          portabilityReason: portableResultsSupported
            ? ""
            : compatibility?.features.gitLfs
              ? "Git LFS result transport is not implemented; execution is Node-local."
              : compatibility?.features.submodules
                ? "Submodule result transport is not implemented; execution is Node-local."
                : "Pinned base commit is unavailable.",
          verifiedAt: now(),
          error: baseAvailable ? "" : "Pinned base commit is unavailable.",
        },
        code: baseAvailable || baseMaterializable ? "" : "base_unavailable",
        error:
          baseAvailable || baseMaterializable
            ? ""
            : "Pinned base commit is unavailable and cannot be materialized.",
      };
    } catch (error) {
      return {
        operationId: request.operationId,
        runId: request.runId,
        placementId: request.placementId,
        nodeId: this.options.nodeId(),
        ok: false,
        code: error instanceof WorktreeConflict ? error.code : "repository_probe_failed",
        error: error instanceof Error ? error.message : "Repository probe failed.",
      };
    }
  }

  private async repositoryIdentity(
    path: string,
    baseSha: string,
  ): Promise<RepositoryIdentity> {
    const objectFormat = (
      await this.git.run(path, ["rev-parse", "--show-object-format"])
    ).stdout.trim();
    const roots = (
      await this.git.run(path, ["rev-list", "--max-parents=0", baseSha])
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    const remoteLines = (
      await this.git.run(path, ["remote", "get-url", "--all", "origin"], {
        allowedExitCodes: [0, 2, 128],
      })
    ).stdout
      .trim()
      .split(/\r?\n/)
      .map(normalizeRemoteIdentity)
      .filter((value): value is string => Boolean(value))
      .sort();
    const rootHash = createHash("sha256").update(roots.join("\n")).digest("hex");
    const remoteHash = remoteLines.length
      ? createHash("sha256").update(remoteLines.join("\n")).digest("hex")
      : "";
    return RepositoryIdentitySchema.parse({
      id: createHash("sha256")
        .update(`${objectFormat}\0${remoteHash || rootHash}`)
        .digest("hex"),
      objectFormat,
      evidence: remoteHash ? "remote" : "roots",
      remoteHash,
      rootHash,
    });
  }

  private async importWorkspaceResults(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<void> {
    if (!tree.composition?.predecessors.length) return;
    const results = new Map(
      request.workspaceResults.map((result) => [result.id, result]),
    );
    const directory = join(this.options.directory, "workspace-result-artifacts");
    const hooks = join(directory, "empty-hooks");
    await mkdir(hooks, { recursive: true });
    for (const predecessor of tree.composition.predecessors) {
      if (await this.hasCommit(tree.repository.path, predecessor.resultSha)) continue;
      const local = this.get(predecessor.worktreeId);
      if (
        !predecessor.workspaceResultId &&
        local?.runId === tree.runId &&
        local.ownerStepId === predecessor.stepId &&
        local.resultSha === predecessor.resultSha
      )
        continue;
      const result = predecessor.workspaceResultId
        ? results.get(predecessor.workspaceResultId)
        : undefined;
      if (
        !result ||
        result.state !== "available" ||
        result.runId !== tree.runId ||
        result.ownerStepId !== predecessor.stepId ||
        result.repositoryIdentity !== tree.repositoryIdentity ||
        result.baseSha !== tree.baseSha ||
        result.headSha !== predecessor.resultSha ||
        result.objectFormat !== tree.repositoryObjectFormat
      )
        throw new WorktreeConflict(
          "workspace_result_mismatch",
          `Predecessor ${predecessor.stepKey} has no matching portable result.`,
        );
      await this.importResult(tree, result, request.operationId, admin, hooks);
    }
  }

  private async importResult(
    tree: ManagedWorktree,
    result: WorkspaceResult,
    operationId: string,
    admin: CheckoutLease,
    hooksPath?: string,
  ): Promise<void> {
    if (
      result.state !== "available" ||
      result.runId !== tree.runId ||
      result.repositoryIdentity !== tree.repositoryIdentity ||
      result.baseSha !== tree.baseSha ||
      result.objectFormat !== tree.repositoryObjectFormat
    )
      throw new WorktreeConflict(
        "workspace_result_mismatch",
        "The portable result does not belong to this logical repository and base.",
      );
    if (!this.options.downloadArtifact)
      throw new WorktreeConflict(
        "artifact_transport_unavailable",
        "This Node cannot materialize portable workspace results.",
      );
    const directory = join(this.options.directory, "workspace-result-artifacts");
    const hooks = hooksPath ?? (await this.disabledHooksPath());
    await mkdir(hooks, { recursive: true });
    const bundlePath = join(directory, `${result.artifactId}.bundle`);
    const importedRef = `refs/fleet/imports/${identityHash(
      `${result.id}:${result.headSha}`,
    ).slice(0, 32)}`;
    try {
      await this.options.downloadArtifact(result, bundlePath, operationId);
      if ((await stat(bundlePath)).size !== result.artifactSize)
        throw new WorktreeConflict("artifact_size", "Downloaded artifact size changed.");
      if ((await sha256File(bundlePath)) !== result.artifactSha256)
        throw new WorktreeConflict(
          "artifact_corrupt",
          "Downloaded artifact hash changed.",
        );
      await this.git.run(tree.repository.path, ["bundle", "verify", bundlePath], {
        timeoutMs: 120_000,
      });
      const existing = await this.ref(tree.repository.path, importedRef);
      if (existing && existing !== result.headSha)
        throw new WorktreeConflict(
          "import_ref_collision",
          "A Fleet-private import ref names different content.",
        );
      if (!existing)
        await this.git.run(
          tree.repository.path,
          [
            "-c",
            `core.hooksPath=${hooks}`,
            "fetch",
            "--no-write-fetch-head",
            bundlePath,
            `${result.artifactRef ?? result.headSha}:${importedRef}`,
          ],
          { timeoutMs: 120_000, lease: admin },
        );
      if ((await this.ref(tree.repository.path, importedRef)) !== result.headSha)
        throw new WorktreeConflict("artifact_import", "Imported result HEAD changed.");
      if (
        result.finalTreeOid &&
        (await this.treeOid(tree.repository.path, result.headSha)) !== result.finalTreeOid
      )
        throw new WorktreeConflict(
          "artifact_tree_mismatch",
          "Imported result tree identity changed.",
        );
      if (!tree.importedWorkspaceResults.some((entry) => entry.id === result.id))
        tree.importedWorkspaceResults.push({
          id: result.id,
          headSha: result.headSha,
          artifactId: result.artifactId,
        });
    } finally {
      await rm(bundlePath, { force: true });
    }
  }
  private async ref(path: string, ref: string): Promise<string> {
    return (
      await this.git.run(path, ["rev-parse", "--verify", ref], {
        allowedExitCodes: [0, 128],
      })
    ).stdout.trim();
  }

  private async hasCommit(path: string, sha: string): Promise<boolean> {
    return (
      (
        await this.git.run(path, ["cat-file", "-e", `${sha}^{commit}`], {
          allowedExitCodes: [0, 1, 128],
        })
      ).exitCode === 0
    );
  }

  private async status(
    path: string,
  ): Promise<
    Pick<
      WorktreeObservation,
      "staged" | "unstaged" | "untracked" | "ignored" | "dirty"
    > & { ignoredPaths: string[] }
  > {
    const text = (
      await this.git.run(path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ])
    ).stdout;
    let staged = false,
      unstaged = false,
      untracked = false,
      ignored = false;
    const ignoredPaths: string[] = [];
    const fields = text.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (!field) continue;
      const xy = field.slice(0, 2);
      if (xy === "??") untracked = true;
      else if (xy === "!!") {
        ignored = true;
        ignoredPaths.push(field.slice(3));
      } else {
        staged ||= xy[0] !== " ";
        unstaged ||= xy[1] !== " ";
        if (/[RC]/.test(xy)) index += 1;
      }
    }
    return {
      staged,
      unstaged,
      untracked,
      ignored,
      dirty: staged || unstaged || untracked || ignored,
      ignoredPaths,
    };
  }

  private async integrationTargetDirty(
    tree: ManagedWorktree,
    targetPath: string,
    taskSha: string,
  ): Promise<boolean> {
    const status = await this.status(targetPath);
    if (status.staged || status.unstaged || status.untracked) return true;
    if (!status.ignored) return false;
    const changedPaths = (
      await this.git.run(tree.path, [
        "diff",
        "--name-only",
        "-z",
        tree.baseSha,
        taskSha,
        "--",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const comparable = (path: string) =>
      (process.platform === "win32" ? path.toLowerCase() : path).replace(/\/+$/, "");
    return status.ignoredPaths.some((ignoredPath) => {
      const ignored = comparable(ignoredPath);
      return changedPaths.some((changedPath) => {
        const changed = comparable(changedPath);
        return (
          changed === ignored ||
          changed.startsWith(`${ignored}/`) ||
          ignored.startsWith(`${changed}/`)
        );
      });
    });
  }

  private async observe(tree: ManagedWorktree): Promise<WorktreeObservation> {
    const status = await this.status(tree.path);
    const head = GitShaSchema.parse(await this.ref(tree.path, "HEAD"));
    const counts = (
      await this.git.run(tree.path, [
        "rev-list",
        "--left-right",
        "--count",
        `${tree.baseSha}...${head}`,
      ])
    ).stdout
      .trim()
      .split(/\s+/);
    const free = await statfs(tree.path);
    return WorktreeObservationSchema.parse({
      ...status,
      generation: tree.generation,
      observedAt: now(),
      head,
      ref: tree.branchRef,
      ahead: Number(counts[1]),
      behind: Number(counts[0]),
      registered: true,
      pathExists: true,
      locked: Boolean(this.locks.holder(tree.checkout!.key)),
      lockHolder: this.locks.holder(tree.checkout!.key)?.owner ?? "",
      prunable: false,
      approximateBytes: await approximateBytes(tree.path),
      freeBytes: free.bavail * free.bsize,
    });
  }

  private requireClean(observation: Pick<WorktreeObservation, "dirty">): void {
    if (observation.dirty !== false)
      throw new WorktreeConflict(
        "dirty_or_unknown",
        "Staged, unstaged, untracked, ignored or unknown data prevents this operation. No files were deleted.",
      );
  }

  private requireTrackedClean(
    status: Pick<WorktreeObservation, "staged" | "unstaged" | "untracked">,
  ): void {
    if (status.staged || status.unstaged || status.untracked)
      throw new WorktreeConflict(
        "dirty_or_unknown",
        "Staged, unstaged, untracked or unknown target data prevents this operation. No files were deleted.",
      );
  }

  private async noGitOperation(path: string, allowMerge = false): Promise<void> {
    const directory = (
      await this.git.run(path, ["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    const names = [
      "index.lock",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "BISECT_LOG",
      ...(allowMerge ? [] : ["MERGE_HEAD"]),
    ];
    for (const name of names)
      if (await exists(join(directory, name)))
        throw new WorktreeConflict(
          "git_operation_active",
          "Another Git operation is active in this checkout.",
        );
  }

  async checkoutIdentity(path: string): Promise<CheckoutIdentity> {
    const directory = await canonicalPath(path);
    const root = await this.git.run(directory.path, ["rev-parse", "--show-toplevel"], {
      allowedExitCodes: [0, 128],
    });
    const checkout =
      root.exitCode === 0 ? await canonicalPath(root.stdout.trim()) : directory;
    const common =
      root.exitCode === 0 ? await this.commonDirectory(checkout.path) : undefined;
    this.locks.bindScope(checkout, common);
    return checkout;
  }

  async coordinatorPath(sessionId: string): Promise<string> {
    const path = join(this.options.directory, "coordinators", identityHash(sessionId));
    await mkdir(path, { recursive: true });
    return (await canonicalPath(path)).path;
  }

  async validateExecution(binding: ExecutionBinding): Promise<void> {
    if (this.paused || this.closed)
      throw new WorktreeConflict(
        "node_draining",
        "Managed execution is paused for Node teardown.",
      );
    if (binding.quarantined)
      throw new WorktreeConflict(
        "quarantined",
        "Restored sessions cannot run before explicit reconciliation.",
      );
    if (!binding.worktreeId) {
      if ((await this.checkoutIdentity(binding.cwd)).key !== binding.checkoutKey)
        throw new WorktreeConflict("binding_mismatch", "Physical checkout changed.");
      return;
    }

    const tree = this.get(binding.worktreeId);
    if (
      !tree ||
      tree.nodeInstallationId !== this.installationId ||
      tree.nodeId !== this.options.nodeId() ||
      tree.generation !== binding.generation ||
      tree.path !== binding.cwd ||
      tree.checkout?.key !== binding.checkoutKey ||
      tree.sourcePlacementId !== binding.sourcePlacementId ||
      tree.abandonedAt ||
      !["ready", "retained"].includes(tree.state) ||
      unresolved.has(tree.integrationState)
    ) {
      throw new WorktreeConflict(
        "binding_unavailable",
        "The immutable task worktree is unavailable, reserved for integration, or belongs to another generation. No source fallback is permitted.",
      );
    }
    await this.verifyTree(tree);
  }

  assertManagedPathBound(checkout: CheckoutIdentity, binding?: ExecutionBinding): void {
    const tree = this.db
      .prepare("SELECT data FROM trees")
      .all()
      .map((row) => ManagedWorktreeSchema.parse(JSON.parse(String(row.data))))
      .find((entry) => entry.checkout?.key === checkout.key && !entry.abandonedAt);
    if (
      (tree && binding?.worktreeId !== tree.id) ||
      (!tree && existsSync(join(dirname(checkout.path), ".fleet-owner.json")))
    ) {
      throw new WorktreeConflict(
        "managed_binding_required",
        "This physical checkout is Fleet-owned. Use its task binding, not a manual source-placement session.",
      );
    }
  }

  private async reconcile(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<{ worktree: ManagedWorktree; integration?: WorktreeIntegration }> {
    this.recoverTaskMaintenance(tree);
    const entries = await this.registry(tree);
    if (
      entries.some(
        (entry) => entry.branch === tree.branchRef && !samePath(entry.path, tree.path),
      )
    ) {
      throw new WorktreeConflict(
        "registry_moved",
        "The owned task branch is registered at an unexpected path; no deletion or adoption is safe.",
      );
    }
    const registered = entries.some((entry) => samePath(entry.path, tree.path));
    const present = await exists(tree.path);
    if (!registered && !present) {
      if (tree.state === "removed" || tree.state === "removing") {
        tree.state = "removed";
        tree.removedAt ||= now();
      } else if (
        ["reserved", "creating", "creation_failed"].includes(tree.state) &&
        !(await this.ref(tree.repository.path, tree.branchRef))
      ) {
        tree.state = "reserved";
      } else {
        tree.state = "missing";
        tree.error =
          "Worktree is missing. Its retained branch and filesystem must be reconciled manually; it is not recreated.";
      }
      return { worktree: tree };
    }
    await this.verifyTree(tree);
    const pending = this.integrations(tree.id).find((entry) => {
      this.locks.bindScope(entry.preview.target, tree.commonDirectory);
      return (
        unresolved.has(entry.state) ||
        this.locks.holder(entry.preview.target.key)?.owner === `integration:${entry.id}`
      );
    });
    if (pending) {
      await assertIdentity(pending.preview.target);
      this.locks.bindScope(pending.preview.target, tree.commonDirectory);
      this.locks.recoverIntegration(pending.preview.target, pending.id);
      const lease = this.locks.acquire(pending.preview.target, {
        kind: "integration",
        owner: `integration:${pending.id}`,
        attempt: pending.id,
      });
      this.integrationLeases.set(pending.id, lease);
      const mergeHead = await this.ref(pending.preview.target.path, "MERGE_HEAD");
      const head = await this.ref(pending.preview.target.path, "HEAD");
      const targetRef = (
        await this.git.run(pending.preview.target.path, ["symbolic-ref", "-q", "HEAD"], {
          allowedExitCodes: [0, 1],
        })
      ).stdout.trim();
      const sameTarget =
        targetRef === pending.preview.targetRef &&
        (await this.commonDirectory(pending.preview.target.path)).key ===
          tree.commonDirectory.key;
      if (
        sameTarget &&
        mergeHead === pending.approvedTaskSha &&
        head === pending.preview.targetSha
      ) {
        await this.noGitOperation(pending.preview.target.path, true);
        pending.conflicts = await this.conflicts(pending.preview.target.path);
        pending.state = pending.conflicts.length ? "conflicted" : "ready";
      } else if (
        sameTarget &&
        !mergeHead &&
        head === pending.preview.targetSha &&
        ["integrating", "aborting", "aborted"].includes(pending.state)
      ) {
        await this.noGitOperation(pending.preview.target.path);
        this.requireTrackedClean(await this.status(pending.preview.target.path));
        pending.state = "aborted";
        pending.conflicts = [];
        pending.error = "";
      } else if (
        sameTarget &&
        !mergeHead &&
        (await this.matchesMergeCommit(pending, head))
      ) {
        await this.noGitOperation(pending.preview.target.path);
        this.requireTrackedClean(await this.status(pending.preview.target.path));
        pending.state = "integrated";
        pending.resultSha = head;
        pending.conflicts = [];
        pending.validationState = "passed";
        pending.validationSummary =
          "Recovered merge result exactly matches the reviewed commit graph and tree.";
        pending.validationStartedAt ||= pending.createdAt;
        pending.validatedAt = now();
        pending.error = "";
      } else {
        pending.state = "needs_reconciliation";
        pending.error =
          "The target no longer matches this merge intent. No reset, clean or automatic abort is permitted.";
      }
      pending.updatedAt = now();
      this.saveIntegration(pending);
      tree.integrationState = pending.state;
      tree.state =
        pending.state === "needs_reconciliation" ? "needs_reconciliation" : "retained";
      tree.observation = await this.observe(tree);
      if (pending.state === "integrated" || pending.state === "aborted") {
        lease.release();
        this.integrationLeases.delete(pending.id);
      }
      return { worktree: tree, integration: pending };
    }
    // A worker lock from a lost Node incarnation is deliberately not reclaimed.
    const holder = this.locks.holder(tree.checkout!.key);
    if (
      holder &&
      (!this.locks.locallyOwned(tree.checkout!.key) || holder.reconciliationRequired)
    )
      throw new WorktreeConflict(
        "process_unknown",
        "A previous Node incarnation owns this checkout and process quiescence is unknown.",
      );
    await this.noGitOperation(tree.path);
    tree.observation = await this.observe(tree);
    if (!tree.repositoryIdentity || !tree.repositoryObjectFormat) {
      const identity = await this.repositoryIdentity(tree.repository.path, tree.baseSha);
      tree.repositoryIdentity = identity.id;
      tree.repositoryObjectFormat = identity.objectFormat;
    }
    tree.state = "retained";
    tree.error = "";
    void request;
    void admin;
    return { worktree: tree };
  }

  private async cleanup(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<ManagedWorktree> {
    if (this.integrations(tree.id).some((entry) => unresolved.has(entry.state)))
      throw new WorktreeConflict(
        "integration_unresolved",
        "Finish or abort the integration before cleanup or abandonment.",
      );
    if (
      this.integrations(tree.id).some(
        (entry) =>
          ["integrated", "no_changes"].includes(entry.state) &&
          entry.preview.targetRemote &&
          entry.publishState !== "published",
      )
    )
      throw new WorktreeConflict(
        "publication_incomplete",
        "The validated integration must be published before its recovery workspace is cleaned.",
      );
    const lease = this.locks.acquire(tree.checkout!, {
      owner: `cleanup:${request.operationId}`,
      attempt: request.operationId,
      kind: "maintenance",
    });
    try {
      await lease.revalidate();
      await this.verifyTree(tree);
      await this.noGitOperation(tree.path);
      for (const integration of this.integrations(tree.id))
        await this.cleanupIntegrationWorkspace(tree, integration, admin);
      tree.observation = await this.observe(tree);
      if (request.kind === "abandon") {
        this.confirmAbandon(tree, request);
        return tree;
      }
      this.requireClean(tree.observation);
      tree.state = "removing";
      this.save(tree);
      await this.git.run(tree.repository.path, ["worktree", "remove", tree.path], {
        timeoutMs: 120_000,
        lease: admin,
      });
      this.options.checkpoint?.("git", request);
      if (
        (await exists(tree.path)) ||
        (await this.registry(tree)).some((entry) => samePath(entry.path, tree.path))
      )
        throw new WorktreeConflict(
          "removal_uncertain",
          "Removal did not reconcile with Git and the filesystem.",
        );
      tree.state = "removed";
      tree.removedAt = now();
      tree.error = "";
      for (const result of tree.importedWorkspaceResults) {
        const importedRef = `refs/fleet/imports/${identityHash(
          `${result.id}:${result.headSha}`,
        ).slice(0, 32)}`;
        if ((await this.ref(tree.repository.path, importedRef)) === result.headSha)
          await this.git.run(
            tree.repository.path,
            ["update-ref", "-d", importedRef, result.headSha],
            { lease: admin },
          );
      }
      if (request.deleteBranch) {
        const integration = this.integrations(tree.id).find(
          (entry) => entry.state === "integrated" || entry.state === "no_changes",
        );
        if (
          !integration ||
          !(await this.ancestor(
            tree.repository.path,
            tree.branchRef,
            integration.resultSha,
          ))
        )
          throw new WorktreeConflict(
            "branch_not_integrated",
            "The task branch has not been proven reachable from an integration result; it was retained.",
          );
        await this.git.run(
          tree.repository.path,
          ["branch", "-d", tree.branchRef.slice("refs/heads/".length)],
          { lease: admin },
        );
      }
      return tree;
    } finally {
      lease.release();
    }
  }

  private confirmAbandon(tree: ManagedWorktree, request: WorktreeOperationRequest): void {
    if (request.confirm !== `ABANDON ${tree.branchRef} AT ${tree.path}; KEEP FILES`) {
      throw new WorktreeConflict(
        "confirmation_required",
        "Type the exact branch/path abandonment confirmation. Files, branch and any base pin are kept, unmanaged.",
      );
    }
    tree.abandonedAt = now();
    tree.state = "retained";
    tree.expiresAt = "";
  }

  private async ancestor(path: string, from: string, to: string): Promise<boolean> {
    return (
      (
        await this.git.run(path, ["merge-base", "--is-ancestor", from, to], {
          allowedExitCodes: [0, 1],
        })
      ).exitCode === 0
    );
  }

  private integrationRemoteBranch(request: WorktreeOperationRequest): {
    remote: string;
    branch: string;
  } {
    const remote = request.integrationRemote || "origin";
    const prefix = `refs/remotes/${remote}/`;
    if (!request.integrationBaseRef.startsWith(prefix))
      throw new WorktreeConflict(
        "integration_base_invalid",
        `Integration base must be a remote-tracking branch under ${prefix}.`,
      );
    const branch = request.integrationBaseRef.slice(prefix.length);
    if (!branch || branch.startsWith("-"))
      throw new WorktreeConflict(
        "integration_base_invalid",
        "Integration base branch is invalid.",
      );
    return { remote, branch };
  }

  private privateFetchRef(request: WorktreeOperationRequest, purpose: string): string {
    return `refs/fleet/fetch/${identityHash(
      `${request.runId}:${request.operationId}:${purpose}`,
    ).slice(0, 32)}`;
  }

  private async fetchIntegrationBase(
    path: string,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
    purpose: string,
  ): Promise<{ ref: string; sha: string }> {
    const { remote, branch } = this.integrationRemoteBranch(request);
    const remoteUrl = (
      await this.git.run(path, ["remote", "get-url", remote])
    ).stdout.trim();
    if (!remoteUrl)
      throw new WorktreeConflict(
        "integration_remote_invalid",
        `The configured integration remote ${remote} has no fetch URL.`,
      );
    const ref = this.privateFetchRef(request, purpose);
    const existing = await this.ref(path, ref);
    if (existing)
      throw new WorktreeConflict(
        "fetch_ref_collision",
        "A Fleet-private fetch ref already exists with no matching durable receipt.",
      );
    const fetched = await this.git.run(
      path,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remoteUrl,
        `refs/heads/${branch}:${ref}`,
      ],
      { allowedExitCodes: [0, 1, 128], lease: admin },
    );
    if (fetched.exitCode !== 0)
      throw new WorktreeConflict(
        "integration_base_fetch_failed",
        `Could not fetch ${remote}/${branch} into Fleet's private namespace; authenticate Git for this Node and retry.`,
      );
    const sha = GitShaSchema.parse(await this.ref(path, `${ref}^{commit}`));
    return { ref, sha };
  }

  private async prepareIntegrationWorkspace(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<{ target: CheckoutIdentity; baseSha: string }> {
    if (!request.integrationTargetRef?.startsWith("refs/heads/dev/"))
      throw new WorktreeConflict(
        "integration_branch_invalid",
        "Automatic task branches must be under refs/heads/dev/.",
      );
    const branch = request.integrationTargetRef.replace(/^refs\/heads\//, "");
    const valid = await this.git.run(
      tree.repository.path,
      ["check-ref-format", "--branch", branch],
      {
        allowedExitCodes: [0, 1],
      },
    );
    if (valid.exitCode !== 0)
      throw new WorktreeConflict(
        "integration_branch_invalid",
        "The generated integration branch name is not valid for Git.",
      );
    if (request.targetPath) {
      const target = await canonicalPath(request.targetPath);
      if (
        dirname(target.path) !== tree.managedRoot.path ||
        !containedPath(tree.managedRoot.path, target.path)
      )
        throw new WorktreeConflict(
          "target_not_fleet_owned",
          "Managed integration may use only a Fleet-owned integration workspace.",
        );
      await assertIdentity(target);
      if ((await this.commonDirectory(target.path)).key !== tree.commonDirectory.key)
        throw new WorktreeConflict(
          "target_repository",
          "The integration workspace no longer belongs to the task repository.",
        );
      return {
        target,
        baseSha: GitShaSchema.parse(await this.ref(target.path, "HEAD")),
      };
    }
    const fetched = request.integrationBaseRef
      ? await this.fetchIntegrationBase(
          tree.repository.path,
          request,
          admin,
          "integration",
        )
      : undefined;
    const baseSha = fetched?.sha ?? tree.baseSha;
    const path = join(
      tree.managedRoot.path,
      `integration-${identityHash(request.operationId).slice(0, 24)}`,
    );
    try {
      if (
        (await exists(path)) ||
        (await this.registry(tree)).some((entry) => samePath(entry.path, path))
      )
        throw new WorktreeConflict(
          "integration_workspace_collision",
          "The Fleet integration path already exists without this attempt's receipt.",
        );
      await this.git.run(
        tree.repository.path,
        [
          "-c",
          `core.hooksPath=${await this.disabledHooksPath()}`,
          "worktree",
          "add",
          "--detach",
          path,
          baseSha,
        ],
        {
          timeoutMs: 120_000,
          lease: admin,
        },
      );
      const target = await canonicalPath(path);
      this.locks.bindScope(target, tree.commonDirectory);
      this.requireClean(await this.observePath(target.path, tree.generation));
      return { target, baseSha };
    } finally {
      if (fetched && (await this.ref(tree.repository.path, fetched.ref)) === fetched.sha)
        await this.git.run(
          tree.repository.path,
          ["update-ref", "-d", fetched.ref, fetched.sha],
          { lease: admin },
        );
    }
  }

  private async cleanupIntegrationWorkspace(
    tree: ManagedWorktree,
    integration: WorktreeIntegration,
    admin: CheckoutLease,
  ): Promise<void> {
    if (!["integrated", "no_changes", "aborted"].includes(integration.state)) return;
    const target = integration.preview.target;
    if (
      dirname(target.path) !== tree.managedRoot.path ||
      !containedPath(tree.managedRoot.path, target.path)
    )
      return;
    if (!(await exists(target.path))) return;
    await assertIdentity(target);
    await this.noGitOperation(target.path);
    this.requireClean(await this.observePath(target.path, tree.generation));
    await this.git.run(tree.repository.path, ["worktree", "remove", target.path], {
      timeoutMs: 120_000,
      lease: admin,
    });
  }

  private async treeOid(path: string, sha: string): Promise<string> {
    return GitShaSchema.parse(await this.ref(path, `${sha}^{tree}`));
  }

  private async presentationDiff(
    path: string,
    from: string,
    to: string,
  ): Promise<string> {
    try {
      return (
        await this.git.run(
          path,
          ["diff", "--binary", "--no-ext-diff", "--no-textconv", from, to, "--"],
          { maxBytes: 1_000_000 },
        )
      ).stdout;
    } catch (error) {
      if (error instanceof WorktreeConflict && error.code === "git_incomplete")
        return "Diff omitted because it exceeds the 1,000,000-byte UI preview limit.";
      throw error;
    }
  }

  private async observePath(
    path: string,
    generation: number,
  ): Promise<WorktreeObservation> {
    const status = await this.status(path);
    const head = GitShaSchema.parse(await this.ref(path, "HEAD"));
    const free = await statfs(path);
    return WorktreeObservationSchema.parse({
      ...status,
      generation,
      observedAt: now(),
      head,
      ref: (
        await this.git.run(path, ["symbolic-ref", "-q", "HEAD"], {
          allowedExitCodes: [0, 1],
        })
      ).stdout.trim(),
      registered: true,
      pathExists: true,
      locked: false,
      prunable: false,
      approximateBytes: await approximateBytes(path),
      freeBytes: free.bavail * free.bsize,
    });
  }

  private async validateIntegrationTarget(
    tree: ManagedWorktree,
    target: CheckoutIdentity,
  ): Promise<void> {
    if (
      dirname(target.path) !== tree.managedRoot.path ||
      !containedPath(tree.managedRoot.path, target.path)
    )
      throw new WorktreeConflict(
        "target_not_fleet_owned",
        "The integration workspace escaped Fleet ownership.",
      );
    await assertIdentity(target);
    if ((await this.commonDirectory(target.path)).key !== tree.commonDirectory.key)
      throw new WorktreeConflict(
        "target_repository",
        "The integration workspace repository identity changed.",
      );
    const symbolic = await this.git.run(target.path, ["symbolic-ref", "-q", "HEAD"], {
      allowedExitCodes: [0, 1],
    });
    if (symbolic.exitCode === 0)
      throw new WorktreeConflict(
        "integration_workspace_branch",
        "The Fleet integration workspace must remain detached.",
      );
  }

  private async publishIntegration(
    integration: WorktreeIntegration,
    approval: WorktreeOperationRequest["publicationApproval"],
    admin: CheckoutLease,
  ): Promise<void> {
    const publicationRequired =
      integration.resultSha !== integration.preview.targetSha ||
      integration.publicationFileCount > 0 ||
      integration.publicationCommitCount > 0;
    if (!publicationRequired || !integration.preview.targetRemote) {
      integration.publishState = "published";
      integration.publishedAt = now();
      integration.error = "";
      integration.updatedAt = now();
      this.saveIntegration(integration);
      return;
    }
    if (!approval)
      throw new WorktreeConflict(
        "publication_approval_mismatch",
        "Publication approval is required before creating a remote branch.",
      );
    integration.publishState = "publishing";
    integration.updatedAt = now();
    this.saveIntegration(integration);
    try {
      const remoteRef =
        (
          await this.git.run(
            integration.preview.target.path,
            [
              "ls-remote",
              "--refs",
              integration.preview.targetRemote,
              integration.preview.targetRef,
            ],
            { lease: admin },
          )
        ).stdout
          .trim()
          .split(/\s+/)[0] ?? "";
      if (remoteRef !== approval.expectedRemoteSha)
        throw new WorktreeConflict(
          "publication_target_changed",
          "Target changed since you reviewed it. Fleet has not published anything.",
        );
      await this.git.run(
        integration.preview.target.path,
        [
          "push",
          `--force-with-lease=${integration.preview.targetRef}:${approval.expectedRemoteSha}`,
          integration.preview.targetRemote,
          `HEAD:${integration.preview.targetRef}`,
        ],
        { lease: admin },
      );
      integration.publishState = "published";
      integration.publishedAt = now();
      integration.error = "";
      integration.updatedAt = now();
      this.saveIntegration(integration);
    } catch (error) {
      integration.publishState = "failed";
      integration.error = error instanceof Error ? error.message : "Publication failed.";
      integration.updatedAt = now();
      this.saveIntegration(integration);
      if (error instanceof WorktreeConflict) throw error;
      throw new WorktreeConflict(
        "publication_failed",
        "The integration is validated, but Fleet could not create the remote branch.",
      );
    }
  }

  private async conflicts(path: string): Promise<string[]> {
    return (
      await this.git.run(path, ["diff", "--name-only", "--diff-filter=U", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean);
  }

  private async preview(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<IntegrationPreview> {
    await this.verifyRepositoryExecutionPolicy(tree);
    const prepared = await this.prepareIntegrationWorkspace(tree, request, admin);
    const target = prepared.target;
    this.locks.bindScope(target, tree.commonDirectory);
    await this.noGitOperation(tree.path);
    await this.noGitOperation(target.path);
    await this.validateIntegrationTarget(tree, target);
    await this.verifyRepositoryExecutionPolicy(tree, target.path, {
      adoptCredentialHelpers: true,
      ignoreHooks: true,
    });
    await this.noninteractivePolicy(target.path, false, tree.allowGitHooks);
    const taskSha = GitShaSchema.parse(await this.ref(tree.path, "HEAD"));
    const targetSha = GitShaSchema.parse(await this.ref(target.path, "HEAD"));
    const baseTree = await this.treeOid(tree.path, tree.baseSha);
    const taskTree = await this.treeOid(tree.path, taskSha);
    const targetTree = await this.treeOid(target.path, targetSha);
    const diff = await this.presentationDiff(tree.path, tree.baseSha, taskSha);
    const hasCommittedChanges = taskTree !== baseTree;
    const baseContainedByTarget = await this.ancestor(
      target.path,
      tree.baseSha,
      targetSha,
    );
    const taskStatus = await this.status(tree.path);
    return IntegrationPreviewSchema.parse({
      id: request.operationId,
      worktreeId: tree.id,
      integrationWorkspaceId: `integration-${request.operationId}`,
      generation: tree.generation,
      taskSha,
      baseTree,
      taskTree,
      targetTree,
      diffIdentity: identityHash(`${tree.baseSha}\0${baseTree}\0${taskSha}\0${taskTree}`),
      diff,
      targetPlacementId: request.targetPlacementId || tree.sourcePlacementId,
      target,
      targetSha,
      targetRef: request.integrationTargetRef,
      targetBaseRef: request.integrationBaseRef,
      targetRemote: request.integrationRemote,
      taskDirty: taskStatus.staged || taskStatus.unstaged || taskStatus.untracked,
      targetDirty: (await this.status(target.path)).dirty,
      hasCommittedChanges,
      baseContainedByTarget,
      targetAdvancedFromBase: baseContainedByTarget && targetSha !== tree.baseSha,
      alreadyIntegrated:
        hasCommittedChanges && (await this.ancestor(target.path, taskSha, targetSha)),
      observedAt: now(),
    });
  }

  private async integrate(
    tree: ManagedWorktree,
    request: WorktreeOperationRequest,
    admin: CheckoutLease,
  ): Promise<{
    worktree: ManagedWorktree;
    preview?: IntegrationPreview;
    integration?: WorktreeIntegration;
  }> {
    if (request.kind === "integration_preview") {
      const preview = await this.preview(tree, request, admin);
      this.db
        .prepare("INSERT INTO previews (id,data) VALUES (?,?)")
        .run(preview.id, JSON.stringify(preview));
      return { worktree: tree, preview };
    }
    if (request.kind === "publish") {
      const integration = this.integration(request.integrationId ?? "");
      if (
        !integration ||
        integration.worktreeId !== tree.id ||
        integration.generation !== tree.generation
      )
        throw new WorktreeConflict(
          "wrong_integration",
          "The publication operation does not match this integration attempt.",
        );
      if (
        !["integrated", "no_changes"].includes(integration.state) ||
        integration.validationState !== "passed"
      )
        throw new WorktreeConflict(
          "publication_not_ready",
          "Only an exactly validated integration result may be published.",
        );
      const approval = request.publicationApproval;
      const publicationRequired =
        integration.resultSha !== integration.preview.targetSha ||
        integration.publicationFileCount > 0 ||
        integration.publicationCommitCount > 0;
      if (
        publicationRequired &&
        (!approval ||
          approval.runId !== tree.runId ||
          approval.integrationId !== integration.id ||
          approval.targetRemote !== integration.preview.targetRemote ||
          approval.targetRef !== integration.preview.targetRef ||
          approval.finalResultSha !== integration.resultSha ||
          approval.finalTreeSha !== integration.finalTree)
      )
        throw new WorktreeConflict(
          "publication_approval_mismatch",
          "Publication approval does not match this exact validated result and target.",
        );
      await this.validateIntegrationTarget(tree, integration.preview.target);
      await this.verifyRepositoryExecutionPolicy(tree, integration.preview.target.path, {
        strictCredentialHelpers: true,
        ignoreHooks: true,
      });
      if (
        (await this.ref(integration.preview.target.path, "HEAD")) !==
        integration.resultSha
      )
        throw new WorktreeConflict(
          "publication_result_changed",
          "The validated integration workspace HEAD changed before publication.",
        );
      if (
        integration.finalTree &&
        (await this.treeOid(integration.preview.target.path, integration.resultSha)) !==
          integration.finalTree
      )
        throw new WorktreeConflict(
          "publication_tree_changed",
          "The validated integration tree changed before publication.",
        );
      await this.publishIntegration(integration, approval, admin);
      return { worktree: tree, integration };
    }
    if (request.kind === "integrate") {
      if (this.integrations(tree.id).some((entry) => unresolved.has(entry.state)))
        throw new WorktreeConflict(
          "integration_unresolved",
          "Another integration for this task is unresolved.",
        );
      const row = this.db
        .prepare("SELECT data FROM previews WHERE id=?")
        .get(request.previewId ?? "");
      if (!row)
        throw new WorktreeConflict(
          "preview_required",
          "An explicit integration preview is required.",
        );
      const preview = IntegrationPreviewSchema.parse(JSON.parse(String(row.data)));
      this.locks.bindScope(preview.target, tree.commonDirectory);
      await this.validateIntegrationTarget(tree, preview.target);
      if (
        preview.worktreeId !== tree.id ||
        preview.generation !== tree.generation ||
        request.reviewedTaskSha !== preview.taskSha ||
        request.reviewedDiffIdentity !== preview.diffIdentity ||
        request.confirm !==
          (preview.hasCommittedChanges
            ? `MERGE ${preview.taskSha} INTO ${preview.targetRef}`
            : `REVIEW NO CHANGES FOR ${preview.taskSha}`)
      )
        throw new WorktreeConflict(
          "review_required",
          "Confirm the exact reviewed task SHA, diff and target branch.",
        );
      const leases: CheckoutLease[] = [];
      let retainTarget = false;
      let operationError: unknown;
      let operationResult:
        { worktree: ManagedWorktree; integration: WorktreeIntegration } | undefined;
      try {
        operationResult = await (async () => {
          for (const identity of [tree.checkout!, preview.target].sort((a, b) =>
            a.key.localeCompare(b.key),
          )) {
            const lease = this.locks.acquire(
              identity,
              identity.key === preview.target.key
                ? {
                    owner: `integration:${request.operationId}`,
                    attempt: request.operationId,
                    kind: "integration",
                  }
                : {
                    owner: `integration-task:${request.operationId}`,
                    attempt: request.operationId,
                    kind: "maintenance",
                  },
            );
            leases.push(lease);
            await lease.revalidate();
          }
          const fresh = await this.preview(
            tree,
            {
              ...request,
              targetPath: preview.target.path,
              targetPlacementId: preview.targetPlacementId,
            },
            admin,
          );
          if (
            fresh.taskSha !== preview.taskSha ||
            fresh.baseTree !== preview.baseTree ||
            fresh.taskTree !== preview.taskTree ||
            fresh.targetTree !== preview.targetTree ||
            fresh.diffIdentity !== preview.diffIdentity ||
            fresh.target.key !== preview.target.key ||
            fresh.targetSha !== preview.targetSha ||
            fresh.targetRef !== preview.targetRef
          )
            throw new WorktreeConflict(
              "stale_preview",
              "Task, reviewed diff or target HEAD changed. Preview again.",
            );
          if (fresh.taskDirty || fresh.targetDirty)
            throw new WorktreeConflict(
              "dirty_or_unknown",
              "The task must be clean, and the target must have no staged, unstaged, untracked, or incoming-path-conflicting ignored data.",
            );
          const integration = WorktreeIntegrationSchema.parse({
            id: request.operationId,
            worktreeId: tree.id,
            generation: tree.generation,
            preview,
            approvedTaskSha: preview.taskSha,
            approvedDiffIdentity: preview.diffIdentity,
            state: !fresh.hasCommittedChanges
              ? "no_changes"
              : fresh.alreadyIntegrated
                ? "integrated"
                : "integrating",
            preState: "clean",
            resultSha:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated
                ? fresh.targetSha
                : "",
            finalTree:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated
                ? fresh.targetTree
                : "",
            validationState:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated
                ? "passed"
                : "not_run",
            validationSummary: !fresh.hasCommittedChanges
              ? "No committed task changes require integration."
              : fresh.alreadyIntegrated
                ? "The reviewed task commit is already reachable from the target."
                : "",
            validationStartedAt:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated ? now() : "",
            validatedAt:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated ? now() : "",
            publishState:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated
                ? "published"
                : "not_started",
            publishedAt:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated ? now() : "",
            publicationBaseSha:
              !fresh.hasCommittedChanges || fresh.alreadyIntegrated
                ? fresh.targetSha
                : "",
            publicationDiff: "",
            publicationFileCount: 0,
            publicationCommitCount: 0,
            createdAt: now(),
            updatedAt: now(),
          });
          this.saveIntegration(integration);
          tree.integrationState = integration.state;
          this.save(tree);
          if (!fresh.hasCommittedChanges || fresh.alreadyIntegrated) {
            return { worktree: tree, integration };
          }
          const targetLease = leases.find((lease) => lease.key === preview.target.key)!;
          this.integrationLeases.set(integration.id, targetLease);
          retainTarget = true;
          const result = await this.git.run(
            preview.target.path,
            [
              "-c",
              `core.hooksPath=${await this.disabledHooksPath()}`,
              "merge",
              "--no-ff",
              "--no-commit",
              preview.taskSha,
            ],
            { allowedExitCodes: [0, 1], lease: admin },
          );
          this.options.checkpoint?.("git", request);
          integration.conflicts = await this.conflicts(preview.target.path);
          integration.state = integration.conflicts.length
            ? "conflicted"
            : result.exitCode === 0
              ? "ready"
              : "uncertain";
          integration.updatedAt = now();
          this.saveIntegration(integration);
          tree.integrationState = integration.state;
          if (integration.state === "ready" && request.commit)
            await this.commitIntegration(integration, tree, admin, request);
          retainTarget = !isIntegrated(integration);
          if (!retainTarget) this.integrationLeases.delete(integration.id);
          return { worktree: tree, integration };
        })();
      } catch (error) {
        operationError = error;
      }
      const releaseErrors: unknown[] = [];
      for (const lease of leases.reverse()) {
        if (retainTarget && lease.key === preview.target.key) continue;
        try {
          lease.release();
        } catch (error) {
          releaseErrors.push(error);
        }
      }
      if (operationError) {
        if (releaseErrors.length)
          throw new AggregateError(
            [operationError, ...releaseErrors],
            "Integration failed and one or more leases could not be released.",
            { cause: operationError },
          );
        throw operationError;
      }
      if (releaseErrors.length)
        throw new AggregateError(
          releaseErrors,
          "One or more integration leases could not be released.",
        );
      return operationResult!;
    }
    const integration = this.integration(request.integrationId ?? "");
    if (
      !integration ||
      integration.worktreeId !== tree.id ||
      integration.generation !== tree.generation
    )
      throw new WorktreeConflict(
        "wrong_integration",
        "The integration operation does not match this worktree.",
      );
    const target = integration.preview.target;
    await assertIdentity(target);
    await this.validateIntegrationTarget(tree, integration.preview.target);
    const targetLease = this.integrationLeases.get(integration.id);
    if (!targetLease)
      throw new WorktreeConflict(
        "reconciliation_required",
        "Reconcile the persisted target reservation on this Node before continuing or aborting.",
      );
    await targetLease.revalidate();
    await this.verifyMerge(integration);
    if (request.kind === "abort") {
      if (request.confirm !== `ABORT MERGE ${integration.id}`)
        throw new WorktreeConflict(
          "confirmation_required",
          "Confirm abort of this exact merge operation.",
        );
      integration.state = "aborting";
      this.saveIntegration(integration);
      await this.git.run(target.path, ["merge", "--abort"], { lease: admin });
      this.options.checkpoint?.("git", request);
      if (
        (await this.ref(target.path, "HEAD")) !== integration.preview.targetSha ||
        (await this.ref(target.path, "MERGE_HEAD"))
      )
        throw new WorktreeConflict(
          "abort_uncertain",
          "Abort did not restore the recorded target; reconciliation is required.",
        );
      this.requireTrackedClean(await this.status(target.path));
      integration.state = "aborted";
      integration.conflicts = [];
      integration.updatedAt = now();
      this.saveIntegration(integration);
      tree.integrationState = "aborted";
      targetLease.release();
      this.integrationLeases.delete(integration.id);
      return { worktree: tree, integration };
    }
    if (request.kind !== "continue")
      throw new WorktreeConflict(
        "unsupported_operation",
        "Only explicit merge, continue and abort are supported.",
      );
    const taskLease = this.locks.acquire(tree.checkout!, {
      kind: "maintenance",
      owner: `integration-task:${request.operationId}`,
      attempt: request.operationId,
    });
    try {
      integration.state = "resolving";
      this.saveIntegration(integration);
      integration.conflicts = await this.conflicts(target.path);
      if (integration.conflicts.length) {
        integration.state = "conflicted";
      } else {
        if (request.confirm !== `COMMIT MERGE ${integration.id}` || !request.commit)
          throw new WorktreeConflict(
            "confirmation_required",
            "Explicit commit confirmation is required after resolution.",
          );
        await this.commitIntegration(integration, tree, admin, request);
      }
      tree.integrationState = integration.state;
      integration.updatedAt = now();
      this.saveIntegration(integration);
      if (isIntegrated(integration)) {
        targetLease.release();
        this.integrationLeases.delete(integration.id);
      }

      return { worktree: tree, integration };
    } finally {
      taskLease.release();
    }
  }

  private async verifyMerge(integration: WorktreeIntegration): Promise<void> {
    const target = integration.preview.target;
    if (
      (await this.commonDirectory(target.path)).key !==
        this.get(integration.worktreeId)!.commonDirectory.key ||
      (await this.ref(target.path, "HEAD")) !== integration.preview.targetSha ||
      (await this.ref(target.path, "MERGE_HEAD")) !== integration.approvedTaskSha
    ) {
      throw new WorktreeConflict(
        "merge_mismatch",
        "Target HEAD/ref/MERGE_HEAD no longer matches this operation. No automatic reset or abort is safe.",
      );
    }
    await this.noGitOperation(target.path, true);
  }

  private async commitIntegration(
    integration: WorktreeIntegration,
    tree: ManagedWorktree,
    admin: CheckoutLease,
    request: WorktreeOperationRequest,
  ): Promise<void> {
    await this.verifyMerge(integration);
    await this.verifyRepositoryExecutionPolicy(tree, integration.preview.target.path, {
      ignoreHooks: true,
    });
    if ((await this.ref(tree.path, "HEAD")) !== integration.approvedTaskSha)
      throw new WorktreeConflict("stale_review", "The approved task HEAD changed.");
    this.requireTrackedClean(await this.status(tree.path));
    const status = await this.status(integration.preview.target.path);
    if (status.untracked || status.unstaged)
      throw new WorktreeConflict(
        "resolution_unstaged",
        "Stage resolved files and remove no data automatically; untracked or unstaged changes block commit.",
      );
    if (
      !(await this.noninteractivePolicy(
        integration.preview.target.path,
        true,
        tree.allowGitHooks,
      ))
    ) {
      integration.state = "ready";
      integration.error =
        "Merge is staged and target reserved. Configure noninteractive identity/signing policy, then explicitly continue. Fleet does not bypass signing.";
      this.saveIntegration(integration);
      tree.integrationState = "ready";
      return;
    }
    integration.mergeTree = (
      await this.git.run(integration.preview.target.path, ["write-tree"], {
        lease: admin,
      })
    ).stdout.trim();
    this.saveIntegration(integration);
    await this.git.run(
      integration.preview.target.path,
      [
        "-c",
        `core.hooksPath=${await this.disabledHooksPath()}`,
        "commit",
        "-m",
        `Merge Fleet task ${tree.taskKey}\n\nFleet-Integration: ${integration.id}`,
      ],
      { lease: admin },
    );
    this.options.checkpoint?.("git", request);
    await this.verifyRepositoryExecutionPolicy(tree, integration.preview.target.path, {
      ignoreHooks: true,
    });
    integration.resultSha = await this.ref(integration.preview.target.path, "HEAD");
    integration.finalTree = await this.treeOid(
      integration.preview.target.path,
      integration.resultSha,
    );
    integration.state = "validating";
    integration.validationState = "running";
    integration.validationSummary = "Verifying the merge result and clean target.";
    integration.validationStartedAt = now();
    integration.updatedAt = now();
    this.saveIntegration(integration);
    tree.integrationState = "validating";
    this.save(tree);
    try {
      if (integration.preview.targetAdvancedFromBase)
        throw new WorktreeConflict(
          "post_integration_validation_required",
          "The integration base advanced beyond the execution base. Repository validation commands are not configured, so Fleet will not publish the untested final tree.",
        );
      this.requireTrackedClean(await this.status(integration.preview.target.path));
      if (!(await this.matchesMergeCommit(integration, integration.resultSha)))
        throw new WorktreeConflict(
          "commit_uncertain",
          "The merge commit graph or tree differs from the reviewed integration result.",
        );
      if (integration.finalTree !== integration.mergeTree)
        throw new WorktreeConflict(
          "validation_failed",
          "The committed integration tree differs from the reviewed merge tree.",
        );
    } catch (error) {
      integration.state = "needs_reconciliation";
      integration.validationState = "failed";
      integration.validationSummary =
        "Post-integration validation failed; reconcile the target before cleanup.";
      integration.error =
        error instanceof Error ? error.message : "Integration validation failed.";
      integration.updatedAt = now();
      this.saveIntegration(integration);
      tree.integrationState = "needs_reconciliation";
      this.save(tree);
      throw error;
    }
    integration.state = "integrated";
    integration.validationState = "passed";
    integration.validationSummary =
      "Merge result is clean and contains the reviewed task commit.";
    integration.validatedAt = now();
    integration.publishState = integration.preview.targetRemote
      ? "awaiting_approval"
      : "published";
    integration.publicationBaseSha = integration.preview.targetSha;
    integration.publicationDiff = await this.presentationDiff(
      integration.preview.target.path,
      integration.preview.targetSha,
      integration.resultSha,
    );
    integration.publicationFileCount = Number(
      (
        await this.git.run(
          integration.preview.target.path,
          ["diff", "--name-only", integration.preview.targetSha, integration.resultSha],
          { maxBytes: 2_000_000 },
        )
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean).length,
    );
    integration.publicationCommitCount = Number(
      (
        await this.git.run(integration.preview.target.path, [
          "rev-list",
          "--count",
          `${integration.preview.targetSha}..${integration.resultSha}`,
        ])
      ).stdout.trim() || "0",
    );
    integration.error = "";
    integration.updatedAt = now();
    this.saveIntegration(integration);
    tree.integrationState = "integrated";
  }

  private recoverTaskMaintenance(tree: ManagedWorktree): void {
    if (!tree.checkout) return;
    const holder = this.locks.holder(tree.checkout.key);
    if (
      !holder ||
      holder.kind !== "maintenance" ||
      this.locks.locallyOwned(tree.checkout.key)
    )
      return;
    const id = holder.owner.split(":").at(-1) ?? "";
    const row = this.db.prepare("SELECT request FROM operations WHERE id=?").get(id);
    const request = row
      ? WorktreeOperationRequestSchema.parse(JSON.parse(String(row.request)))
      : undefined;
    if (
      !request ||
      !this.ownedBy(tree, request) ||
      request.worktreeId !== tree.id ||
      request.expectedPath !== tree.path ||
      request.expectedBranchRef !== tree.branchRef ||
      request.expectedBaseSha !== tree.baseSha ||
      !["cleanup", "integrate", "continue"].includes(request.kind)
    ) {
      throw new WorktreeConflict(
        "maintenance_unknown",
        "The checkout maintenance lease has no matching durable transition intent.",
      );
    }
    this.locks.recoverMaintenance(tree.checkout, holder.owner);
  }

  private async matchesMergeCommit(
    integration: WorktreeIntegration,
    sha: string,
  ): Promise<boolean> {
    if (!integration.mergeTree) return false;
    const result = await this.git.run(
      integration.preview.target.path,
      ["show", "-s", "--format=%P%n%T%n%B", sha],
      { maxBytes: 32_000 },
    );
    const [parents, tree, ...message] = result.stdout.split("\n");
    return (
      parents === `${integration.preview.targetSha} ${integration.approvedTaskSha}` &&
      tree === integration.mergeTree &&
      message.includes(`Fleet-Integration: ${integration.id}`)
    );
  }
}

function isIntegrated(integration: WorktreeIntegration): boolean {
  return integration.state === "integrated" || integration.state === "no_changes";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toUpperCase() === resolve(right).toUpperCase()
    : resolve(left) === resolve(right);
}

function normalizeRemoteIdentity(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/)/i.test(trimmed)) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://"))
    return `ssh://${scp[1]!.toLowerCase()}/${scp[2]!
      .replace(/\\/g, "/")
      .replace(/\.git\/?$/i, "")
      .replace(/^\/+|\/+$/g, "")}`;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname
      .replace(/\.git\/?$/i, "")
      .replace(/^\/+|\/+$/g, "")}`;
  } catch {
    return undefined;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function approximateBytes(root: string): Promise<number | null> {
  const pending = [root];
  let count = 0,
    bytes = 0;
  while (pending.length) {
    const path = pending.pop()!;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 100_000) return null;
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(child);
      else bytes += (await lstat(child)).size;
    }
  }
  return bytes;
}
