import console from "node:console";
import { execFile, spawn } from "node:child_process";
import { access, open, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve, win32 } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { assertIdleNode, readManifest, windowsSid } from "./login-service.mjs";

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

export async function run(manifest) {
  await loadCheckoutEnvironment(manifest);
  if (manifest.kind === "node") {
    const config = await importNodeModule(manifest, "config.js");
    if (!(await config.loadCredentials()))
      throw new Error("Node identity is missing; refusing replacement enrollment.");
    assertIdleNode(config.configDirectory());
  }
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
    const child = spawn(manifest.nodePath, [entry, ...manifest.runtimeArgs], {
      cwd: manifest.repositoryPath,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, NODE_ENV: "production" },
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => child.kill(signal);
      signals.set(signal, handler);
      process.once(signal, handler);
    }
    return await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done(signal ? 1 : (code ?? 1)));
    });
  } finally {
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
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
  const manifest = readManifest(manifestPath, windowsSid());
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
  return run(manifest);
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
