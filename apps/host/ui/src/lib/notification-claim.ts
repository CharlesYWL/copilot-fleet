const CLAIM_PREFIX = "fleet.notification.claim.";
const CLAIM_TTL_MS = 30_000;
export const VISIBLE_ELECTION_DELAY_MS = 50;
export const BROWSER_ELECTION_DELAY_MS = 100;
const owner = Math.random().toString(36).slice(2);
const memoryClaims = new Map<string, number>();

type ClaimMessage = { type: "claimed"; id: string; at: number };
export type LiveNotificationClaim = "suppress" | "visible" | "browser" | "sound";

let channel: BroadcastChannel | undefined;

function claimChannel(): BroadcastChannel | undefined {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel("fleet-notification-delivery");
    channel.onmessage = (event: MessageEvent<ClaimMessage>) => {
      const message = event.data;
      if (message?.type === "claimed" && message.id) {
        memoryClaims.set(message.id, message.at);
      }
    };
  } catch {
    return undefined;
  }
  return channel;
}

function recent(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < CLAIM_TTL_MS;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fallbackClaim(id: string, now: number): boolean {
  for (const [claimedId, claimedAt] of memoryClaims) {
    if (!recent(claimedAt, now)) memoryClaims.delete(claimedId);
  }
  const remembered = memoryClaims.get(id);
  if (recent(remembered, now)) return false;

  const key = CLAIM_PREFIX + id;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const storedKey = localStorage.key(index);
      if (!storedKey?.startsWith(CLAIM_PREFIX)) continue;
      try {
        const claim = JSON.parse(localStorage.getItem(storedKey) ?? "null") as {
          at?: number;
        } | null;
        if (!claim || !recent(claim.at, now)) localStorage.removeItem(storedKey);
      } catch {
        localStorage.removeItem(storedKey);
      }
    }
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as {
      owner?: string;
      at?: number;
    } | null;
    if (stored && recent(stored.at, now)) {
      memoryClaims.set(id, stored.at!);
      return false;
    }

    localStorage.setItem(key, JSON.stringify({ owner, at: now }));
    const written = JSON.parse(localStorage.getItem(key) ?? "null") as {
      owner?: string;
      at?: number;
    } | null;
    if (written?.owner !== owner || written.at !== now) return false;
  } catch {
    // BroadcastChannel and this tab's memory still provide a best-effort election.
  }

  memoryClaims.set(id, now);
  claimChannel()?.postMessage({ type: "claimed", id, at: now } satisfies ClaimMessage);
  return true;
}

/**
 * Best-effort claim for transient delivery across tabs.
 *
 * Durable in-app records are shown everywhere. This only prevents several open
 * tabs from all chiming or raising the same browser notification.
 */
export async function claimLiveNotification(
  id: string,
  claim: LiveNotificationClaim,
  stillEligible: () => boolean = () => true,
): Promise<boolean> {
  if (claim !== "suppress") {
    // A tab already showing the target suppresses all transient delivery.
    // Otherwise, visible toasts get a brief head start over browser alerts.
    await wait(
      claim === "visible" ? VISIBLE_ELECTION_DELAY_MS : BROWSER_ELECTION_DELAY_MS,
    );
  }
  if (!stillEligible()) return false;

  const locks = navigator.locks;
  if (locks) {
    try {
      return await locks.request(
        `fleet-notification-delivery:${id}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock || !stillEligible()) return false;
          return fallbackClaim(id, Date.now());
        },
      );
    } catch {
      if (!stillEligible()) return false;
      return fallbackClaim(id, Date.now());
    }
  }
  return fallbackClaim(id, Date.now());
}

export function resetNotificationClaimsForTest(): void {
  memoryClaims.clear();
}
