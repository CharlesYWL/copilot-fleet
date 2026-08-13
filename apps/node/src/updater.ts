import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
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

/**
 * Set to `exit` when something else is responsible for restarting this Node —
 * PM2, NSSM, a systemd unit. Then an update stops the process instead of
 * launching its own successor, and the supervisor brings it back.
 */
export const RESTART_MODE_ENV = "FLEET_RESTART_MODE";

/**
 * The status a supervised Node exits with when it wants to come back.
 *
 * Distinct from 0 so a supervisor can tell "update me" apart from "I was asked
 * to stop", and restart only the first. 75 is `EX_TEMPFAIL` from sysexits.h,
 * which is close enough in spirit and unlikely to collide with anything the
 * process exits with on its own.
 */
export const RESTART_EXIT_CODE = 75;

export type UpdateReport = (stage: NodeUpdateStage, detail: string) => void;

export type CommandResult = { ok: boolean; output: string };

export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

/** npm and git are `.cmd` shims on Windows, which `spawn` will not run directly. */
function platformCommand(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

/**
 * Runs one update step without blocking the event loop.
 *
 * `spawnSync` was simpler but stopped this process dead for the length of an
 * `npm install`, which outlasts the Host's heartbeat timeout: the Host decided
 * the Node had died and closed the socket mid-update, so the update it had just
 * asked for reported nothing and looked like a crash.
 */
export const runCommand: RunCommand = (command, args, cwd) =>
  new Promise((done) => {
    const executable = command === "npm" ? platformCommand(command) : command;
    // `npm.cmd` is a batch file; without a shell Windows refuses to execute it.
    // The arguments are joined into the command rather than passed alongside it
    // because Node deprecates the combination (DEP0190) — it cannot know that
    // every argument here is a literal spelled out in this file, so it warns on
    // every update. They are, and none of them contains a space.
    const child =
      process.platform === "win32"
        ? spawn([executable, ...args].join(" "), { cwd, shell: true, windowsHide: true })
        : spawn(executable, [...args], { cwd, windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // A failing install can print megabytes; only the tail is ever shown.
      if (output.length > 64_000) output = output.slice(-32_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => done({ ok: false, output: error.message }));
    child.once("close", (code) => done({ ok: code === 0, output: output.trim() }));
  });

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
}: UpdateOptions): Promise<UpdateOutcome> {
  return (async () => {
    report("checking", "Inspecting the checkout");
    if (!existsSync(resolve(repoRoot, ".git"))) {
      return { action: "failed", reason: `${repoRoot} is not a git checkout` };
    }
    const before = await run("git", ["rev-parse", "HEAD"], repoRoot);
    if (!before.ok) {
      return { action: "failed", reason: `git rev-parse: ${before.output}` };
    }

    report("pulling", "git pull --ff-only");
    const pull = await run("git", ["pull", "--ff-only"], repoRoot);
    if (!pull.ok) return { action: "failed", reason: `git pull: ${pull.output}` };

    const after = await run("git", ["rev-parse", "HEAD"], repoRoot);
    if (!after.ok) return { action: "failed", reason: `git rev-parse: ${after.output}` };
    if (after.output.trim() === before.output.trim()) {
      // Restarting anyway would drop the connection for no gain, and on "Update
      // all" it would do that to every machine that was already current.
      return { action: "none", reason: "Already up to date" };
    }

    report("installing", "npm install");
    const install = await run("npm", ["install"], repoRoot);
    if (!install.ok) {
      return { action: "failed", reason: `npm install: ${install.output}` };
    }

    report("building", "npm run build:node");
    const build = await run("npm", ["run", "build:node"], repoRoot);
    if (!build.ok) {
      return { action: "failed", reason: `npm run build:node: ${build.output}` };
    }

    return { action: "restart", revision: after.output.trim().slice(0, 12) };
  })();
}

/** The entry point `npm run build:node` produces, relative to the checkout. */
export const NODE_ENTRY_POINT = "apps/node/dist/main.js";

/**
 * The script the successor should run.
 *
 * The build that just finished is the thing worth launching, and it is always
 * at the same place in the checkout. Re-running `process.argv[1]` looked
 * equivalent and was not: a Node started through `tsx` names a TypeScript file
 * there, which plain `node` cannot load, so the successor died on startup the
 * instant its parent stopped — leaving the machine with no Node and nothing in
 * the log to say why.
 */
export function restartTarget(
  repoRoot: string,
  fallback: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const built = resolve(repoRoot, NODE_ENTRY_POINT);
  if (exists(built)) return built;
  return fallback;
}

/** Whether something else is responsible for bringing this Node back. */
export function restartHandledBySupervisor(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[RESTART_MODE_ENV] === "exit";
}

/**
 * Whether this process is running through `tsx`.
 *
 * `tsx` puts its loader on the command line, so it is visible here whether it
 * was reached through `tsx watch` or a bare `tsx`. Under the supervisor this is
 * true as well — development runs through `tsx` — which is why callers pair it
 * with {@link restartHandledBySupervisor} rather than using it alone.
 */
export function runningUnderTsx(execArgv: readonly string[] = process.execArgv): boolean {
  return execArgv.some((argument) => argument.includes("tsx"));
}

/**
 * Whether replacing this process would fight a watcher for the instance lock.
 *
 * A Node started by `tsx watch` has a second process interested in the same
 * source: the update rewrites the files being watched, the watcher starts its
 * own child, and that child takes the instance lock while the successor is
 * still coming up. The successor then loses, reports that another node is
 * already running, and exits — the terminal that flashes open and vanishes.
 *
 * There is no version of a self-replacing restart that wins that race, so the
 * honest move is to decline it and say so. Running under the supervisor avoids
 * the situation entirely, which is why it is the supported way to do this.
 */
export function restartWouldRaceAWatcher(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  return !restartHandledBySupervisor(env) && runningUnderTsx(execArgv);
}

/**
 * Starts the replacement process and detaches it.
 *
 * It has to outlive this one — the whole point is that nobody is at the
 * keyboard — so it is spawned detached and unref'd. The parent's pid travels in
 * the environment because the successor must not race it for the instance lock:
 * the Host would see the newcomer as a superseding connection and the machine
 * would end up with no Node at all.
 *
 * Its output goes to a file rather than being inherited. Inheriting looked
 * friendlier — the new process kept logging into the same terminal — but those
 * handles belong to a console that goes away with the process being replaced,
 * and the first line the successor logged afterwards killed it with EPIPE. The
 * update reported success and left the machine with nothing running on it.
 *
 * Prefer running under the supervisor (`npm run node`) to any of this: a
 * detached successor on Windows gets its own console window, and a Node started
 * by a watcher has a second process racing it for the instance lock. This path
 * remains for a Node launched directly, with no supervisor to come back to.
 */
export function respawn(
  repoRoot: string,
  scriptPath: string,
  args: readonly string[] = process.argv.slice(2),
  logPath?: string,
): void {
  const output = logPath ? openLogFile(logPath) : "ignore";
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    detached: true,
    // Detaching on Windows hands the successor a console of its own, which
    // appears as a terminal that flashes open and shuts again the moment
    // anything goes wrong. Hiding it keeps the restart silent either way.
    windowsHide: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, [UPDATE_PARENT_PID_ENV]: String(process.pid) },
  });
  child.unref();
}

/** Truncating keeps the file to the run it describes rather than every run. */
function openLogFile(path: string): number | "ignore" {
  try {
    return openSync(path, "w");
  } catch {
    // A log nobody can write is not worth refusing to restart over.
    return "ignore";
  }
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
