import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetSession, HostUpdateStatus } from "@fleet/protocol";
import {
  LAUNCHER_ENDPOINT_ENV,
  LAUNCHER_SCRIPT_ENV,
  LAUNCHER_TOKEN_ENV,
} from "@fleet/protocol/runtime";
import {
  readUpdateRecord,
  writeUpdateRecord,
  type UpdateRecord,
} from "@fleet/protocol/updater";
import {
  HostSelfUpdate,
  MANUAL_LAUNCH_REASON,
  NO_RECORD_REASON,
  detectHostLaunch,
  readLocalNodeId,
  requestLauncherUpdate,
  uncommittedChanges,
  type HostLaunch,
  type HostSelfUpdateOptions,
  type LaunchProbe,
} from "./self-update.js";

const temporary: string[] = [];
function directory(prefix = "fleet-host-update-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    await new Promise((done) => server.close(() => done(undefined)));
  }
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("detectHostLaunch", () => {
  const probe = (changes: Partial<LaunchProbe> = {}): LaunchProbe => ({
    env: {},
    platform: "win32",
    repoRoot: "Q:\\Repos\\copilot-fleet",
    readServiceManifest: () => undefined,
    stdoutIs: () => false,
    ...changes,
  });

  it.each([
    ["dev", "npm run dev"],
    ["dev:tunnel", "npm run dev:tunnel"],
    ["start", "npm start"],
  ])("recognises the launcher behind %s", (script, restartCommand) => {
    expect(
      detectHostLaunch(
        probe({
          env: {
            [LAUNCHER_SCRIPT_ENV]: script,
            [LAUNCHER_ENDPOINT_ENV]: "\\\\.\\pipe\\launcher",
            [LAUNCHER_TOKEN_ENV]: "secret",
          },
        }),
      ),
    ).toEqual({
      mode: script,
      restartCommand,
      endpoint: "\\\\.\\pipe\\launcher",
      token: "secret",
    });
  });

  it("does not trust a launcher it could not reach", () => {
    expect(detectHostLaunch(probe({ env: { [LAUNCHER_SCRIPT_ENV]: "dev" } }))).toEqual({
      mode: "manual",
      reason: MANUAL_LAUNCH_REASON,
    });
  });

  it("recognises the login service by the log it writes the Host's output to", () => {
    const manifests = {
      host: {
        repositoryPath: "q:\\repos\\COPILOT-FLEET\\",
        logPath: "C:\\host\\runtime.log",
      },
      node: {
        repositoryPath: "Q:\\Repos\\copilot-fleet",
        logPath: "C:\\node\\runtime.log",
      },
    };
    expect(
      detectHostLaunch(
        probe({
          readServiceManifest: (kind) => manifests[kind],
          stdoutIs: (path) => path === "C:\\host\\runtime.log",
        }),
      ),
    ).toEqual({
      mode: "service",
      restartCommand: "npm run service -- host+node restart",
      restartKind: "host+node",
    });
  });

  it("restarts only the Host when this checkout's Node is not a login service", () => {
    expect(
      detectHostLaunch(
        probe({
          readServiceManifest: (kind) =>
            kind === "host"
              ? { repositoryPath: "Q:\\Repos\\copilot-fleet", logPath: "C:\\host.log" }
              : { repositoryPath: "D:\\elsewhere", logPath: "C:\\node.log" },
          stdoutIs: () => true,
        }),
      ),
    ).toMatchObject({ mode: "service", restartKind: "host" });
  });

  it("does not take an installed service for the one that started this Host", () => {
    // A login service installed beside a Host started by hand would otherwise
    // be restarted from under it — onto a port the manual Host still holds.
    const installed = () => ({
      repositoryPath: "Q:\\Repos\\copilot-fleet",
      logPath: "C:\\host\\runtime.log",
    });
    expect(
      detectHostLaunch(probe({ readServiceManifest: installed, stdoutIs: () => false }))
        .mode,
    ).toBe("manual");
    expect(
      detectHostLaunch(
        probe({
          readServiceManifest: () => ({
            repositoryPath: "Q:\\Repos\\another-checkout",
            logPath: "C:\\host\\runtime.log",
          }),
          stdoutIs: () => true,
        }),
      ).mode,
    ).toBe("manual");
    expect(
      detectHostLaunch(
        probe({
          platform: "linux",
          readServiceManifest: installed,
          stdoutIs: () => true,
        }),
      ).mode,
    ).toBe("manual");
  });
});

