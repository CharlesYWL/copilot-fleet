import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effectiveRestartKind,
  parseArguments,
  restartCommand,
  run,
  schedule,
  taskArguments,
  taskXml,
  updateTaskName,
} from "./self-update.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "fleet-self-update-"));
  directories.push(path);
  return path;
}

const statusFile = "C:\\Fleet\\apps\\host\\data\\self-update.json";
const valid = [
  "--status",
  statusFile,
  "--update-id",
  "0b6f3c1e-9d2a-4a57-8f7e-1c2d3e4f5a6b",
  "--restart",
  "host+node",
  "--running-revision",
  "abc123def456",
];

/** What PowerShell would run, decoded from the task's -EncodedCommand. */
function decoded(argumentsLine) {
  const encoded = argumentsLine.split(" ").at(-1);
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("self-update", () => {
  it("accepts exactly what the Host sends", () => {
    expect(parseArguments(["schedule", ...valid])).toEqual({
      action: "schedule",
      statusFile,
      updateId: "0b6f3c1e-9d2a-4a57-8f7e-1c2d3e4f5a6b",
      restart: "host+node",
      runningRevision: "abc123def456",
    });
  });

  it.each([
    [["upgrade", ...valid], "Usage"],
    [
      ["run", "--status", "relative.json", "--update-id", "u", "--restart", "host"],
      "absolute",
    ],
    [
      ["run", "--status", statusFile, "--update-id", "u; calc", "--restart", "host"],
      "letters",
    ],
    [
      ["run", "--status", statusFile, "--update-id", "u", "--restart", "node"],
      "--restart",
    ],
    [
      [
        "run",
        "--status",
        statusFile,
        "--update-id",
        "u",
        "--restart",
        "host",
        "--x",
        "1",
      ],
      "Unknown",
    ],
    [
      [
        "run",
        "--status",
        statusFile,
        "--update-id",
        "u",
        "--restart",
        "host",
        "--running-revision",
        "HEAD~1",
      ],
      "commit",
    ],
  ])("refuses anything else: %j", (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });

  it("names one task per Windows user", () => {
    const sid = "S-1-5-21-1-2-3-1001";
    expect(updateTaskName(sid)).toMatch(/^CopilotFleetSelfUpdate-[0-9a-f]{12}$/);
    expect(updateTaskName(sid)).toBe(updateTaskName(sid));
    expect(updateTaskName("S-1-5-21-1-2-3-1002")).not.toBe(updateTaskName(sid));
    expect(restartCommand("host+node")).toBe("npm run service -- host+node restart");
  });

  it("encodes the command so no path can break out of its quotes", () => {
    const options = {
      ...parseArguments(["run", ...valid]),
      statusFile: "C:\\Users\\o'brien\\data\\self-update.json",
    };
    const line = taskArguments({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      script: "C:\\Fleet\\scripts\\self-update.mjs",
      options,
    });
    expect(
      line.startsWith("-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden"),
    ).toBe(true);
    expect(decoded(line)).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Fleet\\scripts\\self-update.mjs' 'run' " +
        "'--status' 'C:\\Users\\o''brien\\data\\self-update.json' " +
        "'--update-id' '0b6f3c1e-9d2a-4a57-8f7e-1c2d3e4f5a6b' '--restart' 'host+node' " +
        "'--running-revision' 'abc123def456'; exit $LASTEXITCODE",
    );
  });

  it("defines an on-demand task for the signed-in user, escaped for XML", () => {
    const definition = taskXml({
      sid: "S-1-5-21-1-2-3-1001",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      argumentsLine: "-EncodedCommand abc",
      workingDirectory: "C:\\R&D\\copilot-fleet",
    });
    expect(definition).toContain("<UserId>S-1-5-21-1-2-3-1001</UserId>");
    // The login-task controller refuses to run for anything but the
    // interactive user, and a stored password is not something to ask for.
    expect(definition).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(definition).toContain(
      "<WorkingDirectory>C:\\R&amp;D\\copilot-fleet</WorkingDirectory>",
    );
    expect(definition).not.toContain("<Triggers>");
  });

  it("registers the task from a UTF-16 definition, starts it, and leaves no file behind", () => {
    const status = join(directory(), "self-update.json");
    const calls = [];
    const exec = vi.fn((file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "/Create") {
        const bytes = readFileSync(args[args.indexOf("/XML") + 1]);
        expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
        expect(bytes.subarray(2).toString("utf16le")).toContain("InteractiveToken");
      }
      return "";
    });
    const result = schedule(
      { ...parseArguments(["schedule", ...valid]), statusFile: status },
      {
        sid: "S-1-5-21-1-2-3-1001",
        exec,
        nodePath: "C:\\nodejs\\node.exe",
        root: "C:\\Fleet",
        platform: "win32",
      },
    );
    const taskName = updateTaskName("S-1-5-21-1-2-3-1001");
    expect(result).toEqual({ ok: true, taskName });
    expect(calls.map((call) => call.slice(1, 3))).toEqual([
      ["/Create", "/TN"],
      ["/Run", "/TN"],
    ]);
    expect(calls[0]).toContain("/F");
    expect(existsSync(`${status}.task.xml`)).toBe(false);
  });

  it("refuses to schedule anywhere but Windows", () => {
    expect(() =>
      schedule(parseArguments(["schedule", ...valid]), {
        sid: "S-1-5-21-1-2-3-1001",
        exec: vi.fn(),
        platform: "linux",
      }),
    ).toThrow("only on Windows");
  });

  describe("effectiveRestartKind", () => {
    const status = (answer) => vi.fn(() => ({ stdout: `${JSON.stringify(answer)}\n` }));

    it("leaves a Node its operator stopped switched off", () => {
      const log = vi.fn();
      const runSync = status({ installed: true, state: "disabled", active: false });
      expect(effectiveRestartKind("host+node", { root: "C:\\Fleet", log, runSync })).toBe(
        "host",
      );
      expect(runSync.mock.calls[0][1]).toEqual([
        join("C:\\Fleet", "scripts", "login-service-cli.mjs"),
        "node",
        "status",
      ]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("only the Host"));
    });

    it("restarts only the Host when the Node task was uninstalled", () => {
      // Uninstall keeps the manifest the Host found, but there is no task to start.
      const log = vi.fn();
      expect(
        effectiveRestartKind("host+node", {
          root: "C:\\Fleet",
          log,
          runSync: status({ installed: false, taskName: "CopilotFleetNodeLogin-x" }),
        }),
      ).toBe("host");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("not installed"));
    });

    it("restarts both when the Node task is running or cannot be read", () => {
      const log = vi.fn();
      expect(
        effectiveRestartKind("host+node", {
          root: "C:\\Fleet",
          log,
          runSync: status({ installed: true, state: "running", active: true }),
        }),
      ).toBe("host+node");
      expect(
        effectiveRestartKind("host+node", {
          root: "C:\\Fleet",
          log,
          runSync: () => ({ stdout: "not json" }),
        }),
      ).toBe("host+node");
      const untouched = vi.fn();
      expect(
        effectiveRestartKind("host", { root: "C:\\Fleet", log, runSync: untouched }),
      ).toBe("host");
      expect(untouched).not.toHaveBeenCalled();
    });
  });

  it("updates, restarts the services the way they were installed, and removes its task", async () => {
    const status = join(directory(), "self-update.json");
    const restart = vi.fn(async () => undefined);
    const removeTask = vi.fn();
    const applyUpdate = vi.fn(async (options) => {
      expect(options.checkout).toMatchObject({
        repoRoot: "C:\\Fleet",
        buildScript: "build",
        preserveLocalChanges: true,
        runningRevision: "abc123def456",
      });
      expect(options.restartCommand).toBe("npm run service -- host+node restart");
      // The tasks running is not Fleet serving in them; the new Host confirms.
      expect(options.confirmRestart).toBe("host");
      expect(await options.restart("new222222222")).toBeUndefined();
      return { stage: "up_to_date", detail: "Updated to new222222222" };
    });
    const code = await run(
      { ...parseArguments(["run", ...valid]), statusFile: status },
      {
        root: "C:\\Fleet",
        loadUpdater: async () => ({ applyUpdate, runCommand: vi.fn() }),
        environment: () => ({ FLEET_TEST_ENV: "from-manifest" }),
        restart,
        removeTask,
      },
    );
    expect(code).toBe(0);
    expect(restart).toHaveBeenCalledWith(
      "host+node",
      expect.objectContaining({ root: "C:\\Fleet" }),
    );
    expect(removeTask).toHaveBeenCalled();
    expect(process.env.FLEET_TEST_ENV).toBe("from-manifest");
    delete process.env.FLEET_TEST_ENV;
    expect(readFileSync(join(status, "..", "self-update.log"), "utf8")).toContain(
      "up_to_date: Updated to new222222222",
    );
  });

  it("reports a failed update in its exit status and still removes its task", async () => {
    const status = join(directory(), "self-update.json");
    const removeTask = vi.fn();
    const code = await run(
      { ...parseArguments(["run", ...valid]), statusFile: status },
      {
        root: "C:\\Fleet",
        loadUpdater: async () => ({
          applyUpdate: async () => ({ stage: "failed", detail: "npm run build: TS2345" }),
          runCommand: vi.fn(),
        }),
        environment: () => {
          throw new Error("no manifest");
        },
        restart: vi.fn(),
        removeTask,
      },
    );
    expect(code).toBe(1);
    expect(removeTask).toHaveBeenCalled();
    const log = readFileSync(join(status, "..", "self-update.log"), "utf8");
    expect(log).toContain("Could not load the Host task's environment (no manifest)");
    expect(log).toContain("failed: npm run build: TS2345");
  });
});
