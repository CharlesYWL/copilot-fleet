import { DriProviderDefinitionSchema, type DriCapability } from "@fleet/protocol";
import { analyzeHar } from "./har.js";
import {
  ProviderPageSchema,
  telemetryPlan,
  type InvestigationProvider,
  type ProviderContext,
  type ProviderPage,
} from "./providers.js";
import { contentHash } from "./safety.js";

// Synthetic fixture clock and handles; never copied from an incident or reference repository.
export const FIXTURE_TIME = "2025-01-01T00:10:00.000Z";
export const fixtureHar = JSON.stringify({
  log: {
    entries: [
      {
        startedDateTime: "2025-01-01T00:10:00.000Z",
        time: 20,
        request: {
          method: "GET",
          url: "https://fixture.invalid/bootstrap",
          headers: [
            { name: "Authorization", value: "Bearer synthetic-not-a-credential" },
          ],
        },
        response: { status: 200, content: { text: "{}" } },
      },
      {
        startedDateTime: "2025-01-01T00:10:01.000Z",
        time: 6_000,
        request: {
          method: "POST",
          url: "https://fixture.invalid/operation?token=synthetic-only",
          headers: [{ name: "x-ms-correlation-id", value: "fixture-correlation" }],
        },
        response: {
          status: 503,
          headers: [{ name: "Set-Cookie", value: "synthetic=not-a-secret" }],
          content: { text: '{"error":"upstream_unavailable"}' },
        },
        timings: { wait: 5_990, send: 5, receive: 5 },
      },
      {
        startedDateTime: "2025-01-01T00:10:08.000Z",
        time: 25,
        request: { method: "POST", url: "https://fixture.invalid/operation" },
        response: { status: 503 },
      },
      {
        startedDateTime: "2025-01-01T00:11:00.000Z",
        time: 30,
        request: { method: "GET", url: "https://fixture.invalid/unaffected" },
        response: { status: 200 },
      },
    ],
  },
});
const capabilities: DriCapability[] = [
  "incident.read",
  "har.analyze",
  "telemetry.query",
  "similar.search",
  "change.read",
  "artifact.read",
];
export type FixtureOptions = {
  unavailable?: DriCapability[];
  outcomes?: Partial<Record<DriCapability, ProviderPage["state"]>>;
  missingAttachment?: boolean;
  inaccessibleAttachment?: boolean;
  delay?: (context: ProviderContext) => Promise<void>;
};
export function fixtureProviders(options: FixtureOptions = {}): InvestigationProvider[] {
  return capabilities
    .filter((capability) => !options.unavailable?.includes(capability))
    .map((capability) => ({
      definition: DriProviderDefinitionSchema.parse({
        id: `fixture.${capability}`,
        version: "1.0.0",
        readOnly: true,
        capabilities: [capability],
        tools: [],
        readiness: "ready",
      }),
      async read(context) {
        await options.delay?.(context);
        if (context.signal.aborted) throw new Error("Interrupted");
        const outcome = options.outcomes?.[capability];
        if (outcome && outcome !== "succeeded")
          return ProviderPageSchema.parse({
            state: outcome,
            summary: `Synthetic ${outcome} result`,
          });
        return fixturePage(capability, context, options);
      },
    }));
}

