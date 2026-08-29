import { describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATION_CLOSE_CODE,
  BrowserSessionRegistry,
  SESSION_REVALIDATION_MS,
} from "./browser-registry.js";

type FakeSocket = {
  readyState: number;
  close: ReturnType<typeof vi.fn>;
};

const OPEN = 1;

function socket(): FakeSocket {
  return { readyState: OPEN, close: vi.fn() };
}

/**
 * A browser socket outlives the request that opened it, so an administrator who
 * was removed a minute ago is still watching every transcript unless something
 * closes the socket. That something is here.
 */
describe("BrowserSessionRegistry", () => {
  function setup(start = 1_000) {
    let now = start;
    const live = new Map<string, { administratorId: string; expiresAt: number }>();
    const registry = new BrowserSessionRegistry({
      now: () => now,
      lookup: (tokenHash) => live.get(tokenHash),
    });
    return { registry, live, advance: (ms: number) => void (now += ms) };
  }

  it("closes a socket the moment its session is revoked", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "admin-1", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });

    registry.revokeSessions(["hash-a"]);

    expect(open.close).toHaveBeenCalledWith(
      AUTHENTICATION_CLOSE_CODE,
      expect.stringMatching(/sign in/i),
    );
    expect(registry.size()).toBe(0);
  });

  it("closes every socket an administrator held when they are removed", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "admin-1", expiresAt: 10_000 });
    live.set("hash-b", { administratorId: "admin-1", expiresAt: 10_000 });
    live.set("hash-c", { administratorId: "admin-2", expiresAt: 10_000 });
    const first = socket();
    const second = socket();
    const other = socket();
    registry.add(first as never, {
      tokenHash: "hash-a",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });
    registry.add(second as never, {
      tokenHash: "hash-b",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });
    registry.add(other as never, {
      tokenHash: "hash-c",
      administratorId: "admin-2",
      expiresAt: 10_000,
    });

    registry.revokeAdministrator("admin-1");

    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
  });

  it("closes a socket whose session has quietly expired", () => {
    const { registry, live, advance } = setup();
    live.set("hash-a", { administratorId: "admin-1", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });

    // Still inside the session's absolute lifetime: nothing to do.
    advance(4_500);
    expect(registry.revalidate()).toBe(0);
    expect(open.close).not.toHaveBeenCalled();

    advance(5_000);
    expect(registry.revalidate()).toBe(1);
    expect(open.close).toHaveBeenCalledWith(
      AUTHENTICATION_CLOSE_CODE,
      expect.stringMatching(/sign in/i),
    );
  });

  it("closes a socket whose administrator row has gone away", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "admin-1", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });

    live.delete("hash-a");

    expect(registry.revalidate()).toBe(1);
    expect(open.close).toHaveBeenCalled();
  });

  it("closes a socket whose session now belongs to a different administrator", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "admin-1", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "admin-1",
      expiresAt: 10_000,
    });

    live.set("hash-a", { administratorId: "admin-2", expiresAt: 10_000 });

    expect(registry.revalidate()).toBe(1);
    expect(open.close).toHaveBeenCalled();
  });

  it("forgets a socket the browser closed on its own", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "",
      expiresAt: 10_000,
    });
    registry.remove(open as never);
    registry.revokeSessions(["hash-a"]);
    expect(open.close).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
  });

  it("revalidates about once a minute, per the design's bound", () => {
    expect(SESSION_REVALIDATION_MS).toBe(60_000);
  });

  it("closes every socket when the Host shuts down", () => {
    const { registry, live } = setup();
    live.set("hash-a", { administratorId: "", expiresAt: 10_000 });
    const open = socket();
    registry.add(open as never, {
      tokenHash: "hash-a",
      administratorId: "",
      expiresAt: 10_000,
    });
    registry.closeAll();
    expect(open.close).toHaveBeenCalled();
    expect(registry.size()).toBe(0);
  });
});
