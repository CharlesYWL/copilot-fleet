import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import {
  UpdateStageSchema,
  errorMessage,
  updateFinished,
  withCopilotNote,
  type UpdateStage,
} from "./index.js";
import {
  copilotVersionFromOutput,
  envFilePath,
  isProcessAlive,
  nodeConfigDirectory,
  resolveCopilotCommand,
  spawnTarget,
  usesMockAgent,
} from "./runtime.js";

/**
 * Bringing a Fleet checkout up to date: the one procedure the Host and every
 * Node share.
 *
 * An update currently means "the tip of the branch this checkout tracks",
 * reached with git and rebuilt in place. Both services go through here rather
 * than running the steps themselves, so moving to released versions later is a
 * change to this module rather than to every caller of it.
 *
 * Node-only, behind its own entry point for the same reason as `./runtime`: the
 * browser bundle imports the protocol root.
 */

export type UpdateReport = (stage: UpdateStage, detail: string) => void;

export type CommandResult = { ok: boolean; output: string };

export type RunCommandOptions = {
  /**
   * Stop the command after this long and report it as failed. Unbounded when
   * absent: an install or a build takes as long as it takes.
   */
  timeoutMs?: number;
};

export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
  options?: RunCommandOptions,
) => Promise<CommandResult>;

/** What may be joined into a Windows command line: words, never shell syntax. */
const SHELL_SAFE = /^[A-Za-z0-9:._=-]+$/;

/**
 * An executable path an operator configured, which may hold spaces, a drive
 * colon and letters of any script, but nothing cmd.exe would act on — no `&`,
 * `|`, `<`, `>`, `^`, `%`, `!` or quote. `spawnTarget` quotes it.
 */
const SHELL_SAFE_PATH = /^[\p{L}\p{N}_ :.\\/()+~'@#$-]+$/u;

type Started = ChildProcess | { refused: string };

/** Joins a command line for a shell, refusing anything the shell would act on. */
function throughShell(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Started {
  // Joined rather than passed alongside the command because Node deprecates
  // the combination (DEP0190). The arguments are literals from this module
  // plus a script name, and anything else is refused outright.
  if (!args.every((argument) => SHELL_SAFE.test(argument))) {
    return { refused: `refusing to pass "${args.join(" ")}" through a shell` };
  }
  return spawn([command, ...args].join(" "), { ...options, shell: true });
}

/**
 * Starts one update step.
 *
 * `npm.cmd` is a batch file, which Windows will only run through a shell; git
 * is a real executable and never goes near one. That matters: git's arguments
 * include the name of the upstream branch, and a ref may contain `&` or `|` —
 * joined into a command line, that is a second command. Anything else is a
 * command an operator configured, such as their Copilot CLI, started the way
 * the Node starts it.
 */
function startCommand(command: string, args: readonly string[], cwd: string): Started {
  const options: SpawnOptions = { cwd, windowsHide: true };
  if (command === "git") return spawn(command, [...args], options);
  if (command === "npm") {
    return process.platform === "win32"
      ? throughShell("npm.cmd", args, options)
      : spawn(command, [...args], options);
  }
  // Nobody is at its prompt, so it is given nothing to wait on.
  const unattended: SpawnOptions = { ...options, stdio: ["ignore", "pipe", "pipe"] };
  const target = spawnTarget(command);
  if (!target.shell) return spawn(target.command, [...args], unattended);
  if (!SHELL_SAFE_PATH.test(command)) {
    return { refused: `refusing to run "${command}" through a shell` };
  }
  return throughShell(target.command, args, unattended);
}

/** Stops a step and whatever it started: a shell's child outlives the shell. */
function stopTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  spawn(
    win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { windowsHide: true, stdio: "ignore" },
  ).once("error", () => child.kill());
}

/**
 * Runs one update step without blocking the event loop.
 *
 * `spawnSync` was simpler but stopped a Node dead for the length of an
 * `npm install`, which outlasts the Host's heartbeat timeout: the Host decided
 * the Node had died and closed the socket mid-update, so the update it had just
 * asked for reported nothing and looked like a crash.
 *
 * A step that outlives its `timeoutMs` is stopped and reported at once, rather
 * than when its output closes: a shell's grandchild can hold that open long
 * after the shell itself is gone.
 */
export const runCommand: RunCommand = (command, args, cwd, { timeoutMs } = {}) =>
  new Promise((done) => {
    const child = startCommand(command, args, cwd);
    if ("refused" in child) {
      done({ ok: false, output: child.refused });
      return;
    }
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // A failing install can print megabytes; only the tail is ever shown.
      if (output.length > 64_000) output = output.slice(-32_000);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stopTree(child);
            const text = output.trim();
            done({
              ok: false,
              output: `timed out after ${timeoutMs / 1_000}s${text ? `: ${text}` : ""}`,
            });
          }, timeoutMs);
    timer?.unref();
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, output: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output: output.trim() });
    });
  });

