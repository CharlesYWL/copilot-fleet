import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCommandStorage } from "./command-storage.js";
import { resolveRepositoryTarget } from "./repository-participation.js";
import { GitRunner } from "./git-runner.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-storage-budget-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("command storage and administration boundaries", () => {
  it("budgets binaries, scripts and compiler assets from zero-output attempts together with lifecycle headroom", async () => {
    const root = await fixture();
    for (const name of ["first", "second"]) {
      const attempt = join(root, name);
      await mkdir(join(attempt, "compiler"), { recursive: true });
      await writeFile(join(attempt, "supervisor.exe"), Buffer.alloc(400));
      await writeFile(join(attempt, "command.ps1"), Buffer.alloc(100));
      await writeFile(join(attempt, "compiler", "supervisor.cs"), Buffer.alloc(50));
      await writeFile(join(attempt, "stdout.bin"), "");
      await writeFile(join(attempt, "stderr.bin"), "");
    }
    await expect(
      assertCommandStorage(root, {
        budgetBytes: 1280,
        reserveBytes: 128,
        minFreeBytes: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCommandStorage(root, {
        budgetBytes: 1280,
        reserveBytes: 256,
        minFreeBytes: 1,
      }),
    ).rejects.toThrow("storage limit");
  });

  it("counts native attempt files independently of journal output rows", async () => {
    const root = await fixture();
    await mkdir(join(root, "attempt"));
    await writeFile(join(root, "attempt", "supervisor.exe"), Buffer.alloc(800));
    await expect(
      assertCommandStorage(root, {
        budgetBytes: 1024,
        reserveBytes: 100,
        minFreeBytes: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCommandStorage(root, {
        budgetBytes: 1024,
        reserveBytes: 300,
        minFreeBytes: 1,
      }),
    ).rejects.toThrow("storage limit");
  });

  it("does not follow storage links outside the controlled directory", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(
      outside,
      join(root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(assertCommandStorage(root)).rejects.toThrow("contains a link");
    await unlink(join(root, "outside"));
  });

  it("rejects Git administration and bare roots rather than creating a second lock namespace", async () => {
    const root = await fixture();
    const git = new GitRunner();
    await git.run(root, ["-c", "init.templateDir=", "init"]);
    await expect(resolveRepositoryTarget(join(root, ".git"))).rejects.toThrow(
      "working directory",
    );
    const bare = await fixture();
    await git.run(bare, ["-c", "init.templateDir=", "init", "--bare"]);
    await expect(resolveRepositoryTarget(bare)).rejects.toThrow("working directory");
    const plain = await fixture();
    expect((await resolveRepositoryTarget(plain)).git).toBe(false);
  });
});
