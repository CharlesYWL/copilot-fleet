import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageSnapshot, UsageStreamMetadata } from "@fleet/protocol";
import { UsageStore } from "./usage-store.js";

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const native = {
  totalTokens: 455117146,
  inputTokens: 454244362,
  outputTokens: 872784,
  cacheReadTokens: 414225335,
  cacheWriteTokens: 38500830,
  reasoningTokens: 165576,
};
const metadata = (sessionId = "s1", taskId = "t1"): UsageStreamMetadata => ({
  nodeId: "n1",
  nodeName: "Machine",
  sessionId,
  sessionName: sessionId,
  backend: "hermes",
  role: "lead",
  taskId,
  taskName: taskId,
});
const setup = (owners = [metadata()]) => {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  const store = new UsageStore(
    db,
    (_node, session) => owners.find((owner) => owner.sessionId === session),
    undefined,
    () => owners,
  );
  return store;
};
const snapshot = (
  sequence: number,
  source: string,
  amounts = native,
  options: { at?: string; sessionId?: string; baseline?: boolean } = {},
): UsageSnapshot => ({
  id: `reading-${sequence}`,
  sequence,
  sessionId: options.sessionId ?? "s1",
  accounting: {
    nativeSessionId: "native",
    counterId:
      source === "hermes-native-totals-v2"
        ? "hermes-native-totals-v2:fleet:native"
        : "fleet:native",
    source,
    observedAt: options.at ?? "2026-10-20T10:00:00Z",
    baseline: options.baseline ?? true,
    ...amounts,
  },
});
const legacy = { ...native, inputTokens: 1518197, totalTokens: 2390981 };

