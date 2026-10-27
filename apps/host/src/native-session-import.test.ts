import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeToHostMessage, SessionEvent } from "@fleet/protocol";
import { FleetStore } from "./store.js";
import { FleetService } from "./fleet-service.js";

type ImportMessage = Extract<NodeToHostMessage, { type: "native_session_import" }>;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "fleet-native-import-"));
  const store = new FleetStore(join(directory, "host.db"));
  const app = Fastify();
  const service = new FleetService(store, app.log);
  const { node } = store.registerNode({
    name: "Node",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 3,
  });
  const { node: other } = store.registerNode({
    name: "Other",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 3,
  });
  const workspace = store.createWorkspace("repo", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\repo");
  const session = store.createSession(placement, "initial", false, "Session");
  store.transitionSession(session.id, "starting");
  store.transitionSession(session.id, "idle");
  const fleetEvent: SessionEvent = {
    eventId: randomUUID(),
    sessionId: session.id,
    sequence: 1,
    type: "agent_text",
    payload: { text: "from fleet" },
    createdAt: new Date().toISOString(),
  };
  store.appendEvent(fleetEvent);
  cleanups.push(() => {
    service.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const message = (overrides: Partial<ImportMessage> = {}): ImportMessage => ({
    type: "native_session_import",
    importId: randomUUID(),
    sessionId: session.id,
    events: [
      {
        eventId: `native:${session.id}:u1`,
        type: "system",
        payload: { text: "User: from terminal" },
        createdAt: new Date().toISOString(),
      },
      {
        eventId: `native:${session.id}:a1:text`,
        type: "agent_text",
        payload: { text: "terminal answer" },
        createdAt: new Date().toISOString(),
      },
      {
        eventId: `native:${session.id}:e1`,
        type: "turn_complete",
        payload: { stopReason: "end_turn" },
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  });
  return { store, service, node, other, session, message };
}

describe("native session import", () => {
  it("appends outside turns after Fleet's own events, as replayed history", () => {
    const { store, service, node, session, message } = setup();
    const result = service.importNativeSession(node.id, message());
    expect(result).toEqual({ status: "stored", throughSequence: 4 });
    const events = store.listEvents(session.id);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "agent_text"],
      [2, "system"],
      [3, "agent_text"],
      [4, "turn_complete"],
    ]);
    // Visible in the transcript, invisible to settlement and wakes.
    expect(events.slice(1).every((event) => event.payload.historyReplay === true)).toBe(
      true,
    );
    // A terminal turn changes no Fleet lifecycle state.
    expect(store.getSession(session.id)?.state).toBe("idle");
  });

  it("ignores a repeated import of the same native lines", () => {
    const { store, service, node, session, message } = setup();
    const first = message();
    service.importNativeSession(node.id, first);
    const again = service.importNativeSession(node.id, {
      ...first,
      importId: randomUUID(),
    });
    expect(again).toEqual({ status: "stored", throughSequence: 4 });
    expect(store.listEvents(session.id)).toHaveLength(4);
  });

  it("uses Node-reserved sequence numbers when Fleet's process is live", () => {
    const { store, service, node, session, message } = setup();
    const imported = message();
    service.importNativeSession(node.id, {
      ...imported,
      events: imported.events.map((event, index) => ({ ...event, sequence: 10 + index })),
    });
    expect(store.listEvents(session.id).map((event) => event.sequence)).toEqual([
      1, 10, 11, 12,
    ]);
  });

  it("refuses another node's session", () => {
    const { store, service, other, session, message } = setup();
    expect(service.importNativeSession(other.id, message())).toEqual({
      status: "unknown_session",
    });
    expect(store.listEvents(session.id)).toHaveLength(1);
  });

  it("records the outside holder and blocks Fleet prompts until it clears", () => {
    const { store, service, node, session, message } = setup();
    const attachment = { pids: [4242], active: true, since: new Date().toISOString() };
    service.importNativeSession(node.id, message({ events: [], attachment }));
    expect(store.getSession(session.id)?.externalAttachment).toEqual(attachment);
    const refused = service.promptSession(session.id, { prompt: "hi", attachments: [] });
    expect(refused).toMatchObject({ ok: false, status: 409 });

    service.importNativeSession(node.id, message({ events: [], attachment: null }));
    expect(store.getSession(session.id)?.externalAttachment).toBeNull();
  });
});
