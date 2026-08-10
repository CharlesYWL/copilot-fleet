import { normalizeHostUrl, sameHostUrl } from "@fleet/protocol";

/** Enough to cover a couple of tunnel rotations without hoarding dead URLs. */
export const MAX_KNOWN_HOST_URLS = 4;

export type HostEndpoints = { hostUrl: string; knownHostUrls: string[] };

/**
 * Every address worth dialing, best first.
 *
 * The primary leads because it is either what the operator configured or the
 * last one that actually produced a welcome.
 */
export function hostUrlCandidates(endpoints: HostEndpoints): string[] {
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
  const knownHostUrls = hostUrlCandidates(endpoints)
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
export function nextHostUrl(endpoints: HostEndpoints, current: string): string {
  const candidates = hostUrlCandidates(endpoints);
  if (candidates.length === 0) return current;
  const index = candidates.findIndex((url) => sameHostUrl(url, current));
  // An address not in the list — the operator edited settings mid-dial — starts
  // the rotation from the top rather than being treated as position -1.
  return candidates[(index + 1) % candidates.length]!;
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
