import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NodeUpdateStage } from "@fleet/protocol";
import { isProcessAlive } from "@fleet/protocol/runtime";

/**
 * Pulling, rebuilding and restarting the checkout this Node runs from.
 *
 * Updating four machines by hand made every protocol change a chore, and a
 * half-updated fleet is worse than an un-updated one: the Host and its Nodes
 * disagree about the message union and hang up on each other. This exists so a
 * change reaches every machine from one click.
 */

/** Names the pid of the process being replaced, so the successor can wait. */
export const UPDATE_PARENT_PID_ENV = "FLEET_UPDATE_PARENT_PID";

export type UpdateReport = (stage: NodeUpdateStage, detail: string) => void;

export type CommandResult = { ok: boolean; output: string };

export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

/** npm and git are `.cmd` shims on Windows, which `spawn` will not run directly. */
function platformCommand(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

export const runCommand: RunCommand = (command, args, cwd) => {
  const executable = command === "npm" ? platformCommand(command) : command;
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    // `npm.cmd` is a batch file; without a shell Windows refuses to execute it.
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output };
};

export type UpdateOptions = {
  repoRoot: string;
  report: UpdateReport;
  run?: RunCommand;
};

export type UpdateOutcome =
  | { action: "restart"; revision: string }
  | { action: "none"; reason: string }
  | { action: "failed"; reason: string };

/**
 * Brings the checkout up to date, stopping at the first step that fails.
 *
 * `--ff-only` is what keeps this safe to run unattended: a machine with local
 * commits or a dirty tree refuses to move rather than inventing a merge nobody
 * asked for, and says so.
 */
export function updateCheckout({
  repoRoot,
  report,
  run = runCommand,
}: UpdateOptions): UpdateOutcome {
  report("checking", "Inspecting the checkout");
  if (!existsSync(resolve(repoRoot, ".git"))) {
    return { action: "failed", reason: `${repoRoot} is not a git checkout` };
  }
  const before = run("git", ["rev-parse", "HEAD"], repoRoot);
  if (!before.ok) return { action: "failed", reason: `git rev-parse: ${before.output}` };

  report("pulling", "git pull --ff-only");
  const pull = run("git", ["pull", "--ff-only"], repoRoot);
  if (!pull.ok) return { action: "failed", reason: `git pull: ${pull.output}` };

  const after = run("git", ["rev-parse", "HEAD"], repoRoot);
  if (!after.ok) return { action: "failed", reason: `git rev-parse: ${after.output}` };
  if (after.output.trim() === before.output.trim()) {
    // Restarting anyway would drop the connection for no gain, and on "Update
    // all" it would do that to every machine that was already current.
    return { action: "none", reason: "Already up to date" };
  }

  report("installing", "npm install");
  const install = run("npm", ["install"], repoRoot);
  if (!install.ok) return { action: "failed", reason: `npm install: ${install.output}` };

  report("building", "npm run build:node");
  const build = run("npm", ["run", "build:node"], repoRoot);
  if (!build.ok)
    return { action: "failed", reason: `npm run build:node: ${build.output}` };

  return { action: "restart", revision: after.output.trim().slice(0, 12) };
}

/**
 * Starts the replacement process and detaches it.
 *
 * It has to outlive this one — the whole point is that nobody is at the
 * keyboard — so it is spawned detached and unref'd. The parent's pid travels in
 * the environment because the successor must not race it for the instance lock:
 * the Host would see the newcomer as a superseding connection and the machine
 * would end up with no Node at all.
 */
export function respawn(repoRoot: string, scriptPath: string): void {
  const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    cwd: repoRoot,
    detached: true,
    stdio: "inherit",
    env: { ...process.env, [UPDATE_PARENT_PID_ENV]: String(process.pid) },
  });
  child.unref();
}

/**
 * Waits for the process being replaced to let go of the instance lock.
 *
 * Bounded rather than indefinite: a parent that somehow never exits must not
 * leave the machine with a Node that waits forever, so the successor gives up
 * waiting and lets the lock decide.
 */
export async function waitForParentExit(
  pid: number,
  timeoutMs = 30_000,
  sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}