describe("Hermes legacy counter reconciliation", () => {
  it("quarantines old mixed-definition readings instead of reporting cache greater than total", () => {
    const store = setup();
    store.ingest("n1", [snapshot(1, "hermes-session-totals", legacy)]);
    const report = store.report({});
    expect(report.totals).toMatchObject({
      totalTokens: null,
      inputTokens: null,
      cacheReadTokens: null,
    });
    expect(report.coverage).toMatchObject({
      tokenSessions: 0,
      legacyHermesSessions: 1,
      pendingHermesSessions: 1,
      lastReportedAt: null,
    });
    expect(report.rows).toHaveLength(0);
  });
  it("replaces incompatible history with a corrected cumulative opening without a migration-day charge", () => {
    const store = setup();
    store.ingest("n1", [
      snapshot(1, "hermes-session-totals", legacy, { at: "2026-10-19T10:00:00Z" }),
      snapshot(2, "hermes-session-totals", {
        ...native,
        totalTokens: 8861550,
        inputTokens: 8849175,
        outputTokens: 12375,
        cacheReadTokens: 8432855,
      }),
      snapshot(3, "hermes-native-totals-v2", native, {
        at: "2026-10-20T11:00:00Z",
        baseline: false,
      }),
      snapshot(
        4,
        "hermes-native-totals-v2",
        {
          ...native,
          totalTokens: native.totalTokens + 300,
          inputTokens: native.inputTokens + 200,
          outputTokens: native.outputTokens + 100,
        },
        { at: "2026-10-20T12:00:00Z" },
      ),
    ]);
    expect(store.report({})).toMatchObject({
      totals: {
        totalTokens: 455117446,
        inputTokens: 454244562,
        outputTokens: 872884,
        cacheReadTokens: 414225335,
      },
      coverage: {
        openingTokens: 455117146,
        legacyHermesSessions: 1,
        pendingHermesSessions: 0,
        regressions: 0,
      },
    });
    expect(store.report({ from: "2026-10-20T00:00:00Z" }).totals.totalTokens).toBe(300);
    expect(
      store.report({ groupBy: "day" }).rows.find((row) => row.key === "__opening__")
        ?.totalTokens,
    ).toBe(455117146);
  });
  it("keeps Copilot cache-inclusive totals unchanged", () => {
    const owner = { ...metadata(), backend: "copilot" as const };
    const store = setup([owner]);
    store.ingest("n1", [
      snapshot(1, "copilot-session-totals", {
        ...native,
        totalTokens: 150,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
      }),
    ]);
    expect(store.report({}).totals.totalTokens).toBe(150);
  });
  it("makes reconciliation independent of task filters and the Fleet session alias", () => {
    const store = setup([metadata("s1", "t1"), metadata("s2", "t2")]);
    store.ingest("n1", [
      snapshot(1, "hermes-session-totals", legacy),
      snapshot(2, "hermes-native-totals-v2", native, { sessionId: "s2" }),
    ]);
    expect(store.report({ taskId: "t1" })).toMatchObject({
      totals: { totalTokens: null },
      coverage: { legacyHermesSessions: 1, pendingHermesSessions: 0 },
    });
    expect(store.report({ taskId: "t2" }).totals.totalTokens).toBe(native.totalTokens);
    expect(store.report({ backend: "copilot" }).coverage.legacyHermesSessions ?? 0).toBe(
      0,
    );
  });
  it("does not rewrite raw history and preserves reconciliation across backup restore", () => {
    const store = setup();
    store.ingest("n1", [
      snapshot(1, "hermes-session-totals", legacy),
      snapshot(2, "hermes-native-totals-v2", native, { at: "2026-10-20T11:00:00Z" }),
    ]);
    const backup = store.exportBackup();
    const report = store.report({});
    expect(store.exportBackup()).toEqual(backup);
    const restored = setup();
    restored.importBackup(backup);
    expect(restored.report({}).totals).toEqual(report.totals);
    expect(restored.report({}).coverage).toEqual(report.coverage);
  });
  it("reconciles the screenshot's 95.30M headline and 529.56M cache into consistent inclusive totals", () => {
    const owners = [
      metadata("h1"),
      metadata("h2"),
      { ...metadata("c1"), backend: "copilot" as const },
      { ...metadata("c2"), backend: "copilot" as const },
    ];
    const store = setup(owners);
    const row = (
      sequence: number,
      sessionId: string,
      source: string,
      amounts: typeof native,
    ) => {
      const value = snapshot(sequence, source, amounts, { sessionId });
      value.accounting.nativeSessionId = sessionId;
      value.accounting.counterId = `${source === "hermes-native-totals-v2" ? "hermes-native-totals-v2:" : ""}fleet:${sessionId}`;
      return value;
    };
    store.ingest("n1", [
      row(1, "h1", "hermes-session-totals", legacy),
      row(2, "h2", "hermes-session-totals", {
        ...native,
        totalTokens: 61233,
        inputTokens: 474,
        outputTokens: 60759,
        cacheReadTokens: 32328894,
        cacheWriteTokens: 3595008,
      }),
      row(3, "h1", "hermes-native-totals-v2", native),
      row(4, "h2", "hermes-native-totals-v2", {
        ...native,
        totalTokens: 35985135,
        inputTokens: 35924376,
        outputTokens: 60759,
        cacheReadTokens: 32328894,
        cacheWriteTokens: 3595008,
      }),
      row(5, "c1", "copilot-session-totals", {
        ...native,
        totalTokens: 68689155,
        inputTokens: 68545201,
        outputTokens: 143954,
        cacheReadTokens: 66874475,
        cacheWriteTokens: 1653487,
      }),
      row(6, "c2", "copilot-checkpoint", {
        ...native,
        totalTokens: 17492318,
        inputTokens: 17385233,
        outputTokens: 107085,
        cacheReadTokens: 16132549,
        cacheWriteTokens: 1252440,
      }),
    ]);
    const totals = store.report({}).totals;
    expect(totals).toMatchObject({
      totalTokens: 577283754,
      inputTokens: 576099172,
      outputTokens: 1184582,
      cacheReadTokens: 529561253,
    });
    expect(totals.inputTokens! + totals.outputTokens!).toBe(totals.totalTokens);
    expect(totals.cacheReadTokens!).toBeLessThanOrEqual(totals.inputTokens!);
  });
  it("does not use a future corrected reading to mark past legacy history as refreshed", () => {
    const store = setup();
    store.ingest("n1", [
      snapshot(1, "hermes-session-totals", legacy),
      snapshot(2, "hermes-native-totals-v2", native, { at: "2026-10-21T00:00:00Z" }),
    ]);
    expect(
      store.report({ to: "2026-10-20T12:00:00Z" }).coverage.pendingHermesSessions,
    ).toBe(1);
  });
});