export type UpdateOptions = {
  repoRoot: string;
  /**
   * The npm script that builds what this installation runs: `build:node` on a
   * Node, `build` for a Host, which also runs the Node started beside it.
   */
  buildScript: string;
  /** Captured when the process started, not the HEAD an earlier attempt moved. */
  runningRevision?: string;
  report: UpdateReport;
  run?: RunCommand;
  beforeMutation?: () => void | Promise<void>;
  forceRebuild?: boolean;
  /**
   * Refuse to reset over uncommitted changes to tracked files.
   *
   * Off for a Node, whose checkout is a deployment. On for a Host, whose
   * checkout is often somebody's working copy as well — and checked here, just
   * before the reset, rather than only when the update was asked for.
   */
  preserveLocalChanges?: boolean;
  /**
   * The Copilot CLI to bring up to date once the build has succeeded, the way
   * this installation's Node launches it. Absent: Copilot is left alone.
   */
  copilotCommand?: string;
};

/**
 * What became of the Copilot CLI an update was asked to bring up to date.
 *
 * Never a reason to stop: a Copilot that could not update keeps running the
 * version it had, and the update reports that alongside the Fleet result.
 */
export type CopilotUpdate =
  { ok: true; version: string; previousVersion?: string } | { ok: false; reason: string };

/** Longest a Copilot download may take before the update moves on without it. */
export const COPILOT_UPDATE_TIMEOUT_MS = 5 * 60_000;
/** Longest `copilot --version` may take; it answers in under a second. */
const COPILOT_VERSION_TIMEOUT_MS = 30_000;

/**
 * Copilot's own switch for its updates. An operator who set it to `false` has
 * pinned the Copilot this machine runs, and an update leaves it there.
 */
export const COPILOT_AUTO_UPDATE_ENV = "COPILOT_AUTO_UPDATE";

/** How spawn, and cmd.exe on Windows, say there is no such command. */
const NOT_FOUND = /\bENOENT\b|is not recognized as an internal or external command/i;

/** The last thing a failed command printed, which is where it says why. */
const lastLine = (output: string): string =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(-300) ?? "";

/**
 * Brings this machine's Copilot CLI up to date with `copilot update`.
 *
 * That command downloads the newest release into Copilot's own package cache,
 * and the next Copilot process starts on it — every session after this update.
 * Standalone installations (WinGet, Homebrew, the install script) do this; one
 * that runs Copilot as JavaScript from npm cannot, says so, and stays a manual
 * `npm install -g @github/copilot`.
 *
 * The version is read again afterwards rather than taken from the command's
 * words, because the version that now starts is the fact that matters.
 */
