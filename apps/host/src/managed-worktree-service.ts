import { createHash, randomUUID } from "node:crypto";
import {
  MANAGED_WORKTREES_CAPABILITY,
  PORTABLE_WORKTREE_RESULTS_CAPABILITY,
  WorktreeConflict,
  WorktreeOperationRequestSchema,
  canTransitionRun,
  isWritingCategory,
  terminalRunStepStates,
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
  type ArtifactDownloadRequest,
  type ArtifactUploadBegin,
  type ArtifactUploadChunk,
  type ArtifactUploadComplete,
  type RepositoryProbeResult,
} from "@fleet/protocol";
import type { FleetService } from "./fleet-service.js";
import { stopSessions } from "./orchestrator/lifecycle.js";
import { owedPrompt } from "./orchestrator/briefing.js";
import { sendBackPrompt } from "./orchestrator/review.js";
import { WorkspaceArtifactStore } from "./workspace-artifact-store.js";

export class ManagedWorktreeService {
  private static readonly ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
  private static readonly REPOSITORY_OBSERVATION_MAX_AGE_MS = 5 * 60_000;
  private static readonly REPOSITORY_PROBE_WINDOW_MS = 3_000;
  private static readonly MAX_AUTOMATIC_QUIESCE_ATTEMPTS = 3;
  private static readonly AUTOMATIC_RECOVERY_DELAYS_MS = [1_000, 3_000, 10_000];
  private readonly waiters = new Map<
    string,
    { resolve: (operation: WorktreeOperation) => void; timer: NodeJS.Timeout }
  >();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly aggregating = new Set<string>();
  private readonly placementProbeStartedAt = new Map<string, number>();
  private readonly placementProbeCooldownUntil = new Map<string, number>();
  private readonly placementProbeTimers = new Map<string, NodeJS.Timeout>();
  private readonly aggregationRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly placementProbeFailures = new Map<string, string>();
  private readonly workspacePlacementStartedAt = new Map<string, number>();
  private lastSweep = 0;
  private readonly artifacts: WorkspaceArtifactStore;

  private deterministicUuid(value: string): string {
    const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  }

  constructor(private readonly service: FleetService) {
    this.artifacts = new WorkspaceArtifactStore(service.store);
  }
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
        originatingPlacementId: binding.originatingPlacementId || source.id,
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

  private dependencyKeysFor(step: RunStep, all: RunStep[]): string[] {
    if (step.dependsOn.length > 0) return step.dependsOn;
    return all
      .filter(
        (entry) => entry.phaseIndex < step.phaseIndex && entry.state === "succeeded",
      )
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((entry) => entry.stepKey);
  }

