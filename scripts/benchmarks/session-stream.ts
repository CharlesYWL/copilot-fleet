import Fastify from "fastify";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import WebSocket, { WebSocketServer } from "ws";
import {
  HostToNodeMessageSchema,
  NodeToHostMessageSchema,
  SessionEventSchema,
  SessionSchema,
} from "@fleet/protocol";
import { FleetStore } from "../../apps/host/src/store.js";
import { FleetService, type NodeLink } from "../../apps/host/src/fleet-service.js";
import { HOST_IDENTITY_ID_SETTING } from "../../apps/host/src/auth/host-identity.js";
import { NodeSessionConsole } from "../../apps/node/src/session-console.js";
import { SessionJournal } from "../../apps/node/src/session-journal.js";
import { SessionFileReader } from "../../apps/node/src/session-files.js";
import { CommandRouter } from "../../apps/node/src/router.js";
import { MockAgentFactory } from "../../apps/node/src/agents.js";

/**
 * Synthetic normalized events, real SQLite stores, separate Host/Node processes.
 * Loopback WebSockets are delayed to model RTT. No model, encryption, or browser painting
 * is measured; no production service or user configuration is contacted.
 */
const NodeConfigSchema = z.object({
  type: z.literal("start"),
  mode: z.enum(["direct", "journal"]),
  nodeId: z.string(),
  directory: z.string(),
  duration: z.number(),
  hostUrl: z.string(),
  sessions: z.array(SessionSchema),
});
const NodeResultSchema = z.object({
  type: z.literal("finished"),
  eventLoopP95Ms: z.number(),
  eventLoopMaxMs: z.number(),
  elapsedMs: z.number(),
  commitP95Ms: z.number(),
  sendP95Ms: z.number(),
  maxOutstanding: z.number(),
  replayRttP95Ms: z.number(),
});
type Result = {
  mode: "direct" | "journal";
  sessions: number;
  simulatedRttMs: number;
  chunks: number;
  p50Ms: number;
  p95Ms: number;
  worstSessionP95Ms: number;
  maxMs: number;
  hostEventLoopP95Ms: number;
  nodeEventLoopP95Ms: number;
  nodeEventLoopMaxMs: number;
  requests: number;
  elapsedMs: number;
  nodeCommitP95Ms: number;
  nodeSendP95Ms: number;
  maxOutstanding: number;
  replayRttP95Ms: number;
  hostAckP95Ms: number;
};
const rounded = (value: number) => Math.round(value * 10) / 10;
const clock = () => performance.timeOrigin + performance.now();
const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};
async function until(
  condition: () => boolean,
  failure: () => string | undefined = () => undefined,
  timeoutMs = 30_000,
) {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && !failure() && performance.now() < deadline) await delay(5);
  if (failure()) throw new Error(failure());
  if (!condition()) throw new Error(`Benchmark did not finish within ${timeoutMs} ms`);
}

