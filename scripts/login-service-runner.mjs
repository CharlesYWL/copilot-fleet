import console from "node:console";
import { execFile, spawn } from "node:child_process";
import { access, open, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve, win32 } from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { accountId, assertIdleNode, readManifest } from "./login-service.mjs";

export function frameRpc(request) {
  const body = JSON.stringify(request);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

export function rpcReader(onMessage) {
  let pending = Buffer.alloc(0);
  return (data) => {
    pending = Buffer.concat([pending, data]);
    if (pending.length > 1024 * 1024)
      throw new Error("Copilot status response is too large.");
    while (true) {
      const boundary = pending.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const length = Number(
        /^Content-Length:\s*(\d+)\s*$/im.exec(
          pending.subarray(0, boundary).toString("ascii"),
        )?.[1],
      );
      if (!Number.isInteger(length) || length < 0 || length > 1024 * 1024)
        throw new Error("Copilot status returned an invalid RPC header.");
      if (pending.length < boundary + 4 + length) return;
      const message = JSON.parse(
        pending.subarray(boundary + 4, boundary + 4 + length).toString("utf8"),
      );
      pending = pending.subarray(boundary + 4 + length);
      onMessage(message);
    }
  };
}

export async function commandCheck(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} status timed out; sign in manually and retry.`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else
        reject(
          new Error(
            `${command} status failed (exit ${code}); sign in with this Windows account and retry.`,
          ),
        );
    });
  });
}

async function waitForChildClose(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((done) => {
    const closed = () => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("close", closed);
      done(false);
    }, milliseconds);
    child.once("close", closed);
  });
}

export async function stopAuthenticationProcess(child) {
  child.stdin?.end();
  if (!child.pid || (await waitForChildClose(child, 3000))) return;
  if (process.platform === "win32") {
    // A .cmd launcher may own a Copilot child; terminate only this probe's tree.
    await new Promise((done, reject) => {
      execFile(
        win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
        (error) => {
          if (error && child.exitCode === null && child.signalCode === null)
            reject(error);
          else done();
        },
      );
    });
  } else child.kill("SIGKILL");
  if (!(await waitForChildClose(child, 5000)))
    throw new Error("The Copilot authentication probe did not terminate.");
}

export async function copilotStatus(command, shell = false, { timeoutMs = 60_000 } = {}) {
  const options = { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] };
  const args = ["--headless", "--stdio", "--no-auto-update"];
  const child = shell
    ? spawn(`${command.startsWith('"') ? command : `"${command}"`} ${args.join(" ")}`, {
        ...options,
        shell: true,
      })
    : spawn(command, args, options);
  let timer;
  try {
    const status = await new Promise((done, reject) => {
      timer = setTimeout(
        () => reject(new Error("Copilot authentication status timed out.")),
        timeoutMs,
      );
      const read = rpcReader((message) => {
        if (message.id === 1) done(message.error ? undefined : message.result);
      });
      child.stdout.on("data", (data) => {
        try {
          read(data);
        } catch (error) {
          reject(error);
        }
      });
      child.once("error", reject);
      child.stdin.once("error", () =>
        reject(new Error("Copilot authentication input closed.")),
      );
      child.once("exit", () =>
        reject(new Error("Copilot exited before authentication status was available.")),
      );
      child.stdin.write(
        frameRpc({ jsonrpc: "2.0", id: 1, method: "auth.getStatus", params: {} }),
      );
    });
    if (status?.isAuthenticated !== true || status.authType === "api-key") {
      throw new Error(
        "Copilot is not signed in to GitHub in this profile. Run copilot login and retry.",
      );
    }
    return { authenticated: true };
  } finally {
    clearTimeout(timer);
    await stopAuthenticationProcess(child);
  }
}

async function importNodeModule(manifest, file) {
  return import(
    pathToFileURL(join(manifest.repositoryPath, "apps", "node", "dist", file)).href
  );
}

async function loadCheckoutEnvironment(manifest) {
  const require = createRequire(join(manifest.repositoryPath, "package.json"));
  require("dotenv").config({ path: join(manifest.repositoryPath, ".env"), quiet: true });
}

export async function ensureNodeGithubAuth(manifest, { interactive = false } = {}) {
  const env = { ...process.env, ...manifest.environment };
  const require = createRequire(join(manifest.repositoryPath, "package.json"));
  require("dotenv").config({
    path: join(manifest.repositoryPath, ".env"),
    processEnv: env,
    quiet: true,
  });
  const { ensureGithubAuth } = await importNodeModule(manifest, "github-auth.js");
  await ensureGithubAuth({ env, interactive });
}

async function hostPortAvailable() {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid Host PORT.");
  const host = process.env.HOST || "127.0.0.1";
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", (error) =>
      reject(
        new Error(
          `Cannot listen on ${host}:${port}. Stop any manual Host first: ${error.message}`,
          { cause: error },
        ),
      ),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
}

export async function preflight(manifest) {
  await loadCheckoutEnvironment(manifest);
  if (manifest.kind === "host") {
    await access(
      join(manifest.repositoryPath, "apps", "host", "dist", "server", "server.js"),
    );
    await hostPortAvailable();
    return { ok: true, accountSid: manifest.accountSid, kind: "host" };
  }
  if (process.env.FLEET_MOCK_AGENT === "1")
    throw new Error("Login startup requires a real Node, not the mock agent.");
  const config = await importNodeModule(manifest, "config.js");
  const credentials = await config.loadCredentials();
  assertIdleNode(config.configDirectory());
  const { loadSettings } = await importNodeModule(manifest, "settings.js");
  const settings = await loadSettings();
  await ensureNodeGithubAuth(manifest);
  const { copilotSpawnTarget } = await importNodeModule(manifest, "copilot-launch.js");
  const target = copilotSpawnTarget(
    (manifest.environment?.FLEET_COPILOT_COMMAND ?? settings.copilotCommand) ||
      (process.platform === "win32" ? "copilot.exe" : "copilot"),
  );
  await copilotStatus(target.command, target.shell);
  if (
    process.env.FLEET_DEVTUNNEL_ID ||
    manifest.runtimeArgs.some((arg) => arg.startsWith("--devtunnel="))
  ) {
    await commandCheck("devtunnel", ["user", "show"]);
  }
  return {
    ok: true,
    accountSid: manifest.accountSid,
    kind: "node",
    ...(credentials ? { nodeId: credentials.nodeId } : {}),
  };
}

async function rotateLog(path) {
  try {
    if ((await stat(path)).size < 10 * 1024 * 1024) return;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await rename(path, `${path}.previous`);
}

const NODE_CRASH_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

/**
 * Asks the Windows login-task controller to start this runner again.
 *
 * `EX_TEMPFAIL`, as for the Node's update restart: another program asked the
 * workload to stop, and it should come back once that program is done. The
 * controller is PowerShell, not node.exe, so it can wait for an installer that
 * is replacing node.exe. Kept in step with windows-login-task.ps1.
 */
export const RELAUNCH_EXIT_CODE = 75;

/**
 * Console control events, which only another program can send a Windows login task.
 *
 * The task has no visible console, and `stop` ends it through Task Scheduler
 * without signalling it, so Ctrl+C or Ctrl+Break never means the operator
 * stopped it. Windows Restart Manager sends Ctrl+C to every node.exe before an
 * installer replaces it, as when winget upgrades Node.js.
 */
export const WINDOWS_INTERRUPT_SIGNALS = ["SIGINT", "SIGBREAK"];

/** How Windows reports a console process that Ctrl+C or Ctrl+Break ended. */
const STATUS_CONTROL_C_EXIT = 0xc000013a;

async function existingIdleNode(manifest) {
  const config = await importNodeModule(manifest, "config.js");
  const credentials = await config.loadCredentials();
  if (!credentials)
    throw new Error("Node identity is missing; refusing replacement enrollment.");
  assertIdleNode(config.configDirectory());
  return credentials.nodeId;
}

async function runRecoveringNode(
  manifest,
  entry,
  log,
  nodeId,
  {
    processManager,
    retryDelaysMs = NODE_CRASH_DELAYS_MS,
    signalSource = process,
    interruptSignals = [],
  },
) {
  const { spawnManagedProcess, stopProcessTree } =
    processManager ?? (await importNodeModule(manifest, "process-quiescence.js"));
  const output = log.createWriteStream({ autoClose: false });
  const interrupts = new Set(interruptSignals);
  let current;
  let cancelBackoff;
  let stopping;
  let logError;
  let fatalError;
  let exitCode = 0;
  output.on("error", (error) => {
    logError = error;
    current?.fail(error);
    cancelBackoff?.();
  });
  const record = (message) =>
    new Promise((done, reject) => {
      if (logError) return reject(logError);
      output.write(
        `${new Date().toISOString()} [login-recovery] ${message}\n`,
        (error) => (error ? reject(error) : done()),
      );
    });
  const signals = new Map();
  for (const signal of new Set(["SIGINT", "SIGTERM", ...interrupts])) {
    const handler = () => {
      stopping ??= signal;
      cancelBackoff?.();
      // stop() always resolves an outcome; the attempt below owns any failure.
      current?.stop();
    };
    signals.set(signal, handler);
    signalSource.on(signal, handler);
  }
  try {
    for (let attempt = 0; attempt <= retryDelaysMs.length && !stopping; attempt++) {
      if (attempt > 0 && (await existingIdleNode(manifest)) !== nodeId)
        throw new Error(
          "Node identity changed; refusing recovery with another identity.",
        );
      await record(`Starting attempt ${attempt + 1}/${retryDelaysMs.length + 1}.`);
      if (stopping) break;
      const child = spawnManagedProcess(
        manifest.nodePath,
        [entry, ...manifest.runtimeArgs],
        {
          cwd: manifest.repositoryPath,
          windowsHide: true,
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      let failure;
      let resolveFailure;
      const failed = new Promise((done) => {
        resolveFailure = done;
      });
      const streams = [child.stdout, child.stderr];
      const fail = (error) => {
        failure ??= error;
        resolveFailure({ error });
        // Keep consuming the proof-bearing stderr even if the log is broken.
        // Normal piping uses stream backpressure, never an in-memory log queue.
        for (const stream of streams) {
          stream.unpipe(output);
          stream.resume();
        }
      };
      const closed = new Promise((done) => {
        child.once("error", fail);
        child.once("close", (code, signal) => done({ code, signal }));
      });
      const drained = Promise.all(
        streams.map((stream) => finished(stream, { cleanup: true }).catch(fail)),
      );
      let quiescence;
      const stop = () =>
        (quiescence ??= Promise.resolve()
          .then(() => stopProcessTree(child, true))
          .then(
            () => undefined,
            (error) => {
              fail(error);
              return error;
            },
          ));
      current = { stop, fail };
      child.stdin.once("error", fail);
      child.stdin.end();
      for (const stream of streams) stream.pipe(output, { end: false });
      const result = await Promise.race([closed, failed]);
      if (!result.error) await drained;
      const cleanupError = await stop();
      current = undefined;
      if (cleanupError) {
        // No successor is allowed without proof. Release the wrapper handles
        // and let the outer task job contain this fatal action exit.
        try {
          child.kill();
        } finally {
          child.stdin.destroy();
          for (const stream of streams) stream.destroy();
          child.unref();
        }
        throw new Error(
          `Process-tree termination was not verified; refusing recovery: ${cleanupError.message}`,
          { cause: cleanupError },
        );
      }
      await drained;
      if (failure) throw failure;
      await record(
        `Attempt ${attempt + 1} exited (code=${result.code ?? "none"}, signal=${result.signal ?? "none"}); process tree verified terminated.`,
      );
      if (stopping) break;
      const clean = result.code === 0 && !result.signal;
      if (interrupts.size > 0 && (clean || result.code === STATUS_CONTROL_C_EXIT)) {
        // The service's stop ends the whole task without signalling it, so a
        // Windows task Node only stops this way when another program sends it
        // Ctrl+C, possibly before this runner receives its own.
        await record(
          "Node stopped without a service stop, so another program interrupted it; exiting for the login task to relaunch.",
        );
        exitCode = RELAUNCH_EXIT_CODE;
        break;
      }
      if (clean) {
        await record("Clean exit; not restarting.");
        break;
      }
      if (attempt === retryDelaysMs.length) {
        await record(`Crash recovery exhausted after ${attempt} retries; stopping.`);
        if (!stopping) exitCode = result.signal ? 1 : (result.code ?? 1);
        break;
      }
      const delay = retryDelaysMs[attempt];
      await record(
        `Crash recovery retry ${attempt + 1}/${retryDelaysMs.length} in ${delay}ms.`,
      );
      if (stopping) break;
      if (logError) throw logError;
      await new Promise((done) => {
        const timer = setTimeout(() => {
          cancelBackoff = undefined;
          done();
        }, delay);
        cancelBackoff = () => {
          clearTimeout(timer);
          cancelBackoff = undefined;
          done();
        };
      });
      if (logError) throw logError;
    }
    if (stopping && interrupts.has(stopping)) {
      await record(
        `Interrupted by ${stopping} from another program, such as an installer replacing node.exe; exiting for the login task to relaunch.`,
      );
      exitCode = RELAUNCH_EXIT_CODE;
    } else if (stopping) {
      await record(`Stopped by ${stopping}; no further retries.`);
      exitCode = 0;
    }
  } catch (error) {
    fatalError = error;
    if (!logError) {
      try {
        await record(`Recovery halted; no retry: ${error.message}`);
      } catch (error) {
        logError = error;
      }
    }
  } finally {
    cancelBackoff?.();
    for (const [signal, handler] of signals) signalSource.removeListener(signal, handler);
    try {
      if (!logError) {
        await new Promise((done, reject) =>
          output.end((error) => (error ? reject(error) : done())),
        );
      }
    } catch (error) {
      logError = error;
    } finally {
      if (!output.closed) {
        await new Promise((done) => {
          output.once("close", done);
          output.destroy();
        });
      }
    }
  }
  if (fatalError && logError && fatalError !== logError)
    throw new AggregateError(
      [fatalError, logError],
      `${fatalError.message}; ${logError.message}`,
    );
  if (fatalError || logError) throw fatalError || logError;
  return exitCode;
}

/**
 * Runs the workload in this login service until it stops.
 *
 * `interruptSignals` are signals that only another program can send, which
 * stop the workload and return RELAUNCH_EXIT_CODE instead of ending the
 * service; main() uses WINDOWS_INTERRUPT_SIGNALS on Windows.
 */
export async function run(manifest, options = {}) {
  const { signalSource = process, interruptSignals = [] } = options;
  await loadCheckoutEnvironment(manifest);
  const nodeId = manifest.kind === "node" ? await existingIdleNode(manifest) : undefined;
  const entry =
    manifest.kind === "node"
      ? join(manifest.repositoryPath, "apps", "node", "supervisor.mjs")
      : join(manifest.repositoryPath, "apps", "host", "dist", "server", "server.js");
  await access(entry);
  await rotateLog(manifest.logPath);
  const log = await open(manifest.logPath, "a", 0o600);
  const signals = new Map();
  try {
    await log.write(
      `\n${new Date().toISOString()} [login-start] Starting ${manifest.kind} as ${manifest.accountSid}\n`,
    );
    // Managed process ownership exists on every platform now: a Job Object on
    // Windows, a verified process group on Linux and macOS.
    if (manifest.kind === "node") {
      return await runRecoveringNode(manifest, entry, log, nodeId, options);
    }
    const child = spawn(manifest.nodePath, [entry, ...manifest.runtimeArgs], {
      cwd: manifest.repositoryPath,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, NODE_ENV: "production" },
    });
    let interrupted;
    for (const signal of new Set(["SIGINT", "SIGTERM", ...interruptSignals])) {
      const handler = () => {
        if (!interruptSignals.includes(signal)) return child.kill(signal);
        interrupted ??= signal;
        // A Windows child cannot be sent Ctrl+Break; any kill ends it.
        child.kill("SIGTERM");
      };
      signals.set(signal, handler);
      signalSource.once(signal, handler);
    }
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done(signal ? 1 : (code ?? 1)));
    });
    // Restart Manager sends the Host its own Ctrl+C, which can end it before
    // this runner's arrives.
    if (interruptSignals.length > 0 && code === STATUS_CONTROL_C_EXIT)
      interrupted ??= "Ctrl+C";
    if (!interrupted) return code;
    await log.write(
      `${new Date().toISOString()} [login-start] Host interrupted by ${interrupted} from another program, such as an installer replacing node.exe; exiting for the login task to relaunch.\n`,
    );
    return RELAUNCH_EXIT_CODE;
  } finally {
    for (const [signal, handler] of signals) signalSource.removeListener(signal, handler);
    await log.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [manifestPath, flag, resultPath] = argv;
  if (
    !manifestPath ||
    (flag && (flag !== "--probe" || !resultPath || argv.length !== 3))
  ) {
    throw new Error("Usage: login-service-runner.mjs <manifest> [--probe <result>]");
  }
  const manifest = readManifest(manifestPath, accountId());
  Object.assign(process.env, manifest.environment);
  process.chdir(manifest.repositoryPath);
  if (flag === "--probe") {
    let result;
    try {
      result = await preflight(manifest);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    const temporary = `${resultPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
    await rename(temporary, resultPath);
    return result.ok ? 0 : 1;
  }
  return run(manifest, {
    interruptSignals: process.platform === "win32" ? WINDOWS_INTERRUPT_SIGNALS : [],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
