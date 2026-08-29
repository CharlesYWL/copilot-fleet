import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  NODE_ID_HEADER,
  NODE_PROOF_NONCE_HEADER,
  NODE_PROOF_SIGNATURE_HEADER,
  NODE_PROOF_TIMESTAMP_HEADER,
  NODE_SECRET_HEADER,
} from "@fleet/protocol";
import {
  NODE_HTTP_PROOF_WINDOW_MS,
  verifyNodeHttpProof,
} from "@fleet/protocol/node-auth";
import type { FleetStore } from "./store.js";
import { BINDING_COOKIE, BOOTSTRAP_COOKIE, OPERATOR_COOKIE, readCookie } from "./auth.js";
import { isStateChanging, requiredPrincipal } from "./auth/guard-rules.js";
import type { FleetAuth } from "./auth/service.js";
import type { ActiveSession } from "./auth/sessions.js";
import type { SchemeDecision } from "./auth/external-scheme.js";

/**
 * Names that always mean this machine.
 *
 * The unspecified addresses (`0.0.0.0`, `::`) are deliberately not here: they
 * are what a socket binds to, not a name a browser should be reaching us
 * under, and on most platforms a page fetching `http://0.0.0.0:8787` lands on
 * loopback anyway — which is exactly the request this check exists to refuse.
 */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * What a node may reach with its own secret.
 *
 * The node's config page cannot call the Host from the browser — different
 * origin, no CORS — so the node process relays those calls. That relay is the
 * only reason a node needs the HTTP API at all, and it only ever needs the
 * catalog, so nothing else is opened to a node's credentials.
 */
const NODE_METHOD_PATHS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/api\/workspaces$/ },
  { method: "POST", pattern: /^\/api\/workspaces$/ },
  { method: "PATCH", pattern: /^\/api\/workspaces\/[^/]+$/ },
  { method: "GET", pattern: /^\/api\/placements$/ },
  { method: "POST", pattern: /^\/api\/placements$/ },
  { method: "PATCH", pattern: /^\/api\/placements\/[^/]+$/ },
];

export function nodeReachable(method: string, pathname: string): boolean {
  return NODE_METHOD_PATHS.some(
    (route) => route.method === method.toUpperCase() && route.pattern.test(pathname),
  );
}

/** The hostname part of a `Host` or `Origin` value, lowercased and unbracketed. */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split("/")[0] ?? "";
  const bracketed = /^\[([^\]]+)]/.exec(authority);
  if (bracketed) return bracketed[1]?.toLowerCase();
  const [host] = authority.split(":");
  return host ? host.toLowerCase() : undefined;
}

export type HostAllowlist = {
  /** `FLEET_ALLOWED_HOSTS`, plus the URLs the Host knows it is reachable at. */
  extra?: string | undefined;
  publicUrl?: () => string | undefined;
  tunnelUrls?: () => readonly string[];
};

/**
 * Every name this Host answers to.
 *
 * A browser reaching the Host under a name nobody configured is the shape of a
 * DNS rebinding attack: the page starts on the attacker's domain, the name is
 * re-pointed at 127.0.0.1, and from then on the attacker's script is
 * same-origin with an administrative API. The names are collected rather than
 * fixed because the legitimate ones move — a tunnel rotates, an operator sets
 * a public URL — and a check that has to be switched off to keep working is
 * not a check.
 */
export function allowedHostnames(allowlist: HostAllowlist): Set<string> {
  const names = new Set(LOOPBACK_NAMES);
  const add = (value: string | undefined) => {
    const name = hostnameOf(value);
    if (name) names.add(name);
  };
  add(allowlist.publicUrl?.());
  for (const url of allowlist.tunnelUrls?.() ?? []) add(url);
  for (const entry of (allowlist.extra ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed) names.add(trimmed.replace(/^\[|]$/g, "").toLowerCase());
  }
  return names;
}

