import { isLoginWalledTunnelUrl, normalizeHostUrl, sameHostUrl } from "@fleet/protocol";

/** Enough to cover a couple of tunnel rotations without hoarding dead URLs. */
export const MAX_KNOWN_HOST_URLS = 4;

export type HostEndpoints = { hostUrl: string; knownHostUrls: string[] };

/**
 * How this node reaches the Host, fixed at launch by how it was started.
 *
 * `devtunnel` means the node runs its own `devtunnel connect` and the Host is
 * only ever reachable through the loopback port that forward reports. `direct`
 * means the node dials the Host's address itself — a LAN address, a named
 * Cloudflare tunnel, anything that answers without a local helper process.
 */
export type TunnelMode = "devtunnel" | "direct";

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|]$/g, "");
  } catch {
    return undefined;
  }
}

/** The loopback address a `devtunnel connect` forward binds on this machine. */
function isLoopbackUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return /^127\./.test(host) || host === "localhost" || host === "::1";
}

/**
 * Whether an address is one this node's tunnel mode could ever reach.
 *
 * The two modes are exclusive, and deliberately so. Mixing them is not a
 * fallback, it is a guarantee of failure at speed: a node behind a private
 * tunnel that dials the public `*.devtunnels.ms` URL is refused in about 60ms,
 * which is fast enough to drive the reconnect loop at its floor and, through
 * it, the tunnel recycler — so the node spends its outage destroying the one
 * client that could have ended it. Refusing to dial the other mode's addresses
 * is what keeps a failed dial slow enough to be honest about what it means.
 *
 * The addresses themselves are kept in `knownHostUrls` rather than deleted:
 * they are the record of where this Host has lived, and a node whose mode
 * changes later needs them.
 */
export function dialableInMode(url: string, mode: TunnelMode): boolean {
  if (!normalizeHostUrl(url)) return false;
  return mode === "devtunnel" ? isLoopbackUrl(url) : !isLoginWalledTunnelUrl(url);
}

/**
 * Every address worth dialing, best first.
 *
 * The primary leads because it is either what the operator configured or the
 * last one that actually produced a welcome.
 *
 * Addresses the mode cannot reach are filtered out. If that leaves nothing —
 * a devtunnel node whose forward has not reported a port yet — the primary is
 * offered anyway, because a node with no address at all cannot even report
 * that it is stuck.
 */
export function hostUrlCandidates(
  endpoints: HostEndpoints,
  mode: TunnelMode = "direct",
): string[] {
  const candidates = distinctHostUrls(endpoints);
  const reachable = candidates.filter((url) => dialableInMode(url, mode));
  if (reachable.length === 0) return candidates.slice(0, 1);
  // A node running its own forward has exactly one of them, and the primary is
  // it — `endpointsBehindLocalForward` promotes whichever port the CLI last
  // reported. Ports it used to bind are as dead as any other stale address and
  // refuse a dial just as fast, so rotating onto them would put the recycler
  // back on the clock this mode exists to take it off.
  return mode === "devtunnel" ? reachable.slice(0, 1) : reachable;
}

/**
 * Every address on record, deduplicated, primary first.
 *
 * Kept separate from {@link hostUrlCandidates} because bookkeeping and dialing
 * want different things: the fallback list has to survive addresses the current
 * mode cannot use, or switching a node's mode later would find nothing to
 * switch to.
 */
function distinctHostUrls(endpoints: HostEndpoints): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const url of [endpoints.hostUrl, ...endpoints.knownHostUrls]) {
    const key = normalizeHostUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(url);
  }
  return candidates;
}

/**
 * Adopts an address the Host announced, demoting the current one to a fallback.
 *
 * The Host is authoritative about where it lives, so the announcement wins — but
 * it is announcing over a connection that survived the move, which is not proof
 * that the *new* address is reachable from this machine. Keeping the address
 * that is working right now is what makes accepting the claim safe.
 */
export function adoptHostUrl(endpoints: HostEndpoints, announced: string): HostEndpoints {
  const next = announced.trim();
  if (!next || sameHostUrl(next, endpoints.hostUrl)) return endpoints;
  const knownHostUrls = distinctHostUrls(endpoints)
    .filter((url) => !sameHostUrl(url, next))
    .slice(0, MAX_KNOWN_HOST_URLS);
  return { hostUrl: next, knownHostUrls };
}

