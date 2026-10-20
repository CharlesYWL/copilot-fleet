import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageSnapshot, UsageStreamMetadata } from "@fleet/protocol";
import { UsageStore } from "./usage-store.js";

const metadata: UsageStreamMetadata = {
  nodeId: "n1",
  nodeName: "Laptop",
  sessionId: "s1",
  sessionName: "Worker",
  backend: "copilot",
  role: "worker",
  taskId: "t1",
  taskName: "Build feature",
};
const snapshot = (
  sequence: number,
  at: string,
  values: Record<string, unknown> = {},
): UsageSnapshot => ({
  id: `snap-${sequence}`,
  sequence,
  sessionId: "s1",
  accounting: {
    nativeSessionId: "native",
    counterId: "native",
    source: "test",
    observedAt: at,
    ...values,
  },
});
const opened: DatabaseSync[] = [];
const setup = () => {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  let available = true;
  const store = new UsageStore(
    db,
    (node, session) => {
      if (node !== metadata.nodeId) throw new Error("Session ownership mismatch");
      return available && session === "s1" ? metadata : undefined;
    },
    undefined,
    () => (available ? [metadata] : []),
  );
  return {
    store,
    removeSession: () => {
      available = false;
    },
  };
};
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("UsageStore cumulative accounting", () => {
  it("counts cumulative snapshots once including duplicate retries and identical shutdown totals", () => {
    const { store } = setup();
    const first = snapshot(1, "2026-10-19T10:00:00Z", {
      aiCredits: 10,
      totalTokens: 100,
      baseline: true,
    });
    store.ingest("n1", [
      first,
      snapshot(2, "2026-10-19T11:00:00Z", { aiCredits: 12, totalTokens: 120 }),
      snapshot(3, "2026-10-19T12:00:00Z", { aiCredits: 12, totalTokens: 120 }),
    ]);
    expect(store.ingest("n1", [first])).toBe(1);
    expect(store.report({ groupBy: "machine" }).totals).toMatchObject({
      aiCredits: 12,
      totalTokens: 120,
      cacheReadTokens: null,
    });
    expect(
      store.report({ from: "2026-10-19T10:00:00Z", to: "2026-10-20T00:00:00Z" }).totals,
    ).toMatchObject({ aiCredits: 2, totalTokens: 20 });
  });
  it("keeps separate metric baselines when tokens arrive after credits", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { baseline: true, aiCredits: 1 }),
      snapshot(2, "2026-10-19T10:00:00Z", { baseline: true, totalTokens: 100 }),
      snapshot(3, "2026-10-19T11:00:00Z", { aiCredits: 3 }),
      snapshot(4, "2026-10-19T12:00:00Z", { totalTokens: 160 }),
    ]);
    expect(store.report({ from: "2026-10-19T09:00:00Z" }).totals).toMatchObject({
      aiCredits: 2,
      totalTokens: 60,
    });
    expect(store.report({}).coverage).toMatchObject({
      openingAiCredits: 1,
      openingTokens: 100,
    });
  });
  it("treats a late first metric as an opening balance when the counter scope was attached existing", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { baseline: true, aiCredits: 1 }),
      snapshot(2, "2026-10-19T10:00:00Z", { totalTokens: 100 }),
      snapshot(3, "2026-10-19T11:00:00Z", { totalTokens: 120 }),
    ]);
    expect(store.report({ from: "2026-10-19T09:00:00Z" })).toMatchObject({
      totals: { totalTokens: 20 },
      coverage: { openingTokens: 100 },
    });
  });
  it("keeps initial balances out of daily allocation and preserves history after session deletion", () => {
    const { store, removeSession } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { baseline: true, totalTokens: 100 }),
    ]);
    removeSession();
    store.ingest("n1", [snapshot(2, "2026-10-19T10:00:00Z", { totalTokens: 110 })]);
    const report = store.report({ groupBy: "task" });
    expect(report.totals.totalTokens).toBe(110);
    expect(report.rows[0]).toMatchObject({ label: "Build feature", totalTokens: 110 });
    expect(
      store.report({ groupBy: "day" }).rows.find((row) => row.key === "__opening__")
        ?.totalTokens,
    ).toBe(100);
  });
  it("exposes boundary-overlapping intervals rather than assigning all spend to the sample date", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-18T23:59:00Z", { totalTokens: 100, baseline: true }),
      snapshot(2, "2026-10-19T00:01:00Z", { totalTokens: 200 }),
    ]);
    expect(
      store.report({ from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" }),
    ).toMatchObject({ totals: { totalTokens: 0 }, coverage: { unallocatedTokens: 100 } });
  });
  it("rejects conflicting identities and foreign ownership without a partial batch commit", () => {
    const { store } = setup();
    const first = snapshot(1, "2026-10-19T09:00:00Z", { aiCredits: 1 });
    store.ingest("n1", [first]);
    expect(() =>
      store.ingest("n1", [
        snapshot(2, "2026-10-19T10:00:00Z", { aiCredits: 2 }),
        { ...first, accounting: { ...first.accounting, aiCredits: 99 } },
      ]),
    ).toThrow();
    expect(store.report({}).totals.aiCredits).toBe(1);
    expect(() => store.ingest("n2", [first])).toThrow(/ownership/i);
  });
  it("flags counter regressions without inventing a reset or double-charging recovery", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { totalTokens: 100 }),
      snapshot(2, "2026-10-19T10:00:00Z", { totalTokens: 20 }),
      snapshot(3, "2026-10-19T11:00:00Z", { totalTokens: 120 }),
    ]);
    expect(store.report({})).toMatchObject({
      totals: { totalTokens: 120 },
      coverage: { regressions: 1 },
    });
  });
  it("does not charge an adopted native conversation twice under a new Fleet session or task filter", () => {
    const db = new DatabaseSync(":memory:");
    opened.push(db);
    const second = { ...metadata, sessionId: "s2", taskId: "t2", taskName: "Follow-up" };
    const store = new UsageStore(db, (_node, session) =>
      session === "s1" ? metadata : second,
    );
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { totalTokens: 100 }),
      {
        ...snapshot(2, "2026-10-19T10:00:00Z", { totalTokens: 120, baseline: true }),
        sessionId: "s2",
      },
    ]);
    expect(store.report({}).totals.totalTokens).toBe(120);
    expect(store.report({ taskId: "t2" }).totals.totalTokens).toBe(20);
  });
  it("keeps a new session's first reading spanning midnight out of an exact daily total", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T00:01:00Z", {
        startedAt: "2026-10-18T23:59:00Z",
        totalTokens: 100,
      }),
    ]);
    expect(
      store.report({ from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" }),
    ).toMatchObject({ totals: { totalTokens: 0 }, coverage: { unallocatedTokens: 100 } });
  });
  it("accepts a fresh Node journal's sequence after an identity move without replaying prior consumption", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T11:00:00Z", { totalTokens: 10 }),
      snapshot(2, "2026-10-19T12:00:00Z", { totalTokens: 20 }),
    ]);
    const moved = {
      ...snapshot(1, "2026-10-19T13:00:00Z", { totalTokens: 25, baseline: true }),
      id: "fresh-journal-1",
    };
    expect(store.ingest("n1", [moved])).toBe(1);
    expect(store.report({}).totals.totalTokens).toBe(25);
    expect(
      store.report({ from: "2026-10-19T12:00:00Z", to: "2026-10-19T14:00:00Z" }).totals
        .totalTokens,
    ).toBe(5);
  });
  it("round-trips retained history without depending on live session rows", () => {
    const { store } = setup();
    store.ingest("n1", [
      snapshot(1, "2026-10-19T09:00:00Z", { aiCredits: 1, totalTokens: 10 }),
    ]);
    const restored = setup();
    restored.removeSession();
    restored.store.importBackup(store.exportBackup());
    expect(restored.store.report({}).totals).toEqual(store.report({}).totals);
  });
});
