import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntilSignedIn } from "./device-login";

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("bounded device polling", () => {
  it("stops as soon as the Host says the browser is signed in", async () => {
    const fetch = vi.fn(async () => answer({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      pollUntilSignedIn({
        flowId: "flow-1",
        expiresAt: Date.now() + 60_000,
        intervalMs: 0,
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ outcome: "signed-in" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while Microsoft has not been answered yet", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer({ pending: true }, 202))
      .mockResolvedValueOnce(answer({ pending: true }, 202))
      .mockResolvedValueOnce(answer({ ok: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      pollUntilSignedIn({
        flowId: "flow-1",
        expiresAt: Date.now() + 60_000,
        intervalMs: 0,
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ outcome: "signed-in" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up at the code's own expiry rather than polling for ever", async () => {
    // A device code has a deadline printed on it; a page that keeps asking past
    // that deadline is a page that never tells the operator to start again.
    const fetch = vi.fn(async () => answer({ pending: true }, 202));
    vi.stubGlobal("fetch", fetch);
    let clock = 0;

    await expect(
      pollUntilSignedIn({
        flowId: "flow-1",
        expiresAt: 30,
        intervalMs: 10,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      }),
    ).resolves.toEqual({ outcome: "expired" });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("reports a refusal by name instead of retrying it", async () => {
    const fetch = vi.fn(async () =>
      answer({ error: "That account is not authorized to use this Fleet." }, 403),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      pollUntilSignedIn({
        flowId: "flow-1",
        expiresAt: Date.now() + 60_000,
        intervalMs: 0,
        wait: async () => undefined,
      }),
    ).resolves.toEqual({
      outcome: "denied",
      message: "That account is not authorized to use this Fleet.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops when the caller abandons the flow", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => answer({ pending: true }, 202));
    vi.stubGlobal("fetch", fetch);

    const settled = pollUntilSignedIn({
      flowId: "flow-1",
      expiresAt: Date.now() + 60_000,
      intervalMs: 0,
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    });

    await expect(settled).resolves.toEqual({ outcome: "abandoned" });
  });
});
