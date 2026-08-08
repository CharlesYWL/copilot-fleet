import { describe, expect, it } from "vitest";
import {
  NodeCommandSchema,
  NodeToHostMessageSchema,
  SessionEventSchema,
  canTransition,
  eventPayload,
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
