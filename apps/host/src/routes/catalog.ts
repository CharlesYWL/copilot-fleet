import type { FastifyPluginAsync } from "fastify";
import {
  CreatePlacementSchema,
  CreateWorkspaceSchema,
  UpdatePlacementSchema,
  UpdateWorkspaceSchema,
  errorMessage,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";

export type CatalogRouteOptions = { service: FleetService };

/**
 * Workspaces and the placements that bind them to a node path.
 *
 * They share a plugin because every write to either has to republish the whole
 * catalog: a placement is meaningless without its workspace, and deleting a
 * workspace takes its placements with it.
 */
export const catalogRoutes: FastifyPluginAsync<CatalogRouteOptions> = async (
  app,
  { service },
) => {
  const { store } = service;

  app.get("/api/workspaces", async () => store.listWorkspaces());
  app.get("/api/placements", async () => store.listPlacements());

  app.post("/api/workspaces", async (request, reply) => {
    const input = CreateWorkspaceSchema.parse(request.body);
    try {
      const workspace = store.createWorkspace(input.name, input.description);
      service.publishCatalog();
      return reply.code(201).send(workspace);
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error, "Workspace exists") });
    }
  });

  app.patch("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = UpdateWorkspaceSchema.parse(request.body);
    if (!store.getWorkspace(id)) {
      return reply.code(404).send({ error: "Unknown workspace" });
    }
    try {
      const workspace = store.updateWorkspace(id, input.name, input.description);
      service.publishCatalog();
      return workspace;
    } catch {
      return reply
        .code(409)
        .send({ error: `A workspace named "${input.name}" already exists` });
    }
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getWorkspace(id)) {
      return reply.code(404).send({ error: "Unknown workspace" });
    }
    try {
      store.deleteWorkspace(id);
      service.publishCatalog();
      return reply.code(204).send();
    } catch (error) {
      return reply
        .code(409)
        .send({ error: errorMessage(error, "Cannot delete workspace") });
    }
  });

  app.post("/api/placements", async (request, reply) => {
    const input = CreatePlacementSchema.parse(request.body);
    try {
      const placement = store.createPlacement(
        input.workspaceId,
        input.nodeId,
        input.localPath,
      );
      service.publishCatalog();
      return reply.code(201).send(placement);
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error, "Invalid placement") });
    }
  });

  app.patch("/api/placements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = UpdatePlacementSchema.parse(request.body);
    if (!store.getPlacement(id)) {
      return reply.code(404).send({ error: "Unknown placement" });
    }
    const placement = store.updatePlacement(id, input.localPath);
    service.publishCatalog();
    return placement;
  });

  app.delete("/api/placements/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getPlacement(id)) {
      return reply.code(404).send({ error: "Unknown placement" });
    }
    try {
      store.deletePlacement(id);
      service.publishCatalog();
      return reply.code(204).send();
    } catch (error) {
      return reply
        .code(409)
        .send({ error: errorMessage(error, "Cannot delete placement") });
    }
  });
};
