import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeUpdateStage } from "@fleet/protocol";
import {
  NODE_BUILD_SCRIPT,
  NODE_ENTRY_POINT,
  RESTART_EXIT_CODE,
  restartHandledBySupervisor,
  restartTarget,
  restartWouldRaceAWatcher,
  runningUnderTsx,
  updateCheckout,
  waitForParentExit,
  type CommandResult,
} from "./updater.js";

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
  const queuedAnswers = new Map(
    Object.entries(answers).map(([key, values]) => [key, [...values]]),
  );
  const run = (command: string, args: readonly string[]): Promise<CommandResult> => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    const queued = queuedAnswers.get(key)?.shift();
    return Promise.resolve(queued ?? { ok: true, output: "" });
  };
  return { run, calls };
}

const ok = (output = ""): CommandResult => ({ ok: true, output });

/** Every run has to answer the upstream lookup before it can reset onto it. */
const upstream = {
  "git rev-parse --abbrev-ref --symbolic-full-name @{u}": [ok("origin/main")],
};

describe("updateCheckout", () => {
  it("runs the shared update and builds only what a Node runs", async () => {
    // The steps themselves are covered where they live, in the protocol
    // package; what is the Node's own is which build it asks for.
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const stages: NodeUpdateStage[] = [];
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      report: (stage) => {
        stages.push(stage);
      },
      run,
    });

    expect(outcome).toEqual({ action: "restart", revision: "new222222222" });
    expect(calls.at(-1)).toBe(`npm run ${NODE_BUILD_SCRIPT}`);
    expect(NODE_BUILD_SCRIPT).toBe("build:node");
    expect(stages).toEqual(["checking", "pulling", "pulling", "installing", "building"]);
  });
});

describe("restartTarget", () => {
  it("prefers the build the update just produced", () => {
    // Re-running argv[1] looked equivalent and was not: under `tsx` that names
    // a TypeScript file, and `node` cannot load one — so the successor died on
    // startup the instant its parent stopped, leaving the machine with no Node
    // and nothing in the log to say why.
    const target = restartTarget(
      "/repo",
      "/repo/apps/node/src/main.ts",
      (path) => path === resolve("/repo", NODE_ENTRY_POINT),
    );
    expect(target).toBe(resolve("/repo", NODE_ENTRY_POINT));
  });

  it("falls back to the entry point this process was given", () => {
    const target = restartTarget("/repo", "/elsewhere/main.js", () => false);
    expect(target).toBe("/elsewhere/main.js");
  });

  it("reports nothing to launch rather than guessing", () => {
    expect(restartTarget("/repo", undefined, () => false)).toBeUndefined();
  });
});

describe("restartHandledBySupervisor", () => {
  it("lets a supervised node exit instead of launching its own successor", () => {
    expect(restartHandledBySupervisor({ FLEET_RESTART_MODE: "exit" })).toBe(true);
  });

  it("takes responsibility itself by default", () => {
    expect(restartHandledBySupervisor({})).toBe(false);
    expect(restartHandledBySupervisor({ FLEET_RESTART_MODE: "respawn" })).toBe(false);
  });
});

describe("runningUnderTsx", () => {
  it("sees the loader tsx puts on the command line", () => {
    expect(
      runningUnderTsx(["--require", "/repo/node_modules/tsx/dist/preflight.cjs"]),
    ).toBe(true);
  });

  it("is false for a plain node", () => {
    expect(runningUnderTsx([])).toBe(false);
    expect(runningUnderTsx(["--enable-source-maps"])).toBe(false);
  });
});

describe("restartWouldRaceAWatcher", () => {
  it("declines to replace a process a watcher is also restarting", () => {
    // The watcher's own child takes the instance lock while the successor is
    // still starting, so the successor loses and exits — an update that reports
    // success and leaves the machine on the build it just replaced.
    expect(restartWouldRaceAWatcher({}, ["--require", "/x/tsx/dist/preflight.cjs"])).toBe(
      true,
    );
  });

  it("leaves a supervised node alone, which also runs through tsx", () => {
    expect(
      restartWouldRaceAWatcher({ FLEET_RESTART_MODE: "exit" }, [
        "--require",
        "/x/tsx/dist/preflight.cjs",
      ]),
    ).toBe(false);
  });

  it("does not stand in the way of a plain unsupervised node", () => {
    expect(restartWouldRaceAWatcher({}, [])).toBe(false);
  });
});

describe("RESTART_EXIT_CODE", () => {
  it("matches the value the supervisor watches for", () => {
    // The supervisor is plain JavaScript so it can start when the build it
    // supervises cannot, which means it cannot import this constant. If the two
    // ever disagree, an update looks like a crash: the supervisor forwards the
    // exit instead of restarting, and the machine is left with no Node.
    const supervisor = readFileSync(
      resolve(import.meta.dirname, "..", "supervisor.mjs"),
      "utf8",
    );
    const declared = supervisor.match(/const RESTART_EXIT_CODE = (\d+);/);
    expect(declared?.[1]).toBe(String(RESTART_EXIT_CODE));
  });

  it("is distinct from a clean exit, so stopping is not mistaken for updating", () => {
    expect(RESTART_EXIT_CODE).not.toBe(0);
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