/**
 * The address to try after one failed to connect.
 *
 * Cycles rather than stopping at the end: the Host may simply be down, and
 * every candidate deserves another attempt when it comes back rather than the
 * node parking on whichever one happened to be last in the list.
 */
export function nextHostUrl(
  endpoints: HostEndpoints,
  current: string,
  mode: TunnelMode = "direct",
): string {
  const candidates = hostUrlCandidates(endpoints, mode);
  if (candidates.length === 0) return current;
  const index = candidates.findIndex((url) => sameHostUrl(url, current));
  // An address not in the list — the operator edited settings mid-dial — starts
  // the rotation from the top rather than being treated as position -1.
  return candidates[(index + 1) % candidates.length]!;
}

/**
 * The address to open the first dial of a connection with.
 *
 * Prefers what last worked, which is what the credentials remember, but never
 * at the cost of leading with an address this mode cannot reach: a devtunnel
 * node whose stored primary is a public `*.devtunnels.ms` URL would otherwise
 * open every reconnect with a guaranteed 404.
 */
export function firstDialUrl(
  endpoints: HostEndpoints,
  remembered: string,
  mode: TunnelMode = "direct",
): string {
  if (dialableInMode(remembered, mode)) return remembered;
  return hostUrlCandidates(endpoints, mode)[0] ?? remembered;
}

/**
 * Promotes the address that produced a welcome, if it was not already primary.
 *
 * Returns `undefined` when nothing changed, so the caller only writes to disk on
 * a real move instead of on every reconnect.
 */
export function promoteHostUrl(
  endpoints: HostEndpoints,
  connected: string,
): HostEndpoints | undefined {
  if (sameHostUrl(connected, endpoints.hostUrl)) return undefined;
  return adoptHostUrl(endpoints, connected);
}

/**
 * Files an announced address without moving to it.
 *
 * The Host is authoritative about where it lives, but not about how this node
 * gets there: a node running its own `devtunnel connect` reaches the Host on a
 * loopback port, and the public URL of that same tunnel would send it to a
 * login it cannot answer. Remembering the address without adopting it keeps the
 * record complete — a node whose mode changes later needs it — while leaving
 * the route that works in the primary slot.
 */
export function recordHostUrl(
  endpoints: HostEndpoints,
  announced: string,
): HostEndpoints {
  const next = announced.trim();
  if (!next || sameHostUrl(next, endpoints.hostUrl)) return endpoints;
  const knownHostUrls = [
    next,
    ...endpoints.knownHostUrls.filter((url) => !sameHostUrl(url, next)),
  ].slice(0, MAX_KNOWN_HOST_URLS);
  return { ...endpoints, knownHostUrls };
}

/**
 * The endpoints to dial when a local tunnel forward supplies the Host address.
 *
 * The forwarded port leads, because it is where the Host is reachable now. What
 * matters is that the address it displaces is *demoted* rather than dropped: a
 * private tunnel is one client process on one machine, and when it dies its
 * loopback port refuses every dial while the Host carries on serving perfectly
 * well at the public address this node already knew. Overwriting that address
 * left the node cycling a dead port forever with the one route that would have
 * worked erased from its own settings — reachable only by editing files on the
 * machine by hand.
 *
 * A forward that reports nothing yet changes nothing, so a tunnel that has not
 * come up cannot blank an address that works.
 */
export function endpointsBehindLocalForward<T extends HostEndpoints>(
  endpoints: T,
  forwardedUrl: string,
): T {
  if (!forwardedUrl.trim()) return endpoints;
  return { ...endpoints, ...adoptHostUrl(endpoints, forwardedUrl) };
}

/**
 * The endpoints to keep after an operator edits the Host URL by hand.
 *
 * A typed address is authoritative. Pointing a node at a different Host is a
 * deliberate act — it is what lets that Host run commands on this machine — and
 * every fallback was learned from the *old* Host's announcements. Keeping them
 * would let a typo, or a new Host that is not serving yet, quietly land this
 * node back on the Host it was just moved away from. An edit that leaves the
 * address alone keeps them.
 */
export function endpointsAfterOperatorEdit<T extends HostEndpoints>(
  previous: HostEndpoints,
  next: T,
): T {
  if (sameHostUrl(previous.hostUrl, next.hostUrl)) return next;
  return { ...next, knownHostUrls: [] };
}
