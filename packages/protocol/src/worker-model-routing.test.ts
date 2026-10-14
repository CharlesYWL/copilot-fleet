import { describe, expect, it } from "vitest";
import {
  DecisionProviderSchema,
  WorkerExecutionProfilesSchema,
  WorkerRoutingConfigurationSchema,
  decisionEndpoint,
} from "./worker-model-routing.js";

const profile = {
  id: "ordinary",
  name: "Ordinary",
  description: "Bounded ordinary implementation.",
  categories: ["implement"],
  model: "Provider/Exact.Model-ID",
  reasoningEffort: null,
};

describe("worker routing configuration", () => {
  it("defaults to off with no invented models or providers", () => {
    expect(WorkerRoutingConfigurationSchema.parse({})).toEqual({
      revision: 0,
      mode: "off",
      minProbability: 0.5,
      timeoutMs: 5000,
      profiles: [],
      providers: [],
    });
    expect(WorkerExecutionProfilesSchema.parse([profile])[0]?.model).toBe(
      "Provider/Exact.Model-ID",
    );
  });

  it.each(["auto", "default", "Uppercase", "a", "bad_id"])(
    "rejects invalid or reserved profile IDs: %s",
    (id) => {
      expect(WorkerExecutionProfilesSchema.safeParse([{ ...profile, id }]).success).toBe(
        false,
      );
    },
  );

  it("rejects duplicates, empty categories, incomplete pairs and unbounded policy", () => {
    for (const profiles of [
      [profile, profile],
      [{ ...profile, categories: [] }],
      [{ ...profile, reasoningEffort: "" }],
      [{ ...profile, description: "x".repeat(401) }],
      Array.from({ length: 21 }, (_, index) => ({ ...profile, id: `profile-${index}` })),
    ])
      expect(WorkerExecutionProfilesSchema.safeParse(profiles).success).toBe(false);
    expect(
      WorkerRoutingConfigurationSchema.safeParse({ minProbability: 1.01 }).success,
    ).toBe(false);
    expect(
      WorkerRoutingConfigurationSchema.safeParse({ timeoutMs: 10_001 }).success,
    ).toBe(false);
  });

  it("normalizes supported resource links once and keeps deployment spelling", () => {
    for (const host of [
      "demo.services.ai.azure.com",
      "demo.openai.azure.com",
      "demo.cognitiveservices.azure.com",
    ]) {
      const endpoint = `https://${host}/providers/microsoft/v1/systemone`;
      expect(decisionEndpoint("foundry", `https://${host}`)).toBe(endpoint);
      expect(decisionEndpoint("foundry", endpoint)).toBe(endpoint);
    }
    expect(
      DecisionProviderSchema.parse({
        id: "foundry",
        name: "Foundry",
        kind: "foundry",
        endpoint: "https://demo.services.ai.azure.com",
        model: "Exact-Deployment",
      }).model,
    ).toBe("Exact-Deployment");
    expect(decisionEndpoint("typesafe", "https://api.typesafe.ai")).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
  });

  it.each([
    "http://demo.services.ai.azure.com",
    "https://user:password@demo.services.ai.azure.com",
    "https://demo.services.ai.azure.com:444",
    "https://demo.services.ai.azure.com?key=value",
    "https://demo.services.ai.azure.com#fragment",
    "https://demo.services.ai.azure.com.evil.example",
    "https://demo.services.ai.azure.com/arbitrary-path",
    "https://localhost",
    "https://127.0.0.1",
  ])("rejects credential-bearing and unsupported endpoints: %s", (value) => {
    expect(() => decisionEndpoint("foundry", value)).toThrow();
  });
});
