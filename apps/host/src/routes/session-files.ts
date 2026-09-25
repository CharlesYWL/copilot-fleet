import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SESSION_FILE_PATH_MAX_LENGTH } from "@fleet/protocol";
import type { FleetService } from "../fleet-service.js";
import { attachmentDisposition } from "../session-files.js";

export type SessionFileRouteOptions = { service: FleetService };

/** Absolute, or relative to the session's working directory; the Node resolves it. */
const FileQuerySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(SESSION_FILE_PATH_MAX_LENGTH)
    .refine((value) => !value.includes("\0"), "Paths cannot contain NUL"),
});

const INVALID_PATH = `Give the path of one file, up to ${SESSION_FILE_PATH_MAX_LENGTH} characters.`;

/**
 * Files from the machine a session ran on, for the operator's browser.
 *
 * Plain GETs so the browser's own download manager can take the bytes — with
 * its progress, its cancel button and the disk rather than a tab's memory —
 * which the operator cookie already authenticates. `stat` exists so the page
 * can say what went wrong before it starts one: a download that fails after it
 * has begun leaves only a browser error behind.
 */
export const sessionFileRoutes: FastifyPluginAsync<SessionFileRouteOptions> = async (
  app,
  { service },
) => {
  app.get("/api/sessions/:id/files/stat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = FileQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: INVALID_PATH });
    const result = await service.files.stat(id, query.data.path);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.info;
  });

  // No HEAD: Fastify answers one by draining the body, which would pull the
  // whole file across the Node's connection only to throw it away.
  app.get(
    "/api/sessions/:id/files/download",
    { exposeHeadRoute: false },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = FileQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: INVALID_PATH });
      const download = await service.files.open(id, query.data.path);
      if (!download.ok) {
        return reply.code(download.status).send({ error: download.error });
      }
      request.log.info(
        {
          sessionId: id,
          nodeId: download.nodeId,
          path: download.info.path,
          bytes: download.info.size,
          actor: request.fleetHumanActor,
        },
        "Relaying a session file download",
      );
      try {
        // Always an attachment and never sniffed: a file an agent wrote is not
        // something to render on this origin, where it would run as the operator.
        reply
          .header("content-type", "application/octet-stream")
          .header("content-length", String(download.info.size))
          .header("content-disposition", attachmentDisposition(download.info.name))
          .header("cache-control", "no-store");
      } catch (error) {
        download.stream.destroy();
        throw error;
      }
      return reply.send(download.stream);
    },
  );
};
