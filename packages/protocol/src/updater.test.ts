import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStage } from "./index.js";
import {
  CHECKOUT_LOCK,
  applyUpdate,
  checkoutLockHolder,
  lockCheckout,
  readUpdateRecord,
  runCommand,
  updateCheckout,
  writeUpdateRecord,
  type CommandResult,
  type UpdateRecord,
} from "./updater.js";

const roots: string[] = [];

function temporary(prefix = "fleet-update-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function gitCheckout(): string {
  const root = temporary();
  mkdirSync(join(root, ".git"));
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
  const run = (
    command: string,
    args: readonly string[],
    _cwd?: string,
  ): Promise<CommandResult> => {
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
  const stages: UpdateStage[] = [];
  const report = (stage: UpdateStage) => {
    stages.push(stage);
  };
  const buildScript = "build:node";

  it("installs and builds before asking for a restart", async () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      report,
      run,
    });

    expect(outcome).toEqual({ action: "restart", revision: "new222222222" });
    // Building before the restart is the whole safety property: a checkout that
    // does not compile must leave the machine on the code it already had.
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git fetch --prune",
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
      "git reset --hard origin/main",
      "git rev-parse HEAD",
      "npm install --include=dev",
      "npm run build:node",
    ]);
    expect(stages).toEqual(["checking", "pulling", "pulling", "installing", "building"]);
  });

  it("builds whatever the installation names, so the Host can build everything", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    await updateCheckout({ repoRoot: gitCheckout(), buildScript: "build", report, run });
    // The Host runs the Node beside it from the same checkout, so a Host update
    // that built only the Host would restart that Node onto a stale build.
    expect(calls.at(-1)).toBe("npm run build");
  });

  it("does not restart a machine that was already current", async () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("same11111111"), ok("same11111111")],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      report,
      run,
    });

    expect(outcome).toEqual({ action: "none", reason: "Already up to date" });
    // Restarting anyway would drop the connection for no gain — and on "Update
    // all" it would do that to every machine that was already up to date.
    expect(calls).not.toContain("npm install --include=dev");
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
  });

  it("rebuilds an unchanged checkout when the running service is still on an older commit", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("new222222222222"), ok("new222222222222")],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      runningRevision: "old111111111",
      report,
      run,
    });

    expect(outcome).toEqual({ action: "restart", revision: "new222222222" });
    expect(calls.slice(-2)).toEqual(["npm install --include=dev", "npm run build:node"]);
  });

  it("accepts the abbreviated running revision when both the process and checkout are current", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("same11111111111"), ok("same11111111111")],
    });
    expect(
      await updateCheckout({
        repoRoot: gitCheckout(),
        buildScript,
        runningRevision: "same11111111",
        report,
        run,
      }),
    ).toEqual({ action: "none", reason: "Already up to date" });
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
  });

  it("retries a failed build even though the previous attempt already moved HEAD", async () => {
    const root = gitCheckout();
    const { run, calls } = scriptedRun({
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}": [
        ok("origin/main"),
        ok("origin/main"),
      ],
      "git rev-parse HEAD": [
        ok("old111111111111"),
        ok("new222222222222"),
        ok("new222222222222"),
        ok("new222222222222"),
      ],
      "npm run build:node": [{ ok: false, output: "tsc not found" }, ok()],
    });
    const options = {
      repoRoot: root,
      buildScript,
      runningRevision: "old111111111",
      report,
      run,
    };
    expect((await updateCheckout(options)).action).toBe("failed");
    expect(await updateCheckout(options)).toEqual({
      action: "restart",
      revision: "new222222222",
    });
    expect(calls.filter((call) => call === "npm run build:node")).toHaveLength(2);
  });

  it("rebuilds rather than claiming success when the running revision is unknown", async () => {
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("same11111111111"), ok("same11111111111")],
    });
    expect(
      (
        await updateCheckout({
          repoRoot: gitCheckout(),
          buildScript,
          runningRevision: "",
          report,
          run,
        })
      ).action,
    ).toBe("restart");
  });

  it("resets onto whichever branch the checkout tracks", async () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}": [ok("upstream/release")],
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    await updateCheckout({ repoRoot: gitCheckout(), buildScript, report, run });

    // Assuming origin/main would drag a machine parked on a release branch onto
    // a different one, which is a worse outcome than not updating it at all.
    expect(calls).toContain("git reset --hard upstream/release");
  });

  it("stops at a fetch that failed, leaving the checkout alone", async () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      ...upstream,
      "git fetch --prune": [{ ok: false, output: "Could not resolve host: github.com" }],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      report,
      run,
    });

    expect(outcome).toEqual({
      action: "failed",
      reason: "git fetch: Could not resolve host: github.com",
    });
    // Resetting onto a stale remote-tracking ref would report success while
    // moving the machine nowhere, or backwards.
    expect(calls).not.toContain("git reset --hard origin/main");
    expect(calls).not.toContain("npm run build:node");
  });

  it("stops when the branch has nothing to be reset onto", async () => {
    stages.length = 0;
    const { run, calls } = scriptedRun({
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}": [
        { ok: false, output: "no upstream configured for branch 'wip'" },
      ],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      report,
      run,
    });

    expect(outcome).toEqual({
      action: "failed",
      reason: "git rev-parse @{u}: no upstream configured for branch 'wip'",
    });
    expect(calls).not.toContain("npm run build:node");
  });

  it("keeps running the old build when the new one does not compile", async () => {
    stages.length = 0;
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
      "npm run build:node": [{ ok: false, output: "TS2345" }],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript,
      report,
      run,
    });

    expect(outcome).toEqual({
      action: "failed",
      reason: "npm run build:node: TS2345",
    });
  });

  it("refuses a directory that is not a git checkout", async () => {
    stages.length = 0;
    const root = temporary("fleet-plain-");
    const { run, calls } = scriptedRun({});

    expect(
      (await updateCheckout({ repoRoot: root, buildScript, report, run })).action,
    ).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("update records", () => {
  const record = (changes: Partial<UpdateRecord> = {}): UpdateRecord => ({
    updateId: "update-1",
    stage: "checking",
    detail: "Update requested",
    restartCommand: "npm run dev",
    revision: "",
    requestedAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    confirmRestart: "updater",
    ...changes,
  });

  it("round-trips through a directory that does not exist yet", () => {
    const path = join(temporary(), "data", "self-update.json");
    writeUpdateRecord(path, record({ stage: "building", updaterPid: 42 }));
    expect(readUpdateRecord(path)).toEqual(record({ stage: "building", updaterPid: 42 }));
  });

  it("reads nothing, rather than throwing, from a missing or foreign file", () => {
    const directory = temporary();
    expect(readUpdateRecord(join(directory, "absent.json"))).toBeUndefined();
    writeFileSync(join(directory, "foreign.json"), JSON.stringify({ stage: "sideways" }));
    expect(readUpdateRecord(join(directory, "foreign.json"))).toBeUndefined();
    writeFileSync(join(directory, "torn.json"), '{"updateId":');
    expect(readUpdateRecord(join(directory, "torn.json"))).toBeUndefined();
  });
});

describe("applyUpdate", () => {
  const clock = () => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 8, 24, 8, 0, tick++));
  };

  it("records every stage and finishes up to date once the restart has happened", async () => {
    const statusFile = join(temporary(), "self-update.json");
    writeUpdateRecord(statusFile, {
      updateId: "update-1",
      stage: "checking",
      detail: "Update requested",
      restartCommand: "npm run dev",
      revision: "",
      requestedAt: "2026-09-24T07:59:00.000Z",
      updatedAt: "2026-09-24T07:59:00.000Z",
      confirmRestart: "updater",
    });
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const restart = vi.fn(async () => {
      // The restart is what the new Host judges success by, so the record has
      // to say a restart began before the processes go away.
      expect(readUpdateRecord(statusFile)).toMatchObject({
        stage: "restarting",
        revision: "new222222222",
        restartRequestedAt: expect.any(String),
      });
      return undefined;
    });

    const final = await applyUpdate({
      statusFile,
      updateId: "update-1",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run dev",
      restart,
      now: clock(),
    });

    expect(restart).toHaveBeenCalledWith("new222222222");
    expect(final).toMatchObject({
      updateId: "update-1",
      stage: "up_to_date",
      detail: "Updated to new222222222",
      revision: "new222222222",
      // Kept from the Host's request, so the record still says when it was asked.
      requestedAt: "2026-09-24T07:59:00.000Z",
      updaterPid: process.pid,
    });
    expect(readUpdateRecord(statusFile)).toEqual(final);
  });

  it("finishes without restarting when there was nothing to update", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("same11111111111"), ok("same11111111111")],
    });
    const restart = vi.fn(async () => undefined);
    const final = await applyUpdate({
      statusFile,
      updateId: "update-2",
      checkout: {
        repoRoot: gitCheckout(),
        buildScript: "build",
        runningRevision: "same11111111",
        run,
      },
      restartCommand: "npm start",
      restart,
    });
    expect(restart).not.toHaveBeenCalled();
    expect(final).toMatchObject({ stage: "up_to_date", detail: "Already up to date" });
  });

  it("records a failed step and never restarts into it", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
      "npm run build": [{ ok: false, output: "TS2345" }],
    });
    const restart = vi.fn(async () => undefined);
    const final = await applyUpdate({
      statusFile,
      updateId: "update-3",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run dev",
      restart,
    });
    expect(restart).not.toHaveBeenCalled();
    expect(final).toMatchObject({ stage: "failed", detail: "npm run build: TS2345" });
  });

  it("reports a restart that did not happen instead of claiming the update", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const final = await applyUpdate({
      statusFile,
      updateId: "update-4",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run service -- host+node restart",
      restart: async () => "The Node login task did not start",
    });
    expect(final).toMatchObject({
      stage: "failed",
      detail: "The Node login task did not start",
      revision: "new222222222",
    });
  });

  it("turns a thrown restart into a failure the record can carry", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const final = await applyUpdate({
      statusFile,
      updateId: "update-5",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run dev",
      restart: async () => {
        throw new Error("spawn EPERM");
      },
    });
    expect(final).toMatchObject({ stage: "failed", detail: "spawn EPERM" });
  });
});

