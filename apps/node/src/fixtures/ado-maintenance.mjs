/* global URL */
// Synthetic provider shape only. No captured PR data or provider I/O.
import { observe } from "../../skills/pr-maintenance/snapshot.mjs";

export const identity = {
  provider: "azure-devops",
  host: "dev.azure.com",
  organization: "sample-org",
  project: "Sample Project",
  projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  repositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  repository: "Sample Project/Repo",
  headRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  headRepository: "Sample Project/Repo",
  headRef: "refs/heads/Fix",
  baseRepositoryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  baseRepository: "Sample Project/Repo",
  baseRef: "refs/heads/main",
  prNumber: 17,
};

export function fixtureInput(at, maxRequests = 39) {
  return {
    schemaVersion: 1,
    generation: 1,
    pr: identity,
    budget: {
      maxRequests,
      maxBytes: 1_048_576,
      deadlineAt: new Date(Date.parse(at) + 120_000).toISOString(),
    },
  };
}

export function fixtureTransport(at, detailBytes = 0) {
  const operations = [];
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const timestamp = new Date(Date.parse(at) - 60_000).toISOString();
  const configuration = {
    id: 1,
    revision: 1,
    isEnabled: true,
    isBlocking: true,
    type: { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" },
    settings: {
      scope: [
        {
          repositoryId: identity.repositoryId,
          refName: identity.baseRef,
          matchKind: "Exact",
        },
      ],
    },
  };
  const threads = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    status: ["active", "fixed", "closed", "pending"][index % 4],
    publishedDate: timestamp,
    lastUpdatedDate: timestamp,
    isDeleted: false,
    comments: [1, 2].map((id) => ({
      id,
      parentCommentId: id === 1 ? 0 : 1,
      content: `Synthetic finding ${index}, comment ${id}. ${"x".repeat(detailBytes)}`,
      author: { id: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
      commentType: "text",
      publishedDate: timestamp,
      lastUpdatedDate: timestamp,
      lastContentUpdatedDate: timestamp,
    })),
  }));
  const request = async ({ url }) => {
    operations.push(url);
    const parsed = new URL(url);
    const path = parsed.pathname;
    let value;
    if (/\/pullRequests\/17$/.test(path))
      return {
        status: 200,
        body: {
          pullRequestId: 17,
          repository: {
            id: identity.repositoryId,
            name: "Repo",
            project: { id: identity.projectId, name: identity.project },
          },
          sourceRefName: identity.headRef,
          targetRefName: identity.baseRef,
          status: "active",
          isDraft: false,
          supportsIterations: true,
          title: "Synthetic repair",
          description: "Offline fixture",
          mergeStatus: "succeeded",
          reviewers: [],
          lastMergeSourceCommit: { commitId: head },
          lastMergeTargetCommit: { commitId: base },
          lastMergeCommit: { commitId: "d".repeat(40) },
        },
      };
    if (/\/iterations$/.test(path))
      value = [
        {
          id: 1,
          sourceRefCommit: { commitId: head },
          targetRefCommit: { commitId: base },
          createdDate: timestamp,
          updatedDate: timestamp,
        },
      ];
    else if (/\/refs$/.test(path)) {
      const isBase = parsed.searchParams.get("filter") === "heads/main";
      value = [
        {
          name: isBase ? identity.baseRef : identity.headRef,
          objectId: isBase ? base : head,
        },
      ];
    } else if (/\/threads$/.test(path)) value = threads;
    else if (/\/statuses$/.test(path)) value = [];
    else if (/\/configurations$/.test(path)) value = [configuration];
    else if (/\/evaluations$/.test(path))
      value = [
        {
          configuration,
          evaluationId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          artifactId: `vstfs:///CodeReview/CodeReviewId/${identity.projectId}/17`,
          status: "approved",
          context: {},
          startedDate: timestamp,
          completedDate: timestamp,
        },
      ];
    else throw new Error(`Unexpected synthetic endpoint: ${path}`);
    return { status: 200, body: { count: value.length, value } };
  };
  return {
    operations,
    threads,
    request,
    now: () => Date.parse(at),
    acquireToken: async () => {
      operations.push("token");
      return "synthetic-not-a-provider-credential";
    },
  };
}

export async function observeFixture(input, detailBytes = 0, padding = 0) {
  const at = new Date(Date.parse(input.budget.deadlineAt) - 120_000).toISOString();
  const fixture = fixtureTransport(at, detailBytes);
  fixture.threads[0].comments[0].content += "y".repeat(padding);
  return observe(input, fixture);
}