/** Any 127.x.x.x is this machine, and a `Host` may name any of them. */
function isLoopback(name: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

export function nameAllowed(
  value: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (allowed.has("*")) return true;
  const name = hostnameOf(value);
  if (!name) return false;
  return allowed.has(name) || isLoopback(name);
}

/**
 * A browser origin must match the complete origin the Host expects.
 *
 * Cookies are not port-scoped and WebSockets are not protected by the browser's
 * same-origin policy, so comparing only `localhost` would let any unrelated
 * local web app read Fleet's live transcript stream.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  decision: SchemeDecision,
): boolean {
  if (origin === undefined) return true;
  if (!host || decision.kind === "unknown") return false;
  const scheme =
    decision.kind === "external-https"
      ? "https"
      : decision.kind === "external-http"
        ? "http"
        : "http";
  try {
    return new URL(origin).origin === new URL(`${scheme}://${host}`).origin;
  } catch {
    return false;
  }
}

export type RequestGuardOptions = {
  store: FleetStore;
  auth: FleetAuth;
  allowlist: HostAllowlist;
};

/**
 * Whether a credential may cross this endpoint at all.
 *
 * The same judgement `sessionIssuanceAllowed` makes about a browser cookie,
 * applied to the two other credentials that reach this Host over the wire: the
 * lead token an orchestrator presents, and the reusable secret a legacy
 * enrolment answers with. Loopback never leaves the machine and an endpoint
 * this Host published as HTTPS is protected by the tunnel's own TLS; anything
 * else — a `bore` relay, a LAN address someone typed into `FLEET_PUBLIC_URL` —
 * carries them in clear text. An unrecognised name is not refused here, because
 * the name check above has already had its say about those.
 */
function confidentialEndpoint(decision: SchemeDecision): boolean {
  return decision.kind !== "external-http";
}

const PLAIN_HTTP_REFUSAL =
  "This Host will not send credentials over a plain-HTTP address. Publish it over HTTPS, or reach it on loopback.";

type Guarded = { pathname: string; isApi: boolean; isSocket: boolean };

function classify(url: string): Guarded {
  const pathname = url.split("?")[0] ?? url;
  return {
    pathname,
    isApi: pathname.startsWith("/api/"),
    isSocket: pathname.startsWith("/ws/"),
  };
}

function nodeCredentials(
  request: FastifyRequest,
): { id: string; secret: string } | undefined {
  const id = request.headers[NODE_ID_HEADER];
  const secret = request.headers[NODE_SECRET_HEADER];
  if (typeof id !== "string" || typeof secret !== "string") return undefined;
  return { id, secret };
}

/** The header, when it arrived exactly once. */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

type PresentedNodeProof = {
  id: string;
  timestamp: string;
  nonce: string;
  signature: string;
};

function nodeProof(request: FastifyRequest): PresentedNodeProof | undefined {
  const id = header(request, NODE_ID_HEADER);
  const timestamp = header(request, NODE_PROOF_TIMESTAMP_HEADER);
  const nonce = header(request, NODE_PROOF_NONCE_HEADER);
  const signature = header(request, NODE_PROOF_SIGNATURE_HEADER);
  if (!id || !timestamp || !nonce || !signature) return undefined;
  return { id, timestamp, nonce, signature };
}

/**
 * The bytes the Node signed, as this Host received them.
 *
 * Fastify has already parsed the body by the time a route runs, but the guard
 * runs on `onRequest` — before a byte of it has been read — so the only body a
 * proof can be checked against here is one that has not arrived yet. Hence the
 * raw text is read in `preValidation` instead, and the guard's job at this
 * point is the part that does not depend on it.
 */
export const NODE_PROOF_NONCE_TTL_MS = NODE_HTTP_PROOF_WINDOW_MS * 2;

/**
 * Every nonce a Node has spent while its proof could still be replayed.
 *
 * A signature says who made a proof, never that it is new, so without this a
 * captured request could be repeated for as long as its clock window lasts.
 * Bounded on both axes: entries expire once no proof carrying them could still
 * verify, and the oldest are dropped past a ceiling — this is fed by anything
 * that can reach the Host with a node id header, so it must not be a way to
 * make the Host spend memory.
 */
export class NodeProofNonces {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly limit: number;

  constructor(options: { ttlMs?: number; limit?: number } = {}) {
    this.ttlMs = options.ttlMs ?? NODE_PROOF_NONCE_TTL_MS;
    this.limit = options.limit ?? 5_000;
  }

  get size(): number {
    return this.seen.size;
  }

  /** True the first time this Node presents this nonce, false every time after. */
  claim(nodeId: string, nonce: string, now: number = Date.now()): boolean {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(key);
    }
    const key = `${nodeId}\u0000${nonce}`;
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.seen.delete(key);
    this.seen.set(key, now + this.ttlMs);
    // Insertion order is expiry order, so the first key is always the one with
    // the least time left to protect anything.
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return true;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the guard so a route can tell an operator from a node. */
    fleetNodeId?: string;
    /** Set by the guard for every route that runs as an operator. */
    fleetSession?: ActiveSession;
    /**
     * The JSON body exactly as it arrived, kept only so a Node's signature can
     * be checked against the bytes the Host will act on rather than against a
     * re-serialisation of them.
     */
    fleetRawBody?: string;
    /** A signed Node call recognised on `onRequest`, verified on `preValidation`. */
    fleetNodeProof?: PresentedNodeProof & { publicKey: string; pathname: string };
  }
}

