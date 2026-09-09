import { z } from "zod";

export const DRI_VERSION = 1;
export const DRI_REDACTION_VERSION = "dri-redaction-v1";
export const DriKey = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9:._-]+$/);
const short = z.string().max(240);
const text = z.string().max(2_000);
const utc = z.string().datetime();
const revision = z.number().int().nonnegative();
const confidence = z.number().min(0).max(1);
const keys = z.array(DriKey).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export function parseIcmReference(value: string): { id: string; url: string } {
  const input = value.trim();
  let id = input;
  if (!/^[1-9]\d{0,17}$/.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Enter a valid ICM ID or HTTPS incident URL");
    }
    if (
      url.protocol !== "https:" ||
      !["portal.microsofticm.com", "icm.ad.msft.net"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search
    ) {
      throw new Error("ICM URLs must use an approved HTTPS incident host");
    }
    const route = url.hash ? url.hash.slice(1) : url.pathname;
    const match =
      /^\/(?:imp\/v[35]\/)?incidents\/(?:details\/)?([1-9]\d{0,17})\/?$/i.exec(route);
    if (!match || (url.hash && !["", "/"].includes(url.pathname))) {
      throw new Error("ICM URL must identify exactly one incident");
    }
    id = match[1]!;
  }
  return { id, url: `https://portal.microsofticm.com/imp/v5/incidents/details/${id}` };
}

