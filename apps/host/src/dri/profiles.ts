import { z } from "zod";
import {
  DriCapabilitySchema,
  DriKey,
  type DriIncident,
  type DriEvidence,
  type DriProfileDecision,
} from "@fleet/protocol";
import { stableId } from "./safety.js";

const ProvenanceSchema = z.object({
  source: z.enum(["fleet", "drifus", "LimnMCP"]),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  reviewedAt: z.string().datetime(),
  freshness: z.enum(["verified_semantics", "requires_live_verification"]),
  applicability: z.string().max(500),
  sensitivity: z.literal("non_sensitive"),
});
export const InvestigationProfileSchema = z.object({
  id: DriKey,
  version: DriKey,
  label: z.string().max(80),
  owningServices: z.array(z.string().max(80)).max(10),
  components: z.array(z.string().max(80)).max(10),
  terminology: z.array(z.string().max(80)).max(20),
  identifierRelationships: z.array(z.string().max(160)).max(20),
  signatures: z
    .array(
      z.object({
        signal: DriKey,
        meaning: z.string().max(240),
        provenance: ProvenanceSchema,
      }),
    )
    .max(20),
  causalRules: z
    .array(
      z.object({
        id: DriKey,
        required: z
          .array(
            z.object({
              type: z.enum(["incident", "har", "telemetry", "change"]),
              signals: z.array(DriKey).min(1).max(10),
            }),
          )
          .min(2)
          .max(4),
        contradictorySignals: z.array(DriKey).max(10),
        hypothesis: z.string().max(500),
        firstIncorrectBehavior: z.string().max(500),
        immediateFailure: z.string().max(500),
        missingEvidence: z.array(z.string().max(240)).max(10),
        falsifyingEvidence: z.array(z.string().max(240)).max(10),
        provenance: ProvenanceSchema,
      }),
    )
    .max(10),
  queryTemplates: z
    .array(
      z.object({
        id: DriKey,
        purpose: z.string().max(240),
        pivots: z.array(DriKey).max(10),
        selectedColumns: z.array(DriKey).max(15),
        comparisons: z.array(z.enum(["failed_success", "affected_unaffected"])).max(2),
        filterOrder: z.tuple([
          z.literal("environment"),
          z.literal("utc_time"),
          z.literal("correlation"),
        ]),
        provenance: ProvenanceSchema,
      }),
    )
    .max(10),
  providerMappings: z.object({
    repository: DriKey,
    pipeline: DriKey,
    deployment: DriKey,
  }),
  window: z.object({
    beforeMinutes: z.number().max(60),
    afterMinutes: z.number().max(60),
  }),
  requirements: z.array(DriCapabilitySchema).max(6),
  reportTerminology: z.array(z.string().max(80)).max(10),
  provenance: ProvenanceSchema,
});
export type InvestigationProfile = z.infer<typeof InvestigationProfileSchema>;

const provenance = {
  source: "drifus" as const,
  commit: "60db3bc63fc230f1940e3b48ae8d8720108191a8",
  reviewedAt: "2026-09-09T00:00:00.000Z",
  freshness: "verified_semantics" as const,
  applicability:
    "Terminology and evidence gates only. Incident evidence overrides heuristics; live selectors and deployment mappings require provider validation.",
  sensitivity: "non_sensitive" as const,
};
export const genericProfile = InvestigationProfileSchema.parse({
  id: "generic",
  version: "1.0.0",
  label: "Generic investigation",
  owningServices: [],
  components: [],
  terminology: ["Incident", "Service", "Component"],
  identifierRelationships: ["Client request -> correlation -> service operation"],
  signatures: [],
  causalRules: [
    {
      id: "dependency-availability",
      required: [
        { type: "har", signals: ["upstream_unavailable"] },
        { type: "telemetry", signals: ["upstream_unavailable", "dependency_refused"] },
      ],
      contradictorySignals: ["affected_dependency_healthy"],
      hypothesis:
        "A dependency availability failure propagated into failed operations; initiating root cause unverified.",
      firstIncorrectBehavior:
        "Dependency refused operations before client retries failed.",
      immediateFailure: "Service unavailability propagated to failed client operations.",
      missingEvidence: ["Verified initiating causal mechanism", "Recovery validation"],
      falsifyingEvidence: [
        "Affected operations succeeded through the allegedly failing dependency during the same window",
      ],
      provenance: {
        ...provenance,
        source: "fleet",
        commit: "03435b71ccf7426a793c0fad5aadfc7c416b7683",
      },
    },
  ],
  queryTemplates: [],
  providerMappings: {
    repository: "repository.read",
    pipeline: "pipeline.read",
    deployment: "deployment.read",
  },
  window: { beforeMinutes: 15, afterMinutes: 30 },
  requirements: ["incident.read"],
  reportTerminology: [
    "Immediate failure",
    "Underlying root cause",
    "Evidence limitation",
  ],
  provenance: {
    ...provenance,
    source: "fleet",
    commit: "03435b71ccf7426a793c0fad5aadfc7c416b7683",
  },
});
export const dmsProfile = InvestigationProfileSchema.parse({
  ...genericProfile,
  id: "dms",
  version: "1.0.0",
  label: "DMS / Fabric Warehouse",
  owningServices: ["Data Movement Service", "DMS"],
  components: ["DMS", "Fabric Warehouse", "Warehouse data movement"],
  terminology: [
    "DMS",
    "Fabric Warehouse",
    "Data movement",
    "Control plane",
    "Data plane",
  ],
  identifierRelationships: [
    "Client request -> activity -> service correlation",
    "Service correlation -> operation -> environment",
  ],
  signatures: [
    {
      signal: "upstream_unavailable",
      meaning: "Unavailable dependency: compare first failure and retry outcome",
      provenance,
    },
    {
      signal: "retry_exhausted",
      meaning: "Retries exhausted: not an independent root cause",
      provenance,
    },
    {
      signal: "auth_failure",
      meaning:
        "Authentication failure: verify redirect and token boundary without persisting secrets",
      provenance,
    },
  ],
  queryTemplates: [
    {
      id: "dms.operation-cohorts.v1",
      purpose: "Compare correlated failures with successful and unaffected operations",
      pivots: ["environment", "correlation", "operation"],
      selectedColumns: [
        "Timestamp",
        "Operation",
        "Outcome",
        "DurationMs",
        "ErrorSignature",
        "Cohort",
      ],
      comparisons: ["failed_success", "affected_unaffected"],
      filterOrder: ["environment", "utc_time", "correlation"],
      provenance: { ...provenance, freshness: "requires_live_verification" },
    },
  ],
  providerMappings: {
    repository: "dms.source.read",
    pipeline: "dms.pipeline.read",
    deployment: "dms.deployment.read",
  },
  requirements: ["incident.read", "telemetry.query"],
  reportTerminology: [
    "DMS operation",
    "Warehouse impact",
    "First incorrect behavior",
    "Evidence gate",
  ],
  provenance,
});

