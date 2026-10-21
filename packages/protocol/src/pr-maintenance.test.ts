import { describe, expect, it } from "vitest";
import {
  PR_MAINTENANCE_WAKE_LIMITS,
  PR_MAINTENANCE_RECOVERY_LIMITS,
  PrMaintenanceCheckpointSchema,
  PrMaintenanceIdentitySchema,
  PrMaintenanceOperatorActionSchema,
  PrMaintenanceScopeSchema,
  PrMaintenanceRegistrationSchema,
  PrMaintenanceObservationSchema,
  PrMaintenanceIncidentSchema,
  PrMaintenanceWakeSchema,
  PrMaintenanceBatchSchema,
  PrMaintenanceGithubSnapshotIdentitySchema,
  PrMaintenanceHelperSnapshotIdentitySchema,
  prMaintenanceObservationFresh,
  prMaintenanceReconciling,
  prMaintenanceStatus,
  prMaintenanceSources,
  prMaintenanceTaskStatuses,
  prMaintenanceWorkSources,
  PrMaintenanceTaskStatusSchema,
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
  it.each([100, 101])(
    "enforces the request boundary across observations, recovery and durable claims at %i",
    (requests) => {
      const accepted = requests === 100;
      const at = "2026-10-21T00:00:00.000Z";
      const provenance = { source: "provider", method: "read", evidenceRef: "test" };
      expect(
        PrMaintenanceObservationSchema.safeParse({
          attemptedAt: at,
          complete: false,
          requestsConsumed: requests,
          evidence: "bounded",
        }).success,
      ).toBe(accepted);
      expect(
        PrMaintenanceCheckpointSchema.safeParse({
          kind: "alternate_attempt",
          incidentId: "incident",
          resolutionId: "resolution",
          provenance,
          requests,
        }).success,
      ).toBe(accepted);
      const attempt = {
        id: "resolution",
        wakeId: "wake",
        provenance,
        requests,
        reservedAt: at,
        state: "reserved",
      };
      const attempts = PrMaintenanceIncidentSchema.shape.attempts;
      expect(attempts.safeParse([attempt]).success).toBe(accepted);
      expect(
        attempts.safeParse(Array.from({ length: 4 }, () => ({ ...attempt, requests: 1 })))
          .success,
      ).toBe(false);
      expect(
        PrMaintenanceWakeSchema.safeParse({
          leadSessionId: "lead",
          wakeId: "wake",
          startedAt: at,
          visits: 1,
          requests,
          milliseconds: 0,
          visitedIds: ["record"],
          observationClaims: [
            {
              recordId: "record",
              generation: 1,
              recordVersion: 1,
              scopeKey: "a".repeat(64),
              claimedAt: at,
              deadlineAt: at,
              requests,
            },
          ],
        }).success,
      ).toBe(accepted);
      expect(PR_MAINTENANCE_WAKE_LIMITS).toEqual({
        visits: 5,
        requests: 100,
        milliseconds: 300_000,
      });
      expect(PR_MAINTENANCE_RECOVERY_LIMITS.attempts).toBe(3);
    },
  );

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

  describe("one effective state from durable facts", () => {
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
    const common = {
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
    };
    const v1 = (overrides: Record<string, unknown> = {}) =>
      PrMaintenanceRegistrationSchema.parse({
        schemaVersion: 1,
        lifecycle: "active",
        ...common,
        ...overrides,
      });
    const base = () =>
      PrMaintenanceRegistrationSchema.parse({
        schemaVersion: 2,
        lifecycle: "active",
        ...common,
      });
    const batch = (state: string, extra: Record<string, unknown> = {}) =>
      PrMaintenanceBatchSchema.parse({
        id: `batch-${state}`,
        kind: "repair",
        sources: [source],
        headSha,
        prompt: "Fix it",
        scope: "Same contract",
        reservedMutations: 1,
        generation: 1,
        authorizationId: "authorization",
        state,
        createdAt: at,
        updatedAt: at,
        ...extra,
      });

    it("migrates old observations without requiring or fabricating a draft flag", () => {
      expect(observation.draft).toBeUndefined();
      expect(base().observation?.draft).toBeUndefined();
    });

    it("upgrades a v1 task_human_hold record to an explicit hold that one Resume clears", () => {
      const upgraded = v1({
        lifecycle: "paused",
        pauseReason: "task_human_hold",
        pausedAt: at,
        pauseOrigin: { actor: "system", actorId: "host", at },
      });
      expect(upgraded.schemaVersion).toBe(2);
      expect(upgraded.lifecycle).toBe("active");
      expect(upgraded.hold).toMatchObject({ kind: "paused", reason: "task_human_hold" });
      expect(prMaintenanceStatus(upgraded)).toMatchObject({
        phase: "idle",
        hold: "paused",
        operatorAction: "resume",
      });
      expect(upgraded.legacyAudit).toMatchObject({ pauseReason: "task_human_hold" });
      // Re-parsing the stored v2 shape is stable.
      expect(PrMaintenanceRegistrationSchema.parse(upgraded)).toEqual(upgraded);
    });

    it("maps v1 pause reasons to the matching hold and moves continuations to audit", () => {
      expect(v1({ lifecycle: "paused", pauseReason: "stopped" }).hold?.kind).toBe(
        "stopped",
      );
      expect(
        v1({ lifecycle: "paused", pauseReason: "authorization_failed" }).hold?.kind,
      ).toBe("access");
      expect(
        v1({ lifecycle: "paused", pauseReason: "remote_identity_changed" }).hold?.kind,
      ).toBe("identity");
      expect(v1({ lifecycle: "paused", pauseReason: "manual_control" }).hold?.kind).toBe(
        "manual_control",
      );
      const continued = v1({
        continuation: {
          id: "c",
          operatorId: "operator",
          requestedAt: at,
          expectedVersion: 1,
          authorityHash: "h",
          headSha,
          evidenceState: "refresh_required",
          state: "checking",
        },
      });
      expect(continued.hold).toBeUndefined();
      expect(continued).not.toHaveProperty("continuation");
      expect(continued.legacyAudit?.continuation).toMatchObject({
        evidenceState: "refresh_required",
      });
    });

    it("upgrades a pending human decision without adding a second hold", () => {
      const decided = v1({
        lifecycle: "paused",
        pauseReason: "wait_for_human",
        decision: {
          id: "d",
          version: 1,
          proposal: "Keep or change the API?",
          headSha,
          scope: "Same contract",
        },
      });
      expect(decided.hold).toBeUndefined();
      expect(prMaintenanceStatus(decided)).toMatchObject({
        phase: "waiting_for_decision",
        label: "Waiting for Design Decision",
        operatorAction: "direction",
      });
    });

    it("derives exactly one phase: Reviewing, Working, Idle, Waiting, Merged/Closed", () => {
      const idle = base();
      expect(prMaintenanceStatus(idle)).toMatchObject({
        phase: "idle",
        label: "Idle",
        operatorAction: "review",
      });
      const reviewing = {
        ...base(),
        review: { id: "r", source: "manual" as const, requestedAt: at },
      };
      expect(prMaintenanceStatus(reviewing).label).toBe("Reviewing");
      const working = {
        ...base(),
        batches: [batch("accepted", { stepId: "step", attempt: 1 })],
      };
      expect(prMaintenanceStatus(working).label).toBe("Working");
      expect(prMaintenanceStatus({ ...base(), lifecycle: "merged" }).label).toBe(
        "Merged",
      );
      expect(prMaintenanceStatus({ ...base(), lifecycle: "closed" }).label).toBe(
        "Closed",
      );
      expect(prMaintenanceStatus({ ...base(), ownershipReleasedAt: at }).phase).toBe(
        "released",
      );
    });

    it("reports holds beside the phase and only Host overlays can add binding/permission", () => {
      const held = {
        ...base(),
        hold: {
          kind: "access" as const,
          reason: "Provider denied",
          actor: "system" as const,
          actorId: "host",
          at,
        },
      };
      expect(prMaintenanceStatus(held)).toMatchObject({
        phase: "idle",
        hold: "access",
        label: "Idle · Access needed",
      });
      expect(prMaintenanceStatus(base(), { binding: "binding_changed" }).hold).toBe(
        "binding",
      );
      expect(prMaintenanceStatus(base(), { permission: true }).hold).toBe("permission");
      const uncertain = { ...base(), batches: [batch("uncertain", { stepId: "s" })] };
      expect(prMaintenanceStatus(uncertain).hold).toBe("reconciling");
      expect(prMaintenanceReconciling(uncertain)).toBe(true);
    });

    it("never derives a hold from stale evidence or the underlying task's state", () => {
      const stale = {
        ...base(),
        observation: { ...observation, attemptedAt: "2020-01-01T00:00:00.000Z" },
      };
      const status = prMaintenanceStatus(stale);
      expect(status.hold).toBeUndefined();
      expect(status.phase).toBe("idle");
    });

    it("keeps authenticated pending work separate from provider-authored claims", () => {
      const record = PrMaintenanceRegistrationSchema.parse({
        ...base(),
        observation: {
          ...observation,
          sources: [{ ...source, id: "operator-work:spoofed" }],
        },
        workRequests: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            operatorId: "operator",
            direction: "Regenerate the API report",
            createdAt: at,
            state: "pending",
          },
        ],
      });
      expect(prMaintenanceWorkSources(record)).toEqual([
        {
          id: "operator-work:11111111-1111-4111-8111-111111111111",
          revision: "11111111-1111-4111-8111-111111111111",
          groupKey: "operator-work:11111111-1111-4111-8111-111111111111",
          evidence: "Regenerate the API report",
        },
      ]);
      expect(prMaintenanceSources(record).map((entry) => entry.id)).toEqual([
        "operator-work:11111111-1111-4111-8111-111111111111",
      ]);
    });

    it("summarizes retained work for task lists with the same status", () => {
      const released = { ...base(), id: "old", ownershipReleasedAt: at };
      const current = {
        ...base(),
        id: "new",
        createdAt: "2026-09-19T00:00:00.000Z",
      };
      const [status] = prMaintenanceTaskStatuses([released, current]);
      expect(PrMaintenanceTaskStatusSchema.parse(status)).toEqual(status);
      expect(status).toMatchObject({ recordId: "new", status: { phase: "idle" } });
      expect(prMaintenanceTaskStatuses([released], () => ({}))[0]?.status.phase).toBe(
        "released",
      );
    });

    it("judges observation freshness only as evidence age, never as admission", () => {
      expect(prMaintenanceObservationFresh(observation, Date.parse(at) + 1_000)).toBe(
        true,
      );
      expect(
        prMaintenanceObservationFresh(observation, Date.parse(at) + 31 * 60 * 1_000),
      ).toBe(false);
    });

    it("accepts review_done and the new operator actions, but not removed ones", () => {
      expect(
        PrMaintenanceCheckpointSchema.safeParse({
          kind: "review_done",
          summary: "Waiting for required checks.",
        }).success,
      ).toBe(true);
      expect(
        PrMaintenanceOperatorActionSchema.safeParse({
          action: "review",
          requestId: "11111111-1111-4111-8111-111111111111",
        }).success,
      ).toBe(true);
      expect(
        PrMaintenanceOperatorActionSchema.safeParse({
          action: "direction",
          decisionId: "d",
          decisionVersion: 1,
          direction: "Keep the current API.",
        }).success,
      ).toBe(true);
      expect(
        PrMaintenanceOperatorActionSchema.safeParse({ action: "renew" }).success,
      ).toBe(false);
      expect(
        PrMaintenanceOperatorActionSchema.safeParse({
          action: "direction",
          decisionId: "d",
          decisionVersion: 1,
          direction: "x",
          continueEligible: true,
        }).success,
      ).toBe(false);
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
