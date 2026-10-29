import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpAgentFactory, type SessionAgent } from "./agents.js";

type FakeAgentPids = { agent: number; grandchild: number };

const FAKE_AGENT = fileURLToPath(
  new URL("./fixtures/fake-acp-agent.mjs", import.meta.url),
);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

/** A killed grandchild is reaped by init, not by us, so give it a moment. */
const waitUntilGone = async (pid: number, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
};

const readPids = async (file: string, timeoutMs = 10_000): Promise<FakeAgentPids> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as FakeAgentPids;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("The fake agent never reported its process IDs.");
};

describe.skipIf(process.platform === "win32")("POSIX agent process ownership", () => {
  let workDirectory: string | undefined;
  let agent: SessionAgent | undefined;
  let pids: FakeAgentPids | undefined;

  afterEach(async () => {
    await agent?.stop(false).catch(() => undefined);
    // Never leave a stray process behind, even when the assertion failed.
    for (const pid of [pids?.agent, pids?.grandchild]) {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    delete process.env.FLEET_FAKE_AGENT_PID_FILE;
    if (workDirectory) rmSync(workDirectory, { recursive: true, force: true });
    agent = undefined;
    pids = undefined;
    workDirectory = undefined;
  });

  it("stops the agent and every process it started", async () => {
    workDirectory = mkdtempSync(join(tmpdir(), "fleet-agent-group-"));
    const launcher = join(workDirectory, "copilot");
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    const pidFile = join(workDirectory, "pids.json");
    process.env.FLEET_FAKE_AGENT_PID_FILE = pidFile;

    const factory = new AcpAgentFactory(60_000, launcher, "default", 30_000);
    agent = await factory.start("session-process-group", workDirectory, () => {});
    pids = await readPids(pidFile);
    expect(isAlive(pids.agent)).toBe(true);
    expect(isAlive(pids.grandchild)).toBe(true);

    await agent.stop(false);

    expect(await waitUntilGone(pids.agent)).toBe(true);
    expect(await waitUntilGone(pids.grandchild)).toBe(true);
  }, 60_000);
});
