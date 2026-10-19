import Fastify, { type FastifyBaseLogger } from "fastify";
import websocket from "@fastify/websocket";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetStore } from "../store.js";
import { FleetService } from "../fleet-service.js";
import { HostIdentityService } from "../auth/host-identity.js";
import { registerNodeGateway } from "./node-socket.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = async () => {
  const store = new FleetStore(":memory:");
  store.setMutualNodeAuthenticationRequired(false);
  const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
  const service = new FleetService(store, log);
  const identity = new HostIdentityService(store);
  const inventory = {
    name: "route-node",
    os: "win32",
    arch: "x64",
    version: "0.9.0",
    capabilities: [],
    maxSessions: 1,
  };
  const { node, secret } = store.registerNode(inventory);
  const app = Fastify();
  await app.register(websocket);
  registerNodeGateway(app, service, {
    identity,
    endpoints: () => [
      { provider: "corp-direct", url: "https://10.0.5.136:8787" },
      { provider: "cloudflare", url: "https://fleet.trycloudflare.com" },
      { provider: "ngrok", url: "https://fleet.ngrok.app" },
    ],
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const sockets: WebSocket[] = [];
  cleanup.push(async () => {
    service.evictAllNodes(1001, "Test shutdown");
    for (const socket of sockets) socket.terminate();
    await app.close();
    store.close();
  });
  const connect = async (
    connection?: object,
    host = `127.0.0.1:${address.port}`,
    suppliedSecret = secret,
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node`, {
      headers: { host },
    });
    sockets.push(socket);
    await once(socket, "open");
    const result =
      suppliedSecret === secret ? once(socket, "message") : once(socket, "close");
    socket.send(
      JSON.stringify({
        type: "hello",
        nodeId: node.id,
        secret: suppliedSecret,
        ...inventory,
        ...(connection ? { connection } : {}),
      }),
    );
    await result;
    return socket;
  };
  return { service, store, node, connect };
};

describe("authenticated connection route telemetry", () => {
  it("reports a chosen public provider from the actual dial origin", async () => {
    const f = await fixture();
    await f.connect({ provider: "direct", hostUrl: "https://fleet.ngrok.app" });
    expect(f.service.snapshot().nodes[0]?.connection).toEqual({
      provider: "ngrok",
      hostUrl: "https://fleet.ngrok.app",
    });
  });

  it("reports Dev Tunnels rather than an ephemeral loopback endpoint", async () => {
    const f = await fixture();
    await f.connect({ provider: "devtunnel" });
    expect(f.service.snapshot().nodes[0]?.connection).toEqual({ provider: "devtunnel" });
  });

  it("infers an older private Node only from a known ingress Host", async () => {
    const f = await fixture();
    await f.connect(undefined, "10.0.5.136:8787");
    expect(f.service.snapshot().nodes[0]?.connection).toEqual({
      provider: "corp-direct",
      hostUrl: "https://10.0.5.136:8787",
    });
  });

  it("leaves an older loopback route unknown rather than guessing Dev Tunnels", async () => {
    const f = await fixture();
    await f.connect();
    expect(f.service.snapshot().nodes[0]?.connection).toBeUndefined();
  });

  it("never attaches route metadata from a failed authentication", async () => {
    const f = await fixture();
    await f.connect({ provider: "devtunnel" }, undefined, "wrong-secret");
    expect(f.service.snapshot().nodes[0]?.connection).toBeUndefined();
  });

  it("clears a previous route when an older reconnect cannot identify its transport", async () => {
    const f = await fixture();
    await f.connect({ provider: "devtunnel" });
    expect(f.service.snapshot().nodes[0]?.connection?.provider).toBe("devtunnel");
    await f.connect();
    expect(f.service.snapshot().nodes[0]?.connection).toBeUndefined();
  });

  it("retains last known route offline, refreshes on reconnect, and clears on eviction", async () => {
    const f = await fixture();
    const socket = await f.connect({
      provider: "corp-direct",
      hostUrl: "https://10.0.5.136:8787",
    });
    socket.close();
    await vi.waitFor(() => expect(f.service.snapshot().nodes[0]?.online).toBe(false));
    expect(f.service.snapshot().nodes[0]?.connection?.provider).toBe("corp-direct");
    await f.connect({ provider: "devtunnel" });
    expect(f.service.snapshot().nodes[0]?.connection).toEqual({ provider: "devtunnel" });
    f.service.evictAllNodes(4002, "Test identity replacement");
    expect(f.service.snapshot().nodes[0]?.connection).toBeUndefined();
  });
});
