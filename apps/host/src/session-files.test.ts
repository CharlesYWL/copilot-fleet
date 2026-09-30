import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticatedEnvelopeSchema,
  HostToNodeMessageSchema,
  MUTUAL_AUTH_PROTOCOL,
  NodeToHostMessageSchema,
  SESSION_FILES_CAPABILITY,
  SESSION_FILE_CHUNK_BYTES,
  type AgentParams,
  type SessionFileReadRequest,
  type SessionFileReadResult,
} from "@fleet/protocol";
import { AuthenticatedChannel } from "@fleet/protocol/node-auth";
import { SessionFileReader } from "../../node/src/session-files.js";
import { OPERATOR_COOKIE } from "./auth.js";
import { FleetAuth } from "./auth/service.js";
import { HostIdentityService } from "./auth/host-identity.js";
import { FleetService } from "./fleet-service.js";
import { SealedNodeLink } from "./gateway/node-channel.js";
import { registerRequestGuard } from "./request-guard.js";
import { sessionFileRoutes } from "./routes/session-files.js";
import { SessionFileService, attachmentDisposition } from "./session-files.js";
import { FleetStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Answer = (request: SessionFileReadRequest) => Promise<SessionFileReadResult | void>;

/**
 * A Host with one session on one Node, joined by a real sealed channel.
 *
 * The Node end is the production reader, so every download here is checked
 * by the same code that runs on a machine: the Host sends a sealed read, the
 * reader answers it, and the answer comes back sealed.
 */
async function fixture(
  options: {
    capabilities?: string[];
    sealed?: boolean;
    online?: boolean;
    agentParams?: AgentParams;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fleet-session-files-host-"));
  const workspace = join(root, "workspace");
  // The Host's own data sits inside the session's folder, as it does for a
  // session working in a checkout of Fleet itself.
  const dataDirectory = join(workspace, ".fleet-data");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const app = Fastify({ logger: false });
  const store = new FleetStore(join(dataDirectory, "host.db"), { secureFiles: () => {} });
  const hostId = new HostIdentityService(store).identity().hostId;
  const service = new FleetService(store, app.log, "fixture");
  const auth = new FleetAuth({
    store,
    announceClaimCode() {},
    warn() {},
    externalScheme: { publicUrl: () => undefined, tunnels: () => [] },
  });
  const admin = store.insertAdministrator({
    tenantId: "fixture-tenant",
    objectId: "fixture-administrator",
    username: "operator@fixture.invalid",
    displayName: "Fixture administrator",
    addedVia: "claim",
  });
  const issued = auth.sessions.issue({
    administratorId: admin.id,
    authMethod: "microsoft-code",
  });
  const cookie = `${OPERATOR_COOKIE}=${issued.token}`;
  registerRequestGuard(app, { store, auth, allowlist: {} });
  await app.register(sessionFileRoutes, { service });

  const node = store.registerNode({
    name: "files-fixture",
    os: process.platform,
    arch: "x64",
    version: "fixture",
    capabilities: options.capabilities ?? [SESSION_FILES_CAPABILITY],
    maxSessions: 1,
  }).node;
  const project = store.createWorkspace("files-fixture", "");
  const placement = store.createPlacement(project.id, node.id, workspace);
  const session = store.createSession(placement, "Write the report", false, "", {
    ...(options.agentParams ? { agentParams: options.agentParams, runRole: "lead" } : {}),
  });

  const reader = new SessionFileReader();
  let answer: Answer = (request) => reader.read(request);
  const keys = { hostToNode: randomBytes(32), nodeToHost: randomBytes(32) };
  const binding = {
    protocol: MUTUAL_AUTH_PROTOCOL,
    hostId,
    nodeId: node.id,
    connectionId: randomUUID(),
  };
  const hostChannel = new AuthenticatedChannel({ keys, binding, seals: "host-to-node" });
  const nodeChannel = new AuthenticatedChannel({ keys, binding, seals: "node-to-host" });
  const reads: SessionFileReadRequest[] = [];
  const raw = {
    OPEN: 1,
    readyState: 1,
    close() {
      this.readyState = 3;
    },
    send(text: string) {
      const plaintext = options.sealed === false ? text : openOnNode(text);
      const message = HostToNodeMessageSchema.parse(JSON.parse(plaintext));
      if (message.type !== "session_file_read") throw new Error(message.type);
      reads.push(message.request);
      void answer(message.request).then((result) => {
        if (!result || raw.readyState !== raw.OPEN) return;
        const opened = hostChannel.open(
          nodeChannel.seal(JSON.stringify({ type: "session_file_data", result })),
        );
        if (!opened.ok) throw new Error(opened.reason);
        const reply = NodeToHostMessageSchema.parse(JSON.parse(opened.plaintext));
        if (reply.type === "session_file_data")
          service.files.handleResult(node.id, reply.result);
      });
    },
  };
  const openOnNode = (text: string) => {
    const opened = nodeChannel.open(AuthenticatedEnvelopeSchema.parse(JSON.parse(text)));
    if (!opened.ok) throw new Error(`Fixture Node channel refused: ${opened.reason}`);
    return opened.plaintext;
  };
  service.attachNode(
    node.id,
    options.sealed === false ? raw : new SealedNodeLink(raw, hostChannel),
  );
  store.setNodeOnline(node.id, options.online ?? true, 0);

  cleanups.push(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const get = (kind: "stat" | "download", path: string) =>
    app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/files/${kind}?path=${encodeURIComponent(path)}`,
      headers: { host: "localhost", cookie },
    });
  return {
    app,
    service,
    store,
    node,
    session,
    workspace,
    dataDirectory,
    raw,
    reads,
    cookie,
    get,
    answerWith(next: Answer) {
      answer = next;
    },
    readWith: (request: SessionFileReadRequest) => reader.read(request),
  };
}

describe("session file downloads", () => {
  it.each(["copilot", "hermes"] as const)(
    "only grants Copilot native state for Copilot sessions: %s",
    async (kind) => {
      const { store, session, workspace, get, reads } = await fixture({
        agentParams:
          kind === "hermes" ? { kind, profile: "fleet-orchestrator" } : { kind },
      });
      const nativeId = randomUUID();
      store.appendEvent({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        type: "agent_session",
        payload: { agentSessionId: nativeId },
        createdAt: new Date().toISOString(),
      });
      await writeFile(join(workspace, "docs", "report.txt"), "report");
      expect((await get("stat", "docs/report.txt")).statusCode).toBe(200);
      expect(reads.at(-1)?.agentSessionId).toBe(kind === "copilot" ? nativeId : "");
      expect(reads.at(-1)?.roots).toEqual([workspace]);
    },
  );

  it("describes and streams a file from the session's machine, chunk by chunk", async () => {
    const { get, workspace, reads } = await fixture();
    const bytes = randomBytes(SESSION_FILE_CHUNK_BYTES * 2 + 1234);
    await writeFile(join(workspace, "docs", "résumé final;v2.bin"), bytes);
    const path = "docs/résumé final;v2.bin";

    const stat = await get("stat", path);
    expect(stat.statusCode).toBe(200);
    expect(stat.json()).toEqual({
      path: await realpath(join(workspace, "docs", "résumé final;v2.bin")),
      name: "résumé final;v2.bin",
      size: bytes.length,
      modifiedAt: expect.any(String),
    });
    expect(reads.at(-1)).toMatchObject({ path, length: 0, roots: [workspace] });

    const download = await get("download", path);
    expect(download.statusCode).toBe(200);
    expect(download.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "cache-control": "no-store",
      "content-disposition":
        "attachment; filename=\"r_sum_ final_v2.bin\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final%3Bv2.bin",
    });
    expect(download.rawPayload.equals(bytes)).toBe(true);
    // One read to open, then one per remaining chunk against the pinned file.
    const chunks = reads.slice(-3);
    expect(chunks.map((read) => [read.offset, read.length])).toEqual([
      [0, SESSION_FILE_CHUNK_BYTES],
      [SESSION_FILE_CHUNK_BYTES, SESSION_FILE_CHUNK_BYTES],
      [SESSION_FILE_CHUNK_BYTES * 2, 1234],
    ]);
    expect(new Set(chunks.slice(1).map((read) => read.version)).size).toBe(1);
    expect(chunks[1]!.path).toBe(stat.json().path);
  });

  it("answers what the Node refused with the matching status", async () => {
    const { get, workspace, dataDirectory } = await fixture();
    await writeFile(join(workspace, "docs", "report.txt"), "report");
    const outside = join(workspace, "..", "outside.txt");
    await writeFile(outside, "outside");
    const cases: Array<[string, number, RegExp]> = [
      ["docs/missing.txt", 404, /does not exist/],
      ["docs", 400, /not a file/],
      [outside, 403, /outside the folders/],
      [join(dataDirectory, "host.db"), 403, /own configuration/],
    ];
    for (const [path, status, message] of cases) {
      const response = await get("download", path);
      expect(response.statusCode, path).toBe(status);
      expect(response.json().error).toMatch(message);
    }
    expect((await get("stat", "")).statusCode).toBe(400);
  });

  it("says why a Node cannot send files before asking it", async () => {
    const offline = await fixture({ online: false });
    expect((await offline.get("stat", "a.txt")).statusCode).toBe(503);
    expect(offline.reads).toHaveLength(0);

    const outdated = await fixture({ capabilities: [] });
    const refused = await outdated.get("download", "a.txt");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Update files-fixture/);

    const legacy = await fixture({ sealed: false });
    const unsealed = await legacy.get("download", "a.txt");
    expect(unsealed.statusCode).toBe(409);
    expect(unsealed.json().error).toMatch(/shared secret/);
    expect(legacy.reads).toHaveLength(0);

    const unknown = await offline.app.inject({
      method: "GET",
      url: `/api/sessions/${randomUUID()}/files/stat?path=a.txt`,
      headers: { host: "localhost", cookie: offline.cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("requires an operator session", async () => {
    const { app, session, cookie, reads } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/files/download?path=a.txt`,
      headers: { host: "localhost" },
    });
    expect(response.statusCode).toBe(401);
    // A HEAD would drain the whole file across the Node's socket for nothing.
    const head = await app.inject({
      method: "HEAD",
      url: `/api/sessions/${session.id}/files/download?path=a.txt`,
      headers: { host: "localhost", cookie },
    });
    expect(head.statusCode).toBe(404);
    expect(reads).toHaveLength(0);
  });

  it("caps concurrent downloads from one Node and frees a slot when one finishes", async () => {
    const { get, service, node, workspace, answerWith, readWith } = await fixture();
    await writeFile(join(workspace, "a.txt"), "a");
    const held: Array<() => void> = [];
    answerWith(
      (request) =>
        new Promise((resolve) => {
          held.push(() => void readWith(request).then(resolve));
        }),
    );
    const running = [
      get("download", "a.txt"),
      get("download", "a.txt"),
      get("download", "a.txt"),
    ];
    await vi.waitFor(() => expect(service.files.activeDownloads(node.id)).toBe(3));
    const refused = await get("download", "a.txt");
    expect(refused.statusCode).toBe(429);
    for (const release of held.splice(0)) release();
    for (const response of await Promise.all(running)) expect(response.body).toBe("a");
    await vi.waitFor(() => expect(service.files.activeDownloads(node.id)).toBe(0));
    answerWith(readWith);
    expect((await get("download", "a.txt")).body).toBe("a");
  });

  it("gives up on a Node that does not answer, and on one that disconnects", async () => {
    const { service, session, node, answerWith } = await fixture();
    answerWith(async () => undefined);
    const impatient = new SessionFileService(service, { timeoutMs: 20 });
    expect(await impatient.stat(session.id, "a.txt")).toEqual({
      ok: false,
      status: 504,
      error: "The Node did not answer in time.",
    });
    // The read is registered before `stat` returns, so a disconnect now fails it.
    const waiting = service.files.stat(session.id, "a.txt");
    service.disconnectNode(node.id, "gone");
    expect(await waiting).toMatchObject({ ok: false, status: 503 });
  });

  it("fails a download whose file changes underneath it, and one the browser abandons", async () => {
    const { app, service, node, session, cookie, workspace, answerWith, readWith } =
      await fixture();
    const file = join(workspace, "growing.bin");
    await writeFile(file, randomBytes(SESSION_FILE_CHUNK_BYTES * 3));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const fetchBody = () =>
      new Promise<{ status: number; length: number; bytes: number; aborted: boolean }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path: `/api/sessions/${session.id}/files/download?path=growing.bin`,
              headers: { host: "localhost", cookie },
            },
            (response) => {
              let bytes = 0;
              let aborted = false;
              response.on("data", (chunk: Buffer) => (bytes += chunk.length));
              response.on("aborted", () => (aborted = true));
              response.on("error", () => (aborted = true));
              response.on("close", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  length: Number(response.headers["content-length"]),
                  bytes,
                  aborted,
                }),
              );
            },
          );
          request.on("error", reject);
          request.end();
        },
      );

    let served = 0;
    answerWith(async (request) => {
      const result = await readWith(request);
      if (++served === 1)
        await writeFile(file, randomBytes(SESSION_FILE_CHUNK_BYTES * 4));
      return result;
    });
    const changed = await fetchBody();
    expect(changed.status).toBe(200);
    expect(changed.bytes).toBeLessThan(changed.length);
    await vi.waitFor(() => expect(service.files.activeDownloads(node.id)).toBe(0));

    answerWith(readWith);
    const abandoned = await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/api/sessions/${session.id}/files/download?path=growing.bin`,
          headers: { host: "localhost", cookie },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.on("error", () => {});
      request.on("close", () => resolve());
      request.end();
      setTimeout(() => reject(new Error("No bytes arrived")), 5_000).unref();
    });
    expect(abandoned).toBeUndefined();
    await vi.waitFor(() => expect(service.files.activeDownloads(node.id)).toBe(0), {
      timeout: 5_000,
    });
  });
});

describe("attachment disposition", () => {
  it("keeps the real name for modern clients and a safe stand-in for old ones", () => {
    expect(attachmentDisposition("report.docx")).toBe(
      "attachment; filename=\"report.docx\"; filename*=UTF-8''report.docx",
    );
    expect(attachmentDisposition("a\r\nb;c\\d%e'(f)*.txt")).toBe(
      "attachment; filename=\"a__b_c_d_e'(f)*.txt\"; filename*=UTF-8''a%0D%0Ab%3Bc%5Cd%25e%27%28f%29%2A.txt",
    );
    expect(attachmentDisposition("\ud800.txt")).toBe('attachment; filename="_.txt"');
  });
});
