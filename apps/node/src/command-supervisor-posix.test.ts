import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandSupervisorReadiness,
  prepareCommandProcess,
  readCommandProcessReceipt,
  type CommandProcessInput,
  type PreparedCommandProcess,
} from "./command-supervisor.js";

/**
 * The POSIX supervisor against real processes: suspended start, verified group
 * termination, output capture and the receipts the Node and Host rely on.
 */
const posix = describe.skipIf(process.platform === "win32");
const roots: string[] = [];
const commands: PreparedCommandProcess[] = [];
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function fixture() {
  const root = resolve(process.cwd(), `.command-supervisor-posix-${randomUUID()}`);
  roots.push(root);
  await mkdir(root);
  const cwd = join(root, "work space 'quoted' Ω");
  await mkdir(cwd);
  return { root, cwd };
}

function input(
  root: string,
  cwd: string,
  command: string,
  timeoutMs = 20_000,
): CommandProcessInput {
  return {
    executionId: randomUUID(),
    attemptId: randomUUID(),
    directory: join(root, `attempt-${randomUUID()}`),
    cwd,
    command,
    timeoutMs,
    startExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

async function start(value: CommandProcessInput) {
  const prepared = await prepareCommandProcess(value);
  commands.push(prepared);
  return prepared;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const command of commands.splice(0)) await command.cancel().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

posix("POSIX command supervisor", () => {
  it("reports verified posix-sh readiness", async () => {
    const ready = await commandSupervisorReadiness();
    expect(ready).toMatchObject({ supported: true, shells: ["posix-sh"] });
    expect(ready.shellPath).toMatch(/^\//);
  });

  it("runs only after release, in the requested cwd, and reports the exit status", async () => {
    const { root, cwd } = await fixture();
    const marker = join(root, "ran");
    const prepared = await start(
      input(root, cwd, `pwd; printf done > '${marker}'; echo oops >&2; exit 7`),
    );
    await delay(300);
    // Gated: nothing user-supplied has run before release.
    await expect(stat(marker)).rejects.toThrow();
    await prepared.release();
    const result = await prepared.result;
    expect(result).toMatchObject({
      exitCode: 7,
      reason: "exited",
      ownership: "quiescent",
      started: true,
      outcomeKnown: true,
      descendantCleanupForced: false,
    });
    expect(await readFile(marker, "utf8")).toBe("done");
    const directory = prepared.identity.directory;
    expect((await readFile(join(directory, "stdout.bin"), "utf8")).trim()).toBe(cwd);
    expect(await readFile(join(directory, "stderr.bin"), "utf8")).toBe("oops\n");
  });

  it("never runs user code when cancelled before release", async () => {
    const { root, cwd } = await fixture();
    const marker = join(root, "ran");
    const prepared = await start(input(root, cwd, `printf ran > '${marker}'`));
    await prepared.cancel();
    const result = await prepared.result;
    expect(result).toMatchObject({
      reason: "cancelled",
      started: false,
      ownership: "quiescent",
    });
    await expect(stat(marker)).rejects.toThrow();
    await expect(prepared.release()).rejects.toThrow();
  });

  it("kills background descendants when the root exits and records forced cleanup", async () => {
    const { root, cwd } = await fixture();
    const pidFile = join(root, "child.pid");
    const prepared = await start(
      input(root, cwd, `sleep 60 & echo $! > '${pidFile}'; exit 0`),
    );
    await prepared.release();
    const result = await prepared.result;
    const child = Number((await readFile(pidFile, "utf8")).trim());
    expect(result).toMatchObject({
      exitCode: 0,
      reason: "descendant_cleanup",
      descendantCleanupForced: true,
      ownership: "quiescent",
    });
    expect(alive(child)).toBe(false);
  });

  it("times out a running command and verifies the group is gone", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, "sleep 60", 500));
    await prepared.release();
    const result = await prepared.result;
    expect(result).toMatchObject({
      reason: "timed_out",
      timedOut: true,
      ownership: "quiescent",
      started: true,
    });
  });

  it("cancels a running command and resolves only after quiescence", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, "sleep 60"));
    await prepared.release();
    await delay(200);
    await prepared.cancel();
    expect((await prepared.result).ownership).toBe("quiescent");
  });

  it("starts stdin at EOF and keeps exact bytes", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, "cat; printf '\\303\\251\\000\\377'"));
    await prepared.release();
    expect((await prepared.result).exitCode).toBe(0);
    const bytes = await readFile(join(prepared.identity.directory, "stdout.bin"));
    expect([...bytes]).toEqual([0xc3, 0xa9, 0x00, 0xff]);
  });

  it("persists receipts the reader accepts and rejects a foreign directory", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, "true"));
    await prepared.release();
    await prepared.result;
    const receipt = await readCommandProcessReceipt(prepared.identity.directory);
    expect(receipt.identity?.root?.pid).toBeGreaterThan(0);
    expect(receipt.result?.ownership).toBe("quiescent");

    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await writeFile(
      join(foreign, "manifest.json"),
      await readFile(join(prepared.identity.directory, "manifest.json")),
    );
    await expect(readCommandProcessReceipt(foreign)).rejects.toThrow(/quarantine/);
  });

  it("does not let a failing script skip status capture", async () => {
    const { root, cwd } = await fixture();
    const prepared = await start(input(root, cwd, "set -e\nfalse\necho unreachable"));
    await prepared.release();
    const result = await prepared.result;
    expect(result.exitCode).toBe(1);
    expect(await readFile(join(prepared.identity.directory, "stdout.bin"), "utf8")).toBe(
      "",
    );
  });

  it("outlives a crashed Node, then stops the command and records parent loss", async () => {
    const { root, cwd } = await fixture();
    const pidFile = join(root, "sleep.pid");
    const value = input(root, cwd, `echo $$ > '${pidFile}'; exec sleep 60`);
    await writeFile(join(root, "parent-input.json"), JSON.stringify(value));
    const parent = spawn(
      process.execPath,
      ["--import", "tsx", PARENT_FIXTURE, join(root, "parent-input.json")],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((done, fail) => {
        parent.stdout!.once("data", () => done());
        parent.once("exit", (code) => fail(new Error(`Parent exited ${code}`)));
      });
      const sleeper = Number(
        await waitFor(async () => {
          try {
            return (await readFile(pidFile, "utf8")).trim() || null;
          } catch {
            return null;
          }
        }),
      );
      expect(alive(sleeper)).toBe(true);
      parent.kill("SIGKILL");
      // quiescent.json can land just before terminal.json; wait for the outcome.
      const receipt = await waitFor(async () => {
        const read = await readCommandProcessReceipt(value.directory);
        return read.result && read.result.reason !== "receipt_missing" ? read : null;
      });
      expect(receipt.result).toMatchObject({
        reason: "parent_lost",
        started: true,
        outcomeKnown: false,
        ownership: "quiescent",
      });
      expect(alive(sleeper)).toBe(false);
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL");
    }
  });
});

const PARENT_FIXTURE = fileURLToPath(
  new URL("./command-supervisor-posix-parent.fixture.ts", import.meta.url),
);

async function waitFor<T>(read: () => Promise<T | null>, timeout = 20_000): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await delay(30);
  }
  throw new Error("Disposable fixture did not reach its expected state.");
}