describe("readLocalNodeId", () => {
  it("takes the id from the Node identity in this user's config directory", () => {
    const config = directory();
    writeFileSync(
      join(config, "node.json"),
      JSON.stringify({ nodeId: "node-local", privateKey: "not read" }),
    );
    expect(readLocalNodeId({ FLEET_NODE_CONFIG_DIR: config })).toBe("node-local");
  });

  it("is undefined for a machine with no Node enrolled", () => {
    expect(readLocalNodeId({ FLEET_NODE_CONFIG_DIR: directory() })).toBeUndefined();
  });
});

describe("uncommittedChanges", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });

  it("refuses to reset over edits nobody has committed", async () => {
    const repo = directory("fleet-host-dirty-");
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "fleet@example.com");
    git(repo, "config", "user.name", "Fleet Test");
    writeFileSync(join(repo, "tracked.txt"), "one");
    writeFileSync(join(repo, "package-lock.json"), "{}");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "first");

    // Untracked files survive a reset, so they are no reason to refuse.
    writeFileSync(join(repo, ".env"), "PORT=8787");
    await expect(uncommittedChanges(repo)).resolves.toBeUndefined();
    // Nor is the lockfile npm rewrites by itself, or one update would block the next.
    writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}');
    await expect(uncommittedChanges(repo)).resolves.toBeUndefined();

    writeFileSync(join(repo, "tracked.txt"), "edited");
    const reason = await uncommittedChanges(repo);
    expect(reason).toContain("tracked.txt");
    expect(reason).not.toContain("package-lock.json");
    expect(reason).toContain("commit or stash them first");
  }, 30_000);
});

describe("uncommittedChanges when git cannot answer", () => {
  it("refuses rather than calling an unreadable checkout clean", async () => {
    // Standing between a reset and somebody's work, the check fails closed.
    const reason = await uncommittedChanges(directory("fleet-host-not-git-"));
    expect(reason).toContain("Could not check");
  }, 30_000);
});
describe("requestLauncherUpdate", () => {
  function launcher(reply: (line: string) => string): string {
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\fleet-test-${process.pid}-${Math.random().toString(16).slice(2)}`
        : join(directory(), "launcher.sock");
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) socket.end(`${reply(buffer.trim())}\n`);
      });
    });
    servers.push(server);
    server.listen(endpoint);
    return endpoint;
  }

  const message = {
    token: "secret",
    type: "update" as const,
    updateId: "update-1",
    statusFile: "/data/self-update.json",
  };

  it("sends the request and resolves once the launcher takes it on", async () => {
    const received: unknown[] = [];
    const endpoint = launcher((line) => {
      received.push(JSON.parse(line));
      return JSON.stringify({ ok: true });
    });
    await expect(requestLauncherUpdate(endpoint, message)).resolves.toBeUndefined();
    expect(received).toEqual([message]);
  });

  it("passes on the launcher's own reason for refusing", async () => {
    const endpoint = launcher(() =>
      JSON.stringify({ ok: false, error: "An update is already running" }),
    );
    await expect(requestLauncherUpdate(endpoint, message)).rejects.toThrow(
      "An update is already running",
    );
  });

  it("says so when there is no launcher to reach", async () => {
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\fleet-test-missing-${process.pid}`
        : join(directory(), "missing.sock");
    await expect(requestLauncherUpdate(endpoint, message)).rejects.toThrow(
      "not reachable",
    );
  });
});

