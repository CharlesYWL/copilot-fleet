#!/usr/bin/env node
import console from "node:console";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureEnvironment,
  loginDirectory,
  parseOptions,
  readManifest,
  taskAction,
  taskName,
  windowsSid,
} from "./login-service.mjs";

export const HELP = `Windows login startup (not signed-out boot)

  npm run service -- node install --existing-node
  npm run service -- node --url <host-url> --host-id <id> --host-fingerprint <sha256> --enrollment-grant <grant>
  npm run service -- host+node install --existing-node
  npm run service -- node|host|host+node status|start|stop|restart|uninstall|logs
  npm run node:service -- install --existing-node [--devtunnel <id>] [--config-port <port>]
  npm run host:service -- install

Install builds and starts by default. Options: --no-build, --no-start, --start-mode login.
Use your normal Windows account and existing gh/Copilot/Dev Tunnels login.
Pass the Host's Connect-card flags to enroll and start in one command.
Enrollment secrets are used in memory during setup, never saved in the scheduled task.
Stop manual Host/Node instances first. No passwords, token files, or elevation required.
Stop disables future logon/recovery runs until start; uninstall preserves all files.
Host+Node operates sequentially on two independent tasks, not an atomic transaction.
Only Windows is supported by these commands. Manual commands are unchanged.`;

export function logPosition(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return { size: 0, ino: 0 };
    throw error;
  }
}

