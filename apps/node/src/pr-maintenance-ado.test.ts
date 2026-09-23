import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PrMaintenanceObservationSchema } from "@fleet/protocol";
import { packageRoot } from "./paths.js";

const helper = join(packageRoot(), "skills", "pr-maintenance", "ado-snapshot.mjs");
const { observe: routeObservation } = await import(
  pathToFileURL(join(packageRoot(), "skills", "pr-maintenance", "snapshot.mjs")).href
);
const {
  observe,
  contentHash,
  POLICY_TYPES,
  matchEffects,
  resolveAzLauncher,
  getAccessToken,
  toAdoHostObservation,
  httpsRequest,
} = await import(pathToFileURL(helper).href);
const projectId = "11111111-1111-4111-8111-111111111111";
const repositoryId = "22222222-2222-4222-8222-222222222222";
const forkId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const evaluationId = "55555555-5555-4555-8555-555555555555";
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const started = Date.parse("2026-09-18T00:00:30.000Z");
const timestamp = "2026-09-18T00:00:00.000Z";
const finished = "2026-09-18T00:00:10.000Z";
const now = () => started;
const repo = (id = repositoryId, name = "Repo") => ({
  id,
  name,
  project: { id: projectId, name: "Project" },
});
const input = (changes: Record<string, any> = {}) => ({
  schemaVersion: 1,
  generation: 1,
  pr: {
    provider: "azure-devops",
    organization: "example",
    project: "Project",
    repo: "Repo",
    number: 7,
  },
  budget: {
    maxRequests: 40,
    deadlineAt: new Date(started + 120_000).toISOString(),
    maxBytes: 1_048_576,
  },
  knownEffects: [],
  handledSources: [],
  previousThreads: [],
  ...changes,
});
function comment(id = 1, content = "Please fix this.") {
  return {
    id,
    parentCommentId: id === 1 ? 0 : 1,
    content,
    commentType: "text",
    author: { id: actorId },
    publishedDate: timestamp,
    lastUpdatedDate: timestamp,
    lastContentUpdatedDate: timestamp,
  };
}
function thread(comments = [comment()]) {
  return {
    id: 12,
    status: "active",
    isDeleted: false,
    lastUpdatedDate: timestamp,
    publishedDate: timestamp,
    threadContext: { filePath: "/test.ts" },
    comments,
  };
}
function policy(type = POLICY_TYPES.build, settings: Record<string, any> = {}) {
  return {
    id: 1,
    revision: 2,
    isEnabled: true,
    isBlocking: true,
    type: { id: type },
    settings: {
      scope: [{ repositoryId: null, refName: "refs/heads/main", matchKind: "Exact" }],
      ...(type === POLICY_TYPES.build ? { buildDefinitionId: 10 } : {}),
      ...settings,
    },
  };
}
function evaluation(config: any, status = "approved", context: any = {}) {
  return {
    artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/7`,
    evaluationId,
    status,
    configuration: structuredClone(config),
    context,
    startedDate: timestamp,
    completedDate: finished,
  };
}
function build() {
  return {
    id: 20,
    project: { id: projectId },
    definition: { id: 10 },
    repository: { id: repositoryId, type: "TfsGit" },
    sourceBranch: "refs/pull/7/merge",
    sourceVersion: merge,
    status: "completed",
    result: "succeeded",
    queueTime: timestamp,
    startTime: timestamp,
    finishTime: finished,
  };
}
function status(id = 1, state = "succeeded") {
  return {
    id,
    iterationId: 2,
    state,
    context: { name: "tests", genre: "ci" },
    createdBy: { id: actorId },
    creationDate: timestamp,
    updatedDate: timestamp,
  };
}
function fixtures() {
  return {
    metadata: {
      pullRequestId: 7,
      repository: repo(),
      sourceRefName: "refs/heads/FixCase",
      targetRefName: "refs/heads/main",
      status: "active",
      isDraft: false,
      supportsIterations: true,
      mergeStatus: "succeeded",
      title: "Fix",
      description: "Description",
      lastMergeSourceCommit: { commitId: head },
      lastMergeTargetCommit: { commitId: base },
      lastMergeCommit: { commitId: merge },
      reviewers: [],
    } as any,
    iterations: [
      {
        id: 2,
        sourceRefCommit: { commitId: head },
        targetRefCommit: { commitId: base },
        createdDate: timestamp,
        updatedDate: timestamp,
      },
    ] as any[],
    headRefs: [{ name: "refs/heads/FixCase", objectId: head }] as any[],
    baseRefs: [{ name: "refs/heads/main", objectId: base }] as any[],
    threads: [] as any[],
    comments: new Map<number, any[]>(),
    statuses: [] as any[],
    iterationStatuses: [] as any[],
    policies: [] as any[],
    evaluations: [] as any[],
    builds: new Map<number, any>(),
  };
}
type Fixtures = ReturnType<typeof fixtures>;
type Call = { method: string; url: string; timeoutMs: number; maxBytes: number };
function transport(
  data: Fixtures,
  mutate?: (call: Call, count: number, response: any) => any,
) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const request = async (call: Call) => {
    calls.push(call);
    expect(call.method).toBe("GET");
    expect(Object.keys(call).sort()).toEqual(["maxBytes", "method", "timeoutMs", "url"]);
    expect(call.timeoutMs).toBeLessThanOrEqual(15_000);
    const url = new URL(call.url);
    expect(url.origin).toBe("https://dev.azure.com");
    expect(url.pathname.startsWith("/example/")).toBe(true);
    const path = url.pathname;
    const key = path + url.search;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    let value: any;
    let single = false;
    if (/\/pullRequests\/7$/.test(path)) {
      value = data.metadata;
      single = true;
    } else if (/\/iterations$/.test(path)) value = data.iterations;
    else if (/\/refs$/.test(path)) {
      expect(url.searchParams.get("$top")).toBe("100");
      value =
        url.searchParams.get("filter") === "heads/main" ? data.baseRefs : data.headRefs;
    } else if (/\/threads$/.test(path)) value = data.threads;
    else if (/\/threads\/\d+\/comments$/.test(path)) {
      const id = Number(/\/threads\/(\d+)\/comments$/.exec(path)![1]);
      value =
        data.comments.get(id) ??
        data.threads.find((entry) => entry.id === id)?.comments ??
        [];
    } else if (/\/iterations\/2\/statuses$/.test(path)) value = data.iterationStatuses;
    else if (/\/statuses$/.test(path)) value = data.statuses;
    else if (/\/git\/policy\/configurations$/.test(path)) {
      expect(url.searchParams.get("api-version")).toBe("5.0-preview.1");
      expect(url.searchParams.get("repositoryId")).toBe(repositoryId);
      expect(url.searchParams.get("refName")).toBe("refs/heads/main");
      expect(url.searchParams.has("scope")).toBe(false);
      value = data.policies;
    } else if (/\/policy\/evaluations$/.test(path)) {
      expect(url.searchParams.get("artifactId")).toBe(
        `vstfs:///CodeReview/CodeReviewId/${projectId}/7`,
      );
      expect(url.searchParams.get("includeNotApplicable")).toBe("true");
      const skip = Number(url.searchParams.get("$skip"));
      value = data.evaluations.slice(skip, skip + 100);
    } else if (/\/build\/builds\/\d+$/.test(path)) {
      value = data.builds.get(Number(path.split("/").at(-1)));
      single = true;
    } else throw new Error(`Unexpected synthetic route: ${path}`);
    const response = {
      status: 200,
      headers: {},
      body: structuredClone(single ? value : { count: value.length, value }),
    };
    return mutate?.(call, count, response) ?? response;
  };
  return { request, calls };
}
async function run(
  data = fixtures(),
  requestInput = input(),
  mutate?: Parameters<typeof transport>[1],
  observeProvider = observe,
) {
  const fixture = transport(data, mutate);
  const result = await observeProvider(requestInput, { request: fixture.request, now });
  expect(PrMaintenanceObservationSchema.safeParse(result.observation).success).toBe(true);
  expect(result.requestsConsumed).toBe(fixture.calls.length);
  return { ...result, calls: fixture.calls };
}
function withBuild() {
  const data = fixtures();
  data.policies = [policy()];
  data.evaluations = [evaluation(data.policies[0], "approved", { buildId: 20 })];
  data.builds.set(20, build());
  return data;
}

