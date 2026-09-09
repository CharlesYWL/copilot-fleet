import { createHash } from "node:crypto";
import {
  DRI_REDACTION_VERSION,
  parseIcmReference,
  type DriRecord,
} from "@fleet/protocol";

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
export const contentHash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${contentHash(value).slice(0, 32)}`;
export const fingerprint = (value: string): string =>
  `hash:${contentHash(value).slice(0, 24)}`;

export function redactText(input: string, limit = 2_000): string {
  return input
    .slice(0, 16_000)
    .replace(
      /(?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=][^\r\n]*/gi,
      "[credential removed]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential removed]")
    .replace(
      /\b(?:password|passwd|pwd|token|secret|api[-_]?key|sig|code|credential)\s*[:=]\s*["']?[^&\s"',;]+/gi,
      "[secret removed]",
    )
    .replace(
      /\b(?:customer|tenant|subscription|user|account|email|person)(?:id|name)?\s*[:=]\s*[^,;\r\n]+/gi,
      "[identity removed]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[personal data removed]")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, (id) => fingerprint(id))
    .replace(/https?:\/\/[^\s<>"]+/gi, "[external link removed]")
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[opaque payload removed]")
    .replace(/[<>]/g, "")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32 || "\n\r\t".includes(character))
    .join("")
    .slice(0, limit);
}

export function safeReference(value: string): string {
  if (
    /^(?:fixture|hash|evidence|artifact|repository|pipeline|deployment):[a-z0-9:._-]{1,140}$/i.test(
      value,
    )
  ) {
    return value;
  }
  try {
    return parseIcmReference(value).url;
  } catch {
    return fingerprint(value);
  }
}

const freeTextKeys = new Set([
  "summary",
  "symptom",
  "impact",
  "scope",
  "finding",
  "limitation",
  "statement",
  "priorCause",
  "priorMitigation",
  "applicability",
  "explanation",
  "reason",
  "purpose",
  "owningService",
  "component",
  "source",
  "sourceVersion",
  "mediaType",
]);
const textArrayKeys = new Set([
  "details",
  "signals",
  "technicalSignals",
  "mismatches",
  "missingEvidence",
  "falsifyingEvidence",
]);

/** Only normalized fields cross this boundary; payloads, headers and query bindings do not. */
export function redactRecord<T extends DriRecord>(record: T): T {
  const walk = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (freeTextKeys.has(key) || textArrayKeys.has(key)) return redactText(value);
      if (key === "reference") return safeReference(value);
      return value;
    }
    if (Array.isArray(value)) {
      if (key === "identifiers")
        return value.map((entry: { kind: string; value: string; hashed: boolean }) => ({
          kind: entry.kind,
          value:
            entry.hashed && /^hash:[a-f0-9]{24,64}$/.test(entry.value)
              ? entry.value
              : fingerprint(entry.value),
          hashed: true,
        }));
      return value.map((entry) => walk(entry, key));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, walk(entry, name)]),
      );
    }
    return value;
  };
  const safe = walk(record) as T;
  if ("redactionVersion" in safe) safe.redactionVersion = DRI_REDACTION_VERSION;
  return safe;
}

export class DriError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
