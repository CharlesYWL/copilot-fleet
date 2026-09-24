#!/usr/bin/env node
/**
 * Updates a Host that runs as the Windows login service, then restarts it the
 * way it was installed: `npm run service -- host+node restart`.
 *
 * The Host asks for this; it cannot do it itself. The login task runs the Host
 * inside a kill-on-close job object, so anything the Host starts — detached or
 * not — dies the moment `host restart` stops that task, which is exactly the
 * step it would be in the middle of. So `schedule` registers a one-off task for
 * this Windows user and starts it, and Task Scheduler runs `run` outside both
 * Fleet tasks, where stopping them cannot take the update down with them.
 *
 *   node scripts/self-update.mjs schedule --status <file> --update-id <id> --restart <host+node|host> [--running-revision <sha>]
 *   node scripts/self-update.mjs run      (the same options; what the task runs)
 *
 * `schedule` prints one JSON line: `{"ok":true,...}` or `{"ok":false,"error":...}`.
 */
import console from "node:console";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loginDirectory, readManifest, windowsSid } from "./login-service.mjs";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `host+node` when this checkout's Node is a login service too. */
export const RESTART_KINDS = ["host+node", "host"];

/** The Host runs its Node from the same checkout, so both are built. */
const HOST_BUILD_SCRIPT = "build";

export function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (action !== "schedule" && action !== "run") {
    throw new Error(
      "Usage: self-update.mjs <schedule|run> --status <file> --update-id <id> --restart <host+node|host> [--running-revision <sha>]",
    );
  }
  const options = { action };
  const names = {
    "--status": "statusFile",
    "--update-id": "updateId",
    "--restart": "restart",
    "--running-revision": "runningRevision",
  };
  for (let index = 0; index < rest.length; index += 2) {
    const name = names[rest[index]];
    const value = rest[index + 1];
    if (!name) throw new Error(`Unknown option ${rest[index]}`);
    if (value === undefined) throw new Error(`${rest[index]} needs a value`);
    options[name] = value;
  }
  // Every value ends up inside a PowerShell command and a task definition, so
  // each is held to the shape the Host actually sends.
  if (!options.statusFile || !isAbsolute(options.statusFile)) {
    throw new Error("--status must be an absolute path");
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(options.updateId ?? "")) {
    throw new Error("--update-id must be letters, digits and dashes");
  }
  if (!RESTART_KINDS.includes(options.restart)) {
    throw new Error(`--restart must be one of ${RESTART_KINDS.join(", ")}`);
  }
  if (
    options.runningRevision !== undefined &&
    !/^[0-9a-f]{0,40}$/i.test(options.runningRevision)
  ) {
    throw new Error("--running-revision must be a commit id");
  }
  return options;
}

/** One task per Windows user, named like the login tasks it restarts. */
export function updateTaskName(sid) {
  return `CopilotFleetSelfUpdate-${createHash("sha256").update(sid).digest("hex").slice(0, 12)}`;
}

export function restartCommand(kind) {
  return `npm run service -- ${kind} restart`;
}

function system32() {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
}

/** A PowerShell single-quoted literal, which expands nothing. */
function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * What the task's PowerShell runs, encoded so no quoting survives to be wrong.
 *
 * PowerShell rather than node directly because an interactive task's console
 * program gets a visible console window for as long as it runs; the login tasks
 * use the same hidden PowerShell wrapper for the same reason.
 */
