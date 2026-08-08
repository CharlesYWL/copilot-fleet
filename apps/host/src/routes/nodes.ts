import type { FastifyPluginAsync } from "fastify";
import { RegisterNodeSchema, RenameNodeSchema, errorMessage } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";

export type NodeRouteOptions = {
  service: FleetService;
  enrollmentToken: string;
};

/** Node enrollment plus the rename/delete a browser drives from Settings. */
export const nodeRoutes: FastifyPluginAsync<NodeRouteOptions> = async (
  app,
  { service, enrollmentToken },
) => {
  const { store } = service;

  app.get("/api/nodes", async () => store.listNodes());

  app.post("/api/nodes/register", async (request, reply) => {
    const input = RegisterNodeSchema.parse(request.body);
    if (input.enrollmentToken !== enrollmentToken) {
      return reply.code(401).send({ error: "Invalid enrollment token" });
    }
    try {
      const { node, secret } = store.registerNode({
        name: input.name,
        os: input.os,
        arch: input.arch,
        version: input.version,
        capabilities: input.capabilities,
        maxSessions: input.maxSessions,
        homeDir: input.homeDir,
      });
      return reply.code(201).send({ nodeId: node.id, secret });
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error, "Registration failed") });
    }
  });

  app.patch("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = RenameNodeSchema.parse(request.body);
    if (!store.getNode(id)) return reply.code(404).send({ error: "Unknown node" });
    try {
      const node = store.renameNode(id, input.name);
      if (node) service.publishNode(node);
      return node;
    } catch {
      return reply
        .code(409)
        .send({ error: `A node named "${input.name}" already exists` });
    }
  });

  app.delete("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getNode(id)) return reply.code(404).send({ error: "Unknown node" });
    try {
      store.deleteNode(id);
      // Deleting a node takes its placements with it, so the catalog moved too.
      service.publishCatalog();
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error, "Cannot delete node") });
    }
    service.evictNode(id, 4002, "Node deleted");
    return reply.code(204).send();
  });
};
