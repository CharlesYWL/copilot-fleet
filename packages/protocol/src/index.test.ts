import { describe, expect, it } from "vitest";
import {
  HostToNodeMessageSchema,
  NodeCommandSchema,
  NodeToHostMessageSchema,
  RenameSessionSchema,
  SessionEventSchema,
  SessionSchema,
  canTransition,
  eventPayload,
  normalizeHostUrl,
  sameHostUrl,
  tryParseJson,
  type SessionEvent,
} from "./index.js";

describe("protocol validation", () => {
  it("accepts a valid streamed event", () => {
    expect(
      NodeToHostMessageSchema.parse({
        type: "event",
        event: {
          eventId: "e1",
          sessionId: "s1",
          sequence: 1,
          type: "agent_text",
          payload: { text: "hello" },
          createdAt: new Date().toISOString(),
        },
      }).type,
    ).toBe("event");
  });

  it("rejects invalid sequences and malformed commands", () => {
    expect(() =>
      SessionEventSchema.parse({
        eventId: "e",
        sessionId: "s",
        sequence: 0,
        type: "agent_text",
        payload: {},
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
    expect(() =>
      NodeCommandSchema.parse({
        type: "start_session",
        commandId: "c",
        sessionId: "s",
        localPath: "",
        prompt: "go",
      }),
    ).toThrow();
  });

  it("guards malformed WebSocket JSON frames", () => {
    expect(tryParseJson('{"type":"heartbeat"}').ok).toBe(true);
    expect(tryParseJson("{not-json").ok).toBe(false);
  });

  it("reads a session row written before names existed", () => {
    // Older Hosts have rows with no name column; parsing must not fail, and the
    // absent name has to arrive as "" so readers fall back to the prompt.
    const session = SessionSchema.parse({
      id: "s1",
      workspaceId: "w1",
      workspaceName: "repo",
      placementId: "p1",
      nodeId: "n1",
      nodeName: "node",
      state: "idle",
      initialPrompt: "go",
      currentActivity: "",
      lastText: "",
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T09:00:00.000Z",
    });
    expect(session.name).toBe("");
  });

  it("accepts a rename that clears the name", () => {
    expect(RenameSessionSchema.parse({ name: "" }).name).toBe("");
    expect(() => RenameSessionSchema.parse({ name: "x".repeat(121) })).toThrow();
  });

  it("carries a new Host address to the node", () => {
    const message = HostToNodeMessageSchema.parse({
      type: "host_url",
      hostUrl: "https://new.trycloudflare.com",
    });
    expect(message).toEqual({
      type: "host_url",
      hostUrl: "https://new.trycloudflare.com",
    });
    expect(() =>
      HostToNodeMessageSchema.parse({ type: "host_url", hostUrl: "" }),
    ).toThrow();
  });
});

describe("normalizeHostUrl", () => {
  it("ignores the spellings that name the same Host", () => {
    // All of these dial the same socket, so treating them as different would
    // announce moves that move nobody.
    expect(sameHostUrl("https://Fleet.Example.com/", "https://fleet.example.com")).toBe(
      true,
    );
    expect(sameHostUrl("http://127.0.0.1:8787", "http://127.0.0.1:8787/")).toBe(true);
    expect(sameHostUrl("http://127.0.0.1:8787", "http://127.0.0.1:8788")).toBe(false);
  });

  it("keeps a value it cannot parse rather than blanking it", () => {
    expect(normalizeHostUrl("not a url/")).toBe("not a url");
    expect(normalizeHostUrl("  ")).toBe("");
  });
});

describe("session transitions", () => {
  it("supports prompt cycles and rejects terminal resurrection", () => {
    expect(canTransition("queued", "starting")).toBe(true);
    expect(canTransition("running", "idle")).toBe(true);
    expect(canTransition("idle", "running")).toBe(true);
    expect(canTransition("offline", "idle")).toBe(true);
    // Resume lands in starting and then waits for the next prompt.
    expect(canTransition("stopped", "starting")).toBe(true);
    expect(canTransition("starting", "idle")).toBe(true);
    expect(canTransition("stopped", "running")).toBe(false);
  });
});

describe("eventPayload", () => {
  const event = (type: SessionEvent["type"], payload: Record<string, unknown>) =>
    SessionEventSchema.parse({
      eventId: "e1",
      sessionId: "s1",
      sequence: 1,
      type,
      payload,
      createdAt: "2026-08-08T09:00:00.000Z",
    });

  it("reads a payload as the shape its type promises", () => {
    expect(
      eventPayload(event("state", { state: "running", activity: "go" }), "state"),
    ).toEqual({ state: "running", activity: "go" });
  });

  it("refuses to read one event type as another", () => {
    expect(eventPayload(event("agent_text", { text: "hi" }), "system")).toBeUndefined();
  });

  it("reports a payload that lost its shape instead of blanking the field", () => {
    expect(eventPayload(event("agent_text", { text: 42 }), "agent_text")).toBeUndefined();
    expect(eventPayload(event("state", { state: "elsewhere" }), "state")).toBeUndefined();
  });

  it("keeps the rest of a permission when its options are malformed", () => {
    const payload = eventPayload(
      event("permission", { requestId: "r1", title: "Run tests", options: "nope" }),
      "permission",
    );
    expect(payload).toEqual({ requestId: "r1", title: "Run tests" });
  });

  it("accepts a payload missing the optional fields a producer may omit", () => {
    expect(eventPayload(event("tool", { toolCallId: "t1" }), "tool")).toEqual({
      toolCallId: "t1",
    });
  });
});
