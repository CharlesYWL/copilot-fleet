import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { NODE_ID_HEADER, NODE_SECRET_HEADER } from "@fleet/protocol";
import type { FleetStore } from "./store.js";
import { OPERATOR_COOKIE, readCookie, type OperatorAuth } from "./auth.js";

/** Names that always resolve to this machine, whatever the DNS says. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

/**
 * Routes that answer before anyone has signed in.
 *
 * `/api/nodes/register` is not one of the unauthenticated routes so much as one
 * authenticated by something else: it carries the enrollment token, which is
 * the only credential a machine has before it has any.
 */
const OPEN_PATHS = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/nodes/register",
]);

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

export type RequestGuardOptions = {
  store: FleetStore;
  auth: OperatorAuth;
  allowlist: HostAllowlist;
};

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

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the guard so a route can tell an operator from a node. */
    fleetNodeId?: string;
  }
}

/**
 * The one place that decides whether a request is allowed to exist.
 *
 * Registered before the routes so that a route added later is protected by
 * having been added at all, rather than by someone remembering to say so.
 */
export function registerRequestGuard(
  app: FastifyInstance,
  { store, auth, allowlist }: RequestGuardOptions,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const { pathname, isApi, isSocket } = classify(request.url);
    if (!isApi && !isSocket) return;

    // The node gateway carries its own credential in the first frame, and a
    // node dials whatever address it was enrolled with — a LAN IP, a forwarded
    // loopback port — so neither the cookie nor the name check applies to it.
    if (pathname === "/ws/node") return;

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

    if (pathname === "/api/nodes/register") return;

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
    if (origin !== undefined && !nameAllowed(origin, allowed)) {
      return reply.code(403).send({ error: "Cross-origin request refused" });
    }

    if (OPEN_PATHS.has(pathname)) return;
    if (!auth.verify(readCookie(request.headers.cookie, OPERATOR_COOKIE))) {
      return reply.code(401).send({ error: "Sign in to use this Host" });
    }
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
