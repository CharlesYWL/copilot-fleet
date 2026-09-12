import { createHash, randomUUID } from "node:crypto";
import {
  MANAGED_WORKTREES_CAPABILITY,
  WorktreeConflict,
  WorktreeOperationRequestSchema,
  canTransitionRun,
  isWritingCategory,
  terminalSessionStates,
  terminalRunStates,
  type ExecutionBinding,
  type FleetSession,
  type Run,
  type RunStep,
  type ManagedWorktree,
  type WorktreeComposition,
  type WorktreeOperation,
  type WorktreeOperationRequest,
  type WorktreeOperationResult,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";
import { stopSessions } from "./orchestrator/lifecycle.js";

export class ManagedWorktreeService {
  private readonly waiters = new Map<
    string,
    { resolve: (operation: WorktreeOperation) => void; timer: NodeJS.Timeout }
  >();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly aggregating = new Set<string>();
  private lastSweep = 0;

  private deterministicUuid(value: string): string {
    const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  }

  constructor(private readonly service: FleetService) {}
  private get store() {
    return this.service.store;
  }

  private setupSummary(code: string): string {
    if (["source_required", "source_mismatch", "source_unavailable"].includes(code))
      return "The selected repository is unavailable. Choose an available repository and retry.";
    if (
      [
        "bare_repository",
        "unborn_repository",
        "invalid_base",
        "invalid_baseline",
      ].includes(code)
    )
      return "Fleet could not resolve a committed baseline from the selected repository.";
    if (
      [
        "path_ref_collision",
        "ref_collision",
        "pin_collision",
        "worktree_conflict",
      ].includes(code)
    )
      return "An existing branch or worktree conflicts with this isolated workspace.";
    if (code === "node_unavailable")
      return "The repository’s Node disconnected during workspace preparation.";
    if (code === "unsupported_hooks")
      return "The selected repository has active Git hooks. Review the workspace details to continue explicitly.";
    if (code.startsWith("unsupported") || code === "bare_repository")
      return "The selected repository configuration is not supported by isolated workspaces.";
    if (code === "git_incomplete" || code.startsWith("git_"))
      return "Git could not finish preparing the isolated workspace.";
    return "Fleet could not prepare the isolated workspace. Review the details and retry.";
  }

  private markSetupFailed(runId: string, code: string, detail: string): void {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding) return;
    const resumeState =
      run.state === "blocked"
        ? binding.setupResumeState
        : ["awaiting_approval", "planning", "running", "awaiting_lead"].includes(
              run.state,
            )
          ? (run.state as typeof binding.setupResumeState)
          : binding.setupResumeState;
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      initialization: "blocked",
      setupState: "failed",
      setupCode: code,
      setupSummary: this.setupSummary(code),
      setupCompletedAt: new Date().toISOString(),
      setupResumeState: resumeState,
      error: detail,
    });
    if (run.state !== "blocked" && canTransitionRun(run.state, "blocked")) {
      this.store.setRunState(runId, "blocked");
    }
    this.service.notifications.createWorktreeAttention(
      runId,
      `generation:${binding.generation}`,
      "creation",
      code,
    );
    this.publish(runId);
  }

  private markSetupReady(runId: string): void {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding) return;
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      setupState: "succeeded",
      setupCode: "",
      setupSummary: "",
      setupCompletedAt: new Date().toISOString(),
      error: "",
    });
    if (
      run.state === "blocked" &&
      canTransitionRun("blocked", binding.setupResumeState)
    ) {
      this.store.setRunState(runId, binding.setupResumeState);
    }
    this.service.notifications.resolveWorktreeAttention(
      runId,
      `generation:${binding.generation}`,
      "creation",
    );
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
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      setupState: "running",
      setupStartedAt: binding.setupStartedAt || new Date().toISOString(),
      setupCompletedAt: "",
      setupCode: "",
      setupSummary: "",
      error: "",
    });
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
      this.markSetupFailed(
        runId,
        error instanceof WorktreeConflict ? error.code : "workspace_setup_failed",
        error instanceof Error
          ? error.message
          : "Managed workspace initialization failed.",
      );
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
          "validating",
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
          this.markSetupFailed(
            run.id,
            error instanceof WorktreeConflict ? error.code : "workspace_setup_failed",
            error instanceof Error
              ? error.message
              : "Managed workspace dispatch blocked.",
          );
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

  private pendingWorkspace(worktreeId: string): WorktreeOperation | undefined {
    return this.store
      .listWorktreeOperations(worktreeId)
      .find((operation) => ["intent", "uncertain"].includes(operation.state));
  }

  private workspaceId(runId: string, stepId: string): string {
    return `worktree-${createHash("sha256")
      .update(`${runId}:step:${stepId}`)
      .digest("hex")
      .slice(0, 32)}`;
  }

  private compositionFor(run: Run, step: RunStep): WorktreeComposition | undefined {
    const all = this.store.listRunSteps(run.id);
    const byKey = new Map(all.map((entry) => [entry.stepKey, entry]));
    const collected = new Map<string, RunStep>();
    const visit = (key: string, seen = new Set<string>()) => {
      if (seen.has(key)) return;
      seen.add(key);
      const predecessor = byKey.get(key);
      if (!predecessor) return;
      if (isWritingCategory(predecessor.category)) {
        collected.set(predecessor.id, predecessor);
        return;
      }
      for (const dependency of predecessor.dependsOn) visit(dependency, seen);
    };
    for (const key of step.dependsOn) visit(key);
    const predecessors = [...collected.values()].sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
    if (predecessors.length === 0) return undefined;
    if (
      predecessors.some(
        (entry) =>
          entry.state !== "succeeded" || !entry.resultSha || !entry.managedWorktreeId,
      )
    )
      return undefined;
    return {
      baseSha: run.workspaceBinding!.baseSha,
      baseRef: run.workspaceBinding!.baseRef,
      predecessors: predecessors.map((entry) => ({
        stepId: entry.id,
        stepKey: entry.stepKey,
        position: entry.position,
        worktreeId: entry.managedWorktreeId!,
        resultSha: entry.resultSha!,
      })),
      state: "pending",
      resultSha: "",
      conflicts: [],
      error: "",
      startedAt: "",
      completedAt: "",
    };
  }

  ensureStepReady(run: Run, step: RunStep): ExecutionBinding | undefined {
    if (run.workspaceBinding?.effectiveMode !== "managed") return this.bindingFor(run);
    const primary = this.store.worktreeForRun(run.id);
    if (!primary || run.workspaceBinding.initialization !== "ready") return undefined;
    const composition = this.compositionFor(run, step);
    const all = this.store.listRunSteps(run.id);
    const byKey = new Map(all.map((entry) => [entry.stepKey, entry]));
    const hasWritableHistory = (key: string, seen = new Set<string>()): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      const predecessor = byKey.get(key);
      return Boolean(
        predecessor &&
        (isWritingCategory(predecessor.category) ||
          predecessor.dependsOn.some((dependency) =>
            hasWritableHistory(dependency, seen),
          )),
      );
    };
    const dependsOnWritableHistory = step.dependsOn.some((key) =>
      hasWritableHistory(key),
    );
    if (!isWritingCategory(step.category) && !dependsOnWritableHistory)
      return this.bindingFor(run);
    if (dependsOnWritableHistory && !composition) return undefined;
    const worktreeId = step.managedWorktreeId || this.workspaceId(run.id, step.id);
    if (!step.managedWorktreeId) {
      this.store.updateRunStep(step.id, {
        managedWorktreeId: worktreeId,
        workspaceState: "pending",
        workspaceError: "",
      });
    }
    const tree = this.store.derivedWorkspaceForStep(run.id, step.id);
    const pending = this.pendingWorkspace(worktreeId);
    const request = (
      kind: WorktreeOperationRequest["kind"],
      expected?: ManagedWorktree,
    ) => {
      if (pending) return;
      const operationId = this.deterministicUuid(
        `${worktreeId}:${kind}:${expected?.version ?? 0}`,
      );
      void this.requestWorkspace(run.id, worktreeId, 1, {
        kind,
        actor: "dag-scheduler",
        operationId,
        workspaceKind: composition ? "derived" : "step",
        ownerStepId: step.id,
        ...(composition ? { composition } : {}),
        expectedVersion: expected?.version ?? 0,
      })
        .then(() => this.service.tickRun(run.id))
        .catch((error: unknown) => {
          this.store.updateRunStep(step.id, {
            workspaceState: "blocked",
            workspaceError:
              error instanceof Error ? error.message : "Workspace preparation failed.",
          });
          this.publish(run.id);
        });
    };
    if (!tree) {
      request("reserve");
      return undefined;
    }
    if (tree.state === "reserved" || tree.state === "creation_failed") {
      this.store.updateRunStep(step.id, { workspaceState: "creating" });
      request("create", tree);
      return undefined;
    }
    if (!["ready", "retained"].includes(tree.state) || tree.abandonedAt) {
      this.store.updateRunStep(step.id, {
        workspaceState: "blocked",
        workspaceError: tree.error || "The step workspace is unavailable.",
      });
      return undefined;
    }
    if (composition) {
      if (!tree.composition || tree.composition.state === "pending") {
        this.store.updateRunStep(step.id, { workspaceState: "composing" });
        request("compose", tree);
        return undefined;
      }
      if (tree.composition.state !== "ready") {
        this.store.updateRunStep(step.id, {
          workspaceState: "blocked",
          workspaceError:
            tree.composition.error || "Predecessor composition is not ready.",
        });
        return undefined;
      }
    }
    const binding = this.bindingForTree(tree);
    this.store.updateRunStep(step.id, {
      workspaceState: "ready",
      workspaceError: "",
      executionBinding: binding,
    });
    return binding;
  }

  finalizeStep(run: Run, step: RunStep): boolean {
    if (
      run.workspaceBinding?.effectiveMode !== "managed" ||
      !isWritingCategory(step.category)
    )
      return true;
    if (step.resultSha) return true;
    const tree = this.store.derivedWorkspaceForStep(run.id, step.id);
    if (!tree || this.pendingWorkspace(tree.id)) return false;
    this.store.updateRunStep(step.id, { workspaceState: "finalizing" });
    void this.requestWorkspace(run.id, tree.id, tree.generation, {
      kind: "finalize",
      actor: "dag-scheduler",
      operationId: this.deterministicUuid(`${tree.id}:finalize:${tree.version}`),
      workspaceKind: tree.workspaceKind,
      ownerStepId: step.id,
      expectedVersion: tree.version,
      ...(tree.composition ? { composition: tree.composition } : {}),
    })
      .then(() => this.service.tickRun(run.id))
      .catch((error: unknown) => {
        this.store.updateRunStep(step.id, {
          workspaceState: "blocked",
          workspaceError:
            error instanceof Error ? error.message : "Could not record a clean commit.",
        });
        this.publish(run.id);
      });
    return false;
  }

  async request(
    runId: string,
    input: Partial<WorktreeOperationRequest> &
      Pick<WorktreeOperationRequest, "kind" | "actor">,
    waitMs = 30_000,
  ): Promise<WorktreeOperation> {
    const binding = this.store.getRun(runId)?.workspaceBinding;
    if (!binding)
      throw new WorktreeConflict("not_managed", "This task has no workspace binding.");
    const resultKinds = new Set<WorktreeOperationRequest["kind"]>([
      "integration_preview",
      "integrate",
      "continue",
      "abort",
    ]);
    const resultTree = resultKinds.has(input.kind)
      ? this.resultWorkspaceForRun(runId)
      : undefined;
    return this.requestWorkspace(
      runId,
      resultTree?.id ?? binding.managedWorktreeId,
      resultTree?.generation ?? binding.generation,
      {
        ...input,
        ...(resultTree
          ? {
              workspaceKind: resultTree.workspaceKind,
              ownerStepId: resultTree.ownerStepId,
              expectedVersion: input.expectedVersion ?? resultTree.version,
              ...(resultTree.composition ? { composition: resultTree.composition } : {}),
            }
          : {}),
      },
      waitMs,
    );
  }

  private resultWorkspaceForRun(runId: string): ManagedWorktree | undefined {
    const steps = this.store.listRunSteps(runId);
    const writing = steps.filter((step) => isWritingCategory(step.category));
    if (
      writing.length === 0 ||
      writing.every((step) => !step.managedWorktreeId && !step.resultSha)
    )
      return undefined;
    const byKey = new Map(steps.map((step) => [step.stepKey, step]));
    const dependsOn = (
      step: RunStep,
      targetKey: string,
      seen = new Set<string>(),
    ): boolean =>
      step.dependsOn.some((key) => {
        if (key === targetKey) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        const dependency = byKey.get(key);
        return dependency ? dependsOn(dependency, targetKey, seen) : false;
      });
    const hasWritableDescendant = new Set(
      writing
        .filter((candidate) =>
          writing.some(
            (descendant) =>
              descendant.id !== candidate.id && dependsOn(descendant, candidate.stepKey),
          ),
        )
        .map((step) => step.id),
    );
    const sinks = writing
      .filter(
        (step) =>
          !hasWritableDescendant.has(step.id) &&
          step.state === "succeeded" &&
          Boolean(step.resultSha),
      )
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    if (sinks.length !== 1)
      throw new WorktreeConflict(
        "result_workspace_ambiguous",
        "Managed integration requires one committed writable DAG sink. Add an explicit fan-in step before integration.",
      );
    const result = this.store.derivedWorkspaceForStep(runId, sinks[0]!.id);
    if (!result || result.resultSha !== sinks[0]!.resultSha)
      throw new WorktreeConflict(
        "result_workspace_changed",
        "The final step workspace no longer matches its committed result SHA.",
      );
    return result;
  }

  private aggregationOperationId(run: Run, phase: string, worktreeId: string): string {
    const attempt = Math.max(1, run.workspaceBinding?.aggregationAttempt ?? 1);
    return this.deterministicUuid(
      `${run.id}:aggregation:${attempt}:${phase}:${worktreeId}`,
    );
  }

  private aggregationWorkspaces(runId: string): ManagedWorktree[] {
    return [...this.store.listManagedWorktrees(), ...this.store.listDerivedWorkspaces()]
      .filter((tree) => tree.runId === runId)
      .sort(
        (a, b) =>
          Number(a.workspaceKind !== "primary") - Number(b.workspaceKind !== "primary") ||
          a.id.localeCompare(b.id),
      );
  }

  private setAggregation(
    runId: string,
    patch: Partial<NonNullable<Run["workspaceBinding"]>>,
  ): void {
    const binding = this.store.getRun(runId)?.workspaceBinding;
    if (!binding) return;
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      ...patch,
      aggregationUpdatedAt: new Date().toISOString(),
    });
    this.publish(runId);
  }

  private aggregationSummary(code: string, phase: string): string {
    if (code === "integration_conflict")
      return "The automatic merge has conflicts. Resolve or abort it in Advanced recovery, then retry integration.";
    if (code === "target_ref_mismatch" || code === "target_unpinned")
      return "The selected source checkout is no longer on the task’s pinned branch.";
    if (code === "source_unavailable" || code === "target_node")
      return "The task’s pinned source checkout is no longer available on its owning Node.";
    if (code === "dirty_or_unknown")
      return "The task or integration target is dirty or its cleanliness cannot be proven.";
    if (code.includes("reconciliation") || code.includes("uncertain"))
      return "Workspace or integration ownership must be reconciled before automation can continue.";
    if (phase === "cleanup")
      return "Safe workspace cleanup could not complete. No files were force-removed.";
    return "Automatic integration stopped safely because its pinned target or reviewed result could not be revalidated.";
  }

  private escalateAggregation(
    runId: string,
    code: string,
    phase: string,
    targetRef: string,
  ): void {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding) return;
    this.setAggregation(runId, {
      aggregationState: "attention",
      aggregationPhase: phase as NonNullable<Run["workspaceBinding"]>["aggregationPhase"],
      aggregationCode: code,
      aggregationSummary: this.aggregationSummary(code, phase),
      aggregationTargetRef: targetRef,
    });
    if (run.state !== "blocked" && canTransitionRun(run.state, "blocked"))
      this.store.setRunState(runId, "blocked", this.aggregationSummary(code, phase));
    this.service.notifications.createWorktreeAttention(
      runId,
      `aggregation:${binding.generation}`,
      "integration",
      code,
      { phase, targetRef },
    );
    this.publish(runId);
  }

  private async automaticOperation(
    run: Run,
    tree: ManagedWorktree,
    phase: string,
    input: Partial<WorktreeOperationRequest> &
      Pick<WorktreeOperationRequest, "kind" | "actor">,
  ): Promise<WorktreeOperation | undefined> {
    const operationId = this.aggregationOperationId(run, phase, tree.id);
    const existing = this.store.getWorktreeOperation(operationId);
    const operation = existing
      ? existing.result
        ? existing
        : await this.send(existing, 30_000)
      : await this.requestWorkspace(run.id, tree.id, tree.generation, {
          ...input,
          operationId,
          expectedVersion: tree.version,
          workspaceKind: tree.workspaceKind,
          ownerStepId: tree.ownerStepId,
          ...(tree.composition ? { composition: tree.composition } : {}),
        });
    if (!operation.result) return undefined;
    if (
      !operation.result.ok &&
      operation.result.retryable &&
      ["quiesce", "cleanup"].includes(phase) &&
      !/(dirty|unknown|reconcil|mismatch|conflict)/i.test(operation.result.code)
    ) {
      const binding = this.store.getRun(run.id)?.workspaceBinding;
      if (binding)
        this.setAggregation(run.id, {
          aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
          aggregationSummary:
            "Waiting for task workspace processes to quiesce before safe cleanup.",
        });
      return undefined;
    }
    if (!operation.result.ok)
      throw new WorktreeConflict(
        operation.result.code || `${phase}_failed`,
        operation.result.error || `Automatic ${phase} failed.`,
      );
    return operation;
  }

  /**
   * Drives the post-orchestration integration transaction from durable receipts.
   * Every phase has a stable operation ID for the current retry attempt, so a
   * Host restart or Node reconnect replays rather than duplicates filesystem work.
   */
  advanceAggregation(runId: string): void {
    if (this.aggregating.has(runId)) return;
    const run = this.store.getRun(runId);
    if (
      !run ||
      run.state !== "aggregating" ||
      run.workspaceBinding?.effectiveMode !== "managed"
    )
      return;
    this.aggregating.add(runId);
    void this.runAggregation(runId).finally(() => this.aggregating.delete(runId));
  }

  beginAggregation(runId: string): Run {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding || binding.effectiveMode !== "managed")
      throw new WorktreeConflict(
        "not_managed",
        "Automatic integration is available only for managed tasks.",
      );
    if (run.state === "aggregating") {
      this.advanceAggregation(runId);
      return run;
    }
    if (!canTransitionRun(run.state, "aggregating"))
      throw new WorktreeConflict(
        "integration_not_ready",
        "This task cannot begin automatic integration from its current state.",
      );
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: Math.max(1, binding.aggregationAttempt),
      aggregationCode: "",
      aggregationSummary: "",
      aggregationTargetRef: binding.baseRef,
      aggregationUpdatedAt: new Date().toISOString(),
    });
    this.store.setRunState(runId, "aggregating", "");
    this.publish(runId);
    this.advanceAggregation(runId);
    return this.store.getRun(runId)!;
  }

  retryAggregation(runId: string): void {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (
      !run ||
      !binding ||
      binding.effectiveMode !== "managed" ||
      binding.aggregationState !== "attention"
    )
      throw new WorktreeConflict(
        "retry_not_available",
        "Retry integration is available only when automatic integration needs attention.",
      );
    if (!canTransitionRun(run.state, "aggregating"))
      throw new WorktreeConflict(
        "retry_not_available",
        "This task cannot resume automatic integration from its current state.",
      );
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
      aggregationCode: "",
      aggregationSummary: "",
      aggregationUpdatedAt: new Date().toISOString(),
    });
    this.store.setRunState(runId, "aggregating", "");
    this.publish(runId);
    this.advanceAggregation(runId);
  }

  private async runAggregation(runId: string): Promise<void> {
    let run = this.store.getRun(runId);
    let binding = run?.workspaceBinding;
    if (!run || !binding || run.state !== "aggregating") return;
    const targetRef = binding.baseRef;
    let phase =
      binding.aggregationPhase === "idle" ? "preview" : binding.aggregationPhase;
    try {
      const source = binding.sourcePlacementId
        ? this.store.getPlacement(binding.sourcePlacementId)
        : undefined;
      const primary = this.store.worktreeForRun(runId);
      if (!source || !primary)
        throw new WorktreeConflict(
          "source_unavailable",
          "The pinned source placement or primary workspace is unavailable.",
        );
      if (source.nodeId !== primary.nodeId)
        throw new WorktreeConflict(
          "target_node",
          "The pinned source placement moved away from the owning Node.",
        );
      if (!targetRef || !targetRef.startsWith("refs/heads/"))
        throw new WorktreeConflict(
          "target_unpinned",
          "Automatic integration requires the pinned symbolic base branch.",
        );

      const resultTree = this.resultWorkspaceForRun(runId) ?? primary;
      let integration = this.store
        .listWorktreeIntegrations(resultTree.id)
        .filter(
          (entry) =>
            entry.preview.targetPlacementId === source.id &&
            entry.preview.targetRef === targetRef,
        )
        .at(-1);

      phase = "preview";
      this.setAggregation(runId, {
        aggregationState: "in_progress",
        aggregationPhase: "preview",
        aggregationTargetRef: targetRef,
        aggregationCode: "",
        aggregationSummary: "",
      });
      const previewOperation = await this.automaticOperation(run, resultTree, "preview", {
        kind: "integration_preview",
        actor: "host-integration-controller",
        targetPlacementId: source.id,
      });
      if (!previewOperation) return;
      const preview = previewOperation.result?.preview;
      if (!preview)
        throw new WorktreeConflict(
          "preview_missing",
          "The Node returned no integration preview.",
        );
      if (
        preview.targetPlacementId !== binding.sourcePlacementId ||
        preview.targetRef !== targetRef
      )
        throw new WorktreeConflict(
          "target_ref_mismatch",
          "The preview target does not match the pinned source branch.",
        );
      const reusableIntegration =
        integration &&
        ["integrated", "no_changes"].includes(integration.state) &&
        integration.approvedTaskSha === preview.taskSha &&
        integration.approvedDiffIdentity === preview.diffIdentity &&
        (integration.state === "no_changes" || preview.alreadyIntegrated);
      if (!reusableIntegration) {
        integration = undefined;
        phase = "integrate";
        this.setAggregation(runId, { aggregationPhase: "integrate" });
        run = this.store.getRun(runId)!;
        const integrateOperation = await this.automaticOperation(
          run,
          this.store.getAnyManagedWorkspace(resultTree.id)!,
          "integrate",
          {
            kind: "integrate",
            actor: "host-integration-controller",
            targetPlacementId: source.id,
            previewId: preview.id,
            reviewedTaskSha: preview.taskSha,
            reviewedDiffIdentity: preview.diffIdentity,
            confirm: preview.hasCommittedChanges
              ? `MERGE ${preview.taskSha} INTO ${preview.targetRef}`
              : `REVIEW NO CHANGES FOR ${preview.taskSha}`,
            commit: true,
          },
        );
        if (!integrateOperation) return;
        integration = integrateOperation.result?.integration;
      }

      if (!integration)
        throw new WorktreeConflict(
          "integration_missing",
          "The Node returned no integration result.",
        );
      if (integration.preview.targetRef !== targetRef)
        throw new WorktreeConflict(
          "target_ref_mismatch",
          "The integration target no longer matches the pinned branch.",
        );
      if (integration.state === "conflicted")
        throw new WorktreeConflict(
          "integration_conflict",
          "The automatic merge has conflicts.",
        );
      if (!["integrated", "no_changes"].includes(integration.state))
        throw new WorktreeConflict(
          integration.state === "needs_reconciliation"
            ? "integration_needs_reconciliation"
            : "integration_incomplete",
          "The automatic merge did not reach a validated terminal state.",
        );

      const workspaces = this.aggregationWorkspaces(runId);
      phase = "quiesce";
      this.setAggregation(runId, { aggregationPhase: "quiesce" });
      const ownedIds = new Set(workspaces.map((tree) => tree.id));
      const ownedSessions = this.store
        .listSessions()
        .filter(
          (session) =>
            session.runId === runId &&
            Boolean(
              session.executionBinding?.worktreeId &&
              ownedIds.has(session.executionBinding.worktreeId),
            ),
        );
      stopSessions(this.service, ownedSessions);
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id)!;
        if (fresh.state === "removed") continue;
        const operation = await this.automaticOperation(run, fresh, "quiesce", {
          kind: "quiesce",
          actor: "host-integration-controller",
        });
        if (!operation) return;
      }
      if (
        ownedSessions.some((session) => {
          const fresh = this.store.getSession(session.id);
          return (
            fresh && (!terminalSessionStates.has(fresh.state) || fresh.stopRequested)
          );
        })
      )
        return;

      phase = "retain";
      this.setAggregation(runId, { aggregationPhase: "retain" });
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id)!;
        if (fresh.state === "removed" || fresh.state === "retained") continue;
        const operation = await this.automaticOperation(run, fresh, "retain", {
          kind: "retain",
          actor: "host-integration-controller",
        });
        if (!operation) return;
      }

      phase = "cleanup";
      this.setAggregation(runId, { aggregationPhase: "cleanup" });
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id)!;
        if (fresh.state === "removed") continue;
        const operation = await this.automaticOperation(run, fresh, "cleanup", {
          kind: "cleanup",
          actor: "host-integration-controller",
          deleteBranch: false,
        });
        if (!operation) return;
      }

      binding = this.store.getRun(runId)!.workspaceBinding!;
      this.store.setRunWorkspaceBinding(runId, {
        ...binding,
        aggregationState: "completed",
        aggregationPhase: "done",
        aggregationCode: "",
        aggregationSummary:
          integration.state === "no_changes"
            ? `No committed changes; verified ${targetRef.replace(/^refs\/heads\//, "")} and cleaned isolated workspaces.`
            : `Integrated into ${targetRef.replace(/^refs\/heads\//, "")} and cleaned isolated workspaces.`,
        aggregationTargetRef: targetRef,
        aggregationUpdatedAt: new Date().toISOString(),
      });
      this.service.notifications.resolveWorktreeAttention(
        runId,
        `aggregation:${binding.generation}`,
        "integration",
      );
      for (const entry of this.store.listWorktreeIntegrations()) {
        if (entry.worktreeId === integration.worktreeId) {
          this.service.notifications.resolveWorktreeAttention(
            runId,
            entry.id,
            "conflict",
          );
          this.service.notifications.resolveWorktreeAttention(
            runId,
            entry.id,
            "reconciliation",
          );
        }
      }
      const completed = this.store.getRun(runId)!;
      if (canTransitionRun(completed.state, "completed"))
        this.store.setRunState(runId, "completed", "");
      this.publish(runId);
    } catch (error) {
      const code = error instanceof WorktreeConflict ? error.code : "integration_failed";
      this.escalateAggregation(runId, code, phase, targetRef);
    }
  }

  private async requestWorkspace(
    runId: string,
    worktreeId: string,
    generation: number,
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
    const tree = this.store.getAnyManagedWorkspace(worktreeId);
    const suppliedId = input.operationId ?? randomUUID();
    const existing = this.store.getWorktreeOperation(suppliedId);
    const request = WorktreeOperationRequestSchema.parse({
      ...input,
      operationId: suppliedId,
      worktreeId,
      runId,
      sourcePlacementId: placement.id,
      workspaceId: run.workspaceId,
      sourcePath: placement.localPath,
      nodeId: node.id,
      hostInstallationId: this.store.worktreeHostInstallationId(),
      expectedVersion: input.expectedVersion ?? tree?.version ?? 0,
      generation,
      expectedPath: tree?.path ?? "",
      expectedBranchRef: tree?.branchRef ?? "",
      expectedBaseSha: binding.baseSha,
      allowGitHooks: input.allowGitHooks ?? binding.allowGitHooks,
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
    const pending = this.pendingWorkspace(worktreeId);
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
      .update(
        expected.workspaceKind === "primary"
          ? `${expected.hostInstallationId}:${expected.runId}:${expected.generation}`
          : `${expected.hostInstallationId}:${expected.runId}:${expected.workspaceKind}:${expected.ownerStepId}:${expected.generation}`,
      )
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
        tree.workspaceKind !== expected.workspaceKind ||
        tree.ownerStepId !== expected.ownerStepId ||
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
    const setupOperation =
      expected.workspaceKind === "primary" &&
      ["reserve", "create"].includes(expected.kind);
    const setupReady = Boolean(
      result.ok &&
      tree &&
      ["ready", "retained"].includes(tree.state) &&
      !tree.abandonedAt,
    );
    this.store.writeAtomically(() => {
      if (tree) {
        if (tree.workspaceKind === "primary") this.store.putManagedWorktree(tree);
        else this.store.putDerivedWorkspace(tree);
      }
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
      if (binding && expected.workspaceKind === "primary") {
        const available =
          tree && ["ready", "retained"].includes(tree.state) && !tree.abandonedAt;
        this.store.setRunWorkspaceBinding(expected.runId, {
          ...binding,
          ...(tree
            ? {
                baseSha: tree.baseSha,
                baseRef: tree.baseRef,
                checkoutKey: tree.checkout?.key ?? binding.checkoutKey,
                resolvedPath: tree.path,
                allowGitHooks: tree.allowGitHooks,
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
          ...(setupOperation && result.ok && expected.kind === "reserve"
            ? {
                setupState: "running" as const,
                setupCode: "",
                setupSummary: "",
                setupStartedAt: binding.setupStartedAt || new Date().toISOString(),
                setupCompletedAt: "",
              }
            : {}),
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
      if (expected.ownerStepId) {
        const step = this.store.getRunStep(expected.ownerStepId);
        if (step?.runId === expected.runId) {
          const blocked =
            !result.ok ||
            tree?.composition?.state === "conflicted" ||
            tree?.composition?.state === "blocked";
          this.store.updateRunStep(step.id, {
            ...(tree?.checkout
              ? {
                  executionBinding: this.bindingForTree(
                    tree,
                    step.executionBinding?.leaseAttempt,
                  ),
                }
              : {}),
            workspaceState: blocked
              ? "blocked"
              : expected.kind === "reserve"
                ? "reserved"
                : expected.kind === "create"
                  ? tree?.composition
                    ? "composing"
                    : "ready"
                  : expected.kind === "compose"
                    ? tree?.composition?.state === "ready"
                      ? "ready"
                      : "blocked"
                    : expected.kind === "finalize" && tree?.resultSha
                      ? "completed"
                      : step.workspaceState,
            workspaceError: result.error || tree?.composition?.error || tree?.error || "",
            ...(expected.kind === "finalize" && tree?.resultSha
              ? { resultSha: tree.resultSha }
              : {}),
          });
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
    if (setupOperation && !result.ok) {
      this.markSetupFailed(
        expected.runId,
        result.code || "workspace_setup_failed",
        result.error || "Managed workspace preparation failed.",
      );
    } else if (setupOperation && expected.kind === "reserve" && result.ok) {
      const reservedRun = this.store.getRun(expected.runId);
      const reservedBinding = reservedRun?.workspaceBinding;
      if (
        reservedRun?.state === "blocked" &&
        reservedBinding &&
        canTransitionRun("blocked", reservedBinding.setupResumeState)
      ) {
        this.store.setRunState(expected.runId, reservedBinding.setupResumeState);
      }
      this.publish(expected.runId);
    } else if (setupOperation && setupReady) {
      this.markSetupReady(expected.runId);
      this.publish(expected.runId);
    } else if (
      result.integration?.state === "conflicted" &&
      expected.actor !== "host-integration-controller"
    ) {
      this.publish(expected.runId);
      this.service.notifications.createWorktreeAttention(
        expected.runId,
        result.integration.id,
        "conflict",
      );
    } else if (
      expected.actor !== "host-integration-controller" &&
      (tree?.state === "needs_reconciliation" ||
        tree?.integrationState === "needs_reconciliation" ||
        result.integration?.state === "needs_reconciliation")
    ) {
      this.publish(expected.runId);
      this.service.notifications.createWorktreeAttention(
        expected.runId,
        result.integration?.id ?? `generation:${expected.generation}`,
        "reconciliation",
      );
    } else {
      this.publish(expected.runId);
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
    for (const tree of [
      ...this.store.listManagedWorktrees(),
      ...this.store.listDerivedWorkspaces(),
    ]
      .filter(
        (entry) =>
          entry.nodeId === nodeId &&
          entry.state === "unavailable" &&
          this.store.getRun(entry.runId)?.workspaceBinding?.initialization !==
            "quarantined" &&
          !this.pending(entry.runId),
      )
      .slice(0, 2)) {
      void (
        tree.workspaceKind === "primary"
          ? this.request(tree.runId, {
              kind: "reconcile",
              actor: "node-reconnect",
            })
          : this.requestWorkspace(tree.runId, tree.id, tree.generation, {
              kind: "reconcile",
              actor: "node-reconnect",
              workspaceKind: tree.workspaceKind,
              ownerStepId: tree.ownerStepId,
              expectedVersion: tree.version,
              ...(tree.composition ? { composition: tree.composition } : {}),
            })
      ).catch(() => undefined);
    }
    this.lastSweep = 0;
    this.sweep();
  }

  sweep(nowMs = Date.now()): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    let count = 0;
    for (const tree of [
      ...this.store.listManagedWorktrees(),
      ...this.store.listDerivedWorkspaces(),
    ]) {
      if (count >= 2) break;
      const run = this.store.getRun(tree.runId);
      if (
        !run ||
        !terminalRunStates.has(run.state) ||
        tree.abandonedAt ||
        !this.store.getNode(tree.nodeId)?.online ||
        this.pendingWorkspace(tree.id) ||
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
              (tree.workspaceKind !== "primary" ||
                ["integrated", "no_changes"].includes(tree.integrationState)) &&
              tree.observation?.dirty === false &&
              tree.expiresAt &&
              Date.parse(tree.expiresAt) <= nowMs
            ? "cleanup"
            : undefined;
      if (!kind) continue;
      count += 1;
      void (
        tree.workspaceKind === "primary"
          ? this.request(run.id, { kind, actor: "bounded-retention" })
          : this.requestWorkspace(run.id, tree.id, tree.generation, {
              kind,
              actor: "bounded-retention",
              workspaceKind: tree.workspaceKind,
              ownerStepId: tree.ownerStepId,
              expectedVersion: tree.version,
              ...(tree.composition ? { composition: tree.composition } : {}),
            })
      ).catch(() => undefined);
    }
  }

  nodeLost(nodeId: string): void {
    for (const tree of [
      ...this.store.listManagedWorktrees(),
      ...this.store.listDerivedWorkspaces(),
    ].filter(
      (entry) =>
        entry.nodeId === nodeId && !["removed", "quarantined"].includes(entry.state),
    )) {
      const unavailable = {
        ...tree,
        state: "unavailable",
        error: "Node unavailable: process and filesystem state are unknown.",
        ...(tree.observation
          ? { observation: { ...tree.observation, dirty: null, locked: null } }
          : {}),
      } as ManagedWorktree;
      if (tree.workspaceKind === "primary") this.store.putManagedWorktree(unavailable);
      else this.store.putDerivedWorkspace(unavailable);
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
    return this.bindingForTree(tree, attempt);
  }

  private bindingForTree(
    tree: ManagedWorktree,
    attempt: string = randomUUID(),
  ): ExecutionBinding {
    if (!tree.checkout)
      throw new WorktreeConflict(
        "workspace_not_ready",
        "The managed workspace has no verified checkout identity.",
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
    if (this.pendingWorkspace(binding.worktreeId))
      throw new WorktreeConflict(
        "workspace_admin_pending",
        "A durable worktree operation is in progress. Wait for its Node acknowledgement.",
      );
    const tree = this.store.getAnyManagedWorkspace(binding.worktreeId);
    const step = this.store.getRunStepBySession(session.id);
    if (
      !tree ||
      tree.runId !== run.id ||
      (tree.workspaceKind !== "primary" && tree.ownerStepId !== step?.id)
    )
      throw new WorktreeConflict(
        "binding_mismatch",
        "The session is not bound to its step's durable managed workspace.",
      );
    const expected = this.bindingForTree(tree, binding.leaseAttempt);
    if (JSON.stringify({ ...binding, quarantined: false }) !== JSON.stringify(expected)) {
      throw new WorktreeConflict(
        "binding_mismatch",
        "The session's immutable checkout binding does not match its task.",
      );
    }
    if (
      tree.nodeId !== session.nodeId ||
      !this.store
        .getNode(session.nodeId)
        ?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY) ||
      [
        "integrating",
        "validating",
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
