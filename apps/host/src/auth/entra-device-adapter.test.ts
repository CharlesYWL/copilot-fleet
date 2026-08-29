import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_DEVICE_FLOWS,
  PROVIDER_DEVICE_START_BURST,
  createMsalAdapter,
  type MsalClient,
} from "./entra.js";

const CONFIG = {
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  clientId: "11111111-2222-3333-4444-555555555555",
};

type Pending = {
  request: { cancel?: boolean };
  settle: (identity: { tenantId: string; uniqueId: string }) => void;
  fail: (error: unknown) => void;
};

/**
 * A client that never answers unless the test says so, which is what a real
 * device flow does: MSAL sits in a polling loop until somebody types the code,
 * the code expires, or the request is cancelled.
 */
function fakeClient(): { client: MsalClient; pending: Pending[] } {
  const pending: Pending[] = [];
  return {
    pending,
    client: {
      getAuthCodeUrl: async () => "https://login.example/authorize",
      acquireTokenByCode: async () => ({
        tenantId: CONFIG.tenantId,
        uniqueId: "object-id",
        account: null,
      }),
      acquireTokenByDeviceCode: (request) =>
        new Promise((resolve, reject) => {
          request.deviceCodeCallback?.({
            deviceCode: "device-code",
            userCode: "ABC-DEF",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresIn: 900,
            interval: 5,
            message: "Enter ABC-DEF",
          });
          pending.push({
            request: request as { cancel?: boolean },
            settle: (identity) => resolve({ ...identity, account: null }),
            fail: reject,
          });
        }),
      removeAccount: async () => {},
    },
  };
}

/**
 * The provider's own bookkeeping, independent of any browser.
 *
 * The Host's outer map is driven by polls from a page; this one is driven by
 * MSAL. A tab that closes stops the first and not the second, so unless the
 * adapter bounds and cancels its own work, every abandoned sign-in leaves a
 * loop asking Microsoft about a code nobody will ever enter — and a promise
 * with no handler when it eventually fails.
 */
describe("the MSAL device-code adapter", () => {
  it("cancels the underlying request when a flow is cancelled", async () => {
    const { client, pending } = fakeClient();
    const adapter = createMsalAdapter(CONFIG, client);
    const started = await adapter.deviceCode!();
    expect(pending[0]!.request.cancel).toBe(false);

    adapter.cancelDevice!({ flowId: started.flowId });
    expect(pending[0]!.request.cancel).toBe(true);

    await expect(adapter.pollDevice!({ flowId: started.flowId })).rejects.toThrow();
  });

  it("cancels a flow at its own expiry without waiting for a poll", async () => {
    vi.useFakeTimers();
    try {
      const { client, pending } = fakeClient();
      const adapter = createMsalAdapter(CONFIG, client);
      const started = await adapter.deviceCode!();
      expect(pending[0]!.request.cancel).toBe(false);

      // The code Microsoft issued is dead; nothing about the browser changed.
      vi.advanceTimersByTime(started.expiresAt - Date.now() + 1_000);
      expect(pending[0]!.request.cancel).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a flow once it settles", async () => {
    const { client, pending } = fakeClient();
    const adapter = createMsalAdapter(CONFIG, client);
    const started = await adapter.deviceCode!();
    pending[0]!.settle({ tenantId: CONFIG.tenantId, uniqueId: "object-id" });

    await expect(adapter.pollDevice!({ flowId: started.flowId })).resolves.toMatchObject({
      objectId: "object-id",
    });
    await expect(adapter.pollDevice!({ flowId: started.flowId })).rejects.toThrow();
  });

  it("caps how many flows may be open at once", async () => {
    const { client } = fakeClient();
    const adapter = createMsalAdapter(CONFIG, client);
    for (let index = 0; index < MAX_PROVIDER_DEVICE_FLOWS; index += 1) {
      await adapter.deviceCode!();
    }
    await expect(adapter.deviceCode!()).rejects.toThrow(/too many/i);
  });

  /*
   * Each start is a round trip to Microsoft and a loop that lives for fifteen
   * minutes. An endpoint reachable through a public tunnel must not be able to
   * turn a burst of requests into an unbounded number of them.
   */
  it("caps how fast flows may be started", async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient();
      const adapter = createMsalAdapter(CONFIG, client);
      for (let index = 0; index < PROVIDER_DEVICE_START_BURST; index += 1) {
        const started = await adapter.deviceCode!();
        adapter.cancelDevice!({ flowId: started.flowId });
      }
      await expect(adapter.deviceCode!()).rejects.toThrow(/too many|slow down/i);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * A rejection nobody is listening for takes the process down under Node's
   * default handler, so the adapter has to own that from the moment it starts
   * the request — not from the moment a page happens to poll it.
   */
  it("leaves no unhandled rejection when a flow fails before anyone polls", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const { client, pending } = fakeClient();
      const adapter = createMsalAdapter(CONFIG, client);
      await adapter.deviceCode!();
      pending[0]!.fail(new Error("AADSTS70016: expired_token"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
