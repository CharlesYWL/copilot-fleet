import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostBackup, HostPortableBackup, TunnelInfo } from "@fleet/protocol";
import { buildServer } from "../server.js";
import { BinaryProbe } from "../tunnel.js";
import { providerSpecs } from "../tunnel-providers.js";
import { readExternalTunnel } from "../external-tunnel.js";
import type * as externalTunnel from "../external-tunnel.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));
vi.mock("../external-tunnel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof externalTunnel>()),
  readExternalTunnel: vi.fn(),
}));

const PASSPHRASE = "correct horse battery staple";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
type Host = { app: FastifyInstance; claimCode: string; cookies: Map<string, string> };
const hosts: Host[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  vi.mocked(readExternalTunnel).mockReturnValue(undefined);
  vi.spyOn(BinaryProbe.prototype, "present").mockResolvedValue(true);
  vi.spyOn(providerSpecs.devtunnel, "prepare");
  vi.mocked(providerSpecs.devtunnel.prepare!).mockResolvedValue(undefined);
  vi.spyOn(providerSpecs.devtunnel, "newTunnelId");
  let sequence = 0;
  vi.mocked(providerSpecs.devtunnel.newTunnelId!).mockImplementation(
    () => `fleet-machine${++sequence}`,
  );
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const id = Array.isArray(args) && typeof args[1] === "string" ? args[1] : "";
    const qualified = id.includes(".") ? id : `${id}.usw2`;
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    queueMicrotask(() =>
      child.stdout?.emit(
        "data",
        Buffer.from(
          `Connect via browser: https://demo-8787.usw2.devtunnels.ms\nReady to accept connections for tunnel: ${qualified}\n`,
        ),
      ),
    );
    children.push(child);
    return child;
  });
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.app.close();
  children.length = 0;
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.mocked(readExternalTunnel).mockReset();
});

async function openHost(): Promise<Host> {
  let claimCode = "";
  const app = await buildServer({
    databasePath: ":memory:",
    enrollmentToken: "test-token",
    operatorPassword: "",
    announceClaimCode: (code) => {
      claimCode = code;
    },
    entraProvider: () => ({
      authorizationUrl: async ({ state }) => `https://login.example/?state=${state}`,
      redeemAuthorizationCode: async () => ({
        tenantId: TENANT,
        objectId: "test-owner",
        username: "owner@example.com",
        displayName: "Owner",
      }),
      startDeviceCode: async () => {
        throw new Error("unused device flow");
      },
      pollDeviceCode: async () => {
        throw new Error("unused device flow");
      },
      cancelDeviceCode: () => {},
    }),
  });
  app.log.level = "silent";
  await app.ready();
  const host = { app, claimCode, cookies: new Map<string, string>() };
  hosts.push(host);
  return host;
}

const cookie = (host: Host) =>
  [...host.cookies].map(([name, value]) => `${name}=${value}`).join("; ");

function remember(host: Host, response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  for (const value of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [name, ...parts] = String(value).split(";")[0]!.split("=");
    if (name) host.cookies.set(name, parts.join("="));
  }
}

const get = (host: Host, url: string) =>
  host.app.inject({ method: "GET", url, headers: { cookie: cookie(host) } });

