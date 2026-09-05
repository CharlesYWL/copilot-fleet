import { errorMessage } from "@fleet/protocol";

export type DeviceFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  message: string;
  /** ISO timestamp; the code stops working here whatever the page does. */
  expiresAt: string;
};

export type DevicePollOutcome =
  | { outcome: "signed-in" }
  | { outcome: "expired" }
  | { outcome: "abandoned" }
  | { outcome: "denied"; message: string };

export type DevicePollInput = {
  flowId: string;
  /** Milliseconds since the epoch, from the flow the Host started. */
  expiresAt: number;
  /** Which endpoint completes the flow; verification writes a setting instead. */
  path?: string;
  intervalMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Extra headers, so a state-changing poll can carry its CSRF proof. */
  headers?: Record<string, string>;
};

const DEFAULT_INTERVAL_MS = 3_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the Host whether the device code has been answered yet, until it is or
 * until the code dies.
 *
 * Bounded on purpose. A device code carries its own deadline, and a page that
 * keeps polling past it never tells the operator to start again — it just sits
 * there looking busy while the flow it is waiting for no longer exists. The
 * deadline is the code's, not a retry count, so a slow tenant is not mistaken
 * for a dead one.
 *
 * A refusal is not retried. `403` is Fleet saying this identity is not an
 * administrator; asking again produces the same answer, more slowly.
 */
export async function pollUntilSignedIn(
  input: DevicePollInput,
): Promise<DevicePollOutcome> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? sleep;
  const interval = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const path = input.path ?? `/api/auth/device/poll/${input.flowId}`;

  while (now() < input.expiresAt) {
    if (input.signal?.aborted) return { outcome: "abandoned" };
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(input.headers ?? {}) },
        body: "{}",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // 202 is checked before `ok`, which it also satisfies: it means Microsoft
      // has not been answered yet, and treating it as success would sign the
      // page in on a flow nobody has completed.
      if (response.status !== 202) {
        if (response.ok) return { outcome: "signed-in" };
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        return {
          outcome: "denied",
          message: body.error ?? `That sign-in failed (${response.status})`,
        };
      }
    } catch (error) {
      if (input.signal?.aborted) return { outcome: "abandoned" };
      return {
        outcome: "denied",
        message: errorMessage(error, "Could not reach the Host"),
      };
    }
    await wait(interval);
    if (input.signal?.aborted) return { outcome: "abandoned" };
  }
  return { outcome: "expired" };
}
