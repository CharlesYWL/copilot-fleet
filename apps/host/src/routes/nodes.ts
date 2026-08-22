import type { FastifyPluginAsync } from "fastify";
import {
  RegisterNodeSchema,
  RenameNodeSchema,
  UpdateNodeSchema,
  errorMessage,
} from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";

export type NodeRouteOptions = {
  service: FleetService;
  enrollment: { token: string };
};

/** Node enrollment plus the rename/delete a browser drives from Settings. */
export const nodeRoutes: FastifyPluginAsync<NodeRouteOptions> = async (
  app,
  { service, enrollment },
) => {
  const { store } = service;

  app.get("/api/nodes", async () => store.listNodes());

  /**
   * Updates one Node, or every Node that is behind this Host.
   *
   * "Update all" is deliberately not all-or-nothing: with four machines, one
   * being busy or offline must not stop the other three from catching up, so
   * each is attempted and the refusals are reported alongside the successes.
   */
  app.post("/api/nodes/update", async () => {
    const results = service
      .staleNodeIds()
      .map((nodeId) => ({ nodeId, ...service.requestUpdate(nodeId) }));
    return {
      started: results.filter((result) => result.started).length,
      skipped: results
        .filter((result) => !result.started)
        .map((result) => result.reason ?? "Update refused"),
    };
  });

  app.post("/api/nodes/:id/update", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getNode(id)) return reply.code(404).send({ error: "Unknown node" });
    const input = UpdateNodeSchema.parse(request.body ?? {});
    const result = service.requestUpdate(id, { stopSessions: input.stopSessions });
    if (!result.started) {
      // The sessions in the way travel with the refusal so the browser can name
      // them, rather than making the operator go and look for what it meant.
      return reply.code(409).send({
        error: result.reason ?? "Update refused",
        ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
      });
    }
    return { started: true };
  });

  app.post("/api/nodes/register", async (request, reply) => {
    const input = RegisterNodeSchema.parse(request.body);
    if (input.enrollmentToken !== enrollment.token) {
      return reply.code(401).send({ error: "Invalid enrollment token" });
    }
    try {
      const { node, secret } = store.registerNode({
        name: input.name,
        os: input.os,
        arch: input.arch,
        version: input.version,
        revision: input.revision,
        capabilities: input.capabilities,
        agents: input.agents,
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
      if (node) {
        service.publishNode(node);
        // Without this the machine keeps calling itself the old name on its own
        // config page, and re-registering under it if it ever loses its
        // credentials — which would split one machine into two nodes.
        service.announceNodeName(node.id, node.name);
      }
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
