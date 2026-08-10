import { describe, expect, it } from "vitest";
import { HostUrlWatcher, isDialableHostUrl } from "./host-url.js";

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

  it("ignores a change that is only a different spelling of the same Host", () => {
    const watcher = watching("https://fleet.example.com", "https://fleet.example.com/");
    watcher.check();
    expect(watcher.check()).toBeUndefined();
  });
});
