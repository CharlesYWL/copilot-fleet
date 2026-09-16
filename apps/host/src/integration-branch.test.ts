import { describe, expect, it } from "vitest";
import { integrationBranchSettings } from "./integration-branch.js";

describe("integration branch settings", () => {
  it("uses a readable task slug instead of an opaque run identifier", () => {
    expect(
      integrationBranchSettings({
        runId: "167e4deb-0d0a-4140-ba15-19abc893d01e",
        username: "sihanwang@microsoft.com",
        taskName: "SQL Endpoints Object Overview",
      }),
    ).toMatchObject({
      branchRef: "refs/heads/dev/sihanwang/sql-endpoints-object-overview",
      remote: "origin",
    });
  });

  it("normalizes unsafe names and bounds each branch segment", () => {
    const result = integrationBranchSettings({
      runId: "12345678-aaaa-bbbb-cccc-dddddddddddd",
      username: "  User.Name+Fleet@example.com ",
      taskName:
        "  Fix Object Overview / Permissions @{ Draft } with a very long descriptive suffix  ",
    });

    expect(result.branchRef).toBe(
      "refs/heads/dev/user-name-fleet/fix-object-overview-permissions-draft-with-a-ver",
    );
  });

  it("uses a stable short run fallback only when the task has no safe slug", () => {
    expect(
      integrationBranchSettings({
        runId: "12345678-aaaa-bbbb-cccc-dddddddddddd",
        username: "",
        taskName: "中文任务",
      }).branchRef,
    ).toBe("refs/heads/dev/operator/task-12345678");
  });

  it("adds a stable short suffix when another local run already owns the slug", () => {
    expect(
      integrationBranchSettings({
        runId: "167e4deb-0d0a-4140-ba15-19abc893d01e",
        username: "sihanwang",
        taskName: "SQL Endpoints Object Overview",
        existingBranchRefs: ["refs/heads/dev/sihanwang/sql-endpoints-object-overview"],
      }).branchRef,
    ).toBe("refs/heads/dev/sihanwang/sql-endpoints-object-overview-167e4deb");
  });

  it("preserves an explicitly supplied target branch", () => {
    expect(
      integrationBranchSettings({
        taskName: "Ignored",
        branchRef: "dev/custom/exact-target",
        existingBranchRefs: ["refs/heads/dev/custom/exact-target"],
      }).branchRef,
    ).toBe("refs/heads/dev/custom/exact-target");
  });
});
