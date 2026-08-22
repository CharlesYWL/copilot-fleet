import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  OPERATOR_COOKIE,
  SESSION_MAX_AGE_MS,
  clearedCookie,
  readCookie,
  sessionCookie,
  type OperatorAuth,
} from "../auth.js";

const LoginSchema = z.object({ password: z.string().min(1).max(512) });

export type AuthRouteOptions = { auth: OperatorAuth };

/**
 * Whether the browser reached us over TLS.
 *
 * A Dev Tunnel terminates TLS at the relay and forwards plain HTTP to
 * loopback, so the socket this process sees says nothing about what the
 * browser saw; the forwarded header is the only witness. Marking the cookie
 * `Secure` on a guess would be worse than not marking it: over plain HTTP the
 * browser would drop it and the operator could never sign in.
 */
function overTls(request: FastifyRequest): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (proto) return proto.split(",")[0]?.trim() === "https";
  return request.protocol === "https";
}

/** Sign in, sign out, and the question the page asks before it renders. */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, { auth }) => {
  app.get("/api/auth/status", async (request) => ({
    authenticated: auth.verify(readCookie(request.headers.cookie, OPERATOR_COOKIE)),
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const input = LoginSchema.parse(request.body);
    const outcome = auth.login(input.password);
    if (!outcome.ok) {
      return reply.code(outcome.status).send({ error: outcome.error });
    }
    return reply
      .header(
        "set-cookie",
        sessionCookie(outcome.token, overTls(request), SESSION_MAX_AGE_MS),
      )
      .send({ ok: true });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.revoke(readCookie(request.headers.cookie, OPERATOR_COOKIE));
    return reply.header("set-cookie", clearedCookie(overTls(request))).send({ ok: true });
  });
};
