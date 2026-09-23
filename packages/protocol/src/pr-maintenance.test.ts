import { describe, expect, it } from "vitest";
import {
  PrMaintenanceCheckpointSchema,
  PrMaintenanceIdentitySchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceScopeSchema,
  PrMaintenanceRegistrationSchema,
  PrMaintenanceObservationSchema,
  PrMaintenanceGithubSnapshotIdentitySchema,
  PrMaintenanceHelperSnapshotIdentitySchema,
  prMaintenanceProgress,
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
  });

  it("normalizes only the strict native GitHub helper identity, not the shared service identity contract", () => {
    const canonical = PrMaintenanceIdentitySchema.parse(identity);
    const { prNumber, ...pins } = canonical;
    const native = {
      ...pins,
      number: prNumber,
      prId: "PR_1",
      url: prMaintenanceUrl(canonical),
    };
    expect(PrMaintenanceGithubSnapshotIdentitySchema.parse(native)).toEqual(canonical);
    expect(
      PrMaintenanceHelperSnapshotIdentitySchema.parse({ ...native, provider: "github" }),
    ).toEqual({ ...canonical, provider: "github" });
    expect(PrMaintenanceHelperSnapshotIdentitySchema.parse(ado)).toEqual(
      PrMaintenanceIdentitySchema.parse(ado),
    );
    expect(PrMaintenanceIdentitySchema.safeParse(native).success).toBe(false);
    expect(PrMaintenanceHelperSnapshotIdentitySchema.safeParse(canonical).success).toBe(
      false,
    );
    for (const patch of [
      { provider: "azure-devops" },
      { prNumber },
      { extra: "untrusted" },
      { prId: "" },
      { url: `${native.url}?claim=approved` },
      { url: `${native.url}1` },
      { number: 2 },
      { host: "example.invalid" },
      { repository: "other/repo" },
    ])
      expect(
        PrMaintenanceHelperSnapshotIdentitySchema.safeParse({ ...native, ...patch })
          .success,
      ).toBe(false);
  });

  describe("maintenance progress from durable facts", () => {
    const at = "2026-09-18T00:00:00.000Z";
    const headSha = "a".repeat(40);
    const source = {
      id: "thread",
      revision: "1",
      groupKey: "finding",
      evidence: "review thread",
    };
    const observation = PrMaintenanceObservationSchema.parse({
      attemptedAt: at,
      complete: true,
      identity,
      snapshotId: "snapshot",
      headSha,
      state: "open",
      fingerprint: "ready-fingerprint",
      mergeability: "mergeable",
      checksComplete: true,
      reviewsComplete: true,
      evidence: "Full current-HEAD observation.",
    });
    const base = () =>
      PrMaintenanceRegistrationSchema.parse({
        schemaVersion: 1,
        id: "job",
        version: 1,
        generation: 1,
        identity,
        leadSessionId: "lead",
        taskId: "task",
        workerSessionId: "worker",
        placementId: "placement",
        checkoutKey: "checkout",
        bindingGeneration: 0,
        eligibilityEvidence: "Authenticated grant.",
        lifecycle: "active",
        renewedAt: at,
        nextCheckAt: at,
        createdAt: at,
        updatedAt: at,
        authorization: {
          id: "authorization",
          operatorId: "operator",
          issuedAt: at,
          headSha,
          scope: {
            baseline: "Same contract",
            verification: "Tests",
            publicationAuthorized: true,
          },
          budgets: {},
        },
        counters: {},
        observation: structuredClone(observation),
        lastAttempt: structuredClone(observation),
      });

    it("migrates old observations without requiring or fabricating a draft flag", () => {
      expect(observation.draft).toBeUndefined();
      expect(base().incidents).toEqual([]);
      expect(base().incidentCursor).toBe(0);
      expect(
        PrMaintenanceObservationSchema.parse({ ...observation, draft: true }).draft,
      ).toBe(true);
    });

    it("preserves optional grant-bound prerequisites without manufacturing legacy evidence", () => {
      const legacy = base();
      expect(legacy.authorization.eligibilityEvidence).toBeUndefined();
      expect(legacy.authorization.sourceProposal).toBeUndefined();
      const record = PrMaintenanceRegistrationSchema.parse({
        ...legacy,
        authorization: {
          ...legacy.authorization,
          eligibilityEvidence: "Fresh metadata and publication evidence",
          sourceProposal: { id: "reviewed-proposal", version: 2 },
        },
        authorizationHistory: [legacy.authorization],
      });
      expect(record.authorization.eligibilityEvidence).toBe(
        "Fresh metadata and publication evidence",
      );
      expect(record.authorization.sourceProposal).toEqual({
        id: "reviewed-proposal",
        version: 2,
      });
      expect(record.authorizationHistory[0]).toEqual(legacy.authorization);
      for (const invalid of [
        { eligibilityEvidence: "x".repeat(8193) },
        { sourceProposal: { id: "proposal", version: 0 } },
        { sourceProposal: { id: "proposal", version: 1, operatorId: "forged" } },
      ])
        expect(
          PrMaintenanceRegistrationSchema.safeParse({
            ...record,
            authorization: { ...record.authorization, ...invalid },
          }).success,
        ).toBe(false);
      expect(
        PrMaintenanceRegistrationSchema.safeParse({
          ...record,
          authorizationHistory: Array(101).fill(record.authorization),
        }).success,
      ).toBe(false);
    });

    it.each([-60_000, 60_000])(
      "uses the proven Host freshness basis without rewriting Node evidence (%d)",
      (offset) => {
        const record = base();
        const now = Date.parse(at);
        record.observation!.attemptedAt = new Date(now + offset).toISOString();
        record.observationHostAt = at;
        record.readyFingerprint = observation.fingerprint;
        expect(prMaintenanceProgress(record, now).stage).toBe("ready");
        expect(prMaintenanceProgress(record, now + 30 * 60_000 + 1).stage).toBe(
          "checking",
        );
        expect(record.observation!.attemptedAt).toBe(
          new Date(now + offset).toISOString(),
        );
      },
    );

    it("provides exactly one truthful current stage with freshness and readiness gates", () => {
      const record = base();
      const now = Date.parse(at);
      expect(prMaintenanceProgress(record, now)).toEqual({
        stage: "checking",
        completedIterations: 0,
      });
      record.readyFingerprint = observation.fingerprint;
      expect(prMaintenanceProgress(record, now).stage).toBe("ready");
      expect(prMaintenanceProgress(record, now + 30 * 60_000 + 1).stage).toBe("checking");
      expect(prMaintenanceProgress(record, now - 1).stage).toBe("checking");
      record.observation!.checksComplete = false;
      expect(prMaintenanceProgress(record, now).stage).toBe("waiting_checks");
      record.observation!.checksComplete = true;
      record.observation!.reviewsComplete = false;
      expect(prMaintenanceProgress(record, now).stage).toBe("waiting_review");
      record.observation!.sources = [source];
      expect(prMaintenanceProgress(record, now).stage).toBe("triage");
      record.observation!.draft = true;
      expect(prMaintenanceProgress(record, now).stage).toBe("blocked");
      record.lifecycle = "paused";
      expect(prMaintenanceProgress(record, now).stage).toBe("paused");
      record.pauseReason = "authorization_failed";
      expect(prMaintenanceProgress(record, now).stage).toBe("blocked");
      record.pauseReason = "task_human_hold";
      expect(prMaintenanceProgress(record, now).stage).toBe("human_hold");
      record.pauseReason = "";
      record.decision = {
        id: "decision",
        version: 1,
        proposal: "Design change?",
        scope: "API",
        headSha,
        state: "pending",
      };
      expect(prMaintenanceProgress(record, now).stage).toBe("human_hold");
      delete record.decision;
      record.ownershipReleasedAt = at;
      expect(prMaintenanceProgress(record, now).stage).toBe("released");
      record.lifecycle = "merged";
      expect(prMaintenanceProgress(record, now).stage).toBe("merged");
    });

    it.each(["headSha", "snapshotId", "failure"] as const)(
      "never displays historical readiness when lastAttempt has inconsistent %s",
      (field) => {
        const record = base();
        record.readyFingerprint = record.observation!.fingerprint;
        if (field === "failure") record.lastAttempt!.failure = "network";
        else record.lastAttempt![field] = "b".repeat(40);
        expect(prMaintenanceProgress(record, Date.parse(at)).stage).toBe("blocked");
      },
    );

    it("counts distinct settled execution attempts rather than reservations or provider iterations", () => {
      const record = base();
      const batch = {
        id: "batch",
        kind: "repair" as const,
        sources: [source],
        headSha,
        prompt: "Bounded repair",
        scope: "Same contract",
        reservedMutations: 3,
        generation: 1,
        authorizationId: "authorization",
        state: "succeeded" as const,
        findings: [],
        effects: [],
        stepId: "step",
        attempt: 2,
        executionSettled: true,
        published: false,
        createdAt: at,
        updatedAt: at,
      };
      record.counters.repairBatches = 20;
      record.counters.answerBatches = 10;
      record.batches = [
        batch,
        { ...batch, id: "same-attempt" },
        { ...batch, id: "failed", attempt: 3, state: "failed" },
        { ...batch, id: "pending-reconciliation", attempt: 4, state: "reconciling" },
        {
          ...batch,
          id: "prepared",
          stepId: undefined,
          attempt: undefined,
          state: "cancelled",
        },
        {
          ...batch,
          id: "cancelled-before-send",
          attempt: 5,
          state: "cancelled",
          executionNotDispatched: true,
        },
        {
          ...batch,
          id: "unknown",
          attempt: 6,
          executionSettled: false,
          state: "uncertain",
        },
      ];
      expect(prMaintenanceProgress(record, Date.parse(at))).toEqual({
        stage: "reconciling",
        completedIterations: 2,
      });
      record.lifecycle = "paused";
      expect(prMaintenanceProgress(record, Date.parse(at)).stage).toBe("reconciling");
      record.lifecycle = "active";
      record.readyFingerprint = record.observation!.fingerprint;
      record.batches = [{ ...batch, state: "failed", executionSettled: false }];
      expect(prMaintenanceProgress(record, Date.parse(at))).toEqual({
        stage: "reconciling",
        completedIterations: 0,
      });
      record.batches = [
        {
          ...batch,
          state: "prepared",
          stepId: undefined,
          attempt: undefined,
          executionSettled: false,
        },
      ];
      expect(prMaintenanceProgress(record, Date.parse(at))).toEqual({
        stage: "checking",
        completedIterations: 0,
      });
    });

    it("requires bounded provenance and rejects a model-supplied wake or fake fallback success", () => {
      const attempt = {
        kind: "alternate_attempt",
        incidentId: "incident",
        resolutionId: "attempt",
        provenance: {
          source: "github.com",
          method: "provider API",
          evidenceRef: "https://github.com/example/repo/pull/1",
        },
        requests: 2,
      };
      expect(PrMaintenanceCheckpointSchema.safeParse(attempt).success).toBe(true);
      expect(
        PrMaintenanceCheckpointSchema.safeParse({ ...attempt, wakeId: "reset" }).success,
      ).toBe(false);
      expect(
        PrMaintenanceCheckpointSchema.safeParse({
          ...attempt,
          provenance: { source: "github.com" },
        }).success,
      ).toBe(false);
      expect(
        PrMaintenanceCheckpointSchema.safeParse({
          kind: "fallback",
          error: "failure",
          observation,
        }).success,
      ).toBe(false);
      expect(
        PrMaintenanceObservationSchema.safeParse({
          ...observation,
          helperState: {
            error: { code: "auth_required", message: "Provider denied access." },
          },
        }).success,
      ).toBe(false);
    });
  });

  it("validates provider keys, repository URLs and identity constraints", () => {
    const parsed = PrMaintenanceIdentitySchema.parse(ado);
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

  it("requires explicit repair scope and leaves optional provider actions off", () => {
    const scope = { baseline: "Observe only.", verification: "Read existing evidence." };
    const repair = {
      publicationAuthorized: true,
      replies: false,
      resolveThreads: false,
      reviewers: [],
      retryChecks: false,
    };
    expect(PrMaintenanceScopeSchema.safeParse(scope).success).toBe(false);
    expect(
      PrMaintenanceScopeSchema.safeParse({ ...scope, publicationAuthorized: false })
        .success,
    ).toBe(false);
    expect(
      PrMaintenanceScopeSchema.parse({ ...scope, publicationAuthorized: true }),
    ).toMatchObject(repair);
  });

  it.each([
    { replies: true },
    { resolveThreads: true },
    { reviewers: ["reviewer"] },
    { retryChecks: true },
  ])(
    "rejects provider mutation flags %j without an explicit publication grant",
    (flags) => {
      const scope = {
        baseline: "Observe only.",
        verification: "Read provider evidence.",
        ...flags,
      };
      expect(PrMaintenanceScopeSchema.safeParse(scope).success).toBe(false);
      expect(
        PrMaintenanceScopeSchema.safeParse({ ...scope, publicationAuthorized: false })
          .success,
      ).toBe(false);
      expect(
        PrMaintenanceScopeSchema.safeParse({ ...scope, publicationAuthorized: true })
          .success,
      ).toBe(true);
    },
  );

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
