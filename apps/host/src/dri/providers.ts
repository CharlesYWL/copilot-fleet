import { z } from "zod";
import {
  DriCapabilitySchema,
  DriIncidentSchema,
  DriPivotSchema,
  DriProviderDefinitionSchema,
  type DriCapability,
  type DriInvestigation,
  type DriProviderDefinition,
  type DriQuery,
} from "@fleet/protocol";
import type { InvestigationProfile } from "./profiles.js";
import { DriError, redactText } from "./safety.js";

const bounded = z.string().max(2_000);
const signal = z
  .string()
  .max(120)
  .regex(/^[a-z0-9_.:-]+$/);
export const ProviderEvidenceSchema = z.object({
  type: z.enum(["incident", "har", "telemetry", "similar", "change", "limitation"]),
  finding: bounded,
  signals: z.array(signal).max(30).default([]),
  identifiers: z.array(DriPivotSchema).max(40).default([]),
  observedAt: z.string().datetime(),
  confidence: z.number().min(0).max(1).default(0.8),
  completeness: z
    .enum(["complete", "partial", "negative", "unavailable"])
    .default("complete"),
  limitation: z.string().max(240).default(""),
});
export type ProviderEvidence = z.infer<typeof ProviderEvidenceSchema>;
const IncidentDataSchema = DriIncidentSchema.omit({
  id: true,
  investigationId: true,
  profileId: true,
  generation: true,
  attempt: true,
  invocationId: true,
  createdAt: true,
  kind: true,
});
export const ProviderPageSchema = z
  .object({
    state: z.enum([
      "succeeded",
      "no_results",
      "access_denied",
      "unavailable",
      "failed",
      "truncated",
    ]),
    evidence: z.array(ProviderEvidenceSchema).max(200).default([]),
    incident: IncidentDataSchema.optional(),
    timeline: z
      .array(
        z.object({
          at: z.string().datetime(),
          category: z.enum([
            "incident",
            "handoff",
            "client",
            "telemetry",
            "change",
            "recovery",
          ]),
          summary: bounded,
        }),
      )
      .max(200)
      .default([]),
    similar: z
      .array(
        z.object({
          reference: z.string().max(240),
          technicalSignals: z.array(signal).max(20),
          mismatches: z.array(signal).max(20),
          priorCause: bounded,
          priorMitigation: bounded,
        }),
      )
      .max(50)
      .default([]),
    changes: z
      .array(
        z.object({
          reference: z.string().max(240),
          category: z.enum(["code", "config", "pipeline", "deployment"]),
          at: z.string().datetime(),
          summary: bounded,
          technicalSignals: z.array(signal).max(20),
          causalEvidence: z.boolean().default(false),
        }),
      )
      .max(50)
      .default([]),
    artifacts: z
      .array(
        z.object({
          reference: z.string().max(160),
          mediaType: z.string().max(100),
          size: z.number().int().min(0).max(4_194_304),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          availability: z.enum(["available", "missing", "access_denied", "quarantined"]),
        }),
      )
      .max(40)
      .default([]),
    nextCursor: z.string().max(240).optional(),
    summary: bounded,
  })
  .strict();
export type ProviderPage = z.infer<typeof ProviderPageSchema>;
export type ProviderContext = {
  investigation: DriInvestigation;
  profile: InvestigationProfile;
  query: DriQuery;
  cursor: string | undefined;
  signal: AbortSignal;
  /** Ephemeral capability-scoped bindings, never persisted or included in public plans. */
  privateBindings: Readonly<Record<string, string>>;
  recordPrivateBindings?: (bindings: Readonly<Record<string, string>>) => void;
};
export interface InvestigationProvider {
  readonly definition: DriProviderDefinition;
  read(context: ProviderContext): Promise<ProviderPage>;
}
export type IncidentProvider = InvestigationProvider;
export type HarProvider = InvestigationProvider;
export type TelemetryProvider = InvestigationProvider;
export type SimilarIncidentProvider = InvestigationProvider;
export type ChangeProvider = InvestigationProvider;
export type ArtifactProvider = InvestigationProvider;

