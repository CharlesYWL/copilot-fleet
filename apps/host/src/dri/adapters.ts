import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import {
  DriProviderDefinitionSchema,
  type DriLimits,
  type DriQuery,
} from "@fleet/protocol";
import { analyzeHar } from "./har.js";
import type { InvestigationProfile } from "./profiles.js";
import {
  ProviderPageSchema,
  READ_ONLY_TOOLS,
  telemetryPlan,
  type DiscoveredMcpClient,
  type DiscoveredReadTool,
  type InvestigationProvider,
  type ProviderContext,
  type ProviderPage,
} from "./providers.js";
import { contentHash, DriError } from "./safety.js";

/** Reuses Fleet's MCP SDK; connection and credentials remain with the authorized transport owner. */
export class SdkMcpReadClient implements DiscoveredMcpClient {
  constructor(private readonly client: Pick<Client, "listTools" | "callTool">) {}
  async discover(signal: AbortSignal): Promise<DiscoveredReadTool[]> {
    const result: DiscoveredReadTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 15_000,
      });
      for (const tool of response.tools.slice(0, 200)) {
        if (Object.values(READ_ONLY_TOOLS).some((names) => names.includes(tool.name))) {
          result.push({
            name: tool.name,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        }
      }
      if (!response.nextCursor) return result;
      if (cursors.has(response.nextCursor))
        throw new DriError("MCP discovery pagination repeated", 422);
      cursor = response.nextCursor;
      cursors.add(cursor);
    }
    throw new DriError("MCP discovery page budget exceeded", 422);
  }
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!Object.values(READ_ONLY_TOOLS).some((names) => names.includes(name)))
      throw new DriError("MCP operation is not read-only allowlisted", 403);
    return this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 15_000,
    });
  }
}

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const TelemetryMappingSchema = z
  .object({
    table: identifier,
    timestamp: identifier,
    environment: identifier,
    correlation: identifier,
    outcome: identifier,
    operation: identifier,
    duration: identifier,
    signature: identifier,
  })
  .strict();
export type TelemetryMapping = z.infer<typeof TelemetryMappingSchema>;
export function compileTelemetryReadPlan(
  profile: InvestigationProfile,
  query: DriQuery,
  mapping: TelemetryMapping,
): {
  text: string;
  parameterNames: string[];
  maxBytes: number;
  timeoutMs: number;
} {
  const fields = TelemetryMappingSchema.parse(mapping);
  const plan = telemetryPlan(profile, query);
  // No parameter values or management commands can be interpolated. Schema names
  // come only from trusted installation mapping, never from an incident or prompt.
  const text = [
    "declare query_parameters(_environment:string, _start:datetime, _end:datetime, _correlation:string);",
    fields.table,
    `| where ${fields.environment} == _environment`,
    `| where ${fields.timestamp} between (_start .. _end)`,
    `| extend Cohort = iff(${fields.correlation} == _correlation, 'affected', 'unaffected')`,
    `| project Timestamp=${fields.timestamp}, Operation=${fields.operation}, Outcome=${fields.outcome}, DurationMs=${fields.duration}, ErrorSignature=${fields.signature}, Cohort`,
    `| take ${plan.maxRows}`,
  ].join("\n");
  return {
    text,
    parameterNames: ["_environment", "_start", "_end", "_correlation"],
    maxBytes: query.bounds.maxBytes,
    timeoutMs: query.bounds.timeoutMs,
  };
}

