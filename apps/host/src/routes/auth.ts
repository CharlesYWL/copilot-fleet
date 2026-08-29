import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  authErrorRedirect,
  type AuthErrorCode,
  type AuthStatus,
  type CodeLoginEndpoint,
} from "@fleet/protocol";
import {
  BINDING_COOKIE,
  BOOTSTRAP_COOKIE,
  OPERATOR_COOKIE,
  bindingCookie,
  bootstrapCookie,
  clearedBootstrapCookie,
  clearedCookie,
  readCookie,
  sessionCookie,
} from "../auth.js";
import { BOOTSTRAP_GRANT_TTL_MS } from "../auth/claim.js";
import { OPERATOR_SESSION_ABSOLUTE_MS } from "../auth/sessions.js";
import { newBinding, type FleetAuth } from "../auth/service.js";
import { hostnameOf } from "../request-guard.js";
import { requireAdministrator as administratorFor } from "./require-administrator.js";

const LoginSchema = z.object({ password: z.string().min(1).max(512) });
const BootstrapSchema = z.object({ code: z.string().min(1).max(256) });
const ConfigureSchema = z.object({
  tenantId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
});
const CodeStartSchema = z.object({
  invitation: z.string().min(1).max(256).optional(),
});

export const ENTRA_CALLBACK_PATH = "/api/auth/entra/callback";

export type AuthRouteOptions = { auth: FleetAuth };

/**
 * Which browser this is, invented if it has not said.
 *
 * Every limit that used to be keyed on an apparent source address is keyed on
 * this instead. It authorises nothing, so a caller who discards or forges it
 * gains nothing but a fresh set of counters — and the global bucket is what
 * answers somebody who does that at scale.
 */
function binding(request: FastifyRequest): { id: string; fresh: boolean } {
  const existing = readCookie(request.headers.cookie, BINDING_COOKIE);
  if (existing) return { id: existing, fresh: false };
  return { id: newBinding(), fresh: true };
}

function appendCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const list = Array.isArray(existing)
    ? existing.map(String)
    : existing === undefined
      ? []
      : [String(existing)];
  reply.header("set-cookie", [...list, cookie]);
}

/**
 * Where Microsoft is told to send the browser back to.
 *
 * `localhost` is the canonical name because that is what the app registration
 * lists, and Entra ignores the port for a localhost redirect — so a Host on any
 * port, or reached through any local forward, needs no extra registration. A
 * request that arrived under a name this Host never published has already been
 * refused by the endpoint policy before this is reached.
 */
function callbackUri(request: FastifyRequest): string {
  const host = request.headers.host ?? "";
  const port = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "";
  return `http://localhost${port ? `:${port}` : ""}${ENTRA_CALLBACK_PATH}`;
}

/**
 * Whether an authorization-code sign-in can complete on the name this request
 * arrived under, and what to do when it cannot.
 *
 * `localhost` is the canonical name because that is what the app registration
 * lists, and Entra ignores the port for a localhost redirect — so a Host on any
 * port, or reached through any local forward, needs no extra registration.
 * 127.0.0.1 is the same machine under a name Entra will not redirect to, and
 * whose Lax transaction cookie would not come back to the callback, so it is
 * offered the equivalent localhost URL rather than a login that cannot finish.
 */
export function codeLoginEndpoint(host: string | undefined): CodeLoginEndpoint {
  const name = hostnameOf(host);
  const authority = host ?? "";
  const port = authority.includes(":")
    ? authority.slice(authority.lastIndexOf(":") + 1)
    : "";
  if (name === "localhost") return { available: true, localForwardRequired: false };
  if (name === "::1" || name?.startsWith("127.")) {
    return {
      available: false,
      canonicalUrl: `http://localhost${port ? `:${port}` : ""}`,
      localForwardRequired: false,
    };
  }
  return { available: false, localForwardRequired: true };
}

const CODE_LOGIN_ELSEWHERE =
  "Open this Host as localhost before signing in with Microsoft.";
const CODE_LOGIN_FORWARD =
  "Authorization-code sign-in needs a localhost URL. Create a local tunnel forward, or use device sign-in when this tenant permits it.";

/** The same decision as a refusal body, for the routes that answer with JSON. */
function refuseCodeLogin(endpoint: CodeLoginEndpoint): {
  error: string;
  canonicalUrl?: string;
  localForwardRequired?: true;
} {
  if (endpoint.canonicalUrl) {
    return { error: CODE_LOGIN_ELSEWHERE, canonicalUrl: endpoint.canonicalUrl };
  }
  return { error: CODE_LOGIN_FORWARD, localForwardRequired: true };
}

