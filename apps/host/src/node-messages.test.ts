import { describe, expect, it } from "vitest";
import type { FleetSession, NodeToHostMessage } from "@fleet/protocol";
import {
  heartbeatSessionsBelongTo,
  isHeartbeatStale,
  nodeMessageOwnership,
} from "./node-messages.js";

const sessions = new Map([
  ["owned", { id: "owned", nodeId: "node-a" } as FleetSession],
  ["foreign", { id: "foreign", nodeId: "node-b" } as FleetSession],
]);
const lookup = (id: string) => sessions.get(id);

describe("authenticated node message ownership", () => {
  it("rejects cross-node events and command results", () => {
    const event = {
      type: "event",
      event: {
        eventId: "event",
        sessionId: "foreign",
        sequence: 1,
        type: "system",
        payload: {},
        createdAt: new Date().toISOString(),
      },
    } satisfies NodeToHostMessage;
    const result = {
      type: "command_result",
      commandId: "command",
      sessionId: "foreign",
      ok: true,
      fatal: false,
    } satisfies NodeToHostMessage;
    expect(nodeMessageOwnership("node-a", event, lookup)).toBe("foreign");
    expect(nodeMessageOwnership("node-a", result, lookup)).toBe("foreign");
    expect(
      nodeMessageOwnership(
        "node-a",
        { ...event, event: { ...event.event, sessionId: "owned" } },
        lookup,
      ),
    ).toBe("owned");
    expect(
      nodeMessageOwnership(
        "node-a",
        { ...event, event: { ...event.event, sessionId: "missing" } },
        lookup,
      ),
    ).toBe("missing");
  });

  it("rejects foreign heartbeat inventory and detects stale nodes", () => {
    expect(heartbeatSessionsBelongTo("node-a", ["owned"], lookup)).toBe(true);
    expect(heartbeatSessionsBelongTo("node-a", ["foreign"], lookup)).toBe(false);
    expect(
      isHeartbeatStale(
        "2026-01-01T00:00:00.000Z",
        Date.parse("2026-01-01T00:00:16.000Z"),
        15_000,
      ),
    ).toBe(true);
  });
});