export async function updateCopilotCli(
  command: string,
  cwd: string,
  run: RunCommand = runCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CopilotUpdate> {
  if (env[COPILOT_AUTO_UPDATE_ENV]?.toLowerCase() === "false") {
    return {
      ok: false,
      reason: `${COPILOT_AUTO_UPDATE_ENV}=false pins the version on this machine`,
    };
  }
  const readVersion = () =>
    run(command, ["--version"], cwd, { timeoutMs: COPILOT_VERSION_TIMEOUT_MS });
  const before = await readVersion();
  if (!before.ok) {
    return {
      ok: false,
      reason: NOT_FOUND.test(before.output)
        ? `${command} was not found`
        : `${command} --version: ${lastLine(before.output) || "failed"}`,
    };
  }
  const updated = await run(command, ["update"], cwd, {
    timeoutMs: COPILOT_UPDATE_TIMEOUT_MS,
  });
  if (!updated.ok) {
    const npmInstall = /running js directly/i.test(updated.output)
      ? " (an npm installation; update it with npm install -g @github/copilot)"
      : "";
    return {
      ok: false,
      reason: `${command} update: ${lastLine(updated.output) || "failed"}${npmInstall}`,
    };
  }
  const version = copilotVersionFromOutput((await readVersion()).output);
  if (!version) {
    return { ok: false, reason: `${command} --version did not report a version` };
  }
  const previousVersion = copilotVersionFromOutput(before.output);
  return { ok: true, version, ...(previousVersion ? { previousVersion } : {}) };
}

/** One line for an operator: the Copilot CLI now in use, or why it is not newer. */
export function describeCopilotUpdate(result: CopilotUpdate): string {
  if (!result.ok) return `Copilot CLI was not updated: ${result.reason}`;
  if (!result.previousVersion) return `Copilot CLI is on ${result.version}`;
  return result.previousVersion === result.version
    ? `Copilot CLI ${result.version} is the latest`
    : `Copilot CLI updated from ${result.previousVersion} to ${result.version}`;
}

/**
 * The Copilot CLI the Node on this machine launches, for an updater that runs
 * outside it — the launcher, or the one-off task beside a login service — or
 * undefined when that Node runs the demo agent and launches none.
 *
 * Resolved the way that Node resolves it: its saved settings, then
 * `FLEET_COPILOT_COMMAND` from the environment or the checkout's `.env` (which
 * the Node loads and these updaters do not), then `copilot` on PATH.
 */
export function localNodeCopilotCommand(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = envFilePath(),
): string | undefined {
  const effective = { ...readEnvFile(envFile), ...env };
  if (usesMockAgent(effective)) return undefined;
  try {
    const saved = JSON.parse(
      readFileSync(join(nodeConfigDirectory(effective), "settings.json"), "utf8"),
    ) as { copilotCommand?: unknown };
    if (typeof saved.copilotCommand === "string") {
      return resolveCopilotCommand(saved.copilotCommand, effective);
    }
  } catch {
    // No Node has saved settings here; it would fall back the same way.
  }
  return resolveCopilotCommand(undefined, effective);
}

/** A `.env` file's variables, or none when there is no readable file. */
function readEnvFile(path: string): NodeJS.ProcessEnv {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export type UpdateOutcome =
  | { action: "restart"; revision: string; copilot?: CopilotUpdate }
  | { action: "none"; reason: string; copilot?: CopilotUpdate }
  | { action: "failed"; reason: string };

/** Names the branch this checkout tracks, the same one `git pull` would merge. */
const UPSTREAM_REF = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];

/**
 * The file that gives one update the checkout to itself.
 *
 * The Host and the Node beside it share a checkout, and each can be asked to
 * update it — from different processes, one of which may restart in the middle.
 * A file naming the updater is the one arrangement that survives both; it is
 * untracked, so the reset it guards leaves it where it is.
 *
 * It is created whole, by hard-linking a finished file into place, so nobody
 * can read it half-written and take it for abandoned. Its holder touches it
 * every half minute, and only a lock whose holder has exited — or that nobody
 * has touched in ten minutes, which a reused pid cannot fake — is taken over.
 */
export const CHECKOUT_LOCK = ".fleet-update.lock";
const CHECKOUT_LOCK_REFRESH_MS = 30_000;
const CHECKOUT_LOCK_STALE_MS = 10 * 60_000;

type LockHolder = { pid: number; at: string };
type LockState = { held: boolean; holder: LockHolder; token?: string };

function inspectLock(path: string, now = Date.now()): LockState | undefined {
  let touched: number;
  try {
    touched = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const fresh = now - touched < CHECKOUT_LOCK_STALE_MS;
  let owner: { pid?: unknown; at?: unknown; token?: unknown } | undefined;
  try {
    owner = JSON.parse(readFileSync(path, "utf8")) as typeof owner;
  } catch {
    owner = undefined;
  }
  if (typeof owner?.pid !== "number") {
    // Not a lock this module wrote whole. A recent one is still somebody's.
    return { held: fresh, holder: { pid: 0, at: new Date(touched).toISOString() } };
  }
  return {
    held: fresh && isProcessAlive(owner.pid),
    holder: {
      pid: owner.pid,
      at: typeof owner.at === "string" ? owner.at : new Date(touched).toISOString(),
    },
    ...(typeof owner.token === "string" ? { token: owner.token } : {}),
  };
}

/** Who is updating this checkout right now, if anyone other than this process is. */
export function checkoutLockHolder(repoRoot: string): LockHolder | undefined {
  const state = inspectLock(resolve(repoRoot, CHECKOUT_LOCK));
  return state?.held && state.holder.pid !== process.pid ? state.holder : undefined;
}

export type CheckoutLock = { release: () => void; refresh: () => void };

/** Takes the checkout for one update: the lock, or who has it already. */
export function lockCheckout(repoRoot: string): CheckoutLock | { heldBy: LockHolder } {
  const path = resolve(repoRoot, CHECKOUT_LOCK);
  const token = randomUUID();
  const staged = `${path}.${process.pid}.${token}`;
  writeFileSync(
    staged,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }),
    { mode: 0o600 },
  );
  const ours = () => inspectLock(path)?.token === token;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(staged, path);
        return {
          // Only its own: a lock judged stale and taken over is someone else's.
          release: () => {
            if (ours()) rmSync(path, { force: true });
          },
          refresh: () => {
            if (!ours()) return;
            const now = new Date();
            utimesSync(path, now, now);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const state = inspectLock(path);
        if (state?.held && state.holder.pid !== process.pid) {
          return { heldBy: state.holder };
        }
        // Its holder is gone; the update it guarded ended one way or another.
        rmSync(path, { force: true });
      }
    }
    return {
      heldBy: inspectLock(path)?.holder ?? { pid: 0, at: new Date().toISOString() },
    };
  } finally {
    rmSync(staged, { force: true });
  }
}

