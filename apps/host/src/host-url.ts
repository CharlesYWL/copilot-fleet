import { isRotatingTunnelUrl, normalizeHostUrl } from "@fleet/protocol";

/**
 * Whether a URL is worth announcing to a machine that is not this one.
 *
 * The Host's own idea of its address falls back to loopback whenever no tunnel
 * is up and no `FLEET_PUBLIC_URL` is set, and loopback on a remote Node points
 * at that Node. Announcing it would take a working connection and aim it at
 * nothing, so a tunnel going down leaves Nodes on the URL they already have
 * rather than being told to follow the Host home.
 */
export function isDialableHostUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  // Brackets survive on IPv6 hostnames from some URL inputs.
  const bare = hostname.replace(/^\[|]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return false;
  if (bare === "::1" || bare === "::" || bare === "0.0.0.0") return false;
  return !/^127\./.test(bare);
}

/**
 * Whether a public URL is worth copying onto another machine.
 *
 * Dialable is necessary but not sufficient: a trycloudflare hostname is
 * reachable right now and gone after the next restart, so restoring it would
 * point every Node at an address that will never answer.
 */
export function isTransferableHostUrl(url: string): boolean {
  return isDialableHostUrl(url) && !isRotatingTunnelUrl(url);
}

export type HostUrlChange = { previous: string; next: string };

/**
 * Notices when the address Nodes should dial has moved.
 *
 * The first reading is only a baseline: at startup every Node is either absent
 * or has just connected using an address that demonstrably works, so there is
 * nothing to correct. After that a change is real news — a tunnel came up,
 * rotated, or was switched to another provider.
 *
 * Values that are not dialable still update the baseline even though they are
 * never announced. Without that, a tunnel that goes down and comes back under a
 * new name would be compared against the *old* tunnel URL, and the comparison
 * would be right for the wrong reason — it stops being right the moment the two
 * happen to match.
 */
export class HostUrlWatcher {
  private current: string | undefined;

  constructor(private readonly read: () => string) {}

  /** The change to announce, if this reading moved somewhere worth dialing. */
  check(): HostUrlChange | undefined {
    const next = normalizeHostUrl(this.read());
    const previous = this.current;
    this.current = next;
    if (previous === undefined) return undefined;
    if (previous === next || !isDialableHostUrl(next)) return undefined;
    return { previous, next };
  }
}

/**
 * Watches the Host's public address and tells connected Nodes when it moves.
 *
 * Polled rather than driven by the tunnel manager because the URL has more than
 * one source and none of them announce themselves: a provider CLI prints its
 * hostname some seconds after the Host asks it to start, and a tunnel running
 * as its own process publishes to a file this Host only ever reads.
 *
 * Starts the sweep; the returned handle must be cleared on shutdown.
 */
export function startHostUrlMonitor(
  resolveUrl: () => string,
  announceUrl: (hostUrl: string) => void,
  intervalMs = 5_000,
): NodeJS.Timeout {
  const watcher = new HostUrlWatcher(resolveUrl);
  // Seeds the baseline, so a Host that starts with a tunnel already up does not
  // treat its own first reading as a move.
  watcher.check();
  const timer = setInterval(() => {
    const change = watcher.check();
    if (change) announceUrl(change.next);
  }, intervalMs);
  timer.unref();
  return timer;
}