/**
 * The front door: what this Host is, and the two proofs it takes to open it.
 *
 * Every route here answers before anybody is signed in, so each one states its
 * own rule rather than relying on the guard. The guard's job is to make sure
 * nothing else can be reached this way.
 */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, { auth }) => {
  app.get("/api/auth/status", async (request) => {
    const session = auth.verifySession(
      readCookie(request.headers.cookie, OPERATOR_COOKIE),
    );
    const authorized = session !== undefined && auth.sessionStillAuthorized(session);
    const administrator = session ? auth.administratorFor(session) : undefined;
    const config = auth.entraConfig();
    const status: AuthStatus = {
      state: auth.state(),
      authenticated: authorized,
      passwordEnabled: auth.passwordEnabled(),
      entraConfigured: config !== undefined,
      deviceFlowEnabled: auth.deviceFlowEnabled(),
      claimCodeRequired: !auth.claimed(),
      // Whether this endpoint can carry a credential at all, so the page can
      // explain a refusal instead of looping on a login that cannot finish.
      canSignIn: auth.mayIssueCredential(request.headers.host),
      // And whether the loopback flow can complete here, so the page can move
      // itself to the name Entra redirects back to rather than failing at the
      // callback with a transaction cookie that was set for a different one.
      codeLogin: codeLoginEndpoint(request.headers.host),
      ...(administrator
        ? {
            identity: {
              username: administrator.username,
              displayName: administrator.displayName,
            },
          }
        : {}),
      // Configuration, not a secret, and the only way an administrator can
      // check which registration this Host is actually pointed at.
      ...(authorized && config
        ? { entra: { tenantId: config.tenantId, clientId: config.clientId } }
        : {}),
    };
    return status;
  });

  app.post("/api/auth/bootstrap", async (request, reply) => {
    const input = BootstrapSchema.parse(request.body);
    const browser = binding(request);
    const secure = auth.secureCookies(request.headers.host);
    if (browser.fresh) appendCookie(reply, bindingCookie(browser.id, secure));
    const outcome = auth.redeemClaimCode(input.code, browser.id, request.headers.host);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    appendCookie(reply, bootstrapCookie(outcome.token, secure, BOOTSTRAP_GRANT_TTL_MS));
    return reply.send({ ok: true, expiresAt: new Date(outcome.expiresAt).toISOString() });
  });

  /**
   * The migration door: a bootstrap grant bought with the password this Host
   * already had.
   *
   * Unlisted in the guard's rules on purpose, so it inherits the operator
   * default — a live session and a CSRF proof — rather than restating them. The
   * service decides the rest, because "which credential signed this session in"
   * and "does this Host have an administrator yet" are its questions, not the
   * route's.
   */
  app.post("/api/auth/bootstrap/password", async (request, reply) => {
    const session = request.fleetSession;
    if (!session) return reply.code(401).send({ error: "Sign in to use this Host" });
    const browser = binding(request);
    const secure = auth.secureCookies(request.headers.host);
    const outcome = auth.grantPasswordBootstrap({
      session,
      binding: browser.id,
      host: request.headers.host,
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    // Only once the grant exists, so a refusal leaves the browser exactly as it
    // was rather than handing it an identity it never earned anything with.
    if (browser.fresh) appendCookie(reply, bindingCookie(browser.id, secure));
    appendCookie(reply, bootstrapCookie(outcome.token, secure, BOOTSTRAP_GRANT_TTL_MS));
    return reply.send({ ok: true, expiresAt: new Date(outcome.expiresAt).toISOString() });
  });

  app.post("/api/auth/configure", async (request, reply) => {
    const input = ConfigureSchema.parse(request.body);
    const config = auth.configureEntra(input);
    return reply.send({ ok: true, tenantId: config.tenantId, clientId: config.clientId });
  });

  app.post("/api/auth/code/start", async (request, reply) => {
    const endpoint = codeLoginEndpoint(request.headers.host);
    if (!endpoint.available) {
      return reply.code(409).send(refuseCodeLogin(endpoint));
    }
    const input = CodeStartSchema.parse(request.body ?? {});
    const browser = binding(request);
    const secure = auth.secureCookies(request.headers.host);
    if (browser.fresh) appendCookie(reply, bindingCookie(browser.id, secure));
    const outcome = await auth.startCodeLogin({
      binding: browser.id,
      bootstrapToken: readCookie(request.headers.cookie, BOOTSTRAP_COOKIE),
      host: request.headers.host,
      redirectUri: callbackUri(request),
      invitation: input.invitation,
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.send({ authorizationUrl: outcome.authorizationUrl });
  });

  /**
   * Where Microsoft sends the browser back to, whatever happened.
   *
   * Every outcome ends in a redirect into the app. A refusal used to answer
   * with a JSON body, which left the operator looking at `{"error":...}` in the
   * address bar with no console, no explanation they could act on, and no way
   * back — and the app is the only thing that can offer the next step.
   */
  app.get(ENTRA_CALLBACK_PATH, async (request, reply) => {
    const secure = auth.secureCookies(request.headers.host);
    const fail = (code: AuthErrorCode, message?: string) =>
      reply
        .header("set-cookie", clearedBootstrapCookie(secure))
        .redirect(authErrorRedirect(code, message), 302);

    const endpoint = codeLoginEndpoint(request.headers.host);
    if (!endpoint.available) {
      return fail("endpoint-refused", refuseCodeLogin(endpoint).error);
    }
    const query = request.query as Record<string, string | undefined>;
    if (query.error) {
      // `access_denied` is the person saying no, which is not a malfunction and
      // must not read as one. Microsoft's own description is not repeated: it
      // is provider output, and this value lands in an address bar.
      return fail(
        query.error === "access_denied" ? "cancelled" : "provider-unavailable",
        query.error === "access_denied"
          ? "That sign-in was cancelled."
          : "Microsoft did not complete that sign-in.",
      );
    }
    const browser = binding(request);
    let outcome: Awaited<ReturnType<typeof auth.completeCodeLogin>>;
    try {
      outcome = await auth.completeCodeLogin({
        state: query.state,
        code: query.code ?? "",
        binding: browser.id,
        host: request.headers.host,
      });
    } catch (error) {
      /*
       * Whatever this was, it was not something the service could name — which
       * makes it Fleet's own bug. It is logged as one, and the operator is
       * still returned to a page that can explain itself: a framework 500
       * leaves them with a JSON body in the address bar, no console, and no
       * way back.
       */
      request.log.error({ err: error }, "Microsoft sign-in failed unexpectedly");
      return fail("provider-unavailable", "Microsoft did not complete that sign-in.");
    }
    if (!outcome.ok) {
      return fail(outcome.code ?? "provider-unavailable", outcome.error);
    }
    appendCookie(reply, clearedBootstrapCookie(secure));
    appendCookie(
      reply,
      sessionCookie(outcome.session.token, secure, OPERATOR_SESSION_ABSOLUTE_MS),
    );
    return reply.redirect("/", 302);
  });

  /**
   * The optional fallback, for a browser that cannot reach a loopback listener.
   *
   * Off unless a Host has been shown its tenant permits it, so the usual answer
   * here is a named refusal that the page turns into local-forward instructions
   * rather than a login that hangs.
   */
  app.post("/api/auth/device/start", async (request, reply) => {
    const input = CodeStartSchema.parse(request.body ?? {});
    const browser = binding(request);
    const secure = auth.secureCookies(request.headers.host);
    if (browser.fresh) appendCookie(reply, bindingCookie(browser.id, secure));
    const outcome = await auth.startDeviceLogin({
      binding: browser.id,
      bootstrapToken: readCookie(request.headers.cookie, BOOTSTRAP_COOKIE),
      host: request.headers.host,
      // An invitation link is opened wherever the invited person is, which for
      // a remote administrator is the public URL — the one place the loopback
      // flow cannot finish. Dropping it here makes the link unusable for
      // exactly the people it exists to reach.
      invitation: input.invitation,
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    return reply.send(outcome.flow);
  });

  app.post("/api/auth/device/poll/:flowId", async (request, reply) => {
    const { flowId } = request.params as { flowId: string };
    const browser = binding(request);
    const outcome = await auth.pollDeviceLogin({
      flowId,
      binding: browser.id,
      host: request.headers.host,
    });
    const secure = auth.secureCookies(request.headers.host);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    appendCookie(reply, clearedBootstrapCookie(secure));
    appendCookie(
      reply,
      sessionCookie(outcome.session.token, secure, OPERATOR_SESSION_ABSOLUTE_MS),
    );
    return reply.send({ ok: true });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = LoginSchema.parse(request.body);
    const outcome = auth.passwordLogin(input.password, request.headers.host);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    const secure = auth.secureCookies(request.headers.host);
    return reply
      .header(
        "set-cookie",
        sessionCookie(outcome.session.token, secure, OPERATOR_SESSION_ABSOLUTE_MS),
      )
      .send({ ok: true });
  });

  app.get("/api/auth/csrf", async (request, reply) => {
    const session = auth.verifySession(
      readCookie(request.headers.cookie, OPERATOR_COOKIE),
    );
    if (!session) return reply.code(401).send({ error: "Sign in to use this Host" });
    return reply.send({ csrfToken: auth.sessions.csrfToken(session.tokenHash) });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(readCookie(request.headers.cookie, OPERATOR_COOKIE));
    return reply
      .header("set-cookie", clearedCookie(auth.secureCookies(request.headers.host)))
      .send({ ok: true });
  });

  /**
   * The administrator behind a request, for the decisions only a person may
   * make.
   *
   * A password session deliberately fails this: a shared secret identifies
   * nobody, so it cannot be the thing that decides who else gets in or which
   * administrator is removed. `recent` additionally demands an
   * authorization-code sign-in within the last ten minutes, because a device
   * flow can be started by an attacker and finished by a phished administrator.
   */
  const requireAdministrator = (
    request: FastifyRequest,
    reply: FastifyReply,
    recent: boolean,
  ) => administratorFor(auth, request, reply, recent);

  app.get("/api/auth/administrators", async (request, reply) => {
    // Listed by an administrator, not merely by an operator: in hybrid mode a
    // shared password is still a way in, and who else holds authority is the
    // administrators' own business.
    if (!requireAdministrator(request, reply, false)) return reply;
    return reply.send({
      administrators: auth.listAdministrators(),
      pending: auth.listPendingCandidates().map((invitation) => ({
        id: invitation.id,
        tenantId: invitation.candidateTenantId,
        objectId: invitation.candidateObjectId,
        username: invitation.candidateUsername,
        displayName: invitation.candidateDisplayName,
        consumedAt: invitation.consumedAt,
      })),
    });
  });

  app.post("/api/auth/administrator-invitations", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, true);
    if (!administrator) return reply;
    const invitation = auth.createInvitation(administrator.id);
    return reply.code(201).send(invitation);
  });

  app.delete("/api/auth/administrator-invitations/:id", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, false);
    if (!administrator) return reply;
    const { id } = request.params as { id: string };
    if (!auth.revokeInvitation(id)) {
      return reply.code(404).send({ error: "No such invitation" });
    }
    return reply.send({ ok: true });
  });

  app.post("/api/auth/administrator-invitations/:id/approve", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, true);
    if (!administrator) return reply;
    const { id } = request.params as { id: string };
    const approved = auth.approveCandidate(id, administrator.id);
    if (!approved) {
      return reply
        .code(404)
        .send({ error: "No candidate is waiting on that invitation" });
    }
    return reply.send({ administrator: approved });
  });

  app.post("/api/auth/administrator-invitations/:id/reject", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, true);
    if (!administrator) return reply;
    const { id } = request.params as { id: string };
    if (!auth.rejectCandidate(id, administrator.id)) {
      return reply
        .code(404)
        .send({ error: "No candidate is waiting on that invitation" });
    }
    return reply.send({ ok: true });
  });

  app.delete("/api/auth/administrators/:id", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, true);
    if (!administrator) return reply;
    const { id } = request.params as { id: string };
    if (!auth.removeAdministrator(id)) {
      return reply.code(409).send({
        error:
          "That administrator cannot be removed. The last active administrator has to stay.",
      });
    }
    return reply.send({ ok: true });
  });

  app.post("/api/auth/password/disable", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, true);
    if (!administrator) return reply;
    if (!auth.passwordEnabled()) {
      return reply.send({ ok: true, alreadyDisabled: true });
    }
    auth.disablePassword();
    return reply.send({ ok: true });
  });

  app.get("/api/security/audit", async (request, reply) => {
    if (!requireAdministrator(request, reply, false)) return reply;
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1_000);
    return reply.send({ events: auth.securityAudit(limit) });
  });

  /**
   * Finds out whether this tenant permits device sign-in at all.
   *
   * Kept separate from `/api/auth/device/start`, which is a way in and is
   * therefore gated on the setting: this one is a way to decide the setting,
   * asked by somebody who is already inside. Nothing is written until Microsoft
   * has actually completed a flow, so a tenant that blocks it stays blocked and
   * gets a named answer rather than a login that hangs.
   */
  app.post("/api/auth/device/verify", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, false);
    if (!administrator) return reply;
    const browser = binding(request);
    if (browser.fresh) {
      appendCookie(
        reply,
        bindingCookie(browser.id, auth.secureCookies(request.headers.host)),
      );
    }
    const outcome = await auth.startDeviceVerification({
      administratorId: administrator.id,
      binding: browser.id,
    });
    if (!outcome.ok) {
      return reply.code(outcome.status).send({
        error: outcome.error,
        ...(outcome.blocked ? { blocked: true } : {}),
      });
    }
    return reply.send(outcome.flow);
  });

  app.post("/api/auth/device/verify/:flowId", async (request, reply) => {
    const administrator = requireAdministrator(request, reply, false);
    if (!administrator) return reply;
    const { flowId } = request.params as { flowId: string };
    const outcome = await auth.completeDeviceVerification({
      flowId,
      binding: binding(request).id,
      administratorId: administrator.id,
    });
    if (!outcome.ok) {
      return reply.code(outcome.status).send({
        error: outcome.error,
        ...(outcome.blocked ? { blocked: true } : {}),
      });
    }
    return reply.send({ deviceFlowEnabled: true });
  });
};
