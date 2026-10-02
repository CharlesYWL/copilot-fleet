import { describe, expect, it } from "vitest";
import { SessionPermissions, type SessionEvent } from "./index.js";

const event = (
  sessionId: string,
  sequence: number,
  type: SessionEvent["type"] = "permission",
): SessionEvent => ({
  eventId: `${sessionId}:${sequence}`,
  sessionId,
  sequence,
  type,
  payload: { requestId: "same-id", title: "Run command", outcome: "allow_once" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("SessionPermissions", () => {
  it("keeps session namespaces separate and does no transcript work for text", () => {
    const permissions = new SessionPermissions();
    const first = event("first", 1);
    const second = event("second", 1);
    expect(permissions.apply([first, second])).toBe(true);
    const pending = permissions.requests();
    expect(pending).toEqual([first, second]);
    expect(permissions.apply([event("first", 2, "agent_text")])).toBe(false);
    expect(permissions.requests()).toBe(pending);
    permissions.apply([event("first", 3, "permission_result")]);
    expect(permissions.requests()).toEqual([second]);
  });

  it("does not resurrect a resolved request from a late history fetch or replay", () => {
    const permissions = new SessionPermissions();
    const request = event("session", 1);
    const resolution = event("session", 2, "permission_result");
    permissions.apply([request]);
    permissions.apply([resolution]);
    const settled = permissions.requests();
    expect(permissions.apply([request, resolution])).toBe(false);
    expect(permissions.requests()).toBe(settled);
    expect(settled).toEqual([]);
  });

  it("hydrates resolution tombstones before receiving an older request", () => {
    const permissions = new SessionPermissions();
    permissions.apply([event("session", 4, "permission_result")]);
    permissions.apply([event("session", 1)]);
    expect(permissions.requests()).toEqual([]);
    const newRequest = event("session", 5);
    permissions.apply([newRequest]);
    expect(permissions.requests()).toEqual([newRequest]);
  });

  it("prunes removed sessions and ignores unreadable request ids", () => {
    const permissions = new SessionPermissions();
    permissions.apply([
      event("first", 1),
      event("second", 1),
      { ...event("third", 1), payload: { requestId: 42 } },
    ]);
    expect(permissions.prune(new Set(["second"]))).toBe(true);
    expect(permissions.requests()).toEqual([event("second", 1)]);
    expect(permissions.prune(new Set(["second"]))).toBe(false);
  });
});