/**
 * Tracked files with changes nobody has committed, or why git could not say.
 *
 * `package-lock.json` alone does not count. `npm install` rewrites it by
 * itself, so an update could otherwise leave behind the change that refuses
 * the next one — and the reset puts the committed copy back before installing.
 */
export async function uncommittedFiles(
  repoRoot: string,
  run: RunCommand = runCommand,
): Promise<{ ok: true; files: string[] } | { ok: false; reason: string }> {
  const status = await run(
    "git",
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
    repoRoot,
  );
  // This check stands between a reset and somebody's work, so a checkout it
  // cannot read is not a clean one.
  if (!status.ok) {
    return {
      ok: false,
      reason: `Could not check ${repoRoot} for uncommitted changes (git status: ${status.output || "failed"})`,
    };
  }
  // `XY path`, or `XY old -> new` for a rename. Parsed rather than sliced at a
  // fixed column: the output arrives trimmed, which takes the leading space of
  // a first line such as ` M file` with it.
  const files = status.output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => /^[MTADRCU?! ]{1,2} (.+)$/.exec(line)?.[1] ?? line.trim())
    .map((path) => path.split(" -> ").at(-1) ?? path)
    .filter((path) => path !== "package-lock.json");
  return { ok: true, files };
}

export function describeUncommittedChanges(repoRoot: string, files: string[]): string {
  const named = files.slice(0, 3).join(", ") + (files.length > 3 ? ", …" : "");
  return `${repoRoot} has uncommitted changes to ${files.length} tracked file${
    files.length === 1 ? "" : "s"
  } (${named}). Updating resets the checkout and would discard them; commit or stash them first.`;
}

