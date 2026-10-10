import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleOperationSchema } from "@fleet/protocol";
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
