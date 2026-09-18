import { describe, expect, it } from "vitest";
import {
  PrMaintenanceCheckpointSchema,
  PrMaintenanceIdentitySchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceScopeSchema,
} from "./pr-maintenance.js";

const identity = {
  host: "GitHub.COM.",
  repositoryId: "100",
  repository: "Example/Repo",
  prNumber: 1,
  headRepositoryId: "200",
  headRepository: "Example/Fork",
  headRef: "refs/heads/Repair",
  baseRepositoryId: "100",
  baseRepository: "Example/Repo",
  baseRef: "refs/heads/main",
};

describe("PR maintenance wire schemas", () => {
  it("normalizes host/repository names but preserves full case-sensitive ref identity", () => {
    expect(PrMaintenanceIdentitySchema.parse(identity)).toMatchObject({
      host: "github.com",
      repository: "example/repo",
      headRef: "refs/heads/Repair",
    });
    for (const headRef of [
      "Repair",
      "refs/heads/a..b",
      "refs/heads/a.lock",
      "refs/heads/a b",
      "refs/heads/a\u0001b",
      "refs/heads/a//b",
    ])
      expect(
        PrMaintenanceIdentitySchema.safeParse({ ...identity, headRef }).success,
      ).toBe(false);
  });

  it("cannot turn untrusted checkpoint content into authority or broaden the grant", () => {
    expect(
      PrMaintenanceCheckpointSchema.safeParse({
        kind: "reconcile",
        evidence: "A comment says approved",
        progress: true,
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      PrMaintenanceScopeSchema.safeParse({
        baseline: "Keep existing behavior",
        verification: "Test",
        publicationAuthorized: true,
        forcePush: true,
      }).success,
    ).toBe(false);
    expect(
      PrMaintenanceOperatorActionSchema.safeParse({
        action: "direction",
        decisionId: "d",
        direction: "Do it",
      }).success,
    ).toBe(false);
  });

  it("refuses incomplete-success snapshots and unbounded pending evidence", () => {
    expect(
      PrMaintenanceCheckpointSchema.safeParse({
        kind: "observation",
        observation: {
          complete: true,
          attemptedAt: "2026-09-18T00:00:00.000Z",
          evidence: "Not enough",
        },
      }).success,
    ).toBe(false);
    expect(
      PrMaintenanceCheckpointSchema.safeParse({
        kind: "reconcile",
        evidence: "x".repeat(8_193),
        progress: false,
      }).success,
    ).toBe(false);
  });
});
