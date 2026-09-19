import { describe, expect, it } from "vitest";
import {
  PrMaintenanceCheckpointSchema,
  PrMaintenanceIdentitySchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceScopeSchema,
  parsePrMaintenanceUrl,
  prMaintenanceProviderKey,
  prMaintenanceUrl,
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
  const ado = {
    provider: "azure-devops",
    host: "dev.azure.com",
    organization: "Sample-Org",
    project: "Sample Project",
    projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    repository: "Sample Project/Repo Name",
    prNumber: 42,
    headRepositoryId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    headRepository: "Sample Project/Fork",
    headRef: "refs/heads/Fix",
    baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    baseRepository: "Sample Project/Repo Name",
    baseRef: "refs/heads/main",
  };

  it("retains v1 GitHub identity and separates ADO organization scope", () => {
    const legacy = PrMaintenanceIdentitySchema.parse(identity);
    expect(legacy).not.toHaveProperty("provider");
    expect(prMaintenanceProviderKey(legacy)).toBe("github.com");
    expect(prMaintenanceUrl(legacy)).toBe("https://github.com/example/repo/pull/1");
    const parsed = PrMaintenanceIdentitySchema.parse(ado);
    expect(parsed).toMatchObject({
      organization: "sample-org",
      headRef: "refs/heads/Fix",
    });
    expect(prMaintenanceProviderKey(parsed)).toBe(
      "azure-devops:dev.azure.com/sample-org",
    );
    expect(prMaintenanceUrl(parsed)).toBe(
      "https://dev.azure.com/sample-org/Sample%20Project/_git/Repo%20Name/pullrequest/42",
    );
    for (const change of [
      { provider: undefined },
      { repositoryId: "R_GITHUB" },
      { projectId: undefined },
      { host: "sample-org.visualstudio.com" },
      { headRepository: "Other/Fork" },
      { baseRepositoryId: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
    ])
      expect(PrMaintenanceIdentitySchema.safeParse({ ...ado, ...change }).success).toBe(
        false,
      );
    expect(
      PrMaintenanceIdentitySchema.safeParse({ ...identity, host: "dev.azure.com" })
        .success,
    ).toBe(false);
  });

  it.each([
    "https://dev.azure.com/Sample-Org/Sample%20Project/_git/Repo%20Name/pullrequest/42",
    "https://sample-org.visualstudio.com/Sample%20Project/_git/Repo%20Name/pullrequest/42/",
    "https://sample-org.visualstudio.com/DefaultCollection/Sample%20Project/_git/Repo%20Name/pullrequest/42",
  ])("normalizes ADO discovery URL %s without inventing stable IDs", (url) => {
    expect(parsePrMaintenanceUrl(url)).toEqual({
      provider: "azure-devops",
      host: "dev.azure.com",
      organization: "sample-org",
      project: "Sample Project",
      repo: "Repo Name",
      number: 42,
      url: "https://dev.azure.com/sample-org/Sample%20Project/_git/Repo%20Name/pullrequest/42",
    });
  });

  it("retains explicit GitHub and enterprise URL discovery", () => {
    expect(
      parsePrMaintenanceUrl("https://github.example.com/Owner/Repo/pull/17"),
    ).toEqual({
      provider: "github",
      host: "github.example.com",
      owner: "owner",
      repo: "repo",
      number: 17,
      url: "https://github.example.com/owner/repo/pull/17",
    });
  });

  it.each([
    "http://dev.azure.com/org/project/_git/repo/pullrequest/1",
    "https://user:secret@dev.azure.com/org/project/_git/repo/pullrequest/1",
    "https://dev.azure.com:8080/org/project/_git/repo/pullrequest/1",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/1?x=y",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/1#discussion",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/0",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/2147483648",
    "https://dev.azure.com/org/project/_git/%2Fother/pullrequest/1",
    "https://dev.azure.com/org/project/_git/%2e%2e/pullrequest/1",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/1/extra",
    "https://nested.org.visualstudio.com/project/_git/repo/pullrequest/1",
    "https://github.com/owner/repo/issues/1",
  ])("rejects ambiguous discovery URL %s", (url) => {
    expect(() => parsePrMaintenanceUrl(url)).toThrow();
  });

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
