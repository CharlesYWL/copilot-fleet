import { afterEach, describe, expect, it, vi } from "vitest";
import { showAppBadge } from "./app-badge";

type BadgeMethods = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

const stubBadging = (methods: BadgeMethods): void => {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(navigator, name, { configurable: true, value });
  }
};

afterEach(() => {
  for (const name of ["setAppBadge", "clearAppBadge"]) {
    Reflect.deleteProperty(navigator, name);
  }
});

describe("showAppBadge", () => {
  it("puts the unread count on the installed app's icon", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    stubBadging({ setAppBadge, clearAppBadge });

    showAppBadge(3);

    expect(setAppBadge).toHaveBeenCalledExactlyOnceWith(3);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge once nothing is unread", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    const clearAppBadge = vi.fn(() => Promise.resolve());
    stubBadging({ setAppBadge, clearAppBadge });

    showAppBadge(0);

    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it("does nothing in a browser without the Badging API", () => {
    expect(() => showAppBadge(2)).not.toThrow();
    expect(() => showAppBadge(0)).not.toThrow();
  });

  it("swallows a refused badge rather than surfacing an unhandled rejection", async () => {
    const setAppBadge = vi.fn(() => Promise.reject(new Error("not installed")));
    stubBadging({ setAppBadge });

    showAppBadge(1);
    await Promise.resolve();

    expect(setAppBadge).toHaveBeenCalledOnce();
  });
});
