import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleOperationSchema, SessionSchema } from "@fleet/protocol";
import { SessionConsoleStore } from "./session-console-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return new SessionConsoleStore(db);
};
const operation = () =>
  ConsoleOperationSchema.parse({
    id: randomUUID(),
    sessionId: "session-a",
    grantId: randomUUID(),
    controlEpoch: 1,
    action: "prompt",
    payload: { prompt: "Scoped input" },
    payloadDigest: "a".repeat(64),
    afterSequence: 7,
    state: "queued",
    createdAt: new Date().toISOString(),
  });

describe("Host console receipts", () => {
  it("validates a live binding without rewriting its grant on every batch", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const store = new SessionConsoleStore(db);
    const session = SessionSchema.parse({
      id: "session",
      workspaceId: "workspace",
      workspaceName: "Workspace",
      placementId: "placement",
      nodeId: "node",
      nodeName: "Node",
      state: "idle",
      initialPrompt: "Work",
      currentActivity: "",
      lastText: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentSessionId: "native",
    });
    const grant = store.grant("host", session, 0);
    const changes = db.prepare("SELECT total_changes() count").get()!.count;
    for (let index = 0; index < 10; index++)
      expect(store.matches(grant, session)).toBe(true);
    expect(store.matches(grant, { ...session, nodeId: "other-node" })).toBe(false);
    expect(db.prepare("SELECT total_changes() count").get()!.count).toBe(changes);
  });
  it("does not let another session overwrite a local-operation identity", () => {
    const store = fixture();
    const original = operation();
    store.localOperation(original);
    expect(() => store.localOperation({ ...original, sessionId: "session-b" })).toThrow(
      /identity changed/,
    );
    expect(store.localOperations("session-a")).toEqual([original]);
    expect(store.localOperations("session-b")).toEqual([]);
  });

  it("does not resurrect a settled queue entry from a stale replay", () => {
    const store = fixture();
    const queued = operation();
    store.localOperation(queued);
    store.localOperation({ ...queued, state: "settled" });
    store.localOperation(queued);
    expect(store.localOperations(queued.sessionId)).toMatchObject([
      { state: "settled", payload: {} },
    ]);
  });

  it("keeps ambiguous operations non-replayable and settled retries idempotent", () => {
    const store = fixture();
    const id = randomUUID();
    expect(store.accept(id, "session-a", { command: "stop" })).toBe(true);
    expect(() => store.accept(id, "session-a", { command: "stop" })).toThrow(/uncertain/);
    store.settle(id);
    expect(store.accept(id, "session-a", { command: "stop" })).toBe(false);
    expect(() => store.accept(id, "session-b", { command: "stop" })).toThrow(
      /different input/,
    );
  });
});
