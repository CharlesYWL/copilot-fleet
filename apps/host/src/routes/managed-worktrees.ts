import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  MANAGED_WORKTREES_CAPABILITY,
  WorktreeConflict,
  type WorktreeOperation,
  type WorktreeOperationRequest,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";

const ActionSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  targetPlacementId: z.string().min(1).optional(),
  previewId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
  reviewedTaskSha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .optional(),
  reviewedDiffIdentity: z.string().min(1).optional(),
  confirm: z.string().max(16_384).optional(),
  commit: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  allowGitHooks: z.boolean().optional(),
});

const actions: Readonly<Record<string, WorktreeOperationRequest["kind"]>> = {
  observe: "observe",
  reconcile: "reconcile",
  "retry-create": "create",
  "retry-with-hooks": "create",
  retain: "retain",
  quiesce: "quiesce",
  "integration-preview": "integration_preview",
  "integration-start": "integrate",
  "integration-continue": "continue",
  "integration-abort": "abort",
  cleanup: "cleanup",
  abandon: "abandon",
};

export const managedWorktreeRoutes: FastifyPluginAsync<{
  service: FleetService;
}> = async (app, { service }) => {
  const { store } = service;
  app.get("/api/worktrees/metrics", async () => {
    const duration = (start: string, end: string) => {
      const value = Date.parse(end) - Date.parse(start);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const summarize = (values: Array<number | undefined>) => {
      const measured = values.filter((value): value is number => value !== undefined);
      return {
        count: measured.length,
        averageMs: measured.length
          ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length)
          : 0,
        maximumMs: measured.reduce((maximum, value) => Math.max(maximum, value), 0),
      };
    };
    const runs = store.listRuns();
    const completed = runs.filter((run) =>
      ["completed", "failed", "cancelled"].includes(run.state),
    );
    const managed = runs.filter(
      (run) => run.workspaceBinding?.effectiveMode === "managed",
    );
    const legacy = runs.filter(
      (run) => run.workspaceBinding?.effectiveMode !== "managed",
    );
    const steps = runs.flatMap((run) => store.listRunSteps(run.id));
    const worktrees = store.listManagedWorktrees();
    const integrations = store.listWorktreeIntegrations();
    return {
      generatedAt: new Date().toISOString(),
      tasks: {
        managed: managed.length,
        legacy: legacy.length,
        managedDuration: summarize(
          completed
            .filter((run) => run.workspaceBinding?.effectiveMode === "managed")
            .map((run) => duration(run.createdAt, run.updatedAt)),
        ),
        legacyDuration: summarize(
          completed
            .filter((run) => run.workspaceBinding?.effectiveMode !== "managed")
            .map((run) => duration(run.createdAt, run.updatedAt)),
        ),
      },
      preparation: {
        duration: summarize(
          managed.map((run) => {
            const binding = run.workspaceBinding;
            return binding?.setupStartedAt && binding.setupCompletedAt
              ? duration(binding.setupStartedAt, binding.setupCompletedAt)
              : undefined;
          }),
        ),
        failures: managed.filter((run) => run.workspaceBinding?.setupState === "failed")
          .length,
        retries: managed.reduce(
          (sum, run) => sum + Math.max(0, (run.workspaceBinding?.setupAttempt ?? 0) - 1),
          0,
        ),
      },
      execution: {
        queueDuration: summarize(
          steps.map((step) =>
            step.dispatchedAt ? duration(step.createdAt, step.dispatchedAt) : undefined,
          ),
        ),
        implementationDuration: summarize(
          steps.map((step) =>
            step.dispatchedAt && ["succeeded", "failed", "cancelled"].includes(step.state)
              ? duration(step.dispatchedAt, step.updatedAt)
              : undefined,
          ),
        ),
      },
      integration: {
        duration: summarize(
          integrations.map((entry) => duration(entry.createdAt, entry.updatedAt)),
        ),
        validationDuration: summarize(
          integrations.map((entry) =>
            entry.validationStartedAt && entry.validatedAt
              ? duration(entry.validationStartedAt, entry.validatedAt)
              : undefined,
          ),
        ),
        conflicts: integrations.filter((entry) => entry.conflicts.length > 0).length,
        reconciliationFailures: integrations.filter(
          (entry) => entry.state === "needs_reconciliation",
        ).length,
      },
      cleanup: {
        duration: summarize(
          worktrees.map((tree) =>
            tree.retainedAt && tree.removedAt
              ? duration(tree.retainedAt, tree.removedAt)
              : undefined,
          ),
        ),
        retained: worktrees.filter((tree) => tree.state === "retained").length,
        removed: worktrees.filter((tree) => tree.state === "removed").length,
      },
      compatibility: {
        sparseCheckout: worktrees.filter((tree) => tree.repositoryFeatures.sparseCheckout)
          .length,
        submodules: worktrees.filter((tree) => tree.repositoryFeatures.submodules).length,
        gitLfs: worktrees.filter((tree) => tree.repositoryFeatures.gitLfs).length,
        partialClone: worktrees.filter((tree) => tree.repositoryFeatures.partialClone)
          .length,
      },
    };
  });

  app.get("/api/worktrees/capabilities", async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.string() }).parse(request.query);
    return {
      managedWorktreesEnabled: store.getManagedWorktreesEnabled(),
      placements: store
        .listPlacements()
        .filter((placement) => placement.workspaceId === workspaceId)
        .map((placement) => {
          const node = store.getNode(placement.nodeId);
          return {
            placementId: placement.id,
            nodeId: placement.nodeId,
            nodeName: node?.name ?? "",
            supported: node?.capabilities.includes(MANAGED_WORKTREES_CAPABILITY) ?? false,
            online: node?.online ?? false,
            eligibility:
              "Repository-root, committed-base and Git-configuration checks run on the Node before dispatch.",
          };
        }),
    };
  });

  app.get("/api/runs/:id/worktree", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Task not found" });
    const worktree = store.worktreeForRun(id);
    const source = run.workspaceBinding?.sourcePlacementId
      ? store.getPlacement(run.workspaceBinding.sourcePlacementId)
      : undefined;
    return {
      binding: run.workspaceBinding,
      worktree,
      source,
      version: worktree?.version ?? 0,
      operations: store
        .listWorktreeOperations(run.workspaceBinding?.managedWorktreeId)
        .filter((entry) => entry.request.runId === id)
        .slice(-10),
      integrations: worktree ? store.listWorktreeIntegrations(worktree.id) : [],
      tombstones: worktree
        ? store
            .listWorktreeTombstones()
            .filter((entry) => entry.worktreeId === worktree.id)
        : [],
      sessions: store
        .listSessions()
        .filter((session) => session.runId === id)
        .map((session) => ({
          id: session.id,
          state: session.state,
          role: session.runRole,
          binding: session.executionBinding,
          stopRequested: session.stopRequested,
        })),
      targets: worktree
        ? store
            .listPlacements()
            .filter(
              (placement) =>
                placement.nodeId === worktree.nodeId && placement.workspaceId !== "chats",
            )
        : [],
    };
  });

  app.post("/api/runs/:id/worktree/:action", async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const kind = actions[action];
    if (!kind) return reply.code(404).send({ error: "Unknown worktree action" });
    if (!store.getRun(id)) return reply.code(404).send({ error: "Task not found" });
    const input = ActionSchema.parse(request.body);
    if (
      kind === "quiesce" &&
      input.confirm !== "STOP TASK AND SELECTED TARGET SESSIONS"
    ) {
      throw new WorktreeConflict(
        "confirmation_required",
        "Explicitly confirm stopping task and selected target sessions.",
      );
    }
    if (action === "retry-with-hooks" && input.confirm !== "ALLOW REPOSITORY GIT HOOKS") {
      throw new WorktreeConflict(
        "confirmation_required",
        "Explicitly confirm allowing repository Git hooks for this managed task.",
      );
    }
    if (action === "retry-with-hooks") {
      const run = store.getRun(id)!;
      store.setRunWorkspaceBinding(id, {
        ...run.workspaceBinding!,
        allowGitHooks: true,
      });
    }
    const retryBinding =
      action === "retry-create" || action === "retry-with-hooks"
        ? store.getRun(id)!.workspaceBinding
        : undefined;
    if (retryBinding) {
      const run = store.getRun(id)!;
      const binding = run.workspaceBinding!;
      store.setRunWorkspaceBinding(id, {
        ...binding,
        setupState: "running",
        setupAttempt: binding.setupAttempt + 1,
        setupCode: "",
        setupSummary: "",
        setupStartedAt: new Date().toISOString(),
        setupCompletedAt: "",
        error: "",
      });
    }
    let operation: WorktreeOperation;
    try {
      operation = await service.worktrees.request(id, {
        ...Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        ),
        kind: kind === "create" && !store.worktreeForRun(id) ? "reserve" : kind,
        ...(action === "retry-with-hooks" ? { allowGitHooks: true } : {}),
        actor: request.fleetSession?.administratorId || "operator",
      });
    } catch (error) {
      if (retryBinding) {
        store.setRunWorkspaceBinding(id, {
          ...retryBinding,
          setupAttempt: retryBinding.setupAttempt + 1,
          ...(action === "retry-with-hooks" ? { allowGitHooks: true } : {}),
        });
      }
      throw error;
    }
    if (!operation.result)
      return reply.code(202).send({
        operation,
        code: "awaiting_node",
        error:
          "Node acknowledgement is pending. Retry/reconcile uses the same durable operation; no timeout unlock occurred.",
      });
    if (!operation.result.ok)
      return reply.code(409).send({
        code: operation.result.code,
        error: operation.result.error,
        retryable: operation.result.retryable,
        operation,
      });
    return { operation };
  });
};
