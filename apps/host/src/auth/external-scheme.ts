import { hostnameOf } from "../request-guard.js";

/**
 * How a browser reached this Host, as far as the Host itself can know.
 *
 * Deliberately not derived from the socket, `x-forwarded-proto`, or an apparent
 * source address: every supported tunnel relays into `http://127.0.0.1:<port>`,
 * so all three describe the relay rather than the browser, and all three are
 * settable by whoever is calling. The only trustworthy witness is the set of
 * URLs this Host published for itself.
 */
export type ExternalScheme = "http" | "https";

export type ExternalEndpoint = {
  hostname: string;
  scheme: ExternalScheme;
  /** Which provider published it, or `public-url` for `FLEET_PUBLIC_URL`. */
  provider: string;
};

export type ExternalSchemeMap = ReadonlyMap<string, ExternalEndpoint>;

export type ExternalSchemeSources = {
  publicUrl: () => string | undefined;
  tunnels: () => readonly { provider: string; url: string | undefined }[];
};

const LOOPBACK_NAMES = new Set(["localhost", "::1"]);

function isLoopbackName(name: string): boolean {
  return LOOPBACK_NAMES.has(name) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function schemeOf(url: string): ExternalScheme | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  if (scheme === "https") return "https";
  if (scheme === "http") return "http";
  return undefined;
}

/**
 * The names this Host published, and the scheme it published each one under.
 *
 * Loopback names are left out on purpose. They are decided by the name itself
 * — `localhost` is loopback whatever a tunnel says — and adding them would let
 * a provider that happened to print a loopback URL claim authority over a
 * decision that does not need one.
 */
export function externalSchemeMap(sources: ExternalSchemeSources): ExternalSchemeMap {
  const map = new Map<string, ExternalEndpoint>();
  const add = (provider: string, url: string | undefined) => {
    if (!url) return;
    const hostname = hostnameOf(url);
    const scheme = schemeOf(url);
    if (!hostname || !scheme) return;
    if (isLoopbackName(hostname)) return;
    map.set(hostname, { hostname, scheme, provider });
  };
  add("public-url", sources.publicUrl());
  for (const tunnel of sources.tunnels()) add(tunnel.provider, tunnel.url);
  return map;
}

export type SchemeDecision =
  | { kind: "loopback" }
  | { kind: "external-https"; provider: string }
  | { kind: "external-http"; provider: string }
  | { kind: "unknown" };

/**
 * Which of the four cases a request's `Host` header falls into.
 *
 * The header is attacker-controlled, but the classification is not: an unknown
 * name lands in `unknown`, and `unknown` grants nothing. Claiming to be
 * `fleet.example.com` only helps if this Host published that name itself.
 */
export function classifyRequestHost(
  host: string | undefined,
  map: ExternalSchemeMap,
): SchemeDecision {
  const hostname = hostnameOf(host);
  if (!hostname) return { kind: "unknown" };
  if (isLoopbackName(hostname)) return { kind: "loopback" };
  const endpoint = map.get(hostname);
  if (!endpoint) return { kind: "unknown" };
  return endpoint.scheme === "https"
    ? { kind: "external-https", provider: endpoint.provider }
    : { kind: "external-http", provider: endpoint.provider };
}

/**
 * Whether a Fleet session or bootstrap grant may be issued over this endpoint.
 *
 * A plain-HTTP relay carries the cookie in clear text to anyone on the path, so
 * issuing one there is handing out the fleet. An unrecognised name gets the
 * same answer rather than the benefit of the doubt: a Host that guesses HTTPS
 * for names it never published is a Host that can be talked into it.
 */
export function sessionIssuanceAllowed(decision: SchemeDecision): boolean {
  return decision.kind === "loopback" || decision.kind === "external-https";
}

/**
 * Whether the cookie should carry `Secure`.
 *
 * Only for an endpoint published as HTTPS. Marking it on loopback HTTP makes
 * the browser drop the cookie, which locks the operator out of the one URL that
 * works without any tunnel at all.
 */
export function cookieSecure(decision: SchemeDecision): boolean {
  return decision.kind === "external-https";
}

/** A short, non-identifying label for the audit log. */
export function endpointLabel(decision: SchemeDecision): string {
  return decision.kind === "loopback" || decision.kind === "unknown"
    ? decision.kind
    : `${decision.kind}:${decision.provider}`;
}
