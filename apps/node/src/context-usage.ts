import { ContextUsageSchema, type ContextUsage } from "@fleet/protocol";

const quantity = String.raw`(\d+(?:,\d{3})*(?:\.\d+)?)([kKmM]?)`;
const header = new RegExp(
  String.raw`(?:^|\n)[^\n]*?(\S+)\s+[·•]\s+${quantity}\s*/\s*${quantity}\s+tokens\s+\((\d+(?:\.\d+)?)%\)`,
);

function tokens(value: string, suffix: string): number {
  const scale =
    suffix.toLowerCase() === "m" ? 1_000_000 : suffix.toLowerCase() === "k" ? 1_000 : 1;
  return Number(value.replaceAll(",", "")) * scale;
}

/** Keep the CLI's rounded percentage rather than deriving false precision from 1.1M. */
export function parseContextUsage(
  report: string,
  updatedAt = new Date().toISOString(),
): ContextUsage | null {
  if (report.trim().startsWith("Context information is not yet available.")) return null;
  if (!report.trim().startsWith("Context Usage")) {
    throw new Error("Copilot returned an unrecognized /context report");
  }
  const match = report.match(header);
  if (!match) throw new Error("Copilot's /context report has no readable usage header");
  const [, model, used, usedSuffix, limit, limitSuffix, percent] = match;
  return ContextUsageSchema.parse({
    model,
    usedTokens: tokens(used!, usedSuffix!),
    tokenLimit: tokens(limit!, limitSuffix!),
    percentage: Number(percent),
    updatedAt,
    estimated: Boolean(usedSuffix || limitSuffix),
  });
}
