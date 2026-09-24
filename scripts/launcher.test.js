import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "@fleet/protocol/runtime";
import {
  HOST_BUILD_SCRIPT,
  LAUNCHER_ENDPOINT_ENV,
  LAUNCHER_SCRIPT_ENV,
  LAUNCHER_TOKEN_ENV,
  childCommand,
  createLauncher,
  displayCommand,
  launcherEndpoint,
} from "./launcher.mjs";

const children = [];
const directories = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "fleet-launcher-"));
  directories.push(path);
  return path;
}

/** Stands in for `npm run dev:bare`: a process that runs until it is stopped. */
function longRunning(env) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function send(endpoint, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      reply += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(JSON.parse(reply)));
  });
}

function endpoint() {
  return process.platform === "win32"
    ? launcherEndpoint()
    : join(directory(), "launcher.sock");
}

function launcher(overrides = {}) {
  const spawned = [];
  const exit = vi.fn();
  const revisions = ["rev-at-start", "rev-after-update"];
  const instance = createLauncher({
    script: "dev",
    root: "/checkout",
    env: { KEEP: "me" },
    endpoint: endpoint(),
    token: "secret",
    spawnChild: (env) => {
      const child = longRunning(env);
      spawned.push({ child, env });
      return child;
    },
    stopTree: (child) => child.kill(),
    headRevision: () => revisions.shift() ?? "rev-later",
    log: () => {},
    exit,
    stopGraceMs: 5_000,
    ...overrides,
  });
  instance.start();
  return { instance, spawned, exit };
}

describe("launcher", () => {
  it("names its endpoint per platform and says how it was started", () => {
    expect(launcherEndpoint(12, "win32", "ab")).toBe(
      "\\\\.\\pipe\\copilot-fleet-launcher-12-ab",
    );
    expect(launcherEndpoint(12, "linux", "ab")).toBe(
      join(tmpdir(), "copilot-fleet-launcher-12-ab.sock"),
    );
    expect(displayCommand("dev")).toBe("npm run dev");
    expect(displayCommand("dev:tunnel")).toBe("npm run dev:tunnel");
    expect(displayCommand("start")).toBe("npm start");
  });

  it("runs the bare script through the npm that started it, keeping the Node's arguments", () => {
    const cli = join(directory(), "npm-cli.js");
    writeFileSync(cli, "");
    expect(
      childCommand("dev", ["--url=https://fleet.example.com", "--name", "a b"], {
        env: { npm_execpath: cli },
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: [
        cli,
        "run",
        "dev:bare",
        "--",
        "--url=https://fleet.example.com",
        "--name",
        "a b",
      ],
      shell: false,
    });
  });

  it("uses the same variable names the Host and Node read", () => {
    // The launcher cannot import them — it has to start before anything is
    // built — so a rename on one side would silently turn updates off.
    expect(LAUNCHER_ENDPOINT_ENV).toBe(runtime.LAUNCHER_ENDPOINT_ENV);
    expect(LAUNCHER_TOKEN_ENV).toBe(runtime.LAUNCHER_TOKEN_ENV);
    expect(LAUNCHER_SCRIPT_ENV).toBe(runtime.LAUNCHER_SCRIPT_ENV);
    expect(HOST_BUILD_SCRIPT).toBe("build");
  });

  it("updates on request, then replaces the command with a fresh run of it", async () => {
    const applyUpdate = vi.fn(async (options) => {
      expect(await options.restart("rev-after-update")).toBeUndefined();
      return { stage: "up_to_date", detail: "Updated to rev-after-update" };
    });
    const { instance, spawned } = launcher({
      loadUpdater: async () => ({ applyUpdate, runCommand: vi.fn() }),
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(spawned[0].env).toMatchObject({
      KEEP: "me",
      [LAUNCHER_ENDPOINT_ENV]: instance.endpoint,
      [LAUNCHER_TOKEN_ENV]: "secret",
      [LAUNCHER_SCRIPT_ENV]: "dev",
    });

    const statusFile = join(directory(), "self-update.json");
    await expect(
      send(instance.endpoint, {
        token: "secret",
        type: "update",
        updateId: "u-1",
        statusFile,
      }),
    ).resolves.toEqual({ ok: true });

    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        statusFile,
        updateId: "u-1",
        restartCommand: "npm run dev",
        // Launching the command proves nothing; the new Host confirms.
        confirmRestart: "host",
        checkout: expect.objectContaining({
          repoRoot: "/checkout",
          buildScript: "build",
          preserveLocalChanges: true,
          // What the running processes were started from, not whatever HEAD
          // the reset moved to: that is what decides "already up to date".
          runningRevision: "rev-at-start",
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(spawned[0].child.exitCode ?? spawned[0].child.signalCode).not.toBeNull(),
    );
    expect(spawned[1].child.exitCode).toBeNull();
    await vi.waitFor(() => expect(instance.state().updating).toBe(false));
    expect(instance.state().revisionAtStart).toBe("rev-after-update");
  });

  it("turns away requests without the token, or with a path it cannot trust", async () => {
    const { instance, spawned } = launcher({ loadUpdater: async () => ({}) });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await expect(
      send(instance.endpoint, {
        token: "guess",
        type: "update",
        updateId: "u-1",
        statusFile: join(directory(), "s.json"),
      }),
    ).resolves.toEqual({ ok: false, error: "Not authorised" });
    await expect(
      send(instance.endpoint, {
        token: "secret",
        type: "update",
        updateId: "u-1",
        statusFile: "relative/s.json",
      }),
    ).resolves.toEqual({ ok: false, error: "Malformed update request" });
  });

  it("runs one update at a time", async () => {
    let finish;
    const applyUpdate = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ stage: "up_to_date", detail: "Already up to date" });
        }),
    );
    const { instance, spawned } = launcher({
      loadUpdater: async () => ({ applyUpdate, runCommand: vi.fn() }),
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const request = {
      token: "secret",
      type: "update",
      updateId: "u-1",
      statusFile: join(directory(), "s.json"),
    };
    await expect(send(instance.endpoint, request)).resolves.toEqual({ ok: true });
    await expect(
      send(instance.endpoint, { ...request, updateId: "u-2" }),
    ).resolves.toEqual({
      ok: false,
      error: "An update is already running",
    });
    finish();
    await vi.waitFor(() => expect(instance.state().updating).toBe(false));
    // Nothing to restart for: the command it was already running stays up.
    expect(spawned).toHaveLength(1);
  });

  it("says the update code is missing rather than taking the request", async () => {
    const { instance, spawned } = launcher({
      loadUpdater: async () => {
        throw new Error("Cannot find package '@fleet/protocol'");
      },
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const reply = await send(instance.endpoint, {
      token: "secret",
      type: "update",
      updateId: "u-1",
      statusFile: join(directory(), "s.json"),
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("npm run build");
    expect(instance.state().updating).toBe(false);
  });

  it("leaves when the command ends by itself, with its exit status", async () => {
    const { spawned, exit } = launcher();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0].child.kill();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(spawned).toHaveLength(1);
  });

  it("stops for good on Ctrl-C instead of restarting", async () => {
    const { instance, spawned, exit } = launcher();
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    instance.interrupt("SIGINT");
    // Windows hands Ctrl-C to the whole console; stand in for that here.
    spawned[0].child.kill();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    if (process.platform !== "win32") expect(existsSync(instance.endpoint)).toBe(false);
  });
});