describe("HostSelfUpdate", () => {
  const launcherLaunch: HostLaunch = {
    mode: "dev",
    restartCommand: "npm run dev",
    endpoint: "\\\\.\\pipe\\launcher",
    token: "secret",
  };
  const session = (id: string): FleetSession => ({ id }) as FleetSession;

  function subject(changes: Partial<HostSelfUpdateOptions> = {}) {
    const statusFile = join(directory(), "data", "self-update.json");
    const published: HostUpdateStatus[] = [];
    const options: HostSelfUpdateOptions = {
      launch: launcherLaunch,
      statusFile,
      currentRevision: () => "new222222222",
      startedAt: Date.parse("2026-09-24T08:00:00.000Z"),
      publish: (status) => published.push(status),
      localNodeId: () => "node-local",
      localNodeState: () => undefined,
      liveSessions: () => [],
      nodeUpdateInFlight: () => false,
      stopSessions: vi.fn(),
      checkoutBusy: () => undefined,
      uncommittedChanges: async () => undefined,
      requestLauncher: vi.fn(async () => undefined),
      scheduleService: vi.fn(async () => undefined),
      log: { info: vi.fn(), warn: vi.fn() } as unknown as HostSelfUpdateOptions["log"],
      isAlive: () => true,
      now: () => Date.parse("2026-09-24T09:00:00.000Z"),
      pollMs: 5,
      ...changes,
    };
    const update = new HostSelfUpdate(options);
    return { update, options, published, statusFile };
  }

  const record = (changes: Partial<UpdateRecord> = {}): UpdateRecord => ({
    updateId: "update-1",
    stage: "building",
    detail: "npm run build",
    restartCommand: "npm run dev",
    revision: "",
    requestedAt: "2026-09-24T08:58:00.000Z",
    updatedAt: "2026-09-24T08:59:00.000Z",
    confirmRestart: "host",
    updaterPid: 4242,
    ...changes,
  });

  it("explains why a Host started by hand cannot update itself", async () => {
    const { update } = subject({
      launch: { mode: "manual", reason: MANUAL_LAUNCH_REASON },
    });
    expect(update.status()).toEqual({
      launch: "manual",
      restartCommand: "",
      unavailableReason: MANUAL_LAUNCH_REASON,
    });
    await expect(update.request()).resolves.toEqual({
      started: false,
      status: 409,
      reason: MANUAL_LAUNCH_REASON,
    });
  });

  it("will not follow an update it has nowhere to record", async () => {
    const { update } = subject({ statusFile: undefined });
    expect(update.status().unavailableReason).toBe(NO_RECORD_REASON);
    expect((await update.request()).started).toBe(false);
  });

  it("hands the update to the launcher, then follows the launcher's record", async () => {
    const { update, options, published, statusFile } = subject();
    const result = await update.request();

    expect(result).toEqual({ started: true });
    expect(options.requestLauncher).toHaveBeenCalledWith("\\\\.\\pipe\\launcher", {
      token: "secret",
      type: "update",
      updateId: expect.any(String),
      statusFile,
    });
    const requested = readUpdateRecord(statusFile)!;
    expect(requested).toMatchObject({
      stage: "checking",
      detail: "Update requested",
      restartCommand: "npm run dev",
      // The launcher's restart only launches, so the new Host confirms it.
      confirmRestart: "host",
    });
    expect(published.at(-1)?.update).toMatchObject({ stage: "checking" });

    // The launcher owns the record from here; each change reaches browsers.
    writeUpdateRecord(statusFile, {
      ...requested,
      stage: "installing",
      detail: "npm install --include=dev",
      updaterPid: 4242,
    });
    await vi.waitFor(() =>
      expect(published.at(-1)?.update).toMatchObject({ stage: "installing" }),
    );
    writeUpdateRecord(statusFile, {
      ...requested,
      stage: "up_to_date",
      detail: "Already up to date",
      updaterPid: 4242,
    });
    await vi.waitFor(() =>
      expect(update.status().update).toMatchObject({ stage: "up_to_date" }),
    );
    update.close();
  });

  it("keeps following through a moment the record cannot be read", async () => {
    const { update, published, statusFile } = subject();
    writeUpdateRecord(statusFile, record());
    update.start();
    // Mid-rename on Windows, the file is briefly unreadable.
    writeFileSync(statusFile, "{");
    await new Promise((done) => setTimeout(done, 30));
    expect(update.status().update).toMatchObject({ stage: "building" });
    writeUpdateRecord(
      statusFile,
      record({ stage: "up_to_date", detail: "Updated to x" }),
    );
    await vi.waitFor(() =>
      expect(published.at(-1)?.update).toMatchObject({ stage: "up_to_date" }),
    );
    update.close();
  });

  it("refuses a second update while one is running", async () => {
    const { update, statusFile } = subject();
    writeUpdateRecord(statusFile, record());
    update.start();
    await expect(update.request()).resolves.toMatchObject({
      started: false,
      status: 409,
      reason: "A Host update is already running",
    });
    update.close();
  });

  it("refuses while another update holds the checkout", async () => {
    const { update, options } = subject({
      checkoutBusy: () => "Another update of this checkout is running (process 7)",
    });
    expect(await update.request()).toEqual({
      started: false,
      status: 409,
      reason: "Another update of this checkout is running (process 7)",
    });
    expect(options.requestLauncher).not.toHaveBeenCalled();
  });

  it("waits for the Node beside it to finish its own update", async () => {
    const { update, options } = subject({ nodeUpdateInFlight: () => true });
    expect(await update.request()).toMatchObject({ started: false, status: 409 });
    expect(options.requestLauncher).not.toHaveBeenCalled();
  });

  it("refuses to reset a checkout with uncommitted work in it", async () => {
    const { update, options } = subject({
      uncommittedChanges: async () => "Q:\\Repos\\copilot-fleet has uncommitted changes",
    });
    expect(await update.request()).toEqual({
      started: false,
      status: 409,
      reason: "Q:\\Repos\\copilot-fleet has uncommitted changes",
    });
    expect(options.requestLauncher).not.toHaveBeenCalled();
  });

  it("names the local Node's sessions, and stops exactly those it was told to", async () => {
    const live = [session("session-1"), session("session-2")];
    const { update, options } = subject({ liveSessions: () => live });

    const refused = await update.request();
    expect(refused).toMatchObject({ started: false, status: 409, blockedBy: live });
    expect(options.requestLauncher).not.toHaveBeenCalled();
    expect(options.stopSessions).not.toHaveBeenCalled();

    expect(
      await update.request({
        stopSessions: true,
        sessionIds: ["session-1", "session-2"],
      }),
    ).toEqual({ started: true });
    expect(options.stopSessions).toHaveBeenCalledWith("node-local", live);
    update.close();
  });

  it("asks again about a session started since the operator agreed", async () => {
    const live = [session("session-1"), session("session-new")];
    const { update, options } = subject({ liveSessions: () => live });
    expect(
      await update.request({ stopSessions: true, sessionIds: ["session-1"] }),
    ).toMatchObject({ started: false, status: 409, blockedBy: live });
    expect(options.stopSessions).not.toHaveBeenCalled();
    expect(options.requestLauncher).not.toHaveBeenCalled();
  });

  it("stops nothing and records the failure when the launcher cannot be reached", async () => {
    const live = [session("session-1")];
    const { update, options, statusFile } = subject({
      liveSessions: () => live,
      requestLauncher: async () => {
        throw new Error("the launcher is not reachable (ENOENT)");
      },
    });
    const result = await update.request({
      stopSessions: true,
      sessionIds: ["session-1"],
    });

    expect(result).toEqual({
      started: false,
      status: 502,
      reason: "Could not start the update: the launcher is not reachable (ENOENT)",
    });
    expect(options.stopSessions).not.toHaveBeenCalled();
    expect(readUpdateRecord(statusFile)).toMatchObject({
      stage: "failed",
      detail: "Could not start the update: the launcher is not reachable (ENOENT)",
    });
    // A failed start is finished, so the next attempt is not refused.
    expect(update.status().update?.stage).toBe("failed");
  });

  it("schedules a login-service update with what the service is running", async () => {
    const { update, options, statusFile } = subject({
      launch: {
        mode: "service",
        restartCommand: "npm run service -- host+node restart",
        restartKind: "host+node",
      },
      startupRevision: () => "abc123def456",
    });
    expect(await update.request()).toEqual({ started: true });
    expect(options.scheduleService).toHaveBeenCalledWith({
      statusFile,
      updateId: expect.any(String),
      restartKind: "host+node",
      runningRevision: "abc123def456",
    });
    expect(readUpdateRecord(statusFile)?.confirmRestart).toBe("host");
    expect(options.requestLauncher).not.toHaveBeenCalled();
    update.close();
  });

  it("blocks a separate update of the local Node while its own is running", () => {
    const { update, statusFile } = subject();
    writeUpdateRecord(statusFile, record());
    update.start();
    expect(update.blocksNodeUpdate("node-local")).toContain("restarts with it");
    expect(update.blocksNodeUpdate("node-remote")).toBeUndefined();
    update.close();
  });

  describe("after a restart", () => {
    const launched = (changes: Partial<UpdateRecord> = {}) =>
      record({
        stage: "restarting",
        revision: "new222222222",
        restartRequestedAt: "2026-09-24T07:59:59.000Z",
        ...changes,
      });

    it("is confirmed by the new Host once it is serving the build the update made", () => {
      const { update, statusFile } = subject();
      writeUpdateRecord(statusFile, launched());
      update.start();
      // Started is not serving: a Host that cannot bind its port is no success.
      expect(update.status().update).toMatchObject({ stage: "restarting" });
      update.ready();
      expect(update.status().update).toMatchObject({
        stage: "up_to_date",
        detail: "Updated to new222222222",
      });
      // Written back, so the next Host start does not announce it again.
      expect(readUpdateRecord(statusFile)?.stage).toBe("up_to_date");
      update.close();
    });

    it("waits for the Node beside it to come back on the new build before confirming", () => {
      let clock = Date.parse("2026-09-24T09:00:00.000Z");
      let node = { online: false, revision: "old111111111" };
      const { update, statusFile } = subject({
        now: () => clock,
        localNodeState: () => node,
      });
      writeUpdateRecord(statusFile, launched());
      update.start();
      update.ready();
      // A Host that came back alone is no proof its Node did.
      expect(update.status().update).toMatchObject({ stage: "restarting" });
      node = { online: true, revision: "new222222222" };
      clock += 30_000;
      update.ready();
      expect(update.status().update).toMatchObject({
        stage: "up_to_date",
        detail: "Updated to new222222222",
      });
      update.close();
    });

    it("gives up on a Node that does not come back", () => {
      let clock = Date.parse("2026-09-24T09:00:00.000Z");
      const { update, statusFile } = subject({
        now: () => clock,
        localNodeState: () => ({ online: false, revision: "old111111111" }),
      });
      writeUpdateRecord(statusFile, launched());
      update.start();
      update.ready();
      clock += 4 * 60_000;
      update.ready();
      expect(update.status().update).toMatchObject({
        stage: "failed",
        detail: "The Host is on new222222222, but this machine's Node did not come back",
      });
    });

    it("does not wait for a Node this Host has never heard of", () => {
      const { update, statusFile } = subject({ localNodeState: () => undefined });
      writeUpdateRecord(statusFile, launched());
      update.start();
      update.ready();
      expect(update.status().update).toMatchObject({ stage: "up_to_date" });
    });
    it("says so when the Host came back on some other commit", () => {
      const { update, statusFile } = subject({ currentRevision: () => "other3333333" });
      writeUpdateRecord(statusFile, launched());
      update.start();
      update.ready();
      expect(update.status().update).toMatchObject({
        stage: "failed",
        detail: "The Host came back on other3333333, not new222222222",
      });
    });

    it("does not count a Host that started before the restart as the new build", () => {
      const { update, statusFile } = subject({ isAlive: () => false });
      writeUpdateRecord(
        statusFile,
        launched({ restartRequestedAt: "2026-09-24T08:30:00.000Z" }),
      );
      update.start();
      update.ready();
      expect(update.status().update).toMatchObject({ stage: "failed" });
      expect(update.status().update?.detail).toContain("stopped before it finished");
    });

    it("leaves a login-service restart to its updater, and fails one it abandoned", async () => {
      // The Host came back, but the updater died before starting the Node:
      // a Host that returned is no proof the rest of the restart happened.
      let alive = true;
      const { update, statusFile } = subject({ isAlive: () => alive });
      writeUpdateRecord(statusFile, launched({ confirmRestart: "updater" }));
      update.start();
      update.ready();
      expect(update.status().update).toMatchObject({ stage: "restarting" });
      alive = false;
      await vi.waitFor(() =>
        expect(update.status().update).toMatchObject({ stage: "failed" }),
      );
      update.close();
    });

    it("fails an update whose updater died mid-way", () => {
      const { update, statusFile } = subject({ isAlive: () => false });
      writeUpdateRecord(statusFile, record({ stage: "installing" }));
      update.start();
      expect(update.status().update).toMatchObject({ stage: "failed" });
      expect(update.status().update?.detail).toContain("npm run build");
    });

    it("fails an update whose heartbeat stopped, even if its pid is still taken", () => {
      const { update, statusFile } = subject();
      writeUpdateRecord(
        statusFile,
        record({ stage: "installing", updatedAt: "2026-09-24T08:40:00.000Z" }),
      );
      update.start();
      expect(update.status().update).toMatchObject({ stage: "failed" });
      expect(update.status().update?.detail).toContain("stopped making progress");
    });

    it("fails a request nothing ever picked up", () => {
      const { update, statusFile } = subject();
      writeUpdateRecord(
        statusFile,
        record({
          stage: "checking",
          updaterPid: undefined,
          requestedAt: "2026-09-24T08:00:00.000Z",
        }),
      );
      update.start();
      expect(update.status().update).toMatchObject({ stage: "failed" });
    });

    it("keeps following an update that is still running", async () => {
      const { update, published, statusFile } = subject();
      writeUpdateRecord(statusFile, record());
      update.start();
      expect(update.status().update).toMatchObject({ stage: "building" });
      writeUpdateRecord(
        statusFile,
        record({ stage: "up_to_date", detail: "Updated to x" }),
      );
      await vi.waitFor(() =>
        expect(published.at(-1)?.update).toMatchObject({ stage: "up_to_date" }),
      );
      update.close();
    });

    it("leaves a finished update as it is", () => {
      const { update, statusFile } = subject({ isAlive: () => false });
      const finished = record({ stage: "failed", detail: "npm run build: TS2345" });
      writeUpdateRecord(statusFile, finished);
      update.start();
      expect(readUpdateRecord(statusFile)).toEqual(finished);
      expect(update.status().update).toMatchObject({ stage: "failed" });
    });
  });

  describe("blocksNodeWork", () => {
    it("holds new work off the local Node until the restart has replaced this Host", () => {
      const { update, statusFile } = subject();
      writeUpdateRecord(statusFile, record({ stage: "installing" }));
      update.start();
      expect(update.blocksNodeWork("node-local")).toContain("updating the Host");
      expect(update.blocksNodeWork("node-remote")).toBeUndefined();
      update.close();
    });

    it("lifts it in the Host the restart brought up, and once the update is over", () => {
      const replaced = subject();
      writeUpdateRecord(
        replaced.statusFile,
        record({
          stage: "restarting",
          revision: "new222222222",
          restartRequestedAt: "2026-09-24T07:59:59.000Z",
        }),
      );
      replaced.update.start();
      expect(replaced.update.blocksNodeWork("node-local")).toBeUndefined();
      replaced.update.close();

      const finished = subject();
      writeUpdateRecord(finished.statusFile, record({ stage: "failed" }));
      finished.update.start();
      expect(finished.update.blocksNodeWork("node-local")).toBeUndefined();
    });
  });

  it("retries a record that exists but cannot be read the moment it starts", async () => {
    const { update, statusFile } = subject();
    mkdirSync(dirname(statusFile), { recursive: true });
    writeFileSync(statusFile, "{");
    update.start();
    expect(update.status().update).toBeUndefined();
    writeUpdateRecord(statusFile, record());
    await vi.waitFor(() =>
      expect(update.status().update).toMatchObject({ stage: "building" }),
    );
    update.close();
  });
  it("creates the data directory for its first record", async () => {
    const { update, statusFile } = subject();
    expect(await update.request()).toEqual({ started: true });
    expect(readUpdateRecord(statusFile)).toBeDefined();
    update.close();
  });
});
