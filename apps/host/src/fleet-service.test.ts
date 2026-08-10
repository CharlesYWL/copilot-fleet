import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { HOST_URL_SYNC_CAPABILITY } from "@fleet/protocol";
import { FleetService } from "./fleet-service.js";
import { FleetStore } from "./store.js";

type SentFrame = { type: string; hostUrl?: string };

/** Just enough socket for the service to consider it writable and record sends. */
function fakeSocket() {
  const sent: SentFrame[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentFrame),
  };
  return { sent, socket: socket as unknown as WebSocket };
}

const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
} as unknown as FastifyBaseLogger;

function setup() {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silentLog);
  const enroll = (name: string, capabilities: string[]) => {
    const { node } = store.registerNode({
      name,
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities,
      maxSessions: 1,
    });
    const wire = fakeSocket();
    service.attachNode(node.id, wire.socket);
    return wire;
  };
  return { store, service, enroll };
}

describe("broadcastHostUrl", () => {
  it("tells a node that can follow the Host where it went", () => {
    const { service, enroll } = setup();
    const node = enroll("new-node", ["copilot-acp", HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(node.sent).toEqual([
      { type: "host_url", hostUrl: "https://two.trycloudflare.com" },
    ]);
  });

  it("says nothing to a node whose agent predates the message", () => {
    // An older agent validates every frame against its own copy of the message
    // union and closes the socket on anything it does not recognise, so sending
    // this would cost it the connection this feature exists to preserve — and
    // it would reconnect and lose it again, forever.
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp", "host-yolo"]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(0);
    expect(older.sent).toEqual([]);
  });

  it("reaches only the capable half of a mixed fleet", () => {
    const { service, enroll } = setup();
    const older = enroll("older-node", ["copilot-acp"]);
    const newer = enroll("new-node", [HOST_URL_SYNC_CAPABILITY]);

    expect(service.broadcastHostUrl("https://two.trycloudflare.com")).toBe(1);
    expect(older.sent).toEqual([]);
    expect(newer.sent).toHaveLength(1);
  });
});
