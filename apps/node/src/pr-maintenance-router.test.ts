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
  it.each([
    { file: "github-snapshot.mjs", ado: false },
    { file: "snapshot.mjs", ado: false },
    { file: "ado-snapshot.mjs", ado: true },
    { file: "snapshot.mjs", ado: true },
  ])(
    "uses F5 runtime clock in the actual $file entrypoint (ADO=$ado) without provider I/O",
    ({ file, ado }) => {
      const host = Date.parse("2026-09-23T00:00:00.000Z");
      const nodeOffset = -60_000;
      const nodeNow = host + 150_000 + nodeOffset;
      const path = join(packageRoot(), "skills", "pr-maintenance", file);
      const context = {
        executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "a".repeat(64),
        claim: { recordId: "record", generation: 1, wakeId: "original" },
        budget: { deadlineAt: new Date(host + 120_000).toISOString(), requests: 39 },
        hostTime: new Date(host).toISOString(),
        preparedAt: new Date(host + nodeOffset).toISOString(),
        nodeTime: new Date(host + nodeOffset).toISOString(),
        hostClockOffsetMs: -nodeOffset,
        clockUncertaintyMs: 5_000,
        monotonicNs: "0",
      };
      const cli = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import child from "node:child_process";
      import https from "node:https";
      import { syncBuiltinESMExports } from "node:module";
      child.spawn = https.get = () => { throw new Error("Provider I/O is forbidden in this fixture."); };
      syncBuiltinESMExports();
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [${nodeNow}])); }
        static now() { return ${nodeNow}; }
      };
      process.hrtime.bigint = () => 150000000000n;
      process.argv[1] = ${JSON.stringify(path)};
      await import(${JSON.stringify(pathToFileURL(path).href)});
    `,
        ],
        {
          input: JSON.stringify({
            schemaVersion: 1,
            generation: 1,
            pr: ado
              ? {
                  provider: "azure-devops",
                  host: "dev.azure.com",
                  organization: "sample-org",
                  project: "Sample",
                  repo: "Repo",
                  number: 17,
                }
              : { host: "github.com", owner: "sample", repo: "repo", number: 7 },
            budget: {
              maxRequests: 39,
              maxBytes: 1_048_576,
              deadlineAt: context.budget.deadlineAt,
            },
          }),
          env: { ...process.env, FLEET_MAINTENANCE_CLOCK: JSON.stringify(context) },
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1_048_576,
        },
      );
      expect(cli.error).toBeUndefined();
      expect(cli.status, cli.stderr).toBe(2);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        complete: false,
        requestsConsumed: 0,
        elapsedMs: 0,
        error: { code: "deadline_exhausted" },
        observation: { attemptedAt: new Date(nodeNow).toISOString(), complete: false },
      });
    },
  );

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
