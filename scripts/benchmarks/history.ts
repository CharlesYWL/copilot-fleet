import { strict as assert } from "node:assert";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, get } from "node:http";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import { z } from "zod";
import {
  SessionEventSchema,
  SessionPermissions,
  TRANSCRIPT_PAGE_LIMIT,
  isTranscriptEvent,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";
import { FleetService } from "../../apps/host/src/fleet-service.js";
import { sessionRoutes } from "../../apps/host/src/routes/sessions.js";
import { FleetStore } from "../../apps/host/src/store.js";
import { TranscriptProjections } from "../../apps/host/src/transcript-projections.js";
import { TranscriptCache } from "../../apps/host/ui/src/lib/transcript-cache.js";
import { mergeEvents } from "../../apps/host/ui/src/lib/merge-events.js";
import { toPreviewLines } from "../../apps/host/ui/src/lib/session-preview.js";
import {
  pendingPermissionRequests,
  toTerminalBlocks,
} from "../../apps/host/ui/src/lib/terminal-blocks.js";
import {
  HISTORY_FIXTURE_VERSION,
  historyEvents,
  incomingEvents,
} from "./history-fixture.js";
import {
  HistoryReportSchema,
  comparisonLines,
  parseOptions,
  summarize,
  type BenchmarkOptions,
  type HistoryReport,
  type Measurement,
} from "./history-report.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const ReadySchema = z.object({
  type: z.literal("ready"),
  url: z.string().url(),
  historyPath: z.string(),
  report: HistoryReportSchema,
});
const StartedSchema = z.object({ type: z.literal("history-start") });
const ResetSchema = z.object({ type: z.literal("reset") });
const InvalidatedSchema = z.object({ type: z.literal("invalidated") });
const MetricsSchema = z.object({
  type: z.literal("metrics"),
  eventLoop: HistoryReportSchema.shape.hostEventLoop,
});
const workerTimeoutMs = 300_000;
/** What the browser keeps per session for monitor-wall previews. */
const LIVE_TAIL_EVENTS = 200;

function receive<T extends z.ZodTypeAny>(
  worker: ChildProcess,
  expectedType: string,
  schema: T,
  timeoutMs = workerTimeoutMs,
): Promise<z.infer<T>> {
  return new Promise((accept, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
      worker.off("error", onError);
    };
    const onMessage = (value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("type" in value) ||
        value.type !== expectedType
      )
        return;
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        onError(
          new Error(`Invalid ${expectedType} benchmark message: ${parsed.error.message}`),
        );
        return;
      }
      cleanup();
      accept(parsed.data);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Benchmark worker exited early (${code ?? signal})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(
      () => onError(new Error("Benchmark worker timed out")),
      timeoutMs,
    );
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.once("error", onError);
  });
}

function send(value: Record<string, unknown>): void {
  if (!process.send || !process.connected)
    throw new Error("Benchmark worker requires its parent IPC connection");
  process.send(value);
}

async function measure<T>(
  measurements: Record<string, Measurement>,
  options: BenchmarkOptions,
  name: string,
  operation: () => T,
): Promise<T> {
  const samples: number[] = [];
  let result!: T;
  for (let index = 0; index < options.warmup + options.iterations; index++) {
    await setImmediate();
    const start = performance.now();
    result = operation();
    const elapsed = performance.now() - start;
    if (index >= options.warmup) samples.push(elapsed);
  }
  measurements[name] = summarize(samples);
  return result;
}

function environment(): HistoryReport["environment"] {
  const processors = cpus();
  if (!processors[0]) throw new Error("Cannot read CPU information for the report");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: processors[0].model,
    cpuCount: processors.length,
    revision: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
  };
}

