import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import process from "node:process";
import {
  enableLinger,
  linuxTaskAction,
  systemdAvailable,
  unitFile,
  unitName,
} from "./linux-login-service.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const manifest = {
  kind: "node",
  repositoryPath: "/home/me/fleet $HOME",
  nodePath: "/usr/bin/node",
  runnerPath: "/home/me/.local/state/copilot-fleet/login/node/login-service-runner.mjs",
};
const manifestPath = "/home/me/.local/state/copilot-fleet/login/node/manifest.json";

/** A systemctl that records calls and reports a unit's state from a map. */
function fakeSystemctl(state = { LoadState: "loaded", ActiveState: "inactive" }) {
  const calls = [];
  const systemctl = vi.fn((args) => {
    calls.push(args.join(" "));
    if (args[0] === "show") return `${state[args[2].split("=")[1]] ?? ""}\n`;
    if (args[0] === "is-enabled") return state.enabled ? "enabled\n" : "disabled\n";
    return "";
  });
  return { systemctl, calls };
}

describe("systemd user unit", () => {
  it("runs the runner with the manifest, escaping systemd specials", () => {
    const text = unitFile(manifest, manifestPath);
    expect(text).toContain(
      `ExecStart="/usr/bin/node" "${manifest.runnerPath}" "${manifestPath}"`,
    );
    expect(text).toContain("WorkingDirectory=/home/me/fleet $HOME\n");
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("KillMode=control-group");
    expect(text).toContain("WantedBy=default.target");
    expect(unitName("host")).toBe("copilot-fleet-host.service");
  });
});

describe.skipIf(process.platform === "win32")("systemd user unit files", () => {
  it.skipIf(
    spawnSync("systemd-analyze", ["--version"], { stdio: "ignore" }).status !== 0,
  )("is accepted by systemd-analyze verify", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-unit-verify-"));
    directories.push(directory);
    const runner = join(directory, "runner.mjs");
    writeFileSync(runner, "");
    const path = join(directory, "copilot-fleet-node.service");
    writeFileSync(
      path,
      unitFile(
        {
          ...manifest,
          repositoryPath: directory,
          nodePath: process.execPath,
          runnerPath: runner,
        },
        join(directory, "manifest with space.json"),
      ),
    );
    const verify = spawnSync("systemd-analyze", ["--user", "verify", path], {
      encoding: "utf8",
    });
    // Only this unit's own errors matter; the host's other units are not ours.
    const ours = `${verify.stdout}${verify.stderr}`
      .split("\n")
      .filter((line) => line.includes("copilot-fleet-node.service"));
    expect(ours).toEqual([]);
  });

  it("registers, enables and reports linger without starting", () => {
    const config = mkdtempSync(join(tmpdir(), "fleet-systemd-"));
    directories.push(config);
    const { systemctl, calls } = fakeSystemctl();
    const result = linuxTaskAction("register", manifest, manifestPath, {
      systemctl,
      env: { XDG_CONFIG_HOME: config },
      linger: () => ({ enabled: false, hint: "enable linger" }),
    });
    const path = join(config, "systemd", "user", "copilot-fleet-node.service");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(manifestPath);
    expect(calls).toContain("daemon-reload");
    expect(calls).toContain("enable copilot-fleet-node.service");
    expect(calls.some((call) => call.startsWith("start"))).toBe(false);
    expect(result).toMatchObject({
      installed: true,
      taskName: "copilot-fleet-node.service",
      linger: { enabled: false },
    });
  });

  it("uninstall removes the unit file and is idempotent", () => {
    const config = mkdtempSync(join(tmpdir(), "fleet-systemd-"));
    directories.push(config);
    const { systemctl } = fakeSystemctl();
    const options = { systemctl, env: { XDG_CONFIG_HOME: config }, linger: () => ({}) };
    linuxTaskAction("register", manifest, manifestPath, options);
    expect(linuxTaskAction("uninstall", manifest, manifestPath, options)).toMatchObject({
      installed: false,
    });
    expect(
      existsSync(join(config, "systemd", "user", "copilot-fleet-node.service")),
    ).toBe(false);
    expect(() =>
      linuxTaskAction("uninstall", manifest, manifestPath, options),
    ).not.toThrow();
  });
});

describe("systemd user unit control", () => {
  it("stop also disables, like the Windows task; start re-enables", () => {
    const { systemctl, calls } = fakeSystemctl({
      LoadState: "loaded",
      ActiveState: "active",
      enabled: true,
    });
    expect(
      linuxTaskAction("status", manifest, manifestPath, { systemctl }),
    ).toMatchObject({
      installed: true,
      active: true,
      enabled: true,
    });
    linuxTaskAction("stop", manifest, manifestPath, { systemctl });
    expect(calls).toEqual(
      expect.arrayContaining([
        "stop copilot-fleet-node.service",
        "disable copilot-fleet-node.service",
      ]),
    );
    calls.length = 0;
    linuxTaskAction("start", manifest, manifestPath, { systemctl });
    expect(calls.slice(0, 2)).toEqual([
      "enable copilot-fleet-node.service",
      "start copilot-fleet-node.service",
    ]);
  });

  it("detects a missing user manager", () => {
    expect(
      systemdAvailable(() => {
        throw new Error("Failed to connect to bus");
      }),
    ).toBe(false);
    expect(systemdAvailable(() => "PATH=/usr/bin\n")).toBe(true);
  });

  it("reports linger instead of failing when policy refuses it", () => {
    expect(enableLinger(() => "yes\n", "me")).toEqual({ enabled: true });
    const refused = enableLinger((args) => {
      if (args[0] === "show-user") return "no\n";
      throw new Error("Access denied");
    }, "me");
    expect(refused).toMatchObject({
      enabled: false,
      hint: expect.stringContaining("me"),
    });
  });
});
