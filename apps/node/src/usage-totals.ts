import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionAccounting } from "@fleet/protocol";

type TokenTotals = Pick<
  SessionAccounting,
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "reasoningTokens"
>;
export const usageObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
/** Native Copilot input includes cache; native output includes reasoning. */
export const accountingTokens = (data: unknown): TokenTotals | undefined => {
  const root = usageObject(data);
  const snapshot = usageObject(root?.accountingSnapshot) ?? root;
  if (!snapshot) return undefined;
  const providers = snapshot.providerModelMetrics;
  const models = usageObject(snapshot.modelMetrics);
  const metrics =
    Array.isArray(providers) && providers.length
      ? providers.map((item) => usageObject(usageObject(item)?.metrics))
      : Object.values(models ?? {}).map(usageObject);
  if (!metrics.length) return undefined;
  const usages = metrics.map((item) => usageObject(item?.usage));
  if (
    usages.some(
      (item) =>
        !item ||
        count(item.inputTokens) === undefined ||
        count(item.outputTokens) === undefined,
    )
  )
    return undefined;
  const totals: TokenTotals = {};
  for (const field of fields) {
    if (usages.every((usage) => count(usage?.[field]) !== undefined)) {
      const value = usages.reduce((sum, usage) => sum + (count(usage?.[field]) ?? 0), 0);
      if (!Number.isSafeInteger(value)) return undefined;
      totals[field] = value;
    }
  }
  const totalTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  return Number.isSafeInteger(totalTokens) ? { ...totals, totalTokens } : undefined;
};

/** Optional read-only aggregate. No per-request records leave the native database. */
export const readNativeTokenTotals = (
  kind: "copilot" | "hermes",
  sessionId: string,
  profile?: string,
): TokenTotals | undefined => {
  const home =
    kind === "copilot"
      ? process.env.COPILOT_HOME || join(homedir(), ".copilot")
      : process.env.HERMES_HOME || join(homedir(), ".hermes");
  const candidates =
    kind === "copilot"
      ? [join(home, "session-store.db")]
      : profile && profile !== "default"
        ? [join(home, "profiles", profile, "state.db")]
        : [join(home, "state.db")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout=100");
      const table = kind === "copilot" ? "assistant_usage_events" : "sessions";
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => String(column.name)),
      );
      if (!columns.has("input_tokens") || !columns.has("output_tokens")) continue;
      const selection = [
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
      ]
        .map((column) =>
          !columns.has(column)
            ? `NULL AS ${column}`
            : kind === "copilot"
              ? `CASE WHEN COUNT(${column})=COUNT(*) THEN SUM(${column}) ELSE NULL END AS ${column}`
              : column,
        )
        .join(",");
      const row =
        kind === "copilot"
          ? db
              .prepare(
                `SELECT COUNT(*) AS records, ${selection} FROM assistant_usage_events WHERE session_id=?`,
              )
              .get(sessionId)
          : db.prepare(`SELECT ${selection} FROM sessions WHERE id=?`).get(sessionId);
      if (!row || (kind === "copilot" && Number(row.records) === 0)) continue;
      const uncachedInput = count(row.input_tokens);
      const output = count(row.output_tokens);
      if (uncachedInput === undefined || output === undefined) continue;
      const cacheRead = count(row.cache_read_tokens);
      const cacheWrite = count(row.cache_write_tokens);
      // Copilot input is inclusive. Hermes stores disjoint canonical buckets;
      // unknown cache values cannot safely be replaced with zero.
      if (kind === "hermes" && (cacheRead === undefined || cacheWrite === undefined))
        continue;
      const input =
        kind === "hermes" ? uncachedInput + cacheRead! + cacheWrite! : uncachedInput;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(input + output)) continue;
      const totals: TokenTotals = {
        totalTokens: input + output,
        inputTokens: input,
        outputTokens: output,
      };
      for (const [field, column] of [
        ["cacheReadTokens", "cache_read_tokens"],
        ["cacheWriteTokens", "cache_write_tokens"],
        ["reasoningTokens", "reasoning_tokens"],
      ] as const) {
        const value = count(row[column]);
        if (value !== undefined) totals[field] = value;
      }
      return totals;
    } catch {
      /* Older or locked native stores leave consumption unknown. */
    } finally {
      db?.close();
    }
  }
  return undefined;
};