/**
 * Brings the checkout up to date, stopping at the first step that fails.
 *
 * The pull is a fetch followed by a hard reset onto the tracking branch rather
 * than `git pull`. `--ff-only` was the safer-looking choice and was the wrong
 * one in practice: nobody is at the keyboard when a Node updates, so a machine
 * that had picked up a local commit — a debug print committed months ago, a
 * merge someone started on the box — refused every update from then on and
 * stayed behind the rest of the fleet until a human logged in. A checkout that
 * runs Fleet is a deployment, not somewhere to keep work: the remote is what it
 * is supposed to be running, so local commits and local edits to tracked files
 * are discarded to get there (a Host asks for the edits to be kept; see
 * `preserveLocalChanges`).
 *
 * Untracked files survive, because `git reset --hard` only deletes the ones
 * standing where a tracked file has to go. That is deliberate — `.env` on that
 * machine is untracked, and cleaning it away would point the Node at a
 * different Host, or at none.
 *
 * Nothing is built until the checkout is where it should be, and nothing is
 * restarted here at all: a build that fails leaves the caller's processes
 * running the code they already had, which is the one property every caller
 * depends on.
 *
 * Given a `copilotCommand`, the Copilot CLI is brought up to date as the last
 * step — after a successful build, or on a checkout that was already current —
 * so the sessions this installation starts next run the newest Copilot as well
 * as the newest Fleet. Its result rides along with the outcome; it never turns
 * a good Fleet update into a failed one.
 */
export function updateCheckout({
  repoRoot,
  buildScript,
  runningRevision,
  report,
  run = runCommand,
  beforeMutation,
  forceRebuild = false,
  preserveLocalChanges = false,
  copilotCommand,
}: UpdateOptions): Promise<UpdateOutcome> {
  return (async () => {
    report("checking", "Inspecting the checkout");
    if (!existsSync(resolve(repoRoot, ".git"))) {
      return { action: "failed", reason: `${repoRoot} is not a git checkout` };
    }
    if (!SHELL_SAFE.test(buildScript)) {
      return { action: "failed", reason: `"${buildScript}" is not an npm script name` };
    }
    const lock = lockCheckout(repoRoot);
    if ("heldBy" in lock) {
      return {
        action: "failed",
        reason: `Another update of ${repoRoot} is running (process ${lock.heldBy.pid}, since ${lock.heldBy.at})`,
      };
    }
    // An install can outlast the staleness window; touching the lock is what
    // tells a competitor this update is still alive.
    const keepAlive = setInterval(() => {
      try {
        lock.refresh();
      } catch {
        // A lock that cannot be touched ages out; nothing else to do here.
      }
    }, CHECKOUT_LOCK_REFRESH_MS);
    keepAlive.unref();
    try {
      return await updateLocked();
    } finally {
      clearInterval(keepAlive);
      lock.release();
    }
  })();

  async function updateLocked(): Promise<UpdateOutcome> {
    const fleet = await updateFleet();
    if (fleet.action === "failed" || copilotCommand === undefined) return fleet;
    // Reported under an existing stage: an older Host or browser rejects one
    // it does not know, and this is still the work before the restart.
    report("building", `${copilotCommand} update`);
    const copilot = await updateCopilotCli(copilotCommand, repoRoot, run);
    return { ...fleet, copilot };
  }

  async function updateFleet(): Promise<UpdateOutcome> {
    const before = await run("git", ["rev-parse", "HEAD"], repoRoot);
    if (!before.ok) {
      return { action: "failed", reason: `git rev-parse: ${before.output}` };
    }

    await beforeMutation?.();
    report("pulling", "git fetch --prune");
    const fetched = await run("git", ["fetch", "--prune"], repoRoot);
    if (!fetched.ok) return { action: "failed", reason: `git fetch: ${fetched.output}` };

    // Asked rather than assumed to be origin/main: a machine parked on a
    // release branch must be reset onto that branch, not dragged onto another.
    // git's own message names the branch when there is no upstream at all.
    const upstream = await run("git", UPSTREAM_REF, repoRoot);
    if (!upstream.ok) {
      return { action: "failed", reason: `git rev-parse @{u}: ${upstream.output}` };
    }
    const target = upstream.output.trim();

    if (preserveLocalChanges) {
      const changed = await uncommittedFiles(repoRoot, run);
      if (!changed.ok) return { action: "failed", reason: changed.reason };
      if (changed.files.length > 0) {
        return {
          action: "failed",
          reason: describeUncommittedChanges(repoRoot, changed.files),
        };
      }
    }

    report("pulling", `git reset --hard ${target}`);
    const reset = await run("git", ["reset", "--hard", target], repoRoot);
    if (!reset.ok) {
      return { action: "failed", reason: `git reset --hard ${target}: ${reset.output}` };
    }

    const after = await run("git", ["rev-parse", "HEAD"], repoRoot);
    if (!after.ok) return { action: "failed", reason: `git rev-parse: ${after.output}` };
    const targetRevision = after.output.trim();
    const currentRevision = runningRevision?.trim() ?? before.output.trim();
    if (
      !forceRebuild &&
      targetRevision === before.output.trim() &&
      currentRevision &&
      targetRevision.startsWith(currentRevision)
    ) {
      return { action: "none", reason: "Already up to date" };
    }

    // TypeScript and the build toolchain are development dependencies. Machines
    // commonly set NODE_ENV=production or npm_config_omit=dev, so an unqualified
    // install can succeed while leaving `tsc` unavailable.
    report("installing", "npm install --include=dev");
    const install = await run("npm", ["install", "--include=dev"], repoRoot);
    if (!install.ok) {
      return {
        action: "failed",
        reason: `npm install --include=dev: ${install.output}`,
      };
    }

    report("building", `npm run ${buildScript}`);
    const build = await run("npm", ["run", buildScript], repoRoot);
    if (!build.ok) {
      return { action: "failed", reason: `npm run ${buildScript}: ${build.output}` };
    }

    return { action: "restart", revision: targetRevision.slice(0, 12) };
  }
}

