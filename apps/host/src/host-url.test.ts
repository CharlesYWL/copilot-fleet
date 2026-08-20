import { describe, expect, it } from "vitest";
import {
  HostUrlWatcher,
  isBroadcastableHostUrl,
  isDialableHostUrl,
  isTransferableHostUrl,
} from "./host-url.js";

const DEVTUNNEL = "https://hqn74pr4-8790.usw2.devtunnels.ms";

describe("isDialableHostUrl", () => {
  it("accepts an address another machine can reach", () => {
    expect(isDialableHostUrl("https://calm-sky-1234.trycloudflare.com")).toBe(true);
    expect(isDialableHostUrl("http://192.168.1.20:8787")).toBe(true);
    expect(isDialableHostUrl("https://fleet.example.com")).toBe(true);
  });

  it("refuses the loopback fallbacks that only name the Host's own machine", () => {
    // Announcing one of these would take a working node connection and point it
    // at that node's own loopback, which is worse than leaving it alone.
    expect(isDialableHostUrl("http://127.0.0.1:8787")).toBe(false);
    expect(isDialableHostUrl("http://127.0.0.53:8787")).toBe(false);
    expect(isDialableHostUrl("http://localhost:8787")).toBe(false);
    expect(isDialableHostUrl("http://0.0.0.0:8787")).toBe(false);
    expect(isDialableHostUrl("http://[::1]:8787")).toBe(false);
    expect(isDialableHostUrl("not-a-url")).toBe(false);
  });
});

describe("isTransferableHostUrl", () => {
  it("accepts a hostname that will still answer after the Host moves", () => {
    expect(isTransferableHostUrl("https://fleet.example.com")).toBe(true);
    expect(isTransferableHostUrl("https://machine.ts.net")).toBe(true);
    expect(isTransferableHostUrl("http://192.168.1.20:8787")).toBe(true);
  });

  it("refuses loopback and rotating tunnel URLs", () => {
    expect(isTransferableHostUrl("http://127.0.0.1:8787")).toBe(false);
    expect(isTransferableHostUrl("https://calm-sky.trycloudflare.com")).toBe(false);
    expect(isTransferableHostUrl("https://abc.ngrok-free.app")).toBe(false);
  });
});

describe("isBroadcastableHostUrl", () => {
  it("refuses a Dev Tunnels URL whatever produced it", () => {
    // `broadcastTunnelUrl()` already skips the devtunnel provider, but the
    // announced address can also come from FLEET_PUBLIC_URL or the
    // `host.publicUrl` setting — an operator can type this, and a Host backup
    // can restore it. Both routed straight past the provider's own refusal.
    expect(isBroadcastableHostUrl(DEVTUNNEL)).toBe(false);
    expect(isBroadcastableHostUrl("https://abc-8790-inspect.usw2.devtunnels.ms")).toBe(
      false,
    );
  });

  it("still announces a rotating tunnel, which is the whole point of announcing", () => {
    // A trycloudflare URL is a bad thing to restore from a backup and a fine
    // thing to announce: the Node is connected right now and the address it
    // holds has just expired, so this message is the only thing that can move
    // it. Refusing would strand exactly the Nodes the feature exists for.
    expect(isBroadcastableHostUrl("https://calm-sky.trycloudflare.com")).toBe(true);
    expect(isBroadcastableHostUrl("https://fleet.example.com")).toBe(true);
    expect(isBroadcastableHostUrl("http://192.168.1.20:8787")).toBe(true);
  });

  it("keeps refusing the addresses that only name the Host's own machine", () => {
    expect(isBroadcastableHostUrl("http://127.0.0.1:8787")).toBe(false);
    expect(isBroadcastableHostUrl("not-a-url")).toBe(false);
  });
});

describe("HostUrlWatcher", () => {
  const watching = (...readings: string[]) => {
    const queue = [...readings];
    let last = "";
    const watcher = new HostUrlWatcher(() => {
      last = queue.shift() ?? last;
      return last;
    });
    return watcher;
  };

  it("treats the first reading as a baseline, not as news", () => {
    // Every node is either absent at startup or has just connected using an
    // address that demonstrably works.
    const watcher = watching("https://one.trycloudflare.com");
    expect(watcher.check()).toBeUndefined();
  });

  it("reports a rotated tunnel URL once", () => {
    const watcher = watching(
      "https://one.trycloudflare.com",
      "https://two.trycloudflare.com",
      "https://two.trycloudflare.com",
    );
    watcher.check();
    expect(watcher.check()).toEqual({
      previous: "https://one.trycloudflare.com",
      next: "https://two.trycloudflare.com",
    });
    expect(watcher.check()).toBeUndefined();
  });

  it("says nothing when a tunnel goes down and the URL falls back to loopback", () => {
    const watcher = watching("https://one.trycloudflare.com", "http://127.0.0.1:8787");
    watcher.check();
    expect(watcher.check()).toBeUndefined();
  });

  it("still reports the next tunnel after a spell with no tunnel at all", () => {
    // The loopback reading has to move the baseline even though it is never
    // announced, or this comparison would be against a URL two rotations old.
    const watcher = watching(
      "https://one.trycloudflare.com",
      "http://127.0.0.1:8787",
      "https://three.trycloudflare.com",
    );
    watcher.check();
    watcher.check();
    expect(watcher.check()).toEqual({
      previous: "http://127.0.0.1:8787",
      next: "https://three.trycloudflare.com",
    });
  });

  it("says nothing when the public URL is set to a Dev Tunnels address", () => {
    // The state that stranded two machines: the operator points FLEET_PUBLIC_URL
    // at the tunnel the Host is hosting, which reads back as a perfectly
    // dialable https address and is pushed to every Node — into a login none of
    // them can answer, from which none of them can be recalled.
    const watcher = watching("https://fleet.example.com", DEVTUNNEL);
    watcher.check();
    expect(watcher.check()).toBeUndefined();
  });

  it("moves the baseline past a refused address so the next real move is seen", () => {
    const watcher = watching(
      "https://fleet.example.com",
      DEVTUNNEL,
      "https://moved.example.com",
    );
    watcher.check();
    watcher.check();
    expect(watcher.check()).toEqual({
      previous: DEVTUNNEL,
      next: "https://moved.example.com",
    });
  });

  it("ignores a change that is only a different spelling of the same Host", () => {
    const watcher = watching("https://fleet.example.com", "https://fleet.example.com/");
    watcher.check();
    expect(watcher.check()).toBeUndefined();
  });
});