export const IcmReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .transform((value, ctx) => {
    try {
      return parseIcmReference(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid ICM ID or incident URL" });
      return z.NEVER;
    }
  });

export const DriTimeRangeSchema = z
  .object({ start: utc, end: utc })
  .strict()
  .refine(
    ({ start, end }) =>
      Date.parse(end) >= Date.parse(start) &&
      Date.parse(end) - Date.parse(start) <= 24 * 60 * 60 * 1_000,
    "Time range must be ordered and at most 24 hours",
  );
export const CreateDriSchema = z
  .object({
    icm: IcmReferenceSchema,
    workspaceId: DriKey.default("chats"),
    leadSessionId: DriKey.optional(),
    question: text.optional(),
    symptom: text.optional(),
    timeRange: DriTimeRangeSchema.optional(),
    profile: DriKey.default("auto"),
    service: short.optional(),
    component: short.optional(),
    telemetryCluster: short.optional(),
    telemetryDatabase: short.optional(),
    artifactRef: DriKey.optional(),
    repository: short.optional(),
    pipeline: short.optional(),
    deployment: short.optional(),
    mode: z.enum(["live", "fixture"]).default("live"),
  })
  .strict();
export type CreateDri = z.infer<typeof CreateDriSchema>;

export const DriLimitsSchema = z
  .object({
    maxInvocations: z.number().int().min(1).max(100).default(30),
    maxPages: z.number().int().min(1).max(50).default(10),
    maxRows: z.number().int().min(1).max(2_000).default(200),
    maxBytes: z.number().int().min(1_024).max(4_194_304).default(524_288),
    timeoutMs: z.number().int().min(50).max(120_000).default(15_000),
    concurrency: z.number().int().min(1).max(4).default(4),
    deadlineMs: z.number().int().min(100).max(900_000).default(180_000),
    maxEvidence: z.number().int().min(1).max(2_000).default(500),
    maxRecords: z.number().int().min(10).max(10_000).default(3_000),
    rawRetentionDays: z.number().int().min(0).max(7).default(1),
    evidenceRetentionDays: z.number().int().min(1).max(730).default(90),
    reportRetentionDays: z.number().int().min(1).max(1_825).default(365),
  })
  .strict();
export type DriLimits = z.infer<typeof DriLimitsSchema>;
export const DriPhaseSchema = z.enum([
  "intake",
  "collect",
  "analyze",
  "validate",
  "report",
]);
export const DriStatusSchema = z.enum([
  "draft",
  "intake",
  "collect",
  "analyze",
  "validate",
  "report",
  "awaiting_review",
  "completed",
  "partial",
  "blocked",
  "failed",
  "stopped",
]);
export const DriProfileDecisionSchema = z
  .object({
    id: DriKey,
    profileId: DriKey,
    profileVersion: short,
    method: z.enum(["explicit", "auto", "correction", "unavailable"]),
    confidence,
    evidenceIds: keys,
    explanation: short,
    revision,
    decidedAt: utc,
  })
  .strict();
export type DriProfileDecision = z.infer<typeof DriProfileDecisionSchema>;

export const DriInvestigationSchema = z
  .object({
    id: DriKey,
    version: z.literal(DRI_VERSION),
    revision,
    generation: revision,
    runId: DriKey,
    leadSessionId: z.string().max(160),
    incident: z.object({
      id: z.string().regex(/^[1-9]\d{0,17}$/),
      url: z.string().max(512),
    }),
    requestedProfile: DriKey,
    profile: DriProfileDecisionSchema,
    mode: z.enum(["live", "fixture"]),
    phase: DriPhaseSchema,
    status: DriStatusSchema,
    limits: DriLimitsSchema,
    legalHold: z.boolean().default(false),
    question: text,
    hints: z.array(z.object({ kind: short, fingerprint: hash })).max(12),
    timeRange: DriTimeRangeSchema.optional(),
    artifactRef: DriKey.optional(),
    createdAt: utc,
    updatedAt: utc,
    lifecycleCause: z.enum([
      "created",
      "operator",
      "provider_unavailable",
      "provider_failure",
      "budget",
      "host_restart",
      "restore",
      "profile_corrected",
      "review",
      "finished",
    ]),
    limitation: short,
  })
  .strict();
export type DriInvestigation = z.infer<typeof DriInvestigationSchema>;

export const DriPivotSchema = z.object({
  kind: z.enum([
    "correlation",
    "activity",
    "request",
    "operation",
    "environment",
    "signature",
  ]),
  value: short,
  hashed: z.boolean(),
});
const pivots = z.array(DriPivotSchema).max(40);
const base = {
  id: DriKey,
  investigationId: DriKey,
  profileId: DriKey,
  generation: revision,
  attempt: z.number().int().min(1).max(100),
  invocationId: DriKey,
  createdAt: utc,
};
export const DriArtifactSchema = z.object({
  ...base,
  kind: z.literal("artifacts"),
  mediaType: short,
  size: z.number().int().min(0).max(4_194_304),
  hash,
  storage: z.enum(["fixture", "metadata_only", "local_redacted"]),
  reference: DriKey,
  expiresAt: utc,
  availability: z.enum([
    "available",
    "missing",
    "access_denied",
    "expired",
    "quarantined",
  ]),
  redactionVersion: short,
  quarantined: z.boolean(),
  sensitivity: z.enum(["synthetic", "redacted", "restricted"]),
});
export type DriArtifact = z.infer<typeof DriArtifactSchema>;
export const DriIncidentSchema = z.object({
  ...base,
  kind: z.literal("incidents"),
  summary: text,
  symptom: text,
  impact: text,
  scope: short,
  owningService: short,
  component: short,
  ownershipVerified: z.boolean(),
  startedAt: utc,
  endedAt: utc.optional(),
  identifiers: pivots,
  resources: z.array(z.object({ kind: short, reference: short })).max(40),
  attachments: z
    .array(
      z.object({
        reference: DriKey,
        mediaType: short,
        size: z.number().int().min(0).max(4_194_304),
        availability: z.enum(["available", "missing", "access_denied"]),
      }),
    )
    .max(40),
  details: z.array(text).max(50),
  completeness: z.enum(["complete", "partial", "unavailable"]),
});
export type DriIncident = z.infer<typeof DriIncidentSchema>;
export const DriTimelineSchema = z.object({
  ...base,
  kind: z.literal("timeline"),
  at: utc,
  category: z.enum(["incident", "handoff", "client", "telemetry", "change", "recovery"]),
  summary: text,
  evidenceIds: keys,
});
export const DriEvidenceSchema = z.object({
  ...base,
  kind: z.literal("evidence"),
  type: z.enum(["incident", "har", "telemetry", "similar", "change", "limitation"]),
  providerId: DriKey,
  source: short,
  reference: short,
  observedAt: utc,
  identifiers: pivots,
  finding: text,
  hypothesisIds: keys,
  confidence,
  completeness: z.enum(["complete", "partial", "negative", "unavailable"]),
  limitation: short,
  producerAgentId: DriKey,
  artifactId: DriKey.optional(),
  sensitivity: z.enum(["synthetic", "redacted"]),
  redactionVersion: short,
  provenance: z.object({ sourceVersion: short, collectedAt: utc, contentHash: hash }),
  dedupeKey: DriKey,
  signals: z.array(short).max(30),
});
export type DriEvidence = z.infer<typeof DriEvidenceSchema>;
export const DriCapabilitySchema = z.enum([
  "incident.read",
  "artifact.read",
  "har.analyze",
  "telemetry.query",
  "similar.search",
  "change.read",
]);
export type DriCapability = z.infer<typeof DriCapabilitySchema>;
export const DriProviderDefinitionSchema = z
  .object({
    id: DriKey,
    version: short,
    readOnly: z.literal(true),
    capabilities: z.array(DriCapabilitySchema).min(1).max(6),
    tools: z.array(DriKey).max(20),
    readiness: z.enum(["ready", "unavailable", "access_denied"]),
  })
  .strict();
export type DriProviderDefinition = z.infer<typeof DriProviderDefinitionSchema>;
export const DriQueryStateSchema = z.enum([
  "planned",
  "running",
  "succeeded",
  "no_results",
  "access_denied",
  "unavailable",
  "failed",
  "truncated",
  "incomplete",
  "cancelled",
]);
export type DriQueryState = z.infer<typeof DriQueryStateSchema>;
export const DriQuerySchema = z.object({
  ...base,
  kind: z.literal("queries"),
  key: DriKey,
  stepId: DriKey,
  agentId: DriKey,
  providerId: DriKey,
  capability: DriCapabilitySchema,
  purpose: text,
  template: DriKey,
  parameters: z.array(z.object({ name: DriKey, value: short })).max(20),
  privateParameterNames: z.array(DriKey).max(20),
  parameterHash: hash,
  bounds: DriLimitsSchema,
  timeRange: DriTimeRangeSchema,
  state: DriQueryStateSchema,
  summary: text,
  error: z.enum([
    "none",
    "authorization",
    "capability",
    "policy",
    "timeout",
    "provider",
    "invalid_data",
    "budget",
    "interrupted",
  ]),
  rows: z.number().int().nonnegative().max(10_000),
  bytes: z.number().int().nonnegative().max(4_194_304),
  pages: z.number().int().nonnegative().max(50),
  cursor: short,
  startedAt: utc.optional(),
  endedAt: utc.optional(),
});
export type DriQuery = z.infer<typeof DriQuerySchema>;
export const DriHypothesisSchema = z.object({
  ...base,
  kind: z.literal("hypotheses"),
  statement: text,
  status: z.enum(["proposed", "supported", "contradicted", "unresolved", "ruled_out"]),
  supportingEvidence: keys,
  contradictingEvidence: keys,
  missingEvidence: z.array(short).max(20),
  falsifyingEvidence: z.array(short).max(20),
  confidence,
  revision,
});
export type DriHypothesis = z.infer<typeof DriHypothesisSchema>;
export const DriSimilarSchema = z.object({
  ...base,
  kind: z.literal("similar"),
  reference: short,
  match: z.enum(["strong", "partial", "ruled_out"]),
  score: confidence,
  technicalSignals: z.array(short).max(20),
  mismatches: z.array(short).max(20),
  priorCause: text,
  priorMitigation: text,
  applicability: text,
  evidenceIds: keys,
});
export type DriSimilar = z.infer<typeof DriSimilarSchema>;
export const DriChangeSchema = z.object({
  ...base,
  kind: z.literal("changes"),
  category: z.enum(["code", "config", "pipeline", "deployment"]),
  reference: short,
  at: utc,
  assessment: z.enum(["temporal_only", "causal_support", "ruled_out"]),
  summary: text,
  technicalSignals: z.array(short).max(20),
  evidenceIds: keys,
});
export type DriChange = z.infer<typeof DriChangeSchema>;
const claim = z.object({ statement: text, evidenceIds: keys });
export const DriCausalChainSchema = z.object({
  trigger: claim,
  firstIncorrectBehavior: claim,
  downstreamImpact: claim,
  customerSymptom: claim,
  mitigationRecovery: claim,
  immediateFailure: claim,
  underlyingRootCause: claim,
  contributors: z.array(claim).max(10),
  scope: claim,
  fallbackRetry: claim,
  detectionGaps: claim,
  recurrenceRisk: claim,
  alternativesRuledOut: z.array(claim).max(10),
  confidence,
  assessment: z.enum(["supported", "provisional", "unknown"]),
});
export type DriCausalChain = z.infer<typeof DriCausalChainSchema>;
export const DRI_REPORT_SECTIONS = [
  "Executive summary",
  "Timeline (UTC)",
  "HAR / client",
  "Telemetry",
  "Similar incidents",
  "Root-cause assessment",
  "Changes / deployments",
  "Limitations / missing evidence",
] as const;
export const DriReportSchema = z.object({
  ...base,
  kind: z.literal("reports"),
  revision: z.number().int().positive(),
  sections: z
    .array(z.object({ title: z.enum(DRI_REPORT_SECTIONS), ...claim.shape }))
    .length(DRI_REPORT_SECTIONS.length)
    .refine(
      (sections) =>
        new Set(sections.map((section) => section.title)).size ===
        DRI_REPORT_SECTIONS.length,
      "Every DRI section is required exactly once",
    ),
  causalChain: DriCausalChainSchema,
  actions: z
    .array(
      z.object({
        kind: z.enum(["immediate", "permanent", "telemetry", "validation", "ownership"]),
        ...claim.shape,
      }),
    )
    .min(5)
    .max(20)
    .refine(
      (actions) => new Set(actions.map((action) => action.kind)).size === 5,
      "All five action categories are required",
    ),
  evidenceIds: keys,
  contentHash: hash,
});
export type DriReport = z.infer<typeof DriReportSchema>;
export const DriAuditSchema = z.object({
  ...base,
  kind: z.literal("audit"),
  event: z.enum([
    "authorization",
    "capability",
    "policy",
    "redaction",
    "invocation",
    "transition",
    "late_result",
    "restore",
    "retention",
  ]),
  decision: z.enum(["allow", "deny", "retain", "pause"]),
  reason: short,
});
export const DriWorkSchema = z.object({
  ...base,
  kind: z.literal("work"),
  logicalKey: DriKey,
  stepId: DriKey,
  agentId: DriKey,
  role: z.enum([
    "intake",
    "har",
    "telemetry",
    "similar",
    "change",
    "analyze",
    "validate",
    "report",
  ]),
  dependsOn: keys,
  capabilities: z.array(DriCapabilitySchema).max(6),
  state: z.enum(["pending", "running", "completed", "partial", "blocked", "stopped"]),
});
export type DriWork = z.infer<typeof DriWorkSchema>;
export const DriRecordSchema = z.discriminatedUnion("kind", [
  DriIncidentSchema,
  DriTimelineSchema,
  DriEvidenceSchema,
  DriArtifactSchema,
  DriQuerySchema,
  DriHypothesisSchema,
  DriSimilarSchema,
  DriChangeSchema,
  DriReportSchema,
  DriAuditSchema,
  DriWorkSchema,
]);
export type DriRecord = z.infer<typeof DriRecordSchema>;
export type DriRecordKind = DriRecord["kind"];
export type DriRecordOf<K extends DriRecordKind> = Extract<DriRecord, { kind: K }>;
export const DriPageInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.coerce.number().int().min(0).max(10_000_000).default(0),
  revision: z.coerce.number().int().min(0).optional(),
  generation: z.coerce.number().int().min(0).optional(),
});
export type DriPage<T> = {
  items: T[];
  nextCursor: number | null;
  revision: number;
  generation?: number;
};
export const DRI_BACKUP_LIMITS = {
  investigations: 2_000,
  decisions: 10_000,
  records: 100_000,
  attempts: 100_000,
  tombstones: 10_000,
} as const;
export const DriBackupCountsSchema = z.object({
  investigations: revision,
  decisions: revision,
  records: revision,
  attempts: revision,
  tombstones: revision,
});
export type DriBackupCounts = z.infer<typeof DriBackupCountsSchema>;
export const DriBackupCoverageSchema = z.object({
  state: z.enum(["complete", "limited", "degraded"]),
  reason: z.enum(["none", "capacity", "export_failed", "incomplete_source"]),
  totals: DriBackupCountsSchema.nullable(),
  included: DriBackupCountsSchema,
});
export const DriRetentionTombstoneSchema = z.object({
  id: DriKey,
  investigationId: DriKey,
  runId: DriKey,
  generation: revision,
  expiredAt: utc,
  reason: z.literal("retention_expired"),
});
export const DriBackupSchema = z
  .object({
    version: z.literal(DRI_VERSION),
    coverage: DriBackupCoverageSchema.optional(),
    investigations: z.array(DriInvestigationSchema).max(DRI_BACKUP_LIMITS.investigations),
    decisions: z
      .array(z.object({ investigationId: DriKey, decision: DriProfileDecisionSchema }))
      .max(DRI_BACKUP_LIMITS.decisions),
    attempts: z
      .array(
        z.object({
          id: DriKey,
          query: DriQuerySchema,
          hash,
          accepted: z.boolean(),
        }),
      )
      .max(DRI_BACKUP_LIMITS.attempts)
      .default([]),
    tombstones: z
      .array(DriRetentionTombstoneSchema)
      .max(DRI_BACKUP_LIMITS.tombstones)
      .default([]),
    records: z
      .array(
        z.object({
          record: DriRecordSchema,
          hash,
          head: z.boolean(),
          logicalKey: DriKey,
        }),
      )
      .max(DRI_BACKUP_LIMITS.records),
  })
  .superRefine((backup, context) => {
    if (!backup.coverage) return;
    for (const key of Object.keys(DRI_BACKUP_LIMITS) as (keyof DriBackupCounts)[]) {
      if (
        backup.coverage.included[key] !== backup[key].length ||
        (backup.coverage.totals !== null &&
          backup.coverage.included[key] > backup.coverage.totals[key])
      ) {
        context.addIssue({
          code: "custom",
          message: "DRI backup coverage does not match its payload",
        });
      }
      if (
        backup.coverage.state === "complete" &&
        (backup.coverage.reason !== "none" ||
          backup.coverage.totals?.[key] !== backup.coverage.included[key])
      ) {
        context.addIssue({
          code: "custom",
          message: "A complete DRI backup must account for every row",
        });
      }
    }
  });