export type ArtifactManifestEntry = {
  relativePath: string;
  mediaType: "application/json" | "application/har+json";
  expiresAt: string;
};
export class LocalArtifactReader {
  constructor(
    private readonly root: string,
    private readonly manifest: ReadonlyMap<string, ArtifactManifestEntry>,
  ) {}
  async read(
    reference: string,
    limits: DriLimits,
    signal: AbortSignal,
  ): Promise<{ raw: string; size: number; hash: string; mediaType: string }> {
    const entry = this.manifest.get(reference);
    if (!entry || Date.parse(entry.expiresAt) <= Date.now())
      throw new DriError("Artifact missing or expired", 404);
    if (
      isAbsolute(entry.relativePath) ||
      entry.relativePath.includes("\0") ||
      !Number.isFinite(Date.parse(entry.expiresAt))
    )
      throw new DriError("Artifact is quarantined", 403);
    const root = await realpath(this.root);
    const file = resolve(root, entry.relativePath);
    const relativePath = relative(root, file);
    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === ".." ||
      isAbsolute(relativePath)
    )
      throw new DriError("Artifact is outside approved storage", 403);
    // Check every component, not just the leaf: a directory junction must not
    // turn an approved relative reference into a read elsewhere on the Host.
    let part = root;
    for (const component of relativePath.split(sep)) {
      part = resolve(part, component);
      if ((await lstat(part)).isSymbolicLink())
        throw new DriError("Linked artifacts are quarantined", 403);
    }
    const canonical = await realpath(file);
    if (canonical !== file) throw new DriError("Artifact path changed", 403);
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.maxBytes || signal.aborted)
        throw new DriError("Artifact unavailable or over budget", 422);
      const buffer = Buffer.alloc(Math.min(limits.maxBytes + 1, stat.size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size || bytesRead > limits.maxBytes || signal.aborted)
        throw new DriError("Artifact changed during bounded read", 422);
      const raw = buffer.subarray(0, bytesRead).toString("utf8");
      return { raw, size: bytesRead, hash: contentHash(raw), mediaType: entry.mediaType };
    } finally {
      await handle.close();
    }
  }
}

export class LocalHarProvider implements InvestigationProvider {
  readonly definition = DriProviderDefinitionSchema.parse({
    id: "local.har",
    version: "1.0.0",
    readOnly: true,
    capabilities: ["har.analyze", "artifact.read"],
    tools: ["har_analyze_local", "artifact_bounded_read"],
    readiness: "ready",
  });
  constructor(private readonly artifacts: LocalArtifactReader) {}
  async read(context: ProviderContext): Promise<ProviderPage> {
    const reference = context.investigation.artifactRef;
    if (!reference)
      return ProviderPageSchema.parse({
        state: "unavailable",
        summary: "No approved local artifact reference",
      });
    const artifact = await this.artifacts.read(
      reference,
      context.query.bounds,
      context.signal,
    );
    if (context.query.capability === "artifact.read")
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary: "Approved artifact metadata; raw contents not exposed",
        artifacts: [
          {
            reference,
            size: artifact.size,
            hash: artifact.hash,
            mediaType: artifact.mediaType,
            availability: "available",
          },
        ],
      });
    const analysis = analyzeHar(artifact.raw, context.query.bounds);
    return ProviderPageSchema.parse({
      state: analysis.truncated ? "truncated" : "succeeded",
      summary: `Bounded HAR analysis; first meaningful failure ${analysis.firstFailure ?? "none"}. Credential values removed.`,
      evidence: analysis.requests.map((request) => ({
        type: "har",
        observedAt: request.at,
        finding: `Request ${request.order}: HTTP ${request.status}, ${request.outcome}, ${request.durationMs}ms; retry of ${request.retryOf ?? "none"}; redirect parent ${request.parentOrder ?? "none"}; wait=${request.phases.wait}ms.`,
        signals: request.signals,
        identifiers: request.correlationIds.map((value) => ({
          kind: "correlation",
          value,
          hashed: true,
        })),
      })),
      artifacts: [
        {
          reference,
          size: artifact.size,
          hash: analysis.hash,
          mediaType: artifact.mediaType,
          availability: "available",
        },
      ],
      timeline: analysis.requests.map((request) => ({
        at: request.at,
        category: "client",
        summary: `Request ${request.order}: ${request.outcome}`,
      })),
    });
  }
}
