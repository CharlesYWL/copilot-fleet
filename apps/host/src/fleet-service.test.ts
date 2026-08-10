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

describe("handleEvent after a Host restart", () => {
  const event = (sessionId: string, sequence: number, payload: object, type = "state") =>
    ({
      eventId: `e${sequence}`,
      sessionId,
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    }) as Parameters<FleetService["handleEvent"]>[0];

  it("keeps applying events whose predecessors were lost", () => {
    // The exact freeze: the Host restarted mid-turn, the Node kept working and
    // kept numbering, and the first event afterwards was ahead of what the Host
    // expected. Refusing it refused everything after it, so the session sat at
    // whatever state the reconnect had guessed — accepting no output and no
    // state change — while its agent was alive and well on the Node.
    const { store, service } = setup();
    const { node } = store.registerNode({
      name: "devbox",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
    const session = store.createSession(placement, "long task");

    service.handleEvent(event(session.id, 1, { state: "starting" }));
    service.handleEvent(event(session.id, 2, { state: "running" }));
    expect(store.getSession(session.id)?.state).toBe("running");

    // Host restarts: everything live is parked, and the Node that still owns the
    // session brings it back as idle on reconnect.
    store.resetConnectivity();
    store.reconcileOfflineSessions(node.id, [session.id]);
    expect(store.getSession(session.id)?.state).toBe("idle");

    // Events 3-11 were raised while nothing was listening.
    service.handleEvent(event(session.id, 12, { text: "back" }, "agent_text"));
    service.handleEvent(event(session.id, 13, { state: "running" }));

    expect(store.getSession(session.id)?.lastText).toBe("back");
    expect(store.getSession(session.id)?.state).toBe("running");

    // And the session keeps moving, rather than being deaf from here on.
    service.handleEvent(event(session.id, 14, { state: "idle", activity: "Done" }));
    expect(store.getSession(session.id)?.state).toBe("idle");
  });
});

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
