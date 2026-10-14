import { z } from "zod";

export const WORKER_CATEGORIES = [
  "implement",
  "test",
  "explore",
  "review-quick",
  "review-deep",
] as const;

export const WorkerRoutingModeSchema = z.enum(["off", "shadow", "route"]);
export const DecisionProviderKindSchema = z.enum(["foundry", "typesafe"]);
export type DecisionProviderKind = z.infer<typeof DecisionProviderKindSchema>;

export function decisionEndpoint(kind: DecisionProviderKind, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter an HTTPS decision provider URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw new Error("Use HTTPS without credentials, a query, fragment, or custom port.");
  }
  const path = kind === "foundry" ? "/providers/microsoft/v1/systemone" : "/v1/systemone";
  const hostAllowed =
    kind === "foundry"
      ? /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:services\.ai|openai|cognitiveservices)\.azure\.com$/.test(
          url.hostname,
        )
      : url.hostname === "api.typesafe.ai";
  if (!hostAllowed || !["/", path, `${path}/`].includes(url.pathname)) {
    throw new Error(
      kind === "foundry"
        ? "Use an Azure AI Foundry resource URL or its Microsoft decision endpoint."
        : "Use https://api.typesafe.ai or https://api.typesafe.ai/v1/systemone.",
    );
  }
  url.pathname = path;
  return url.href;
}

const decisionProviderFields = {
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .refine(
      (value) => !["constructor", "prototype"].includes(value),
      "This connection ID is reserved.",
    ),
  name: z.string().trim().min(1).max(80),
  kind: DecisionProviderKindSchema,
  endpoint: z.string().max(500),
  model: z.string().trim().min(1).max(200),
} as const;

export const DecisionProviderSchema = z
  .object(decisionProviderFields)
  .superRefine((value, context) => {
    try {
      decisionEndpoint(value.kind, value.endpoint);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: error instanceof Error ? error.message : "Invalid decision endpoint.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    endpoint: decisionEndpoint(value.kind, value.endpoint),
  }));
export type DecisionProvider = z.infer<typeof DecisionProviderSchema>;

export const WorkerExecutionProfileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,39}$/, "Use 2-40 lowercase letters, digits, or hyphens.")
    .refine((value) => !["auto", "default"].includes(value), "This ID is reserved."),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  model: z.string().min(1).max(200),
  reasoningEffort: z.string().min(1).max(200).nullable(),
});
export type WorkerExecutionProfile = z.infer<typeof WorkerExecutionProfileSchema>;

export const WorkerExecutionProfilesSchema = z
  .array(WorkerExecutionProfileSchema)
  .max(20)
  .refine(
    (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    "Profile IDs must be unique.",
  );

export const WorkerRoutingConfigurationSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  mode: WorkerRoutingModeSchema.default("off"),
  minProbability: z.number().min(0).max(1).default(0.5),
  timeoutMs: z.number().int().min(500).max(10_000).default(5000),
  providers: z
    .array(DecisionProviderSchema)
    .max(8)
    .default([])
    .refine(
      (providers) =>
        new Set(providers.map((provider) => provider.id)).size === providers.length,
      "Decision model IDs must be unique.",
    ),
  profiles: WorkerExecutionProfilesSchema.default([]),
});
export type WorkerRoutingConfiguration = z.infer<typeof WorkerRoutingConfigurationSchema>;

export const DecisionProviderDraftSchema = z.object({
  provider: DecisionProviderSchema,
  keyAction: z.enum(["keep", "replace", "clear"]).default("keep"),
  key: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^[\x21-\x7e]+$/, "An API key must contain only printable non-space ASCII.")
    .optional(),
  testToken: z.string().uuid().optional(),
});
export type DecisionProviderDraft = z.infer<typeof DecisionProviderDraftSchema>;

export const UpdateWorkerRoutingSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  mode: WorkerRoutingModeSchema,
  minProbability: z.number().min(0).max(1),
  timeoutMs: z.number().int().min(500).max(10_000),
  providers: z.array(DecisionProviderDraftSchema).max(8),
  profiles: WorkerExecutionProfilesSchema,
});
export type UpdateWorkerRouting = z.infer<typeof UpdateWorkerRoutingSchema>;

export const ProposeWorkerRoutingPolicySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(10).max(1000),
  profiles: WorkerExecutionProfilesSchema,
});

