import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PrMaintenanceObservationSchema } from "@fleet/protocol";
import { packageRoot } from "./paths.js";

const assets = join(packageRoot(), "skills", "pr-maintenance");
const { toHostObservation } = await import(
  pathToFileURL(join(assets, "host-observation.mjs")).href
);
const sha = "a".repeat(40);
const snapshot = () => ({
  identity: {
    host: "github.com",
    repositoryId: "R_Base",
    repository: "org/repo",
    number: 7,
    url: "https://github.com/org/repo/pull/7",
    headRepositoryId: "R_Fork",
    headRepository: "owner/repo",
    headRef: "refs/heads/Fix",
    baseRepositoryId: "R_Base",
    baseRepository: "org/repo",
    baseRef: "refs/heads/main",
  },
  headSha: sha,
  baseSha: "b".repeat(40),
  state: "open",
  mergeable: "MERGEABLE",
  actionableFingerprint: "fingerprint",
  threadStates: [],
  threads: [],
  rules: [],
  reviewPolicy: { branchProtection: null, rules: [] },
  reviewDecision: "UNKNOWN",
  requiredChecks: [],
  actionableSources: [],
  effects: { matched: [], ambiguous: [] },
  obligationKeys: { checks: [], review: "review-revision" },
});
const complete = (value: unknown = snapshot()) => ({
  complete: true,
  requestsConsumed: 17,
  elapsedMs: 401,
  progress: { phase: "complete", pages: 7, verifiedPages: 7, cursor: null },
  snapshot: value,
});

describe("GitHub helper to durable Host observation", () => {
  it("preserves opaque GitHub IDs and explicit absence of required gates", () => {
    const observation = PrMaintenanceObservationSchema.parse(
      toHostObservation(complete(), {}),
    );
    expect(observation).toMatchObject({
      complete: true,
      requestsConsumed: 17,
      elapsedMs: 401,
      identity: {
        repositoryId: "R_Base",
        headRepositoryId: "R_Fork",
        headRef: "refs/heads/Fix",
      },
      checksComplete: true,
      reviewsComplete: true,
      checks: [],
      reviews: [],
    });
  });

  it("persists a partial scan larger than the old 4 KiB cursor limit", () => {
    const resume = { data: "x".repeat(30_000), digest: "opaque" };
    const observation = PrMaintenanceObservationSchema.parse(
      toHostObservation(
        {
          complete: false,
          requestsConsumed: 8,
          elapsedMs: 500,
          progress: { phase: "collect", pages: 6, verifiedPages: 0, cursor: "page-7" },
          error: { code: "budget_exhausted", message: "Carry the scan." },
          resume,
        },
        { previousThreads: [{ id: "thread", revision: 2, stateHash: "state" }] },
      ),
    );
    expect(observation.failure).toBe("budget");
    expect(observation.helperState).toEqual({
      resume,
      previousThreads: [{ id: "thread", revision: 2, stateHash: "state" }],
    });
    expect(observation.complete).toBe(false);
  });

  it.each([
    ["auth_required", "auth"],
    ["permission_denied", "permission"],
    ["rate_limited", "rate_limit"],
  ])("classifies %s without consuming a complete observation", (code, expected) => {
    const observation = toHostObservation(
      {
        complete: false,
        requestsConsumed: 1,
        elapsedMs: 3,
        progress: { phase: "read" },
        error: { code, message: "Read refused.", retryAfterSeconds: 60 },
      },
      {},
      "2026-09-18T00:00:00.000Z",
    );
    expect(observation).toMatchObject({
      complete: false,
      failure: expected,
      requestsConsumed: 1,
      retryAfter: "2026-09-18T00:01:00.000Z",
    });
  });

  it("turns CI failure without comments into stable repairable source revisions", () => {
    const value = {
      ...snapshot(),
      requiredChecks: [
        {
          name: "tests",
          appId: null,
          states: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        },
      ],
      obligationKeys: {
        checks: [{ name: "tests", appId: null, key: "failure-incident" }],
        review: "review-revision",
      },
    };
    const observation = toHostObservation(complete(value), {});
    expect(observation.checks[0].state).toBe("failed");
    expect(observation.sources).toEqual([
      {
        id: "check:tests:*",
        revision: "failure-incident",
        groupKey: "check:tests:*",
        evidence: expect.stringContaining("FAILURE"),
      },
    ]);
  });

  it("uses the effective review decision rather than replaying historical reviews", () => {
    const value = {
      ...snapshot(),
      reviewDecision: "APPROVED",
      reviewPolicy: { branchProtection: { requiresApprovingReviews: true }, rules: [] },
    };
    expect(toHostObservation(complete(value), {}).reviews).toEqual([
      expect.objectContaining({ state: "approved", headSha: sha }),
    ]);
  });

  it("does not manufacture readiness for an unevaluated branch rule", () => {
    const value = { ...snapshot(), rules: [{ type: "required_deployments" }] };
    expect(toHostObservation(complete(value), {})).toMatchObject({
      complete: false,
      failure: "incomplete",
    });
  });

  it("retains classic conversation-resolution obligations after comments were handled", () => {
    const value = {
      ...snapshot(),
      reviewDecision: "APPROVED",
      reviewPolicy: {
        branchProtection: { requiresConversationResolution: true },
        rules: [],
      },
      threads: [{ id: "thread-1", isResolved: false }],
    };
    expect(toHostObservation(complete(value), {}).reviews).toContainEqual(
      expect.objectContaining({ key: "thread-resolution:thread-1", state: "required" }),
    );
  });

  it("prints a protocol-valid incomplete checkpoint when the CLI has no request allowance", () => {
    const result = spawnSync(process.execPath, [join(assets, "github-snapshot.mjs")], {
      input: JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        pr: { host: "github.com", owner: "org", repo: "repo", number: 7 },
        budget: {
          maxRequests: 0,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        },
      }),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(PrMaintenanceObservationSchema.parse(output.observation)).toMatchObject({
      complete: false,
      failure: "budget",
      requestsConsumed: 0,
    });
    expect(output.snapshot).toBeUndefined();
  });
});
