import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { FleetService } from "./fleet-service.js";
import { startPresenceMonitor } from "./presence.js";
import { FleetStore } from "./store.js";

const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;
const cleanups: (() => void)[] = [];
const t0 = Date.parse("2026-10-06T16:00:00.000Z");

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function setup(path = ":memory:") {
  const store = new FleetStore(path, { secureFiles: () => {} });
  const service = new FleetService(store, log);
  cleanups.push(() => {
    service.shutdown();
    store.close();
  });
  const { node } = store.registerNode({
    name: "alpha",
    os: "win32",
    arch: "x64",
    version: "0.3.0",
    capabilities: [],
    maxSessions: 1,
  });
  return { store, service, nodeId: node.id };
}

describe("Host heartbeat persistence", () => {
  it("commits nothing for a heartbeat that changes nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const file = join(mkdtempSync(join(tmpdir(), "fleet-presence-")), "fleet.db");
    cleanups.push(() => rmSync(dirname(file), { recursive: true, force: true }));
    const { store, service, nodeId } = setup(file);
    service.recordPresence(nodeId, []);
    const probe = new DatabaseSync(file);
    cleanups.push(() => probe.close());
    const version = () =>
      Number(
        (probe.prepare("PRAGMA data_version").get() as { data_version: number })
          .data_version,
      );
    const before = version();

    // Every commit is a synchronous flush on the Host's only thread; six Nodes
    // beating every five seconds turned a slow disk into a frozen Host.
    for (let beat = 1; beat <= 3; beat += 1) {
      vi.setSystemTime(t0 + beat * 5_000);
      service.recordPresence(nodeId, []);
    }

    expect(version()).toBe(before);
    expect(store.getNode(nodeId)).toMatchObject({
      online: true,
      lastHeartbeat: new Date(t0 + 15_000).toISOString(),
    });
    expect(store.listNodes()[0]?.lastHeartbeat).toBe(new Date(t0 + 15_000).toISOString());

    // A transition is still written, so the probe is not blind.
    store.setNodeOnline(nodeId, false);
    expect(version()).not.toBe(before);
  });
});

describe("startPresenceMonitor", () => {
  it("drops a Node that stopped beating", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const { store, service, nodeId } = setup();
    service.recordPresence(nodeId, []);
    const timer = startPresenceMonitor(service, 15_000);
    cleanups.push(() => clearInterval(timer));

    vi.advanceTimersByTime(20_000);

    expect(store.getNode(nodeId)?.online).toBe(false);
  });

  it("does not blame Nodes for a stall of the Host's own event loop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const { store, service, nodeId } = setup();
    service.recordPresence(nodeId, []);
    const stalls: number[] = [];
    const timer = startPresenceMonitor(service, 15_000, (ms) => stalls.push(ms));
    cleanups.push(() => clearInterval(timer));

    // The Host is frozen for a minute: the clock moves, no callback runs, and
    // the Node's heartbeats queue unread in the socket. The overdue sweep runs
    // before those frames are read, so it must not judge on them yet.
    vi.setSystemTime(t0 + 60_000);
    vi.advanceTimersByTime(5_000);

    expect(store.getNode(nodeId)?.online).toBe(true);
    expect(stalls).toEqual([60_000]);

    // The queued heartbeat is read once the loop runs again.
    service.recordPresence(nodeId, []);
    vi.advanceTimersByTime(5_000);
    expect(store.getNode(nodeId)?.online).toBe(true);
  });

  it("still drops a Node that stays silent after the Host recovers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const { store, service, nodeId } = setup();
    service.recordPresence(nodeId, []);
    const timer = startPresenceMonitor(service, 15_000);
    cleanups.push(() => clearInterval(timer));

    vi.setSystemTime(t0 + 60_000);
    vi.advanceTimersByTime(5_000);
    expect(store.getNode(nodeId)?.online).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(store.getNode(nodeId)?.online).toBe(false);
  });
});
