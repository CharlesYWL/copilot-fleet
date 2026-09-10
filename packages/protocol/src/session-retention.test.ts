import { describe, expect, it } from "vitest";
import {
  isResumableSession,
  isSessionActivityEvent,
  NodeCommandSchema,
  NodeToHostMessageSchema,
  SESSION_RETENTION_DAY_MS,
  sessionRetentionCutoff,
  SessionSchema,
  type SessionEvent,
} from "./index.js";

describe("session retention protocol", () => {
  const command = {
    type: "delete_session",
    commandId: "cleanup",
    sessionId: "fleet",
    agentSessionId: "copilot",
    inactiveBefore: "2026-08-01T00:00:00.000Z",
    retentionDays: 30,
  };

  it("round-trips scoped cleanup commands and separate acknowledgements", () => {
    expect(NodeCommandSchema.parse(command)).toEqual(command);
    const result = {
      type: "session_cleanup_result",
      commandId: "cleanup",
      sessionId: "fleet",
      ok: true,
    };
    expect(NodeToHostMessageSchema.parse(result)).toEqual(result);
  });

  it.each([0, 1, 29, 30.5, -30, Infinity, NaN])(
    "rejects a destructive command with retentionDays=%s",
    (retentionDays) => {
      expect(NodeCommandSchema.safeParse({ ...command, retentionDays }).success).toBe(
        false,
      );
    },
  );

  it("has an inclusive 30-day cutoff and an explicit disabled policy", () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    expect(sessionRetentionCutoff(now, 30)).toBe(now - 30 * SESSION_RETENTION_DAY_MS);
    expect(sessionRetentionCutoff(now, 0)).toBeUndefined();
    expect(() => sessionRetentionCutoff(NaN, 30)).toThrow();
  });

  it.each([
    "agent_text",
    "agent_thought",
    "tool",
    "permission",
    "permission_result",
    "turn_complete",
    "error",
  ] as const)("counts %s but not its historical replay as activity", (type) => {
    const event: SessionEvent = {
      eventId: "event",
      sessionId: "session",
      sequence: 1,
      type,
      payload: {},
      createdAt: command.inactiveBefore,
    };
    expect(isSessionActivityEvent(event)).toBe(true);
    expect(isSessionActivityEvent({ ...event, payload: { historyReplay: true } })).toBe(
      false,
    );
  });

  it("does not confuse connectivity/picker replay with real user input", () => {
    const event: SessionEvent = {
      eventId: "event",
      sessionId: "session",
      sequence: 1,
      type: "system",
      payload: { text: "Host reconnected" },
      createdAt: command.inactiveBefore,
    };
    expect(isSessionActivityEvent(event)).toBe(false);
    expect(
      isSessionActivityEvent({ ...event, payload: { text: "User: Continue" } }),
    ).toBe(true);
    for (const type of ["state", "commands", "config", "agent_session"] as const) {
      expect(isSessionActivityEvent({ ...event, type })).toBe(false);
    }
  });

  it("keeps old snapshots readable but never offers Resume during deletion", () => {
    expect(SessionSchema.shape.lastActivityAt.parse(undefined)).toBeUndefined();
    expect(SessionSchema.shape.cleanupRequested.parse(undefined)).toBeUndefined();
    const session = { state: "stopped" as const, agentSessionId: "copilot" };
    expect(isResumableSession(session)).toBe(true);
    expect(isResumableSession({ ...session, cleanupRequested: true })).toBe(false);
  });
});
