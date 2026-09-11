import { createHash, randomUUID } from "node:crypto";
import {
  MANAGED_WORKTREES_CAPABILITY,
  WorktreeConflict,
  WorktreeOperationRequestSchema,
  terminalSessionStates,
  terminalRunStates,
  type ExecutionBinding,
  type FleetSession,
  type Run,
  type WorktreeOperation,
  type WorktreeOperationRequest,
  type WorktreeOperationResult,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";

export class ManagedWorktreeService {
  private readonly waiters = new Map<
    string,
    { resolve: (operation: WorktreeOperation) => void; timer: NodeJS.Timeout }
  >();
  private readonly initializing = new Map<string, Promise<void>>();
  private lastSweep = 0;

  constructor(private readonly service: FleetService) {}
  private get store() {
    return this.service.store;
  }

  prepare(runId: string): Promise<void> {
    const previous = this.initializing.get(runId);
    if (previous) return previous;
    const pending = this.prepareRun(runId).finally(() => this.initializing.delete(runId));
    this.initializing.set(runId, pending);
    return pending;
  }

  private async prepareRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (
      !run ||
      binding?.effectiveMode !== "managed" ||
      binding.initialization !== "pending"
    )
      return;
    try {
      const source = binding.sourcePlacementId
        ? this.store.getPlacement(binding.sourcePlacementId)
        : this.store
            .listPlacements()
            .filter((placement) => placement.workspaceId === run.workspaceId)
            .sort(
              (a, b) =>
                Number(Boolean(this.store.getNode(b.nodeId)?.online)) -
                Number(Boolean(this.store.getNode(a.nodeId)?.online)),
            )[0];
      if (!source)
        throw new WorktreeConflict(
          "source_required",
          "Add a repository-root source placement before using managed mode.",
        );
      if (source.workspaceId !== run.workspaceId)
        throw new WorktreeConflict(
          "source_mismatch",
          "The pinned source must belong to the task workspace.",
        );
      this.store.setRunWorkspaceBinding(runId, {
        ...binding,
        sourcePlacementId: source.id,
      });
      this.store.updateRun(runId, { placementId: source.id });
      const operation = await this.request(runId, {
        kind: "reserve",
        actor: "run-creation",
      });
      if (operation.result?.ok) this.service.tickRun(runId);
    } catch (error) {
      const current = this.store.getRun(runId)?.workspaceBinding;
      if (current)
        this.store.setRunWorkspaceBinding(runId, {
          ...current,
          initialization: "blocked",
          error:
            error instanceof Error
              ? error.message
              : "Managed workspace initialization failed.",
        });
      this.service.notifications.createWorktreeAttention(
        runId,
        `generation:${binding.generation}`,
        "creation",
      );
      this.publish(runId);
    }
  }

  /** Allocation is deferred until checkout work is dispatched; the base is already pinned. */
  ensureReady(run: Run): boolean {
    const binding = run.workspaceBinding;
    if (binding?.effectiveMode !== "managed") return true;
    if (binding.initialization === "ready") {
      if (this.pending(run.id)) return false;
      const tree = this.store.worktreeForRun(run.id);
      return Boolean(
        tree &&
        ["ready", "retained"].includes(tree.state) &&
        !tree.abandonedAt &&
        ![
          "integrating",
          "ready",
          "conflicted",
          "resolving",
          "aborting",
          "uncertain",
          "needs_reconciliation",
        ].includes(tree.integrationState),
      );
    }
    if (binding.initialization === "pending") void this.prepare(run.id);
    if (binding.initialization === "reserved" && !this.pending(run.id)) {
      void this.request(run.id, { kind: "create", actor: "scheduler" })
        .then(() => this.service.tickRun(run.id))
        .catch((error: unknown) => {
          const binding = this.store.getRun(run.id)?.workspaceBinding;
          if (binding)
            this.store.setRunWorkspaceBinding(run.id, {
              ...binding,
              initialization: "blocked",
              error:
                error instanceof Error
                  ? error.message
                  : "Managed workspace dispatch blocked.",
            });
          this.publish(run.id);
        });
    }
    return false;
  }

  private pending(runId: string): WorktreeOperation | undefined {
    return this.store
      .listWorktreeOperations(
        this.store.getRun(runId)?.workspaceBinding?.managedWorktreeId,
      )
      .find(
        (operation) =>
          operation.request.runId === runId &&
          ["intent", "uncertain"].includes(operation.state),
      );
  }

  async request(
    runId: string,
    input: Partial<WorktreeOperationRequest> &
      Pick<WorktreeOperationRequest, "kind" | "actor">,
    waitMs = 30_000,
  ): Promise<WorktreeOperation> {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || binding?.effectiveMode !== "managed")
      throw new WorktreeConflict(
        "not_managed",
        "This task uses its legacy source checkout.",
      );
    if (binding.initialization === "quarantined" && input.kind !== "reconcile")
      throw new WorktreeConflict(
        "quarantined",
        "Restored metadata requires explicit reconciliation first.",
      );
    const placement = this.store.getPlacement(binding.sourcePlacementId);
    if (!placement)
      throw new WorktreeConflict(
        "source_unavailable",
        "The pinned source placement is unavailable; no replacement is chosen automatically.",
      );
    const node = this.store.getNode(placement.nodeId);
    if (!node?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY))
      throw new WorktreeConflict(
        "unsupported_node",
        "Upgrade the pinned Node to managed-worktrees-v1. Managed tasks never fall back to Legacy.",
      );
    if (!node.online || !this.service.nodeSocket(node.id))
      throw new WorktreeConflict(
        "node_unavailable",
        "The owning Node is offline; checkout state and process ownership are unknown.",
      );
    const tree = this.store.worktreeForRun(runId);
    const suppliedId = input.operationId ?? randomUUID();
    const existing = this.store.getWorktreeOperation(suppliedId);
    const request = WorktreeOperationRequestSchema.parse({
      ...input,
      operationId: suppliedId,
      worktreeId: binding.managedWorktreeId,
      runId,
      sourcePlacementId: placement.id,
      workspaceId: run.workspaceId,
      sourcePath: placement.localPath,
      nodeId: node.id,
      hostInstallationId: this.store.worktreeHostInstallationId(),
      expectedVersion: input.expectedVersion ?? tree?.version ?? 0,
      generation: binding.generation,
      expectedPath: tree?.path ?? "",
      expectedBranchRef: tree?.branchRef ?? "",
      expectedBaseSha: binding.baseSha,
      policy: this.store.getManagedWorktreePolicy(),
    });
    if (existing) {
      // A replay uses the original immutable envelope, not today's policy or path.
      for (const key of Object.keys(input) as (keyof typeof input)[]) {
        if (
          JSON.stringify(existing.request[key as keyof WorktreeOperationRequest]) !==
          JSON.stringify(input[key])
        ) {
          throw new WorktreeConflict(
            "idempotency_mismatch",
            "That operation ID was already used with different arguments.",
          );
        }
      }
      if (existing.state === "quarantined")
        throw new WorktreeConflict(
          "quarantined",
          "Restored operations cannot be replayed; explicitly reconcile.",
        );
      if (existing.result) return existing;
      return this.send(existing, waitMs);
    }
    if (tree && request.expectedVersion !== tree.version)
      throw new WorktreeConflict(
        "stale_revision",
        "Worktree state changed. Refresh the preview and revision.",
      );
    const pending = this.pending(runId);
    if (pending) {
      if (input.kind === "reconcile") return this.send(pending, waitMs);
      throw new WorktreeConflict(
        "operation_pending",
        `Operation ${pending.request.operationId} is awaiting reconciliation or its Node acknowledgement.`,
      );
    }
    if (request.targetPlacementId) {
      const target = this.store.getPlacement(request.targetPlacementId);
      if (!target || target.nodeId !== node.id)
        throw new WorktreeConflict(
          "target_node",
          "Choose a target placement on the owning Node.",
        );
      request.targetPath = target.localPath;
    } else if (request.targetPath) {
      throw new WorktreeConflict(
        "target_required",
        "Targets must be explicitly selected from this Node's catalog.",
      );
    }
    const operation: WorktreeOperation = {
      request,
      state: "intent",
      createdAt: new Date().toISOString(),
    };
    this.store.putWorktreeOperation(operation);
    this.publish(runId);
    return this.send(operation, waitMs);
  }

  private send(operation: WorktreeOperation, waitMs: number): Promise<WorktreeOperation> {
    const socket = this.service.nodeSocket(operation.request.nodeId);
    if (!socket) return Promise.resolve(operation);
    const previous = this.waiters.get(operation.request.operationId);
    if (previous)
      return Promise.resolve(
        this.store.getWorktreeOperation(operation.request.operationId)!,
      );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(operation.request.operationId);
        const current = this.store.getWorktreeOperation(operation.request.operationId)!;
        if (!current.result) {
          this.store.putWorktreeOperation({ ...current, state: "uncertain" });
          this.publish(operation.request.runId);
        }
        resolve(this.store.getWorktreeOperation(operation.request.operationId)!);
      }, waitMs);
      timer.unref();
      this.waiters.set(operation.request.operationId, { timer, resolve });
      this.service.send(socket, { type: "managed_worktree", request: operation.request });
    });
  }

  handleResult(nodeId: string, result: WorktreeOperationResult): boolean {
    const operation = this.store.getWorktreeOperation(result.operationId);
    if (!operation || operation.state === "quarantined") return false;
    const expected = operation.request;
    if (
      expected.nodeId !== nodeId ||
      result.nodeId !== nodeId ||
      expected.worktreeId !== result.worktreeId ||
      expected.generation !== result.generation ||
      expected.hostInstallationId !== result.hostInstallationId
    )
      return false;
    if (operation.result)
      return JSON.stringify(operation.result) === JSON.stringify(result);
    const tree = result.worktree;
    const safeKey = createHash("sha256")
      .update(`${expected.hostInstallationId}:${expected.runId}:${expected.generation}`)
      .digest("hex")
      .slice(0, 32);
    if (
      tree &&
      (tree.id !== expected.worktreeId ||
        tree.runId !== expected.runId ||
        tree.nodeId !== nodeId ||
        tree.hostInstallationId !== expected.hostInstallationId ||
        tree.sourcePlacementId !== expected.sourcePlacementId ||
        tree.workspaceId !== expected.workspaceId ||
        tree.generation !== expected.generation ||
        tree.taskKey !== safeKey ||
        tree.branchRef !== `refs/heads/fleet/${safeKey}` ||
        tree.pinRef !== `refs/fleet/pins/${safeKey}` ||
        ![
          `${tree.managedRoot.path}\\${safeKey}`,
          `${tree.managedRoot.path}/${safeKey}`,
        ].includes(tree.path) ||
        (tree.checkout && tree.checkout.path !== tree.path) ||
        (expected.expectedPath && tree.path !== expected.expectedPath) ||
        (expected.expectedBranchRef && tree.branchRef !== expected.expectedBranchRef) ||
        (expected.expectedBaseSha && tree.baseSha !== expected.expectedBaseSha) ||
        (expected.kind === "reconcile"
          ? tree.version <= expected.expectedVersion
          : tree.version !== expected.expectedVersion + 1))
    )
      return false;
    if (
      result.preview &&
      (result.preview.worktreeId !== expected.worktreeId ||
        result.preview.generation !== expected.generation ||
        result.preview.id !== expected.operationId ||
        result.preview.targetPlacementId !== expected.targetPlacementId)
    )
      return false;
    if (
      result.integration &&
      (result.integration.worktreeId !== expected.worktreeId ||
        result.integration.generation !== expected.generation ||
        (expected.kind === "integrate" &&
          result.integration.id !== expected.operationId) ||
        (["continue", "abort"].includes(expected.kind) &&
          result.integration.id !== expected.integrationId))
    )
      return false;
    if (result.ok && !tree) return false;
    this.store.writeAtomically(() => {
      if (tree) this.store.putManagedWorktree(tree);
      if (result.integration) {
        if (
          result.integration.worktreeId !== expected.worktreeId ||
          result.integration.generation !== expected.generation
        )
          throw new WorktreeConflict(
            "integration_mismatch",
            "Integration receipt ownership did not match.",
          );
        this.store.putWorktreeIntegration(result.integration);
      }
      this.store.putWorktreeOperation({ ...operation, state: "acknowledged", result });
      const run = this.store.getRun(expected.runId);
      const binding = run?.workspaceBinding;
      if (binding) {
        const available =
          tree && ["ready", "retained"].includes(tree.state) && !tree.abandonedAt;
        this.store.setRunWorkspaceBinding(expected.runId, {
          ...binding,
          ...(tree
            ? {
                baseSha: tree.baseSha,
                checkoutKey: tree.checkout?.key ?? binding.checkoutKey,
                resolvedPath: tree.path,
              }
            : {}),
          initialization: result.ok
            ? available
              ? "ready"
              : tree?.state === "reserved"
                ? "reserved"
                : "blocked"
            : expected.kind === "reserve" ||
                expected.kind === "create" ||
                expected.kind === "reconcile"
              ? "blocked"
              : binding.initialization,
          error: result.error || tree?.error || "",
        });
        if (result.ok && expected.kind === "reconcile" && available) {
          for (const session of this.store.listSessions())
            if (
              session.runId === run!.id &&
              session.executionBinding?.worktreeId === tree.id
            ) {
              this.store.setSessionExecutionBinding(session.id, {
                ...session.executionBinding,
                quarantined: false,
              });
            }
          for (const step of this.store.listRunSteps(run!.id))
            if (step.executionBinding?.worktreeId === tree.id) {
              this.store.updateRunStep(step.id, {
                executionBinding: { ...step.executionBinding, quarantined: false },
              });
            }
        }
      }
      if (tree?.state === "removed" || tree?.abandonedAt) {
        for (const tombstone of this.store
          .listWorktreeTombstones()
          .filter((entry) => entry.worktreeId === tree.id)) {
          this.store.putWorktreeTombstone({
            ...tombstone,
            state: tree.abandonedAt ? "abandoned" : "reconciled",
            reconciledAt: result.acknowledgedAt,
          });
        }
      }
    });
    const waiter = this.waiters.get(result.operationId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(result.operationId);
      waiter.resolve(this.store.getWorktreeOperation(result.operationId)!);
    }
    this.publish(expected.runId);
    if (!result.ok && ["reserve", "create"].includes(expected.kind)) {
      this.service.notifications.createWorktreeAttention(
        expected.runId,
        `generation:${expected.generation}`,
        "creation",
      );
    } else if (result.integration?.state === "conflicted") {
      this.service.notifications.createWorktreeAttention(
        expected.runId,
        result.integration.id,
        "conflict",
      );
    } else if (
      tree?.state === "needs_reconciliation" ||
      result.integration?.state === "needs_reconciliation"
    ) {
      this.service.notifications.createWorktreeAttention(
        expected.runId,
        result.integration?.id ?? `generation:${expected.generation}`,
        "reconciliation",
      );
    }
    this.service.tickRun(expected.runId);
    return true;
  }

  onNodeReconciled(nodeId: string): void {
    if (!this.store.getNode(nodeId)?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY))
      return;
    for (const operation of this.store
      .listWorktreeOperations()
      .filter(
        (entry) =>
          entry.request.nodeId === nodeId &&
          ["intent", "uncertain"].includes(entry.state),
      )
      .slice(0, 2))
      void this.send(operation, 30_000);
    for (const tree of this.store
      .listManagedWorktrees()
      .filter(
        (entry) =>
          entry.nodeId === nodeId &&
          entry.state === "unavailable" &&
          this.store.getRun(entry.runId)?.workspaceBinding?.initialization !==
            "quarantined" &&
          !this.pending(entry.runId),
      )
      .slice(0, 2)) {
      void this.request(tree.runId, { kind: "reconcile", actor: "node-reconnect" }).catch(
        () => undefined,
      );
    }
  }

  sweep(nowMs = Date.now()): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    let count = 0;
    for (const tree of this.store.listManagedWorktrees()) {
      if (count >= 2) break;
      const run = this.store.getRun(tree.runId);
      if (
        !run ||
        !terminalRunStates.has(run.state) ||
        tree.abandonedAt ||
        !this.store.getNode(tree.nodeId)?.online ||
        this.pending(run.id) ||
        this.store
          .listSessions()
          .some(
            (session) =>
              session.runId === run.id &&
              (!terminalSessionStates.has(session.state) || session.stopRequested),
          )
      )
        continue;
      const kind =
        tree.state === "ready"
          ? "retain"
          : tree.state === "retained" &&
              tree.integrationState === "integrated" &&
              tree.observation?.dirty === false &&
              tree.expiresAt &&
              Date.parse(tree.expiresAt) <= nowMs
            ? "cleanup"
            : undefined;
      if (!kind) continue;
      count += 1;
      void this.request(run.id, { kind, actor: "bounded-retention" }).catch(
        () => undefined,
      );
    }
  }

  nodeLost(nodeId: string): void {
    for (const tree of this.store
      .listManagedWorktrees()
      .filter(
        (entry) =>
          entry.nodeId === nodeId && !["removed", "quarantined"].includes(entry.state),
      )) {
      this.store.putManagedWorktree({
        ...tree,
        state: "unavailable",
        error: "Node unavailable: process and filesystem state are unknown.",
        ...(tree.observation
          ? { observation: { ...tree.observation, dirty: null, locked: null } }
          : {}),
      });
    }
  }

  bindingFor(run: Run, attempt: string = randomUUID()): ExecutionBinding | undefined {
    const binding = run.workspaceBinding;
    if (binding?.effectiveMode !== "managed") return undefined;
    const tree = this.store.worktreeForRun(run.id);
    if (
      binding.initialization !== "ready" ||
      !tree?.checkout ||
      !["ready", "retained"].includes(tree.state) ||
      tree.abandonedAt
    )
      throw new WorktreeConflict(
        "workspace_not_ready",
        binding.error ||
          "Managed task workspace is not ready; source fallback is prohibited.",
      );
    return {
      worktreeId: tree.id,
      generation: tree.generation,
      sourcePlacementId: tree.sourcePlacementId,
      cwd: tree.path,
      checkoutKey: tree.checkout.key,
      accessClass: "shell",
      leaseAttempt: attempt,
      quarantined: false,
    };
  }

  validateSession(session: FleetSession): void {
    const binding = session.executionBinding;
    const run = session.runId ? this.store.getRun(session.runId) : undefined;
    if (
      session.runRole !== "lead" &&
      run?.workspaceBinding?.effectiveMode === "managed" &&
      !binding?.worktreeId
    )
      throw new WorktreeConflict(
        "binding_required",
        "The managed task's launch binding is missing.",
      );
    if (!binding?.worktreeId) return;
    if (binding.quarantined || !run)
      throw new WorktreeConflict(
        "quarantined",
        "This managed session requires explicit reconciliation.",
      );
    if (this.pending(run.id))
      throw new WorktreeConflict(
        "workspace_admin_pending",
        "A durable worktree operation is in progress. Wait for its Node acknowledgement.",
      );
    const expected = this.bindingFor(run, binding.leaseAttempt)!;
    if (JSON.stringify({ ...binding, quarantined: false }) !== JSON.stringify(expected)) {
      throw new WorktreeConflict(
        "binding_mismatch",
        "The session's immutable checkout binding does not match its task.",
      );
    }
    const tree = this.store.worktreeForRun(run.id)!;
    if (
      tree.nodeId !== session.nodeId ||
      !this.store
        .getNode(session.nodeId)
        ?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY) ||
      [
        "integrating",
        "ready",
        "conflicted",
        "resolving",
        "aborting",
        "uncertain",
        "needs_reconciliation",
      ].includes(tree.integrationState)
    ) {
      throw new WorktreeConflict(
        "workspace_reserved",
        "The worktree is unavailable or reserved for integration.",
      );
    }
    const competitor = this.store
      .listSessions()
      .find(
        (entry) =>
          entry.id !== session.id &&
          entry.executionBinding?.checkoutKey === binding.checkoutKey &&
          (!terminalSessionStates.has(entry.state) || entry.stopRequested),
      );
    if (competitor)
      throw new WorktreeConflict(
        "checkout_busy",
        `The task checkout is still held by session ${competitor.id}; verify process quiescence before transferring it.`,
      );
  }

  shutdown(): void {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      const operation = this.store.getWorktreeOperation(id);
      if (operation) waiter.resolve(operation);
    }
    this.waiters.clear();
  }

  private publish(runId: string): void {
    const run = this.store.getRun(runId);
    if (run) this.service.publishRun(run);
  }
}
