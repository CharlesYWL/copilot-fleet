import { once } from "node:events";
import http, { type Server } from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createHttpRelay } from "./http-relay.js";
import {
  TEST_TLS_CERTIFICATE,
  TEST_TLS_PASSPHRASE,
  TEST_TLS_PFX,
} from "./test-tls-fixture.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});
const listen = async (
  server: Server | https.Server,
  host = "127.0.0.1",
  port = 0,
): Promise<number> => {
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return address.port;
};
const backend = async (tls = false) => {
  const handle: http.RequestListener = (request, response) => {
    if (request.url === "/redirect-out") {
      response.writeHead(302, { location: "https://attacker.invalid/collect" }).end();
      return;
    }
    if (request.url === "/nested/redirect-relative") {
      response.writeHead(307, { location: "next?relative=1" }).end();
      return;
    }
    if (request.url === "/redirect-same") {
      response
        .writeHead(307, {
          location: `${tls ? "https" : "http"}://${request.headers.host}/mcp`,
        })
        .end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          path: request.url,
          host: request.headers.host,
          authorization: request.headers.authorization,
          forwarded: request.headers["x-forwarded-proto"],
          body,
        }),
      );
    });
  };
  const server = tls
    ? https.createServer(
        { pfx: Buffer.from(TEST_TLS_PFX, "base64"), passphrase: TEST_TLS_PASSPHRASE },
        handle,
      )
    : http.createServer(handle);
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  const port = await listen(server);
  closing.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { server, port, url: `${tls ? "https" : "http"}://127.0.0.1:${port}` };
};
const relay = async (options: Parameters<typeof createHttpRelay>[0]) => {
  const result = createHttpRelay(options);
  const port = await listen(result.server);
  closing.push(result.close);
  return {
    ...result,
    port,
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
  };
};
const textRequest = (url: string, options: https.RequestOptions = {}, body = "") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = (url.startsWith("https:") ? https : http).request(
      url,
      { agent: false, timeout: 3000, ...options },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: text }));
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Test timed out")));
    request.end(body);
  });

describe("fixed-upstream HTTP and secure WebSocket relay", () => {
  it("streams HTTP bodies, preserves authorization, rewrites Host only when requested and strips forwarding claims", async () => {
    const upstream = await backend();
    const forwarding = await relay({ upstream: upstream.url, rewriteHost: true });
    const response = await textRequest(
      `${forwarding.url}/mcp?x=1`,
      {
        method: "POST",
        headers: {
          host: "untrusted.example",
          authorization: "Bearer synthetic-test",
          "x-forwarded-proto": "https",
        },
      },
      "probe payload",
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      path: "/mcp?x=1",
      host: new URL(upstream.url).host,
      authorization: "Bearer synthetic-test",
      body: "probe payload",
    });
    const preserving = await relay({ upstream: upstream.url });
    expect(
      JSON.parse(
        (
          await textRequest(preserving.url, {
            headers: { host: "published.private:8787" },
          })
        ).body,
      ).host,
    ).toBe("published.private:8787");
  });

  it("rejects absolute-form requests instead of choosing another upstream", async () => {
    const upstream = await backend();
    const forwarding = await relay({ upstream: upstream.url });
    expect(
      (await textRequest(forwarding.url, { path: "http://attacker.invalid/mcp" })).status,
    ).toBe(400);
  });

  it("keeps Node redirects inside the verified helper while preserving Host browser sign-in redirects", async () => {
    const upstream = await backend();
    const nodeForward = await relay({ upstream: upstream.url, rewriteHost: true });
    expect((await textRequest(`${nodeForward.url}/redirect-out`)).status).toBe(502);
    const followed = await fetch(`${nodeForward.url}/redirect-same`);
    expect(followed.status).toBe(200);
    expect(new URL(followed.url).origin).toBe(nodeForward.url);
    const relative = await fetch(`${nodeForward.url}/nested/redirect-relative`);
    expect(new URL(relative.url).origin).toBe(nodeForward.url);
    expect((await relative.json()).path).toBe("/nested/next?relative=1");
    const hostEdge = await relay({ upstream: upstream.url });
    expect((await textRequest(`${hostEdge.url}/redirect-out`)).status).toBe(302);
  });

  it("does not impose a short response deadline on an established long-polling MCP call", async () => {
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const server = http.createServer((_request, response) => {
      release = () => response.end("late tool response");
      ready();
    });
    const port = await listen(server);
    closing.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const forwarding = await relay({ upstream: `http://127.0.0.1:${port}` });
    vi.useFakeTimers();
    try {
      const response = textRequest(forwarding.url, { timeout: 0 });
      await reached;
      await vi.advanceTimersByTimeAsync(181000);
      release();
      expect(await response).toEqual({ status: 200, body: "late tool response" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies request and peer restrictions", async () => {
    const upstream = await backend();
    const denied = await relay({ upstream: upstream.url, allowRequest: () => false });
    expect((await textRequest(denied.url)).status).toBe(403);
    const noPeer = await relay({ upstream: upstream.url, allowPeer: () => false });
    await expect(textRequest(noPeer.url)).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("uses explicit TLS trust upstream and refuses an untrusted certificate", async () => {
    const upstream = await backend(true);
    const trusted = await relay({
      upstream: upstream.url,
      caCertificate: TEST_TLS_CERTIFICATE,
    });
    expect((await textRequest(trusted.url)).status).toBe(200);
    const untrusted = await relay({ upstream: upstream.url });
    expect((await textRequest(untrusted.url)).status).toBe(502);
  });

  it("terminates TLS with ordinary certificate-name verification", async () => {
    const upstream = await backend();
    const edge = await relay({
      upstream: upstream.url,
      tls: { pfx: Buffer.from(TEST_TLS_PFX, "base64"), passphrase: TEST_TLS_PASSPHRASE },
    });
    expect((await textRequest(edge.url, { ca: TEST_TLS_CERTIFICATE })).status).toBe(200);
    await expect(
      textRequest(edge.url, { ca: TEST_TLS_CERTIFICATE, servername: "wrong.example" }),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("relays WebSocket messages, ping/pong and normal close over validated TLS", async () => {
    const upstream = await backend(true);
    const forwarding = await relay({
      upstream: upstream.url,
      caCertificate: TEST_TLS_CERTIFICATE,
      rewriteHost: true,
    });
    const socket = new WebSocket(forwarding.url.replace("http:", "ws:"));
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      socket.send("synthetic MCP/control message");
      expect((await message)[0].toString()).toBe("synthetic MCP/control message");
      const pong = once(socket, "pong");
      socket.ping("heartbeat");
      expect((await pong)[0].toString()).toBe("heartbeat");
      const closed = once(socket, "close");
      socket.close(1000, "done");
      expect((await closed)[0]).toBe(1000);
    } finally {
      socket.terminate();
    }
  });

  // macOS configures only 127.0.0.1 on lo0; other 127/8 addresses need an alias
  // (`ifconfig lo0 alias 127.0.0.2`), so the second listener has nowhere to bind.
  it.skipIf(process.platform === "darwin")(
    "allows explicitly different loopback addresses to bind the same port",
    async () => {
      const first = await backend();
      const second = createHttpRelay({ upstream: first.url });
      closing.push(second.close);
      await listen(second.server, "127.0.0.2", first.port);
      expect((await textRequest(`http://127.0.0.2:${first.port}/health`)).status).toBe(
        200,
      );
    },
  );
});