/** Read only this startup's log bytes, including a log rotated by the runner. */
export async function printNodeConfigUrl(
  path,
  cursor,
  { timeoutMs = 60_000, log = console.log } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let offset = cursor.size,
    inode = cursor.ino,
    pending = "",
    started = false;
  while (Date.now() < deadline) {
    let file;
    try {
      file = await open(path, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (file) {
      try {
        const current = await file.stat();
        if (current.ino !== inode || current.size < offset) {
          offset = 0;
          pending = "";
          started = false;
        }
        inode = current.ino;
        const { bytesRead, buffer } = await file.read({
          buffer: Buffer.alloc(64 * 1024),
          position: offset,
        });
        offset += bytesRead;
        const lines = (pending + buffer.subarray(0, bytesRead).toString("utf8")).split(
          /\r?\n/,
        );
        pending = lines.pop().slice(-4096);
        for (const line of lines) {
          if (/^\S+ \[login-start\] Starting node as /.test(line)) {
            started = true;
            continue;
          }
          if (!started) continue;
          const message = /^\S+ \[node\] (.*)$/.exec(line)?.[1] ?? "";
          if (/^Config UI port \d+ is occupied; trying \d+\.$/.test(message))
            log(message);
          const ready = /^ {2}config UI {3}(http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(message);
          if (ready) {
            log(`Node config UI: ${ready[1]}`);
            return ready[1];
          }
          if (message.startsWith("Config UI unavailable:"))
            throw new Error(`${message} Log: ${path}`);
        }
      } finally {
        await file.close();
      }
    }
    await delay(100);
  }
  throw new Error(
    `The Node task started, but its config UI URL was not reported within ${timeoutMs / 1000}s. Inspect ${path}; the task remains installed.`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.action === "help") {
    console.log(HELP);
    return;
  }
  if (process.platform !== "win32")
    throw new Error("Login-start task management is Windows-only.");
  const combined = options.kind === "host+node";
  const kinds = combined
    ? ["stop", "uninstall"].includes(options.action)
      ? ["node", "host"]
      : ["host", "node"]
    : [options.kind];
  const steps =
    combined && options.action === "restart"
      ? [
          ["node", "stop"],
          ["host", "restart"],
          ["node", "start"],
        ]
      : kinds.map((kind) => [kind, options.action]);
  const sid = windowsSid();
  for (const [kind, action] of steps) {
    await manage(
      {
        ...options,
        kind,
        action,
        build: options.build && !(combined && kind === "node"),
      },
      sid,
    );
  }
}

async function manage(options, sid) {
  const directory = loginDirectory(options.kind);
  const manifestPath = join(directory, "manifest.json");
  const source = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(source, "..");
  const installedController = join(directory, "windows-login-task.ps1");
  const old = existsSync(manifestPath) ? readManifest(manifestPath, sid) : undefined;
  if (old && old.kind !== options.kind)
    throw new Error("The manifest names a different workload.");
  let controller = old?.controllerPath ?? installedController;
  const invoke = (action, extra = []) =>
    taskAction(action, manifestPath, controller, extra);
  if (options.action !== "install") {
    if (!old) {
      if (["status", "uninstall"].includes(options.action)) {
        console.log(
          JSON.stringify({ installed: false, taskName: taskName(options.kind, sid) }),
        );
        return;
      }
      throw new Error("Login startup is not installed.");
    }
    if (options.action === "logs") {
      for (const path of [old.logPath, `${old.logPath}.startup.log`]) {
        console.log(`Log: ${path}`);
        if (existsSync(path))
          console.log(readFileSync(path, "utf8").split(/\r?\n/).slice(-80).join("\n"));
      }
      return;
    }
    const startingNode =
      options.kind === "node" &&
      (options.action === "restart" ||
        (options.action === "start" && !invoke("status").active));
    const cursor = startingNode ? logPosition(old.logPath) : undefined;
    console.log(JSON.stringify(invoke(options.action)));
    if (cursor) await printNodeConfigUrl(old.logPath, cursor);
    return;
  }
  if (old) {
    const status = invoke("status");
    if (
      status.installed &&
      win32.normalize(old.repositoryPath).toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error(
        "A login task points to another checkout. Uninstall it there first.",
      );
    }
    if (status.active)
      throw new Error("Stop the existing login task before reinstalling.");
    if (status.installed) invoke("stop");
  }
  if (options.build) {
    const npm = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!existsSync(npm))
      throw new Error(
        "Cannot locate npm beside node.exe. Build manually and use --no-build.",
      );
    const build = spawnSync(
      process.execPath,
      [npm, "run", options.kind === "node" ? "build:node" : "build"],
      { cwd: repo, stdio: "inherit" },
    );
    if (build.error) throw build.error;
    if (build.status !== 0)
      throw new Error(`Build failed (exit ${build.status}). Nothing was registered.`);
  }
  const entry = join(
    repo,
    "apps",
    options.kind,
    "dist",
    options.kind === "node" ? "main.js" : "server\\server.js",
  );
  if (!existsSync(entry)) throw new Error(`Missing production build: ${entry}`);
  if (
    options.kind === "host" &&
    !existsSync(join(repo, "apps", "host", "dist", "ui", "index.html"))
  ) {
    throw new Error("The production Host UI is missing. Run npm run build first.");
  }
  const nodeSetup =
    options.kind === "node"
      ? await import(
          pathToFileURL(join(repo, "apps", "node", "dist", "service-enrollment.js")).href
        )
      : undefined;
  const runtimeArgs = nodeSetup ? nodeSetup.serviceRuntimeArgs(options.nodeArgs) : [];
  mkdirSync(directory, { recursive: true });
  for (const file of [
    "login-service.mjs",
    "login-service-runner.mjs",
    "windows-login-task.ps1",
    "windows-login-job.ps1",
  ]) {
    copyFileSync(join(source, file), join(directory, file));
  }
  controller = installedController;
  const manifest = {
    schemaVersion: 1,
    kind: options.kind,
    taskName: taskName(options.kind, sid),
    accountSid: sid,
    repositoryPath: repo,
    nodePath: process.execPath,
    runnerPath: join(directory, "login-service-runner.mjs"),
    controllerPath: installedController,
    logPath: join(directory, "runtime.log"),
    environment: captureEnvironment(),
    runtimeArgs,
  };
  const saveManifest = () =>
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  const verifyContext = async (settings) => {
    if (settings) manifest.environment.FLEET_COPILOT_COMMAND = settings.copilotCommand;
    saveManifest();
    const proof = invoke("probe", ["-ProbeResult", join(directory, "probe.json")]);
    if (!proof.ok) throw new Error(proof.error || "The logged-in task preflight failed.");
    console.log("Same-user authentication preflight succeeded.");
  };
  if (nodeSetup) {
    const prepared = await nodeSetup.prepareNodeService(options.nodeArgs, {
      existingNode: options.existingNode,
      verifyContext,
    });
    manifest.runtimeArgs = prepared.runtimeArgs;
    saveManifest();
    console.log(
      `Prepared Node ${prepared.nodeId}; later starts reuse its saved identity.`,
    );
  } else {
    await verifyContext();
  }
  console.log(JSON.stringify(invoke("register")));
  const cursor =
    options.start && options.kind === "node" ? logPosition(manifest.logPath) : undefined;
  if (options.start) console.log(JSON.stringify(invoke("start")));
  console.log(`Starts after Windows sign-in. Log: ${manifest.logPath}`);
  if (cursor) await printNodeConfigUrl(manifest.logPath, cursor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
