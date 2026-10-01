import { parseArgs } from "node:util";
import { z } from "zod";
import { HISTORY_FIXTURE_VERSION } from "./history-fixture.js";

const duration = z.number().finite().nonnegative();
const MeasurementSchema = z.object({
  samplesMs: z.array(duration).min(1),
  medianMs: duration,
  p95Ms: duration,
  minMs: duration,
  maxMs: duration,
});

const EventLoopSchema = z.object({
  resolutionMs: duration,
  meanMs: duration,
  p95Ms: duration,
  maxMs: duration,
});

export const HistoryReportSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  environment: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    cpu: z.string(),
    cpuCount: z.number().int().positive(),
    revision: z.string(),
    dirty: z.boolean(),
  }),
  fixture: z.object({
    version: z.literal(HISTORY_FIXTURE_VERSION),
    leadEvents: z.number().int().positive(),
    backgroundEventsPerSession: z.number().int().nonnegative(),
    sessions: z.number().int().positive(),
    totalEvents: z.number().int().positive(),
    leadBlocks: z.number().int().nonnegative(),
    eventTypes: z.record(z.string(), z.number().int().nonnegative()),
  }),
  sampling: z.object({
    iterations: z.number().int().positive(),
    warmup: z.number().int().nonnegative(),
    percentile: z.literal("nearest-rank"),
  }),
  measurements: z.record(z.string(), MeasurementSchema),
  sizesBytes: z.record(z.string(), z.number().int().nonnegative()),
  hostEventLoop: EventLoopSchema,
  /** Event-loop delay while projections were rebuilt from the log. */
  hostEventLoopCold: EventLoopSchema.optional(),
  notes: z.array(z.string()),
});

export type HistoryReport = z.infer<typeof HistoryReportSchema>;
export type Measurement = z.infer<typeof MeasurementSchema>;
export type BenchmarkOptions = {
  events: number;
  sessions: number;
  iterations: number;
  warmup: number;
  output: string;
  baseline?: string;
  worker: boolean;
  help: boolean;
};

export function parseOptions(args: string[]): BenchmarkOptions {
  const { values } = parseArgs({
    args,
    options: {
      events: { type: "string", default: "112000" },
      sessions: { type: "string", default: "26" },
      iterations: { type: "string", default: "30" },
      warmup: { type: "string", default: "5" },
      output: { type: "string", default: "dist/benchmarks/history.json" },
      baseline: { type: "string" },
      worker: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const integer = (name: string, raw: string, min: number, max: number) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  if (!values.output.trim()) throw new Error("--output must name a JSON file");
  if (values.baseline !== undefined && !values.baseline.trim())
    throw new Error("--baseline must name a JSON file");
  return {
    events: integer("events", values.events, 200, 2_000_000),
    sessions: integer("sessions", values.sessions, 1, 100),
    iterations: integer("iterations", values.iterations, 1, 1000),
    warmup: integer("warmup", values.warmup, 0, 100),
    output: values.output,
    ...(values.baseline ? { baseline: values.baseline } : {}),
    worker: values.worker,
    help: values.help,
  };
}

export function summarize(samplesMs: readonly number[]): Measurement {
  if (
    samplesMs.length === 0 ||
    samplesMs.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("Measurements must contain finite, nonnegative samples");
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]!;
  return {
    samplesMs: [...samplesMs],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}

export function assertComparable(current: HistoryReport, baseline: HistoryReport): void {
  for (const key of [
    "version",
    "leadEvents",
    "backgroundEventsPerSession",
    "sessions",
    "totalEvents",
  ] as const) {
    if (current.fixture[key] !== baseline.fixture[key])
      throw new Error(`Cannot compare different fixture ${key}`);
  }
  for (const key of ["node", "platform", "arch", "cpu", "cpuCount"] as const) {
    if (current.environment[key] !== baseline.environment[key])
      throw new Error(`Cannot compare different environment ${key}`);
  }
  if (
    current.sampling.iterations !== baseline.sampling.iterations ||
    current.sampling.warmup !== baseline.sampling.warmup
  )
    throw new Error("Cannot compare different iteration or warm-up counts");
}

export function comparisonLines(
  current: HistoryReport,
  baseline: HistoryReport,
): string[] {
  assertComparable(current, baseline);
  return Object.entries(current.measurements).map(([name, measurement]) => {
    const previous = baseline.measurements[name];
    if (!previous) return `${name}: new measurement`;
    const before = summarize(previous.samplesMs).p95Ms;
    const after = summarize(measurement.samplesMs).p95Ms;
    const change =
      before === 0
        ? "n/a (zero baseline)"
        : `${((after / before - 1) * 100).toFixed(1)}%`;
    return `${name}: P95 ${before.toFixed(2)} -> ${after.toFixed(2)} ms (${change})`;
  });
}