describe("Azure DevOps read-only snapshot: synthetic transports only", () => {
  it.each(["%2F", "%2f"])(
    "accepts native percent-encoded artifact separator %s with exact project and PR pins",
    async (separator) => {
      const data = withBuild();
      data.evaluations[0].artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}${separator}7`;
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.checksComplete).toBe(false);
      expect(result.progress).toMatchObject({ pages: 9, verifiedPages: 9 });
    },
  );

  it.each([
    `vstfs:///CodeReview/CodeReviewId/${forkId}%2F7`,
    `vstfs:///CodeReview/CodeReviewId/${projectId}%2F8`,
    `vstfs:///CodeReview/CodeReviewId/${projectId}%252F7`,
    `vstfs:///CodeReview/CodeReviewId/${projectId}%2F7/extra`,
    `vstfs:///CodeReview/CodeReviewId/${projectId}%2F7#fragment`,
    `vstfs:%2F%2F%2FCodeReview/CodeReviewId/${projectId}%2F7`,
    undefined,
  ])(
    "rejects nonmatching or over-encoded policy artifact identity: %s",
    async (artifactId) => {
      const data = withBuild();
      data.evaluations[0].artifactId = artifactId;
      const result = await run(data);
      expect(result.complete).toBe(false);
      expect(result.error).toMatchObject({
        code: "malformed_response",
        diagnostic: {
          stage: "snapshot",
          check: "evaluation.artifact_id",
          path: "evaluations[0].artifactId",
        },
      });
      expect(result.snapshot).toBeUndefined();
    },
  );

  it.each([
    ["direct", observe],
    ["router", routeObservation],
  ])(
    "collects native omitted-state statuses as unknown through %s",
    async (_name, collect) => {
      const data = fixtures();
      data.statuses = [status()];
      data.iterationStatuses = [status()];
      delete data.statuses[0].state;
      delete data.iterationStatuses[0].state;
      data.threads = [thread()];
      const result = await run(data, input(), undefined, collect);
      expect(result.complete).toBe(true);
      expect(result.snapshot.statuses[0].state).toBe("notSet");
      expect(result.observation.checks).toContainEqual(
        expect.objectContaining({ state: "unknown", headSha: head }),
      );
      expect(result.observation.sources.map((source: any) => source.id)).toEqual([
        "thread_comment:12:1",
      ]);
      expect(result.progress).toMatchObject({ pages: 8, verifiedPages: 8 });
    },
  );

  it("still detects an omitted-state status changing during verification", async () => {
    const data = fixtures();
    data.iterationStatuses = [status()];
    delete data.iterationStatuses[0].state;
    const result = await run(data, input(), (call, count, response) => {
      if (call.url.includes("/iterations/2/statuses?") && count === 2)
        response.body.value[0].state = "succeeded";
      return response;
    });
    expect(result.error.code).toBe("inconsistent_snapshot");
    expect(result.snapshot).toBeUndefined();
  });

  it.each([
    ["null state", "state", null, "status.state"],
    ["unknown state", "state", "PRIVATE_PROVIDER_TEXT", "status.state"],
    ["numeric state", "state", 0, "status.state"],
    ["missing id", "id", undefined, "status.id"],
    ["missing context", "context", undefined, "status.context"],
    ["missing date", "updatedDate", undefined, "status.updated_date"],
  ])(
    "rejects partial status evidence with sanitized diagnostics: %s",
    async (_name, field, value, check) => {
      const data = fixtures();
      data.iterationStatuses = [{ ...status(), [field]: value }];
      data.metadata.title = "PRIVATE_PROVIDER_TEXT";
      data.threads = [thread([comment(1, "PRIVATE_PROVIDER_TEXT")])];
      const result = await run(data);
      expect(result.complete).toBe(false);
      expect(result.snapshot).toBeUndefined();
      expect(result.resume).toBeUndefined();
      expect(result.error).toEqual({
        code: "malformed_response",
        message:
          "Azure DevOps returned missing, partial, or malformed required evidence.",
        diagnostic: {
          stage: "snapshot",
          check,
          path: `iterationStatuses[0].${field}`,
        },
      });
      expect(result.observation.helperState.error).toEqual(result.error);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_TEXT");
    },
  );

  it.each(["json", "list", "thread", "comment", "null-comment", "evaluation", "spoofed"])(
    "does not leak provider text or arbitrary keys in malformed diagnostics: %s",
    async (kind) => {
      const data = withBuild();
      data.metadata.title = "PRIVATE_PROVIDER_TEXT";
      data.threads = [thread([comment(1, "PRIVATE_PROVIDER_TEXT")])];
      if (kind === "thread") delete data.threads[0].comments;
      if (kind === "comment")
        data.threads[0].comments[0].commentType = "PRIVATE_PROVIDER_TEXT";
      if (kind === "null-comment") data.threads[0].comments[0] = null;
      if (kind === "evaluation") data.evaluations[0].status = "PRIVATE_PROVIDER_TEXT";
      const result = await run(data, input(), (call, _count, response) => {
        if (!call.url.includes("/threads?")) return response;
        if (kind === "json") response.body = '{"PRIVATE_PROVIDER_TEXT":';
        if (kind === "list") response.body = { PRIVATE_PROVIDER_TEXT: [] };
        if (kind === "spoofed")
          throw Object.assign(new Error("PRIVATE_PROVIDER_TEXT"), {
            code: "malformed_response",
            diagnostic: {
              stage: "PRIVATE_PROVIDER_TEXT",
              check: "PRIVATE_PROVIDER_TEXT",
              path: "PRIVATE_PROVIDER_TEXT",
            },
          });
        return response;
      });
      const expected = {
        json: ["response", "response.json", "$"],
        list: ["response", "list.envelope", "threads"],
        thread: ["response", "thread.fields", "threads[0]"],
        comment: ["response", "comment.fields", "threads[0].comments[0]"],
        "null-comment": ["response", "comment.fields", "threads[0].comments[0]"],
        evaluation: ["snapshot", "evaluation.fields", "evaluations[0]"],
        spoofed: ["response", "required_evidence", "$"],
      }[kind]!;
      expect(result.error).toMatchObject({
        code: "malformed_response",
        diagnostic: { stage: expected[0], check: expected[1], path: expected[2] },
      });
      expect(result.snapshot).toBeUndefined();
      expect(result.resume).toBeUndefined();
      expect(result.observation.helperState.error).toEqual(result.error);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_TEXT");
    },
  );

  it.each([40, 39])(
    "collects forty mixed multi-comment threads within %i operations including authentication",
    async (maxRequests) => {
      const data = fixtures();
      data.threads = Array.from({ length: 40 }, (_, index) => ({
        ...thread([comment(1, `Finding ${index}`), comment(2, `Reply ${index}`)]),
        id: index + 1,
        status: ["active", "fixed", "closed", "pending"][index % 4],
      }));
      const fixture = transport(data);
      let authentications = 0;
      const result = await observe(
        input({ budget: { ...input().budget, maxRequests } }),
        {
          request: fixture.request,
          now,
          acquireToken: async () => {
            authentications++;
            return "synthetic-token-not-a-credential";
          },
        },
      );
      expect(result, JSON.stringify(result.progress)).toMatchObject({
        complete: true,
        requestsConsumed: 19,
        progress: { pages: 8, verifiedPages: 8 },
      });
      expect(authentications).toBe(1);
      expect(fixture.calls).toHaveLength(18);
      expect(result.snapshot.threads).toHaveLength(40);
      expect(result.snapshot.actionableSources).toHaveLength(80);
      expect(result.observation.sources).toHaveLength(80);
      expect(fixture.calls.filter((call) => /\/threads\?/.test(call.url))).toHaveLength(
        2,
      );
      expect(fixture.calls.some((call) => /\/comments\?/.test(call.url))).toBe(false);
    },
  );

  it("pins case-preserved names, lowercase GUIDs and current-iteration/live branch SHAs", async () => {
    const data = fixtures();
    data.metadata.repository.id = repositoryId.toUpperCase();
    const result = await run(data);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      complete: true,
      requestsConsumed: 18,
      observation: {
        checksComplete: true,
        reviewsComplete: true,
        mergeability: "mergeable",
        identity: {
          provider: "azure-devops",
          organization: "example",
          project: "Project",
          projectId,
          repositoryId,
          repository: "Project/Repo",
          headRef: "refs/heads/FixCase",
        },
        headSha: head,
        baseSha: base,
        reviews: [],
        sources: [],
      },
    });
    expect(result.snapshot.iteration.id).toBe(2);
  });

  it.each(["head", "base", "body", "revision", "thread", "new-comment", "deleted"])(
    "rejects a consolidated second-pass %s mutation without consuming stale sources",
    async (change) => {
      const data = fixtures();
      data.threads = Array.from({ length: 40 }, (_, index) => ({
        ...thread([comment(), comment(2)]),
        id: index + 1,
      }));
      const result = await run(data, input(), (call, count, response) => {
        if (count !== 2) return response;
        const url = new URL(call.url);
        if (
          ["head", "base"].includes(change) &&
          url.pathname.endsWith("/refs") &&
          url.searchParams.get("filter") ===
            (change === "head" ? "heads/FixCase" : "heads/main")
        )
          response.body.value[0].objectId = merge;
        if (url.pathname.endsWith("/threads")) {
          const entry = response.body.value[39];
          if (change === "body")
            entry.comments[1].content = "Changed reply, unchanged metadata";
          if (change === "revision") entry.comments[1].lastContentUpdatedDate = finished;
          if (change === "thread") entry.status = "fixed";
          if (change === "new-comment") entry.comments.push(comment(3));
          if (change === "deleted") entry.comments[1].isDeleted = true;
        }
        return response;
      });
      expect(result.error.code).toBe("inconsistent_snapshot");
      expect(result.snapshot).toBeUndefined();
      expect(result.observation.sources).toEqual([]);
      expect(result.observation.helperState.resume).toBeNull();
    },
  );

  it("rejects old per-thread continuations and expired restart deadlines without provider I/O", async () => {
    const data = fixtures();
    const first = await run(
      data,
      input({ budget: { ...input().budget, maxRequests: 9 } }),
    );
    const legacy = structuredClone(first.resume);
    delete legacy.collectionVersion;
    legacy.digest = contentHash({ ...legacy, digest: undefined });
    expect(await run(data, input({ resume: legacy }))).toMatchObject({
      complete: false,
      requestsConsumed: 0,
      error: { code: "invalid_resume" },
    });
    const fixture = transport(data);
    const expired = await observe(input({ resume: first.resume }), {
      request: fixture.request,
      now: () => started + 120_001,
    });
    expect(expired).toMatchObject({
      complete: false,
      requestsConsumed: 0,
      error: { code: "deadline_exhausted" },
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it.each(["local_auth_unavailable", "auth_required"])(
    "counts token acquisition and fails closed for %s",
    async (code) => {
      const fixture = transport(fixtures(), () => ({ status: 401 }));
      const result = await observe(input(), {
        request: fixture.request,
        now,
        acquireToken: async () => {
          if (code === "local_auth_unavailable")
            throw Object.assign(new Error("PRIVATE_TOKEN"), { code });
          return "synthetic-token";
        },
      });
      expect(result).toMatchObject({
        complete: false,
        requestsConsumed: code === "auth_required" ? 2 : 1,
        error: { code },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
      expect(result.snapshot).toBeUndefined();
    },
  );

  it.each([
    "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7",
    "https://example.visualstudio.com/Project/_git/Repo/pullrequest/7",
    "https://example.visualstudio.com/DefaultCollection/Project/_git/Repo/pullrequest/7",
  ])("accepts canonical or legacy URL %s", async (url) => {
    expect(
      (await run(fixtures(), input({ pr: { provider: "azure-devops", url } }))).complete,
    ).toBe(true);
  });

  it.each([
    "http://dev.azure.com/example/Project/_git/Repo/pullrequest/7",
    "https://user:password@dev.azure.com/example/Project/_git/Repo/pullrequest/7",
    "https://dev.azure.com:444/example/Project/_git/Repo/pullrequest/7",
    "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7?x=secret",
    "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7#x",
    "https://dev.azure.com/example/%ZZ/_git/Repo/pullrequest/7",
    "https://github.com/example/Repo/pull/7",
  ])("rejects unsafe/wrong-provider URL without transport %s", async (url) => {
    const result = await run(
      fixtures(),
      input({ pr: { provider: "azure-devops", url } }),
    );
    expect(result.error.code).toBe("invalid_input");
    expect(result.requestsConsumed).toBe(0);
  });

  it.each(["organization", "project", "repo"])(
    "rejects missing explicit %s rather than reading an undefined-name scope",
    async (key) => {
      const pr = { ...input().pr } as Record<string, any>;
      delete pr[key];
      const result = await run(fixtures(), input({ pr }));
      expect(result.error.code).toBe("invalid_input");
      expect(result.requestsConsumed).toBe(0);
    },
  );

  it("verifies same-project fork refs against the fork, not the base repository", async () => {
    const data = fixtures();
    data.metadata.forkSource = {
      name: "refs/heads/FixCase",
      repository: repo(forkId, "Fork"),
    };
    const result = await run(data);
    expect(result.complete).toBe(true);
    expect(result.snapshot.identity).toMatchObject({
      headRepositoryId: forkId,
      headRepository: "Project/Fork",
    });
    expect(result.calls.some((call: Call) => call.url.includes(`${forkId}/refs`))).toBe(
      true,
    );
    const pins = result.snapshot.identity;
    expect((await run(data, input({ pr: { ...input().pr, ...pins } }))).complete).toBe(
      true,
    );
    expect(
      (
        await run(
          data,
          input({ pr: { ...input().pr, ...pins, headRef: "refs/heads/fixcase" } }),
        )
      ).error.code,
    ).toBe("scope_changed");
    data.metadata.forkSource.repository.project.id = forkId;
    expect((await run(data)).error.code).toBe("unsupported_scope");
  });

  it("does not substitute the base repository for an incompletely described fork", async () => {
    const data = fixtures();
    data.metadata.forkSource = { name: "refs/heads/FixCase" };
    expect((await run(data)).error.code).toBe("unsupported_scope");
  });

  it.each(["completed", "abandoned"])(
    "settles %s without requiring deleted live branches or policy reads",
    async (state) => {
      const data = fixtures();
      data.metadata.status = state;
      data.headRefs = [];
      data.policies = [policy("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")];
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.requestsConsumed).toBe(2);
      expect(result.observation.state).toBe(state === "completed" ? "merged" : "closed");
    },
  );

  it.each(["isDraft", "autoCompleteSetBy", "completionQueueTime", "bypassPolicy"])(
    "guards %s",
    async (field) => {
      const data = fixtures();
      if (field === "bypassPolicy")
        data.metadata.completionOptions = { bypassPolicy: true };
      else
        data.metadata[field] =
          field === "isDraft"
            ? true
            : field === "autoCompleteSetBy"
              ? { id: actorId }
              : timestamp;
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.draft).toBe(field === "isDraft");
      expect(
        result.observation.checks.some((check: any) => check.state === "pending"),
      ).toBe(true);
    },
  );

  it.each(["conflicts", "queued", "rejectedByPolicy", "failure", "notSet"])(
    "does not call merge status %s mergeable",
    async (mergeStatus) => {
      const data = fixtures();
      data.metadata.mergeStatus = mergeStatus;
      const result = await run(data);
      expect(result.observation.mergeability).toBe(
        mergeStatus === "conflicts" ? "conflicting" : "unknown",
      );
    },
  );

  it("does not claim mergeable when a succeeded merge status lacks a merge commit", async () => {
    const data = fixtures();
    delete data.metadata.lastMergeCommit;
    expect((await run(data)).observation.mergeability).toBe("unknown");
  });

  it.each(["iteration-head", "live-head"])("blocks stale %s", async (field) => {
    const data = fixtures();
    if (field === "iteration-head") data.iterations[0].sourceRefCommit.commitId = merge;
    if (field === "live-head") data.headRefs[0].objectId = merge;
    const result = await run(data);
    expect(result.error.code).toBe("stale_evidence");
    expect(result.snapshot).toBeUndefined();
  });

  it("retains iteration target and actionable complete feedback when the live target advances", async () => {
    const data = fixtures();
    data.threads = [thread()];
    data.baseRefs[0].objectId = merge;
    const stale = await run(data);
    expect(stale.complete).toBe(true);
    expect(stale.snapshot.iteration.targetRefCommit.commitId).toBe(base);
    expect(stale.snapshot.baseSha).toBe(merge);
    expect(stale.snapshot.mergeEvaluation).toMatchObject({
      targetSha: base,
      current: false,
    });
    expect(stale.observation.mergeability).toBe("unknown");
    expect(stale.observation.checks.some((check: any) => check.state === "pending")).toBe(
      true,
    );
    expect(stale.observation.sources).toHaveLength(1);
    data.metadata.lastMergeTargetCommit.commitId = merge;
    data.metadata.lastMergeCommit.commitId = "d".repeat(40);
    const reevaluated = await run(data);
    expect(reevaluated.complete).toBe(true);
    expect(reevaluated.snapshot.iteration.targetRefCommit.commitId).toBe(base);
    expect(reevaluated.snapshot.baseSha).toBe(merge);
    expect(reevaluated.snapshot.mergeEvaluation.current).toBe(true);
    expect(reevaluated.observation.mergeability).toBe("mergeable");
    expect(reevaluated.observation.sources).toEqual(stale.observation.sources);
  });

  it.each(["source", "target"])(
    "retains feedback but prevents readiness with stale merge-evaluation %s",
    async (which) => {
      const data = fixtures();
      data.threads = [thread()];
      const key = which === "source" ? "lastMergeSourceCommit" : "lastMergeTargetCommit";
      data.metadata[key].commitId = merge;
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.sources).toHaveLength(1);
      expect(result.observation.mergeability).toBe("unknown");
      expect(
        result.observation.checks.some((check: any) => check.state === "pending"),
      ).toBe(true);
    },
  );

  it("reads every thread's full replies, exact edits and observed reopen revisions", async () => {
    const data = fixtures();
    data.threads = [thread([comment(), comment(2, "reply")])];
    const first = await run(data);
    expect(first.complete).toBe(true);
    expect(first.snapshot.actionableSources).toHaveLength(2);
    expect(
      first.calls.filter((call: Call) => call.url.includes("/threads?")),
    ).toHaveLength(2);
    const source = first.snapshot.actionableSources[0];
    const handled = {
      kind: source.kind,
      id: source.id,
      revision: source.revision,
      headSha: head,
    };
    expect(
      (await run(data, input({ handledSources: [handled] }))).snapshot.actionableSources,
    ).toHaveLength(1);
    expect(
      (await run(data, input({ handledSources: [{ ...handled, headSha: base }] })))
        .snapshot.actionableSources,
    ).toHaveLength(2);
    data.threads[0].comments[0].content = "edited";
    expect((await run(data)).snapshot.actionableSources[0].revision).not.toBe(
      source.revision,
    );
    data.threads[0].comments[0] = comment();
    data.threads[0].status = "fixed";
    const resolved = await run(
      data,
      input({ previousThreads: first.snapshot.threadStates }),
    );
    expect(resolved.snapshot.threadStates[0].revision).toBe(1);
    data.threads[0].status = "active";
    const reopened = await run(
      data,
      input({
        previousThreads: resolved.snapshot.threadStates,
        handledSources: [handled],
      }),
    );
    expect(reopened.snapshot.threadStates[0].revision).toBe(2);
    expect(reopened.snapshot.actionableSources).toHaveLength(2);
  });

  it.each(["fixed", "closed", "wontFix", "byDesign"])(
    "does not treat thread status %s as an addressed disposition",
    async (status) => {
      const data = fixtures();
      data.threads = [{ ...thread(), status }];
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.sources).toHaveLength(1);
      expect(result.snapshot.actionableSources[0].body).toBe("Please fix this.");
    },
  );

  it("settles only unique exact provider comment IDs or unique marker+actor+hash", async () => {
    const data = fixtures();
    const text = "receipt:abcdefghijklmnop replied";
    data.threads = [thread([comment(1, text)])];
    const effect = {
      effectId: "reply-1",
      kind: "thread_comment",
      id: "12:1",
      actor: actorId,
      contentHash: contentHash(text),
    };
    const result = await run(
      data,
      input({
        knownEffects: [
          effect,
          { ...effect, effectId: "unknown-push", kind: "commit" },
          { ...effect, effectId: "unknown-resolve", kind: "thread_resolution" },
        ],
      }),
    );
    expect(result.observation.knownSelfEffectIds).toEqual(["reply-1"]);
    expect(result.snapshot.effects.unobserved).toEqual([
      "unknown-push",
      "unknown-resolve",
    ]);
    expect(result.snapshot.actionableSources).toEqual([]);
    const marker = { ...effect, id: undefined, marker: "abcdefghijklmnop" };
    expect(
      (await run(data, input({ knownEffects: [marker] }))).snapshot.effects.matched,
    ).toHaveLength(1);
    expect(
      (await run(data, input({ knownEffects: [{ ...effect, actor: forkId }] }))).snapshot
        .effects.matched,
    ).toHaveLength(0);
    data.threads[0].comments.push(comment(2, text));
    const ambiguous = await run(data, input({ knownEffects: [marker] }));
    expect(ambiguous.error.code).toBe("ambiguous_effect");
    expect(ambiguous.snapshot).toBeUndefined();
    expect(
      matchEffects(
        [
          {
            kind: "thread_comment",
            id: "12:1",
            actor: null,
            body: text,
            contentHash: contentHash(text),
          },
        ],
        [effect],
      ).matched,
    ).toEqual([]);
  });

  it("detects body edits during both collection and the full second pass", async () => {
    const data = fixtures();
    data.threads = [thread()];
    const result = await run(data, input(), (call, count, response) => {
      if (call.url.includes("/threads?") && count === 2)
        response.body.value[0].comments[0].content = "changed without PR timestamp";
      return response;
    });
    expect(result.error.code).toBe("inconsistent_snapshot");
    expect(result.resume).toBeUndefined();
    expect(result.snapshot).toBeUndefined();
  });

  it("preserves pending/reject votes and required reviewers without treating raw +10/+5 as fresh approval", async () => {
    const data = fixtures();
    data.metadata.reviewers = [10, 5, 0, -5, -10].map((vote, index) => ({
      id: `${index + 1}4444444-4444-4444-8444-444444444444`,
      vote,
      isRequired: index < 3,
    }));
    const result = await run(data);
    expect(result.complete).toBe(true);
    expect(result.snapshot.reviewers.map((voter: any) => voter.vote)).toEqual([
      10, 5, 0, -5, -10,
    ]);
    expect(result.observation.reviews.map((review: any) => review.state)).toEqual([
      "required",
      "required",
      "required",
      "changes_requested",
      "changes_requested",
    ]);
  });

  it("preserves member-to-team vote rollup without counting an extra approval", async () => {
    const data = fixtures();
    data.metadata.reviewers = [
      { id: actorId, vote: 10, isRequired: false, votedFor: [{ id: forkId, vote: 10 }] },
      { id: forkId, vote: 10, isRequired: true, isContainer: true },
    ];
    const result = await run(data);
    expect(result.complete).toBe(true);
    expect(result.snapshot.reviewers[0].votedFor).toEqual([{ id: forkId, vote: 10 }]);
    expect(result.snapshot.reviewers[1].isContainer).toBe(true);
    expect(result.observation.reviews).toHaveLength(1);
    expect(result.observation.reviews[0]).toMatchObject({
      reviewer: forkId,
      state: "required",
    });
  });

  it.each([POLICY_TYPES.reviewers, POLICY_TYPES.requiredReviewers])(
    "retains feedback but blocks review readiness for unverifiable approval %s",
    async (type) => {
      const data = fixtures();
      data.policies = [
        policy(
          type,
          type === POLICY_TYPES.reviewers
            ? { minimumApproverCount: 1, resetOnSourcePush: true }
            : { requiredReviewerIds: [actorId] },
        ),
      ];
      data.threads = [thread()];
      data.evaluations = [evaluation(data.policies[0], "approved", { iterationId: 2 })];
      const approved = await run(data);
      expect(approved.complete).toBe(true);
      expect(approved.observation).toMatchObject({
        checksComplete: true,
        reviewsComplete: false,
      });
      expect(approved.observation.sources).toHaveLength(1);
      data.evaluations[0].status = "rejected";
      const rejected = await run(data);
      expect(rejected.complete).toBe(true);
      expect(rejected.observation.reviews[0].state).toBe("changes_requested");
    },
  );

  it("uses effective inherited project configurations and exact evaluation config revisions", async () => {
    const data = fixtures();
    data.policies = [policy(POLICY_TYPES.comments)];
    data.evaluations = [evaluation(data.policies[0])];
    expect((await run(data)).complete).toBe(true);
    data.policies[0].revision++;
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: true,
    });
    data.policies[0].revision--;
    data.evaluations = [];
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: true,
    });
    data.evaluations = [evaluation(data.policies[0], "notApplicable")];
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: false,
    });
  });

  it("does not bypass an approved unknown policy, including optional policies", async () => {
    for (const isBlocking of [true, false]) {
      const data = fixtures();
      data.policies = [{ ...policy("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), isBlocking }];
      data.threads = [thread()];
      data.evaluations = [evaluation(data.policies[0])];
      const result = await run(data);
      expect(result.observation).toMatchObject({
        complete: true,
        checksComplete: false,
        reviewsComplete: false,
      });
      expect(result.observation.sources).toHaveLength(1);
    }
  });

  it("retains external comments with common approved build and reviewer policies while both readiness flags are false", async () => {
    const data = withBuild();
    const review = {
      ...policy(POLICY_TYPES.reviewers, { minimumApproverCount: 1 }),
      id: 2,
    };
    data.policies.push(review);
    data.evaluations.push({ ...evaluation(review), evaluationId: forkId });
    data.threads = [thread()];
    data.metadata.reviewers = [{ id: actorId, vote: 10, isRequired: true }];
    const result = await run(data);
    expect(result.observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: false,
    });
    expect(result.snapshot).toMatchObject({
      checksComplete: false,
      reviewsComplete: false,
    });
    expect(result.observation.sources).toHaveLength(1);
    expect(result.observation.sources[0].id).toBe("thread_comment:12:1");
    expect(result.observation.reviews).toContainEqual(
      expect.objectContaining({ reviewer: actorId, state: "required" }),
    );
    expect(result.observation.checks).toContainEqual(
      expect.objectContaining({ state: "unknown" }),
    );
  });

  it.each([
    { unknownRequirement: true },
    { filenamePatterns: ["src/**"] },
    { scope: [{ repositoryId: null, matchKind: "new-scope-semantics" }] },
  ])(
    "retains data but clears both flags for unknown settings/applicability %j",
    async (settings) => {
      const data = fixtures();
      data.policies = [policy(POLICY_TYPES.comments, settings)];
      data.evaluations = [evaluation(data.policies[0])];
      data.threads = [thread()];
      const result = await run(data);
      expect(result.observation).toMatchObject({
        complete: true,
        checksComplete: false,
        reviewsComplete: false,
      });
      expect(result.observation.sources).toHaveLength(1);
    },
  );

  it("preserves precise build/status failures, negative voters and comments alongside unknown policy", async () => {
    const data = withBuild();
    data.evaluations[0].status = "rejected";
    data.builds.get(20).result = "failed";
    const unknown = { ...policy("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), id: 2 };
    data.policies.push(unknown);
    data.evaluations.push({ ...evaluation(unknown), evaluationId: forkId });
    data.iterationStatuses = [status(1, "failed")];
    data.threads = [thread()];
    data.metadata.reviewers = [{ id: actorId, vote: -10, isRequired: false }];
    const result = await run(data);
    expect(result.observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: false,
    });
    expect(result.observation.sources.map((source: any) => source.id)).toEqual([
      "thread_comment:12:1",
      "check:policy:1",
      `check:status:${contentHash(JSON.stringify(["ci", "tests"]))}`,
    ]);
    expect(result.observation.reviews).toContainEqual(
      expect.objectContaining({ reviewer: actorId, state: "changes_requested" }),
    );
  });

  it("keeps a rejected build obligation without using an absent opaque build hint as CI proof", async () => {
    const data = withBuild();
    data.evaluations[0].status = "rejected";
    data.evaluations[0].context = {};
    data.threads = [thread()];
    const result = await run(data);
    expect(result.observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: true,
    });
    expect(result.observation.checks).toContainEqual(
      expect.objectContaining({ state: "failed" }),
    );
    expect(result.observation.sources.map((source: any) => source.id)).toEqual([
      "thread_comment:12:1",
    ]);
  });

  it.each([POLICY_TYPES.build, POLICY_TYPES.status])(
    "preserves a pending CI policy even while readiness is unproven: %s",
    async (type) => {
      const data = fixtures();
      data.policies = [
        {
          ...policy(
            type,
            type === POLICY_TYPES.status
              ? { statusName: "tests", statusGenre: "ci", invalidateOnSourceUpdate: true }
              : {},
          ),
          isBlocking: false,
        },
      ];
      data.evaluations = [evaluation(data.policies[0], "queued")];
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.checks).toContainEqual(
        expect.objectContaining({
          state: "pending",
          evidence: expect.stringContaining("policy 1"),
        }),
      );
    },
  );

  it("still rejects a second-pass policy change instead of classifying it as a readiness gap", async () => {
    const data = withBuild();
    data.threads = [thread()];
    const result = await run(data, input(), (call, count, response) => {
      if (call.url.includes("/git/policy/configurations?") && count === 2)
        response.body.value[0].revision++;
      return response;
    });
    expect(result.complete).toBe(false);
    expect(result.error.code).toBe("inconsistent_snapshot");
    expect(result.snapshot).toBeUndefined();
    expect(result.observation.sources).toEqual([]);
  });

  it.each(["configuration", "evaluation", "build"])(
    "still rejects malformed %s evidence, not just readiness",
    async (kind) => {
      const data = withBuild();
      data.threads = [thread()];
      if (kind === "configuration") data.policies[0].isEnabled = "yes";
      if (kind === "evaluation") data.evaluations[0].status = "invalid-provider-enum";
      if (kind === "build") delete data.builds.get(20).sourceVersion;
      const result = await run(data);
      expect(result.complete).toBe(false);
      expect(result.error.code).toBe("malformed_response");
      expect(result.snapshot).toBeUndefined();
    },
  );

  it.each([
    "artifact",
    "stale-date",
    "future-date",
    "missing-build",
    "definition",
    "project",
    "repository",
    "branch",
    "sha",
    "stale-build",
    "build-failed",
  ])("never allows readiness from mismatched build/evaluation %s", async (change) => {
    const data = withBuild();
    data.threads = [thread()];
    const record = data.builds.get(20);
    if (change === "artifact")
      data.evaluations[0].artifactId = `vstfs:///Git/PullRequestId/${projectId}/${repositoryId}/7`;
    if (change === "stale-date")
      data.evaluations[0].completedDate = "2025-01-01T00:00:00Z";
    if (change === "future-date")
      data.evaluations[0].completedDate = "2030-01-01T00:00:00Z";
    if (change === "missing-build") data.evaluations[0].context = {};
    if (change === "definition") record.definition.id++;
    if (change === "project") record.project.id = forkId;
    if (change === "repository") record.repository.id = forkId;
    if (change === "branch") record.sourceBranch = "refs/heads/other";
    if (change === "sha") record.sourceVersion = head;
    if (change === "stale-build") record.queueTime = "2025-01-01T00:00:00Z";
    if (change === "build-failed") record.result = "failed";
    const result = await run(data);
    if (["artifact", "project"].includes(change)) {
      expect(result.complete).toBe(false);
      expect(result.observation.failure).toBe("incomplete");
      expect(result.snapshot).toBeUndefined();
    } else {
      expect(result.observation).toMatchObject({
        complete: true,
        checksComplete: false,
        reviewsComplete: true,
      });
      expect(result.observation.sources).toHaveLength(1);
    }
  });

  it("does not certify build approval from opaque context and keeps CI failure sources stable across retries", async () => {
    const data = withBuild();
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: true,
    });
    Object.assign(data.builds.get(20), {
      sourceVersion: head,
      sourceBranch: data.metadata.sourceRefName,
    });
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
      reviewsComplete: true,
    });
    data.evaluations[0].status = "rejected";
    data.builds.get(20).result = "failed";
    const first = await run(data);
    expect(first.observation.sources[0].id).toBe("check:policy:1");
    data.builds.set(21, { ...data.builds.get(20), id: 21 });
    data.evaluations[0].context.buildId = 21;
    const retry = await run(data);
    expect(retry.observation.sources).toEqual(first.observation.sources);
    expect(retry.snapshot.actionableFingerprint).toBe(
      first.snapshot.actionableFingerprint,
    );
  });

  it("requires current iteration status, configured author and reset behavior", async () => {
    const data = fixtures();
    data.policies = [
      policy(POLICY_TYPES.status, {
        statusName: "tests",
        statusGenre: "ci",
        authorId: actorId,
        invalidateOnSourceUpdate: true,
      }),
    ];
    data.evaluations = [evaluation(data.policies[0])];
    data.iterationStatuses = [status()];
    data.statuses = [status()];
    expect((await run(data)).complete).toBe(true);
    data.iterationStatuses[0].createdBy.id = forkId;
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
    });
    data.iterationStatuses[0].createdBy.id = actorId;
    data.iterationStatuses[0].iterationId = 1;
    expect((await run(data)).error.code).toBe("stale_evidence");
    data.iterationStatuses = [];
    expect((await run(data)).observation).toMatchObject({
      complete: true,
      checksComplete: false,
    });
  });

  it("creates stable non-policy CI failure sources only from current-iteration failures", async () => {
    const data = fixtures();
    data.statuses = [{ ...status(), iterationId: 1, state: "failed" }];
    data.iterationStatuses = [status(4, "failed")];
    const first = await run(data);
    expect(first.observation.sources).toHaveLength(1);
    data.iterationStatuses[0].id = 8;
    data.iterationStatuses[0].updatedDate = finished;
    const second = await run(data);
    expect(second.observation.sources).toEqual(first.observation.sources);
    expect(second.snapshot.actionableFingerprint).toBe(
      first.snapshot.actionableFingerprint,
    );
  });

  it.each(["pending", "notSet"])(
    "retains latest non-policy %s status to prevent ready without creating a repair source",
    async (state) => {
      const data = fixtures();
      data.iterationStatuses = [
        status(1, "succeeded"),
        { ...status(2, state), updatedDate: finished },
      ];
      const result = await run(data);
      expect(result.observation).toMatchObject({
        complete: true,
        checksComplete: true,
        reviewsComplete: true,
      });
      expect(result.observation.checks).toContainEqual(
        expect.objectContaining({
          state: state === "pending" ? "pending" : "unknown",
          evidence: expect.stringContaining(`: ${state}.`),
        }),
      );
      expect(
        result.observation.checks.every((check: any) => check.state === "passed"),
      ).toBe(false);
      expect(result.observation.sources).toEqual([]);
    },
  );

  it.each([
    [
      ["ci", "unit/tests"],
      ["ci/unit", "tests"],
    ],
    [
      ["ci", "tests"],
      ["tests", "ci"],
    ],
  ])(
    "does not let a newer success in distinct context %j hide another context failure",
    async (failedContext, successfulContext) => {
      const data = fixtures();
      data.iterationStatuses = [
        {
          ...status(1, "failed"),
          context: { genre: failedContext[0], name: failedContext[1] },
        },
        {
          ...status(2, "succeeded"),
          updatedDate: finished,
          context: { genre: successfulContext[0], name: successfulContext[1] },
        },
      ];
      const result = await run(data);
      expect(result.complete).toBe(true);
      expect(result.observation.checks).toContainEqual(
        expect.objectContaining({ state: "failed" }),
      );
      expect(result.observation.sources).toHaveLength(1);
      expect(result.observation.sources[0].id).toBe(
        `check:status:${contentHash(JSON.stringify(failedContext))}`,
      );
      expect(result.observation.sources[0].id).not.toBe(
        `check:status:${contentHash(JSON.stringify(successfulContext))}`,
      );
    },
  );

  it("bounds derived status IDs for long provider context names", async () => {
    const data = fixtures();
    const context = ["genre".repeat(300), "name".repeat(300)];
    data.iterationStatuses = [
      { ...status(1, "failed"), context: { genre: context[0], name: context[1] } },
    ];
    const result = await run(data);
    expect(result.complete).toBe(true);
    expect(result.observation.sources[0].id).toBe(
      `check:status:${contentHash(JSON.stringify(context))}`,
    );
    expect(result.observation.sources[0].id.length).toBeLessThanOrEqual(512);
    expect(result.observation.sources[0].groupKey.length).toBeLessThanOrEqual(512);
  });

  it("retains unresolved feedback but blocks comment policy approval", async () => {
    const data = fixtures();
    data.policies = [policy(POLICY_TYPES.comments)];
    data.evaluations = [evaluation(data.policies[0])];
    data.threads = [thread()];
    const unresolved = await run(data);
    expect(unresolved.observation).toMatchObject({
      complete: true,
      checksComplete: false,
    });
    expect(unresolved.observation.sources).toHaveLength(1);
    data.threads[0].status = "fixed";
    expect((await run(data)).complete).toBe(true);
  });

  it.each([
    [401, "auth_required", "auth"],
    [403, "permission_denied", "permission"],
    [429, "rate_limited", "rate_limit"],
    [500, "network", "network"],
    [302, "network", "network"],
  ])(
    "counts and sanitizes HTTP %i failures without following Location",
    async (statusCode, code, failure) => {
      const result = await run(fixtures(), input(), () => ({
        status: statusCode,
        headers: { "retry-after": "3", location: "https://evil.invalid/token" },
        body: "Authorization: Bearer PRIVATE_TOKEN",
      }));
      expect(result.requestsConsumed).toBe(1);
      // 403 Retry-After is a documented throttling signal.
      expect(result.error.code).toBe(statusCode === 403 ? "rate_limited" : code);
      expect(result.observation.failure).toBe(
        statusCode === 403 ? "rate_limit" : failure,
      );
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
      expect(result.snapshot).toBeUndefined();
    },
  );

  it("distinguishes ordinary permission failures and missing effective policy API", async () => {
    const forbidden = await run(fixtures(), input(), () => ({
      status: 403,
      headers: {},
      body: "private detail",
    }));
    expect(forbidden.observation.failure).toBe("permission");
    const unavailable = await run(fixtures(), input(), (call, _count, response) =>
      call.url.includes("/git/policy/configurations?")
        ? { status: 404, headers: {} }
        : response,
    );
    expect(unavailable.error.code).toBe("unsupported_policy");
    expect(unavailable.observation.failure).toBe("incomplete");
  });

  it("never leaks invalid input into durable helper state", async () => {
    const result = await run(
      fixtures(),
      input({ previousThreads: [{ secret: "DO_NOT_PERSIST" }] }),
    );
    expect(result.error.code).toBe("invalid_input");
    expect(result.observation.helperState.previousThreads).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_PERSIST");
  });

  it("sanitizes arbitrary transport exceptions even when they carry a recognized error code", async () => {
    const result = await observe(input(), {
      now,
      request: async () => {
        throw Object.assign(new Error("SECRET_TOKEN"), { code: "auth_required" });
      },
    });
    expect(result.requestsConsumed).toBe(1);
    expect(result.error.code).toBe("auth_required");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
  });

  it("bounds every wake and reserves a complete fresh verification, never partial verification credit", async () => {
    const data = fixtures();
    data.threads = [thread()];
    const limited = input({ budget: { ...input().budget, maxRequests: 10 } });
    const first = await run(data, limited);
    expect(first.complete).toBe(false);
    expect(first.requestsConsumed).toBe(9);
    expect(first.error.code).toBe("budget_exhausted");
    expect(first.progress.verifiedPages).toBe(0);
    expect(first.observation.helperState.resume).toEqual(first.resume);
    const resumed = await run(data, input({ resume: first.resume }));
    expect(resumed.complete).toBe(true);
    expect(resumed.requestsConsumed).toBe(10);
    const changed = await run(data, input({ resume: first.resume, generation: 2 }));
    expect(changed.error.code).toBe("invalid_resume");
    expect(changed.requestsConsumed).toBe(0);
    data.threads[0].comments[0].content = "edited between wakes";
    const edited = await run(data, input({ resume: first.resume }));
    expect(edited.error.code).toBe("inconsistent_snapshot");
    expect(edited.resume).toBeUndefined();
  });

  it("retains a large consolidated discovery continuation within the actual CLI byte allowance", async () => {
    const data = fixtures();
    data.threads = Array.from({ length: 27 }, (_, index) => ({
      ...thread([comment(1, `Finding ${index}: ${"detail ".repeat(800)}`)]),
      id: index + 1,
    }));
    const request = input({
      pr: { url: "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7" },
      budget: { ...input().budget, maxRequests: 10, maxBytes: 262_144 },
    });
    const first = await run(data, request, undefined, routeObservation);
    expect(first.error).toMatchObject({ code: "budget_exhausted" });
    expect(first).toMatchObject({
      complete: false,
      requestsConsumed: 9,
      progress: { phase: "verify", pages: 8, verifiedPages: 0, cursor: null },
      observation: { complete: false, checksComplete: false, reviewsComplete: false },
    });
    expect(first.snapshot).toBeUndefined();
    expect(first.observation.helperState.resume).toBeDefined();
    expect(first.resume).toEqual(first.observation.helperState.resume);
    const { calls: _calls, resume: _resume, ...wire } = first;
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(262_144);
    expect(Buffer.byteLength(JSON.stringify(first.resume))).toBeGreaterThan(131_072);
    const cli = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { main } from ${JSON.stringify(
          pathToFileURL(
            join(packageRoot(), "skills", "pr-maintenance", "github-snapshot.mjs"),
          ).href,
        )};
        await main(async input => input.fixture, result => result.observation);`,
      ],
      {
        input: JSON.stringify({ budget: request.budget, fixture: first }),
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 10_000,
      },
    );
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(2);
    const emitted = JSON.parse(cli.stdout);
    expect(emitted.error.code).toBe("budget_exhausted");
    expect(emitted.resume).toBeUndefined();
    expect(emitted.observation.helperState.resume).toEqual(first.resume);
    expect(Buffer.byteLength(cli.stdout)).toBeLessThanOrEqual(262_144);
    const stillTooSmall = await run(
      data,
      input({ ...request, resume: first.resume }),
      undefined,
      routeObservation,
    );
    expect(stillTooSmall).toMatchObject({
      complete: false,
      error: {
        code: "payload_overflow",
        limit: { kind: "bytes", stage: "snapshot", maximum: 262_144 },
      },
      observation: { complete: false, checksComplete: false, reviewsComplete: false },
    });
    expect(stillTooSmall.observation.helperState.resume).toBeDefined();
    expect(stillTooSmall.error.limit.actual).toBeGreaterThan(262_144);
    const resumed = await run(
      data,
      input({
        ...request,
        budget: { ...input().budget, maxBytes: 1_048_576 },
        resume: JSON.parse(JSON.stringify(stillTooSmall.observation.helperState.resume)),
      }),
      undefined,
      routeObservation,
    );
    expect(resumed.complete).toBe(true);
    expect(resumed.requestsConsumed).toBe(10);
    expect(resumed.snapshot.actionableSources).toHaveLength(27);
    expect(resumed.observation.sources).toHaveLength(27);
    expect(resumed.snapshot.actionableSources.map((source: any) => source.body)).toEqual(
      data.threads.map((entry) => entry.comments[0].content),
    );
    const changed = structuredClone(data);
    changed.threads[0].comments[0].content = "An edited obligation";
    const invalidated = await run(
      changed,
      input({ ...request, resume: first.resume }),
      undefined,
      routeObservation,
    );
    expect(invalidated.error.code).toBe("inconsistent_snapshot");
    expect(invalidated.observation.helperState.resume).toBeNull();
    expect(invalidated.snapshot).toBeUndefined();
  });

  it("preserves the pending page on real checkpoint byte overflow for a larger bounded continuation", async () => {
    const data = fixtures();
    data.threads = Array.from({ length: 12 }, (_, index) => ({
      ...thread([comment(1, `Finding ${index}: ${"details ".repeat(800)}`)]),
      id: index + 1,
    }));
    const maxBytes =
      Buffer.byteLength(
        JSON.stringify({
          status: 200,
          headers: {},
          body: { count: data.threads.length, value: data.threads },
        }),
      ) + 256;
    const first = await run(data, input({ budget: { ...input().budget, maxBytes } }));
    expect(first.error).toMatchObject({
      code: "payload_overflow",
      limit: { kind: "bytes", stage: "checkpoint", maximum: maxBytes },
    });
    expect(first.observation.helperState.resume.jobs[0].kind).toBe("threads");
    expect(first.snapshot).toBeUndefined();
    const resumed = await run(data, input({ resume: first.resume }));
    expect(resumed.complete).toBe(true);
    expect(resumed.requestsConsumed).toBeLessThanOrEqual(40);
    expect(resumed.snapshot.actionableSources).toHaveLength(12);
    expect(resumed.observation.sources).toHaveLength(12);
  });

  it("keeps a bounded continuation when only the final Host observation exceeds the byte allowance", async () => {
    const data = fixtures();
    data.threads = [thread([comment(1, "details ".repeat(1_500))])];
    const full = await run(data);
    expect(full.complete).toBe(true);
    const maxBytes = Buffer.byteLength(
      JSON.stringify({ ...full, observation: undefined, calls: undefined }),
    );
    const limited = await run(data, input({ budget: { ...input().budget, maxBytes } }));
    expect(limited.error).toMatchObject({
      code: "payload_overflow",
      limit: { kind: "bytes", stage: "output", maximum: maxBytes },
    });
    expect(limited.snapshot).toBeUndefined();
    expect(limited.observation.complete).toBe(false);
    expect(limited.observation.helperState.resume).toBeDefined();
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...limited, resume: undefined, calls: undefined }),
      ),
    ).toBeLessThanOrEqual(maxBytes);
    const resumed = await run(data, input({ resume: limited.resume }));
    expect(resumed.complete).toBe(true);
    expect(resumed.observation.sources).toHaveLength(1);
  });

  it("reports item overflow separately and never truncates accumulated comment obligations", async () => {
    const data = fixtures();
    data.threads = [1, 2].map((id) => ({
      ...thread(Array.from({ length: 101 }, (_, index) => comment(index + 1))),
      id,
    }));
    const result = await run(data);
    expect(result.error).toMatchObject({
      code: "payload_overflow",
      limit: { kind: "items", stage: "checkpoint", actual: 202, maximum: 200 },
    });
    expect(result.observation).toMatchObject({
      complete: false,
      checksComplete: false,
      reviewsComplete: false,
      sources: [],
      helperState: { resume: null },
    });
    expect(result.snapshot).toBeUndefined();
    expect(result.resume).toBeUndefined();
  });

  it("bounds combined Host sources without treating schema item overflow as a byte allowance problem", async () => {
    const data = fixtures();
    data.threads = [
      thread(Array.from({ length: 200 }, (_, index) => comment(index + 1))),
    ];
    data.iterationStatuses = [status(1, "failed")];
    const result = await run(data);
    expect(result.error).toMatchObject({
      code: "payload_overflow",
      limit: { kind: "items", stage: "observation", actual: 201, maximum: 200 },
    });
    expect(result.observation.complete).toBe(false);
    expect(result.observation.sources).toEqual([]);
    expect(result.observation.helperState.resume).toBeNull();
    expect(result.snapshot).toBeUndefined();
  });

  it("never carries verification credit when a full pass cannot fit the maximum request allowance", async () => {
    const data = fixtures();
    data.policies = Array.from({ length: 31 }, (_, index) => ({
      ...policy(),
      id: index + 1,
    }));
    data.evaluations = data.policies.map((config, index) => {
      const buildId = index + 20;
      data.builds.set(buildId, { ...build(), id: buildId });
      return {
        ...evaluation(config, "approved", { buildId }),
        evaluationId: `${String(index).padStart(8, "0")}-5555-4555-8555-555555555555`,
      };
    });
    const first = await run(data);
    expect(first).toMatchObject({
      complete: false,
      requestsConsumed: 40,
      progress: { phase: "verify", pages: 39, verifiedPages: 0 },
      error: { code: "budget_exhausted" },
    });
    const later = await run(data, input({ resume: first.resume }));
    expect(later).toMatchObject({
      complete: false,
      requestsConsumed: 1,
      progress: { phase: "verify", pages: 39, verifiedPages: 0 },
      error: { code: "budget_exhausted" },
    });
    expect(later.snapshot).toBeUndefined();
    expect(later.observation.checksComplete).toBe(false);
  });

  it("revalidates metadata before consuming scoped continuation", async () => {
    const data = fixtures();
    const first = await run(
      data,
      input({ budget: { ...input().budget, maxRequests: 2 } }),
    );
    expect(first.resume).toBeDefined();
    data.metadata.lastMergeSourceCommit.commitId = merge;
    const second = await run(data, input({ resume: first.resume }));
    expect(second.error.code).toBe("inconsistent_snapshot");
    expect(second.requestsConsumed).toBe(1);
  });

  it("resumes verification from zero after interrupted verification, not stale credit", async () => {
    const data = fixtures();
    let failed = false;
    const first = await run(data, input(), (call, count, response) => {
      if (call.url.includes("/threads?") && count === 2 && !failed) {
        failed = true;
        return { status: 503, headers: {} };
      }
      return response;
    });
    expect(first.resume.phase).toBe("verify");
    expect(first.resume.verified).toBeGreaterThan(0);
    data.iterations[0].description = "a previously verified page changed";
    const resumed = await run(data, input({ resume: first.resume }));
    expect(resumed.error.code).toBe("inconsistent_snapshot");
    expect(resumed.requestsConsumed).toBe(2);
  });

  it("handles documented ref cursors and offset policy-evaluation pages, comparing them again", async () => {
    const data = fixtures();
    data.policies = Array.from({ length: 100 }, (_, index) => ({
      ...policy(POLICY_TYPES.comments),
      id: index + 1,
      isEnabled: false,
    }));
    data.evaluations = data.policies.map((config, index) => ({
      ...evaluation(config, "queued"),
      evaluationId: `${String(index).padStart(8, "0")}-5555-4555-8555-555555555555`,
    }));
    const result = await run(data, input(), (call, _count, response) => {
      const url = new URL(call.url);
      if (
        url.pathname.endsWith("/refs") &&
        url.searchParams.get("filter") === "heads/FixCase"
      ) {
        if (!url.searchParams.has("continuationToken")) {
          return {
            ...response,
            headers: { "x-ms-continuationtoken": "opaque &$ token" },
            body: {
              count: 1,
              value: [{ name: "refs/heads/FixCase-other", objectId: merge }],
            },
          };
        }
        expect(url.searchParams.get("continuationToken")).toBe("opaque &$ token");
      }
      return response;
    });
    expect(result.complete).toBe(true);
    expect(
      result.calls.filter(
        (call: Call) => new URL(call.url).searchParams.get("$skip") === "100",
      ),
    ).toHaveLength(2);
  });

  it("rejects undocumented continuation and incomplete nested comments", async () => {
    const result = await run(fixtures(), input(), (call, _count, response) => {
      if (call.url.includes("/threads?"))
        response.headers["x-ms-continuationtoken"] = "do-not-guess";
      return response;
    });
    expect(result.error.code).toBe("unsupported_pagination");
    const data = fixtures();
    data.threads = [thread([comment(), comment(2)])];
    delete data.threads[0].comments;
    expect((await run(data)).error.code).toBe("malformed_response");
    data.threads = [thread([comment(), comment()])];
    expect((await run(data)).error.code).toBe("inconsistent_snapshot");
  });

  it("enforces zero requests, elapsed deadline, arrays and 1 MiB without success-shaped fallbacks", async () => {
    expect(
      (await run(fixtures(), input({ budget: { ...input().budget, maxRequests: 0 } })))
        .requestsConsumed,
    ).toBe(0);
    expect(
      (
        await run(
          fixtures(),
          input({ budget: { ...input().budget, deadlineAt: timestamp } }),
        )
      ).error.code,
    ).toBe("deadline_exhausted");
    const data = fixtures();
    data.threads = Array.from({ length: 201 }, (_, index) => ({
      ...thread(),
      id: index + 1,
    }));
    expect((await run(data)).error).toMatchObject({
      code: "payload_overflow",
      limit: { kind: "items", stage: "response", actual: 201, maximum: 200 },
    });
    const overflow = await run(fixtures(), input(), () => ({
      status: 200,
      body: "x".repeat(1_048_576),
      headers: {},
    }));
    expect(overflow.error.code).toBe("payload_overflow");
    expect(overflow.error.limit).toMatchObject({
      kind: "bytes",
      stage: "response",
      maximum: 1_048_576,
    });
    expect(overflow.requestsConsumed).toBe(1);
    let clock = started;
    const fixture = transport(fixtures());
    const timed = await observe(input(), {
      now: () => clock,
      request: async (call: Call) => {
        const response = await fixture.request(call);
        clock += 120_001;
        return response;
      },
    });
    expect(timed.error.code).toBe("deadline_exhausted");
    expect(timed.requestsConsumed).toBe(1);
  });

  it("emits protocol-valid CLI input errors with no az installation/authentication", () => {
    const child = spawnSync(process.execPath, [helper], {
      input: "{broken",
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toBe("");
    const result = JSON.parse(child.stdout);
    expect(result).toMatchObject({
      complete: false,
      requestsConsumed: 0,
      error: { code: "invalid_input" },
    });
    expect(PrMaintenanceObservationSchema.safeParse(result.observation).success).toBe(
      true,
    );
  });

  it("emits a zero-budget CLI observation without invoking Azure CLI", () => {
    const child = spawnSync(process.execPath, [helper], {
      input: JSON.stringify(
        input({
          budget: {
            ...input().budget,
            maxRequests: 0,
            deadlineAt: new Date(Date.now() + 120_000).toISOString(),
          },
        }),
      ),
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    expect(child.status).toBe(2);
    const result = JSON.parse(child.stdout);
    expect(result.error.code).toBe("budget_exhausted");
    expect(result.requestsConsumed).toBe(0);
    expect(result.resume).toBeUndefined();
    expect(PrMaintenanceObservationSchema.safeParse(result.observation).success).toBe(
      true,
    );
  });
});

describe("Azure CLI launcher contracts without executing az", () => {
  it("resolves az.cmd's Python entry point without shell syntax or user-controlled arguments", async () => {
    const existing = new Set([
      "C:\\Program Files\\Azure\\wbin\\az.cmd",
      "C:\\Program Files\\Azure\\python.exe",
    ]);
    const launcher = await resolveAzLauncher({
      platform: "win32",
      env: { PATH: "C:\\not-cli;C:\\Program Files\\Azure\\wbin" },
      exists: async (path: string) => existing.has(path),
    });
    expect(launcher.command).toBe("C:\\Program Files\\Azure\\python.exe");
    expect(launcher.args).toEqual([
      "-IBm",
      "azure.cli",
      "account",
      "get-access-token",
      "--resource",
      "499b84ac-1321-427f-aa17-267ca6975798",
      "--query",
      "accessToken",
      "--output",
      "tsv",
      "--only-show-errors",
    ]);
    await expect(
      resolveAzLauncher({
        platform: "win32",
        env: { PATH: "" },
        exists: async () => false,
      }),
    ).rejects.toMatchObject({ code: "cli_unavailable" });
    expect((await resolveAzLauncher({ platform: "linux" })).command).toBe("az");
  });

  it.each(["local_auth_unavailable", "cli_unavailable"])(
    "records local %s as a capability incident, not provider access denial",
    (code) => {
      const error = { code, message: "Sanitized local helper prerequisite failure" };
      const observation = toAdoHostObservation({
        complete: false,
        requestsConsumed: 1,
        elapsedMs: 10,
        progress: { phase: "metadata" },
        error,
      });
      expect(observation).toMatchObject({
        complete: false,
        failure: "capability",
        helperState: { error },
      });
    },
  );

  it.each([true, false])(
    "keeps fake CLI output private and uses bounded pipes, success=%s",
    async (success) => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      const promise = getAccessToken({
        timeoutMs: 1000,
        launcher: { command: "fixture", args: ["fixed"] },
        spawnProcess: (command: string, args: string[], options: any) => {
          expect(command).toBe("fixture");
          expect(args).toEqual(["fixed"]);
          expect(options.shell).toBe(false);
          expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
          expect(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL).toBe("no");
          return child;
        },
      });
      child.stdout.write("synthetic_token_no_credentials\n");
      child.stderr.write("must_not_appear_in_error");
      child.emit("close", success ? 0 : 1);
      if (success) expect(await promise).toBe("synthetic_token_no_credentials");
      else
        await expect(promise).rejects.toMatchObject({
          code: "local_auth_unavailable",
          message: expect.not.stringContaining("must_not_appear"),
        });
    },
  );

  it.each(["overflow", "timeout", "error"])(
    "bounds fake CLI %s without exposing stdout/stderr",
    async (mode) => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      const pending = getAccessToken({
        timeoutMs: 5,
        launcher: { command: "fixture", args: [] },
        spawnProcess: () => child,
      });
      if (mode === "overflow") child.stderr.write("private".repeat(10_000));
      if (mode === "error") child.emit("error", new Error("private credential"));
      await expect(pending).rejects.toMatchObject({
        code:
          mode === "overflow"
            ? "payload_overflow"
            : mode === "error"
              ? "cli_unavailable"
              : "timeout",
        message: expect.not.stringContaining("private"),
      });
    },
  );

  it.each(["redirect", "body-token", "header-token", "overflow", "success"])(
    "uses bounded HTTPS without redirects or token echo: %s",
    async (mode) => {
      let count = 0;
      const token = "synthetic_token_never_real";
      const pending = httpsRequest(
        {
          url: "https://dev.azure.com/example/Project/_apis/test",
          timeoutMs: 1000,
          maxBytes: 1024,
        },
        token,
        (url: URL, options: any, callback: (response: any) => void) => {
          count++;
          expect(url.host).toBe("dev.azure.com");
          expect(options.headers.Authorization).toBe(`Bearer ${token}`);
          const request = new EventEmitter() as any;
          request.destroy = () => undefined;
          queueMicrotask(() => {
            const response = new EventEmitter() as any;
            response.statusCode = mode === "redirect" ? 302 : 200;
            response.headers =
              mode === "redirect"
                ? { location: "https://evil.invalid/" }
                : mode === "header-token"
                  ? { "x-ms-continuationtoken": token }
                  : {};
            let destroyed = false;
            response.destroy = () => {
              destroyed = true;
            };
            callback(response);
            if (destroyed) return;
            response.emit(
              "data",
              Buffer.from(
                mode === "body-token"
                  ? token
                  : mode === "overflow"
                    ? "x".repeat(1025)
                    : "{}",
              ),
            );
            response.emit("end");
          });
          return request;
        },
      );
      if (mode === "redirect") expect(await pending).toMatchObject({ status: 302 });
      else if (mode === "success")
        expect(await pending).toMatchObject({ status: 200, body: "{}" });
      else
        await expect(pending).rejects.toMatchObject({
          code: mode === "overflow" ? "payload_overflow" : "malformed_response",
          message: expect.not.stringContaining(token),
        });
      expect(count).toBe(1);
    },
  );
});