export function assessProfileRule(
  profile: InvestigationProfile,
  evidence: DriEvidence[],
) {
  const assessed = profile.causalRules.map((rule) => {
    const supporting = rule.required.map((requirement) =>
      evidence.filter(
        (item) =>
          item.type === requirement.type &&
          item.completeness === "complete" &&
          requirement.signals.every((signal) => item.signals.includes(signal)),
      ),
    );
    const contradicting = evidence.filter((item) =>
      item.signals.some((signal) => rule.contradictorySignals.includes(signal)),
    );
    return {
      rule,
      supporting: [...new Map(supporting.flat().map((item) => [item.id, item])).values()],
      contradicting,
      corroborated:
        supporting.every((group) => group.length > 0) && contradicting.length === 0,
    };
  });
  return assessed.find((assessment) => assessment.corroborated) ?? assessed[0];
}

export class ProfileRegistry {
  private readonly profiles = new Map<string, InvestigationProfile>();
  constructor(profiles: InvestigationProfile[] = [genericProfile, dmsProfile]) {
    for (const profile of profiles) this.register(profile);
  }
  register(profile: InvestigationProfile): void {
    const parsed = InvestigationProfileSchema.parse(profile);
    if (this.profiles.has(parsed.id)) throw new Error("Duplicate DRI profile");
    this.profiles.set(parsed.id, parsed);
  }
  get(id: string): InvestigationProfile | undefined {
    return this.profiles.get(id);
  }
  list(): InvestigationProfile[] {
    return [...this.profiles.values()];
  }

  resolve(
    requested: string,
    incident: DriIncident | undefined,
    evidenceIds: string[],
    revision = 0,
    correction = false,
  ): DriProfileDecision {
    let selected = requested === "auto" ? this.get("generic") : this.get(requested);
    let method: DriProfileDecision["method"] = correction ? "correction" : "explicit";
    let confidence = selected ? 1 : 0;
    let explanation =
      "Explicit operator selection; current incident evidence takes precedence.";
    if (requested === "auto") {
      const matches = this.list().filter(
        (profile) =>
          incident?.ownershipVerified &&
          profile.owningServices.some(
            (service) => service.toLowerCase() === incident.owningService.toLowerCase(),
          ) &&
          profile.components.some(
            (component) => component.toLowerCase() === incident.component.toLowerCase(),
          ),
      );
      selected = matches.length === 1 ? matches[0] : this.get("generic");
      method = "auto";
      confidence = matches.length === 1 ? 0.98 : 0;
      explanation =
        matches.length === 1
          ? "Verified ICM owning service and component match exactly; title wording was not used."
          : "Reliable owning-service/component evidence unavailable or ambiguous; using generic.";
    }
    if (!selected) {
      method = "unavailable";
      explanation = "Requested profile is not installed; investigation is paused.";
    }
    return {
      id: stableId("profile", [requested, selected?.id, revision, evidenceIds]),
      profileId: selected?.id ?? requested,
      profileVersion: selected?.version ?? "unavailable",
      method,
      confidence,
      evidenceIds,
      explanation,
      revision,
      decidedAt: new Date().toISOString(),
    };
  }
}
