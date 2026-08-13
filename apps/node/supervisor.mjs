#!/usr/bin/env node
/**
 * Runs a Node and puts it back after it updates itself.
 *
 * A process cannot reliably replace itself on Windows. The version that tried
 * spawned a detached successor, which arrives with a console window of its own
 * and has to win a race for the instance lock against whatever the terminal is
 * already running. Under `tsx watch` it lost that race every time: the pull
 * changed the source, the watcher restarted its own child, and the successor
 * found the lock taken and exited — a terminal that flashed open and vanished.
 *
 * This is the other half of that problem. The restart is performed by a process
 * that is guaranteed to still be alive, because it never had anything to do
 * with the update: it waits for the child, and if the child exits asking to
 * come back, starts another one. Nothing is detached, nothing is raced, and the
 * console stays where it was.
 *
 * Deliberately plain JavaScript and dependency-free: it has to start even when
 * the build it supervises does not.
 *
 * Usage:
 *   node supervisor.mjs [--dev] [-- <node args>]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Kept in step with `RESTART_EXIT_CODE` in src/updater.ts. */
const RESTART_EXIT_CODE = 75;

/**
 * A child that asks to restart faster than this is not making progress.
 *
 * Restarting forever would turn a bad build into a machine that spins, so the
 * supervisor gives up and says why instead.
 */
const RESTART_STORM_WINDOW_MS = 20_000;
const RESTART_STORM_LIMIT = 5;

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "..", "..");

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const childArgs = argv.filter((argument) => argument !== "--dev");

const log = (message) =>
  console.log(`${new Date().toISOString()} [supervisor] ${message}`);

/**
 * What to run, and whether it is there.
 *
 * Development goes through `tsx` so a checkout that has never been built still
 * starts; production runs the build. `tsx watch` is deliberately not used —
 * a watcher does not restart a child that exits, so an update under one leaves
 * the machine with nothing running.
 */
function resolveTarget() {
  if (dev) {
    const tsx = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    if (!existsSync(tsx)) {
      return { error: `tsx is not installed at ${tsx}; run npm install` };
    }
    return { args: [tsx, resolve(appRoot, "src", "main.ts")] };
  }
  const built = resolve(appRoot, "dist", "main.js");
  if (!existsSync(built)) {
    return { error: `${built} does not exist; run npm run build:node` };
  }
  return { args: [built] };
}

const target = resolveTarget();
if (target.error) {
  console.error(`${new Date().toISOString()} [supervisor] ${target.error}`);
  process.exit(1);
}

/**
 * The commit the checkout is on, or undefined if that cannot be established.
 *
 * Undefined is treated as "unchanged" everywhere it is used: a checkout this
 * cannot read is one the updater could not have moved either, so the safe
 * reading is that nothing happened.
 */
function headRevision() {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a clean exit was actually an update by a build too old to say so.
 *
 * The exit code contract is carried by the Node being supervised, so the very
 * first update on a machine is always performed by a build that predates it:
 * that build updates itself, logs that it is leaving for the supervisor, and
 * exits 0 because 0 is all it knows. Taking that at face value would read an
 * update as a clean stop and leave the machine with nothing running — silently,
 * which is worse than the crash this supervisor exists to prevent.
 *
 * A moved HEAD is the evidence that distinguishes the two, and it is only
 * consulted for exit code 0, so a crash stays a crash.
 */
function updatedWithoutSayingSo(code, revisionAtStart) {
  if (code !== 0 || !revisionAtStart) return false;
  const now = headRevision();
  if (!now || now === revisionAtStart) return false;
  log(
    `node exited cleanly but the checkout moved to ${now.slice(0, 12)}; ` +
      `treating that as an update from a build that predates the restart contract`,
  );
  return true;
}

let child;
let stopping = false;
const restarts = [];

function start() {
  // Read before the child runs, so an update it performs is a change against
  // this value rather than against whatever the checkout settled on later.
  const revisionAtStart = headRevision();
  child = spawn(process.execPath, [...target.args, ...childArgs], {
    cwd: repoRoot,
    // The supervisor owns the console, so the child can inherit it safely: the
    // handles outlive every restart, which is what the detached version could
    // not promise.
    stdio: "inherit",
    env: {
      ...process.env,
      // Tells the Node to exit for a restart rather than trying to spawn its
      // own successor.
      FLEET_RESTART_MODE: "exit",
    },
  });

  child.once("error", (error) => {
    console.error(
      `${new Date().toISOString()} [supervisor] failed to start node: ${error.message}`,
    );
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    child = undefined;
    if (stopping) return;
    if (signal) {
      log(`node stopped on ${signal}`);
      process.exit(0);
    }
    if (code !== RESTART_EXIT_CODE && !updatedWithoutSayingSo(code, revisionAtStart)) {
      // Anything other than a restart request is the child's business, not
      // this process's: crash recovery belongs to PM2 or a service manager,
      // which can also survive a reboot. Looping here would only hide the exit.
      process.exit(code ?? 0);
    }

    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && now - restarts[0] > RESTART_STORM_WINDOW_MS) {
      restarts.shift();
    }
    if (restarts.length >= RESTART_STORM_LIMIT) {
      console.error(
        `${new Date().toISOString()} [supervisor] node asked to restart ` +
          `${restarts.length} times in ${RESTART_STORM_WINDOW_MS / 1000}s; giving up`,
      );
      process.exit(1);
    }

    log("node exited for an update; starting the new build");
    start();
  });
}

/** Ctrl-C should stop the fleet Node, not orphan it behind a dead supervisor. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

log(`supervising ${dev ? "src/main.ts (tsx)" : "dist/main.js"}`);
start();
