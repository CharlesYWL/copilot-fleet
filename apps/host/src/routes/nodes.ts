import type { FastifyPluginAsync } from "fastify";
import {
  EnrollNodeSchema,
  NodeEnrollmentChallengeSchema,
  RegisterNodeSchema,
  RenameNodeSchema,
  UpdateNodeSchema,
  errorMessage,
} from "@fleet/protocol";
import type { LegacyEnrollment } from "../config.js";
import type { FleetService } from "../fleet-service.js";
import type { NodeEnrollment } from "../auth/node-enrollment.js";

export type NodeRouteOptions = {
  service: FleetService;
  enrollment: LegacyEnrollment;
  /** The bound, grant-authorised path a new Node takes. */
  nodeEnrollment: NodeEnrollment;
  /** Whether this Host has anybody who can operate it yet. */
  enrollable: () => boolean;
};

/** Named once, because the three refusals below all point at the same door. */
const USE_A_GRANT =
  "This Fleet enrolls machines with a one-time grant. Generate a Connect command from Settings and run that on the new machine.";

/** Node enrollment plus the rename/delete a browser drives from Settings. */
export const nodeRoutes: FastifyPluginAsync<NodeRouteOptions> = async (
  app,
  { service, enrollment, nodeEnrollment, enrollable },
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

  /**
   * The Host's half of a bound enrolment: prove who this Host is.
   *
   * Reachable without a credential, because a machine that has not enrolled
   * cannot have one. What it costs an unauthenticated caller is bounded: the
   * grant id has to name a live grant, and nothing here reveals the secret that
   * would let one be spent.
   */
  app.post("/api/nodes/enrollment/challenge", async (request, reply) => {
    const input = NodeEnrollmentChallengeSchema.parse(request.body);
    const outcome = nodeEnrollment.challenge(input);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.send(outcome.response);
  });

  /**
   * Registration, by either protocol.
   *
   * The bound completion is tried first and is recognised by its shape rather
   * than by a flag: a body carrying a challenge id and two proofs is not a
   * token registration, and the fleet-wide token can never authorise one. That
   * separation is what keeps the legacy credential from being an upgrade path
   * into the key-based protocol.
   */
  app.post("/api/nodes/register", async (request, reply) => {
    /*
     * Somebody has to own this Host first. A machine that joins one nobody can
     * operate has been added by nobody — and the fleet-wide token, being a
     * static string, is enough to do it. Both protocols are refused, because
     * the ordering is about ownership rather than which credential was
     * offered. A Host still on a password is owned, just not by a Microsoft
     * identity, so it enrols as before.
     */
    if (!enrollable()) {
      return reply.code(423).send({
        error:
          "This Fleet has not been claimed yet. Claim it with the code on the Host console, then generate a Connect command from Settings.",
      });
    }
    const bound = EnrollNodeSchema.safeParse(request.body);
    if (bound.success) {
      const outcome = nodeEnrollment.complete(bound.data);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
      service.publishNode(outcome.node);
      service.publishCatalog();
      return reply.code(201).send(outcome.receipt);
    }

    const input = RegisterNodeSchema.parse(request.body);
    /*
     * The fleet-wide token mints a reusable secret from a static string, which
     * is the credential the key protocol exists to replace. It has to keep
     * working while machines that predate keys do — but a Host that never had
     * one, or whose operator has declared the shared secret over, must not
     * accept this path at all. Leaving it open on a Host with no token would
     * be worse than useless: there would be nothing to compare against.
     */
    if (store.mutualNodeAuthenticationRequired() || enrollment.token === undefined) {
      return reply.code(403).send({ error: USE_A_GRANT });
    }
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