  private compositionFor(run: Run, step: RunStep): WorktreeComposition | undefined {
    const all = this.store.listRunSteps(run.id);
    const byKey = new Map(all.map((entry) => [entry.stepKey, entry]));
    const dependencyKeys = this.dependencyKeysFor(step, all);
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
    for (const key of dependencyKeys) visit(key);
    const predecessors = [...collected.values()].sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
    const dependsOn = (
      candidate: RunStep,
      targetKey: string,
      seen = new Set<string>(),
    ): boolean =>
      candidate.dependsOn.some((key) => {
        if (key === targetKey) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        const dependency = byKey.get(key);
        return dependency ? dependsOn(dependency, targetKey, seen) : false;
      });
    const frontier = predecessors.filter(
      (candidate) =>
        !predecessors.some(
          (other) => other.id !== candidate.id && dependsOn(other, candidate.stepKey),
        ),
    );
    const coveredPredecessorStepIds = predecessors
      .filter((candidate) => !frontier.some((entry) => entry.id === candidate.id))
      .map((entry) => entry.id);
    if (predecessors.length === 0) {
      const directReadOnlyPredecessors = dependencyKeys
        .map((key) => byKey.get(key))
        .filter((entry): entry is RunStep =>
          Boolean(
            entry && entry.state === "succeeded" && !isWritingCategory(entry.category),
          ),
        )
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      const primary = this.store.worktreeForRun(run.id);
      const observedHead = primary?.observation?.head;
      if (
        directReadOnlyPredecessors.length > 0 &&
        directReadOnlyPredecessors.length === dependencyKeys.length &&
        primary &&
        observedHead &&
        observedHead !== run.workspaceBinding!.baseSha &&
        primary.observation?.dirty === false
      ) {
        const predecessor = directReadOnlyPredecessors.at(-1)!;
        return {
          baseSha: run.workspaceBinding!.baseSha,
          baseRef: run.workspaceBinding!.baseRef,
          dependencyResolution: step.dependsOn.length > 0 ? "explicit" : "phase_fallback",
          implicitDependencyFallback: step.dependsOn.length === 0,
          predecessors: [
            {
              stepId: predecessor.id,
              stepKey: predecessor.stepKey,
              position: predecessor.position,
              worktreeId: primary.id,
              resultSha: observedHead,
            },
          ],
          coveredPredecessorStepIds: [],
          state: "pending",
          resultSha: "",
          conflicts: [],
          error: "",
          startedAt: "",
          completedAt: "",
        };
      }
      return undefined;
    }
    const results = new Map(
      predecessors.map((entry) => [
        entry.id,
        this.store.workspaceResultForStep(run.id, entry.id),
      ]),
    );
    if (
      frontier.some(
        (entry) =>
          entry.state !== "succeeded" || !entry.resultSha || !entry.managedWorktreeId,
      )
    )
      return undefined;
    return {
      baseSha: run.workspaceBinding!.baseSha,
      baseRef: run.workspaceBinding!.baseRef,
      dependencyResolution: step.dependsOn.length > 0 ? "explicit" : "phase_fallback",
      implicitDependencyFallback: step.dependsOn.length === 0,
      predecessors: frontier.map((entry) => ({
        stepId: entry.id,
        stepKey: entry.stepKey,
        position: entry.position,
        worktreeId: entry.managedWorktreeId!,
        resultSha: entry.resultSha!,
        workspaceResultId:
          results.get(entry.id)?.state === "available"
            ? results.get(entry.id)!.id
            : undefined,
      })),
      coveredPredecessorStepIds,
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
    const dependencyKeys = this.dependencyKeysFor(step, all);
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
    const dependsOnWritableHistory = dependencyKeys.some((key) =>
      hasWritableHistory(key),
    );
    if (dependsOnWritableHistory && !composition) return undefined;
    if (this.waitingForPlacementProbes(run, step)) return undefined;
    const worktreeId = step.managedWorktreeId || this.workspaceId(run.id, step.id);
    const executionPlacement = this.executionPlacement(run, step);
    if (!executionPlacement) return undefined;
    if (!step.managedWorktreeId) {
      this.store.updateRunStep(step.id, {
        managedWorktreeId: worktreeId,
        placementId: executionPlacement.id,
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
        `${worktreeId}:${kind}:${expected?.version ?? 0}:${step.attempts}`,
      );
      void this.requestWorkspace(run.id, worktreeId, 1, {
        kind,
        actor: "dag-scheduler",
        operationId,
        workspaceKind: composition ? "derived" : "step",
        ownerStepId: step.id,
        ...(composition ? { composition } : {}),
        sourcePlacementId: executionPlacement.id,
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
    const placementStartedAt = this.workspacePlacementStartedAt.get(tree.id);
    if (placementStartedAt !== undefined) {
      this.service.logManagedPlacementScheduling(
        {
          event: "managed_workspace_ready",
          run_id: run.id,
          step_id: step.id,
          worktree_id: tree.id,
          selected_node_id: tree.nodeId,
          selected_placement_id: tree.executionPlacementId,
          actual_workspace_ready_ms: Date.now() - placementStartedAt,
        },
        "Managed workspace became ready",
      );
      this.workspacePlacementStartedAt.delete(tree.id);
    }
    this.store.updateRunStep(step.id, {
      workspaceState: "ready",
      workspaceError: "",
      executionBinding: binding,
    });
    return binding;
  }

  private placementCapability(run: Run, placementId: string) {
    const binding = run.workspaceBinding!;
    return this.store.getPlacementRepositoryCapability(
      placementId,
      binding.repositoryIdentity,
      binding.baseSha,
    );
  }

  private freshPlacementObservation(run: Run, placementId: string) {
    const capability = this.placementCapability(run, placementId);
    return capability &&
      Date.now() - Date.parse(capability.verifiedAt) <=
        ManagedWorktreeService.REPOSITORY_OBSERVATION_MAX_AGE_MS
      ? capability
      : undefined;
  }

  private placementProbeKey(run: Run, placementId: string): string {
    return `${run.id}:${placementId}:${run.workspaceBinding!.baseSha}`;
  }

  private waitingForPlacementProbes(run: Run, step: RunStep): boolean {
    if (step.sessionId || step.executionBinding) return false;
    const binding = run.workspaceBinding!;
    const alternatives = this.store.listPlacements().filter((placement) => {
      const node = this.store.getNode(placement.nodeId);
      return (
        placement.workspaceId === run.workspaceId &&
        placement.id !== binding.originatingPlacementId &&
        node?.online &&
        node.capabilities.includes(MANAGED_WORKTREES_CAPABILITY) &&
        node.capabilities.includes(PORTABLE_WORKTREE_RESULTS_CAPABILITY)
      );
    });
    if (!alternatives.length) return false;
    const key = `${run.id}:${step.id}:${step.attempts}`;
    const now = Date.now();
    const cooldownUntil = this.placementProbeCooldownUntil.get(key) ?? 0;
    if (cooldownUntil > now) return false;
    this.placementProbeCooldownUntil.delete(key);
    const allProven = alternatives.every((placement) =>
      Boolean(this.freshPlacementObservation(run, placement.id)),
    );
    if (allProven) {
      this.placementProbeCooldownUntil.set(
        key,
        now + ManagedWorktreeService.REPOSITORY_OBSERVATION_MAX_AGE_MS,
      );
      const startedAt = this.placementProbeStartedAt.get(key);
      this.service.logManagedPlacementScheduling(
        {
          event: "repository_probe_decision",
          run_id: run.id,
          step_id: step.id,
          candidate_count_known: alternatives.length + 1,
          candidate_count_pending: 0,
          candidate_count_failed: alternatives.filter((placement) =>
            this.placementProbeFailures.has(this.placementProbeKey(run, placement.id)),
          ).length,
          probe_wait_ms: startedAt === undefined ? 0 : now - startedAt,
          schedule_reason: "all_eligible_probes_resolved",
        },
        "Repository placement probes resolved before scheduling",
      );
      this.placementProbeStartedAt.delete(key);
      const timer = this.placementProbeTimers.get(key);
      if (timer) clearTimeout(timer);
      this.placementProbeTimers.delete(key);
      return false;
    }
    if (!this.placementProbeStartedAt.has(key)) {
      this.placementProbeStartedAt.set(key, now);
      this.probeRunPlacements(run.id);
      const timer = setTimeout(() => {
        const finishedAt = Date.now();
        const startedAt = this.placementProbeStartedAt.get(key) ?? finishedAt;
        const known = alternatives.filter((placement) =>
          Boolean(this.freshPlacementObservation(run, placement.id)),
        ).length;
        const failed = alternatives.filter((placement) =>
          this.placementProbeFailures.has(this.placementProbeKey(run, placement.id)),
        ).length;
        this.service.logManagedPlacementScheduling(
          {
            event: "repository_probe_decision",
            run_id: run.id,
            step_id: step.id,
            candidate_count_known: known + 1,
            candidate_count_pending: alternatives.length - known - failed,
            candidate_count_failed: failed,
            probe_wait_ms: finishedAt - startedAt,
            schedule_reason: "probe_decision_deadline",
          },
          "Repository placement probe deadline reached",
        );
        this.placementProbeStartedAt.delete(key);
        this.placementProbeTimers.delete(key);
        this.placementProbeCooldownUntil.set(
          key,
          finishedAt + ManagedWorktreeService.REPOSITORY_OBSERVATION_MAX_AGE_MS,
        );
        this.service.tickRun(run.id);
      }, ManagedWorktreeService.REPOSITORY_PROBE_WINDOW_MS);
      timer.unref();
      this.placementProbeTimers.set(key, timer);
    }
    return true;
  }

  private executionPlacement(run: Run, step: RunStep) {
    const binding = run.workspaceBinding!;
    const primary = this.store.worktreeForRun(run.id);
    const composition = this.compositionFor(run, step);
    const activeCost = (nodeId: string) =>
      this.store
        .listSessions()
        .filter(
          (session) =>
            session.nodeId === nodeId && !terminalSessionStates.has(session.state),
        ).length *
        60_000 +
      this.store
        .listRunSteps(run.id)
        .filter(
          (candidate) =>
            candidate.id !== step.id &&
            candidate.placementId &&
            this.store.getPlacement(candidate.placementId)?.nodeId === nodeId &&
            !terminalRunStepStates.has(candidate.state),
        ).length *
        60_000;
    const transferCost = (nodeId: string) =>
      (composition?.predecessors ?? []).reduce((total, predecessor) => {
        const owner = this.store.getAnyManagedWorkspace(predecessor.worktreeId)?.nodeId;
        if (!owner || owner === nodeId) return total;
        const result = predecessor.workspaceResultId
          ? this.store.getWorkspaceResult(predecessor.workspaceResultId)
          : undefined;
        return total + 1_000 + Math.ceil((result?.artifactSize ?? 0) / 20_000);
      }, 0);
    let candidates = this.store
      .listPlacements()
      .filter((placement) => {
        const node = this.store.getNode(placement.nodeId);
        if (
          placement.workspaceId !== run.workspaceId ||
          !node?.online ||
          !node.capabilities.includes(MANAGED_WORKTREES_CAPABILITY)
        )
          return false;
        if (
          placement.id === (binding.originatingPlacementId || binding.sourcePlacementId)
        )
          return primary?.repositoryIdentity === binding.repositoryIdentity;
        const capability = this.freshPlacementObservation(run, placement.id);
        return Boolean(
          node.capabilities.includes(PORTABLE_WORKTREE_RESULTS_CAPABILITY) &&
          (capability?.baseAvailable || capability?.baseMaterializable) &&
          capability.portableResultsSupported &&
          capability.nodeId === placement.nodeId &&
          capability.localPath === placement.localPath &&
          capability.baseSha === binding.baseSha &&
          capability.repositoryIdentity.id === binding.repositoryIdentity &&
          capability.repositoryIdentity.objectFormat === binding.repositoryObjectFormat,
        );
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const score = (placement: (typeof candidates)[number]) => {
      const active = activeCost(placement.nodeId);
      const base =
        placement.id === binding.originatingPlacementId ||
        this.freshPlacementObservation(run, placement.id)?.baseAvailable
          ? 0
          : 30_000;
      const transfer = transferCost(placement.nodeId);
      return {
        placement,
        active_cost_ms: active,
        base_cost_ms: base,
        transfer_cost_ms: transfer,
        predicted_total_ms: active + base + transfer,
      };
    };
    if (composition?.predecessors.some((entry) => !entry.workspaceResultId)) {
      const owners = new Set(
        composition.predecessors.map(
          (entry) => this.store.getAnyManagedWorkspace(entry.worktreeId)?.nodeId,
        ),
      );
      if (owners.size !== 1 || owners.has(undefined)) return undefined;
      candidates = candidates.filter((entry) => owners.has(entry.nodeId));
    }
    const ranked = candidates
      .map(score)
      .sort(
        (a, b) =>
          a.predicted_total_ms - b.predicted_total_ms ||
          Number(b.placement.id === binding.originatingPlacementId) -
            Number(a.placement.id === binding.originatingPlacementId) ||
          a.placement.id.localeCompare(b.placement.id),
      );
    const selected =
      step.sessionId && step.placementId
        ? ranked.find((entry) => entry.placement.id === step.placementId)
        : ranked[0];
    if (step.sessionId && step.placementId) {
      if (selected) return selected.placement;
      return undefined;
    }
    const choice = selected ?? ranked[0];
    if (choice && !step.managedWorktreeId) {
      const worktreeId = this.workspaceId(run.id, step.id);
      this.workspacePlacementStartedAt.set(worktreeId, Date.now());
      this.service.logManagedPlacementScheduling(
        {
          event: "managed_placement_selected",
          run_id: run.id,
          step_id: step.id,
          selected_node_id: choice.placement.nodeId,
          selected_placement_id: choice.placement.id,
          originating_placement_id: binding.originatingPlacementId,
          schedule_reason:
            choice.placement.id === binding.originatingPlacementId
              ? "lowest_cost_with_locality_tiebreak"
              : "lower_estimated_completion_cost",
          candidates: ranked.map((entry) => ({
            node_id: entry.placement.nodeId,
            placement_id: entry.placement.id,
            active_cost_ms: entry.active_cost_ms,
            base_cost_ms: entry.base_cost_ms,
            transfer_cost_ms: entry.transfer_cost_ms,
            predicted_total_ms: entry.predicted_total_ms,
          })),
        },
        "Selected managed repository placement",
      );
    }
    return choice?.placement;
  }

  finalizeStep(run: Run, step: RunStep): boolean {
    this.store.commands.assertTaskUnfenced(run.id);
    if (
      run.workspaceBinding?.effectiveMode !== "managed" ||
      !isWritingCategory(step.category)
    )
      return true;
    if (step.resultSha) return true;
    const tree = this.store.derivedWorkspaceForStep(run.id, step.id);
    if (!tree) return false;
    const pending = this.pendingWorkspace(tree.id);
    if (pending && pending.request.kind !== "finalize") return false;
    this.store.updateRunStep(step.id, { workspaceState: "finalizing" });
    const fail = (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string" && error
            ? error
            : "Could not record a clean commit.";
      this.store.updateRunStep(step.id, {
        workspaceState: "blocked",
        workspaceError: message,
      });
      this.service.settleOrchestrationStep({
        runId: run.id,
        stepId: step.id,
        state: "failed",
        output: `Managed workspace finalization failed: ${message}`,
      });
      this.publish(run.id);
    };
    void this.requestWorkspace(
      run.id,
      tree.id,
      tree.generation,
      pending?.request ?? {
        kind: "finalize",
        actor: "dag-scheduler",
        operationId: this.deterministicUuid(
          `${tree.id}:finalize:${tree.version}:${step.attempts}`,
        ),
        workspaceKind: tree.workspaceKind,
        ownerStepId: step.id,
        expectedVersion: tree.version,
        ...(tree.composition ? { composition: tree.composition } : {}),
      },
    )
      .then((operation) => {
        if (!operation.result) return;
        if (operation.result && !operation.result.ok) {
          if (
            operation.result.retryable &&
            operation.result.code === "artifact_transport_failed" &&
            this.store
              .listWorktreeOperations(tree.id)
              .filter(
                (entry) =>
                  entry.request.kind === "finalize" &&
                  entry.result?.code === "artifact_transport_failed",
              ).length < 3
          ) {
            this.store.updateRunStep(step.id, {
              workspaceState: "finalizing",
              workspaceError:
                "The result is sealed; retrying artifact transport without rerunning the agent.",
            });
            this.service.tickRun(run.id);
            return;
          }
          fail(operation.result.error || "Could not record a clean commit.");
          return;
        }
        this.service.tickRun(run.id);
      })
      .catch(fail);
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
      "publish",
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
    const synthetic = this.store
      .listDerivedWorkspaces(runId)
      .filter(
        (tree) =>
          tree.workspaceKind === "derived" &&
          tree.ownerStepId === `synthetic-fan-in:${runId}` &&
          Boolean(tree.resultSha),
      )
      .sort((a, b) => b.generation - a.generation)
      .at(0);
    if (synthetic) return synthetic;
    const sinks = this.writableSinkSteps(runId);
    if (sinks.length !== 1)
      throw new WorktreeConflict(
        "result_workspace_ambiguous",
        "The final writable results have not yet been aggregated.",
      );
    const result = this.store.derivedWorkspaceForStep(runId, sinks[0]!.id);
    if (!result || result.resultSha !== sinks[0]!.resultSha)
      throw new WorktreeConflict(
        "result_workspace_changed",
        "The final step workspace no longer matches its committed result SHA.",
      );
    return result;
  }

  private writableSinkSteps(runId: string): RunStep[] {
    const steps = this.store.listRunSteps(runId);
    const writing = steps.filter((step) => isWritingCategory(step.category));
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
    return writing
      .filter(
        (step) =>
          !hasWritableDescendant.has(step.id) &&
          step.state === "succeeded" &&
          Boolean(step.resultSha),
      )
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  private async ensureSyntheticFanIn(run: Run): Promise<ManagedWorktree | undefined> {
    const sinks = this.writableSinkSteps(run.id);
    if (sinks.length <= 1) return this.resultWorkspaceForRun(run.id);
    const ownerStepId = `synthetic-fan-in:${run.id}`;
    const existing = this.store
      .listDerivedWorkspaces(run.id)
      .filter((tree) => tree.ownerStepId === ownerStepId)
      .sort((a, b) => b.generation - a.generation)
      .at(0);
    const predecessors = sinks.map((step) => {
      const worktree = this.store.derivedWorkspaceForStep(run.id, step.id);
      if (!worktree || worktree.resultSha !== step.resultSha)
        throw new WorktreeConflict(
          "fan_in_result_changed",
          `The sealed result for ${step.stepKey} no longer matches its workspace.`,
        );
      const result = this.store.workspaceResultForStep(run.id, step.id);
      return {
        stepId: step.id,
        stepKey: step.stepKey,
        position: step.position,
        worktreeId: worktree.id,
        resultSha: step.resultSha!,
        ...(result?.state === "available" ? { workspaceResultId: result.id } : {}),
      };
    });
    const composition = {
      baseSha: run.workspaceBinding!.baseSha,
      baseRef: run.workspaceBinding!.baseRef,
      dependencyResolution: "explicit" as const,
      implicitDependencyFallback: false,
      predecessors,
      coveredPredecessorStepIds: [],
      state: "pending" as const,
      resultSha: "",
      conflicts: [],
      error: "",
      startedAt: "",
      completedAt: "",
    };
    const first =
      predecessors
        .map((entry) => this.store.getAnyManagedWorkspace(entry.worktreeId))
        .find(
          (tree) =>
            tree &&
            this.store.getNode(tree.nodeId)?.online &&
            this.service.nodeSocket(tree.nodeId),
        ) ?? this.store.getAnyManagedWorkspace(predecessors[0]!.worktreeId)!;
    const worktreeId =
      existing?.id ??
      `worktree-${createHash("sha256")
        .update(`${run.id}:synthetic-fan-in:1`)
        .digest("hex")
        .slice(0, 32)}`;
    let tree = existing;
    if (!tree) {
      const reserved = await this.requestWorkspace(run.id, worktreeId, 1, {
        kind: "reserve",
        actor: "host-aggregation-controller",
        operationId: this.deterministicUuid(`${worktreeId}:reserve:1`),
        workspaceKind: "derived",
        ownerStepId,
        sourcePlacementId: first.sourcePlacementId,
        composition,
      });
      tree = reserved.result?.worktree;
      if (!tree) return undefined;
    }
    if (tree.state === "reserved" || tree.state === "creation_failed") {
      const created = await this.requestWorkspace(run.id, tree.id, tree.generation, {
        kind: "create",
        actor: "host-aggregation-controller",
        operationId: this.deterministicUuid(`${tree.id}:create:${tree.version}`),
        workspaceKind: "derived",
        ownerStepId,
        sourcePlacementId: tree.sourcePlacementId,
        expectedVersion: tree.version,
        composition,
      });
      tree = created.result?.worktree;
      if (!tree) return undefined;
    }
    if (tree.composition?.state !== "ready") {
      const composed = await this.requestWorkspace(run.id, tree.id, tree.generation, {
        kind: "compose",
        actor: "host-aggregation-controller",
        operationId: this.deterministicUuid(`${tree.id}:compose:${tree.version}`),
        workspaceKind: "derived",
        ownerStepId,
        sourcePlacementId: tree.sourcePlacementId,
        expectedVersion: tree.version,
        composition,
      });
      tree = composed.result?.worktree;
      if (!tree || tree.composition?.state !== "ready") return tree;
    }
    if (!tree.resultSha) {
      const finalized = await this.requestWorkspace(run.id, tree.id, tree.generation, {
        kind: "finalize",
        actor: "host-aggregation-controller",
        operationId: this.deterministicUuid(`${tree.id}:finalize:${tree.version}`),
        workspaceKind: "derived",
        ownerStepId,
        sourcePlacementId: tree.sourcePlacementId,
        expectedVersion: tree.version,
        composition: tree.composition,
      });
      tree = finalized.result?.worktree;
    }
    return tree;
  }

  private aggregationOperationId(run: Run, phase: string, worktreeId: string): string {
    const attempt = Math.max(1, run.workspaceBinding?.aggregationAttempt ?? 1);
    return this.deterministicUuid(
      `${run.id}:aggregation:${attempt}:${phase}:${worktreeId}`,
    );
  }

  private aggregationWorkspaces(runId: string): ManagedWorktree[] {
    const steps = new Map(this.store.listRunSteps(runId).map((step) => [step.id, step]));
    const sessions = this.store.listSessions();
    return [...this.store.listManagedWorktrees(), ...this.store.listDerivedWorkspaces()]
      .filter((tree) => tree.runId === runId)
      .filter((tree) => {
        if (tree.workspaceKind === "primary" || !tree.ownerStepId) return true;
        const step = steps.get(tree.ownerStepId);
        if (step) return true;
        return sessions.some(
          (session) =>
            session.executionBinding?.worktreeId === tree.id &&
            (!terminalSessionStates.has(session.state) || session.stopRequested),
        );
      })
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
    const attempt = this.store
      .listIntegrationAttempts(runId)
      .find(
        (entry) =>
          entry.attemptNumber ===
          Math.max(1, patch.aggregationAttempt ?? binding.aggregationAttempt),
      );
    if (attempt) {
      const phase = patch.aggregationPhase ?? binding.aggregationPhase;
      const mappedPhase =
        phase === "quiesce"
          ? "quiesce"
          : phase === "preview" || phase === "integrate"
            ? "integrate"
            : phase === "retain"
              ? "retain"
              : phase === "publish"
                ? "publish"
                : phase === "await_publish_approval"
                  ? "validate"
                  : phase === "cleanup"
                    ? "cleanup"
                    : phase === "done"
                      ? "done"
                      : attempt.phase;
      this.store.putIntegrationAttempt({
        ...attempt,
        phase: mappedPhase,
        status:
          patch.aggregationState === "attention"
            ? "attention"
            : patch.aggregationState === "completed"
              ? "completed"
              : attempt.status,
        publishState:
          phase === "await_publish_approval"
            ? "awaiting_approval"
            : phase === "publish"
              ? "publishing"
              : patch.aggregationState === "completed"
                ? "published"
                : attempt.publishState,
        updatedAt: new Date().toISOString(),
      });
    }
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
    if (code === "publication_failed")
      return "Changes are validated and ready, but Fleet could not publish the branch.";
    if (code.includes("reconciliation") || code.includes("uncertain"))
      return "Workspace or integration ownership must be reconciled before automation can continue.";
    if (phase === "cleanup")
      return "Safe workspace cleanup could not complete. No files were force-removed.";
    return `Automatic integration stopped safely during ${phase} (${code}). Nothing was published; the retained workspace and reviewed result were not modified.`;
  }

  private canAutomaticallyRecover(run: Run, code: string): boolean {
    if (!run.policy.automaticManagedIntegrationRecovery) return false;
    return !/(ambiguous|changed|mismatch|dirty|conflict|unpin|uncertain|reconcil|quarantin|idempotency|forbidden|unsupported|owner|validation|required|not_fleet_owned|retry_exhausted)/i.test(
      code,
    );
  }

  private scheduleAutomaticRecovery(runId: string, code: string, phase: string): boolean {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding || !this.canAutomaticallyRecover(run, code)) return false;
    const retryIndex = binding.aggregationAutomaticRetries;
    const delay = ManagedWorktreeService.AUTOMATIC_RECOVERY_DELAYS_MS[retryIndex];
    if (delay === undefined) return false;

    const existingTimer = this.aggregationRecoveryTimers.get(runId);
    if (existingTimer) clearTimeout(existingTimer);
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      aggregationState: "in_progress",
      aggregationPhase: phase as NonNullable<Run["workspaceBinding"]>["aggregationPhase"],
      aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
      aggregationAutomaticRetries: retryIndex + 1,
      aggregationCode: code,
      aggregationSummary: `Plan-approved automatic recovery ${retryIndex + 1}/${ManagedWorktreeService.AUTOMATIC_RECOVERY_DELAYS_MS.length}: revalidating the retained workspace after ${code}. Nothing has been published.`,
      aggregationUpdatedAt: new Date().toISOString(),
    });
    this.publish(runId);
    const timer = setTimeout(() => {
      this.aggregationRecoveryTimers.delete(runId);
      const current = this.store.getRun(runId);
      if (
        current &&
        (current.state === "aggregating" || terminalRunStates.has(current.state)) &&
        current.workspaceBinding?.aggregationState === "in_progress"
      )
        this.advanceAggregation(runId);
    }, delay);
    timer.unref();
    this.aggregationRecoveryTimers.set(runId, timer);
    return true;
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
    let operation: WorktreeOperation;
    try {
      operation = existing
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
    } catch (error) {
      if (error instanceof WorktreeConflict && error.code === "operation_pending")
        return undefined;
      throw error;
    }
    if (!operation.result) return undefined;
    if (
      !operation.result.ok &&
      ["registry_moved", "registry_mismatch", "registry_locked"].includes(
        operation.result.code,
      )
    ) {
      const repairId = this.aggregationOperationId(run, `repair-${phase}`, tree.id);
      const existingRepair = this.store.getWorktreeOperation(repairId);
      const repair = existingRepair?.result
        ? existingRepair
        : existingRepair
          ? await this.send(existingRepair, 30_000)
          : await this.requestWorkspace(run.id, tree.id, tree.generation, {
              kind: "reconcile",
              actor: "host-finalization-controller",
              operationId: repairId,
              expectedVersion: operation.result.worktree?.version ?? tree.version,
              workspaceKind: tree.workspaceKind,
              ownerStepId: tree.ownerStepId,
            });
      if (!repair.result) return undefined;
      if (!repair.result.ok)
        throw new WorktreeConflict(
          repair.result.code || "reconciliation_failed",
          repair.result.error || "Automatic Git administration repair failed.",
        );
      const binding = this.store.getRun(run.id)?.workspaceBinding;
      if (binding)
        this.setAggregation(run.id, {
          aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
          aggregationCode: "",
          aggregationSummary:
            "Fleet repaired stale Git worktree administration and is resuming finalization.",
        });
      const timer = setTimeout(() => this.advanceAggregation(run.id), 0);
      timer.unref();
      return undefined;
    }
    if (
      !operation.result.ok &&
      operation.result.retryable &&
      ["quiesce", "cleanup"].includes(phase) &&
      !/(dirty|unknown|reconcil|mismatch|conflict)/i.test(operation.result.code)
    ) {
      const binding = this.store.getRun(run.id)?.workspaceBinding;
      if (
        binding &&
        binding.aggregationAutomaticRetries <
          ManagedWorktreeService.MAX_AUTOMATIC_QUIESCE_ATTEMPTS - 1
      )
        this.setAggregation(run.id, {
          aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
          aggregationAutomaticRetries: binding.aggregationAutomaticRetries + 1,
          aggregationSummary:
            "Waiting for task workspace processes to quiesce before safe cleanup.",
        });
      else
        throw new WorktreeConflict(
          "automatic_retry_exhausted",
          "Automatic workspace quiescence did not complete after three attempts.",
        );
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
      (run.state !== "aggregating" &&
        !(
          terminalRunStates.has(run.state) &&
          run.workspaceBinding?.aggregationState === "in_progress"
        )) ||
      run.workspaceBinding?.effectiveMode !== "managed"
    )
      return;
    if (
      run.workspaceBinding.finalizationOutcome === "completed" &&
      !this.store.prMaintenance.admission({ action: "aggregate", taskId: runId }).allowed
    )
      return;
    this.aggregating.add(runId);
    void this.runAggregation(runId).finally(() => this.aggregating.delete(runId));
  }

  beginAggregation(runId: string): Run {
    this.store.assertCommandVerification(runId);
    this.store.prMaintenance.assertAdmission({ action: "aggregate", taskId: runId });
    return this.beginFinalization(runId, "completed", "");
  }

  beginFinalization(
    runId: string,
    outcome: "completed" | "failed" | "cancelled",
    reason: string,
  ): Run {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding || binding.effectiveMode !== "managed")
      throw new WorktreeConflict(
        "not_managed",
        "Automatic integration is available only for managed tasks.",
      );
    if (run.state === "aggregating") {
      if (
        binding.finalizationOutcome !== outcome ||
        binding.finalizationReason !== reason
      )
        this.store.setRunWorkspaceBinding(runId, {
          ...binding,
          finalizationOutcome: outcome,
          finalizationReason: reason,
        });
      this.advanceAggregation(runId);
      return this.store.getRun(runId)!;
    }
    if (!terminalRunStates.has(run.state) && !canTransitionRun(run.state, "aggregating"))
      throw new WorktreeConflict(
        "integration_not_ready",
        "This task cannot begin automatic integration from its current state.",
      );
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: Math.max(1, binding.aggregationAttempt),
      aggregationAutomaticRetries: 0,
      aggregationCode: "",
      aggregationSummary: "",
      aggregationTargetRef: binding.integrationTargetRef || binding.baseRef,
      aggregationUpdatedAt: new Date().toISOString(),
      finalizationOutcome: outcome,
      finalizationReason: reason,
    });
    if (!terminalRunStates.has(run.state))
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
    const terminalFinalization =
      terminalRunStates.has(run.state) && binding.finalizationOutcome !== "completed";
    if (!terminalFinalization)
      this.store.prMaintenance.assertAdmission({ action: "aggregate", taskId: runId });
    if (!terminalFinalization && !canTransitionRun(run.state, "aggregating"))
      throw new WorktreeConflict(
        "retry_not_available",
        "This task cannot resume automatic integration from its current state.",
      );
    this.store.setRunWorkspaceBinding(runId, {
      ...binding,
      aggregationState: "in_progress",
      aggregationPhase: "preview",
      aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
      aggregationAutomaticRetries: 0,
      aggregationCode: "",
      aggregationSummary: "",
      aggregationUpdatedAt: new Date().toISOString(),
    });
    if (!terminalFinalization) this.store.setRunState(runId, "aggregating", "");
    this.publish(runId);
    this.advanceAggregation(runId);
  }

  approvePublication(runId: string, approvalId: string, approvedBy: string) {
    this.store.prMaintenance.assertAdmission({ action: "publish", taskId: runId });
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding || run.state !== "aggregating")
      throw new WorktreeConflict(
        "publication_not_ready",
        "This task does not have a validated result awaiting publication.",
      );
    const attempt = this.store.listIntegrationAttempts(runId).at(-1);
    const tree = attempt
      ? this.store.getAnyManagedWorkspace(attempt.resultWorkspaceId)
      : undefined;
    const integration = tree
      ? (this.store
          .listWorktreeIntegrations(tree.id)
          .find((entry) => entry.id === attempt?.attemptId) ??
        this.store.listWorktreeIntegrations(tree.id).at(-1))
      : undefined;
    if (
      !attempt ||
      !tree ||
      !integration ||
      integration.validationState !== "passed" ||
      !["integrated", "no_changes"].includes(integration.state) ||
      !integration.resultSha ||
      !integration.finalTree
    )
      throw new WorktreeConflict(
        "publication_not_ready",
        "Only the exact validated integrated result can be approved for publication.",
      );
    const approval = this.store.putPublicationApproval({
      approvalId,
      runId,
      integrationId: integration.id,
      targetRemote: integration.preview.targetRemote,
      targetRef: integration.preview.targetRef,
      expectedRemoteSha: "",
      finalResultSha: integration.resultSha,
      finalTreeSha: integration.finalTree,
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    this.setAggregation(runId, {
      aggregationState: "in_progress",
      aggregationPhase: "publish",
      aggregationCode: "",
      aggregationSummary: "",
    });
    this.advanceAggregation(runId);
    return approval;
  }

  requestPublicationChanges(runId: string, feedback: string, requestedBy: string): Run {
    const note = feedback.trim();
    if (!note)
      throw new WorktreeConflict(
        "publication_feedback_required",
        "Say what needs changing, so the orchestrator can act on it.",
      );
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    const attempt = this.store.listIntegrationAttempts(runId).at(-1);
    const tree = attempt
      ? this.store.getAnyManagedWorkspace(attempt.resultWorkspaceId)
      : undefined;
    const integration = tree
      ? (this.store
          .listWorktreeIntegrations(tree.id)
          .find((entry) => entry.id === attempt?.attemptId) ??
        this.store.listWorktreeIntegrations(tree.id).at(-1))
      : undefined;
    const lead = run?.leadSessionId
      ? this.store.getSession(run.leadSessionId)
      : undefined;
    if (
      !run ||
      !binding ||
      run.state !== "aggregating" ||
      binding.aggregationPhase !== "await_publish_approval" ||
      !attempt ||
      !tree ||
      !integration ||
      integration.publishState !== "awaiting_approval" ||
      integration.validationState !== "passed" ||
      !["integrated", "no_changes"].includes(integration.state)
    )
      throw new WorktreeConflict(
        "publication_not_ready",
        "Changes can be requested only for the exact validated result awaiting publication.",
      );
    if (!lead || terminalSessionStates.has(lead.state))
      throw new WorktreeConflict(
        "orchestrator_unavailable",
        "The orchestrator conversation has ended, so it cannot act on requested changes.",
      );

    const now = new Date().toISOString();
    const reopened = this.store.writeAtomically(() => {
      this.store.revokePublicationApprovals(runId, requestedBy, note, now);
      this.store.putWorktreeIntegration({
        ...integration,
        validationState: "failed",
        validationSummary: "Changes requested during final publication review.",
        publishState: "failed",
        error: "Publication was rejected pending requested changes.",
        updatedAt: now,
      });
      this.store.putIntegrationAttempt({
        ...attempt,
        status: "attention",
        publishState: "failed",
        updatedAt: now,
      });
      this.store.appendRunNote(
        runId,
        run.phaseIndex,
        `Changes requested during final publication review.\n\n${note}`,
        {
          summary: "Changes requested during publication review",
          kind: "decision",
          source: "operator",
        },
      );
      this.store.setRunWorkspaceBinding(runId, {
        ...binding,
        aggregationState: "not_started",
        aggregationPhase: "idle",
        aggregationAttempt: Math.max(1, binding.aggregationAttempt) + 1,
        aggregationAutomaticRetries: 0,
        aggregationCode: "",
        aggregationSummary: "Changes requested; orchestration resumed.",
        aggregationUpdatedAt: now,
      });
      return this.store.updateRun(runId, {
        state: "running",
        failureReason: "",
        pendingPrompt: owedPrompt(run.pendingPrompt, sendBackPrompt(run.name, note)),
      })!;
    });
    this.publish(runId);
    this.service.tickRun(runId);
    return reopened;
  }

  private isVerifiedNoChangeRun(runId: string, workspaces: ManagedWorktree[]): boolean {
    return (
      workspaces.length > 0 &&
      this.store.listWorkspaceResults(runId).length === 0 &&
      workspaces.every(
        (workspace) =>
          workspace.observation?.head === workspace.baseSha &&
          workspace.observation.dirty === false &&
          !workspace.resultSha,
      )
    );
  }

  private async runAggregation(runId: string): Promise<void> {
    let run = this.store.getRun(runId);
    let binding = run?.workspaceBinding;
    if (
      !run ||
      !binding ||
      (run.state !== "aggregating" &&
        !(terminalRunStates.has(run.state) && binding.aggregationState === "in_progress"))
    )
      return;
    const finalizationOutcome = binding.finalizationOutcome ?? "completed";
    const targetRef = binding.integrationTargetRef || binding.baseRef;
    let phase =
      binding.aggregationPhase === "idle" ? "preview" : binding.aggregationPhase;
    try {
      const primary = this.store.worktreeForRun(runId);
      if (!primary)
        throw new WorktreeConflict(
          "source_unavailable",
          "The primary managed workspace is unavailable.",
        );

      let workspaces = this.aggregationWorkspaces(runId);
      const sinks = this.writableSinkSteps(runId);
      let selectedResultTree =
        sinks.length === 1
          ? this.store.derivedWorkspaceForStep(runId, sinks[0]!.id)
          : (sinks
              .map((step) => this.store.derivedWorkspaceForStep(runId, step.id))
              .find(
                (tree) =>
                  tree &&
                  this.store.getNode(tree.nodeId)?.online &&
                  this.service.nodeSocket(tree.nodeId),
              ) ?? this.store.worktreeForRun(runId));
      const preQuiesceNoChanges = this.isVerifiedNoChangeRun(
        runId,
        workspaces
          .map((workspace) => this.store.getAnyManagedWorkspace(workspace.id))
          .filter((workspace): workspace is ManagedWorktree => Boolean(workspace)),
      );
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
        const ownerOnline = Boolean(
          this.store.getNode(fresh.nodeId)?.online &&
          this.service.nodeSocket(fresh.nodeId),
        );
        const liveSession = ownedSessions.some(
          (session) =>
            session.executionBinding?.worktreeId === fresh.id &&
            (!terminalSessionStates.has(session.state) || session.stopRequested),
        );
        if (!ownerOnline) {
          if (
            liveSession ||
            (!preQuiesceNoChanges && fresh.id === selectedResultTree?.id)
          )
            throw new WorktreeConflict(
              "node_unavailable",
              `Node ${fresh.nodeId} must be online to quiesce the active integration workspace.`,
            );
          continue;
        }
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
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id);
        if (
          !fresh ||
          fresh.state === "removed" ||
          fresh.abandonedAt ||
          !fresh.ownerStepId ||
          !fresh.observation?.dirty
        )
          continue;
        const owner = this.store.getRunStep(fresh.ownerStepId);
        if (!owner || owner.state === "succeeded") continue;
        if (
          fresh.observation.ignored === true &&
          fresh.observation.staged === false &&
          fresh.observation.unstaged === false &&
          fresh.observation.untracked === false
        )
          continue;
        const recovery = await this.automaticOperation(run, fresh, "recover", {
          kind: "finalize",
          actor: "host-finalization-controller",
        });
        if (!recovery) return;
      }
      workspaces = this.aggregationWorkspaces(runId);
      if (finalizationOutcome === "completed" && sinks.length > 1) {
        selectedResultTree = await this.ensureSyntheticFanIn(run);
        if (!selectedResultTree) return;
        workspaces = this.aggregationWorkspaces(runId);
      } else {
        selectedResultTree = selectedResultTree
          ? this.store.getAnyManagedWorkspace(selectedResultTree.id)
          : undefined;
      }
      if (selectedResultTree) {
        const attemptNumber = Math.max(1, binding.aggregationAttempt);
        const attemptId = this.deterministicUuid(
          `${runId}:integration-attempt:${attemptNumber}`,
        );
        const currentAttempt = this.store
          .listIntegrationAttempts(runId)
          .find((entry) => entry.attemptId === attemptId);
        if (!currentAttempt)
          this.store.putIntegrationAttempt({
            attemptId,
            runId,
            attemptNumber,
            resultWorkspaceId: selectedResultTree.id,
            resultGeneration: selectedResultTree.generation,
            integrationBaseSha: "",
            targetRef,
            assignedNodeId: selectedResultTree.nodeId,
            phase: "aggregate",
            expectedTree: "",
            finalSha: "",
            status: "in_progress",
            publishState: "not_started",
            receiptIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
      }
      const verifiedNoChanges =
        finalizationOutcome !== "completed" ||
        this.isVerifiedNoChangeRun(
          runId,
          workspaces
            .map((workspace) => this.store.getAnyManagedWorkspace(workspace.id))
            .filter((workspace): workspace is ManagedWorktree => Boolean(workspace)),
        );
      if (!verifiedNoChanges && (!targetRef || !targetRef.startsWith("refs/heads/")))
        throw new WorktreeConflict(
          "target_unpinned",
          "Automatic integration requires the pinned symbolic base branch.",
        );

      let integration;
      if (!verifiedNoChanges) {
        const resultTree = selectedResultTree!;
        integration = this.store
          .listWorktreeIntegrations(resultTree.id)
          .filter((entry) => entry.preview.targetRef === targetRef)
          .at(-1);

        const reusableValidatedIntegration =
          integration &&
          ["integrated", "no_changes"].includes(integration.state) &&
          integration.validationState === "passed" &&
          integration.approvedTaskSha ===
            (resultTree.resultSha || resultTree.observation?.head);
        if (!reusableValidatedIntegration) {
          phase = "preview";
          this.setAggregation(runId, {
            aggregationState: "in_progress",
            aggregationPhase: "preview",
            aggregationTargetRef: verifiedNoChanges ? "" : targetRef,
            aggregationCode: "",
            aggregationSummary: "",
          });
          const previewOperation = await this.automaticOperation(
            run,
            resultTree,
            "preview",
            {
              kind: "integration_preview",
              actor: "host-integration-controller",
              integrationBaseRef: binding.integrationBaseRef,
              integrationTargetRef: binding.integrationTargetRef,
              integrationRemote: binding.integrationRemote,
            },
          );
          if (!previewOperation) return;
          const preview = previewOperation.result?.preview;
          if (!preview)
            throw new WorktreeConflict(
              "preview_missing",
              "The Node returned no integration preview.",
            );
          if (preview.targetRef !== targetRef)
            throw new WorktreeConflict(
              "target_ref_mismatch",
              "The preview target does not match the pinned source branch.",
            );
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
              integrationBaseRef: binding.integrationBaseRef,
              integrationTargetRef: binding.integrationTargetRef,
              integrationRemote: binding.integrationRemote,
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
        const approval = this.store.getPublicationApproval(runId);
        const approvalMatches =
          approval?.integrationId === integration.id &&
          approval.targetRemote === integration.preview.targetRemote &&
          approval.targetRef === integration.preview.targetRef &&
          approval.finalResultSha === integration.resultSha &&
          approval.finalTreeSha === integration.finalTree;
        const publicationRequired =
          integration.resultSha !== integration.preview.targetSha ||
          integration.publicationFileCount > 0 ||
          integration.publicationCommitCount > 0;
        if (
          integration.publishState !== "published" &&
          publicationRequired &&
          !approvalMatches
        ) {
          this.setAggregation(runId, {
            aggregationState: "in_progress",
            aggregationPhase: "await_publish_approval",
            aggregationCode: "",
            aggregationSummary:
              "The exact validated integrated result is ready for your review and publication approval.",
          });
          return;
        }
        phase = "publish";
        this.setAggregation(runId, { aggregationPhase: "publish" });
        if (integration.publishState !== "published") {
          const publishOperation = await this.automaticOperation(
            run,
            this.store.getAnyManagedWorkspace(resultTree.id)!,
            "publish",
            {
              kind: "publish",
              actor: "host-integration-controller",
              integrationId: integration.id,
              ...(approval ? { publicationApproval: approval } : {}),
            },
          );
          if (!publishOperation) return;
          integration = publishOperation.result?.integration;
        }
        if (!integration || integration.publishState !== "published")
          throw new WorktreeConflict(
            "publication_failed",
            "The integration is validated, but Fleet could not publish the branch.",
          );
      }

      const artifactExpiry = new Date(
        Date.now() + ManagedWorktreeService.ARTIFACT_RETENTION_MS,
      ).toISOString();
      for (const result of this.store.listWorkspaceResults(runId))
        this.store.putWorkspaceResult({ ...result, expiresAt: artifactExpiry });

      phase = "retain";
      this.setAggregation(runId, { aggregationPhase: "retain" });
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id)!;
        if (fresh.state === "removed" || fresh.state === "retained") continue;
        if (
          !this.store.getNode(fresh.nodeId)?.online ||
          !this.service.nodeSocket(fresh.nodeId)
        )
          continue;
        const operation = await this.automaticOperation(run, fresh, "retain", {
          kind: "retain",
          actor: "host-integration-controller",
        });
        if (!operation) return;
      }

      phase = "cleanup";
      this.setAggregation(runId, { aggregationPhase: "cleanup" });
      let retainedWorkspaceCount = 0;
      for (const workspace of workspaces) {
        const fresh = this.store.getAnyManagedWorkspace(workspace.id)!;
        if (fresh.state === "removed") continue;
        if (
          !this.store.getNode(fresh.nodeId)?.online ||
          !this.service.nodeSocket(fresh.nodeId)
        ) {
          retainedWorkspaceCount += 1;
          continue;
        }
        try {
          const operation = await this.automaticOperation(run, fresh, "cleanup", {
            kind: "cleanup",
            actor: "host-integration-controller",
            deleteBranch: false,
          });
          if (!operation) return;
        } catch (error) {
          const observation = this.store.getAnyManagedWorkspace(
            workspace.id,
          )?.observation;
          if (
            error instanceof WorktreeConflict &&
            error.code === "dirty_or_unknown" &&
            fresh.state === "retained" &&
            observation?.ignored === true &&
            observation.staged === false &&
            observation.unstaged === false &&
            observation.untracked === false
          ) {
            retainedWorkspaceCount += 1;
            continue;
          }
          throw error;
        }
      }

      binding = this.store.getRun(runId)!.workspaceBinding!;
      const cleanupSuffix = retainedWorkspaceCount
        ? ` ${retainedWorkspaceCount} workspace${retainedWorkspaceCount === 1 ? "" : "s"} retained because ignored generated output was present.`
        : "";
      this.store.setRunWorkspaceBinding(runId, {
        ...binding,
        aggregationState: "completed",
        aggregationPhase: "done",
        aggregationCode: "",
        aggregationSummary:
          finalizationOutcome !== "completed"
            ? `Preserved unfinished changes and cleaned managed workspaces for the ${finalizationOutcome} task.${cleanupSuffix}`
            : verifiedNoChanges
              ? `No committed changes; verified task workspaces and cleaned them without merge integration.${cleanupSuffix}`
              : integration?.state === "no_changes"
                ? `No committed changes; verified ${targetRef.replace(/^refs\/heads\//, "")} and cleaned isolated workspaces.${cleanupSuffix}`
                : `Integrated into ${targetRef.replace(/^refs\/heads\//, "")} and cleaned isolated workspaces.${cleanupSuffix}`,
        aggregationTargetRef: verifiedNoChanges ? "" : targetRef,
        aggregationUpdatedAt: new Date().toISOString(),
      });
      this.service.notifications.resolveWorktreeAttention(
        runId,
        `aggregation:${binding.generation}`,
        "integration",
      );
      for (const entry of integration ? this.store.listWorktreeIntegrations() : []) {
        if (entry.worktreeId === integration?.worktreeId) {
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
      if (completed.state !== finalizationOutcome) {
        if (canTransitionRun(completed.state, finalizationOutcome))
          this.store.setRunState(runId, finalizationOutcome, binding.finalizationReason);
      }
      this.publish(runId);
    } catch (error) {
      const code = error instanceof WorktreeConflict ? error.code : "integration_failed";
      if (this.scheduleAutomaticRecovery(runId, code, phase)) return;
      this.escalateAggregation(runId, code, phase, targetRef);
    }
  }

  observeCommandTarget(
    runId: string,
    worktreeId: string,
    generation: number,
  ): Promise<WorktreeOperation> {
    return this.requestWorkspace(runId, worktreeId, generation, {
      kind: "observe",
      actor: "command-reconciliation",
    });
  }

  private async requestWorkspace(
    runId: string,
    worktreeId: string,
    generation: number,
    input: Partial<WorktreeOperationRequest> &
      Pick<WorktreeOperationRequest, "kind" | "actor">,
    waitMs = 30_000,
  ): Promise<WorktreeOperation> {
    if (!["observe", "reconcile", "quiesce"].includes(input.kind))
      this.store.commands.assertTaskUnfenced(runId);
    if (["integrate", "publish", "integration_preview"].includes(input.kind))
      this.store.assertCommandVerification(runId);
    this.assertMaintenanceWorkspaceOperation(runId, input.kind);
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
    const requestedPlacementId =
      input.sourcePlacementId ||
      this.store.getAnyManagedWorkspace(worktreeId)?.sourcePlacementId ||
      binding.originatingPlacementId ||
      binding.sourcePlacementId;
    const placement = this.store.getPlacement(requestedPlacementId);
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
      originatingPlacementId: binding.originatingPlacementId || binding.sourcePlacementId,
      repositoryIdentity: binding.repositoryIdentity,
      repositoryObjectFormat: binding.repositoryObjectFormat,
      workspaceId: run.workspaceId,
      sourcePath: placement.localPath,
      nodeId: node.id,
      hostInstallationId: this.store.worktreeHostInstallationId(),
      expectedVersion: input.expectedVersion ?? tree?.version ?? 0,
      generation,
      expectedPath: tree?.path ?? "",
      expectedBranchRef: tree?.branchRef ?? "",
      expectedBaseSha: binding.baseSha,
      expectedBaseRef: binding.baseRef,
      integrationBaseRef: binding.integrationBaseRef,
      integrationTargetRef: binding.integrationTargetRef,
      integrationRemote: binding.integrationRemote,
      allowGitHooks: input.allowGitHooks ?? binding.allowGitHooks,
      policy: this.store.getManagedWorktreePolicy(),
      workspaceResults:
        input.workspaceResults ??
        (input.composition
          ? input.composition.predecessors.flatMap((predecessor) => {
              if (!predecessor.workspaceResultId) return [];
              const result = this.store.getWorkspaceResult(predecessor.workspaceResultId);
              if (!result || result.state !== "available")
                throw new WorktreeConflict(
                  "workspace_result_unavailable",
                  `A sealed predecessor result is unavailable for ${predecessor.stepKey}.`,
                );
              return [result];
            })
          : []),
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
    if (request.targetPath) {
      throw new WorktreeConflict(
        "target_not_fleet_owned",
        "The Host does not accept a user checkout as a managed integration target.",
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
    this.assertMaintenanceWorkspaceOperation(
      operation.request.runId,
      operation.request.kind,
    );
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

  private assertMaintenanceWorkspaceOperation(
    runId: string,
    kind: WorktreeOperationRequest["kind"],
  ): void {
    if (["inspect", "reconcile", "quiesce", "retain"].includes(kind)) return;
    this.store.prMaintenance.assertAdmission({
      action: kind === "cleanup" ? "cleanup" : "publish",
      taskId: runId,
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
        tree.executionPlacementId !== expected.sourcePlacementId ||
        tree.originatingPlacementId !== expected.originatingPlacementId ||
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
      result.workspaceResult &&
      (!tree ||
        result.workspaceResult.id !== expected.operationId ||
        result.workspaceResult.runId !== expected.runId ||
        result.workspaceResult.ownerStepId !== expected.ownerStepId ||
        result.workspaceResult.sourceWorktreeId !== expected.worktreeId ||
        result.workspaceResult.sourceNodeId !== nodeId ||
        result.workspaceResult.sourcePlacementId !== expected.sourcePlacementId ||
        result.workspaceResult.sourceGeneration !== expected.generation ||
        result.workspaceResult.repositoryIdentity !== tree.repositoryIdentity ||
        result.workspaceResult.baseSha !== tree.baseSha ||
        result.workspaceResult.headSha !== tree.resultSha ||
        result.workspaceResult.state !== "available")
    )
      return false;
    if (
      result.preview &&
      (result.preview.worktreeId !== expected.worktreeId ||
        result.preview.generation !== expected.generation ||
        result.preview.id !== expected.operationId ||
        result.preview.targetPlacementId !==
          (expected.targetPlacementId || expected.sourcePlacementId))
    )
      return false;
    if (
      result.integration &&
      (result.integration.worktreeId !== expected.worktreeId ||
        result.integration.generation !== expected.generation ||
        (expected.kind === "integrate" &&
          result.integration.id !== expected.operationId) ||
        (["continue", "abort", "publish"].includes(expected.kind) &&
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
      if (result.workspaceResult) this.store.putWorkspaceResult(result.workspaceResult);
      this.store.putWorktreeOperation({ ...operation, state: "acknowledged", result });
      const run = this.store.getRun(expected.runId);
      const binding = run?.workspaceBinding;
      const available =
        tree && ["ready", "retained"].includes(tree.state) && !tree.abandonedAt;
      if (binding && expected.workspaceKind === "primary") {
        this.store.setRunWorkspaceBinding(expected.runId, {
          ...binding,
          ...(tree
            ? {
                baseSha: tree.baseSha,
                baseRef: tree.baseRef,
                checkoutKey: tree.checkout?.key ?? binding.checkoutKey,
                resolvedPath: tree.path,
                allowGitHooks: tree.allowGitHooks,
                originatingPlacementId:
                  binding.originatingPlacementId || tree.originatingPlacementId,
                repositoryIdentity: tree.repositoryIdentity,
                repositoryObjectFormat: tree.repositoryObjectFormat,
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
      }
      if (binding && result.ok && expected.kind === "reconcile" && available) {
        for (const session of this.store.listSessions())
          if (
            session.runId === expected.runId &&
            session.executionBinding?.worktreeId === tree.id &&
            session.executionBinding.generation === tree.generation
          ) {
            this.store.setSessionExecutionBinding(session.id, {
              ...session.executionBinding,
              quarantined: false,
            });
          }
        for (const step of this.store.listRunSteps(expected.runId))
          if (
            step.executionBinding?.worktreeId === tree.id &&
            step.executionBinding.generation === tree.generation
          ) {
            this.store.updateRunStep(step.id, {
              executionBinding: { ...step.executionBinding, quarantined: false },
            });
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
    if (
      expected.workspaceKind === "primary" &&
      expected.kind === "reserve" &&
      result.ok &&
      tree?.repositoryIdentity
    ) {
      this.store.resolveRunWorkspaceSpec(expected.runId, {
        repositoryIdentity: tree.repositoryIdentity,
        repositoryObjectFormat: tree.repositoryObjectFormat,
        executionBaseRef: tree.baseRef,
        executionBaseSha: tree.baseSha,
        repositoryExecutionPolicy: tree.repositoryExecutionPolicy,
      });
      this.store.putPlacementRepositoryCapability({
        placementId: expected.sourcePlacementId,
        nodeId,
        localPath: tree.repository.path,
        repositoryIdentity: {
          id: tree.repositoryIdentity,
          objectFormat: tree.repositoryObjectFormat!,
          evidence: "roots",
          remoteHash: "",
          rootHash: createHash("sha256").update(tree.baseSha).digest("hex"),
        },
        baseSha: tree.baseSha,
        baseAvailable: true,
        baseMaterializable: false,
        portableResultsSupported:
          !tree.repositoryFeatures.gitLfs && !tree.repositoryFeatures.submodules,
        portabilityReason: tree.repositoryFeatures.gitLfs
          ? "Git LFS result transport is not implemented; execution is Node-local."
          : tree.repositoryFeatures.submodules
            ? "Submodule result transport is not implemented; execution is Node-local."
            : "",
        verifiedAt: result.acknowledgedAt,
        error: "",
      });
      this.probeRunPlacements(expected.runId);
    }
    this.service.tickRun(expected.runId);
    return true;
  }

  probeRunPlacements(runId: string): void {
    const run = this.store.getRun(runId);
    const binding = run?.workspaceBinding;
    if (!run || !binding?.repositoryIdentity || !binding.baseSha) return;
    for (const placement of this.store
      .listPlacements()
      .filter(
        (entry) =>
          entry.workspaceId === run.workspaceId &&
          entry.id !== binding.originatingPlacementId,
      )) {
      const node = this.store.getNode(placement.nodeId);
      if (
        !node?.online ||
        !node.capabilities.includes(PORTABLE_WORKTREE_RESULTS_CAPABILITY)
      )
        continue;
      const socket = this.service.nodeSocket(node.id);
      if (!socket) continue;
      const operationId = this.deterministicUuid(
        `${run.id}:repository-probe:${placement.id}:${binding.baseSha}`,
      );
      this.service.send(socket, {
        type: "repository_probe",
        request: {
          operationId,
          runId,
          placementId: placement.id,
          localPath: placement.localPath,
          baseSha: binding.baseSha,
          baseRef: binding.baseRef,
          remote: binding.integrationRemote,
          expectedRepositoryIdentity: binding.repositoryIdentity,
        },
      });
    }
  }

  handleRepositoryProbe(nodeId: string, result: RepositoryProbeResult): boolean {
    const run = this.store.getRun(result.runId);
    const placement = this.store.getPlacement(result.placementId);
    if (!run || !placement || placement.nodeId !== nodeId || result.nodeId !== nodeId)
      return false;
    if (result.ok && result.capability) {
      const binding = run.workspaceBinding;
      if (
        !binding ||
        result.capability.placementId !== placement.id ||
        result.capability.nodeId !== placement.nodeId ||
        result.capability.localPath !== placement.localPath ||
        result.capability.repositoryIdentity.id !== binding.repositoryIdentity ||
        result.capability.repositoryIdentity.objectFormat !==
          binding.repositoryObjectFormat ||
        result.capability.baseSha !== binding.baseSha
      )
        return false;
      this.store.putPlacementRepositoryCapability(result.capability);
      this.placementProbeFailures.delete(this.placementProbeKey(run, placement.id));
      this.service.tickRun(run.id);
    } else {
      this.placementProbeFailures.set(
        this.placementProbeKey(run, placement.id),
        result.error || result.code || "Repository probe failed.",
      );
    }
    return true;
  }

  async handleArtifactUploadBegin(nodeId: string, value: ArtifactUploadBegin) {
    if (
      value.resultId !== value.result.id ||
      value.artifactId !== value.result.artifactId
    )
      throw new WorktreeConflict(
        "artifact_upload_forbidden",
        "Artifact upload identifiers do not match the sealed result.",
      );
    this.authorizeArtifactUpload(nodeId, value.operationId, value.result);
    const offset = await this.artifacts.begin(value);
    return {
      operationId: value.operationId,
      resultId: value.resultId,
      artifactId: value.artifactId,
      ok: true,
      offset,
      complete: offset === value.result.artifactSize,
      code: "",
      error: "",
    };
  }

  async handleArtifactUploadChunk(nodeId: string, value: ArtifactUploadChunk) {
    const result = this.store.getWorkspaceResult(value.resultId);
    if (
      !result ||
      value.operationId !== result.id ||
      value.artifactId !== result.artifactId
    )
      throw new WorktreeConflict("artifact_owner", "Artifact upload identity changed.");
    this.authorizeArtifactUpload(nodeId, value.operationId, result);
    const offset = await this.artifacts.append(value);
    return {
      operationId: value.operationId,
      resultId: value.resultId,
      artifactId: value.artifactId,
      ok: true,
      offset,
      complete: offset === result.artifactSize,
      code: "",
      error: "",
    };
  }

  async handleArtifactUploadComplete(nodeId: string, value: ArtifactUploadComplete) {
    const result = this.store.getWorkspaceResult(value.resultId);
    if (
      !result ||
      value.operationId !== result.id ||
      value.artifactId !== result.artifactId ||
      value.size !== result.artifactSize ||
      value.sha256 !== result.artifactSha256
    )
      throw new WorktreeConflict("artifact_owner", "Artifact upload identity changed.");
    this.authorizeArtifactUpload(nodeId, value.operationId, result);
    const available = await this.artifacts.complete(value);
    return {
      operationId: value.operationId,
      resultId: value.resultId,
      artifactId: value.artifactId,
      ok: true,
      offset: available.artifactSize,
      complete: true,
      code: "",
      error: "",
    };
  }

  async handleArtifactDownload(nodeId: string, value: ArtifactDownloadRequest) {
    const operation = this.store.getWorktreeOperation(value.operationId);
    const result = this.store.getWorkspaceResult(value.resultId);
    if (
      !operation ||
      operation.request.nodeId !== nodeId ||
      !["intent", "uncertain"].includes(operation.state) ||
      !operation.request.workspaceResults.some((entry) => entry.id === value.resultId) ||
      !result ||
      result.state !== "available"
    )
      throw new WorktreeConflict(
        "artifact_download_forbidden",
        "Artifact download is not authorized for this operation.",
      );
    const chunk = await this.artifacts.read(
      value.resultId,
      value.artifactId,
      value.offset,
    );
    return { ...chunk, operationId: value.operationId };
  }

  private authorizeArtifactUpload(
    nodeId: string,
    operationId: string,
    result: NonNullable<WorktreeOperationResult["workspaceResult"]>,
  ): void {
    const operation = this.store.getWorktreeOperation(operationId);
    const tree = this.store.getAnyManagedWorkspace(result.sourceWorktreeId);
    if (
      !operation ||
      result.id !== operationId ||
      !["intent", "uncertain"].includes(operation.state) ||
      operation.request.kind !== "finalize" ||
      operation.request.nodeId !== nodeId ||
      operation.request.runId !== result.runId ||
      operation.request.ownerStepId !== result.ownerStepId ||
      operation.request.worktreeId !== result.sourceWorktreeId ||
      operation.request.sourcePlacementId !== result.sourcePlacementId ||
      operation.request.generation !== result.sourceGeneration ||
      !tree ||
      tree.nodeId !== nodeId ||
      tree.runId !== result.runId ||
      tree.ownerStepId !== result.ownerStepId ||
      tree.sourcePlacementId !== result.sourcePlacementId ||
      tree.generation !== result.sourceGeneration ||
      tree.repositoryIdentity !== result.repositoryIdentity ||
      tree.baseSha !== result.baseSha ||
      tree.baseRef !== result.baseRef ||
      tree.repositoryObjectFormat !== result.objectFormat ||
      result.artifactRef !== `refs/fleet/results/${tree.taskKey}`
    )
      throw new WorktreeConflict(
        "artifact_upload_forbidden",
        "Artifact upload is not authorized for this result.",
      );
  }

  onNodeReconciled(nodeId: string): void {
    if (!this.store.getNode(nodeId)?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY))
      return;
    const pendingOperations = this.store
      .listWorktreeOperations()
      .filter(
        (entry) =>
          entry.request.nodeId === nodeId &&
          ["intent", "uncertain"].includes(entry.state),
      )
      .sort((left, right) => {
        const leftActive = !terminalRunStates.has(
          this.store.getRun(left.request.runId)?.state ?? "failed",
        );
        const rightActive = !terminalRunStates.has(
          this.store.getRun(right.request.runId)?.state ?? "failed",
        );
        return (
          Number(rightActive) - Number(leftActive) ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.request.operationId.localeCompare(left.request.operationId)
        );
      });
    for (const operation of pendingOperations.slice(0, 2))
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
    for (const run of this.store
      .listRuns()
      .filter(
        (entry) =>
          entry.workspaceBinding?.effectiveMode === "managed" &&
          !terminalRunStates.has(entry.state),
      ))
      this.probeRunPlacements(run.id);
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
    for (const result of this.store
      .listWorkspaceResults()
      .filter(
        (entry) =>
          entry.state === "available" &&
          Boolean(entry.expiresAt) &&
          Date.parse(entry.expiresAt) <= nowMs &&
          terminalRunStates.has(this.store.getRun(entry.runId)?.state ?? "running"),
      )
      .slice(0, Math.max(0, 2 - count))) {
      void this.artifacts.expire(result.id).catch(() => undefined);
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
    if (session.runId && session.runRole !== "lead")
      this.store.commands.assertTaskUnfenced(session.runId);
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
    const attachedStep = this.store.getRunStepBySession(session.id);
    const step =
      attachedStep ??
      (tree?.workspaceKind !== "primary" && tree?.ownerStepId
        ? this.store.getRunStep(tree.ownerStepId)
        : undefined);
    if (
      !tree ||
      tree.runId !== run.id ||
      (tree.workspaceKind !== "primary" &&
        (tree.ownerStepId !== step?.id ||
          step.runId !== run.id ||
          step.managedWorktreeId !== tree.id ||
          step.executionBinding?.worktreeId !== tree.id))
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
    for (const timer of this.placementProbeTimers.values()) clearTimeout(timer);
    this.placementProbeTimers.clear();
    this.placementProbeStartedAt.clear();
    this.placementProbeCooldownUntil.clear();
    this.placementProbeFailures.clear();
    for (const timer of this.aggregationRecoveryTimers.values()) clearTimeout(timer);
    this.aggregationRecoveryTimers.clear();
    this.workspacePlacementStartedAt.clear();
  }

  private publish(runId: string): void {
    const run = this.store.getRun(runId);
    if (run) this.service.publishRun(run);
  }
}
