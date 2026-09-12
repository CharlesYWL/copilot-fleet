import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  GitShaSchema,
  IntegrationPreviewSchema,
  ManagedWorktreeSchema,
  WorktreeConflict,
  WorktreeIntegrationSchema,
  WorktreeObservationSchema,
  WorktreeOperationRequestSchema,
  WorktreeOperationResultSchema,
  type CheckoutIdentity,
  type ExecutionBinding,
  type IntegrationPreview,
  type ManagedWorktree,
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
};
const now = () => new Date().toISOString();
const unresolved = new Set([
  "integrating",
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trees_run_generation
        ON trees(json_extract(data,'$.runId'),json_extract(data,'$.generation'));
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
    if (request.nodeId !== this.options.nodeId()) {
      throw new WorktreeConflict("wrong_owner", "This Node does not own that request.");
    }
    const previous = this.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(request.operationId);
    if (previous) {
      if (!isDeepStrictEqual(JSON.parse(String(previous.request)), request)) {
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
    let result: WorktreeOperationResult;
    try {
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
      const tree = ["binding_mismatch", "wrong_owner", "stale_revision"].includes(code)
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
        retryable: code === "checkout_busy",
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
      tree.workspaceId === request.workspaceId
    );
  }

  private async perform(request: WorktreeOperationRequest): Promise<{
    worktree: ManagedWorktree;
    preview?: IntegrationPreview;
    integration?: WorktreeIntegration;
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
          tree.expiresAt =
            tree.integrationState === "integrated" && tree.observation.dirty === false
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

  private async supportedRepository(path: string, base: string): Promise<void> {
    const config = await this.git.run(
      path,
      [
        "config",
        "--get-regexp",
        "^(extensions\\.(partialclone|worktreeconfig)|core\\.(sparsecheckout|sparsecheckoutcone)|remote\\..*\\.(promisor|partialclonefilter))$",
      ],
      { allowedExitCodes: [0, 1] },
    );
    if (config.stdout.trim())
      throw new WorktreeConflict(
        "unsupported_repository",
        "V1 rejects sparse, partial/promisor, LFS and worktree-specific configurations.",
      );
    const modules = await this.git.run(path, ["ls-tree", "-r", base], {
      maxBytes: 2_000_000,
    });
    if (/^160000 /m.test(modules.stdout) || /\t\.gitmodules$/m.test(modules.stdout)) {
      throw new WorktreeConflict(
        "unsupported_repository",
        "V1 does not initialize or manage submodules.",
      );
    }
    const attributes = await this.git.run(
      path,
      ["grep", "-I", "-l", "-e", "filter=lfs", base, "--", "*.gitattributes"],
      { allowedExitCodes: [0, 1] },
    );
    if (attributes.stdout)
      throw new WorktreeConflict(
        "unsupported_repository",
        "V1 does not manage Git LFS repositories.",
      );
    await this.noninteractivePolicy(path, false);
  }

  private async noninteractivePolicy(
    path: string,
    committing: boolean,
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
    if (hookNames.some((name) => !name.endsWith(".sample"))) {
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
    const base = GitShaSchema.parse(
      (
        await this.git.run(repository.path, ["rev-parse", "--verify", "HEAD^{commit}"])
      ).stdout.trim(),
    );
    await this.supportedRepository(repository.path, base);
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
      `${request.hostInstallationId}:${request.runId}:${request.generation}`,
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
    const files = await this.git.run(repository.path, ["ls-tree", "-r", "-l", base], {
      maxBytes: 2_000_000,
    });
    const estimate = files.stdout
      .split("\n")
      .reduce(
        (sum, line) => sum + (Number(/^\d+ \w+ [a-f0-9]+ +(\d+)\t/.exec(line)?.[1]) || 0),
        0,
      );
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
    await this.supportedRepository(tree.repository.path, tree.baseSha);
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
      await this.git.run(
        tree.repository.path,
        [
          "worktree",
          "add",
          "-b",
          tree.branchRef.slice("refs/heads/".length),
          tree.path,
          tree.baseSha,
        ],
        { timeoutMs: 120_000, lease: admin },
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

  private async ref(path: string, ref: string): Promise<string> {
    return (
      await this.git.run(path, ["rev-parse", "--verify", ref], {
        allowedExitCodes: [0, 128],
      })
    ).stdout.trim();
  }

  private async status(
    path: string,
  ): Promise<
    Pick<WorktreeObservation, "staged" | "unstaged" | "untracked" | "ignored" | "dirty">
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
    const fields = text.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (!field) continue;
      const xy = field.slice(0, 2);
      if (xy === "??") untracked = true;
      else if (xy === "!!") ignored = true;
      else {
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
    };
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
        this.requireClean(await this.status(pending.preview.target.path));
        pending.state = "aborted";
        pending.conflicts = [];
        pending.error = "";
      } else if (
        sameTarget &&
        !mergeHead &&
        (await this.matchesMergeCommit(pending, head))
      ) {
        await this.noGitOperation(pending.preview.target.path);
        this.requireClean(await this.status(pending.preview.target.path));
        pending.state = "integrated";
        pending.resultSha = head;
        pending.conflicts = [];
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
    const lease = this.locks.acquire(tree.checkout!, {
      owner: `cleanup:${request.operationId}`,
      attempt: request.operationId,
      kind: "maintenance",
    });
    try {
      await lease.revalidate();
      await this.verifyTree(tree);
      await this.noGitOperation(tree.path);
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
      if (request.deleteBranch) {
        const integration = this.integrations(tree.id).find(
          (entry) => entry.state === "integrated",
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
  ): Promise<IntegrationPreview> {
    if (!request.targetPath || !request.targetPlacementId)
      throw new WorktreeConflict(
        "target_required",
        "Choose a target checkout explicitly.",
      );
    const target = await this.repository(request.targetPath);
    if (
      target.key === tree.checkout!.key ||
      (await this.commonDirectory(target.path)).key !== tree.commonDirectory.key
    )
      throw new WorktreeConflict(
        "target_repository",
        "Target must be a different checkout on this Node sharing the exact Git common directory.",
      );
    this.locks.bindScope(target, tree.commonDirectory);
    await this.noGitOperation(tree.path);
    await this.noGitOperation(target.path);
    await this.noninteractivePolicy(target.path, false);
    const taskSha = GitShaSchema.parse(await this.ref(tree.path, "HEAD"));
    const targetSha = GitShaSchema.parse(await this.ref(target.path, "HEAD"));
    const targetRef = (
      await this.git.run(target.path, ["symbolic-ref", "-q", "HEAD"], {
        allowedExitCodes: [0, 1],
      })
    ).stdout.trim();
    if (!targetRef)
      throw new WorktreeConflict(
        "detached_target",
        "Integration requires the target's current branch; Fleet never chooses or switches one.",
      );
    const diff = (
      await this.git.run(
        tree.path,
        [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          tree.baseSha,
          taskSha,
          "--",
        ],
        { maxBytes: 1_000_000 },
      )
    ).stdout;
    return IntegrationPreviewSchema.parse({
      id: request.operationId,
      worktreeId: tree.id,
      generation: tree.generation,
      taskSha,
      diffIdentity: identityHash(diff),
      diff,
      targetPlacementId: request.targetPlacementId,
      target,
      targetSha,
      targetRef,
      taskDirty: (await this.status(tree.path)).dirty,
      targetDirty: (await this.status(target.path)).dirty,
      alreadyIntegrated: await this.ancestor(target.path, taskSha, targetSha),
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
      const preview = await this.preview(tree, request);
      this.db
        .prepare("INSERT INTO previews (id,data) VALUES (?,?)")
        .run(preview.id, JSON.stringify(preview));
      return { worktree: tree, preview };
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
      if (
        preview.worktreeId !== tree.id ||
        preview.generation !== tree.generation ||
        request.reviewedTaskSha !== preview.taskSha ||
        request.reviewedDiffIdentity !== preview.diffIdentity ||
        request.confirm !== `MERGE ${preview.taskSha} INTO ${preview.targetRef}`
      )
        throw new WorktreeConflict(
          "review_required",
          "Confirm the exact reviewed task SHA, diff and target branch.",
        );
      const leases: CheckoutLease[] = [];
      let retainTarget = false;
      try {
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
        const fresh = await this.preview(tree, {
          ...request,
          targetPath: preview.target.path,
          targetPlacementId: preview.targetPlacementId,
        });
        if (
          fresh.taskSha !== preview.taskSha ||
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
            "Both task and target must be clean, including untracked and ignored data.",
          );
        const integration = WorktreeIntegrationSchema.parse({
          id: request.operationId,
          worktreeId: tree.id,
          generation: tree.generation,
          preview,
          approvedTaskSha: preview.taskSha,
          approvedDiffIdentity: preview.diffIdentity,
          state: fresh.alreadyIntegrated ? "integrated" : "integrating",
          preState: "clean",
          resultSha: fresh.alreadyIntegrated ? fresh.targetSha : "",
          createdAt: now(),
          updatedAt: now(),
        });
        this.saveIntegration(integration);
        tree.integrationState = integration.state;
        this.save(tree);
        if (fresh.alreadyIntegrated) return { worktree: tree, integration };
        const targetLease = leases.find((lease) => lease.key === preview.target.key)!;
        this.integrationLeases.set(integration.id, targetLease);
        retainTarget = true;
        const result = await this.git.run(
          preview.target.path,
          ["merge", "--no-ff", "--no-commit", preview.taskSha],
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
      } finally {
        for (const lease of leases.reverse())
          if (!(retainTarget && lease.key === preview.target.key)) lease.release();
      }
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
      this.requireClean(await this.status(target.path));
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
      (await this.ref(target.path, "MERGE_HEAD")) !== integration.approvedTaskSha ||
      (await this.git.run(target.path, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() !==
        integration.preview.targetRef
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
    if ((await this.ref(tree.path, "HEAD")) !== integration.approvedTaskSha)
      throw new WorktreeConflict("stale_review", "The approved task HEAD changed.");
    this.requireClean(await this.status(tree.path));
    const status = await this.status(integration.preview.target.path);
    if (status.untracked || status.ignored || status.unstaged)
      throw new WorktreeConflict(
        "resolution_unstaged",
        "Stage resolved files and remove no data automatically; untracked, ignored or unstaged changes block commit.",
      );
    if (!(await this.noninteractivePolicy(integration.preview.target.path, true))) {
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
        "commit",
        "-m",
        `Merge Fleet task ${tree.taskKey}\n\nFleet-Integration: ${integration.id}`,
      ],
      { lease: admin },
    );
    this.options.checkpoint?.("git", request);
    integration.resultSha = await this.ref(integration.preview.target.path, "HEAD");
    this.requireClean(await this.status(integration.preview.target.path));
    if (!(await this.matchesMergeCommit(integration, integration.resultSha)))
      throw new WorktreeConflict(
        "commit_uncertain",
        "The merge result did not include the approved task.",
      );
    integration.state = "integrated";
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
  return integration.state === "integrated";
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
