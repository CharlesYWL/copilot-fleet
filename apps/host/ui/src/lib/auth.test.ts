import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceIdentityConfirmed,
  browserNavigation,
  confirmIdentityInNewTab,
  csrfToken,
  forgetCsrfToken,
  onIdentityConfirmed,
  signOut,
} from "./auth";

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeTab = () => ({ closed: false, assign: vi.fn(), close: vi.fn() });

describe("confirming identity in a new tab", () => {
  it("opens the tab before asking the Host, then sends only that tab to Microsoft", async () => {
    const order: string[] = [];
    const tab = fakeTab();
    vi.spyOn(browserNavigation, "openTab").mockImplementation(() => {
      order.push("open");
      return tab;
    });
    const page = vi
      .spyOn(browserNavigation, "assign")
      .mockImplementation(() => undefined);
    const fetch = vi.fn(async () => {
      order.push("start");
      return answer({ authorizationUrl: "https://login/authorize" });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(confirmIdentityInNewTab()).resolves.toBe("tab");
    // A browser only allows the tab during the click, before anything awaits.
    expect(order).toEqual(["open", "start"]);
    expect(tab.assign).toHaveBeenCalledExactlyOnceWith("https://login/authorize");
    expect(page).not.toHaveBeenCalled();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ reauth: true });
  });

  it("signs in on this page when the browser will not open a tab", async () => {
    vi.spyOn(browserNavigation, "openTab").mockReturnValue(undefined);
    const page = vi
      .spyOn(browserNavigation, "assign")
      .mockImplementation(() => undefined);
    const fetch = vi.fn(async () =>
      answer({ authorizationUrl: "https://login/authorize" }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(confirmIdentityInNewTab()).resolves.toBe("page");
    expect(page).toHaveBeenCalledExactlyOnceWith("https://login/authorize");
    // Landing back on this page is an ordinary sign-in, not a hand-back.
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("closes the tab it opened when the Host will not start a sign-in", async () => {
    const tab = fakeTab();
    vi.spyOn(browserNavigation, "openTab").mockReturnValue(tab);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ error: "Microsoft sign-in is unavailable." }, 503)),
    );

    await expect(confirmIdentityInNewTab()).rejects.toThrow(/unavailable/);
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.assign).not.toHaveBeenCalled();
  });

  it("moves the whole page when the sign-in can only finish under the Host's other name", async () => {
    const tab = fakeTab();
    vi.spyOn(browserNavigation, "openTab").mockReturnValue(tab);
    const page = vi
      .spyOn(browserNavigation, "assign")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ canonicalUrl: "http://localhost:8787/" }, 409)),
    );

    await expect(confirmIdentityInNewTab()).resolves.toBe("page");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(page).toHaveBeenCalledExactlyOnceWith("http://localhost:8787/");
  });
});

describe("handing a confirmed sign-in back", () => {
  it("is taken up by a tab that was waiting for it", async () => {
    const listener = vi.fn(() => true);
    const stop = onIdentityConfirmed(listener);
    try {
      await expect(announceIdentityConfirmed(2_000)).resolves.toBe(true);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("reports nobody when no tab was waiting for it", async () => {
    const stop = onIdentityConfirmed(() => false);
    try {
      await expect(announceIdentityConfirmed(100)).resolves.toBe(false);
    } finally {
      stop();
    }
    await expect(announceIdentityConfirmed(50)).resolves.toBe(false);
  });

  it("ignores anything on the channel that is not a hand-back", async () => {
    const listener = vi.fn(() => true);
    const stop = onIdentityConfirmed(listener);
    const stranger = new BroadcastChannel("fleet:auth");
    try {
      stranger.postMessage({ type: "identity-confirmed" });
      stranger.postMessage("identity-confirmed");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stranger.close();
      stop();
    }
  });
});

describe("account-picker tab", () => {
  it("reports a blocked popup without pretending a tab was opened", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(browserNavigation.openTab()).toBeUndefined();
  });

  it("disconnects the opener before the sign-in tab can navigate to Microsoft", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const tab = frame.contentWindow;
    if (!tab) throw new Error("expected a window");
    tab.opener = window;
    const open = vi.spyOn(window, "open").mockReturnValue(tab);
    const close = vi.spyOn(tab, "close").mockImplementation(() => undefined);
    const opened = browserNavigation.openTab();
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    opened?.close();
    expect(close).toHaveBeenCalledOnce();
    frame.remove();
  });
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
