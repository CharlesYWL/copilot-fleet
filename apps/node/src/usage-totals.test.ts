import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountingTokens, readNativeTokenTotals } from "./usage-totals.js";
const paths: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("cumulative backend token snapshots", () => {
  it("counts cache and reasoning once and prefers one aggregate view", () => {
    const metrics = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 60,
        cacheWriteTokens: 10,
        reasoningTokens: 20,
      },
    };
    expect(
      accountingTokens({
        accountingSnapshot: {
          modelMetrics: { model: metrics },
          providerModelMetrics: [{ metrics }],
        },
      }),
    ).toEqual({
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
    });
  });
  it("keeps missing counts unknown rather than treating context as consumption", () => {
    expect(accountingTokens({ used: 100, size: 200 })).toBeUndefined();
    expect(
      accountingTokens({ modelMetrics: { model: { usage: { inputTokens: 100 } } } }),
    ).toBeUndefined();
  });
  it("reads live totals even when an older native database lacks optional detail columns", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-token-totals-"));
    paths.push(home);
    vi.stubEnv("COPILOT_HOME", home);
    const db = new DatabaseSync(join(home, "session-store.db"));
    db.exec(
      "CREATE TABLE assistant_usage_events (session_id TEXT,input_tokens INTEGER,output_tokens INTEGER); INSERT INTO assistant_usage_events VALUES ('s',100,20),('s',50,10),('other',999,999)",
    );
    db.close();
    expect(readNativeTokenTotals("copilot", "s")).toEqual({
      totalTokens: 180,
      inputTokens: 150,
      outputTokens: 30,
    });
  });
  it("includes Hermes's disjoint cache buckets in input and total exactly once", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-hermes-totals-"));
    paths.push(home);
    vi.stubEnv("HERMES_HOME", home);
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec(
      "CREATE TABLE sessions(id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER); INSERT INTO sessions VALUES ('native',1518197,872784,414225335,38500830,165576)",
    );
    db.close();
    expect(readNativeTokenTotals("hermes", "native")).toEqual({
      inputTokens: 454244362,
      outputTokens: 872784,
      cacheReadTokens: 414225335,
      cacheWriteTokens: 38500830,
      reasoningTokens: 165576,
      totalTokens: 455117146,
    });
  });
  it("requires known Hermes cache counters instead of returning an understated total", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-hermes-totals-"));
    paths.push(home);
    vi.stubEnv("HERMES_HOME", home);
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec(
      "CREATE TABLE sessions(id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER); INSERT INTO sessions VALUES ('missing-column',100,20,300),('null-cache',100,20,NULL)",
    );
    db.close();
    expect(readNativeTokenTotals("hermes", "missing-column")).toBeUndefined();
    expect(readNativeTokenTotals("hermes", "null-cache")).toBeUndefined();
  });
  it("rejects Hermes overflow and negative cache values while preserving explicit zero", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-hermes-totals-"));
    paths.push(home);
    vi.stubEnv("HERMES_HOME", home);
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec(
      "CREATE TABLE sessions(id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER); INSERT INTO sessions VALUES ('overflow',9007199254740991,0,1,0),('negative',1,2,-3,0),('zero',0,0,0,0)",
    );
    db.close();
    expect(readNativeTokenTotals("hermes", "overflow")).toBeUndefined();
    expect(readNativeTokenTotals("hermes", "negative")).toBeUndefined();
    expect(readNativeTokenTotals("hermes", "zero")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
  it("rejects malformed and negative totals without exposing payload text", () => {
    for (const inputTokens of [-1, Number.POSITIVE_INFINITY]) {
      expect(
        accountingTokens({
          modelMetrics: { model: { usage: { inputTokens, outputTokens: 1 } } },
        }),
      ).toBeUndefined();
    }
  });
});
