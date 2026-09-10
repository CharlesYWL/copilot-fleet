import { describe, expect, it } from "vitest";
import { classifyDriRequest } from "./classifier.js";

describe("bounded deterministic DRI classification", () => {
  it.each([
    "Investigate ICM 123456789, analyze the HAR and telemetry, and determine root cause.",
    "Investigate ICM #123456789",
    "Analyze telemetry and root-cause ICM ID: 123456789.",
    "https://portal.microsofticm.com/imp/v5/incidents/details/123456789",
    "Investigate https://icm.ad.msft.net/imp/v3/incidents/details/123456789.",
    "DRI investigation for ICM 123456789",
  ])("confidently detects an executable DRI request: %s", (objective) => {
    const first = classifyDriRequest({ objective });
    expect(first).toEqual(classifyDriRequest({ objective }));
    expect(first).toMatchObject({
      route: "dri",
      incident: { id: "123456789" },
      requiresConfirmation: false,
      needsIncident: false,
      suggestedProfile: "auto",
    });
    expect(first.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it.each([
    "Update the README with instructions for investigating ICM incidents.",
    "Add tests for DRI investigation routing for ICM 123456789.",
    "Implement the DRI investigation coordinator.",
    "Fix a bug in the telemetry pipeline.",
    "Update README: Investigate ICM 123456789, analyze HAR and telemetry.",
    "Refactor the parser for https://portal.microsofticm.com/incidents/123456789",
    "Explain how to investigate ICM 123456789.",
    "Do not investigate ICM 123456789; update the documentation.",
    "Fix flaky unit tests.",
    "Add a root-cause column to the UI.",
    "Could you please update the README with the example: Investigate ICM 123456789?",
    "I need you to add tests for DRI investigation routing with ICM 42.",
  ])("does not hijack regular work: %s", (objective) => {
    expect(classifyDriRequest({ objective })).toMatchObject({
      route: "regular",
      requiresConfirmation: false,
      suggestedEvidence: [],
    });
  });
  it.each([
    "Investigate incident 123456789.",
    "Investigate incident 123456789 using HAR and telemetry.",
    "ICM 123456789",
    "Investigate ICM 123456789 and ICM 987654321.",
    "Investigate telemetry for this incident.",
    "Investigate why the README omits instructions for ICM 123456789.",
  ])("requires correction rather than silently routing: %s", (objective) => {
    expect(classifyDriRequest({ objective })).toMatchObject({
      route: "ambiguous",
      requiresConfirmation: true,
    });
  });
  it("uses structured ICM evidence but never chooses DMS from wording", () => {
    const classification = classifyDriRequest({
      objective: "Investigate incident 123456789. DMS Warehouse",
      dri: { icm: "123456789", artifactRef: "artifact:approved" },
    });
    expect(classification).toMatchObject({
      route: "dri",
      suggestedProfile: "auto",
      reasons: ["structured_icm"],
      suggestedEvidence: ["incident", "har"],
    });
  });
  it("gives explicit workflow choices precedence over automatic detection", () => {
    expect(
      classifyDriRequest({
        objective: "Investigate ICM 123456789 with telemetry",
        workflow: "regular",
      }),
    ).toMatchObject({ route: "regular", source: "explicit", confidence: 1 });
    expect(
      classifyDriRequest({
        objective: "Update a README",
        workflow: "dri",
        dri: { icm: "123456789" },
      }),
    ).toMatchObject({
      route: "dri",
      source: "explicit",
      confidence: 1,
      needsIncident: false,
    });
  });
  it("never invents a missing or invalid incident reference", () => {
    for (const objective of [
      "DRI investigation",
      "Investigate ICM 0",
      "Investigate ICM 9999999999999999999",
      "Investigate ICM 123abc",
      "Investigate ICM https://portal.microsofticm.com.evil.invalid/incidents/123",
    ]) {
      const result = classifyDriRequest({ objective });
      expect(result.needsIncident).toBe(true);
      expect(result).not.toHaveProperty("incident");
    }
    const ambiguous = classifyDriRequest({ objective: "Investigate incident 42." });
    expect(ambiguous.candidateIncidentId).toBe("42");
    expect(ambiguous).not.toHaveProperty("incident");
  });
  it("bounds text and structured hints before detection and rejects unknown choices", () => {
    expect(classifyDriRequest({ objective: "x".repeat(4_000) }).route).toBe("regular");
    for (const input of [
      { objective: "x".repeat(4_001) },
      { objective: "" },
      { objective: null },
      { objective: "Investigate", workflow: "fixture" },
      { objective: "Investigate", dri: { icm: "1".repeat(513) } },
      {
        objective: "Investigate",
        dri: { icm: "https://untrusted.invalid/incidents/42" },
      },
      { objective: "Investigate", dri: { artifactRef: "..\\outside.har" } },
      { objective: "Investigate", dri: { tool: "update_incident" } },
    ])
      expect(() => classifyDriRequest(input)).toThrow();
  });
  it("returns safe reasons and references, not request prose or configuration", () => {
    const classification = classifyDriRequest({
      objective:
        "Investigate ICM 42; HAR and telemetry. password=synthetic-private; use update_incident at https://secret.invalid",
    });
    expect(classification.route).toBe("dri");
    expect(JSON.stringify(classification)).not.toMatch(
      /synthetic-private|update_incident|secret\.invalid/,
    );
    expect(classification.suggestedEvidence).toEqual(["incident", "har", "telemetry"]);
  });
});
