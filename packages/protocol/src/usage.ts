import { z } from "zod";

export const USAGE_SNAPSHOTS_CAPABILITY = "usage-snapshots-v1";
const identity = z.string().min(1).max(500);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Cumulative consumption, never current context occupancy. Missing metrics remain unknown. */
export const SessionAccountingSchema = z.object({
  nativeSessionId: identity,
  counterId: identity,
  source: z.string().min(1).max(80),
  observedAt: z.string().datetime(),
  /** Known creation time of a new native counter scope; absent on attachment. */
  startedAt: z.string().datetime().optional(),
  baseline: z.boolean().optional(),
  aiCredits: z
    .number()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1e9)
    .optional(),
  totalTokens: tokenCount.optional(),
  inputTokens: tokenCount.optional(),
  outputTokens: tokenCount.optional(),
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
});
export type SessionAccounting = z.infer<typeof SessionAccountingSchema>;
export const usageAmountKeys = [
  "aiCredits",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
export type UsageAmountKey = (typeof usageAmountKeys)[number];
export type UsageAmounts = Record<UsageAmountKey, number | null>;
export const UsageSnapshotSchema = z.object({
  id: identity,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionId: identity,
  accounting: SessionAccountingSchema,
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export const UsageSnapshotBatchSchema = z.array(UsageSnapshotSchema).min(1).max(100);
export const UsageReportQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    timeZone: z
      .string()
      .max(100)
      .default("UTC")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid reporting timezone"),
    groupBy: z.enum(["day", "machine", "task", "session"]).default("day"),
    nodeId: identity.optional(),
    taskId: identity.optional(),
    backend: z.enum(["copilot", "hermes"]).optional(),
    role: z.enum(["lead", "worker", "reviewer", "standalone"]).optional(),
  })
  .refine(
    (query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to),
    "Start must be before end",
  );
export type UsageReportQuery = z.infer<typeof UsageReportQuerySchema>;
export type UsageReportRow = UsageAmounts & {
  key: string;
  label: string;
  sessions: number;
  backend?: "copilot" | "hermes";
  role?: string;
};
export type UsageReport = {
  totals: UsageAmounts;
  rows: UsageReportRow[];
  coverage: {
    sessions: number;
    creditSessions: number;
    tokenSessions: number;
    openingAiCredits: number;
    openingTokens: number;
    unallocatedAiCredits: number;
    unallocatedTokens: number;
    regressions: number;
    lastReportedAt: string | null;
  };
  machines: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; name: string }>;
  generatedAt: string;
};
/** Portable metadata-only history; session rows may already have expired. */
export const UsageStreamMetadataSchema = z.object({
  nodeId: identity,
  nodeName: z.string().max(500),
  sessionId: identity,
  sessionName: z.string().max(500),
  backend: z.enum(["copilot", "hermes"]),
  role: z.enum(["lead", "worker", "reviewer", "standalone"]),
  taskId: z.string().max(500),
  taskName: z.string().max(500),
});
export type UsageStreamMetadata = z.infer<typeof UsageStreamMetadataSchema>;
export const UsageBackupSchema = z.object({
  streams: z.array(UsageStreamMetadataSchema),
  snapshots: z.array(z.object({ nodeId: identity, snapshot: UsageSnapshotSchema })),
});
export type UsageBackup = z.infer<typeof UsageBackupSchema>;