function fixturePage(
  capability: DriCapability,
  context: ProviderContext,
  options: FixtureOptions,
): ProviderPage {
  const evidence = (type: string, finding: string, signals: string[] = []) => ({
    type,
    finding,
    signals,
    observedAt: FIXTURE_TIME,
    completeness: "complete",
    confidence: 0.9,
  });
  switch (capability) {
    case "incident.read": {
      const second = context.cursor === "fixture-page-2";
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary: second
          ? "Synthetic handoff and linked-resource page"
          : "Synthetic incident details page",
        ...(!second ? { nextCursor: "fixture-page-2" } : {}),
        incident: {
          summary: "Warehouse operation unavailable",
          symptom: "Warehouse operation fails after retry",
          impact: "Synthetic affected cohort experiences failed operations",
          scope: "One synthetic service cohort; unaffected cohort succeeds",
          owningService: "Data Movement Service",
          component: "Fabric Warehouse",
          ownershipVerified: true,
          startedAt: FIXTURE_TIME,
          identifiers: [
            { kind: "correlation", value: "hash:fixture-correlation", hashed: true },
          ],
          resources: second
            ? [{ kind: "linked_incident", reference: "fixture:prior-strong" }]
            : [],
          attachments: [
            {
              reference: "fixture:har",
              mediaType: "application/json",
              size: Buffer.byteLength(fixtureHar),
              availability: options.missingAttachment
                ? "missing"
                : options.inaccessibleAttachment
                  ? "access_denied"
                  : "available",
            },
          ],
          details: [
            second
              ? "Handoff confirms affected cohort; recovery not yet verified."
              : "Initial technical symptom and scope captured.",
          ],
          completeness: "complete",
        },
        evidence: [
          evidence(
            "incident",
            second
              ? "Handoff corroborates the affected cohort; recovery unverified."
              : "Verified owning service and component with operation failures.",
            ["warehouse_operation"],
          ),
        ],
        timeline: [
          {
            at: second ? "2025-01-01T00:12:00.000Z" : FIXTURE_TIME,
            category: second ? "handoff" : "incident",
            summary: second ? "Technical handoff captured" : "First reported impact",
          },
        ],
      });
    }
    case "har.analyze": {
      const analysis = analyzeHar(fixtureHar, context.query.bounds);
      return ProviderPageSchema.parse({
        state: analysis.truncated ? "truncated" : "succeeded",
        summary: `Analyzed ${analysis.requests.length} requests; first meaningful failure at request ${analysis.firstFailure ?? "none"}. Credential values discarded.`,
        artifacts: [
          {
            reference: "fixture:har",
            mediaType: "application/json",
            size: Buffer.byteLength(fixtureHar),
            hash: analysis.hash,
            availability: "available",
          },
        ],
        evidence: analysis.requests.map((request) =>
          evidence(
            "har",
            `Request ${request.order}: ${request.method}, HTTP ${request.status}, ${request.durationMs}ms, ${request.outcome}; retry of ${request.retryOf ?? "none"}; redirect parent ${request.parentOrder ?? "none"}. Timing wait=${request.phases.wait}ms, connect=${request.phases.connect}ms.`,
            request.signals,
          ),
        ),
        timeline: analysis.requests.map((request) => ({
          at: request.at,
          category: "client",
          summary: `Request ${request.order}: HTTP ${request.status}; ${request.outcome}`,
        })),
      });
    }
    case "telemetry.query":
      telemetryPlan(context.profile, context.query);
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary:
          "Failed/successful and affected/unaffected fixture cohorts compared within bounded UTC window",
        evidence: [
          evidence(
            "telemetry",
            "Affected operations returned upstream_unavailable; dependency refused traffic before retries exhausted.",
            [
              "upstream_unavailable",
              "retry_exhausted",
              "warehouse_operation",
              "dependency_refused",
            ],
          ),
          evidence(
            "telemetry",
            "Successful and unaffected cohorts did not show dependency refusal in the same UTC window.",
            [
              "unaffected_success",
              "failed_success_comparison",
              "affected_unaffected_comparison",
            ],
          ),
        ],
      });
    case "similar.search":
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary: context.cursor
          ? "False-match technical comparison"
          : "Progressive technical signature comparison",
        ...(context.cursor ? {} : { nextCursor: "fixture-similar-2" }),
        similar: context.cursor
          ? [
              {
                reference: "fixture:prior-false",
                technicalSignals: ["auth_failure"],
                mismatches: ["different_failure_layer"],
                priorCause: "Expired authorization, not dependency refusal",
                priorMitigation: "Renew authentication",
              },
            ]
          : [
              {
                reference: "fixture:prior-strong",
                technicalSignals: ["upstream_unavailable", "retry_exhausted"],
                mismatches: [],
                priorCause: "Dependency admission failure",
                priorMitigation: "Restore dependency health after verification",
              },
            ],
        evidence: [
          evidence(
            "similar",
            context.cursor
              ? "Similar wording but incompatible authentication signature."
              : "Prior incident matches dependency failure and retry-exhaustion signals.",
            context.cursor
              ? ["auth_failure"]
              : ["upstream_unavailable", "retry_exhausted"],
          ),
        ],
      });
    case "change.read":
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary: "Deployment found before impact; temporal correlation only",
        changes: [
          {
            reference: "deployment:fixture",
            category: "deployment",
            at: "2025-01-01T00:08:00.000Z",
            summary:
              "Synthetic deployment precedes impact; no rollback or code-path evidence proves causality.",
            technicalSignals: ["preceded_impact"],
            causalEvidence: false,
          },
        ],
        evidence: [
          evidence(
            "change",
            "A deployment preceded the first failure; causal attribution remains unproven.",
            ["preceded_impact"],
          ),
        ],
      });
    case "artifact.read":
      return ProviderPageSchema.parse({
        state: "succeeded",
        summary: "Synthetic artifact metadata only",
        artifacts: [
          {
            reference: "fixture:har",
            mediaType: "application/json",
            size: Buffer.byteLength(fixtureHar),
            hash: contentHash(fixtureHar),
            availability: "available",
          },
        ],
      });
  }
}
