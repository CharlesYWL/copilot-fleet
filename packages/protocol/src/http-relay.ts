import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

export type HttpRelayOptions = {
  upstream: string;
  caCertificate?: string;
  tls?: { pfx: Buffer; passphrase?: string };
  rewriteHost?: boolean;
  allowPeer?: (address: string) => boolean;
  allowRequest?: (request: IncomingMessage) => boolean;
};

/** Hop-by-hop claims belong to this connection, never to the next one. */
const relayHeaders = (
  headers: IncomingHttpHeaders,
  upgrade = false,
): IncomingHttpHeaders => {
  const blocked = new Set([
    "connection",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  ]);
  const result = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !blocked.has(name) && !name.startsWith("x-forwarded-"),
    ),
  );
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
};

const writeSocketResponse = (
  socket: Duplex,
  status: number,
  headers: IncomingHttpHeaders = {},
) => {
  const lines = Object.entries(headers).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values])
      .filter((value) => value !== undefined)
      .map((value) => `${name}: ${value}`),
  );
  socket.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Response"}\r\n${lines.join("\r\n")}\r\n\r\n`,
  );
};

/**
 * A fixed upstream, used by the Host's TLS edge and the Node's loopback helper.
 * No certificate overrides, redirect following, proxy discovery or variable upstream.
 */
export const createHttpRelay = (options: HttpRelayOptions) => {
  const upstream = new URL(options.upstream);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error(
      "The relay upstream must be an HTTP(S) origin without credentials or a path",
    );
  }
  if (options.caCertificate && upstream.protocol !== "https:") {
    throw new Error("Explicit certificate trust requires an HTTPS upstream");
  }
  const transport = upstream.protocol === "https:" ? https : http;
  const sockets = new Set<Duplex>();
  const requests = new Set<http.ClientRequest>();
  const trackSocket = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {
      socket.destroy();
    });
  };
  const permitted = (request: IncomingMessage): boolean =>
    options.allowRequest?.(request) !== false;
  const validPath = (request: IncomingMessage): boolean =>
    Boolean(
      request.url?.startsWith("/") &&
      !request.url.startsWith("//") &&
      !/[\r\n]/.test(request.url),
    );

  const forward = (request: IncomingMessage, upgrade: boolean): http.ClientRequest => {
    const headers = relayHeaders(request.headers, upgrade);
    if (options.rewriteHost) headers.host = upstream.host;
    const outgoing = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      method: request.method,
      path: request.url,
      headers,
      agent: false,
      ...(upstream.protocol === "https:"
        ? {
            rejectUnauthorized: true,
            minVersion: "TLSv1.2" as const,
            ...(options.caCertificate ? { ca: options.caCertificate } : {}),
          }
        : {}),
    });
    requests.add(outgoing);
    outgoing.once("close", () => requests.delete(outgoing));
    // Bound connection/TLS establishment. Once connected, preserve the caller's
    // own lifetime for long-polling MCP tools and streamed responses.
    const deadline = setTimeout(
      () => outgoing.destroy(new Error("Upstream connection timed out")),
      15_000,
    );
    outgoing.once("close", () => clearTimeout(deadline));
    outgoing.once("socket", (socket) => {
      trackSocket(socket);
      if (upstream.protocol === "https:")
        socket.once("secureConnect", () => clearTimeout(deadline));
      else if (!socket.connecting) clearTimeout(deadline);
      else socket.once("connect", () => clearTimeout(deadline));
    });
    return outgoing;
  };

  const responseHeaders = (
    request: IncomingMessage,
    incoming: IncomingMessage,
  ): IncomingHttpHeaders | undefined => {
    const headers = relayHeaders(incoming.headers);
    if (!options.rewriteHost || !incoming.headers.location) return headers;
    try {
      const redirected = new URL(
        incoming.headers.location,
        new URL(request.url ?? "/", upstream),
      );
      if (
        redirected.origin !== upstream.origin ||
        redirected.username ||
        redirected.password ||
        !request.headers.host
      )
        return undefined;
      // Node callers have already checked the incoming Host/Origin. Rebase even
      // absolute same-origin redirects so a client cannot bypass this TLS hop.
      headers.location = `${options.tls ? "https" : "http"}://${request.headers.host}${redirected.pathname}${redirected.search}${redirected.hash}`;
      return headers;
    } catch {
      return undefined;
    }
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    if (!validPath(request)) {
      response.writeHead(400).end("Invalid request path");
      return;
    }
    if (!permitted(request)) {
      response.writeHead(403).end("Request refused");
      return;
    }
    const outgoing = forward(request, false);
    outgoing.on("response", (incoming) => {
      const headers = responseHeaders(request, incoming);
      if (!headers) {
        incoming.resume();
        response
          .writeHead(502, { "cache-control": "no-store" })
          .end("Upstream redirect refused");
        return;
      }
      response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    outgoing.on("error", () => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response
        .writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("Upstream connection failed");
    });
    request.once("aborted", () => outgoing.destroy());
    request.on("error", () => outgoing.destroy());
    response.once("close", () => {
      if (!response.writableEnded) outgoing.destroy();
    });
    request.pipe(outgoing);
  };

  const server = options.tls
    ? https.createServer({ minVersion: "TLSv1.2", ...options.tls }, handleRequest)
    : http.createServer(handleRequest);
  server.headersTimeout = 30_000;
  server.on("connection", (socket) => {
    trackSocket(socket);
    if (options.allowPeer && !options.allowPeer(socket.remoteAddress ?? ""))
      socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (request, downstream, head) => {
    if (
      !validPath(request) ||
      !permitted(request) ||
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      writeSocketResponse(downstream, 403, {
        connection: "close",
        "content-length": "0",
      });
      downstream.end();
      return;
    }
    const outgoing = forward(request, true);
    let upgraded = false;
    downstream.once("close", () => outgoing.destroy());
    outgoing.on("upgrade", (incoming, remote, remoteHead) => {
      if (downstream.destroyed) {
        remote.destroy();
        return;
      }
      upgraded = true;
      trackSocket(remote);
      writeSocketResponse(
        downstream,
        incoming.statusCode ?? 101,
        relayHeaders(incoming.headers, true),
      );
      if (remoteHead.length) downstream.write(remoteHead);
      if (head.length) remote.write(head);
      downstream.once("close", () => remote.destroy());
      remote.once("close", () => downstream.destroy());
      remote.pipe(downstream);
      downstream.pipe(remote);
    });
    outgoing.on("response", (incoming) => {
      if (downstream.destroyed) {
        incoming.destroy();
        return;
      }
      const headers = responseHeaders(request, incoming);
      if (!headers) {
        incoming.resume();
        writeSocketResponse(downstream, 502, {
          connection: "close",
          "content-length": "0",
        });
        downstream.end();
        return;
      }
      writeSocketResponse(downstream, incoming.statusCode ?? 502, {
        ...headers,
        connection: "close",
      });
      incoming.on("error", () => downstream.destroy());
      incoming.pipe(downstream);
    });
    outgoing.on("error", () => {
      if (downstream.destroyed) return;
      if (upgraded) {
        downstream.destroy();
        return;
      }
      writeSocketResponse(downstream, 502, {
        connection: "close",
        "content-length": "0",
      });
      downstream.end();
    });
    outgoing.end();
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    for (const outgoing of requests) outgoing.destroy();
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return Promise.resolve();
    closing = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return closing;
  };
  return { server, close };
};
