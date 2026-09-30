import { describe, expect, it } from "vitest";
import { SessionEventSchema } from "@fleet/protocol";
import { toTerminalBlocks } from "../../apps/host/ui/src/lib/terminal-blocks.js";
import {
  HISTORY_FIXTURE_VERSION,
  historyEvents,
  incomingEvents,
} from "./history-fixture.js";
import {
  HistoryReportSchema,
  comparisonLines,
  parseOptions,
  summarize,
  type HistoryReport,
} from "./history-report.js";
import { runBenchmark } from "./history.js";

function exampleReport(): HistoryReport {
  return {
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    environment: {
      node: "v22",
      platform: "win32",
      arch: "x64",
      cpu: "synthetic",
      cpuCount: 4,
      revision: "baseline",
      dirty: false,
    },
    fixture: {
      version: HISTORY_FIXTURE_VERSION,
      leadEvents: 400,
      backgroundEventsPerSession: 29,
      sessions: 2,
      totalEvents: 429,
      leadBlocks: 20,
      eventTypes: {},
    },
    sampling: { iterations: 2, warmup: 1, percentile: "nearest-rank" },
    measurements: { fold: summarize([1, 2]) },
    sizesBytes: { rawHistory: 100 },
    hostEventLoop: { resolutionMs: 10, meanMs: 10, p95Ms: 10, maxMs: 10 },
    notes: [],
  };
}

describe("history benchmark fixture", () => {
  it("is deterministic, validates, and models many chunks per presentation block", () => {
    const events = [...historyEvents("synthetic", 0, 400)];
    expect(events).toEqual([...historyEvents("synthetic", 0, 400)]);
    expect(events.map((event) => SessionEventSchema.parse(event))).toEqual(events);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 400 }, (_, index) => index + 1),
    );
    const mix: Record<string, number> = {};
    for (const event of events) mix[event.type] = (mix[event.type] ?? 0) + 1;
    expect(mix).toEqual({
      system: 2,
      state: 2,
      commands: 2,
      config: 2,
      agent_session: 2,
      agent_thought: 68,
      agent_text: 272,
      permission: 2,
      tool: 12,
      permission_result: 2,
      usage: 32,
      turn_complete: 2,
    });
    const blocks = toTerminalBlocks(events);
    expect(blocks).toHaveLength(20);
    expect(blocks.find((block) => block.text === "Read fixture")).toMatchObject({
      status: "completed",
      detail: "synthetic.ts",
    });
    expect(
      blocks.find((block) => block.text === "task_complete")?.body?.length,
    ).toBeGreaterThan(64_000);
    const serialized = JSON.stringify(blocks);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(serialized.length);
  });

  it("keeps identities unique across sessions and supports partial turns", () => {
    const first = [...historyEvents("first", 0, 225)];
    const second = [...historyEvents("second", 1, 225)];
    expect(first).toHaveLength(225);
    expect(new Set([...first, ...second].map((event) => event.eventId)).size).toBe(450);
    expect(
      toTerminalBlocks([...historyEvents("synthetic", 0, 4000)]).some(
        (block) => block.kind === "wake",
      ),
    ).toBe(true);
  });

  it("uses explicit streaming cases including updates to a non-tail tool", () => {
    const cases = incomingEvents("synthetic", 401);
    expect(cases.text?.type).toBe("agent_text");
    expect(cases.thought?.type).toBe("agent_thought");
    expect(cases.olderTool?.payload.toolCallId).toBe("synthetic:read:0");
    expect(cases.permission?.type).toBe("permission");
    for (const event of Object.values(cases))
      expect(SessionEventSchema.parse(event).sequence).toBe(401);
    const original = [...historyEvents("synthetic", 0, 400)];
    const updated = toTerminalBlocks([...original, cases.olderTool!]);
    expect(updated).toHaveLength(20);
    expect(updated.find((block) => block.text === "Read fixture")).toMatchObject({
      status: "failed",
      body: "Synthetic late tool failure",
    });
  });
});

describe("history benchmark reporting", () => {
  it("reports nearest-rank percentiles without mutating samples", () => {
    const samples = Array.from({ length: 30 }, (_, index) => 30 - index);
    expect(summarize(samples)).toEqual({
      samplesMs: samples,
      medianMs: 15,
      p95Ms: 29,
      minMs: 1,
      maxMs: 30,
    });
    expect(samples[0]).toBe(30);
    expect(() => summarize([])).toThrow();
    expect(() => summarize([NaN])).toThrow();
    expect(() => summarize([-1])).toThrow();
  });

  it("parses bounded options and rejects typos and invalid inputs", () => {
    expect(parseOptions([])).toMatchObject({
      events: 112000,
      sessions: 26,
      iterations: 30,
      warmup: 5,
    });
    expect(parseOptions(["--warmup", "0"]).warmup).toBe(0);
    for (const args of [
      ["--events", "-1"],
      ["--events", "3.5"],
      ["--sessions", "0"],
      ["--iterations", "0"],
      ["--iterations", "NaN"],
      ["--warmp", "5"],
      ["--output", ""],
      ["unexpected"],
    ])
      expect(() => parseOptions(args)).toThrow();
  });

  it("compares matching workloads, including zero baselines, but rejects mismatches", () => {
    const baseline = exampleReport();
    const current = exampleReport();
    current.environment.revision = "after";
    current.measurements.fold = summarize([2, 4]);
    expect(comparisonLines(current, baseline)).toEqual([
      "fold: P95 2.00 -> 4.00 ms (100.0%)",
    ]);
    baseline.measurements.fold = summarize([0, 0]);
    expect(comparisonLines(current, baseline)[0]).toContain("zero baseline");
    baseline.fixture.leadEvents++;
    expect(() => comparisonLines(current, baseline)).toThrow("fixture");
    baseline.fixture.leadEvents--;
    baseline.environment.node = "different";
    expect(() => comparisonLines(current, baseline)).toThrow("environment");
    expect(() => HistoryReportSchema.parse({})).toThrow();
  });
});

it("runs real store/HTTP code on an isolated fixture and returns all measured samples", async () => {
  const report = HistoryReportSchema.parse(
    await runBenchmark(
      parseOptions([
        "--events",
        "400",
        "--sessions",
        "2",
        "--iterations",
        "2",
        "--warmup",
        "1",
      ]),
    ),
  );
  expect(report.fixture).toMatchObject({
    leadEvents: 400,
    totalEvents: 429,
    sessions: 2,
    leadBlocks: 20,
  });
  for (const measurement of Object.values(report.measurements)) {
    expect(measurement.samplesMs).toHaveLength(2);
    expect(measurement).toEqual(summarize(measurement.samplesMs));
  }
  expect(report.measurements["store.listEvents"]).toBeDefined();
  expect(report.measurements["http.history.total"]).toBeDefined();
  expect(report.measurements["http.probe.duringHistory"]).toBeDefined();
  expect(report.sizesBytes.httpHistory).toBe(report.sizesBytes.currentTranscript);
  expect(report.sizesBytes.rawHistory).toBeGreaterThan(
    report.sizesBytes.allBlocksEstimate!,
  );
  expect(Number.isFinite(report.hostEventLoop.maxMs)).toBe(true);
}, 30_000);
