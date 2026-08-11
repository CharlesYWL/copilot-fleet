import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeUpdateStage } from "@fleet/protocol";
import { updateCheckout, waitForParentExit, type CommandResult } from "./updater.js";

const roots: string[] = [];

function gitCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-update-"));
  mkdirSync(join(root, ".git"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Answers each command in order, so a test can fail whichever step it means to. */
function scriptedRun(answers: Record<string, CommandResult[]>) {
  const calls: string[] = [];
  const run = (command: string, args: readonly string[]): CommandResult => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const queued = answers[key]?.shift();
    return queued ?? { ok: true, output: "" };
  };
  return { run, calls };
}

const ok = (output = ""): CommandResult => ({ ok: true, output });

describe("updateCheckout", () => {
  const stages: NodeUpdateStage[] = [];
  const report = (stage: NodeUpdateStage) => {
    stages.push(stage);
  };

  it("installs and builds before asking for a restart", () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const outcome = updateCheckout({ repoRoot: gitCheckout(), report, run });

    expect(outcome).toEqual({ action: "restart", revision: "new222222222" });
    // Building before the restart is the whole safety property: a checkout that
    // does not compile must leave the machine on the code it already had.
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git pull --ff-only",
      "git rev-parse HEAD",
      "npm install",
      "npm run build:node",
    ]);
    expect(stages).toEqual(["checking", "pulling", "installing", "building"]);
  });

  it("does not restart a node that was already current", () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      "git rev-parse HEAD": [ok("same11111111"), ok("same11111111")],
    });
    const outcome = updateCheckout({ repoRoot: gitCheckout(), report, run });

    expect(outcome).toEqual({ action: "none", reason: "Already up to date" });
    // Restarting anyway would drop the connection for no gain — and on "Update
    // all" it would do that to every machine that was already up to date.
    expect(calls).not.toContain("npm install");
  });

  it("stops at a pull that would need a merge, leaving the build alone", () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      "git pull --ff-only": [{ ok: false, output: "Not possible to fast-forward" }],
    });
    const outcome = updateCheckout({ repoRoot: gitCheckout(), report, run });

    expect(outcome).toEqual({
      action: "failed",
      reason: "git pull: Not possible to fast-forward",
    });
    expect(calls).not.toContain("npm run build:node");
  });

  it("keeps running the old build when the new one does not compile", () => {
    stages.length = 0;
    const { run } = scriptedRun({
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
      "npm run build:node": [{ ok: false, output: "TS2345" }],
    });
    const outcome = updateCheckout({ repoRoot: gitCheckout(), report, run });

    expect(outcome).toEqual({
      action: "failed",
      reason: "npm run build:node: TS2345",
    });
  });

  it("refuses a directory that is not a git checkout", () => {
    stages.length = 0;
    const root = mkdtempSync(join(tmpdir(), "fleet-plain-"));
    roots.push(root);
    const { run, calls } = scriptedRun({});

    expect(updateCheckout({ repoRoot: root, report, run }).action).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("waitForParentExit", () => {
  it("returns as soon as the predecessor is gone", async () => {
    const sleep = vi.fn(async () => {});
    // A pid this process cannot signal reads as already exited.
    await expect(waitForParentExit(2 ** 30, 1_000, sleep)).resolves.toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up rather than leaving the machine without a node", async () => {
    const sleep = vi.fn(async () => {});
    // Waiting forever on a parent that never exits would be worse than racing
    // it for the lock: the machine would simply have no node running.
    await expect(waitForParentExit(process.pid, 0, sleep)).resolves.toBe(false);
  });
});
