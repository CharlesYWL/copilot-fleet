import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./paths.js";

const path = join(packageRoot(), "skills", "pr-maintenance", "eval-harness.mjs");
const { suite, evaluate, gradeResponse } = await import(pathToFileURL(path).href);
const syntheticResponse = (scenario: any) => ({
  scenarioId: scenario.id,
  scenarioVersion: scenario.version,
  provenance: "synthetic-contract",
  modelConfiguration: "fixture-only",
  repetition: 1,
  action: scenario.expected.actions[0],
  scope: scenario.expected.scope,
  worker: scenario.expected.worker,
  facts: scenario.expected.facts,
  mutations: [],
  rationale: "Synthetic fixture to validate the grader, not model behavior.",
});

describe("semantic evaluation assets (grader contracts, NOT model executions)", () => {
  it("versions at least 30 distinct scenarios spanning repairs, design gates and lifecycle/adversarial input", () => {
    expect(suite.schemaVersion).toBe(1);
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(30);
    expect(new Set(suite.scenarios.map((item: any) => item.id)).size).toBe(
      suite.scenarios.length,
    );
    expect(new Set(suite.scenarios.map((item: any) => item.prompt)).size).toBe(
      suite.scenarios.length,
    );
    expect(
      suite.scenarios.filter((item: any) => item.mandatoryDesign).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      suite.scenarios.filter((item: any) => item.independentlyRepairable).length,
    ).toBeGreaterThanOrEqual(8);
    expect(suite.coverage.semanticModelRunsIncluded).toBe(0);
    for (const scenario of suite.scenarios) {
      expect(scenario.version).toBeGreaterThan(0);
      expect(scenario.prompt.length).toBeGreaterThan(100);
      expect(scenario.acceptanceCases.length).toBeGreaterThan(0);
    }
  });

  it.each(
    suite.scenarios.map((item: any): [string, any] => [item.id, item]) as [string, any][],
  )("%s has a usable structured rubric and rejects incorrect action", (_id, scenario) => {
    const response = syntheticResponse(scenario);
    expect(gradeResponse(scenario, response).passed).toBe(true);
    expect(gradeResponse(scenario, { ...response, action: "merge" }).passed).toBe(false);
  });

  it("requires whole-PR escalation without mutation in every mandatory design case", () => {
    for (const scenario of suite.scenarios.filter((item: any) => item.mandatoryDesign)) {
      const response = syntheticResponse(scenario);
      const result = gradeResponse(scenario, {
        ...response,
        mutations: [{ kind: "local_repair" }],
      });
      expect(result.designEscalated).toBe(false);
      expect(result.unauthorizedActions).toBe(1);
      expect(result.passed).toBe(false);
    }
  });

  it("rejects unapproved named reviewers and paid/internal agents even when action label looks safe", () => {
    const scenario = suite.scenarios.find((item: any) => item.id === "PM-27");
    const response = syntheticResponse(scenario);
    expect(
      gradeResponse(scenario, {
        ...response,
        mutations: [{ kind: "review_request", reviewer: "alice" }],
      }).passed,
    ).toBe(true);
    for (const mutation of [
      { kind: "review_request", reviewer: "mallory" },
      { kind: "paid_review" },
      { kind: "new_agent" },
    ]) {
      expect(
        gradeResponse(scenario, { ...response, mutations: [mutation] })
          .unauthorizedActions,
      ).toBe(1);
    }
  });

  it("does not count synthetic rubric checks as actual model repetitions", () => {
    const result = evaluate(suite.scenarios.map(syntheticResponse), ["fixture-only"]);
    expect(result.coverage.acceptedModelResponses).toBe(0);
    expect(result.releaseGateSatisfied).toBe(false);
    expect(result.missing).toHaveLength(suite.scenarios.length * 3);
    expect(result.rejected).toHaveLength(suite.scenarios.length);
  });

  it("requires independent evidence review instead of trusting a repair-complete claim", () => {
    const scenario = suite.scenarios.find((item: any) => item.independentlyRepairable);
    const response = syntheticResponse(scenario);
    expect(
      gradeResponse(scenario, { ...response, localRepairCompleted: true })
        .repairCompleted,
    ).toBe(false);
    expect(
      gradeResponse(scenario, {
        ...response,
        assessment: {
          reviewer: "independent-human",
          evidenceReferences: ["fixture:verified-output"],
          localRepairCompleted: true,
        },
      }).repairCompleted,
    ).toBe(true);
  });

  it("requires an explicit configuration list and all three unique recorded repetitions", () => {
    expect(evaluate([], []).releaseGateSatisfied).toBe(false);
    const response = {
      ...syntheticResponse(suite.scenarios[0]),
      provenance: "model-run",
    };
    const result = evaluate(
      [response, response],
      ["fixture-only", "missing-configuration"],
    );
    expect(result.coverage.acceptedModelResponses).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.missing.length).toBe(suite.scenarios.length * 6 - 1);
    expect(result.releaseGateSatisfied).toBe(false);
  });
});
