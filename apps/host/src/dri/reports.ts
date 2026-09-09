import {
  DRI_REPORT_SECTIONS,
  DriReportSchema,
  type DriCausalChain,
  type DriEvidence,
  type DriHypothesis,
  type DriInvestigation,
  type DriReport,
} from "@fleet/protocol";
import { contentHash, DriError, stableId } from "./safety.js";
import type { DriStore } from "./store.js";
import {
  assessProfileRule,
  genericProfile,
  type InvestigationProfile,
} from "./profiles.js";

export function validateCitations(evidence: DriEvidence[], ids: string[]): void {
  const known = new Set(evidence.map((item) => item.id));
  if (ids.some((id) => !known.has(id)))
    throw new DriError("Unknown, stale, or cross-investigation evidence citation", 422);
}
export function validateHypothesis(
  hypothesis: DriHypothesis,
  evidence: DriEvidence[],
): void {
  validateCitations(evidence, [
    ...hypothesis.supportingEvidence,
    ...hypothesis.contradictingEvidence,
  ]);
  if (
    hypothesis.supportingEvidence.some((id) =>
      hypothesis.contradictingEvidence.includes(id),
    )
  ) {
    throw new DriError(
      "Evidence cannot both support and contradict the same hypothesis",
      422,
    );
  }
  const kinds = new Set(
    evidence
      .filter((item) => hypothesis.supportingEvidence.includes(item.id))
      .map((item) => item.type),
  );
  if (
    hypothesis.status === "supported" &&
    (!hypothesis.supportingEvidence.length ||
      hypothesis.contradictingEvidence.length ||
      kinds.size < 2)
  ) {
    throw new DriError(
      "Supported hypotheses require corroboration and resolved contradictions",
      422,
    );
  }
  if (hypothesis.confidence > (kinds.size >= 2 ? 0.85 : 0.5))
    throw new DriError("Hypothesis confidence exceeds evidence support", 422);
}
export function validateReport(report: DriReport, evidence: DriEvidence[]): void {
  DriReportSchema.parse(report);
  const claims = [
    ...report.sections,
    ...report.actions,
    ...Object.values(report.causalChain).flatMap((value) =>
      Array.isArray(value) ? value : typeof value === "object" ? [value] : [],
    ),
  ];
  const ids = claims.flatMap((claim) => claim.evidenceIds);
  validateCitations(evidence, [...ids, ...report.evidenceIds]);
  if (ids.some((id) => !report.evidenceIds.includes(id)))
    throw new DriError("Report citation index is incomplete", 422);
  const causal = report.causalChain;
  for (const claim of [
    causal.trigger,
    causal.firstIncorrectBehavior,
    causal.underlyingRootCause,
    causal.immediateFailure,
  ]) {
    if (!claim.evidenceIds.length && !/^Unknown|^Not established/.test(claim.statement))
      throw new DriError("Unsupported causal claim", 422);
  }
  const support = evidence.filter((item) =>
    causal.underlyingRootCause.evidenceIds.includes(item.id),
  );
  if (
    causal.assessment === "supported" &&
    (new Set(support.map((item) => item.type)).size < 2 ||
      !support.some((item) => item.signals.includes("causal_mechanism_verified")))
  ) {
    throw new DriError(
      "Root cause requires independent evidence and verified causal mechanism",
      422,
    );
  }
  if (causal.assessment !== "supported" && causal.confidence > 0.75)
    throw new DriError("Provisional root-cause confidence must be bounded", 422);
  const { contentHash: _hash, ...body } = report;
  if (contentHash(body) !== report.contentHash)
    throw new DriError("Report content hash mismatch", 422);
}

