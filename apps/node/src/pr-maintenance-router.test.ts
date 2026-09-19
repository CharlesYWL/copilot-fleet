import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PrMaintenanceObservationSchema } from "@fleet/protocol";
import { packageRoot } from "./paths.js";

const helper = join(packageRoot(), "skills", "pr-maintenance", "snapshot.mjs");
const { providerInput } = await import(pathToFileURL(helper).href);
const input = {
  schemaVersion: 1,
  generation: 1,
  budget: { maxRequests: 0, deadlineAt: "2030-01-01T00:00:00.000Z" },
};

describe("packaged PR provider router", () => {
  it("routes canonical/legacy ADO URLs and retains exact pins", () => {
    expect(
      providerInput({
        ...input,
        pr: {
          url: "https://example.visualstudio.com/Project/_git/Repo/pullrequest/7",
          repositoryId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          headRef: "refs/heads/Fix",
        },
      }),
    ).toMatchObject({
      ...input,
      pr: {
        provider: "azure-devops",
        host: "dev.azure.com",
        organization: "example",
        project: "Project",
        repo: "Repo",
        number: 7,
        headRef: "refs/heads/Fix",
      },
    });
  });

  it("takes a retained identity directly instead of requiring hand-translated JSON", () => {
    expect(
      providerInput({
        ...input,
        pr: {
          provider: "azure-devops",
          host: "dev.azure.com",
          organization: "example",
          project: "Project",
          repository: "Project/Repo",
          prNumber: 7,
        },
      }).pr,
    ).toMatchObject({ repo: "Repo", number: 7, project: "Project" });
    expect(
      providerInput({
        ...input,
        pr: {
          host: "github.com",
          repository: "owner/repo",
          prNumber: 3,
        },
      }).pr,
    ).toMatchObject({ provider: "github", owner: "owner", repo: "repo", number: 3 });
  });

  it("rejects mismatched provider/scope/number rather than silently retargeting", () => {
    const url = "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7";
    for (const pin of [
      { provider: "github" },
      { organization: "other" },
      { number: 8 },
      { prNumber: 8 },
      { repository: "Project/Other" },
    ])
      expect(() => providerInput({ ...input, pr: { url, ...pin } })).toThrow();
    expect(() => providerInput({ ...input, pr: { provider: "other" } })).toThrow();
    expect(() => providerInput({ ...input, pr: { host: "dev.azure.com" } })).toThrow();
  });

  it.each([
    "https://github.com/owner/repo/pull/3",
    "https://dev.azure.com/example/Project/_git/Repo/pullrequest/7",
  ])("returns a schema-valid bounded deferral without credentials for %s", (url) => {
    const result = spawnSync(process.execPath, [helper], {
      input: JSON.stringify({ ...input, pr: { url } }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(PrMaintenanceObservationSchema.parse(output.observation)).toMatchObject({
      complete: false,
      failure: "budget",
      requestsConsumed: 0,
    });
    expect(output).not.toHaveProperty("snapshot");
  });
});