describe("the checkout lock", () => {
  it("gives one update the checkout and releases it afterwards", async () => {
    const root = gitCheckout();
    const seen: boolean[] = [];
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    await updateCheckout({
      repoRoot: root,
      buildScript: "build",
      report: () => {},
      run: (command, args, cwd) => {
        seen.push(existsSync(join(root, CHECKOUT_LOCK)));
        return run(command, args, cwd);
      },
    });
    expect(seen.every(Boolean)).toBe(true);
    expect(existsSync(join(root, CHECKOUT_LOCK))).toBe(false);
  });

  it("refuses while another live process is updating the same checkout", async () => {
    const root = gitCheckout();
    // The parent of this test run is alive and is not this process.
    writeFileSync(
      join(root, CHECKOUT_LOCK),
      JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }),
    );
    expect(checkoutLockHolder(root)).toMatchObject({ pid: process.ppid });
    const { run, calls } = scriptedRun({});
    const outcome = await updateCheckout({
      repoRoot: root,
      buildScript: "build",
      report: () => {},
      run,
    });
    expect(outcome.action).toBe("failed");
    expect(outcome.action === "failed" && outcome.reason).toContain(
      `process ${process.ppid}`,
    );
    expect(calls).toEqual([]);
    // Refusing leaves the holder's lock alone.
    expect(existsSync(join(root, CHECKOUT_LOCK))).toBe(true);
  });

  it("treats a recent lock it cannot read as somebody's", async () => {
    const root = gitCheckout();
    writeFileSync(join(root, CHECKOUT_LOCK), "");
    const { run, calls } = scriptedRun({});
    const outcome = await updateCheckout({
      repoRoot: root,
      buildScript: "build",
      report: () => {},
      run,
    });
    expect(outcome.action).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("takes over a lock nobody has touched in ten minutes, even under a live pid", () => {
    // A reused pid cannot fake the touches a live holder makes every half minute.
    const root = gitCheckout();
    const path = join(root, CHECKOUT_LOCK);
    writeFileSync(
      path,
      JSON.stringify({ pid: process.ppid, at: "2026-09-24T08:00:00.000Z" }),
    );
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path, old, old);
    expect(checkoutLockHolder(root)).toBeUndefined();
    const lock = lockCheckout(root);
    expect("release" in lock).toBe(true);
    if ("release" in lock) {
      lock.refresh();
      lock.release();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("releases only its own lock", () => {
    const root = gitCheckout();
    const lock = lockCheckout(root);
    if (!("release" in lock)) throw new Error("expected the lock");
    // Taken over by someone else after being judged stale.
    writeFileSync(
      join(root, CHECKOUT_LOCK),
      JSON.stringify({
        pid: process.ppid,
        at: new Date().toISOString(),
        token: "theirs",
      }),
    );
    lock.release();
    expect(existsSync(join(root, CHECKOUT_LOCK))).toBe(true);
  });
  it("takes over a lock whose owner is gone", () => {
    const root = gitCheckout();
    writeFileSync(
      join(root, CHECKOUT_LOCK),
      JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }),
    );
    expect(checkoutLockHolder(root)).toBeUndefined();
    const lock = lockCheckout(root);
    expect("release" in lock).toBe(true);
    if ("release" in lock) lock.release();
    expect(existsSync(join(root, CHECKOUT_LOCK))).toBe(false);
  });
});