export const WorkerRoutingProposalSchema = ProposeWorkerRoutingPolicySchema.extend({
  id: z.string().uuid(),
  leadSessionId: z.string(),
  leadName: z.string(),
  createdAt: z.string().datetime(),
});
export type WorkerRoutingProposal = z.infer<typeof WorkerRoutingProposalSchema>;

export const workerRoutingFallbackLabels = {
  shadow: "Shadow mode uses worker defaults",
  over_size: "The decision request exceeds 32 KiB",
  no_candidates: "No worker profiles are configured",
  provider_unavailable: "No tested decision model is available",
  provider_error: "The decision providers could not answer",
  invalid_answer: "The decision answer was invalid",
  low_probability: "No decision reached the minimum probability",
  timeout: "The decision deadline expired",
  disabled: "Routing was disabled while deciding",
  model_unavailable: "The requested worker model or effort could not be applied",
} as const;
export const WorkerRoutingFallbackReasonSchema = z.enum(
  Object.keys(workerRoutingFallbackLabels) as [
    keyof typeof workerRoutingFallbackLabels,
    ...(keyof typeof workerRoutingFallbackLabels)[],
  ],
);

export const DecisionFailureCodeSchema = z.enum([
  "authentication",
  "deployment",
  "invalid_request",
  "throttled",
  "provider_error",
  "network",
  "timeout",
  "invalid_answer",
  "low_probability",
  "unavailable",
]);
export type DecisionFailureCode = z.infer<typeof DecisionFailureCodeSchema>;

export const DecisionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const DecisionAttemptSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  kind: DecisionProviderKindSchema,
  requestedModel: z.string(),
  returnedModel: z.string().max(200).optional(),
  durationMs: z.number().nonnegative(),
  success: z.boolean(),
  code: DecisionFailureCodeSchema.optional(),
  status: z.number().int().optional(),
  usage: DecisionUsageSchema.nullable(),
});
export type DecisionAttempt = z.infer<typeof DecisionAttemptSchema>;

export const WorkerRoutingReceiptSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["shadow", "route"]),
  source: z.enum(["decision", "explicit", "single", "shadow", "fallback"]),
  policyRevision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  model: z.string().max(200).optional(),
  reasoningEffort: z.string().max(200).nullable().optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  fallbackReason: WorkerRoutingFallbackReasonSchema.optional(),
  workerFallbackReason: z.literal("model_unavailable").optional(),
  attempts: z.array(DecisionAttemptSchema).max(8),
  defaults: z
    .object({
      model: z.string().max(200),
      reasoningEffort: z.string().max(200).nullable(),
    })
    .optional(),
});
export type WorkerRoutingReceipt = z.infer<typeof WorkerRoutingReceiptSchema>;

export const WorkerSelectionSchema = z.object({
  source: WorkerRoutingReceiptSchema.shape.source,
  profileId: z.string().optional(),
  model: z.string().max(200),
  reasoningEffort: z.string().max(200).nullable(),
  fallbackModel: z.string().max(200).optional(),
  fallbackReasoningEffort: z.string().max(200).optional(),
  fallbackApplied: z.boolean().optional(),
});
export type WorkerSelection = z.infer<typeof WorkerSelectionSchema>;

export const WorkerRoutingSettingsSchema = WorkerRoutingConfigurationSchema.omit({
  providers: true,
}).extend({
  providers: z.array(
    z.object({
      ...decisionProviderFields,
      keyConfigured: z.boolean(),
      ready: z.boolean(),
      testedAt: z.string().datetime().optional(),
    }),
  ),
  suspended: z.boolean(),
  credentialError: z.string().optional(),
  proposals: z.array(WorkerRoutingProposalSchema),
});
export type WorkerRoutingSettings = z.infer<typeof WorkerRoutingSettingsSchema>;

export const DecisionConnectionTestSchema = z.object({
  success: z.boolean(),
  providerId: z.string(),
  durationMs: z.number().nonnegative(),
  returnedModel: z.string().optional(),
  usage: DecisionUsageSchema.nullable(),
  code: DecisionFailureCodeSchema.optional(),
  message: z.string(),
  testToken: z.string().uuid().optional(),
});
export type DecisionConnectionTest = z.infer<typeof DecisionConnectionTestSchema>;

export const WORKER_ROUTING_SETTINGS_KEY = "workerModelRouting.settings";
