import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { SELF_UPDATE_CAPABILITY } from "@fleet/protocol";
import { readUpdateRecord } from "@fleet/protocol/updater";
import { buildServer } from "../server.js";
import { MANUAL_LAUNCH_REASON } from "../self-update.js";

const OPERATOR_PASSWORD = "test-password";

describe("host update routes", () => {
  let app: FastifyInstance;
  let cookie = "";
  let csrfToken = "";
  const directories: string[] = [];

  const inject = (options: InjectOptions) =>
    app.inject({
      ...options,
      headers: { ...options.headers, cookie, "x-csrf-token": csrfToken },
    });

  async function start(options: Parameters<typeof buildServer>[0] = {}) {
    app = await buildServer({
      databasePath: ":memory:",
      enrollmentToken: "test-token",
      operatorPassword: OPERATOR_PASSWORD,
      ...options,
    });
    app.log.level = "silent";
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: OPERATOR_PASSWORD },
    });
    cookie = (login.headers["set-cookie"] as string).split(";")[0] ?? "";
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie },
    });
    csrfToken = (csrf.json() as { csrfToken: string }).csrfToken;
  }

  function statusFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "fleet-host-update-route-"));
    directories.push(directory);
    return join(directory, "self-update.json");
  }

  afterEach(async () => {
    await app?.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tells a Host started by hand that it cannot restart itself", async () => {
    await start();
    expect((await inject({ method: "GET", url: "/api/host/update" })).json()).toEqual({
      launch: "manual",
      restartCommand: "",
      unavailableReason: MANUAL_LAUNCH_REASON,
    });
    const refused = await inject({
      method: "POST",
      url: "/api/host/update",
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: MANUAL_LAUNCH_REASON });
    expect(
      (await inject({ method: "GET", url: "/api/snapshot" })).json().hostUpdate,
    ).toMatchObject({ launch: "manual" });
  });

  it("starts an update through the launcher and reports it with the fleet", async () => {
    const file = statusFile();
    const requestLauncher = vi.fn(async () => undefined);
    await start({
      hostSelfUpdate: {
        launch: {
          mode: "dev",
          restartCommand: "npm run dev",
          endpoint: "\\\\.\\pipe\\launcher",
          token: "secret",
        },
        statusFile: file,
        localNodeId: () => undefined,
        uncommittedChanges: async () => undefined,
        requestLauncher,
        pollMs: 60_000,
      },
    });

    const started = await inject({
      method: "POST",
      url: "/api/host/update",
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      started: true,
      status: {
        launch: "dev",
        restartCommand: "npm run dev",
        update: { stage: "checking" },
      },
    });
    expect(requestLauncher).toHaveBeenCalledWith(
      "\\\\.\\pipe\\launcher",
      expect.objectContaining({ token: "secret", statusFile: file }),
    );
    expect(readUpdateRecord(file)).toMatchObject({ stage: "checking" });
    expect(
      (await inject({ method: "GET", url: "/api/snapshot" })).json().hostUpdate,
    ).toMatchObject({ launch: "dev", update: { stage: "checking" } });

    const again = await inject({ method: "POST", url: "/api/host/update", payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "A Host update is already running" });
  });

  it("keeps the Node beside the Host from updating on its own at the same time", async () => {
    /** Filled in once the Node has enrolled; the Host asks for it later. */
    const local: { nodeId?: string } = {};
    await start({
      hostSelfUpdate: {
        launch: {
          mode: "start",
          restartCommand: "npm start",
          endpoint: "\\\\.\\pipe\\launcher",
          token: "secret",
        },
        statusFile: statusFile(),
        localNodeId: () => local.nodeId,
        uncommittedChanges: async () => undefined,
        requestLauncher: async () => undefined,
        pollMs: 60_000,
      },
    });
    const registered = await inject({
      method: "POST",
      url: "/api/nodes/register",
      payload: {
        name: "workstation",
        os: "win32",
        arch: "x64",
        version: "0.8.0",
        capabilities: ["copilot-acp", SELF_UPDATE_CAPABILITY],
        maxSessions: 1,
        enrollmentToken: "test-token",
      },
    });
    local.nodeId = (registered.json() as { nodeId: string }).nodeId;

    expect(
      (await inject({ method: "POST", url: "/api/host/update", payload: {} })).statusCode,
    ).toBe(200);
    const nodeUpdate = await inject({
      method: "POST",
      url: `/api/nodes/${local.nodeId}/update`,
      payload: {},
    });
    expect(nodeUpdate.statusCode).toBe(409);
    expect(nodeUpdate.json().error).toContain("The Host is updating");
  });
});
