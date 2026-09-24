#!/usr/bin/env node
/**
 * Runs `npm run dev`, `npm run dev:tunnel` or `npm start`, and brings them back
 * after the Host updates itself.
 *
 * The Host cannot update itself from inside itself. Under `npm run dev` the file
 * watcher restarts it the moment the update rewrites its source, killing the
 * update halfway through; and in every mode the process that has to come back is
 * the one doing the asking. So the work happens here instead, in a process that
 * sits above the Host and its Node and takes no part in either: the Host asks
 * over a local socket, this pulls, installs and builds with the same code a Node
 * updates itself with, then stops everything it started and runs the same
 * command again — in the same terminal, with the same arguments, the way the
 * operator started it. A build that fails leaves the running processes alone.
 *
 * Plain JavaScript and dependency-free, like the Node's supervisor, so it starts
 * on a checkout that has never been built. The shared update code is loaded only
 * when an update is asked for.
 *
 * Usage (see package.json):
 *   node scripts/launcher.mjs <dev|dev:tunnel|start> [arguments for the Node...]
 */
import console from "node:console";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the Host reaches this launcher, and the proof it presents when it does. */
export const LAUNCHER_ENDPOINT_ENV = "FLEET_LAUNCHER_ENDPOINT";
export const LAUNCHER_TOKEN_ENV = "FLEET_LAUNCHER_TOKEN";
/** Which command this is, so the Host can say how it will come back. */
export const LAUNCHER_SCRIPT_ENV = "FLEET_LAUNCHER_SCRIPT";

/** The commands put under the launcher; each runs `<name>:bare` underneath. */
export const LAUNCHED_SCRIPTS = ["dev", "dev:tunnel", "start"];