async function nodeWorker(): Promise<void> {
  if (!process.send) throw new Error("The Node benchmark must be forked with IPC");
  const [raw] = await once(process, "message");
  const config = NodeConfigSchema.parse(raw);
  const send = (message: unknown) => process.send?.(message);
  let error: string | undefined;
  let controller: NodeSessionConsole | undefined;
  let journal: SessionJournal | undefined;
  let stopped = false;
  const commits: number[] = [];
  const sends: number[] = [];
  const outstanding = new Map<string, number>();
  const replayRtts: number[] = [];
  let maxOutstanding = 0;
  const socket = new WebSocket(config.hostUrl);
  await once(socket, "open");
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "stop"
    ) {
      stopped = true;
      return;
    }
  });
  socket.on("message", (raw) => {
    try {
      const frame = HostToNodeMessageSchema.parse(JSON.parse(String(raw)));
      if (frame.type === "session_console_response") {
        const began = outstanding.get(frame.response.requestId);
        if (began !== undefined) {
          replayRtts.push(performance.now() - began);
          outstanding.delete(frame.response.requestId);
        }
        controller?.response(frame.response);
      } else if (frame.type === "session_console_grant") controller?.grant(frame.grant);
      else if (frame.type === "session_console_update") controller?.update(frame.message);
    } catch (reason) {
      error = String(reason);
    }
  });
  try {
    if (config.mode === "journal") {
      journal = new SessionJournal(join(config.directory, "history"), {
        secure: false,
        onEvents: (events) => {
          for (const event of events)
            if (event.sequence > 20 && typeof event.payload.benchmarkAt === "number")
              commits.push(clock() - event.payload.benchmarkAt);
          controller!.committed(events);
        },
        onFailure: (reason) => {
          error = String(reason);
        },
      });
      controller = new NodeSessionConsole({
        journal,
        router: new CommandRouter(new MockAgentFactory(), 64, () => {}),
        files: new SessionFileReader(),
        hostId: () => "benchmark-host",
        nodeId: () => config.nodeId,
        onError: (reason) => {
          error = reason;
        },
        send: (message) => {
          if (
            message.type === "session_console_request" &&
            message.request.kind === "replay"
          ) {
            outstanding.set(message.requestId, performance.now());
            maxOutstanding = Math.max(maxOutstanding, outstanding.size);
            for (const event of message.request.events)
              if (event.sequence > 20 && typeof event.payload.benchmarkAt === "number")
                sends.push(clock() - event.payload.benchmarkAt);
          }
          socket.send(JSON.stringify(message));
          return true;
        },
      });
      await controller.connected(true);
      send({ type: "grant_sessions" });
      await until(
        () => config.sessions.every((session) => journal!.has(session.id)),
        () => error,
      );
    }
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const start = performance.now();
    const cycles = Math.ceil(config.duration / 20);
    for (let sequence = 1; sequence <= cycles; sequence++) {
      for (let index = 0; index < config.sessions.length; index++) {
        const target =
          start + (sequence - 1) * 20 + (index * 20) / config.sessions.length;
        if (target > performance.now()) await delay(target - performance.now());
        const session = config.sessions[index]!;
        const event = {
          eventId: randomUUID(),
          sessionId: session.id,
          sequence,
          type: "agent_text" as const,
          payload: { text: "A short streamed token chunk. ", benchmarkAt: clock() },
          createdAt: new Date().toISOString(),
        };
        if (controller) controller.capture(event);
        else socket.send(JSON.stringify({ type: "event", event }));
      }
    }
    journal?.flush();
    if (journal)
      await until(
        () =>
          journal!
            .list("benchmark-host")
            .every((entry) => entry.highWater === entry.acknowledgedSequence),
        () => error,
      );
    lag.disable();
    send({
      type: "finished",
      eventLoopP95Ms: rounded(lag.percentile(95) / 1e6),
      eventLoopMaxMs: rounded(lag.max / 1e6),
      elapsedMs: Math.round(performance.now() - start),
      commitP95Ms: rounded(percentile(commits, 0.95)),
      sendP95Ms: rounded(percentile(sends, 0.95)),
      maxOutstanding,
      replayRttP95Ms: rounded(percentile(replayRtts, 0.95)),
    });
    await until(() => stopped);
  } finally {
    controller?.close();
    journal?.close();
    const closed = once(socket, "close");
    socket.close();
    await closed;
    process.disconnect();
  }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "stop" });
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