export function seed(
  store: FleetStore,
  database: DatabaseSync,
  options: BenchmarkOptions,
): { ids: string[]; fixture: HistoryReport["fixture"] } {
  const { node } = store.registerNode({
    name: "Synthetic benchmark node",
    os: process.platform,
    arch: process.arch,
    version: "benchmark",
    capabilities: ["copilot-acp"],
    maxSessions: options.sessions,
  });
  const workspace = store.createWorkspace("Synthetic benchmark", "");
  const placement = store.createPlacement(workspace.id, node.id, repoRoot);
  const ids = Array.from({ length: options.sessions }, (_, index) => {
    const session = store.createSession(
      placement,
      "Synthetic benchmark",
      false,
      `Synthetic session ${index}`,
    );
    return session.id;
  });
  const fixture: HistoryReport["fixture"] = {
    version: HISTORY_FIXTURE_VERSION,
    leadEvents: options.events,
    backgroundEventsPerSession: Math.ceil(options.events / 14),
    sessions: options.sessions,
    totalEvents: 0,
    leadBlocks: 0,
    eventTypes: {},
  };
  const insert = database.prepare(
    "INSERT INTO events (event_id,session_id,sequence,type,payload,created_at,received_at) VALUES (?,?,?,?,?,?,?)",
  );
  database.exec("BEGIN");
  try {
    for (const [sessionIndex, sessionId] of ids.entries()) {
      const count =
        sessionIndex === 0 ? options.events : fixture.backgroundEventsPerSession;
      for (const candidate of historyEvents(sessionId, sessionIndex, count)) {
        const event = SessionEventSchema.parse(candidate);
        insert.run(
          event.eventId,
          event.sessionId,
          event.sequence,
          event.type,
          JSON.stringify(event.payload),
          event.createdAt,
          event.createdAt,
        );
        fixture.totalEvents++;
        fixture.eventTypes[event.type] = (fixture.eventTypes[event.type] ?? 0) + 1;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { ids, fixture };
}

async function diagnostics(
  database: DatabaseSync,
  id: string,
  measurements: Record<string, Measurement>,
  options: BenchmarkOptions,
): Promise<void> {
  const run = <T>(name: string, operation: () => T) =>
    measure(measurements, options, `diagnostic.${name}`, operation);
  const statement = database.prepare(
    "SELECT * FROM events WHERE session_id=? ORDER BY sequence",
  );
  const rows = await run("sqlSelect", () => statement.all(id));
  const decoded = await run("decodePayloads", () =>
    rows.map((row) => ({
      eventId: String(row.event_id),
      sessionId: String(row.session_id),
      sequence: Number(row.sequence),
      type: String(row.type),
      payload: JSON.parse(String(row.payload)) as unknown,
      createdAt: String(row.created_at),
    })),
  );
  const validated = await run("validateOuterSchema", () =>
    decoded.map((event) => SessionEventSchema.parse(event)),
  );
  assert.equal(validated.length, options.events);
}

async function measureAsync<T>(
  measurements: Record<string, Measurement>,
  options: BenchmarkOptions,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const samples: number[] = [];
  let result!: T;
  for (let index = 0; index < options.warmup + options.iterations; index++) {
    await setImmediate();
    const start = performance.now();
    result = await operation();
    const elapsed = performance.now() - start;
    if (index >= options.warmup) samples.push(elapsed);
  }
  measurements[name] = summarize(samples);
  return result;
}

/** Times `operation` only; `prepare` builds a fresh input for each sample. */
async function measurePrepared<S, T>(
  measurements: Record<string, Measurement>,
  options: BenchmarkOptions,
  name: string,
  prepare: (iteration: number) => S,
  operation: (state: S) => T,
): Promise<T> {
  const samples: number[] = [];
  let result!: T;
  for (let index = 0; index < options.warmup + options.iterations; index++) {
    const state = prepare(index);
    await setImmediate();
    const start = performance.now();
    result = operation(state);
    const elapsed = performance.now() - start;
    if (index >= options.warmup) samples.push(elapsed);
  }
  measurements[name] = summarize(samples);
  return result;
}

async function nodeMeasurements(
  store: FleetStore,
  database: DatabaseSync,
  ids: string[],
  options: BenchmarkOptions,
): Promise<Pick<HistoryReport, "measurements" | "sizesBytes">> {
  const measurements: Record<string, Measurement> = {};
  const run = <T>(name: string, operation: () => T) =>
    measure(measurements, options, name, operation);
  const id = ids[0]!;
  await diagnostics(database, id, measurements, options);
  const events = await run("store.listEvents", () => store.listEvents(id));
  assert.equal(events.length, options.events);
  const from = Math.floor(options.events * 0.9);
  const legacySuffix = await run("diagnostic.readThenFilter", () =>
    store.listEvents(id).filter((event) => event.sequence > from),
  );
  const suffix = await run("store.listEventsAfter", () =>
    store.listEventsAfter(id, from),
  );
  assert.deepEqual(suffix, legacySuffix);

  // First open after a Host start: the whole log folded in yielding batches.
  const noReset = () => {};
  await measureAsync(measurements, options, "host.projection.build", () =>
    new TranscriptProjections(store, noReset).page(id),
  );
  const projections = new TranscriptProjections(store, noReset);
  await projections.page(id);
  // Every later open: a slice of the maintained projection.
  const page = await measureAsync(measurements, options, "host.projection.page", () =>
    projections.page(id),
  );
  assert.equal(page.blocks.length, Math.min(TRANSCRIPT_PAGE_LIMIT, page.total));
  const body = await run("history.stringify", () => JSON.stringify(page));
  const parsed = await run(
    "history.parse.node",
    () => JSON.parse(body) as TranscriptPage,
  );
  const blocks = await run("transcript.fold", () => toTerminalBlocks(events));
  assert.deepEqual(parsed.blocks, blocks.slice(-parsed.blocks.length));

  const known = Object.fromEntries(
    ids.map((sessionId) => [
      sessionId,
      sessionId === id ? events : store.listEvents(sessionId),
    ]),
  );
  await run("permissions.allCached", () =>
    pendingPermissionRequests(Object.values(known).flat()),
  );
  const permissionEvents = await run("store.listPermissionEvents", () =>
    store.listPermissionEvents(),
  );
  const permissions = new SessionPermissions();
  permissions.apply(permissionEvents);
  const tail = events.filter(isTranscriptEvent).slice(-LIVE_TAIL_EVENTS);
  await run("permissions.liveText", () =>
    permissions.apply([incomingEvents(id, options.events + 1).text!]),
  );
  // A monitor tile folds only the live tail it keeps.
  const preview = await run("preview.last12", () =>
    toPreviewLines(toTerminalBlocks(tail), "", 12),
  );
  assert.ok(preview.length <= 12);

  // A streamed event: the Host advances its projection, the browser applies
  // the one change to its copy, and the preview tail takes the event.
  let sequence = options.events + 1;
  for (const name of ["text", "thought", "olderTool", "permission"]) {
    const next = (iteration: number) => {
      const item = incomingEvents(id, ++sequence)[name]!;
      return { ...item, eventId: `${item.eventId}:${iteration}:${sequence}` };
    };
    await measurePrepared(measurements, options, `events.merge.${name}`, next, (event) =>
      mergeEvents([event], tail),
    );
    const updates: TranscriptUpdate[] = [];
    await measurePrepared(
      measurements,
      options,
      `host.projection.apply.${name}`,
      next,
      (event) => {
        const update = projections.apply(event);
        if (update) updates.push(update);
        return update;
      },
    );
    assert.ok(updates.length > 0, `${name} events must change the transcript`);
    await measurePrepared(
      measurements,
      options,
      `transcript.update.${name}`,
      (iteration) => {
        const cache = new TranscriptCache();
        const update = updates[iteration % updates.length]!;
        cache.begin(id);
        cache.receive(id, {
          ...page,
          generation: update.generation,
          revision: update.revision - 1,
        });
        return { cache, update };
      },
      ({ cache, update }) => cache.apply(id, update),
    );
  }
  const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  return {
    measurements,
    sizesBytes: {
      rawHistory: byteLength(events),
      currentTranscript: Buffer.byteLength(body, "utf8"),
      filteredHistoryEstimate: byteLength(events.filter(isTranscriptEvent)),
      allBlocksEstimate: byteLength(blocks),
      last200BlocksEstimate: byteLength(blocks.slice(-200)),
      projectionRetained: projections.retainedBytes,
    },
  };
}

async function runWorker(options: BenchmarkOptions): Promise<void> {
  if (!process.send) throw new Error("--worker is reserved for the benchmark runner");
  const directory = mkdtempSync(join(tmpdir(), "fleet-history-benchmark-"));
  const databasePath = join(directory, "synthetic.db");
  const app = Fastify({ logger: false });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let store: FleetStore | undefined;
  let database: DatabaseSync | undefined;
  let service: FleetService | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      histogram.disable();
      const failures: unknown[] = [];
      for (const dispose of [
        () => app.close(),
        () => service?.shutdown(),
        () => database?.close(),
        () => store?.close(),
        () => rmSync(directory, { recursive: true, force: true }),
      ]) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (process.connected) process.disconnect();
      if (failures.length)
        throw new AggregateError(
          failures,
          `Could not clean benchmark directory ${directory}`,
        );
    })());
  const onDisconnect = () => {
    void close().catch((error: unknown) => {
      process.stderr.write(`Benchmark cleanup failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("disconnect", onDisconnect);
  try {
    store = new FleetStore(databasePath);
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys=ON");
    const { ids, fixture } = seed(store, database, options);
    const results = await nodeMeasurements(store, database, ids, options);
    fixture.leadBlocks = toTerminalBlocks(store.listEvents(ids[0]!)).length;
    service = new FleetService(store, app.log, "synthetic-benchmark");
    const historyPath = `/api/sessions/${ids[0]}/transcript`;
    app.addHook("onRequest", async (request, reply) => {
      if (
        request.method !== "GET" ||
        (request.url !== historyPath && request.url !== "/_benchmark/ping")
      ) {
        return reply.code(403).send({ error: "This isolated server is read-only" });
      }
      if (request.url === historyPath) send({ type: "history-start" });
    });
    app.get("/_benchmark/ping", async () => ({ ok: true }));
    await app.register(sessionRoutes, { service });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    process.on("message", (message: unknown) => {
      void (async () => {
        if (message === "shutdown") {
          await close();
        } else if (message === "invalidate") {
          service!.transcripts.clear();
          send({ type: "invalidated" });
        } else if (message === "reset") {
          histogram.enable();
          await delay(25);
          histogram.reset();
          send({ type: "reset" });
        } else if (message === "metrics") {
          await delay(25);
          send({
            type: "metrics",
            eventLoop: {
              resolutionMs: 10,
              meanMs: histogram.mean / 1e6,
              p95Ms: histogram.percentile(95) / 1e6,
              maxMs: histogram.max / 1e6,
            },
          });
        } else {
          throw new Error("Unexpected benchmark worker command");
        }
      })().catch((error: unknown) => {
        process.stderr.write(`Benchmark worker failed: ${String(error)}\n`);
        process.exitCode = 1;
        onDisconnect();
      });
    });
    send({
      type: "ready",
      url,
      historyPath,
      report: {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        environment: environment(),
        fixture,
        sampling: {
          iterations: options.iterations,
          warmup: options.warmup,
          percentile: "nearest-rank",
        },
        ...results,
        hostEventLoop: { resolutionMs: 10, meanMs: 0, p95Ms: 0, maxMs: 0 },
        notes: [
          "Synthetic fixture only. Setup and seeding are excluded; no live Host or database is accessed.",
          "Node stages are not browser, React, layout, paint, or input-to-paint measurements.",
          "diagnostic.* reproduces individual decoding stages; store.listEvents and HTTP call production implementations.",
          "host.projection.build is a first open after a Host start; host.projection.page is every later open.",
          "transcript.update.* applies one Host block change to the browser's copy; events.merge.* updates the 200-event preview tail.",
          "history.* is the newest 200-block page the browser downloads; rawHistory is the canonical log for reference.",
          "HTTP is the real browser transcript route on loopback, without production auth, TLS, compression, gateways, or agents.",
          "http.history.cold.* drops the projection before each request; hostEventLoopCold covers those rebuilds.",
          "The responsiveness probe uses a separate connection and parent process; an IPC signal starts it when history handling begins.",
          "The event-loop histogram has 10 ms resolution; inspect its maximum as well as its P95.",
          "All size estimates use UTF-8 bytes, not characters; block/filtered estimates are not implemented APIs.",
          "permissions.allCached is the legacy diagnostic scan; permissions.liveText measures the current incremental index.",
          "Natural GC is included; no forced collection.",
        ],
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}

type HttpSample = { ttfbMs: number; totalMs: number; bytes: number };

function request(url: string, agent: Agent): Promise<HttpSample> {
  return new Promise((accept, reject) => {
    const start = performance.now();
    const timeout = setTimeout(
      () => req.destroy(new Error("Benchmark HTTP timeout")),
      workerTimeoutMs,
    );
    const req = get(url, { agent }, (response) => {
      const ttfbMs = performance.now() - start;
      if (response.statusCode !== 200) {
        response.resume();
        clearTimeout(timeout);
        reject(new Error(`Benchmark HTTP ${response.statusCode} from ${url}`));
        return;
      }
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      response.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      response.on("end", () => {
        clearTimeout(timeout);
        accept({ ttfbMs, totalMs: performance.now() - start, bytes });
      });
    });
    req.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => {
      worker.kill();
      reject(
        new Error(
          "Benchmark worker did not stop cleanly; inspect stderr for its temporary directory",
        ),
      );
    }, 10_000);
    worker.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) accept();
      else reject(new Error(`Benchmark worker stopped with ${code ?? signal}`));
    });
    if (worker.connected) worker.send("shutdown");
    else worker.kill();
  });
}

export async function runBenchmark(options: BenchmarkOptions): Promise<HistoryReport> {
  const worker = fork(
    fileURLToPath(import.meta.url),
    [
      "--worker",
      "--events",
      String(options.events),
      "--sessions",
      String(options.sessions),
      "--iterations",
      String(options.iterations),
      "--warmup",
      String(options.warmup),
    ],
    {
      cwd: repoRoot,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const historyAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const probeAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const startupTimeout =
      workerTimeoutMs *
      Math.max(1, options.events / 112000) *
      Math.max(1, (options.iterations + options.warmup) / 35);
    const { report, url, historyPath } = await receive(
      worker,
      "ready",
      ReadySchema,
      startupTimeout,
    );
    await request(`${url}/_benchmark/ping`, probeAgent);
    const metrics = async () => {
      const reply = receive(worker, "metrics", MetricsSchema);
      worker.send("metrics");
      return (await reply).eventLoop;
    };
    const resetEventLoop = async () => {
      const reply = receive(worker, "reset", ResetSchema);
      worker.send("reset");
      await reply;
    };
    // A first open after a Host start: the projection is rebuilt every time.
    const coldTotal: number[] = [];
    const coldProbe: number[] = [];
    await resetEventLoop();
    for (let index = 0; index < options.warmup + options.iterations; index++) {
      const invalidated = receive(worker, "invalidated", InvalidatedSchema);
      worker.send("invalidate");
      await invalidated;
      const started = receive(worker, "history-start", StartedSchema);
      const [history, concurrent] = await Promise.all([
        request(`${url}${historyPath}`, historyAgent),
        started.then(() => request(`${url}/_benchmark/ping`, probeAgent)),
      ]);
      assert.equal(history.bytes, report.sizesBytes.currentTranscript);
      if (index >= options.warmup) {
        coldTotal.push(history.totalMs);
        coldProbe.push(concurrent.totalMs);
      }
    }
    report.measurements["http.history.cold.total"] = summarize(coldTotal);
    report.measurements["http.probe.duringColdHistory"] = summarize(coldProbe);
    report.hostEventLoopCold = await metrics();
    const ttfb: number[] = [];
    const total: number[] = [];
    const probe: number[] = [];
    const idleProbe: number[] = [];
    for (let index = 0; index < options.warmup + options.iterations; index++) {
      if (index === options.warmup) await resetEventLoop();

      const idle = await request(`${url}/_benchmark/ping`, probeAgent);
      const started = receive(worker, "history-start", StartedSchema);
      const [history, concurrent] = await Promise.all([
        request(`${url}${historyPath}`, historyAgent),
        started.then(() => request(`${url}/_benchmark/ping`, probeAgent)),
      ]);
      assert.equal(history.bytes, report.sizesBytes.currentTranscript);
      if (index >= options.warmup) {
        ttfb.push(history.ttfbMs);
        total.push(history.totalMs);
        probe.push(concurrent.totalMs);
        idleProbe.push(idle.totalMs);
      }
    }
    report.measurements["http.history.ttfb"] = summarize(ttfb);
    report.measurements["http.history.total"] = summarize(total);
    report.measurements["http.probe.idle"] = summarize(idleProbe);
    report.measurements["http.probe.duringHistory"] = summarize(probe);
    report.sizesBytes.httpHistory = report.sizesBytes.currentTranscript!;
    report.hostEventLoop = await metrics();

    return HistoryReportSchema.parse(report);
  } finally {
    historyAgent.destroy();
    probeAgent.destroy();
    await stopWorker(worker);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run benchmark:history -- [--events 112000] [--sessions 26]\n" +
        "  [--iterations 30] [--warmup 5] [--output dist/benchmarks/history.json]\n" +
        "  [--baseline path-to-earlier-report.json]\n" +
        "Synthetic data only. Measures Node stages and isolated HTTP, not browser paint.\n",
    );
    return;
  }
  if (options.worker) {
    await runWorker(options);
    return;
  }
  const baseline = options.baseline
    ? HistoryReportSchema.parse(JSON.parse(readFileSync(options.baseline, "utf8")))
    : undefined;
  const output = resolve(options.output);
  const comparablePath = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (options.baseline && comparablePath(output) === comparablePath(options.baseline))
    throw new Error("--output must not overwrite --baseline");
  process.stdout.write(
    `Benchmarking ${options.events.toLocaleString()} lead events, ${options.sessions} sessions; ` +
      `${options.warmup} warm-up + ${options.iterations} measured iterations.\n`,
  );
  const report = await runBenchmark(options);
  const comparison = baseline ? comparisonLines(report, baseline) : [];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    Object.entries(report.measurements)
      .map(
        ([name, value]) =>
          `${name.padEnd(35)} median ${value.medianMs.toFixed(2).padStart(8)} ms | P95 ${value.p95Ms.toFixed(2).padStart(8)} ms`,
      )
      .join("\n") +
      `\nHost event-loop maximum: ${report.hostEventLoop.maxMs.toFixed(2)} ms` +
      (report.hostEventLoopCold
        ? ` (rebuilding projections: ${report.hostEventLoopCold.maxMs.toFixed(2)} ms)`
        : "") +
      "\n" +
      `History: ${report.sizesBytes.httpHistory} UTF-8 bytes; ${report.fixture.leadBlocks} blocks\n` +
      (comparison.length
        ? `\nComparison (positive percentages are slower):\n${comparison.join("\n")}\n`
        : "") +
      `Saved ${output}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