/** The Host runs its Node from the same checkout, so both are built. */
export const HOST_BUILD_SCRIPT = "build";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A named pipe on Windows, a socket file elsewhere; unique to this launcher. */
export function launcherEndpoint(
  pid = process.pid,
  platform = process.platform,
  nonce = randomBytes(6).toString("hex"),
) {
  const name = `copilot-fleet-launcher-${pid}-${nonce}`;
  return platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** The command as the operator typed it. */
export function displayCommand(script) {
  return script === "start" ? "npm start" : `npm run ${script}`;
}

/**
 * The npm command that runs `<script>:bare`.
 *
 * Run through the npm CLI that started this launcher, by the same node, rather
 * than through the `npm.cmd` shim: a shim needs a shell on Windows, and a shell
 * would have to re-quote every argument meant for the Node.
 */
export function childCommand(
  script,
  args,
  { env = process.env, execPath = process.execPath, exists = existsSync } = {},
) {
  const npmArgs = ["run", `${script}:bare`, "--", ...args];
  const candidates = [
    env.npm_execpath,
    // Beside node.exe on Windows; under lib/ on a POSIX install.
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find(
    (candidate) => candidate && /npm-cli\.js$/i.test(candidate) && exists(candidate),
  );
  if (cli) return { command: execPath, args: [cli, ...npmArgs], shell: false };
  return process.platform === "win32"
    ? { command: "npm.cmd", args: npmArgs, shell: true }
    : { command: "npm", args: npmArgs, shell: false };
}

/** Equal-time comparison, so the token cannot be discovered a byte at a time. */
function tokenMatches(presented, expected) {
  if (typeof presented !== "string") return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const sleep = (milliseconds) =>
  new Promise((done) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
  });

/**
 * The launcher, with everything that touches the machine passed in so it can be
 * exercised without starting a real Host. `spawnChild` starts the command with
 * the environment it is given; the arguments for the Node are its business.
 */
export function createLauncher({
  script,
  root = checkoutRoot,
  env = process.env,
  platform = process.platform,
  endpoint = launcherEndpoint(process.pid, platform),
  token = randomBytes(24).toString("base64url"),
  spawnChild,
  stopTree,
  treeAlive = () => false,
  headRevision,
  loadUpdater = () => import("@fleet/protocol/updater"),
  log = (message) => console.log(`${new Date().toISOString()} [launcher] ${message}`),
  exit = (code) => process.exit(code),
  stopGraceMs = 10_000,
}) {
  const display = displayCommand(script);
  /** The running command, and a promise that settles when it has exited. */
  let child;
  /** HEAD when the command was last started: what its processes are running. */
  let revisionAtStart;
  let listening = false;
  let updating = false;
  let restarting = false;
  let stopping = false;
  let finished = false;
  /** Set when the command ended by itself while an update was running. */
  let pendingExit;

  const childEnv = () =>
    listening
      ? {
          ...env,
          [LAUNCHER_ENDPOINT_ENV]: endpoint,
          [LAUNCHER_TOKEN_ENV]: token,
          [LAUNCHER_SCRIPT_ENV]: script,
        }
      : { ...env };

  function finish(code) {
    if (finished) return;
    finished = true;
    if (listening) {
      server.close();
      if (platform !== "win32") rmSync(endpoint, { force: true });
    }
    exit(code);
  }

  function launch() {
    revisionAtStart = headRevision();
    const spawned = spawnChild(childEnv());
    const current = {
      process: spawned,
      exited: new Promise((done) => spawned.once("exit", () => done())),
    };
    child = current;
    spawned.once("error", (error) => {
      log(`could not start ${display}: ${error.message}`);
      if (child === current) child = undefined;
      finish(1);
    });
    spawned.once("exit", (code, signal) => {
      if (child === current) child = undefined;
      if (restarting) return;
      const status = code ?? (signal ? 1 : 0);
      // An update still running decides what happens next: it brings the
      // command back if it succeeds, and this exit is honoured if it does not.
      if (updating) {
        pendingExit = status;
        return;
      }
      finish(stopping ? 0 : status);
    });
  }

  /** Resolves once the command and everything it started are gone, or on timeout. */
  async function settled(current, milliseconds) {
    const deadline = Date.now() + milliseconds;
    const exited = await Promise.race([
      current.exited.then(() => true),
      sleep(milliseconds).then(() => false),
    ]);
    if (!exited) return false;
    // npm can exit ahead of what it started; a Host still holding its port
    // would make the new one fail to listen.
    while (treeAlive(current.process)) {
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
    return true;
  }

  /** Stops the command, forcefully if it does not go when asked. */
  async function stopChild(current) {
    stopTree(current.process, false);
    if (await settled(current, stopGraceMs)) return true;
    stopTree(current.process, true);
    return settled(current, stopGraceMs);
  }

  /** What `applyUpdate` calls once the new build is on disk. */
  async function restartChild() {
    if (stopping)
      return `The launcher is stopping; run ${display} again to start the new build`;
    restarting = true;
    try {
      const current = child;
      if (current && !(await stopChild(current))) {
        return `${display} did not stop, so the new build was not started; stop it and run ${display} again`;
      }
      if (stopping)
        return `The launcher is stopping; run ${display} again to start the new build`;
      pendingExit = undefined;
      launch();
      log(
        `started ${display} again on ${(revisionAtStart ?? "an unknown commit").slice(0, 12)}`,
      );
      return undefined;
    } finally {
      restarting = false;
    }
  }

  async function runUpdate(updater, { updateId, statusFile }) {
    log(
      `the Host asked for an update; pulling, installing and building before ${display} restarts`,
    );
    try {
      const record = await updater.applyUpdate({
        statusFile,
        updateId,
        checkout: {
          repoRoot: root,
          buildScript: HOST_BUILD_SCRIPT,
          // Often somebody's working copy as well as the running Host.
          preserveLocalChanges: true,
          ...(revisionAtStart ? { runningRevision: revisionAtStart } : {}),
          // The terminal is where somebody might be watching; say what runs.
          run: (command, commandArgs, cwd) => {
            log(`${command} ${commandArgs.join(" ")}`);
            return updater.runCommand(command, commandArgs, cwd);
          },
        },
        restartCommand: display,
        // Starting the command proves nothing about it; the new Host confirms
        // the restart once it is listening.
        confirmRestart: "host",
        restart: () => restartChild(),
      });
      log(
        record.stage === "restarting"
          ? `restarted ${display}; the new Host confirms the update once it is up`
          : `update ${record.stage === "failed" ? "failed" : "finished"}: ${record.detail}`,
      );
    } catch (error) {
      log(`update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      updating = false;
      if (!child && pendingExit !== undefined) finish(stopping ? 0 : pendingExit);
      else if (!child && stopping) finish(0);
    }
  }

  async function handleRequest(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false, error: "Malformed request" };
    }
    if (!tokenMatches(request?.token, token))
      return { ok: false, error: "Not authorised" };
    if (request.type !== "update") return { ok: false, error: "Unknown request" };
    if (
      typeof request.updateId !== "string" ||
      !request.updateId ||
      typeof request.statusFile !== "string" ||
      !isAbsolute(request.statusFile)
    ) {
      return { ok: false, error: "Malformed update request" };
    }
    if (stopping) return { ok: false, error: "The launcher is stopping" };
    if (updating) return { ok: false, error: "An update is already running" };
    updating = true;
    let updater;
    try {
      updater = await loadUpdater();
    } catch (error) {
      updating = false;
      return {
        ok: false,
        error: `The update code could not be loaded (${error instanceof Error ? error.message : String(error)}); run npm run build`,
      };
    }
    void runUpdate(updater, request);
    return { ok: true };
  }

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (buffer === undefined) return;
      buffer += chunk;
      if (buffer.length > 16_384) {
        buffer = undefined;
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = undefined;
      void handleRequest(line).then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });

  return {
    endpoint,
    token,
    /** Starts listening for the Host, then the command itself. */
    start() {
      const unavailable = (error) => {
        // The command still runs; only updating from the browser is lost, and
        // the Host says so when asked.
        log(`updates from the Host are unavailable: ${error.message}`);
        launch();
      };
      server.once("error", unavailable);
      server.listen(endpoint, () => {
        // Past this point an error concerns one connection, never the command.
        server.removeListener("error", unavailable);
        server.on("error", (error) => log(`update socket error: ${error.message}`));
        listening = true;
        if (platform !== "win32") {
          try {
            chmodSync(endpoint, 0o600);
          } catch {
            // The token still guards it.
          }
        }
        log(`running ${display}; an update from Settings restarts it here`);
        launch();
      });
    },
    /** Ctrl-C, a closed terminal, a stop request from elsewhere. */
    interrupt(signal) {
      stopping = true;
      const current = child;
      if (!current) {
        if (!updating && !restarting) finish(0);
        return;
      }
      if (platform !== "win32") {
        // Its own process group, so the signal has to be passed on to reach it.
        try {
          process.kill(-current.process.pid, signal);
        } catch {
          // Already gone.
        }
      } else if (signal !== "SIGINT") {
        // Windows delivers Ctrl-C to the whole console by itself; anything else
        // would otherwise leave the command running after this has gone.
        stopTree(current.process, true);
      }
      const timer = setTimeout(() => {
        if (child === current) stopTree(current.process, true);
      }, stopGraceMs);
      timer.unref?.();
    },
    /** For tests: what the command is running and whether it is updating. */
    state: () => ({ child: child?.process, revisionAtStart, updating, stopping }),
  };
}

function gitHead(root) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Every process the command started, not just the npm at the top of it. */
function stopProcessTree(child, force) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // There is no gentler signal for a console tree on Windows; Ctrl-C would
    // reach the launcher's own console too.
    spawnSync(
      win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Whether anything the command started is still running.
 *
 * Only POSIX can ask: the command is its own process group there. `taskkill /T`
 * has already waited for the whole tree on Windows.
 */
function processTreeAlive(child) {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function main(
  argv = process.argv.slice(2),
  { root = checkoutRoot, loadUpdater } = {},
) {
  const [script, ...args] = argv;
  if (!LAUNCHED_SCRIPTS.includes(script)) {
    console.error(
      `Usage: node scripts/launcher.mjs <${LAUNCHED_SCRIPTS.join("|")}> [arguments]`,
    );
    process.exitCode = 2;
    return undefined;
  }
  const launcher = createLauncher({
    script,
    root,
    ...(loadUpdater ? { loadUpdater } : {}),
    spawnChild: (childEnv) => {
      const command = childCommand(script, args);
      return spawn(command.command, command.args, {
        cwd: root,
        env: childEnv,
        stdio: "inherit",
        shell: command.shell,
        // Its own process group on POSIX, so a restart stops everything under it.
        detached: process.platform !== "win32",
      });
    },
    stopTree: stopProcessTree,
    treeAlive: processTreeAlive,
    headRevision: () => gitHead(root),
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => launcher.interrupt(signal));
  }
  launcher.start();
  return launcher;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
