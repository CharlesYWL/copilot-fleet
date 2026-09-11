import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  MANAGED_WORKTREES_CAPABILITY,
  WorktreeConflict,
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
});

const actions: Readonly<Record<string, WorktreeOperationRequest["kind"]>> = {
  observe: "observe",
  reconcile: "reconcile",
  "retry-create": "create",
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
    return {
      binding: run.workspaceBinding,
      worktree,
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
    const operation = await service.worktrees.request(id, {
      ...Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
      kind: kind === "create" && !store.worktreeForRun(id) ? "reserve" : kind,
      actor: request.fleetSession?.administratorId || "operator",
    });
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
