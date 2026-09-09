import { z } from "zod";
import type { DriLimits } from "@fleet/protocol";
import { contentHash, fingerprint } from "./safety.js";

const header = z.object({ name: z.string().max(100), value: z.string().max(16_000) });
const entry = z.object({
  startedDateTime: z.string().datetime({ offset: true }),
  time: z.number().min(0).max(3_600_000),
  request: z.object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
    url: z.string().url().max(16_000),
    headers: z.array(header).max(100).default([]),
    cookies: z.array(z.unknown()).max(100).default([]),
  }),
  response: z.object({
    status: z.number().int().min(0).max(599),
    headers: z.array(header).max(100).default([]),
    cookies: z.array(z.unknown()).max(100).default([]),
    redirectURL: z.string().max(16_000).default(""),
    content: z
      .object({
        mimeType: z.string().max(100).optional(),
        text: z.string().max(524_288).optional(),
      })
      .optional(),
  }),
  timings: z
    .object({
      blocked: z.number().min(-1).default(-1),
      dns: z.number().min(-1).default(-1),
      connect: z.number().min(-1).default(-1),
      ssl: z.number().min(-1).default(-1),
      send: z.number().min(-1).default(-1),
      wait: z.number().min(-1).default(-1),
      receive: z.number().min(-1).default(-1),
    })
    .default(() => ({
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: -1,
      wait: -1,
      receive: -1,
    })),
  _error: z.string().max(2_000).optional(),
});
export type HarRequest = {
  order: number;
  at: string;
  endpoint: string;
  method: string;
  status: number;
  durationMs: number;
  parentOrder: number | null;
  retryOf: number | null;
  outcome: "success" | "http_error" | "app_error" | "cancelled" | "stall";
  signals: string[];
  correlationIds: string[];
  phases: z.infer<typeof entry>["timings"];
};
export type HarAnalysis = {
  requests: HarRequest[];
  firstFailure: number | null;
  hash: string;
  credentialHeadersRemoved: number;
  truncated: boolean;
};

/** Parses in memory. No URLs, bodies, cookie values or credential headers are returned. */
export function analyzeHar(raw: string, limits: DriLimits): HarAnalysis {
  if (Buffer.byteLength(raw) > limits.maxBytes)
    throw new Error("HAR byte budget exceeded");
  const parsed = z
    .object({ log: z.object({ entries: z.array(entry).max(10_000) }) })
    .parse(JSON.parse(raw));
  const sorted = parsed.log.entries
    .map((request, index) => ({ request, index }))
    .sort(
      (a, b) =>
        Date.parse(a.request.startedDateTime) - Date.parse(b.request.startedDateTime) ||
        a.index - b.index,
    );
  let removed = 0;
  const requests: HarRequest[] = [];
  const destinations = new Map<string, number>();
  for (const { request: row } of sorted.slice(0, limits.maxRows)) {
    const endpointUrl = new URL(row.request.url);
    if (!["https:", "http:"].includes(endpointUrl.protocol))
      throw new Error("Unsupported HAR URL");
    const endpoint = fingerprint(`${endpointUrl.origin}${endpointUrl.pathname}`);
    const previous = [...requests]
      .reverse()
      .find(
        (request) =>
          request.endpoint === endpoint && request.method === row.request.method,
      );
    const headers = [...row.request.headers, ...row.response.headers];
    removed += headers.filter((h) =>
      /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(h.name),
    ).length;
    const correlationIds = headers
      .filter((h) =>
        /^(x-ms-(request|correlation|activity)-id|request-id|traceparent)$/i.test(h.name),
      )
      .map((h) => fingerprint(h.value))
      .slice(0, 10);
    const cancelled = /cancel|abort/i.test(row._error ?? "");
    const appError = /"(?:error|errorCode)"\s*:\s*(?!"(?:0|none|)"|null|false)/i.test(
      row.response.content?.text ?? "",
    );
    const outcome = cancelled
      ? "cancelled"
      : row.response.status === 0
        ? "stall"
        : row.response.status >= 400
          ? "http_error"
          : appError
            ? "app_error"
            : "success";
    const signals: string[] = [];
    if (row.response.status === 503) signals.push("upstream_unavailable");
    if ([401, 403].includes(row.response.status)) signals.push("auth_failure");
    if (row.response.status >= 300 && row.response.status < 400) signals.push("redirect");
    if (row.time >= 5_000) signals.push("slow");
    if (row.timings.blocked >= 1_000 || row.timings.wait >= 5_000)
      signals.push("stalled_phase");
    if (headers.some((h) => /^access-control-/i.test(h.name)))
      signals.push("cors_headers_present");
    if (/cors/i.test(row._error ?? "")) signals.push("cors_failure");
    if (row.request.cookies.length || row.response.cookies.length)
      signals.push("cookies_present_values_removed");
    if (previous && previous.outcome !== "success") signals.push("retry");
    const order = requests.length + 1;
    requests.push({
      order,
      at: new Date(row.startedDateTime).toISOString(),
      endpoint,
      method: row.request.method,
      status: row.response.status,
      durationMs: row.time,
      parentOrder: destinations.get(endpoint) ?? null,
      retryOf: previous && previous.outcome !== "success" ? previous.order : null,
      outcome,
      signals,
      correlationIds,
      phases: row.timings,
    });
    if (row.response.redirectURL) {
      try {
        const target = new URL(row.response.redirectURL, row.request.url);
        destinations.set(fingerprint(`${target.origin}${target.pathname}`), order);
      } catch {
        /* An invalid redirect is evidence, not a URL to fetch. */
      }
    }
  }
  return {
    requests,
    firstFailure:
      requests.find(
        (request) => request.outcome !== "success" && request.outcome !== "cancelled",
      )?.order ?? null,
    hash: contentHash(requests),
    credentialHeadersRemoved: removed,
    truncated: sorted.length > requests.length,
  };
}
