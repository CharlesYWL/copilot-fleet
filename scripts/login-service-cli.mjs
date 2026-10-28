#!/usr/bin/env node
import console from "node:console";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  accountId,
  captureEnvironment,
  loginDirectory,
  parseOptions,
  readManifest,
  taskAction,
  taskName,
} from "./login-service.mjs";
import { ensureNodeGithubAuth } from "./login-service-runner.mjs";
import {
  SYSTEMD_UNAVAILABLE,
  linuxTaskAction,
  probeCommand,
  systemdAvailable,
  unitDirectory,
  unitName,
} from "./linux-login-service.mjs";

const windows = process.platform === "win32";

/**
 * How this platform registers and controls a login-start workload.
 *
 * Windows drives a per-user scheduled task through its PowerShell controller;
 * Linux writes a systemd user unit. Both take an action and the manifest and
 * report `{ installed, active, ... }`, so the install flow below is shared.
 */
function platformService() {
  if (windows)
    return {
      files: [
        "login-service.mjs",
        "login-service-runner.mjs",
        "windows-login-task.ps1",
        "windows-login-job.ps1",
      ],
      controller: (directory) => join(directory, "windows-login-task.ps1"),
      invoke: (action, manifestPath, controller, extra) =>
        taskAction(action, manifestPath, controller, extra),
      // The task's own preflight runs inside the scheduled-task context.
      probe: (invoke, directory) =>
        invoke("probe", ["-ProbeResult", join(directory, "probe.json")]),
      startsWhen: "Starts after Windows sign-in.",
    };
  if (process.platform !== "linux")
    throw new Error(
      "Login-start services support Windows (Task Scheduler) and Linux (systemd --user). On macOS, run `npm start` under the launcher.",
    );
  if (!systemdAvailable()) throw new Error(SYSTEMD_UNAVAILABLE);
  return {
    files: ["login-service.mjs", "login-service-runner.mjs", "linux-login-service.mjs"],
    controller: (kind) => join(unitDirectory(), unitName(kind)),
    invoke: (action, manifestPath) =>
      linuxTaskAction(action, readManifest(manifestPath, accountId()), manifestPath),
    // Probe inside the user manager, not this terminal, so credentials that
    // exist only here (an exported GH_TOKEN) cannot pass for the service.
    probe: (_invoke, directory, manifestPath, nodePath, runnerPath) => {
      const resultPath = join(directory, "probe.json");
      rmSync(resultPath, { force: true });
      const manifest = readManifest(manifestPath, accountId());
      const [command, args] = probeCommand({
        nodePath,
        runnerPath,
        manifestPath,
        resultPath,
        kind: manifest.kind,
        cwd: manifest.repositoryPath,
      });
      const run = spawnSync(command, args, {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (run.error) throw run.error;
      if (!existsSync(resultPath))
        throw new Error(
          `The service preflight did not run in the systemd user manager (exit ${run.status}).`,
        );
      return JSON.parse(readFileSync(resultPath, "utf8"));
    },
    startsWhen:
      "Starts at login (and at boot when lingering is enabled) via systemd --user.",
  };
}

export const HELP = `Login startup (Windows Task Scheduler or Linux systemd --user)

  npm run service -- node install --existing-node
  npm run service -- node --url <host-url> --host-id <id> --host-fingerprint <sha256> --enrollment-grant <grant>
  npm run service -- host+node install --existing-node
  npm run service -- node|host|host+node status|start|stop|restart|uninstall|logs
  npm run node:service -- install --existing-node [--devtunnel <id>] [--config-port <port>]
  npm run host:service -- install

Run install once before start; start does not install the service.
Install builds and starts by default. Options: --no-build, --no-start, --start-mode login.
Use your normal user account (never root/LocalSystem). Expired gh login is renewed in this terminal.
Copilot requires its own login. Dev Tunnels login is needed only in Dev Tunnels mode.
Corp direct uses --corp-direct plus --host-ca from the Connect card; its saved private
origin and public CA are reused at login without a tunnel or certificate-store change.
Pass the Host's Connect-card flags to enroll and start in one command.
Enrollment secrets are used in memory during setup, never saved in the service.
Stop manual Host/Node instances first. No passwords, token files, or elevation required.
Stop disables future login/recovery runs until start; uninstall preserves all files.
Host+Node operates sequentially on two independent services, not an atomic transaction.
Windows: a per-user scheduled task that starts after sign-in.
Linux: a systemd user unit (~/.config/systemd/user/copilot-fleet-*.service) that starts at
login, and at boot when lingering is enabled (loginctl enable-linger). Without a systemd
user manager (e.g. WSL without systemd), run \`npm start\` under the launcher instead.`;

/**
 * The npm CLI script to build with, run by this same node.
 *
 * `npm run service` sets npm_execpath to the npm actually running, which covers
 * distribution layouts such as /usr/bin/node with
 * /usr/share/nodejs/npm/bin/npm-cli.js. Only an existing npm-cli.js is used, as
 * the launcher does; otherwise npm is looked for beside node: node_modules/npm
 * on Windows, lib/node_modules/npm on POSIX.
 */
export function npmCli({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  return [
    env.npm_execpath,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => path && /npm-cli\.js$/i.test(path) && exists(path));
}

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
  // The first install builds this package; help/build must work before dist exists.
  const { CONFIG_UI_EVENT_MARKER, ConfigUiEventSchema } = await import("@fleet/protocol");
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
          const marker = line.indexOf(CONFIG_UI_EVENT_MARKER);
          if (marker === -1) continue;
          const event = ConfigUiEventSchema.parse(
            JSON.parse(line.slice(marker + CONFIG_UI_EVENT_MARKER.length)),
          );
          if (event.type === "starting") {
            started = true;
            continue;
          }
          if (!started) continue;
          if (event.type === "retry")
            log(`Config UI port ${event.port} is occupied; trying ${event.nextPort}.`);
          if (event.type === "ready") {
            log(`Node config UI: ${event.url}`);
            return event.url;
          }
          if (event.type === "error")
            throw new Error(`Config UI unavailable: ${event.message} Log: ${path}`);
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
  const service = platformService();
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
  const sid = accountId();
  if (
    combined &&
    options.action === "restart" &&
    kinds.every((kind) => existsSync(join(loginDirectory(kind), "manifest.json")))
  ) {
    await ensureNodeGithubAuth(
      readManifest(join(loginDirectory("node"), "manifest.json"), sid),
      { interactive: process.stdin.isTTY === true && process.stdout.isTTY === true },
    );
  }
  for (const [kind, action] of steps) {
    await manage(
      {
        ...options,
        kind,
        action,
        build: options.build && !(combined && kind === "node"),
      },
      sid,
      options.kind,
      service,
    );
  }
}

async function manage(options, sid, requestedKind, service) {
  const directory = loginDirectory(options.kind);
  const manifestPath = join(directory, "manifest.json");
  const source = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(source, "..");
  const installedController = windows
    ? service.controller(directory)
    : service.controller(options.kind);
  const old = existsSync(manifestPath) ? readManifest(manifestPath, sid) : undefined;
  if (old && old.kind !== options.kind)
    throw new Error("The manifest names a different workload.");
  let controller = old?.controllerPath ?? installedController;
  const invoke = (action, extra = []) =>
    service.invoke(action, manifestPath, controller, extra);
  if (options.action !== "install") {
    if (!old) {
      if (["status", "uninstall"].includes(options.action)) {
        console.log(
          JSON.stringify({ installed: false, taskName: taskName(options.kind, sid) }),
        );
        return;
      }
      const installKind =
        requestedKind === "host+node" &&
        ["host", "node"].every(
          (kind) => !existsSync(join(loginDirectory(kind), "manifest.json")),
        )
          ? requestedKind
          : options.kind;
      const includesNode = installKind !== "host";
      const account = windows ? "Windows account" : "user account";
      const unit = windows ? "tasks" : "services";
      throw new Error(
        [
          `${options.kind === "host" ? "Host" : "Node"} login startup is not installed for this ${account}.`,
          `start only starts installed ${unit}; it does not install them.`,
          "",
          "Stop any manually running Host/Node instances before installing.",
          includesNode ? "If your Node is already enrolled, run:" : "Run:",
          `  npm run service -- ${installKind} install${includesNode ? " --existing-node" : ""}`,
          "",
          windows
            ? "Install builds, registers, and starts the selected tasks, and enables startup after Windows sign-in."
            : `Install builds, registers, and starts the selected services. ${service.startsWhen}`,
          ...(includesNode
            ? [
                "For a new Node, install/start the Host first if needed, then use the service enrollment command from Nodes > Connect a machine.",
              ]
            : []),
          `If you installed previously, use the same ${account}.`,
        ].join("\n"),
      );
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
    if (startingNode) {
      await ensureNodeGithubAuth(old, {
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      });
    }
    const cursor = startingNode ? logPosition(old.logPath) : undefined;
    console.log(JSON.stringify(invoke(options.action)));
    if (cursor) await printNodeConfigUrl(old.logPath, cursor);
    return;
  }
  if (old) {
    const status = invoke("status");
    const samePath = windows
      ? win32.normalize(old.repositoryPath).toLowerCase() === repo.toLowerCase()
      : resolve(old.repositoryPath) === repo;
    if (status.installed && !samePath) {
      throw new Error(
        "A login service points to another checkout. Uninstall it there first.",
      );
    }
    if (status.active)
      throw new Error("Stop the existing login service before reinstalling.");
    if (status.installed) invoke("stop");
  }
  if (options.build) {
    const npm = npmCli();
    if (!npm)
      throw new Error(
        "Cannot locate npm (npm_execpath, or beside the node executable). Build manually and use --no-build.",
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
    ...(options.kind === "node" ? ["main.js"] : ["server", "server.js"]),
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
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of service.files) {
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
    if (manifest.kind === "node") {
      await ensureNodeGithubAuth(manifest, {
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      });
    }
    const proof = service.probe(
      invoke,
      directory,
      manifestPath,
      manifest.nodePath,
      manifest.runnerPath,
    );
    if (!proof.ok)
      throw new Error(
        `${proof.error || "The logged-in task preflight failed."}${
          windows
            ? ""
            : " The service runs without this terminal's environment: credentials exported only here (GH_TOKEN, GITHUB_TOKEN) are not available to it. Sign in with `gh auth login` instead."
        }`,
      );
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
  const registered = invoke("register");
  console.log(JSON.stringify(registered));
  if (registered.linger && !registered.linger.enabled && registered.linger.hint)
    console.log(registered.linger.hint);
  const cursor =
    options.start && options.kind === "node" ? logPosition(manifest.logPath) : undefined;
  if (options.start) console.log(JSON.stringify(invoke("start")));
  console.log(`${service.startsWhen} Log: ${manifest.logPath}`);
  if (cursor) await printNodeConfigUrl(manifest.logPath, cursor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
