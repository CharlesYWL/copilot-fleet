import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountingTokens,
  hermesResponseTokens,
  readNativeTokenTotals,
} from "./usage-totals.js";
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
    expect(
      hermesResponseTokens({
        usage: {
          totalTokens: 100,
          inputTokens: 80,
          outputTokens: 20,
          cachedReadTokens: 60,
          thoughtTokens: 10,
        },
      }),
    ).toMatchObject({ totalTokens: 100, cacheReadTokens: 60, reasoningTokens: 10 });
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
  it("rejects malformed and negative totals without exposing payload text", () => {
    expect(hermesResponseTokens({ usage: { totalTokens: -1 } })).toBeUndefined();
    expect(
      hermesResponseTokens({ usage: { totalTokens: Number.POSITIVE_INFINITY } }),
    ).toBeUndefined();
  });
});