/**
 * An update run by a process other than the one that asked for it.
 *
 * The Host cannot update itself from inside itself: under `npm run dev` the
 * file watcher restarts it the moment the reset rewrites its source, and as a
 * login service the restart has to come from outside the task being restarted.
 * So the work happens elsewhere — in the launcher, or in a one-off task — and
 * this file is how the Host, including the new Host that comes up afterwards,
 * learns how it went.
 */
export const UpdateRecordSchema = z.object({
  updateId: z.string().min(1),
  stage: UpdateStageSchema,
  detail: z.string().default(""),
  /** What brings the processes back, as a person would type it. */
  restartCommand: z.string().default(""),
  /** The commit the update landed on, once it has one. */
  revision: z.string().default(""),
  requestedAt: z.string(),
  /** Rewritten at least every heartbeat while the updater is working. */
  updatedAt: z.string(),
  /** When the restart began; only a Host started after it can be the new build. */
  restartRequestedAt: z.string().optional(),
  /**
   * Who records that the restart worked. The updater, when its restart waits
   * for the processes to come back; the Host, when the restart only launches
   * them and the new Host is the first thing that can know it is serving.
   */
  confirmRestart: z.enum(["updater", "host"]).default("updater"),
  /** The process doing the work, so a reader can tell a live update from a dead one. */
  updaterPid: z.number().int().positive().optional(),
  /**
   * What became of the Copilot CLI, as one line for the operator, once the
   * update has tried it. Kept apart from `detail` so the Host that confirms a
   * restart can still say it after replacing the detail with its own.
   */
  copilot: z.string().optional(),
});
export type UpdateRecord = z.infer<typeof UpdateRecordSchema>;

/** How often an updater rewrites its record, so silence means it has died. */
export const UPDATE_HEARTBEAT_MS = 30_000;