export type DriBackup = z.infer<typeof DriBackupSchema>;

export function degradedDriBackup(): DriBackup {
  return DriBackupSchema.parse({
    version: DRI_VERSION,
    investigations: [],
    decisions: [],
    records: [],
    attempts: [],
    tombstones: [],
    coverage: {
      state: "degraded",
      reason: "export_failed",
      totals: null,
      included: {
        investigations: 0,
        decisions: 0,
        records: 0,
        attempts: 0,
        tombstones: 0,
      },
    },
  });
}
export function driBackupWarning(archive: unknown): string {
  if (!archive || typeof archive !== "object" || !("dri" in archive)) return "";
  const dri = archive.dri;
  if (!dri || typeof dri !== "object" || !("coverage" in dri)) return "";
  const coverage = DriBackupCoverageSchema.safeParse(dri.coverage);
  if (!coverage.success || coverage.data.state === "complete") return "";
  return "DRI backup is incomplete. Some investigation data is omitted; affected Runs remain paused after restore. Preserve the source Host.";
}

export const DriAvailabilitySchema = z.object({
  fixtureEnabled: z.boolean(),
  liveRegistration: z.literal("embedding_only"),
  liveProvidersConfigured: z.boolean(),
});
export type DriAvailability = z.infer<typeof DriAvailabilitySchema>;
export const DriProposalScopeSchema = z
  .object({
    runId: DriKey,
    stepId: DriKey,
    producerAgentId: DriKey,
    producerSessionId: z.string().max(160),
    stepAttempt: z.number().int().min(1).max(100),
    generation: revision,
    attempt: z.number().int().min(1).max(100),
    invocationId: DriKey,
  })
  .strict();
export type DriProposalScope = z.infer<typeof DriProposalScopeSchema>;

export function renderDriReport(report: DriReport): string {
  const cite = (ids: string[]) => ids.map((id) => `[${id}](#evidence-${id})`).join(" ");
  const lines = report.sections.map(
    (section) =>
      `## ${section.title}\n\n${section.statement}\n\n${cite(section.evidenceIds)}`,
  );
  for (const [name, value] of Object.entries(report.causalChain)) {
    if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`### ${name}\n\n${value.statement}\n\n${cite(value.evidenceIds)}`);
    } else if (Array.isArray(value)) {
      for (const entry of value)
        lines.push(`### ${name}\n\n${entry.statement}\n\n${cite(entry.evidenceIds)}`);
    }
  }
  lines.push(
    `Confidence: ${report.causalChain.confidence}; assessment: ${report.causalChain.assessment}`,
    "## Recommended actions",
    ...report.actions.map(
      (action) => `- **${action.kind}**: ${action.statement} ${cite(action.evidenceIds)}`,
    ),
  );
  return lines.join("\n\n");
}
