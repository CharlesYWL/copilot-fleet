import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  evaluateShadowCase,
  jevShadowRequest,
  ShadowDatasetSchema,
  ShadowPredictionsSchema,
  ShadowThresholdsSchema,
  summarizeShadow,
  type ShadowPrediction,
  type ShadowResult,
  type ShadowThresholds,
} from "./jev-shadow.js";

export type ShadowProvider = (
  request: ReturnType<typeof jevShadowRequest>,
) => Promise<unknown>;

/** Only the offline CLI constructs this client, after explicit upload consent. */
export function createJevShadowProvider(apiKey: string): ShadowProvider {
  if (!apiKey.trim()) throw new Error("TYPESAFE_API_KEY is required");
  const client = new TypeSafeClient({
    apiKey,
    baseURL: "https://api.typesafe.ai",
    logLevel: "off",
    timeout: 2_000,
    retry: { maxRetries: 0 },
    // An environment override or redirect must not move sensitive state elsewhere.
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  return async (request) =>
    client.systemOne(request, { signal: AbortSignal.timeout(2_000) });
}

type EvaluationMode =
  | { mode: "replay"; predictions: unknown }
  | { mode: "remote"; model: string; provider: ShadowProvider };

export async function runShadowEvaluation(
  input: unknown,
  thresholds: ShadowThresholds,
  mode: EvaluationMode,
) {
  const dataset = ShadowDatasetSchema.parse(input);
  const policy = ShadowThresholdsSchema.parse(thresholds);
  const predictions =
    mode.mode === "replay"
      ? ShadowPredictionsSchema.parse(mode.predictions).predictions
      : [];
  if (predictions.some((entry) => !dataset.cases.some((c) => c.id === entry.caseId))) {
    throw new Error("Predictions contain unknown case IDs");
  }
  if (mode.mode === "remote" && !/^[a-zA-Z0-9._-]{1,120}$/.test(mode.model)) {
    throw new Error("Invalid Jev model identifier");
  }
  const results: ShadowResult[] = [];
  for (const sample of dataset.cases) {
    let prediction = predictions.find((entry) => entry.caseId === sample.id);
    const before = evaluateShadowCase(sample, undefined, policy);
    if (mode.mode === "remote" && before.eligible) {
      const started = performance.now();
      try {
        const response = await mode.provider(jevShadowRequest(sample, mode.model));
        prediction = {
          caseId: sample.id,
          fingerprint: before.fingerprint,
          latencyMs: performance.now() - started,
          response,
        };
      } catch {
        // Provider errors can contain credentials, input text or response bodies.
        prediction = {
          caseId: sample.id,
          fingerprint: before.fingerprint,
          latencyMs: performance.now() - started,
          error: "provider_error",
        };
      }
    }
    results.push(evaluateShadowCase(sample, prediction, policy));
  }
  return {
    version: 1 as const,
    mode: "shadow" as const,
    source: mode.mode,
    thresholds: policy,
    results,
    summary: summarizeShadow(results),
    // Enough to replay with another threshold, without echoing any source text.
    predictions: results.flatMap((result): ShadowPrediction[] => {
      if (result.latencyMs === null) return [];
      const base = {
        caseId: result.caseId,
        fingerprint: result.fingerprint,
        latencyMs: result.latencyMs,
      };
      if (result.reason === "provider_error")
        return [{ ...base, error: "provider_error" }];
      if (
        result.model === null ||
        result.confidence === null ||
        result.probability === null ||
        result.leadProbability === null ||
        result.choice === null
      ) {
        return [base];
      }
      return [
        {
          ...base,
          response: {
            model: result.model,
            answers: {
              handoff: {
                type: "choice",
                choice: result.choice,
                confidence: result.confidence,
                probabilities: {
                  preauthorized_review: result.probability,
                  lead: result.leadProbability,
                },
              },
            },
          },
        },
      ];
    }),
  };
}
