import type http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { createServer as createPortProbe } from "node:net";
import { buildServer } from "../apps/host/src/server.js";
import { openNodeChannel } from "../apps/node/src/enrollment.js";
import Fastify from "fastify";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  NodeEnrollmentChallengeSchema,
  HostChallengeSchema,
  EnrollNodeSchema,
  MUTUAL_AUTH_PROTOCOL,
} from "../packages/protocol/src/index.js";
import {
  CorpDirectAccess,
  CORP_DIRECT_CONFIG_SETTING,
  privateHostAddresses,
} from "../apps/host/src/corp-direct.js";
import { FleetStore } from "../apps/host/src/store.js";
import { HostIdentityService } from "../apps/host/src/auth/host-identity.js";
import { EnrollmentGrants } from "../apps/host/src/auth/enrollment-grants.js";
import { NodeEnrollment } from "../apps/host/src/auth/node-enrollment.js";
import { startCorpDirectForward } from "../apps/node/src/corp-direct.js";
import { enrollWithGrant } from "../apps/node/src/enrollment.js";

const requestTls = (url: string, ca?: string, headers?: http.OutgoingHttpHeaders) =>
  new Promise<number>((resolve, reject) => {
    const request = https.get(
      url,
      { ca, headers, agent: false, timeout: 5000 },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("TLS integration timed out")));
  });

