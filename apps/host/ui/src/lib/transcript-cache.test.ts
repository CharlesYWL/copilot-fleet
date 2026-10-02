import { describe, expect, it } from "vitest";
import {
  TranscriptProjector,
  type SessionEvent,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";
import { TranscriptCache } from "./transcript-cache";

let sequence = 0;
const event = (type: SessionEvent["type"], payload: Record<string, unknown>) => ({
  eventId: `e${++sequence}`,
  sessionId: "s1",
  sequence,
  type,
  payload,
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** A Host-side projection, to produce the pages and changes a browser receives. */
function host(events: SessionEvent[]) {
  const projector = new TranscriptProjector();
  for (const item of events) projector.apply(item);
  let revision = 0;
  return {
    projector,
    page(before?: number, limit = 200): TranscriptPage {
      const end = before ?? projector.blocks.length;
      const start = Math.max(0, end - limit);
      return {
        generation: "g1",
        revision,
        total: projector.blocks.length,
        start,
        blocks: projector.blocks.slice(start, end),
        ...(before === undefined ? { prompts: projector.prompts.slice() } : {}),
      };
    },
    emit(item: SessionEvent): TranscriptUpdate | undefined {
      const change = projector.apply(item);
      return change ? { generation: "g1", revision: ++revision, change } : undefined;
    },
  };
}

const conversation = () => {
  sequence = 0;
  return [
    event("system", { text: "User: one" }),
    event("tool", { toolCallId: "old", title: "Read", status: "pending" }),
    event("agent_text", { text: "first answer" }),
    event("system", { text: "User: two" }),
    event("agent_text", { text: "second answer" }),
  ];
};

describe("TranscriptCache", () => {
  it("follows the Host change by change and matches its blocks", () => {
    const server = host(conversation());
    const cache = new TranscriptCache();
    cache.begin("s1");
    expect(cache.receive("s1", server.page())).toBe(true);
    const before = cache.view("s1")!;
    for (const item of [
      event("agent_text", { text: " grows" }),
      event("tool", { toolCallId: "old", status: "completed" }),
      event("system", { text: "User: three" }),
      event("usage", { aiCredits: 1 }),
    ]) {
      const update = server.emit(item);
      if (update) expect(cache.apply("s1", update)).toBe("applied");
    }
    const view = cache.view("s1")!;
    expect(view.blocks).toEqual(server.projector.blocks);
    expect(view.prompts).toEqual(server.projector.prompts);
    expect(view.total).toBe(server.projector.blocks.length);
    expect(view.revision).toBe(3);
    // Copies handed to React are replaced, never edited.
    expect(before.blocks).toEqual(host(conversation()).projector.blocks);
    expect(view.blocks[0]).toBe(before.blocks[0]);
    expect(view.blocks[4]).not.toBe(before.blocks[4]);
  });

  it("holds changes that arrive while the newest page is in flight", () => {
    const server = host(conversation());
    const cache = new TranscriptCache();
    cache.begin("s1");
    const included = server.emit(event("agent_text", { text: " included" }))!;
    const page = server.page();
    const later = server.emit(event("agent_text", { text: " later" }))!;
    expect(cache.apply("s1", included)).toBe("ignored");
    expect(cache.apply("s1", later)).toBe("ignored");
    expect(cache.view("s1")).toBeUndefined();
    expect(cache.receive("s1", page)).toBe(true);
    expect(cache.view("s1")!.blocks).toEqual(server.projector.blocks);
    expect(cache.view("s1")!.revision).toBe(2);
  });

  it("asks for a resync on a missed revision or a rebuilt projection", () => {
    const server = host(conversation());
    const cache = new TranscriptCache();
    cache.begin("s1");
    cache.receive("s1", server.page());
    server.emit(event("agent_text", { text: " lost" }));
    const next = server.emit(event("agent_text", { text: " next" }))!;
    expect(cache.apply("s1", next)).toBe("resync");
    expect(cache.apply("s1", { ...next, revision: 1, generation: "g2" })).toBe("resync");
    expect(cache.apply("other", next)).toBe("ignored");
  });

  it("prepends older pages without applying a change twice", () => {
    const server = host(conversation());
    const cache = new TranscriptCache();
    cache.begin("s1");
    cache.receive("s1", server.page(undefined, 2));
    expect(cache.view("s1")!.start).toBe(3);
    // The old tool row is not loaded yet; the change is accepted but not applied.
    const toolDone = server.emit(
      event("tool", { toolCallId: "old", status: "completed" }),
    )!;
    const older = server.page(3, 10);
    // This change reached the Host before the older page was read, and only
    // reaches the browser after it.
    const appended = server.emit(event("agent_text", { text: " more" }))!;
    expect(cache.apply("s1", toolDone)).toBe("applied");
    expect(cache.receiveOlder("s1", older)).toBe(true);
    expect(cache.apply("s1", appended)).toBe("applied");
    const view = cache.view("s1")!;
    expect(view.start).toBe(0);
    expect(view.blocks).toEqual(server.projector.blocks);
    expect(view.blocks[1]).toMatchObject({ status: "completed" });
    expect(cache.receiveOlder("s1", { ...older, generation: "g2" })).toBe(false);
  });

  it("forgets abandoned requests and trims copies that are not on screen", () => {
    const server = host(conversation());
    const cache = new TranscriptCache({ maxViews: 2, keepBlocks: 2 });
    cache.begin("gone");
    cache.cancel("gone");
    expect(cache.has("gone")).toBe(false);
    for (const id of ["a", "b", "c"]) {
      cache.begin(id);
      cache.receive(id, server.page());
      cache.trim(id);
    }
    expect(Object.keys(cache.views())).toEqual(["b", "c"]);
    expect(cache.view("b")).toMatchObject({ start: 3, total: 5 });
    expect(cache.view("b")!.blocks).toEqual(server.projector.blocks.slice(3));
    expect(cache.view("c")!.blocks).toHaveLength(5);
  });
});