/**
 * The one place that decides whether a request is allowed to exist.
 *
 * Registered before the routes so that a route added later is protected by
 * having been added at all, rather than by someone remembering to say so. The
 * literal open-path set this replaced could not express a parameterized route,
 * and every credential that was not an operator cookie — the node gateway, the
 * orchestrator's bearer token — was handled by an early `return` that reads
 * exactly like having no rule. Each route now names the principal it expects.
 */
export function registerRequestGuard(
  app: FastifyInstance,
  { store, auth, allowlist }: RequestGuardOptions,
): void {
  const nonces = new NodeProofNonces();

  /*
   * Overrides Fastify's own JSON parser to keep the bytes it was handed.
   *
   * A Node signs the body it sent, and re-serialising the parsed value here to
   * check that signature would make two JSON writers agreeing the thing the
   * proof depends on. Route-level body limits still apply: `parseAs` is
   * Fastify's own reader, and this only adds a copy of what it read.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, payload, done) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      request.fleetRawBody = text;
      if (text.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        // Shaped like Fastify's own so a malformed body is still a 400.
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  app.addHook("onRequest", async (request, reply) => {
    const { pathname, isApi, isSocket } = classify(request.url);
    const principal = requiredPrincipal(request.method, pathname);
    if (!isApi && !isSocket && principal !== "lead") return;

    // The node gateway carries its own credential in the first frame, and a
    // node dials whatever address it was enrolled with — a LAN IP, a forwarded
    // loopback port — so neither the cookie nor the name check applies to it.
    if (principal === "node-protocol") return;

    /*
     * The orchestrator's tool endpoint is a second control plane rather than
     * an operator-cookie exception: it is called by an agent process, with a
     * bearer token scoped to one live lead, and its own route does that part.
     *
     * What it does not get is an early `return`, which is what it had — and an
     * early return reads exactly like having no rule at all. The two questions
     * the guard asks everywhere else are asked here too, because this endpoint
     * is reachable through whatever tunnel the Host is published on: the name
     * the request claims to have arrived under must be one this Host answers
     * to, and a browser must not be able to reach it however good its token is.
     */
    if (principal === "lead") {
      if (!nameAllowed(request.headers.host, allowedHostnames(allowlist))) {
        auth.audit({
          eventType: "mcp_request_host_rejected",
          actorKind: "lead",
          outcome: "denied",
          requestHost: (hostnameOf(request.headers.host) ?? "").slice(0, 100),
          detail: "host name is not one this Fleet answers to",
        });
        return reply.code(403).send({
          error:
            "Refused a request for an unrecognised host name. Set FLEET_PUBLIC_URL, or list the name in FLEET_ALLOWED_HOSTS.",
        });
      }
      /*
       * A lead token is a bearer credential for the orchestrator's whole tool
       * surface — starting sessions, reading transcripts, dispatching work —
       * and it travels in a header on every call. Over an address this Host
       * published as plain HTTP, that header is readable to everyone on the
       * path, and the token is valid for whoever picks it up. The console
       * already refuses to issue a session over such an address; the same
       * reasoning is what makes this endpoint unreachable there.
       */
      if (!confidentialEndpoint(auth.classify(request.headers.host))) {
        auth.audit({
          eventType: "mcp_request_host_rejected",
          actorKind: "lead",
          outcome: "denied",
          requestHost: (hostnameOf(request.headers.host) ?? "").slice(0, 100),
          detail: "plain HTTP endpoint",
        });
        return reply.code(403).send({ error: PLAIN_HTTP_REFUSAL });
      }
      // Any `Origin` at all, rather than a mismatched one: nothing that
      // belongs on this endpoint is sent by a browser, so the header's
      // presence is the refusal.
      if (request.headers.origin !== undefined) {
        auth.audit({
          eventType: "mcp_browser_origin_rejected",
          actorKind: "lead",
          outcome: "denied",
          requestHost: (hostnameOf(request.headers.host) ?? "").slice(0, 100),
          detail: "browser origin",
        });
        return reply.code(403).send({ error: "Cross-origin request refused" });
      }
      return;
    }

    /*
     * A keyed Node proves each call rather than presenting a credential, so
     * there is nothing here to compare — only a signature, and it is over the
     * body, which has not been read yet on this hook. What can be settled now
     * is settled now: that the Node has a key at all, and that the path is one
     * a Node may reach. The proof itself is checked in `preValidation` below,
     * before any route sees the request, and `fleetNodeId` is set only there.
     */
    const proof = nodeProof(request);
    if (proof) {
      const publicKey = store.nodePublicKey(proof.id);
      if (!publicKey) {
        return reply.code(401).send({ error: "Invalid node credentials" });
      }
      if (!nodeReachable(request.method, pathname)) {
        return reply.code(403).send({ error: "Not available to a node" });
      }
      request.fleetNodeProof = { ...proof, publicKey, pathname };
      return;
    }

    const credentials = nodeCredentials(request);
    if (credentials) {
      if (!store.authenticateNode(credentials.id, credentials.secret)) {
        return reply.code(401).send({ error: "Invalid node credentials" });
      }
      if (!nodeReachable(request.method, pathname)) {
        return reply.code(403).send({ error: "Not available to a node" });
      }
      request.fleetNodeId = credentials.id;
      return;
    }

    if (principal === "enrollment") {
      /*
       * The one enrollment path that answers with a reusable credential.
       *
       * `/api/nodes/register` with a fleet-wide token mints a node secret and
       * puts it in the response body; the bound path beside it sends nothing
       * reusable in either direction, but the guard cannot tell them apart
       * before the body is read. Refusing both over an address this Host
       * published as plain HTTP is the safe reading: a bound enrolment over
       * such an address is one whose whole subsequent connection — lead tokens
       * included — is readable anyway.
       */
      if (!confidentialEndpoint(auth.classify(request.headers.host))) {
        auth.audit({
          eventType: "node_enrollment_endpoint_rejected",
          actorKind: "enrollment",
          outcome: "denied",
          requestHost: (hostnameOf(request.headers.host) ?? "").slice(0, 100),
          detail: "plain HTTP endpoint",
        });
        return reply.code(403).send({ error: PLAIN_HTTP_REFUSAL });
      }
      return;
    }

    const allowed = allowedHostnames(allowlist);
    if (!nameAllowed(request.headers.host, allowed)) {
      return reply.code(403).send({
        error:
          "Refused a request for an unrecognised host name. Set FLEET_PUBLIC_URL, or list the name in FLEET_ALLOWED_HOSTS.",
      });
    }
    // A cross-site WebSocket handshake is not blocked by the same-origin policy
    // the way a fetch is, so the only thing standing between a page the
    // operator visits and a live transcript stream is this.
    const origin = request.headers.origin;
    if (
      !originAllowed(origin, request.headers.host, auth.classify(request.headers.host))
    ) {
      return reply.code(403).send({ error: "Cross-origin request refused" });
    }

    if (principal === "anonymous") return;

    /*
     * A bootstrap grant configures Entra and starts the first login and does
     * nothing else. It is checked here rather than in the route so that a
     * second configuration route added later inherits the rule.
     */
    if (principal === "bootstrap") {
      const grant = auth.claim.verifyBootstrap(
        readCookie(request.headers.cookie, BOOTSTRAP_COOKIE),
        // Bound to the browser that earned it: a copied cookie replayed from
        // somewhere else is exactly what this refuses.
        readCookie(request.headers.cookie, BINDING_COOKIE) ?? "",
      );
      if (!grant) {
        return reply.code(401).send({
          error: "Enter the claim code printed on the Host console first.",
        });
      }
      return;
    }

    // The login transaction is a capability the route itself has to match
    // against stored state, so the guard only insists that nothing else rides
    // in on the same path.
    if (principal === "transaction") return;

    const session = auth.verifySession(
      readCookie(request.headers.cookie, OPERATOR_COOKIE),
    );
    if (!session || !auth.sessionStillAuthorized(session)) {
      return reply.code(401).send({ error: "Sign in to use this Host" });
    }
    /*
     * `SameSite=Strict` already keeps another site from sending the cookie, but
     * it is one browser setting away from not being true, and a fleet-wide
     * command runner is not the place to depend on a single control. The proof
     * is derived from the session, so there is nothing extra to store and
     * nothing to keep in step.
     */
    if (isStateChanging(request.method)) {
      const presented = request.headers["x-csrf-token"];
      const token = Array.isArray(presented) ? presented[0] : presented;
      if (!auth.sessions.verifyCsrf(session.tokenHash, token)) {
        return reply.code(403).send({ error: "Missing or invalid CSRF token" });
      }
    }
    request.fleetSession = session;
  });

  app.addHook("preValidation", async (request, reply) => {
    const proof = request.fleetNodeProof;
    if (!proof) return;
    const verified = verifyNodeHttpProof({
      publicKey: proof.publicKey,
      nodeId: proof.id,
      method: request.method,
      path: proof.pathname,
      body: request.fleetRawBody ?? "",
      timestamp: proof.timestamp,
      nonce: proof.nonce,
      signature: proof.signature,
    });
    // A nonce is claimed only once the proof carrying it is real, so a stream
    // of forgeries cannot spend the nonces a working Node is about to use.
    if (!verified.ok || !nonces.claim(proof.id, proof.nonce)) {
      auth.audit({
        eventType: "node_proof_rejected",
        actorKind: "node",
        actorId: proof.id,
        outcome: "denied",
        detail: verified.ok ? "replayed proof" : verified.reason,
      });
      return reply.code(401).send({ error: "Invalid node credentials" });
    }
    request.fleetNodeId = proof.id;
  });

  app.addHook("onSend", async (_request, reply: FastifyReply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    // Nothing here is meant to be embedded, and an administrative UI in an
    // invisible frame is a click away from being driven by the page around it.
    reply.header("content-security-policy", "frame-ancestors 'none'");
    return payload;
  });
}
