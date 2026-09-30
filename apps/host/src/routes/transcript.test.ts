import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionTranscriptSchema,
  isTranscriptEvent,
  type SessionEvent,
} from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { sessionRoutes } from "./sessions.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const store = new FleetStore(":memory:");
  const app = Fastify();
  const service = new FleetService(store, app.log, "test");
  const { node } = store.registerNode({
    name: "node",
    os: "win32",
    arch: "x64",
    version: "test",
    capabilities: ["copilot-acp"],
    maxSessions: 2,
  });
  const workspace = store.createWorkspace("workspace", "");
  const placement = store.createPlacement(workspace.id, node.id, "C:\\synthetic");
  const first = store.createSession(placement, "first");
  const second = store.createSession(placement, "second");
  await app.register(sessionRoutes, { service });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    service.shutdown();
    store.close();
  });
  const append = (
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
    sessionId = first.id,
  ) => {
    const event: SessionEvent = {
      eventId: `${sessionId}:${sequence}`,
      sessionId,
      sequence,
      type,
      payload,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.appendEvent(event);
    return event;
  };
  return { store, app, service, first, second, append };
}

describe("browser transcript history", () => {
  it("filters only bookkeeping, keeps activity metadata, and leaves raw history intact", async () => {
    const { app, store, first, append } = await setup();
    const events = [
      append(1, "system", { text: "User: inspect this" }),
      append(2, "agent_text", { text: "Working" }),
      append(3, "commands", { commands: [] }),
      append(4, "config", { options: [] }),
      append(5, "agent_session", { agentSessionId: "agent-session" }),
      append(6, "tool", { toolCallId: "tool", title: "Read", status: "pending" }),
      append(7, "permission", { requestId: "permission", title: "Allow?" }),
      append(8, "permission_result", { requestId: "permission", outcome: "deny" }),
      append(9, "commands", { commands: [] }),
      append(10, "usage", { aiCredits: 1 }),
    ];
    const response = await app.inject(`/api/sessions/${first.id}/transcript`);
    expect(response.statusCode).toBe(200);
    const history = SessionTranscriptSchema.parse(response.json());
    expect(history.events).toEqual(events.filter(isTranscriptEvent));
    expect(history.activity).toEqual({
      eventId: events[8]!.eventId,
      sequence: 9,
      createdAt: events[8]!.createdAt,
    });
    expect(store.listEvents(first.id)).toEqual(events);
    const raw = await app.inject(`/api/sessions/${first.id}/events`);
    expect(raw.json()).toEqual(events);
  });

  it("returns an empty transcript and reports a missing session", async () => {
    const { app, first } = await setup();
    expect((await app.inject(`/api/sessions/${first.id}/transcript`)).json()).toEqual({
      events: [],
    });
    expect((await app.inject("/api/sessions/missing/transcript")).statusCode).toBe(404);
  });

  it("reads the exact exclusive attempt suffix, including sparse and late sequences", async () => {
    const { store, first, second, append } = await setup();
    append(1, "agent_text", { text: "previous attempt" });
    append(10, "agent_text", { text: "new attempt" });
    append(5, "turn_complete", { stopReason: "end_turn" });
    append(11, "agent_text", { text: "different session" }, second.id);
    for (const from of [0, 1, 4, 5, 9, 10, 11]) {
      expect(store.listEventsAfter(first.id, from)).toEqual(
        store.listEvents(first.id).filter((event) => event.sequence > from),
      );
    }
  });

  it("hydrates the latest permission state per session/request without a transcript", async () => {
    const { store, service, first, second, append } = await setup();
    append(1, "permission", { requestId: "same", title: "first" });
    const resolved = append(8, "permission_result", {
      requestId: "same",
      outcome: "deny",
    });
    append(4, "permission", { requestId: "same", title: "late older request" });
    const pending = append(
      1,
      "permission",
      { requestId: "same", title: "second" },
      second.id,
    );
    append(2, "permission_result", { requestId: "same", outcome: 42 }, second.id);
    append(3, "permission", { requestId: "same", title: 42 }, second.id);
    append(9, "agent_text", { text: "not permission data" });
    append(10, "permission", { requestId: 42 });
    expect(new Set(store.listPermissionEvents().map((event) => event.eventId))).toEqual(
      new Set([resolved.eventId, pending.eventId]),
    );
    expect(service.snapshot().permissionEvents).toEqual(store.listPermissionEvents());
    expect(
      store.listPermissionEvents().filter((event) => event.sessionId === first.id),
    ).toEqual([resolved]);
  });
});