export function taskArguments({ nodePath, script, options }) {
  const words = [
    "&",
    literal(nodePath),
    literal(script),
    "'run'",
    "'--status'",
    literal(options.statusFile),
    "'--update-id'",
    literal(options.updateId),
    "'--restart'",
    literal(options.restart),
    ...(options.runningRevision
      ? ["'--running-revision'", literal(options.runningRevision)]
      : []),
  ];
  const command = `${words.join(" ")}; exit $LASTEXITCODE`;
  return `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
}

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A task that runs once, on demand, as this user in this session.
 *
 * InteractiveToken because the login-task controller refuses anything else —
 * the restart it runs checks for the signed-in interactive user — and because
 * it needs no stored password. No triggers: it runs when `schedule` starts it.
 */
export function taskXml({ sid, command, argumentsLine, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Copilot Fleet Host self-update. Runs once when the Host asks for it and deletes itself.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(argumentsLine)}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks prints its reason on stderr; the exit status alone says nothing. */
function commandError(error) {
  const stderr = error?.stderr?.toString().trim();
  const stdout = error?.stdout?.toString().trim();
  return stderr || stdout || (error instanceof Error ? error.message : String(error));
}

/** Registers the one-off task and starts it; returns once Task Scheduler has it. */
export function schedule(
  options,
  {
    sid = windowsSid(),
    exec = execFileSync,
    nodePath = process.execPath,
    root = checkoutRoot,
    platform = process.platform,
  } = {},
) {
  if (platform !== "win32") throw new Error("The login service exists only on Windows.");
  const taskName = updateTaskName(sid);
  const schtasks = win32.join(system32(), "schtasks.exe");
  const definition = taskXml({
    sid,
    command: win32.join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"),
    argumentsLine: taskArguments({
      nodePath,
      script: join(root, "scripts", "self-update.mjs"),
      options,
    }),
    workingDirectory: root,
  });
  const definitionPath = `${options.statusFile}.task.xml`;
  // schtasks reads task XML as UTF-16, as the declaration says; with a BOM so
  // nothing has to guess.
  writeFileSync(
    definitionPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition, "utf16le")]),
    { mode: 0o600 },
  );
  const quiet = { windowsHide: true, stdio: "pipe", timeout: 60_000 };
  try {
    exec(schtasks, ["/Create", "/TN", taskName, "/XML", definitionPath, "/F"], quiet);
  } finally {
    rmSync(definitionPath, { force: true });
  }
  exec(schtasks, ["/Run", "/TN", taskName], quiet);
  return { ok: true, taskName };
}

/** The Host task's saved PATH and profile, which Task Scheduler does not give this one. */
function hostTaskEnvironment() {
  return readManifest(join(loginDirectory("host"), "manifest.json"), windowsSid())
    .environment;
}

/**
 * `host` when the Node login task is not there to restart.
 *
 * `npm run service -- node stop` disables the task until someone starts it
 * again, and a Host update is not that someone: `host+node restart` would bring
 * back a Node its operator switched off. `uninstall` keeps the manifest the
 * Host found, but there is no task left to start. Anything short of a clear
 * answer keeps the restart the Host asked for.
 */
export function effectiveRestartKind(kind, { root, log, runSync = spawnSync }) {
  if (kind !== "host+node") return kind;
  try {
    const result = runSync(
      process.execPath,
      [join(root, "scripts", "login-service-cli.mjs"), "node", "status"],
      { cwd: root, windowsHide: true, encoding: "utf8", timeout: 120_000 },
    );
    const status = JSON.parse(
      String(result.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .at(-1),
    );
    if (status?.installed === false) {
      log("The Node login task is not installed, so only the Host is restarted");
      return "host";
    }
    if (status?.installed === true && status.state === "disabled") {
      log("The Node login task is stopped, so only the Host is restarted");
      return "host";
    }
  } catch {
    // Unknown is not stopped.
  }
  return kind;
}

/**
 * Runs `npm run service -- <kind> restart` from the updated checkout.
 *
 * Resolves to why it failed, or undefined. The command's own output goes to the
 * log; its last lines travel with a failure, because that is where it names the
 * login or the task that stopped it.
 */
function restartServices(requested, { root, log }) {
  return new Promise((done) => {
    const kind = effectiveRestartKind(requested, { root, log });
    const command = restartCommand(kind);
    log(`$ ${command}`);
    const child = spawn(
      process.execPath,
      [join(root, "scripts", "login-service-cli.mjs"), kind, "restart"],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let tail = "";
    const collect = (chunk) => {
      const text = chunk.toString("utf8");
      log(text.trimEnd());
      tail = (tail + text).slice(-2_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => done(`${command} could not start: ${error.message}`));
    child.once("close", (code) => {
      if (code === 0) return done(undefined);
      const reason = tail.trim().split(/\r?\n/).slice(-3).join(" ").trim();
      done(`${command} failed (exit ${code})${reason ? `: ${reason}` : ""}`);
    });
  });
}

/** What the one-off task runs: the update, the restart, and then its own removal. */
export async function run(
  options,
  {
    root = checkoutRoot,
    loadUpdater = () => import("@fleet/protocol/updater"),
    environment = hostTaskEnvironment,
    restart = restartServices,
    removeTask = () =>
      execFileSync(
        win32.join(system32(), "schtasks.exe"),
        ["/Delete", "/TN", updateTaskName(windowsSid()), "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 60_000 },
      ),
  } = {},
) {
  const logPath = join(dirname(options.statusFile), "self-update.log");
  const logFile = openSync(logPath, "w", 0o600);
  const log = (message) => {
    if (message) writeSync(logFile, `${new Date().toISOString()} ${message}\n`);
  };
  try {
    try {
      Object.assign(process.env, environment());
    } catch (error) {
      log(
        `Could not load the Host task's environment (${error.message}); using this one`,
      );
    }
    const updater = await loadUpdater();
    const command = restartCommand(options.restart);
    const record = await updater.applyUpdate({
      statusFile: options.statusFile,
      updateId: options.updateId,
      checkout: {
        repoRoot: root,
        buildScript: HOST_BUILD_SCRIPT,
        preserveLocalChanges: true,
        ...(options.runningRevision ? { runningRevision: options.runningRevision } : {}),
        run: async (name, args, cwd) => {
          log(`$ ${name} ${args.join(" ")}`);
          const result = await updater.runCommand(name, args, cwd);
          log(result.output);
          return result;
        },
      },
      restartCommand: command,
      // `restart` returns once the tasks run, not once Fleet is serving in
      // them; the new Host confirms, as under the launcher.
      confirmRestart: "host",
      restart: () => restart(options.restart, { root, log }),
    });
    log(`${record.stage}: ${record.detail}`);
    return record.stage === "failed" ? 1 : 0;
  } catch (error) {
    log(`Update failed: ${error instanceof Error ? error.stack : String(error)}`);
    return 1;
  } finally {
    // The task has done its one job; the next update registers it afresh.
    try {
      removeTask();
    } catch (error) {
      log(`Could not delete the update task: ${commandError(error)}`);
    }
    closeSync(logFile);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    return 2;
  }
  if (options.action === "run") return run(options);
  try {
    console.log(JSON.stringify(schedule(options)));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: commandError(error) }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