async function measure(
  mode: Result["mode"],
  count: number,
  rtt: number,
  duration: number,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), "fleet-session-stream-"));
  const app = Fastify();
  const store = new FleetStore(join(directory, "host.db"), { secureFiles() {} });
  store.setSetting(HOST_IDENTITY_ID_SETTING, "benchmark-host");
  const service = new FleetService(store, app.log);
  const { node } = store.registerNode({
    name: "benchmark-node",
    os: "win32",
    arch: "x64",
    version: "benchmark",
    capabilities: ["copilot-acp"],
    maxSessions: 64,
  });
  const workspace = store.createWorkspace("benchmark", "");
  const placement = store.createPlacement(workspace.id, node.id, directory);
  const sessions = Array.from({ length: count }, (_, index) => {
    const session = store.createSession(
      placement,
      "Synthetic stream",
      false,
      `Stream ${index}`,
    );
    store.transitionSession(session.id, "starting");
    return store.transitionSession(session.id, "running");
  });
  const timers = new Set<NodeJS.Timeout>();
  const latencies = new Map(sessions.map((session) => [session.id, [] as number[]]));
  const lag = monitorEventLoopDelay({ resolution: 10 });
  let closing = false;
  let requests = 0;
  let received = 0;
  let error: string | undefined;
  let result: z.infer<typeof NodeResultSchema> | undefined;
  const receivedRequests = new Map<string, number>();
  const hostAcks: number[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No benchmark WebSocket address");
  let socket: WebSocket | undefined;
  const child = fork(fileURLToPath(import.meta.url), ["--worker"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.on("error", (reason) => {
    error = String(reason);
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8_000);
  });
  child.on("exit", (code, signal) => {
    if (!closing && (code !== 0 || signal))
      error = `Node benchmark exited (${code ?? signal}): ${stderr}`;
  });
  const wire = (work: () => void) => {
    if (rtt === 0) {
      queueMicrotask(() => {
        if (!closing) work();
      });
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closing) work();
    }, rtt / 2);
    timers.add(timer);
  };
  const link: NodeLink = {
    OPEN: 1,
    get readyState() {
      return socket?.readyState ?? 0;
    },
    close() {},
    send(raw) {
      const frame = HostToNodeMessageSchema.parse(JSON.parse(raw));
      if (frame.type === "session_console_response") {
        const at = receivedRequests.get(frame.response.requestId);
        if (at !== undefined) {
          hostAcks.push(performance.now() - at);
          receivedRequests.delete(frame.response.requestId);
        }
      }
      wire(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      });
    },
  };
  service.attachNode(node.id, link);
  store.setNodeOnline(node.id, true, count);
  if (mode === "journal") service.console.attach(node.id, link, [], []);
  service.onSessionEvent((event) => {
    received++;
    if (event.sequence <= 20 || typeof event.payload.benchmarkAt !== "number") return;
    latencies.get(event.sessionId)!.push(clock() - event.payload.benchmarkAt);
  });
  server.on("connection", (connected) => {
    socket = connected;
    socket.on("message", (raw) => {
      try {
        const frame = NodeToHostMessageSchema.parse(JSON.parse(String(raw)));
        if (frame.type === "session_console_request") requests++;
        wire(() => {
          if (frame.type === "event")
            service.handleEvent(SessionEventSchema.parse(frame.event));
          else if (frame.type === "session_console_request") {
            if (frame.request.kind === "replay")
              receivedRequests.set(frame.requestId, performance.now());
            void service.console.handle(node.id, frame.requestId, frame.request);
          }
        });
      } catch (reason) {
        error = String(reason);
      }
    });
  });
  child.on("message", (message: unknown) => {
    try {
      if (!message || typeof message !== "object" || !("type" in message))
        throw new Error("Invalid benchmark message");
      if (message.type === "grant_sessions") {
        for (const session of sessions) service.console.observe(session);
      } else if (message.type === "finished") {
        result = NodeResultSchema.parse(message);
      } else throw new Error("Unsupported benchmark message");
    } catch (reason) {
      error = String(reason);
    }
  });
  try {
    await service.transcripts.page(sessions[0]!.id);
    lag.enable();
    child.send({
      type: "start",
      mode,
      nodeId: node.id,
      directory,
      duration,
      sessions,
      hostUrl: `ws://127.0.0.1:${address.port}`,
    });
    const expected = Math.ceil(duration / 20) * count;
    await until(
      () => !!result && received === expected,
      () => error,
      duration + 30_000,
    );
    lag.disable();
    const all = [...latencies.values()].flat();
    return {
      mode,
      sessions: count,
      simulatedRttMs: rtt,
      chunks: all.length,
      p50Ms: rounded(percentile(all, 0.5)),
      p95Ms: rounded(percentile(all, 0.95)),
      worstSessionP95Ms: rounded(
        Math.max(...[...latencies.values()].map((values) => percentile(values, 0.95))),
      ),
      maxMs: rounded(Math.max(...all)),
      hostEventLoopP95Ms: rounded(lag.percentile(95) / 1e6),
      nodeEventLoopP95Ms: result!.eventLoopP95Ms,
      nodeEventLoopMaxMs: result!.eventLoopMaxMs,
      requests,
      elapsedMs: result!.elapsedMs,
      nodeCommitP95Ms: result!.commitP95Ms,
      nodeSendP95Ms: result!.sendP95Ms,
      maxOutstanding: result!.maxOutstanding,
      replayRttP95Ms: result!.replayRttP95Ms,
      hostAckP95Ms: rounded(percentile(hostAcks, 0.95)),
    };
  } finally {
    closing = true;
    lag.disable();
    for (const timer of timers) clearTimeout(timer);
    await stopChild(child);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.shutdown();
    store.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    worker: { type: "boolean" },
    sessions: { type: "string", default: "1,4,8" },
    rtt: { type: "string", default: "50" },
    duration: { type: "string", default: "4000" },
    output: { type: "string" },
    "max-regression-ms": { type: "string" },
  },
});
if (values.worker) {
  await nodeWorker();
} else {
  const counts = values.sessions.split(",").map(Number);
  const rtt = Number(values.rtt);
  const duration = Number(values.duration);
  if (
    !counts.length ||
    counts.some((count) => !Number.isInteger(count) || count < 1 || count > 64) ||
    !Number.isFinite(rtt) ||
    rtt < 0 ||
    rtt > 1000 ||
    !Number.isFinite(duration) ||
    duration < 1000
  )
    throw new Error(
      "Use sessions 1-64, RTT 0-1000 ms and a duration of at least 1000 ms",
    );
  const results: Result[] = [];
  for (const count of counts) {
    for (const mode of ["direct", "journal"] as const) {
      const result = await measure(mode, count, rtt, duration);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  if (values.output)
    writeFileSync(
      values.output,
      JSON.stringify({ rate: 50, processes: "separate", results }, null, 2),
    );
  if (values["max-regression-ms"] !== undefined) {
    const budget = Number(values["max-regression-ms"]);
    if (!Number.isFinite(budget) || budget < 0)
      throw new Error("The regression budget must be nonnegative milliseconds");
    for (const count of counts) {
      const direct = results.find(
        (result) => result.sessions === count && result.mode === "direct",
      )!;
      const journal = results.find(
        (result) => result.sessions === count && result.mode === "journal",
      )!;
      if (journal.p95Ms > direct.p95Ms + budget)
        throw new Error(
          `${count} sessions: journaled P95 ${journal.p95Ms} ms exceeds direct ${direct.p95Ms} ms plus ${budget} ms`,
        );
    }
  }
}