export const READ_ONLY_TOOLS: Readonly<Record<DriCapability, readonly string[]>> = {
  "incident.read": [
    "get_incident_details_by_id",
    "get_incident_discussion_entries_and_insights",
    "get_incident_context",
  ],
  "artifact.read": ["artifact_metadata_read", "artifact_bounded_read"],
  "har.analyze": ["har_analyze_local"],
  "telemetry.query": ["telemetry_query_readonly"],
  "similar.search": ["get_similar_incidents", "search_incidents"],
  "change.read": ["get_commit", "get_file_contents", "actions_get", "actions_list"],
};
export function assertReadOnlyTool(capability: DriCapability, name: string): void {
  DriCapabilitySchema.parse(capability);
  if (!READ_ONLY_TOOLS[capability].includes(name)) {
    throw new DriError("Tool is not in the declared read-only capability allowlist", 403);
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, InvestigationProvider>();
  constructor(providers: InvestigationProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }
  register(provider: InvestigationProvider): void {
    const definition = DriProviderDefinitionSchema.parse(provider.definition);
    if (this.providers.has(definition.id)) throw new DriError("Duplicate provider");
    for (const tool of definition.tools) {
      if (
        !definition.capabilities.some((capability) =>
          READ_ONLY_TOOLS[capability].includes(tool),
        )
      ) {
        throw new DriError("Provider declares a write or unknown tool", 403);
      }
    }
    this.providers.set(definition.id, provider);
  }
  replace(providers: InvestigationProvider[]): void {
    const checked = new ProviderRegistry(providers);
    this.providers.clear();
    for (const [id, provider] of checked.providers) this.providers.set(id, provider);
  }
  get(id: string): InvestigationProvider | undefined {
    return this.providers.get(id);
  }
  forCapability(capability: DriCapability): InvestigationProvider | undefined {
    return [...this.providers.values()].find(
      (provider) =>
        provider.definition.readiness === "ready" &&
        provider.definition.capabilities.includes(capability),
    );
  }
  list(): DriProviderDefinition[] {
    return [...this.providers.values()].map((provider) => provider.definition);
  }
}

export type DiscoveredReadTool = {
  name: string;
  readOnly: boolean;
  inputSchema?: Record<string, unknown>;
};
export interface DiscoveredMcpClient {
  discover(signal: AbortSignal): Promise<DiscoveredReadTool[]>;
  call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export type McpReadBinding = {
  tool: string;
  capability: DriCapability;
  /** Trusted adapter, not incident text or a worker-supplied query. */
  arguments: (context: ProviderContext) => Readonly<Record<string, unknown>>;
  normalize: (raw: unknown, context: ProviderContext) => ProviderPage;
};

/** Uses the discovered-tool transport; discovery alone never grants authorization. */
export class DeclaredMcpProvider implements InvestigationProvider {
  readonly definition: DriProviderDefinition;
  constructor(
    id: string,
    private readonly client: DiscoveredMcpClient,
    private readonly binding: McpReadBinding,
    private readonly authorize: (context: ProviderContext) => Promise<boolean>,
  ) {
    assertReadOnlyTool(binding.capability, binding.tool);
    this.definition = DriProviderDefinitionSchema.parse({
      id,
      version: "1.0.0",
      readOnly: true,
      capabilities: [binding.capability],
      tools: [binding.tool],
      readiness: "ready",
    });
  }
  async read(context: ProviderContext): Promise<ProviderPage> {
    if (context.query.capability !== this.binding.capability)
      throw new DriError("Capability scope mismatch", 403);
    if (!(await this.authorize(context))) return unavailablePage("access_denied");
    assertReadOnlyTool(context.query.capability, this.binding.tool);
    const tools = await this.client.discover(context.signal);
    if (!tools.some((tool) => tool.name === this.binding.tool && tool.readOnly === true))
      return unavailablePage("unavailable");
    const raw = await this.client.call(
      this.binding.tool,
      this.binding.arguments(context),
      context.signal,
    );
    if (Buffer.byteLength(JSON.stringify(raw) ?? "") > context.query.bounds.maxBytes) {
      throw new DriError("MCP result exceeded byte budget", 422);
    }
    // A live adapter must project approved technical fields, never free-form customer content.
    return ProviderPageSchema.parse(this.binding.normalize(raw, context));
  }
}

export function unavailablePage(
  state: "unavailable" | "access_denied" | "failed",
): ProviderPage {
  return ProviderPageSchema.parse({
    state,
    summary:
      state === "access_denied"
        ? "Read-only provider access denied"
        : state === "unavailable"
          ? "Read-only provider not configured or unavailable"
          : "Provider query failed",
  });
}

export function assertProviderPageCapability(
  capability: DriCapability,
  page: ProviderPage,
): void {
  const permitted: Record<DriCapability, string[]> = {
    "incident.read": ["incident"],
    "har.analyze": ["har"],
    "telemetry.query": ["telemetry"],
    "similar.search": ["similar"],
    "change.read": ["change"],
    "artifact.read": [],
  };
  if (
    page.evidence.some(
      (evidence) =>
        evidence.type !== "limitation" && !permitted[capability].includes(evidence.type),
    ) ||
    (page.incident && capability !== "incident.read") ||
    (page.similar.length && capability !== "similar.search") ||
    (page.changes.length && capability !== "change.read") ||
    (page.artifacts.length &&
      !["incident.read", "har.analyze", "artifact.read"].includes(capability))
  ) {
    throw new DriError("Provider result exceeds its scoped capability", 403);
  }
  if (
    page.state === "no_results" &&
    (page.evidence.length || page.incident || page.similar.length || page.changes.length)
  )
    throw new DriError("No-results response contains contradictory data", 422);
}

export function telemetryPlan(
  profile: InvestigationProfile,
  query: DriQuery,
): {
  template: string;
  filterOrder: readonly string[];
  selectedColumns: readonly string[];
  comparisons: readonly string[];
  timeRange: DriQuery["timeRange"];
  maxRows: number;
} {
  const template = profile.queryTemplates.find(
    (candidate) => candidate.id === query.template,
  );
  if (!template || query.capability !== "telemetry.query")
    throw new DriError("Unknown query template", 422);
  const duration = Date.parse(query.timeRange.end) - Date.parse(query.timeRange.start);
  if (duration < 0 || duration > 86_400_000 || !query.bounds.maxRows)
    throw new DriError("Unsafe telemetry bounds", 422);
  return {
    template: template.id,
    filterOrder: template.filterOrder,
    selectedColumns: template.selectedColumns,
    comparisons: template.comparisons,
    timeRange: query.timeRange,
    maxRows: query.bounds.maxRows,
  };
}

export function matchSimilar(
  candidate: ProviderPage["similar"][number],
  signals: Set<string>,
) {
  const technicalSignals = candidate.technicalSignals.filter((signal) =>
    signals.has(signal),
  );
  const score = candidate.mismatches.length
    ? 0
    : technicalSignals.length / Math.max(1, candidate.technicalSignals.length);
  const match =
    candidate.mismatches.length || !technicalSignals.length
      ? "ruled_out"
      : technicalSignals.length >= 2 && score >= 0.75
        ? "strong"
        : "partial";
  return {
    match: match as "strong" | "partial" | "ruled_out",
    score,
    technicalSignals,
    mismatches: candidate.mismatches,
    applicability: redactText(
      match === "strong"
        ? "Multiple matching technical signals; prior cause is a hypothesis, not proof for this incident."
        : match === "partial"
          ? "Insufficient technical overlap; further evidence required."
          : "Contradicting or absent technical signals; wording is not evidence.",
    ),
  };
}