async function post(
  host: Host,
  url: string,
  payload: Record<string, unknown>,
  operator = true,
) {
  const csrf = operator
    ? (await get(host, "/api/auth/csrf")).json<{ csrfToken: string }>().csrfToken
    : undefined;
  const response = await host.app.inject({
    method: "POST",
    url,
    payload,
    headers: {
      cookie: cookie(host),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
  });
  remember(host, response);
  return response;
}

async function signIn(host: Host) {
  const started = await post(host, "/api/auth/code/start", {}, false);
  const state = new URL(
    started.json<{ authorizationUrl: string }>().authorizationUrl,
  ).searchParams.get("state");
  const signedIn = await host.app.inject({
    method: "GET",
    url: `/api/auth/entra/callback?code=test&state=${state}`,
    headers: { cookie: cookie(host) },
  });
  expect(signedIn.statusCode).toBe(302);
  remember(host, signedIn);
}

async function claim(host: Host) {
  expect(
    (await post(host, "/api/auth/bootstrap", { code: host.claimCode }, false)).statusCode,
  ).toBe(200);
  expect(
    (
      await post(
        host,
        "/api/auth/configure",
        { tenantId: TENANT, clientId: CLIENT },
        false,
      )
    ).statusCode,
  ).toBe(200);
  await signIn(host);
}

async function exportArchive(host: Host, format: "data" | "portable") {
  const response =
    format === "data"
      ? await get(host, "/api/backup")
      : await post(host, "/api/backup/portable", { passphrase: PASSPHRASE });
  expect(response.statusCode).toBe(200);
  return response.json<HostBackup | HostPortableBackup>();
}

async function restore(host: Host, backup: HostBackup | HostPortableBackup) {
  return backup.version === 1
    ? post(host, "/api/backup", backup)
    : post(host, "/api/backup/portable/import", { passphrase: PASSPHRASE, backup });
}

describe("tunnel migration through the real backup routes", () => {
  it.each(["data", "portable"] as const)(
    "reuses Machine1's tunnel rather than Machine2's running tunnel after a %s restore",
    async (format) => {
      const source = await openHost();
      await claim(source);
      expect(
        (await post(source, "/api/tunnel", { provider: "devtunnel", enabled: true }))
          .statusCode,
      ).toBe(200);
      const identity = (await get(source, "/api/enrollment")).json();
      const backup = await exportArchive(source, format);
      expect(backup.tunnel.ids).toEqual({ devtunnel: "fleet-machine1.usw2" });
      await source.app.close();
      hosts.splice(hosts.indexOf(source), 1);

      const destination = await openHost();
      await claim(destination);
      expect(
        (await post(destination, "/api/tunnel", { provider: "devtunnel", enabled: true }))
          .statusCode,
      ).toBe(200);
      const oldProcess = children[1]!;
      expect((await restore(destination, backup)).statusCode).toBe(200);
      if (format === "portable") await signIn(destination);

      const current = (await get(destination, "/api/tunnel")).json<TunnelInfo>();
      expect(current.tunnelId).toBe("fleet-machine1.usw2");
      expect(oldProcess.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect((await exportArchive(destination, format)).tunnel).toEqual(backup.tunnel);
      expect(spawn).toHaveBeenLastCalledWith(
        "devtunnel",
        ["host", "fleet-machine1.usw2"],
        expect.any(Object),
      );
      if (format === "portable") {
        expect((await get(destination, "/api/enrollment")).json()).toMatchObject({
          hostId: identity.hostId,
          hostFingerprint: identity.hostFingerprint,
        });
      }
    },
  );

  it("starts the archived tunnel when restoring a fresh unclaimed Host", async () => {
    const source = await openHost();
    await claim(source);
    await post(source, "/api/tunnel", { provider: "devtunnel", enabled: true });
    const backup = await exportArchive(source, "portable");
    await source.app.close();
    hosts.splice(hosts.indexOf(source), 1);

    const destination = await openHost();
    await post(
      destination,
      "/api/auth/bootstrap",
      { code: destination.claimCode },
      false,
    );
    const response = await post(
      destination,
      "/api/backup/portable/import",
      { passphrase: PASSPHRASE, backup },
      false,
    );
    expect(response.statusCode).toBe(200);
    await signIn(destination);
    expect((await get(destination, "/api/tunnel")).json<TunnelInfo>().tunnelId).toBe(
      "fleet-machine1.usw2",
    );
    expect((await exportArchive(destination, "portable")).tunnel.ids).toEqual(
      backup.tunnel.ids,
    );
    expect(providerSpecs.devtunnel.newTunnelId).toHaveBeenCalledOnce();
  });

  it.each(["data", "portable"] as const)(
    "exports external IDs but refuses an incompatible external destination before a %s restore",
    async (format) => {
      vi.mocked(readExternalTunnel).mockReturnValue({
        provider: "devtunnel",
        url: "https://demo-8787.usw2.devtunnels.ms",
        tunnelId: "fleet-external.usw2",
      });
      const host = await openHost();
      await claim(host);
      const backup = await exportArchive(host, format);
      expect(backup.tunnel.ids).toEqual({ devtunnel: "fleet-external.usw2" });
      backup.tunnel.ids = { devtunnel: "fleet-other.use" };
      const identity = (await get(host, "/api/enrollment")).json();

      const response = await restore(host, backup);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/Stop the separately managed Dev Tunnels/);
      expect((await get(host, "/api/enrollment")).json()).toEqual(identity);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["data", "portable"] as const)(
    "reports an already-restored %s backup on setup failure and retries the same ID",
    async (format) => {
      const host = await openHost();
      await claim(host);
      await post(host, "/api/tunnel", { provider: "devtunnel", enabled: true });
      const backup = await exportArchive(host, format);
      vi.mocked(providerSpecs.devtunnel.prepare!).mockRejectedValue(
        new Error("Sign in to the account that owns this tunnel"),
      );

      const response = await restore(host, backup);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        restored: true,
        error: expect.stringMatching(
          /was restored.*Sign in.*do not import the backup again/,
        ),
      });
      if (format === "portable") await signIn(host);
      const saved = await exportArchive(host, format);
      expect(saved.tunnel.ids).toEqual(backup.tunnel.ids);
      expect(saved.tunnel.enabled).toBe(false);

      vi.mocked(providerSpecs.devtunnel.prepare!).mockResolvedValue(undefined);
      expect(
        (await post(host, "/api/tunnel", { provider: "devtunnel", enabled: true }))
          .statusCode,
      ).toBe(200);
      expect((await get(host, "/api/tunnel")).json<TunnelInfo>().tunnelId).toBe(
        "fleet-machine1.usw2",
      );
      expect(providerSpecs.devtunnel.newTunnelId).toHaveBeenCalledOnce();
    },
  );
});
