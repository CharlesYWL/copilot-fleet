// Synthetic provider transport only; native router, collector and CLI remain in use.
export const identity = {
  host: "github.com",
  repositoryId: "R_base",
  repository: "sample/repo",
  prNumber: 7,
  headRepositoryId: "R_fork",
  headRepository: "contributor/repo",
  headRef: "refs/heads/Fix",
  baseRepositoryId: "R_base",
  baseRepository: "sample/repo",
  baseRef: "refs/heads/main",
};

export function fixtureTransport(at) {
  const metadata = {
    id: "PR_7",
    number: 7,
    url: "https://github.com/sample/repo/pull/7",
    title: "Synthetic repair",
    body: "Approved baseline",
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    repository: { id: "R_base", nameWithOwner: "sample/repo" },
    headRepository: { id: "R_fork", nameWithOwner: "contributor/repo" },
    headRefName: "Fix",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    baseRef: { branchProtectionRule: null },
    commits: {
      nodes: [
        {
          commit: {
            oid: "a".repeat(40),
            message: "Repair",
            author: { user: { login: "worker" } },
          },
        },
      ],
    },
  };
  const calls = [];
  const connection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const request = async (args) => {
    if (args.host !== identity.host || args.timeoutMs <= 0 || args.timeoutMs > 15_000)
      throw new Error("Unexpected synthetic GitHub read scope or timeout.");
    calls.push(args);
    if (args.endpoint) {
      if (args.endpoint !== "repos/sample/repo/rules/branches/main?per_page=100")
        throw new Error(`Unexpected synthetic rules endpoint: ${args.endpoint}`);
      return { status: 200, body: [] };
    }
    const query = args.payload.query;
    if (/\bmutation\b/.test(query)) throw new Error("Read-only fixture.");
    if (query.includes("contexts(first:"))
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: metadata.headRefOid,
                        statusCheckRollup: { contexts: connection },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    for (const field of [
      "reviewThreads",
      "reviews",
      "comments",
      "reviewRequests",
      "timelineItems",
    ])
      if (query.includes(`${field}(first:`))
        return {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  [field]: connection,
                },
              },
            },
          },
        };
    return { status: 200, body: { data: { repository: { pullRequest: metadata } } } };
  };
  return { request, now: () => Date.parse(at), calls };
}
