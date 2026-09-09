import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { HostToNodeMessageSchema, type NodeCommand } from "@fleet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FleetService } from "./fleet-service.js";
import { FleetStore } from "./store.js";

const stores: FleetStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new FleetStore(":memory:");
  stores.push(store);
  const service = new FleetService(
    store,
    { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger,
    "",
  );
  const { node } = store.registerNode({
    name: "remote",
    os: "win32",
    arch: "x64",
    version: "0.4.0",
    capabilities: ["copilot-acp", "host-yolo"],
    maxSessions: 4,
    homeDir: "C:\\Users\\test",
  });
  const commands: NodeCommand[] = [];
  service.attachNode(node.id, {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      const message = HostToNodeMessageSchema.parse(JSON.parse(raw));
      if (message.type === "command") commands.push(message.command);
    },
  } as unknown as WebSocket);
  store.setNodeOnline(node.id, true, 0);
  const workspace = store.createWorkspace("project", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\project");
  return { store, service, node, placement, commands };
}

describe("fleet-wide Agency mode", () => {
  it.each(["", "lead", "worker"] as const)(
    "selects Agency for session role '%s' without changing permissions",
    (runRole) => {
      const { store, service, placement, commands } = setup();
      store.setAgencyMode(true);
      const result = service.createAndStartSession({
        placement,
        prompt: "hello",
        yolo: false,
        runRole,
      });
      expect(result.ok).toBe(true);
      expect(commands.at(-1)).toMatchObject({
        type: "start_session",
        agencyMode: true,
        yolo: false,
      });
    },
  );

  it("also selects Agency for Chats", () => {
    const { store, service, node, commands } = setup();
    const placement = store.chatPlacementFor(node.id);
    if (!placement) throw new Error("Expected a Chats placement for this Node");
    store.setAgencyMode(true);
    expect(
      service.createAndStartSession({ placement, prompt: "research", yolo: false }).ok,
    ).toBe(true);
    expect(commands.at(-1)).toMatchObject({ type: "start_session", agencyMode: true });
  });

  it("uses the current preference on adoption and resume without stopping live agents", () => {
    const { store, service, placement, commands } = setup();
    const adopted = service.adoptAndResumeSession({
      placement,
      agentSessionId: "existing-conversation",
      yolo: false,
    });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error(adopted.error);
    expect(commands.at(-1)).toMatchObject({ type: "resume_session", agencyMode: false });
    store.setAgencyMode(true);
    expect(commands).toHaveLength(1);
    store.transitionSession(adopted.session.id, "stopped");
    expect(service.resumeSession(adopted.session.id).ok).toBe(true);
    expect(commands.at(-1)).toMatchObject({
      type: "resume_session",
      agentSessionId: "existing-conversation",
      agencyMode: true,
    });
    store.setAgencyMode(false);
    store.transitionSession(adopted.session.id, "stopped");
    expect(service.resumeSession(adopted.session.id).ok).toBe(true);
    expect(commands.at(-1)).toMatchObject({ type: "resume_session", agencyMode: false });
  });

  it("applies the current preference during automatic recovery after a restart", () => {
    const { store, service, node, placement, commands } = setup();
    const session = store.createSession(placement, "interrupted");
    store.appendEvent({
      eventId: "agent",
      sessionId: session.id,
      sequence: 1,
      type: "agent_session",
      payload: { agentSessionId: "acp-interrupted" },
      createdAt: new Date().toISOString(),
    });
    store.markNodeSessionsOffline(node.id, "Node disconnected");
    store.setAgencyMode(true);
    service.reconcile(node.id, []);
    expect(commands.at(-1)).toMatchObject({
      type: "resume_session",
      sessionId: session.id,
      agencyMode: true,
    });
  });
});
