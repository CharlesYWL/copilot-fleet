import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { BrowserMessage, NodeHealth } from "@fleet/protocol";
import { FleetService } from "./fleet-service.js";
import { FleetStore } from "./store.js";

const sampledAt = "2026-09-14T12:00:00.000Z";
const health: NodeHealth = {
  cpu: { sampledAt, usagePercent: 25 },
  memory: { sampledAt, totalBytes: 16_000, availableBytes: 4_000 },
};
const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;
const cleanups: (() => void)[] = [];

function setup() {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, log);
  const { node } = store.registerNode({
    name: "alpha",
    os: "win32",
    arch: "x64",
    version: "0.3.0",
    capabilities: [],
    maxSessions: 1,
  });
  const messages: BrowserMessage[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw) as BrowserMessage),
    close: vi.fn(),
  } as unknown as WebSocket;
  service.addBrowser(socket);
  cleanups.push(() => {
    service.shutdown();
    store.close();
  });
  return { store, service, nodeId: node.id, messages, socket };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("ephemeral Host Node health", () => {
  it("broadcasts new readings but not identical five-second heartbeats", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(sampledAt));
    const { store, service, nodeId, messages } = setup();
    service.recordPresence(nodeId, [], [], true, health);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "node", node: { health } });
    expect(service.snapshot().nodes[0]?.health).toEqual(health);
    expect(service.listNodes()[0]?.health).toEqual(health);
    expect(store.getNode(nodeId)).not.toHaveProperty("health");

    vi.advanceTimersByTime(5_000);
    service.recordPresence(nodeId, [], [], true, structuredClone(health));
    expect(messages).toHaveLength(1);
    expect(service.snapshot().nodes[0]).toMatchObject({
      lastHeartbeat: "2026-09-14T12:00:05.000Z",
      health,
    });
    service.recordPresence(nodeId, [], [], true, { memory: health.memory });
    expect(messages).toHaveLength(2);
    expect(service.snapshot().nodes[0]?.health?.cpu).toBeUndefined();
  });

  it("retains original sample times offline and during rename, not across reconnects", () => {
    const { store, service, nodeId, messages, socket } = setup();
    service.recordPresence(nodeId, [], [], true, health);
    service.publishNode(store.renameNode(nodeId, "renamed")!);
    expect(messages.at(-1)).toMatchObject({ node: { name: "renamed", health } });
    service.disconnectNode(nodeId, "Connection lost");
    expect(messages.at(-1)).toMatchObject({ node: { online: false, health } });
    expect(service.snapshot().nodes[0]?.health?.cpu?.sampledAt).toBe(sampledAt);
    service.attachNode(nodeId, socket);
    expect(service.snapshot().nodes[0]).not.toHaveProperty("health");
  });

  it("tolerates old Nodes and clears telemetry on deletion or backup replacement", () => {
    const { service, nodeId } = setup();
    service.recordPresence(nodeId, [], [], true, health);
    service.recordPresence(nodeId, []);
    expect(service.snapshot().nodes[0]).not.toHaveProperty("health");
    service.recordPresence(nodeId, [], [], true, health);
    service.evictNode(nodeId, 4002, "Deleted");
    expect(service.snapshot().nodes[0]).not.toHaveProperty("health");
    service.recordPresence(nodeId, [], [], true, health);
    service.evictAllNodes(4002, "Restored");
    expect(service.snapshot().nodes[0]).not.toHaveProperty("health");
  });

  it("does not resurrect telemetry on a new Host service or for an unknown Node", () => {
    const { store, service, nodeId } = setup();
    service.recordPresence(nodeId, [], [], true, health);
    const restarted = new FleetService(store, log);
    expect(restarted.snapshot().nodes[0]).not.toHaveProperty("health");
    service.recordPresence("unknown", [], [], true, health);
    expect(service.snapshot().nodes).toHaveLength(1);
    restarted.shutdown();
  });
});