export function buildReport(
  investigation: DriInvestigation,
  store: DriStore,
  profile: InvestigationProfile = genericProfile,
): DriReport {
  const evidence = store.all(investigation.id, "evidence");
  const citations = (type: DriEvidence["type"]) =>
    evidence
      .filter((item) => item.type === type)
      .slice(0, 15)
      .map((item) => item.id);
  const statements = (type: DriEvidence["type"]) =>
    evidence
      .filter((item) => item.type === type)
      .slice(0, 8)
      .map((item) => item.finding)
      .join(" ") || "Not established; evidence is missing or inaccessible.";
  const assessment = assessProfileRule(profile, evidence);
  const corroborated = assessment?.corroborated ?? false;
  const causeEvidence = assessment?.supporting.slice(0, 10).map((item) => item.id) ?? [];
  const retryEvidence = evidence
    .filter(
      (item) => item.type === "telemetry" && item.signals.includes("retry_exhausted"),
    )
    .map((item) => item.id);
  const unknown = (statement: string) => ({
    statement: `Unknown: ${statement}`,
    evidenceIds: [] as string[],
  });
  const causalChain: DriCausalChain = {
    trigger: unknown(
      "initiating condition has not been causally verified; a preceding deployment alone is insufficient.",
    ),
    firstIncorrectBehavior: corroborated
      ? { statement: assessment!.rule.firstIncorrectBehavior, evidenceIds: causeEvidence }
      : unknown(
          "first incorrect service behavior requires corroborated client and telemetry evidence.",
        ),
    downstreamImpact: {
      statement: statements("telemetry"),
      evidenceIds: citations("telemetry"),
    },
    customerSymptom: {
      statement: statements("incident"),
      evidenceIds: citations("incident"),
    },
    mitigationRecovery: unknown(
      "recovery and mitigation effectiveness require post-action read-only validation.",
    ),
    immediateFailure: corroborated
      ? { statement: assessment!.rule.immediateFailure, evidenceIds: causeEvidence }
      : unknown("immediate failure is not corroborated."),
    underlyingRootCause: unknown(
      "the initiating causal mechanism remains unverified; similar incidents are hypotheses, not proof.",
    ),
    contributors:
      retryEvidence.length > 0
        ? [
            {
              statement: "Telemetry records exhausted retries for affected operations.",
              evidenceIds: retryEvidence,
            },
          ]
        : [],
    scope: { statement: statements("incident"), evidenceIds: citations("incident") },
    fallbackRetry: { statement: statements("har"), evidenceIds: citations("har") },
    detectionGaps: unknown(
      "detection coverage requires alert and success-cohort evidence.",
    ),
    recurrenceRisk: unknown(
      "cannot estimate recurrence before the initiating mechanism is established.",
    ),
    alternativesRuledOut: store
      .all(investigation.id, "similar")
      .filter((item) => item.match === "ruled_out")
      .map((item) => ({ statement: item.applicability, evidenceIds: item.evidenceIds }))
      .slice(0, 10),
    confidence: corroborated ? 0.7 : 0.25,
    assessment: corroborated ? "provisional" : "unknown",
  };
  const similar = store.all(investigation.id, "similar");
  const comparison = [
    "Match | Technical signals | Applicability",
    "--- | --- | ---",
    ...similar.map(
      (item) =>
        `${item.match} | ${item.technicalSignals.join(", ") || "none"} | ${item.applicability}`,
    ),
  ].join("\n");
  const sections: DriReport["sections"] = DRI_REPORT_SECTIONS.map((title) => {
    switch (title) {
      case "Executive summary":
        return {
          title,
          statement: corroborated
            ? `${assessment!.rule.hypothesis} The underlying initiating cause remains unverified.`
            : "Investigation is incomplete; missing evidence is not evidence of absence.",
          evidenceIds: causeEvidence,
        };
      case "Timeline (UTC)":
        return {
          title,
          statement:
            store
              .all(investigation.id, "timeline")
              .slice(0, 12)
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((entry) => `${entry.at} — ${entry.summary}`)
              .join("\n") || "Timeline unavailable.",
          evidenceIds: citations("incident"),
        };
      case "HAR / client":
        return { title, statement: statements("har"), evidenceIds: citations("har") };
      case "Telemetry":
        return {
          title,
          statement: statements("telemetry"),
          evidenceIds: citations("telemetry"),
        };
      case "Similar incidents":
        return {
          title,
          statement: similar.length
            ? comparison
            : "No comparable incident evidence available.",
          evidenceIds: citations("similar"),
        };
      case "Changes / deployments":
        return {
          title,
          statement: statements("change"),
          evidenceIds: citations("change"),
        };
      case "Root-cause assessment":
        return {
          title,
          statement: causalChain.underlyingRootCause.statement,
          evidenceIds: causeEvidence,
        };
      case "Limitations / missing evidence":
        return {
          title,
          statement:
            evidence
              .filter((item) => item.completeness === "unavailable" || item.limitation)
              .slice(0, 8)
              .map((item) => item.limitation || item.finding)
              .join(" ") ||
            "No provider access limitations observed. Causal validation and recovery verification remain outstanding.",
          evidenceIds: citations("limitation"),
        };
    }
  });
  const actions: DriReport["actions"] = [
    {
      kind: "immediate",
      statement:
        "Ask the authorized service owner to verify dependency health and evaluate documented mitigation; this workflow performs no production mutations.",
      evidenceIds: causeEvidence,
    },
    {
      kind: "permanent",
      statement:
        "Confirm the causal mechanism before proposing a permanent fix; do not attribute cause by deployment timing alone.",
      evidenceIds: citations("change"),
    },
    {
      kind: "telemetry",
      statement:
        "Compare affected, unaffected, failed and successful cohorts; inspect first-failure and retry outcomes within the scoped UTC window.",
      evidenceIds: citations("telemetry"),
    },
    {
      kind: "validation",
      statement:
        "Verify recovery, falsify competing hypotheses, and collect missing evidence before raising confidence.",
      evidenceIds: causeEvidence,
    },
    {
      kind: "ownership",
      statement:
        "Have the current owning service review evidence and assign follow-up ownership through its authorized process.",
      evidenceIds: citations("incident"),
    },
  ];
  const evidenceIds = [
    ...new Set(
      [
        ...sections,
        ...actions,
        ...Object.values(causalChain).flatMap((value) =>
          Array.isArray(value) ? value : typeof value === "object" ? [value] : [],
        ),
      ].flatMap((claim) => claim.evidenceIds),
    ),
  ];
  const revision = store.all(investigation.id, "reports").length + 1;
  const body = {
    id: stableId("report", [investigation.id, investigation.generation, revision]),
    investigationId: investigation.id,
    profileId: investigation.profile.profileId,
    generation: investigation.generation,
    attempt: 1,
    invocationId: "domain",
    createdAt: new Date().toISOString(),
    kind: "reports" as const,
    revision,
    sections: sections.map((section) => ({
      ...section,
      statement: section.statement.slice(0, 2_000),
    })),
    causalChain,
    actions,
    evidenceIds,
  };
  const report = DriReportSchema.parse({ ...body, contentHash: contentHash(body) });
  validateReport(report, evidence);
  return report;
}
