import { afterEach, describe, expect, it, vi } from "vitest";
import { csrfToken, forgetCsrfToken, signOut } from "./auth";

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

describe("browser auth transport", () => {
  it("does not cache a failed CSRF lookup and retries the next request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: "proof" }),
      });
    vi.stubGlobal("fetch", fetch);

    await expect(csrfToken()).rejects.toThrow(/CSRF/i);
    await expect(csrfToken()).resolves.toBe("proof");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("announces sign-out only after the server confirms revocation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ csrfToken: "proof" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetch);
    const signedOut = vi.fn();
    window.addEventListener("fleet:signed-out", signedOut);

    await expect(signOut()).rejects.toThrow(/sign out/i);
    expect(signedOut).not.toHaveBeenCalled();
    window.removeEventListener("fleet:signed-out", signedOut);
  });
});