describe("preserveLocalChanges", () => {
  it("checks again just before the reset, and resets nothing over edits", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git --no-optional-locks status --porcelain --untracked-files=no": [
        ok(" M package-lock.json\n M apps/host/src/server.ts"),
      ],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript: "build",
      preserveLocalChanges: true,
      report: () => {},
      run,
    });
    expect(outcome.action).toBe("failed");
    expect(outcome.action === "failed" && outcome.reason).toContain(
      "uncommitted changes to 1 tracked file (apps/host/src/server.ts)",
    );
    expect(calls.some((call) => call.startsWith("git reset"))).toBe(false);
    // After the fetch, so the gap before the reset is as short as it can be.
    expect(calls.indexOf("git fetch --prune")).toBeLessThan(
      calls.indexOf("git --no-optional-locks status --porcelain --untracked-files=no"),
    );
  });

  it("fails closed when git cannot say whether the checkout is clean", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git --no-optional-locks status --porcelain --untracked-files=no": [
        { ok: false, output: "fatal: index file corrupt" },
      ],
    });
    const outcome = await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript: "build",
      preserveLocalChanges: true,
      report: () => {},
      run,
    });
    expect(outcome.action).toBe("failed");
    expect(outcome.action === "failed" && outcome.reason).toContain(
      "fatal: index file corrupt",
    );
    expect(calls.some((call) => call.startsWith("git reset"))).toBe(false);
  });
  it("is not consulted for a Node, whose checkout is a deployment", async () => {
    const { run, calls } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    await updateCheckout({
      repoRoot: gitCheckout(),
      buildScript: "build:node",
      report: () => {},
      run,
    });
    expect(calls.some((call) => call.includes("status"))).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("runCommand on Windows", () => {
  it("will not join anything but plain words into npm's command line", async () => {
    await expect(runCommand("npm", ["run", "build&calc"], tmpdir())).resolves.toEqual({
      ok: false,
      output: 'refusing to pass "run build&calc" through a shell',
    });
  });
});
describe("applyUpdate confirmation and heartbeat", () => {
  it.each(["up_to_date", "failed"] as const)(
    "does not overwrite the Host's %s outcome while its restart command is still running",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const statusFile = join(temporary(), "self-update.json");
        const { run } = scriptedRun({
          ...upstream,
          "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
        });
        let settled!: UpdateRecord;
        const final = await applyUpdate({
          statusFile,
          updateId: "update-confirmed",
          checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
          restartCommand: "npm run service -- host+node restart",
          confirmRestart: "host",
          restart: async () => {
            settled = {
              ...readUpdateRecord(statusFile)!,
              stage,
              detail: "Outcome recorded by the serving Host",
            };
            writeUpdateRecord(statusFile, settled);
            await vi.advanceTimersByTimeAsync(60_000);
            return undefined;
          },
        });
        expect(readUpdateRecord(statusFile)).toEqual(settled);
        expect(final).toEqual(settled);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves a launched restart for the new Host to confirm", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const final = await applyUpdate({
      statusFile,
      updateId: "update-host",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run dev",
      confirmRestart: "host",
      restart: async () => undefined,
    });
    // Launching the command proves nothing about it; only a Host that is
    // serving can say the restart worked.
    expect(final).toMatchObject({
      stage: "restarting",
      confirmRestart: "host",
      revision: "new222222222",
    });
    expect(readUpdateRecord(statusFile)).toEqual(final);
  });

  it("does not overwrite a restart the new Host already confirmed", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const final = await applyUpdate({
      statusFile,
      updateId: "update-late",
      checkout: { repoRoot: gitCheckout(), buildScript: "build", run },
      restartCommand: "npm run service -- host+node restart",
      confirmRestart: "host",
      restart: async () => {
        // The Host came back and confirmed while the restart command was still
        // waiting on something it then gave up on.
        const current = readUpdateRecord(statusFile)!;
        writeUpdateRecord(statusFile, {
          ...current,
          stage: "up_to_date",
          detail: "Updated to new222222222",
        });
        return "The Node config UI URL was not reported within 60s";
      },
    });
    expect(final).toMatchObject({ stage: "up_to_date" });
    expect(readUpdateRecord(statusFile)?.stage).toBe("up_to_date");
  });
  it("keeps rewriting the record while a long step runs, so silence means death", async () => {
    const statusFile = join(temporary(), "self-update.json");
    const { run } = scriptedRun({
      ...upstream,
      "git rev-parse HEAD": [ok("old111111111111"), ok("new222222222222")],
    });
    const stamps = new Set<string>();
    let tick = 0;
    await applyUpdate({
      statusFile,
      updateId: "update-slow",
      checkout: {
        repoRoot: gitCheckout(),
        buildScript: "build",
        run: async (command, args, cwd) => {
          if (command === "npm" && args[0] === "install") {
            // A quiet install: no stage changes while it runs.
            for (let beat = 0; beat < 4; beat++) {
              await new Promise((done) => setTimeout(done, 15));
              const current = readUpdateRecord(statusFile);
              if (current?.stage === "installing") stamps.add(current.updatedAt);
            }
          }
          return run(command, args, cwd);
        },
      },
      restartCommand: "npm start",
      restart: async () => undefined,
      heartbeatMs: 5,
      now: () => new Date(Date.UTC(2026, 8, 24, 8, 0, 0, tick++)),
    });
    expect(stamps.size).toBeGreaterThan(1);
  });
});
