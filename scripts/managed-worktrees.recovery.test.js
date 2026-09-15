import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeOperationRequestSchema } from "@fleet/protocol";
import { ManagedWorktrees } from "../apps/node/src/managed-worktrees.ts";
import { GitRunner, parseWorktreeRegistry } from "../apps/node/src/git-runner.ts";

const execute = promisify(execFile);
const cleanup = [];
const git = new GitRunner();
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = resolve(".mwi-test-work", randomUUID());
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await git.run(source, ["init", "-b", "target"]);
  for (const [name, value] of [
    ["user.name", "Fleet Recovery"],
    ["user.email", "recovery@example.invalid"],
    ["commit.gpgSign", "false"],
    ["core.autocrlf", "false"],
  ]) {
    await git.run(source, ["config", name, value]);
  }
  await writeFile(join(source, "same.txt"), "base\n");
  await git.run(source, ["add", "."]);
  await git.run(source, ["commit", "-m", "base"]);
  const remote = join(root, "remote.git");
  await git.run(root, ["init", "--bare", remote]);
  await git.run(source, ["remote", "add", "origin", remote]);
  await git.run(source, ["push", "origin", "target"]);
  const directory = join(root, "node");
  let manager = new ManagedWorktrees({ directory, nodeId: () => "node" });
  cleanup.push(() => manager.shutdown());
  const runId = randomUUID();
  const reserved = await manager.execute(
    WorktreeOperationRequestSchema.parse({
      operationId: randomUUID(),
      kind: "reserve",
      worktreeId: `tree-${runId}`,
      runId,
      sourcePlacementId: "source",
      workspaceId: "workspace",
      sourcePath: source,
      nodeId: "node",
      hostInstallationId: "host",
      expectedVersion: 0,
      generation: 1,
      actor: "test",
      policy: { freeSpaceFloorBytes: 0 },
    }),
  );
  expect(reserved.ok).toBe(true);
  const treeId = reserved.worktree.id;
  const request = (kind, extra = {}) => {
    const tree = manager.get(treeId);
    return WorktreeOperationRequestSchema.parse({
      ...reserved,
      operationId: randomUUID(),
      kind,
      runId,
      worktreeId: treeId,
      sourcePlacementId: "source",
      workspaceId: "workspace",
      sourcePath: source,
      nodeId: "node",
      hostInstallationId: "host",
      expectedVersion: tree.version,
      generation: 1,
      expectedPath: tree.path,
      expectedBranchRef: tree.branchRef,
      expectedBaseSha: tree.baseSha,
      integrationBaseRef: "refs/remotes/origin/target",
      integrationTargetRef: `refs/heads/dev/test/fleet-${runId.slice(0, 20)}`,
      integrationRemote: "origin",
      actor: "test",
      policy: { freeSpaceFloorBytes: 0 },
      ...extra,
    });
  };
  const crash = async (operation, mutation = 1, reconcileFirst = false) => {
    const preparation = reconcileFirst ? request("reconcile") : undefined;
    manager.close();
    const script = `
      import { ManagedWorktrees } from ${JSON.stringify(new URL("../apps/node/src/managed-worktrees.ts", import.meta.url).href)};
      const input = JSON.parse(process.argv[1]);
      let count = 0;
      const manager = new ManagedWorktrees({
        directory: input.directory, nodeId: () => "node",
        checkpoint(stage, request) {
          if (request.operationId === input.operation.operationId && stage === "git" && ++count === input.mutation) process.exit(86);
        },
      });
      if (input.preparation) {
        const reconciled = await manager.execute(input.preparation);
        if (!reconciled.ok) throw new Error(reconciled.error);
        input.operation.expectedVersion = manager.get(input.operation.worktreeId).version;
      }
      const result = await manager.execute(input.operation);
      await manager.shutdown();
      throw new Error("Expected a crash, got " + JSON.stringify(result));
    `;
    let code,
      detail = "";
    try {
      await execute(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          JSON.stringify({ directory, operation, mutation, preparation }),
        ],
        { cwd: process.cwd(), timeout: 60_000, windowsHide: true, maxBuffer: 32_000 },
      );
    } catch (error) {
      code = error.code;
      detail = error.stderr ?? error.message;
    }
    manager = new ManagedWorktrees({ directory, nodeId: () => "node" });
    expect(code, detail).toBe(86);
  };
  const act = (kind, extra) => manager.execute(request(kind, extra));
  return { source, tree: () => manager.get(treeId), request, crash, act };
}

