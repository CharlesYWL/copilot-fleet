import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  TranscriptPageSchema,
  changedBlock,
  toTerminalBlocks,
  type BrowserMessage,
  type SessionEvent,
  type TerminalBlock,
} from "@fleet/protocol";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { TranscriptProjections } from "../transcript-projections.js";
import { sessionRoutes } from "./sessions.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const store = new FleetStore(":memory:");
  const app = Fastify();
  const service = new FleetService(store, app.log, "test");
  const sent: BrowserMessage[] = [];
  service.addBrowser({
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw) as BrowserMessage),
    close: () => {},
  } as unknown as WebSocket);
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
  const make = (
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
    sessionId = first.id,
  ): SessionEvent => ({
    eventId: `${sessionId}:${sequence}`,
    sessionId,
    sequence,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const append = (...args: Parameters<typeof make>) => {
    const event = make(...args);
    store.appendEvent(event);
    return event;
  };
  const page = async (sessionId: string, query = "") => {
    const response = await app.inject(`/api/sessions/${sessionId}/transcript${query}`);
    expect(response.statusCode).toBe(200);
    return TranscriptPageSchema.parse(response.json());
  };
  return { store, app, service, sent, first, second, make, append, page };
}

const history = (
  append: (
    sequence: number,
    type: SessionEvent["type"],
    payload: SessionEvent["payload"],
  ) => SessionEvent,
) => [
  append(1, "system", { text: "User: inspect this" }),
  append(2, "agent_text", { text: "Working" }),
  append(3, "commands", { commands: [] }),
  append(4, "config", { options: [] }),
  append(5, "agent_session", { agentSessionId: "agent-session" }),
  append(6, "tool", { toolCallId: "tool", title: "Read", status: "pending" }),
  append(7, "permission", { requestId: "permission", title: "Allow?" }),
  append(8, "permission_result", { requestId: "permission", outcome: "deny" }),
  append(9, "agent_text", { text: "Reading" }),
  append(10, "agent_text", { text: " more" }),
  append(11, "system", { text: "User: and then?" }),
  append(12, "commands", { commands: [] }),
  append(13, "usage", { aiCredits: 1 }),
];

describe("browser transcript pages", () => {
  it("serves the whole-history fold as newest and older pages, with prompts and activity", async () => {
    const { first, append, page, store } = await setup();
    const events = history(append);
    const expected = toTerminalBlocks(events);
    const newest = await page(first.id, "?limit=3");
    expect(newest).toMatchObject({ revision: 0, total: expected.length, start: 4 });
    expect(newest.blocks).toEqual(expected.slice(4));
    expect(newest.prompts?.map(({ index, label }) => [index, label])).toEqual([
      [0, "inspect this"],
      [6, "and then?"],
    ]);
    // Bookkeeping is not shown but still counts as activity; usage never did.
    expect(newest.activity).toEqual({
      eventId: events[11]!.eventId,
      sequence: 12,
      createdAt: events[11]!.createdAt,
    });
    const older = await page(first.id, "?before=4&limit=2");
    expect(older).toMatchObject({ generation: newest.generation, start: 2 });
    expect(older.blocks).toEqual(expected.slice(2, 4));
    expect(older.prompts).toBeUndefined();
    expect(older.activity).toBeUndefined();
    expect((await page(first.id, "?before=2")).blocks).toEqual(expected.slice(0, 2));
    expect(store.listEvents(first.id)).toEqual(events);
  });

  it("returns an empty page and reports a missing session", async () => {
    const { app, first, page } = await setup();
    expect(await page(first.id)).toMatchObject({ total: 0, start: 0, blocks: [] });
    expect((await app.inject("/api/sessions/missing/transcript")).statusCode).toBe(404);
  });

  it("publishes ordered block changes that keep a page equal to the full fold", async () => {
    const { first, append, make, page, service, sent } = await setup();
    const events = history(append);
    const initial = await page(first.id);
    let blocks: TerminalBlock[] = initial.blocks.slice();
    const live = [
      make(14, "agent_text", { text: "Answer" }),
      make(15, "agent_text", { text: " continues" }),
      make(16, "usage", { aiCredits: 2 }),
      make(17, "tool", { toolCallId: "tool", status: "completed" }),
      make(18, "agent_text", { text: "Done" }),
    ];
    for (const event of live) expect(service.handleEvent(event)).toBe(true);
    const updates = sent.flatMap((message) =>
      message.type === "event" && message.transcript ? [message.transcript] : [],
    );
    expect(updates.map((update) => update.revision)).toEqual([1, 2, 3, 4]);
    for (const { generation, change } of updates) {
      expect(generation).toBe(initial.generation);
      const next = changedBlock(blocks[change.index], change);
      blocks = blocks.slice();
      blocks[change.index] = next!;
    }
    expect(blocks).toEqual(toTerminalBlocks([...events, ...live]));
    const current = await page(first.id);
    expect(current).toMatchObject({ generation: initial.generation, revision: 4 });
    expect(current.blocks).toEqual(blocks);
  });

  it("drops the projection on a late fill and rebuilds it to include the event", async () => {
    const { first, make, page, service, sent, store } = await setup();
    service.handleEvent(make(1, "agent_text", { text: "first" }));
    service.handleEvent(make(5, "agent_text", { text: "third" }));
    const before = await page(first.id);
    expect(service.handleEvent(make(3, "system", { text: "User: late prompt" }))).toBe(
      true,
    );
    expect(sent.at(-3)).toMatchObject({ type: "transcript_reset", sessionId: first.id });
    const after = await page(first.id);
    expect(after.generation).not.toBe(before.generation);
    expect(after.blocks).toEqual(toTerminalBlocks(store.listEvents(first.id)));
    expect(after.blocks.map((block) => block.kind)).toEqual(["agent", "user", "agent"]);
  });

  it("notices events stored behind its back and rebuilds", async () => {
    const { first, append, page, sent } = await setup();
    append(1, "agent_text", { text: "first" });
    const before = await page(first.id);
    append(2, "error", { message: "stored without the service" });
    const after = await page(first.id);
    expect(after.generation).not.toBe(before.generation);
    expect(after.blocks.map((block) => block.kind)).toEqual(["agent", "error"]);
    expect(sent).toContainEqual({ type: "transcript_reset", sessionId: first.id });
  });
});

describe("TranscriptProjections", () => {
  it("restarts a yielding build when an event lands behind its cursor", async () => {
    const { store, first, make } = await setup();
    for (const sequence of [2, 4, 6, 8]) {
      store.appendEvent(make(sequence, "error", { message: `e${sequence}` }));
    }
    const projections = new TranscriptProjections(store, () => {}, {
      batchSize: 2,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    const pending = projections.page(first.id);
    const late = make(1, "error", { message: "late" });
    store.appendEvent(late);
    expect(projections.apply(late)).toBeUndefined();
    const result = await pending;
    expect(result.blocks.map((block) => block.text)).toEqual([
      "late",
      "e2",
      "e4",
      "e6",
      "e8",
    ]);
  });

  it("evicts the least recently used projection and announces it", async () => {
    const { store, first, second, append } = await setup();
    append(1, "agent_text", { text: "x".repeat(1_000) });
    append(1, "agent_text", { text: "y".repeat(1_000) }, second.id);
    const reset: string[] = [];
    const projections = new TranscriptProjections(store, (id) => reset.push(id), {
      batchSize: 100,
      maxBytes: 3_000,
    });
    await projections.page(first.id);
    expect(reset).toEqual([]);
    await projections.page(second.id);
    expect(reset).toEqual([first.id]);
    expect(projections.retainedBytes).toBeLessThanOrEqual(3_000);
  });
});

describe("history readers", () => {
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
