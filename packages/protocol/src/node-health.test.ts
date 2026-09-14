import { describe, expect, it } from "vitest";
import {
  BrowserMessageSchema,
  HostBackupNodeSchema,
  NodeHealthSchema,
  NodeSchema,
  NodeToHostMessageSchema,
  SnapshotSchema,
} from "./index.js";

const sampledAt = "2026-09-14T12:00:00.000Z";
const health = {
  cpu: { sampledAt, usagePercent: 25 },
  memory: { sampledAt, totalBytes: 16_000, availableBytes: 4_000 },
  disk: { sampledAt, totalBytes: 100_000, availableBytes: 40_000, scope: "home" },
};
const heartbeat = { type: "heartbeat", activeSessionIds: [], sentAt: sampledAt };
const node = {
  id: "n1",
  name: "alpha",
  os: "win32",
  arch: "x64",
  version: "0.3.0",
  capabilities: [],
  maxSessions: 1,
  activeSessions: 0,
  lastHeartbeat: sampledAt,
  online: true,
};

describe("optional Node resource telemetry", () => {
  it("keeps old heartbeats, nodes, snapshots and backup rows valid", () => {
    expect(NodeToHostMessageSchema.parse(heartbeat)).not.toHaveProperty("health");
    expect(NodeSchema.parse(node)).not.toHaveProperty("health");
    expect(
      SnapshotSchema.parse({
        nodes: [node],
        workspaces: [],
        placements: [],
        sessions: [],
      }).nodes[0],
    ).not.toHaveProperty("health");
    expect(
      HostBackupNodeSchema.parse({ ...node, secretHash: "a".repeat(64) }),
    ).not.toHaveProperty("health");
  });

  it("preserves each measurement time through heartbeat, snapshot, broadcast and backup parsing", () => {
    const value = {
      ...health,
      cpu: { ...health.cpu, sampledAt: "2026-09-14T11:59:30.000Z" },
    };
    expect(NodeToHostMessageSchema.parse({ ...heartbeat, health: value })).toMatchObject({
      health: value,
    });
    expect(
      BrowserMessageSchema.parse({ type: "node", node: { ...node, health: value } }),
    ).toMatchObject({ node: { health: value } });
    expect(
      SnapshotSchema.parse({
        nodes: [{ ...node, health: value }],
        workspaces: [],
        placements: [],
        sessions: [],
      }).nodes[0]?.health,
    ).toEqual(value);
    expect(
      HostBackupNodeSchema.parse({ ...node, health: value, secretHash: "a".repeat(64) })
        .health,
    ).toEqual(value);
  });

  it("supports partial or entirely unavailable metrics without fabricating zeros", () => {
    expect(NodeHealthSchema.parse({})).toEqual({});
    expect(NodeHealthSchema.parse({ memory: health.memory })).toEqual({
      memory: health.memory,
    });
  });

  it.each([
    { cpu: { sampledAt, usagePercent: -1 } },
    { cpu: { sampledAt, usagePercent: 101 } },
    { cpu: { sampledAt, usagePercent: NaN } },
    { cpu: { sampledAt, usagePercent: Infinity } },
    { cpu: { sampledAt, usagePercent: "25" } },
    { cpu: { usagePercent: 25 } },
    { cpu: { sampledAt: "yesterday", usagePercent: 25 } },
    { memory: { ...health.memory, totalBytes: 0 } },
    { memory: { ...health.memory, availableBytes: -1 } },
    { memory: { ...health.memory, availableBytes: 20_000 } },
    { memory: { ...health.memory, totalBytes: Number.MAX_SAFE_INTEGER + 1 } },
    { memory: { ...health.memory, availableBytes: 0.5 } },
    { disk: { ...health.disk, scope: "all-disks" } },
    { disk: { ...health.disk, availableBytes: 200_000 } },
    { disk: { ...health.disk, totalBytes: Infinity } },
  ])("rejects invalid telemetry %j", (invalid) => {
    expect(
      NodeToHostMessageSchema.safeParse({ ...heartbeat, health: invalid }).success,
    ).toBe(false);
  });
});
