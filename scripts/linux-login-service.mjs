import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import process from "node:process";

/**
 * Linux login startup through `systemd --user`.
 *
 * The counterpart of `windows-login-task.ps1`: one user unit per workload that
 * runs `login-service-runner.mjs <manifest>`. Each action returns the same
 * result shape the Windows controller prints, so the CLI treats both alike.
 *
 * A user unit starts at login. With lingering enabled (`loginctl
 * enable-linger`) it also starts at boot without a login. Either way it runs as
 * the user, with the user's Copilot and GitHub credentials, never as root.
 */

export function unitName(kind) {
  return `copilot-fleet-${kind}.service`;
}

export function unitDirectory(env = process.env) {
  const base =
    env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : posix.join(env.HOME || homedir(), ".config");
  return posix.join(base, "systemd", "user");
}

/** systemd quoting for one ExecStart word: double quotes, escaped specials. */
function quote(value) {
  return `"${value.replace(/[\\"$%]/g, (character) =>
    character === "%" ? "%%" : character === "$" ? "$$" : `\\${character}`,
  )}"`;
}

/**
 * A path for settings that take one unquoted path (WorkingDirectory=), which
 * systemd rejects when quoted. Only `%` specifiers need escaping there; paths
 * with a newline are refused rather than written into the unit.
 */
function pathValue(value) {
  if (/[\r\n]/.test(value)) throw new Error("Unit paths cannot contain line breaks.");
  return value.replace(/%/g, "%%");
}

/**
 * The unit file.
 *
 * `Restart=on-failure` brings a crashed workload back; exit 0 (a clean stop)
 * does not restart it. The Node's own supervisor already turns its update exit
 * (75) into a restart inside the unit, and the Host's self-update restarts the
 * unit explicitly, so neither relies on systemd for that.
 * `KillMode=control-group` stops the whole cgroup, including detached agent
 * process groups, when the unit stops.
 */
export function unitFile(manifest, manifestPath) {
  return [
    "[Unit]",
    `Description=Copilot Fleet ${manifest.kind === "host" ? "Host" : "Node"}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${pathValue(manifest.repositoryPath)}`,
    `ExecStart=${quote(manifest.nodePath)} ${quote(manifest.runnerPath)} ${quote(manifestPath)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=control-group",
    "TimeoutStopSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function defaultSystemctl(args, options = {}) {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    ...options,
  });
}

/**
 * Whether a usable user systemd manager exists. Plain WSL and containers often
 * have none; the caller then points at `npm start` under the launcher.
 */
export function systemdAvailable(systemctl = defaultSystemctl) {
  try {
    systemctl(["show-environment"]);
    return true;
  } catch {
    return false;
  }
}

export const SYSTEMD_UNAVAILABLE =
  "No systemd user manager is running (common on WSL without systemd=true, and in containers). " +
  "Run the Host and Node under the launcher instead: `npm start`, which also self-updates and restarts. " +
  "On WSL you can enable systemd in /etc/wsl.conf ([boot] systemd=true) and restart WSL.";

function state(kind, systemctl) {
  const unit = unitName(kind);
  const read = (args) => {
    try {
      return systemctl(args).trim();
    } catch (error) {
      return String(error.stdout ?? "").trim();
    }
  };
  const loadState = read(["show", unit, "--property=LoadState", "--value"]);
  const activeState = read(["show", unit, "--property=ActiveState", "--value"]);
  const enabled = read(["is-enabled", unit]);
  const installed = loadState === "loaded";
  const active = ["active", "activating", "reloading"].includes(activeState);
  return {
    installed,
    active,
    enabled: enabled === "enabled",
    activeState,
    // Same vocabulary as the Windows task, which the Host's updater reads:
    // a stopped service is disabled until someone starts it again.
    state: !installed
      ? "absent"
      : active
        ? "running"
        : enabled === "enabled"
          ? "ready"
          : "disabled",
  };
}

/**
 * Performs one action on a workload's unit. `manifest` must already be valid.
 * Returns `{ installed, active, enabled, taskName, ... }` like the Windows task.
 */
export function linuxTaskAction(
  action,
  manifest,
  manifestPath,
  { systemctl = defaultSystemctl, env = process.env, linger = enableLinger } = {},
) {
  const unit = unitName(manifest.kind);
  const path = posix.join(unitDirectory(env), unit);
  const result = (extra = {}) => ({
    ...state(manifest.kind, systemctl),
    taskName: unit,
    unitPath: path,
    ...extra,
  });
  switch (action) {
    case "status":
      return result();
    case "register": {
      mkdirSync(unitDirectory(env), { recursive: true });
      writeFileSync(path, unitFile(manifest, manifestPath), { mode: 0o644 });
      systemctl(["daemon-reload"]);
      systemctl(["enable", unit]);
      return result({ linger: linger() });
    }
    case "start":
      systemctl(["enable", unit]);
      systemctl(["start", unit]);
      return result();
    case "stop":
      // Like the Windows task, stop also disables future starts until `start`.
      systemctl(["stop", unit]);
      systemctl(["disable", unit]);
      return result();
    case "restart":
      systemctl(["enable", unit]);
      systemctl(["restart", unit]);
      return result();
    case "uninstall":
      if (existsSync(path)) {
        try {
          systemctl(["disable", "--now", unit]);
        } catch {
          // Already stopped or never enabled; removing the file is what matters.
        }
        rmSync(path, { force: true });
        systemctl(["daemon-reload"]);
      }
      return { installed: false, active: false, enabled: false, taskName: unit };
    default:
      throw new Error(`Unsupported login-start action: ${action}`);
  }
}

/**
 * Asks logind to keep this user's manager running without a login, so the
 * unit also starts at boot. Not fatal when policy forbids it: the unit still
 * starts at login, and the result says how to enable it.
 */
export function enableLinger(
  run = (args) =>
    execFileSync("loginctl", args, { stdio: "pipe", encoding: "utf8", timeout: 30_000 }),
  user = process.env.USER,
) {
  if (!user) return { enabled: false, hint: "Run: loginctl enable-linger $USER" };
  try {
    const shown = run(["show-user", user, "--property=Linger", "--value"]).trim();
    if (shown === "yes") return { enabled: true };
    run(["enable-linger", user]);
    return { enabled: true };
  } catch {
    return {
      enabled: false,
      hint: `To also start at boot without logging in, run: sudo loginctl enable-linger ${user}`,
    };
  }
}
