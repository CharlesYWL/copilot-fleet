import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import process from "node:process";

const ACTIONS = new Set([
  "install",
  "status",
  "start",
  "stop",
  "restart",
  "uninstall",
  "logs",
]);
const ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "COPILOT_HOME",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "GIT_CONFIG_GLOBAL",
  "FLEET_NODE_CONFIG_DIR",
  "FLEET_COPILOT_COMMAND",
  "FLEET_DEVTUNNEL_ID",
  "FLEET_NODE_CONFIG_PORT",
  "HOST",
  "PORT",
  "DATABASE_PATH",
  "FLEET_PUBLIC_URL",
]);

export function parseOptions(argv) {
  const [kind, requestedAction, ...rest] = argv;
  const implicitInstall =
    requestedAction?.startsWith("--") && requestedAction !== "--help";
  const action = implicitInstall ? "install" : (requestedAction ?? "help");
  const flags = implicitInstall ? [requestedAction, ...rest] : rest;
  if (!["host", "node", "host+node"].includes(kind)) {
    throw new Error("Choose node, host, or host+node.");
  }
  if (["help", "--help", "-h"].includes(action)) return { kind, action: "help" };
  if (!ACTIONS.has(action)) throw new Error(`Unknown login-start action: ${action}`);
  const options = {
    kind,
    action,
    build: true,
    start: true,
    nodeArgs: [],
  };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--") continue;
    if (action !== "install")
      throw new Error(`${action} does not accept installation options.`);
    if (flag === "--no-build") options.build = false;
    else if (flag === "--no-start") options.start = false;
    else if (flag === "--existing-node" && kind !== "host") options.existingNode = true;
    else if (flag === "--start-mode" || flag.startsWith("--start-mode=")) {
      const mode = flag.includes("=")
        ? flag.slice("--start-mode=".length)
        : flags[++index];
      if (mode !== "login")
        throw new Error(
          "Only --start-mode login is supported; no boot/password fallback.",
        );
    } else if (
      kind !== "host" &&
      flag.startsWith("--") &&
      !/^--(?:credential-file|password)(?:=|$)/.test(flag)
    ) {
      options.nodeArgs.push(flag);
      if (!flag.includes("=") && flags[index + 1] && !flags[index + 1].startsWith("--")) {
        options.nodeArgs.push(flags[++index]);
      }
    } else {
      throw new Error(
        `Unsupported service option: ${flag.split("=")[0]}. Use the Node's regular connection flags for enrollment.`,
      );
    }
  }
  return options;
}

export function windowsSid() {
  const output = execFileSync(
    win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  const sid = output.match(/"(S-\d+(?:-\d+)+)"\s*$/m)?.[1];
  if (!sid || ["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(sid)) {
    throw new Error("Login startup requires your interactive Windows user account.");
  }
  return sid;
}

export function taskName(kind, sid) {
  const suffix = createHash("sha256").update(sid).digest("hex").slice(0, 12);
  return `CopilotFleet${kind === "host" ? "Host" : "Node"}Login-${suffix}`;
}

export function loginDirectory(kind, env = process.env) {
  if (!env.LOCALAPPDATA || !win32.isAbsolute(env.LOCALAPPDATA)) {
    throw new Error("A normal Windows user profile with LOCALAPPDATA is required.");
  }
  return win32.join(env.LOCALAPPDATA, "CopilotFleet", "login", kind);
}

export function captureEnvironment(env = process.env) {
  return Object.fromEntries(
    [...ENVIRONMENT_KEYS]
      .map((key) => [key, env[key] ?? (key === "PATH" ? env.Path : undefined)])
      .filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

export function validateManifest(value, sid) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !["host", "node"].includes(value.kind) ||
    !/^S-\d+(?:-\d+)+$/.test(value.accountSid || "") ||
    ["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(value.accountSid) ||
    value.accountSid !== sid ||
    value.taskName !== taskName(value.kind, sid)
  ) {
    throw new Error("Login-start manifest does not belong to this Windows user.");
  }
  for (const field of [
    "repositoryPath",
    "nodePath",
    "runnerPath",
    "controllerPath",
    "logPath",
  ]) {
    if (
      typeof value[field] !== "string" ||
      !/^(?:[a-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+)/i.test(value[field]) ||
      /[\0\r\n"]/.test(value[field])
    )
      throw new Error(`Invalid login-start ${field}.`);
  }
  if (
    !value.environment ||
    typeof value.environment !== "object" ||
    Array.isArray(value.environment) ||
    Object.entries(value.environment).some(
      ([key, entry]) =>
        !ENVIRONMENT_KEYS.has(key) || typeof entry !== "string" || entry.includes("\0"),
    )
  ) {
    throw new Error("Only named, nonsecret profile/runtime settings may be persisted.");
  }
  if (
    !Array.isArray(value.runtimeArgs) ||
    (value.kind === "host" && value.runtimeArgs.length > 0) ||
    value.runtimeArgs.some(
      (argument) =>
        typeof argument !== "string" ||
        !/^--(?:devtunnel|config-port)=[^\0\r\n]+$/.test(argument),
    )
  ) {
    throw new Error(
      "Unexpected runtime arguments; enrollment secrets must not be saved.",
    );
  }
  return value;
}

export function readManifest(path, sid) {
  return validateManifest(
    JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")),
    sid,
  );
}

export function assertIdleNode(directory, alive = processAlive) {
  const lock = win32.join(directory, "node.lock");
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("The existing Node lock is invalid; inspect it before installing.");
  if (alive(pid))
    throw new Error(
      `Another Fleet Node is running (PID ${pid}). Stop it normally before installing or starting login mode.`,
    );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export function taskAction(action, manifestPath, controllerPath, extra = []) {
  const powershell = win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let output;
  try {
    output = execFileSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        controllerPath,
        "-Action",
        action,
        "-Manifest",
        manifestPath,
        ...extra,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 150_000, stdio: "pipe" },
    );
  } catch (error) {
    throw new Error(
      error.stderr?.toString().trim() ||
        `Windows login task ${action} failed (exit ${error.status ?? "unknown"}).`,
      { cause: error },
    );
  }
  const line = output.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error(`Windows login task ${action} returned no result.`);
  return JSON.parse(line);
}