/** The record at `path`, or undefined when there is none or it cannot be read. */
export function readUpdateRecord(path: string): UpdateRecord | undefined {
  try {
    const parsed = UpdateRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the record in one step, so a reader never sees half of one.
 *
 * Retried briefly because Windows refuses to rename over a file that something
 * — a virus scanner, the Host reading it that instant — has open.
 */
export function writeUpdateRecord(path: string, record: UpdateRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify(UpdateRecordSchema.parse(record), null, 2)}\n`,
    { mode: 0o600 },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
      // A rename blocked by a reader clears within milliseconds.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export type ApplyUpdateOptions = {
  statusFile: string;
  updateId: string;
  checkout: Omit<UpdateOptions, "report">;
  restartCommand: string;
  /**
   * Brings the processes back on the build that was just made. Resolves to why
   * it could not, or undefined once it has.
   */
  restart: (revision: string) => Promise<string | undefined>;
  /** See {@link UpdateRecordSchema}; `updater` unless the restart only launches. */
  confirmRestart?: "updater" | "host";
  heartbeatMs?: number;
  now?: () => Date;
};

/**
 * Runs one update end to end and records every step of it at `statusFile`.
 *
 * The last thing written is a finished stage — `up_to_date` or `failed` — or,
 * when the Host is to confirm the restart, `restarting`, which only a Host
 * started after it may finish. A record left in any other stage, or one that
 * stops being rewritten, means the process running this died.
 */
export async function applyUpdate({
  statusFile,
  updateId,
  checkout,
  restartCommand,
  restart,
  confirmRestart = "updater",
  heartbeatMs = UPDATE_HEARTBEAT_MS,
  now = () => new Date(),
}: ApplyUpdateOptions): Promise<UpdateRecord> {
  const requested = readUpdateRecord(statusFile);
  const at = now().toISOString();
  let record: UpdateRecord = {
    updateId,
    stage: "checking",
    detail: "Inspecting the checkout",
    restartCommand,
    revision: "",
    requestedAt: requested?.updateId === updateId ? requested.requestedAt : at,
    updatedAt: at,
    confirmRestart,
    updaterPid: process.pid,
  };
  const write = (changes: Partial<UpdateRecord>): void => {
    record = { ...record, ...changes, updatedAt: now().toISOString() };
    writeUpdateRecord(statusFile, record);
  };
  write({});
  // An install or a build can run for minutes without a new stage to report.
  const heartbeat = setInterval(() => {
    try {
      write({});
    } catch {
      // The next stage write reports a record that cannot be written.
    }
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await proceed();
  } finally {
    clearInterval(heartbeat);
  }

  async function proceed(): Promise<UpdateRecord> {
    let outcome: UpdateOutcome;
    try {
      outcome = await updateCheckout({
        ...checkout,
        report: (stage, detail) => write({ stage, detail }),
      });
    } catch (error) {
      outcome = { action: "failed", reason: errorMessage(error) };
    }
    if (outcome.action === "failed") {
      write({ stage: "failed", detail: outcome.reason });
      return record;
    }
    const copilot = outcome.copilot ? describeCopilotUpdate(outcome.copilot) : undefined;
    if (outcome.action === "none") {
      write({
        stage: "up_to_date",
        detail: withCopilotNote(outcome.reason, copilot),
        ...(copilot ? { copilot } : {}),
      });
      return record;
    }

    write({
      stage: "restarting",
      detail: `Updated to ${outcome.revision}; restarting with ${restartCommand}`,
      revision: outcome.revision,
      restartRequestedAt: now().toISOString(),
      ...(copilot ? { copilot } : {}),
    });
    // Confirmation belongs to the new Host; a heartbeat must not replace its outcome.
    if (confirmRestart === "host") clearInterval(heartbeat);
    let failure: string | undefined;
    try {
      failure = await restart(outcome.revision);
    } catch (error) {
      failure = errorMessage(error);
    }
    const current = confirmRestart === "host" ? readUpdateRecord(statusFile) : undefined;
    if (current?.updateId === updateId && updateFinished(current.stage)) {
      record = current;
    } else if (failure) {
      write({ stage: "failed", detail: failure });
    } else if (confirmRestart === "updater") {
      write({
        stage: "up_to_date",
        detail: withCopilotNote(`Updated to ${outcome.revision}`, copilot),
      });
    }
    return record;
  }
}