describe("real Node process-death recovery", { timeout: 90_000 }, () => {
  it("reconciles create/remove after process death between Git mutation and acknowledgement", async () => {
    const fleet = await fixture();
    await fleet.crash(fleet.request("create"));
    const restored = await fleet.act("reconcile");
    expect(restored.error).toBe("");
    expect(restored.worktree.state).toBe("retained");
    const registry = parseWorktreeRegistry(
      (await git.run(fleet.source, ["worktree", "list", "--porcelain", "-z"])).stdout,
    );
    expect(
      registry.filter((entry) => entry.branch === fleet.tree().branchRef),
    ).toHaveLength(1);
    await fleet.crash(fleet.request("cleanup"));
    const removed = await fleet.act("reconcile");
    expect(removed.error).toBe("");
    expect(removed.worktree.state).toBe("removed");
    expect(
      (await git.run(fleet.source, ["rev-parse", "--verify", fleet.tree().branchRef]))
        .exitCode,
    ).toBe(0);
    expect(await readdir(join(fleet.source, ".git", "fleet-managed-locks-v1"))).toEqual(
      [],
    );
  });

  it("recovers a conflicted merge and an interrupted abort without resetting or deleting task data", async () => {
    const fleet = await fixture();
    expect((await fleet.act("create")).ok).toBe(true);
    await writeFile(join(fleet.tree().path, "same.txt"), "task\n");
    await git.run(fleet.tree().path, ["commit", "-am", "task"]);
    await writeFile(join(fleet.source, "same.txt"), "target\n");
    await git.run(fleet.source, ["commit", "-am", "target"]);
    await git.run(fleet.source, ["push", "origin", "target"]);
    const preview = (await fleet.act("integration_preview")).preview;
    const integration = fleet.request("integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
    });
    await fleet.crash(integration);
    expect(
      (
        await git.run(preview.target.path, ["diff", "--name-only", "--diff-filter=U"])
      ).stdout.trim(),
    ).toBe("same.txt");
    const restored = await fleet.act("reconcile");
    expect(restored.integration.state).toBe("needs_reconciliation");
    expect(restored.worktree.state).toBe("needs_reconciliation");
    expect(
      (
        await git.run(preview.target.path, ["diff", "--name-only", "--diff-filter=U"])
      ).stdout.trim(),
    ).toBe("same.txt");
    expect(await readFile(join(fleet.tree().path, "same.txt"), "utf8")).toBe("task\n");
    expect((await fleet.act("cleanup")).ok).toBe(false);
  });

  it("recognizes the exact owned merge commit after death before its receipt, without committing again", async () => {
    const fleet = await fixture();
    expect((await fleet.act("create")).ok).toBe(true);
    await writeFile(join(fleet.tree().path, "task.txt"), "task\n");
    await git.run(fleet.tree().path, ["add", "."]);
    await git.run(fleet.tree().path, ["commit", "-m", "task"]);
    const preview = (await fleet.act("integration_preview")).preview;
    const request = fleet.request("integrate", {
      previewId: preview.id,
      reviewedTaskSha: preview.taskSha,
      reviewedDiffIdentity: preview.diffIdentity,
      confirm: `MERGE ${preview.taskSha} INTO ${preview.targetRef}`,
      commit: true,
    });
    await fleet.crash(request, 2);
    const head = (
      await git.run(preview.target.path, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const restored = await fleet.act("reconcile");
    expect(restored.error).toBe("");
    expect(restored.integration.state).toBe("needs_reconciliation");
    expect(restored.worktree.state).toBe("needs_reconciliation");
    expect(
      (await git.run(preview.target.path, ["rev-parse", "HEAD"])).stdout.trim(),
    ).toBe(head);
    expect((await fleet.act("cleanup")).ok).toBe(false);
  });
});