const hostIp = privateHostAddresses()[0];
describe.skipIf(process.platform !== "win32" || !hostIp)(
  "real Windows private HTTPS/WSS route",
  () => {
    it("coexists with loopback on the same port, enrolls with a real grant, carries MCP and survives helper recreation", async () => {
      const store = new FleetStore(":memory:");
      const identity = new HostIdentityService(store);
      const owner = store.insertAdministrator({
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        objectId: "integration-corp-admin",
        username: "integration@microsoft.com",
        displayName: "Synthetic integration administrator",
        addedVia: "claim",
      });
      const grants = new EnrollmentGrants({ store });
      const enrollment = new NodeEnrollment({ store, identity, grants, audit: () => {} });
      const app = Fastify();
      app.post("/api/nodes/enrollment/challenge", (request, reply) => {
        const outcome = enrollment.challenge(
          NodeEnrollmentChallengeSchema.parse(request.body),
        );
        return outcome.ok
          ? outcome.response
          : reply.code(outcome.status).send({ error: outcome.error });
      });
      app.post("/api/nodes/register", (request, reply) => {
        const outcome = enrollment.complete(EnrollNodeSchema.parse(request.body));
        return outcome.ok
          ? reply.code(201).send(outcome.receipt)
          : reply.code(outcome.status).send({ error: outcome.error });
      });
      app.post("/mcp", (request, reply) => {
        if (request.headers.authorization !== "Bearer synthetic-integration-token")
          return reply.code(401).send({ error: "token missing" });
        return {
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true, host: request.headers.host, body: request.body },
        };
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("No integration backend address");
      const sockets = new WebSocketServer({ server: app.server, path: "/ws/test" });
      sockets.on("connection", (socket) =>
        socket.on("message", (data) => socket.send(data)),
      );
      let allowed = true;
      const direct = new CorpDirectAccess({
        store,
        upstream: `http://127.0.0.1:${address.port}`,
        hostId: () => identity.identity().hostId,
        canRun: () => allowed,
      });
      direct.configure({
        hostIp: hostIp!,
        port: address.port,
      });
      // A previous per-worker restriction must not survive invisibly on upgrade.
      store.setSetting(
        CORP_DIRECT_CONFIG_SETTING,
        JSON.stringify({
          hostIp,
          port: address.port,
          allowedSources: [
            hostIp === "10.255.255.254" ? "192.168.255.254" : "10.255.255.254",
          ],
        }),
      );
      let forward: Awaited<ReturnType<typeof startCorpDirectForward>> | undefined;
      try {
        const remote = await direct.start();
        expect(new URL(remote).port).toBe(String(address.port));
        expect(direct.info().configuration).toEqual({ hostIp, port: address.port });
        expect(direct.info().firewallCommand).toContain("-RemoteAddress Any");
        const caCertificate = direct.info().caCertificate!;
        await expect(requestTls(`${remote}/mcp`)).rejects.toThrow();
        expect(
          await requestTls(`${remote}/mcp`, caCertificate, {
            Host: `127.0.0.1:${address.port}`,
          }),
        ).toBe(403);
        expect(
          await requestTls(`${remote}/mcp`, caCertificate, {
            Origin: "https://attacker.invalid",
          }),
        ).toBe(403);
        forward = await startCorpDirectForward({ hostUrl: remote, caCertificate });
        const grant = grants.create(owner.id);
        const result = await enrollWithGrant({
          hostUrl: forward.url,
          hostId: identity.identity().hostId,
          hostFingerprint: identity.identity().fingerprint,
          grant: grant.grant,
          registration: {
            name: "corp-direct-synthetic-node",
            os: "windows",
            arch: "x64",
            version: "0.9.0",
            revision: "test",
            capabilities: [],
            agents: [],
            maxSessions: 1,
            homeDir: "C:\\synthetic",
          },
        });
        expect(result.credentials.authProtocol).toBe(MUTUAL_AUTH_PROTOCOL);
        expect(store.getNode(result.credentials.nodeId)?.name).toBe(
          "corp-direct-synthetic-node",
        );
        const mcp = await fetch(`${forward.url}/mcp`, {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-integration-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(mcp.status).toBe(200);
        expect((await mcp.json()).result.host).toBe(`${hostIp}:${address.port}`);
        const socket = new WebSocket(`${forward.url.replace("http:", "ws:")}/ws/test`);
        try {
          await once(socket, "open");
          const received = once(socket, "message");
          socket.send("synthetic control message");
          expect((await received)[0].toString()).toBe("synthetic control message");
          const closed = once(socket, "close");
          socket.close(1000, "done");
          expect((await closed)[0]).toBe(1000);
        } finally {
          socket.terminate();
        }
        await forward.stop();
        forward = await startCorpDirectForward({ hostUrl: remote, caCertificate });
        expect(await requestTls(`${remote}/mcp`, caCertificate)).toBe(404);
        allowed = false;
        expect(direct.activeUrl()).toBeUndefined();
        await expect(requestTls(`${remote}/mcp`, caCertificate)).rejects.toThrow();
      } finally {
        await forward?.stop();
        await direct.stop();
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await app.close();
        store.close();
      }
    }, 120000);

    it("uses the real corporate setup API, scoped Host guard and authenticated Node control channel", async () => {
      const previousPort = process.env.PORT;
      const previousHost = process.env.HOST;
      const probe = createPortProbe();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const free = probe.address();
      if (!free || typeof free === "string") throw new Error("No isolated test port");
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      process.env.PORT = String(free.port);
      process.env.HOST = "127.0.0.1";
      let claimCode = "";
      const app = await buildServer({
        databasePath: ":memory:",
        operatorPassword: "",
        announceClaimCode: (code) => {
          claimCode = code;
        },
        entraProvider: () => ({
          authorizationUrl: async ({ state }) =>
            `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`,
          redeemAuthorizationCode: async () => ({
            tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
            objectId: "synthetic-full-corp-owner",
            username: "synthetic@microsoft.com",
            displayName: "Synthetic",
          }),
          startDeviceCode: async () => {
            throw new Error("Unused");
          },
          pollDeviceCode: async () => {
            throw new Error("Unused");
          },
          cancelDeviceCode: () => {},
        }),
      });
      app.log.level = "silent";
      const cookies = new Map<string, string>();
      const request = async (
        method: "GET" | "POST",
        url: string,
        payload?: object,
        csrf?: string,
      ) => {
        const response = await app.inject({
          method,
          url,
          ...(payload ? { payload } : {}),
          headers: {
            host: `localhost:${free.port}`,
            cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
            ...(csrf ? { "x-csrf-token": csrf } : {}),
          },
        });
        const raw = response.headers["set-cookie"];
        for (const cookie of Array.isArray(raw) ? raw : raw ? [raw] : []) {
          const [name, ...value] = cookie.split(";")[0]!.split("=");
          if (name) cookies.set(name, value.join("="));
        }
        return response;
      };
      let forward: Awaited<ReturnType<typeof startCorpDirectForward>> | undefined;
      let socket: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: free.port });
        expect(
          (await request("POST", "/api/auth/bootstrap", { code: claimCode })).statusCode,
        ).toBe(200);
        expect(
          (
            await request("POST", "/api/auth/configure", {
              tenantId: "common",
              clientId: "11111111-2222-3333-4444-555555555555",
            })
          ).statusCode,
        ).toBe(200);
        const started = (await request("POST", "/api/auth/code/start", {})).json();
        const state = new URL(started.authorizationUrl).searchParams.get("state");
        expect(
          (await request("GET", `/api/auth/entra/callback?code=synthetic&state=${state}`))
            .statusCode,
        ).toBe(302);
        const csrf = (await request("GET", "/api/auth/csrf")).json().csrfToken;
        const setup = await request(
          "POST",
          "/api/tunnel",
          {
            provider: "corp-direct",
            enabled: true,
            corpDirect: { hostIp, port: free.port },
          },
          csrf,
        );
        expect(setup.statusCode).toBe(200);
        expect(setup.json().primary).toBe("corp-direct");
        expect(setup.json().corpDirect.configuration).toEqual({
          hostIp,
          port: free.port,
        });
        expect(setup.json().corpDirect.firewallCommand).toContain("-RemoteAddress Any");
        expect(JSON.stringify(setup.json())).not.toContain("authorityPfx");
        const issued = await request("POST", "/api/enrollment-grants", {}, csrf);
        expect(issued.statusCode).toBe(201);
        const command = issued.json().command;
        expect(command.corpDirectCa).toContain("BEGIN CERTIFICATE");
        expect(command.tunnelId).toBeUndefined();
        forward = await startCorpDirectForward({
          hostUrl: command.hostUrl,
          caCertificate: command.corpDirectCa,
        });
        // Network reachability and the public CA do not grant operator access.
        expect((await fetch(`${forward.url}/api/nodes`)).status).toBe(401);
        const enrolled = await enrollWithGrant({
          hostUrl: forward.url,
          hostId: command.hostId,
          hostFingerprint: command.hostFingerprint,
          grant: command.enrollmentGrant,
          registration: {
            name: "full-corp-direct-node",
            os: "windows",
            arch: "x64",
            version: "0.9.0",
            revision: "test",
            capabilities: [],
            agents: [],
            maxSessions: 1,
            homeDir: "C:\\synthetic",
          },
        });
        if (enrolled.credentials.authProtocol !== MUTUAL_AUTH_PROTOCOL)
          throw new Error("Expected key enrollment");
        const channel = openNodeChannel({
          credentials: enrolled.credentials,
          dialedHostUrl: forward.url,
        });
        socket = new WebSocket(`${forward.url.replace("http:", "ws:")}/ws/node`);
        await once(socket, "open");
        const challenged = once(socket, "message");
        socket.send(JSON.stringify(channel.clientHello));
        const accepted = channel.accept(
          HostChallengeSchema.parse(JSON.parse((await challenged)[0].toString())),
        );
        if (!accepted.ok) throw new Error(`Host proof refused: ${accepted.reason}`);
        const welcomed = once(socket, "message");
        socket.send(JSON.stringify(accepted.proof));
        socket.send(
          JSON.stringify(
            accepted.channel.seal(
              JSON.stringify({
                type: "ready",
                os: "windows",
                arch: "x64",
                version: "0.9.0",
                revision: "test",
                capabilities: [],
                maxSessions: 1,
                homeDir: "C:\\synthetic",
                name: "full-corp-direct-node",
                activeSessionIds: [],
              }),
            ),
          ),
        );
        const opened = accepted.channel.open(JSON.parse((await welcomed)[0].toString()));
        if (!opened.ok) throw new Error(`Welcome decryption refused: ${opened.reason}`);
        expect(JSON.parse(opened.plaintext)).toMatchObject({
          type: "welcome",
          nodeId: enrolled.credentials.nodeId,
        });
        const nodes = (await request("GET", "/api/nodes")).json();
        expect(nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: enrolled.credentials.nodeId, online: true }),
          ]),
        );
        const closed = once(socket, "close");
        socket.close(1000, "test complete");
        await closed;
        expect(
          (
            await request(
              "POST",
              "/api/tunnel",
              { provider: "corp-direct", enabled: false },
              csrf,
            )
          ).statusCode,
        ).toBe(200);
        expect((await request("GET", "/api/health")).statusCode).toBe(200);
      } finally {
        socket?.terminate();
        await forward?.stop();
        await app.close();
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
        if (previousHost === undefined) delete process.env.HOST;
        else process.env.HOST = previousHost;
      }
    }, 120000);
  },
);
