import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { FleetSession } from "@fleet/protocol";
import { FleetService } from "./fleet-service.js";
import { FleetStore } from "./store.js";

type SentFrame = { type: string; command?: { type: string; sessionId: string } };

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

function setup(maxSessions = 4) {
  const store = new FleetStore(":memory:");
  const service = new FleetService(store, silentLog, "");
  const { node } = store.registerNode({
    name: "devbox",
    os: "win32",
    arch: "x64",
    version: "0.1.0",
    revision: "",
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions,
  });
  const wire = fakeSocket();
  service.attachNode(node.id, wire.socket);
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");

  /** A session that reached its agent and was then orphaned by a restart. */
  const orphan = (name: string): FleetSession => {
    const session = store.createSession(placement, name, false, name);
    store.appendEvent({
      eventId: `${session.id}-agent`,
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: `acp-${name}` },
      createdAt: new Date().toISOString(),
    });
    store.transitionSession(session.id, "starting");
    store.transitionSession(session.id, "idle");
    store.markNodeSessionsOffline(node.id, "Node disconnected");
    return store.getSession(session.id)!;
  };

  const resumeCommands = () =>
    wire.sent
      .filter((frame) => frame.command?.type === "resume_session")
      .map((frame) => frame.command!.sessionId);

  return { store, service, node, placement, orphan, resumeCommands };
}

describe("auto resume", () => {
  it("re-attaches a session the node came back without", () => {
    // The state an operator used to have to clear by hand after every restart:
    // reconciliation settles it as failed with a Resume button and nothing else
    // happens until someone clicks it, once per session.
    const { service, store, node, orphan, resumeCommands } = setup();
    const session = orphan("Lost");

    service.reconcile(node.id, []);

    expect(resumeCommands()).toEqual([session.id]);
    expect(store.getSession(session.id)?.state).toBe("starting");
    expect(store.getSession(session.id)?.currentActivity).toBe(
      "Reconnecting automatically",
    );
  });

  it("leaves a session the node still has alone", () => {
    const { service, store, node, orphan, resumeCommands } = setup();
    const session = orphan("Still there");

    service.reconcile(node.id, [session.id]);

    expect(resumeCommands()).toEqual([]);
    expect(store.getSession(session.id)?.state).toBe("idle");
  });

  it("does not resume a session that never reached its agent", () => {
    // There is nothing to re-attach to, so a resume would only fail loudly.
    const { service, store, node, placement, resumeCommands } = setup();
    const session = store.createSession(placement, "never started");
    store.markNodeSessionsOffline(node.id, "Node disconnected");

    service.reconcile(node.id, []);

    expect(resumeCommands()).toEqual([]);
    expect(store.getSession(session.id)?.state).toBe("failed");
  });

  it("stops at the node's capacity, newest first", async () => {
    // Each resume is a Copilot process on someone's machine; the most recently
    // started work is the likeliest to still matter. The waits give the rows
    // distinct creation times — real sessions do not start in one millisecond.
    const { service, node, orphan, resumeCommands } = setup(2);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    orphan("oldest");
    await pause();
    orphan("middle");
    await pause();
    const newest = orphan("newest");

    service.reconcile(node.id, []);

    const resumed = resumeCommands();
    expect(resumed).toHaveLength(2);
    expect(resumed[0]).toBe(newest.id);
  });

  it("counts sessions the node kept against that capacity", () => {
    const { service, store, node, placement, orphan, resumeCommands } = setup(2);
    const live = store.createSession(placement, "live");
    store.transitionSession(live.id, "starting");
    store.transitionSession(live.id, "running");
    const first = orphan("first");
    const second = orphan("second");

    service.reconcile(node.id, [live.id]);

    // Two slots, one already taken by the live session.
    expect(resumeCommands()).toHaveLength(1);
    expect([first.id, second.id]).toContain(resumeCommands()[0]);
  });

  it("does not try again on the next heartbeat", () => {
    // A resume that fails settles the session as failed. Retrying it every five
    // seconds would spawn processes forever on a session that cannot come back.
    const { service, store, node, orphan, resumeCommands } = setup();
    const session = orphan("Lost");

    service.reconcile(node.id, []);
    store.transitionSession(session.id, "failed", "Resume failed");
    service.reconcile(node.id, []);

    expect(resumeCommands()).toEqual([session.id]);
  });

  it("stays out of the way when it is turned off", () => {
    const { service, store, node, orphan, resumeCommands } = setup();
    store.setAutoResume(false);
    const session = orphan("Lost");

    service.reconcile(node.id, []);

    expect(resumeCommands()).toEqual([]);
    expect(store.getSession(session.id)?.state).toBe("failed");
  });

  it("refuses a yolo session on a node that cannot honour it", () => {
    // The same guard the manual Resume applies: downgrading silently would
    // promise unattended execution the node will not deliver.
    const store = new FleetStore(":memory:");
    const service = new FleetService(store, silentLog, "");
    const { node } = store.registerNode({
      name: "older",
      os: "win32",
      arch: "x64",
      version: "0.1.0",
      revision: "",
      capabilities: ["copilot-acp"],
      maxSessions: 4,
    });
    const wire = fakeSocket();
    service.attachNode(node.id, wire.socket);
    const workspace = store.createWorkspace("repo", "");
    const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
    const session = store.createSession(placement, "yolo work", true);
    store.appendEvent({
      eventId: "e1",
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "acp-1" },
      createdAt: new Date().toISOString(),
    });
    store.markNodeSessionsOffline(node.id, "Node disconnected");

    service.reconcile(node.id, []);

    expect(wire.sent.filter((frame) => frame.command)).toEqual([]);
    expect(store.getSession(session.id)?.state).toBe("failed");
  });
});
