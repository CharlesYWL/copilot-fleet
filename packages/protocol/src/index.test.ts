import { describe, expect, it } from "vitest";
import {
  NodeCommandSchema,
  NodeToHostMessageSchema,
  SessionEventSchema,
  canTransition,
  tryParseJson,
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
    expect(canTransition("stopped", "running")).toBe(false);
  });
});
