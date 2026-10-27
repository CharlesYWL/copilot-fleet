/**
 * Measures what following Copilot's native session logs costs a Node and Host.
 *
 *   npx tsx scripts/benchmarks/native-session-sync.ts [--sessions 50] [--real <dir>]
 *
 * Scenarios, all against a temporary COPILOT_HOME (the real ~/.copilot is only
 * ever read, and only with --real):
 *
 *   idle       One follower pass over N followed sessions that did not change.
 *              This is the steady cost every 3 seconds on a Node.
 *   append     A terminal turn appended to every session, then one pass.
 *   catch-up   One large log read from byte 0 by the follower's reader and by
 *              the existing SessionCreditReader, which already does this on
 *              every Fleet start/resume. With --real, the largest real logs.
 *   ingest     Imported turns stored by a real FleetStore + FleetService and
 *              projected into the transcript, as the Host does on receipt.
 *
 * Event-loop delay is sampled throughout, because a Node's only thread also
 * carries every live session's stream.
 */
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  MemoryFollowerStore,
  NativeSessionFollower,
  readNativeEvents,
  translateNativeEvents,
  type ImportMessage,
} from "../../apps/node/src/native-session-sync.js";
import { SessionCreditReader } from "../../apps/node/src/session-credits.js";
import { FleetStore } from "../../apps/host/src/store.js";
import { FleetService } from "../../apps/host/src/fleet-service.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "50" },
    "synthetic-mb": { type: "string", default: "150" },
    real: { type: "string" },
    "real-count": { type: "string", default: "3" },
    passes: { type: "string", default: "20" },
  },
});
const sessionCount = Number(values.sessions);
const syntheticMb = Number(values["synthetic-mb"]);
const passes = Number(values.passes);

/** The report is this script's output; stdout keeps it apart from logs. */
const report = (line: string) => process.stdout.write(`${line}\n`);
const ms = (value: number) => `${value.toFixed(2)} ms`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const percentile = (samples: number[], fraction: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

let counter = 0;
const nativeLine = (type: string, data: Record<string, unknown>) =>
  `${JSON.stringify({ type, data, id: `n${++counter}-${randomUUID()}`, timestamp: new Date().toISOString(), parentId: null })}\n`;

/** One realistic turn: prompt, hooks, several tool calls with bulky output, answer. */
function turn(text: string, toolOutputBytes = 6_000): string {
  let out = nativeLine("user.message", { content: text, interactionId: "i" });
  out += nativeLine("assistant.turn_start", { turnId: "0" });
  for (let call = 0; call < 4; call++) {
    out += nativeLine("hook.start", {
      hookType: "preToolUse",
      input: { a: "x".repeat(400) },
    });
    out += nativeLine("hook.end", { hookType: "preToolUse", success: true });
    out += nativeLine("assistant.message", {
      content: "",
      reasoningText: "Considering the next step. ".repeat(8),
      toolRequests: [
        {
          toolCallId: `c${call}`,
          name: "powershell",
          arguments: { command: "npm test" },
        },
      ],
    });
    out += nativeLine("tool.execution_start", {
      toolCallId: `c${call}`,
      toolName: "powershell",
      arguments: { command: "npm test" },
    });
    out += nativeLine("tool.execution_complete", {
      toolCallId: `c${call}`,
      success: true,
      result: {
        content: "y".repeat(toolOutputBytes),
        detailedContent: "z".repeat(toolOutputBytes),
      },
    });
  }
  out += nativeLine("assistant.message", {
    content: `Done: ${text}. `.repeat(20),
    toolRequests: [],
  });
  out += nativeLine("assistant.turn_end", { turnId: "0" });
  out += nativeLine("session.usage_checkpoint", { totalNanoAiu: 1_000_000_000 });
  return out;
}

async function writeLog(path: string, targetBytes: number): Promise<void> {
  const block = Array.from({ length: 20 }, (_, index) => turn(`task ${index}`)).join("");
  const blockBytes = Buffer.byteLength(block);
  await writeFile(path, "");
  for (let written = 0; written < targetBytes; written += blockBytes)
    await appendFile(path, block);
}

function loopMonitor() {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  return () => {
    histogram.disable();
    return { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
  };
}

async function benchmarkFollower(home: string): Promise<void> {
  const nativeIds = Array.from({ length: sessionCount }, () => randomUUID());
  for (const id of nativeIds) {
    await mkdir(join(home, "session-state", id), { recursive: true });
    // Each followed session starts with ~1 MB of history, the real average.
    await writeLog(join(home, "session-state", id, "events.jsonl"), 1024 * 1024);
  }
  const sent: ImportMessage[] = [];
  const follower = new NativeSessionFollower({
    copilotHome: home,
    store: new MemoryFollowerStore(),
    fleetTurnActive: () => false,
    reserveSequences: () => undefined,
    send: (message) => {
      sent.push(message);
      queueMicrotask(() => follower.acknowledge(message.importId, "stored", 1));
      return true;
    },
    startTimes: async (pids) => new Map(pids.map((pid) => [pid, 0])),
  });
  for (const [index, id] of nativeIds.entries())
    await follower.track(`fleet-${index}`, id);
  follower.connect(3_600_000);
  await follower.poll();
  await new Promise((resolve) => setTimeout(resolve, 10));
  sent.length = 0;

  const idle: number[] = [];
  const stopIdle = loopMonitor();
  for (let pass = 0; pass < passes; pass++) {
    const started = performance.now();
    const stats = await follower.poll();
    idle.push(performance.now() - started);
    if (stats.bytesRead !== 0) throw new Error("Idle pass read bytes");
  }
  const idleLoop = stopIdle();

  const appendTimes: number[] = [];
  let appendedBytes = 0;
  let imported = 0;
  const stopAppend = loopMonitor();
  for (let pass = 0; pass < 5; pass++) {
    for (const id of nativeIds) {
      const chunk = turn(`terminal ${pass}`);
      appendedBytes += Buffer.byteLength(chunk);
      await appendFile(join(home, "session-state", id, "events.jsonl"), chunk);
    }
    const started = performance.now();
    const stats = await follower.poll();
    appendTimes.push(performance.now() - started);
    imported += stats.imported;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const appendLoop = stopAppend();
  await follower.close();

  report(`\nFollower, ${sessionCount} followed sessions (~1 MB history each)`);
  report(
    `  idle pass          p50 ${ms(percentile(idle, 0.5))}  p95 ${ms(percentile(idle, 0.95))}  (${((percentile(idle, 0.5) / sessionCount) * 1000).toFixed(1)} µs/session)`,
  );
  report(`  idle event loop    p99 ${ms(idleLoop.p99)}  max ${ms(idleLoop.max)}`);
  report(
    `  append pass        p50 ${ms(percentile(appendTimes, 0.5))}  max ${ms(Math.max(...appendTimes))}  for ${sessionCount} new turns (${mb(appendedBytes / 5)} appended/pass)`,
  );
  report(`  append event loop  p99 ${ms(appendLoop.p99)}  max ${ms(appendLoop.max)}`);
  report(`  imported           ${imported} events over 5 passes`);
}

async function benchmarkCatchUp(path: string, label: string): Promise<void> {
  const size = (await stat(path)).size;
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  let peak = heapBefore;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 5);
  const stopLoop = loopMonitor();
  const started = performance.now();
  const read = await readNativeEvents(path, { offset: 0 });
  const readMs = performance.now() - started;
  const translateStarted = performance.now();
  const imported = translateNativeEvents(read.events, "fleet-x");
  const translateMs = performance.now() - translateStarted;
  const loop = stopLoop();
  clearInterval(sampler);

  // The reader Fleet already runs from byte 0 on every start/resume today.
  const directory = join(path, "..");
  const home = join(directory, "..", "..");
  const nativeId = directory.split(/[\\/]/).at(-1)!;
  const credit = new SessionCreditReader(nativeId, home);
  const creditStarted = performance.now();
  await credit.read().catch(() => undefined);
  const creditMs = performance.now() - creditStarted;

  report(`\nCatch-up, ${label} (${mb(size)}, ${read.linesSeen} lines)`);
  report(
    `  read               ${ms(readMs)}  (${(size / 1024 / 1024 / (readMs / 1000)).toFixed(0)} MB/s), parsed ${read.linesParsed}/${read.linesSeen} lines`,
  );
  report(
    `  translate          ${ms(translateMs)}  -> ${imported.length} transcript events`,
  );
  report(`  event loop         p99 ${ms(loop.p99)}  max ${ms(loop.max)}`);
  report(`  heap growth        ${mb(peak - heapBefore)} peak over baseline`);
  report(
    `  existing reader    ${ms(creditMs)}  (SessionCreditReader, same file, from byte 0)`,
  );
}

async function benchmarkIngest(directory: string): Promise<void> {
  const store = new FleetStore(join(directory, "host.db"), { secureFiles() {} });
  const app = Fastify();
  const service = new FleetService(store, app.log);
  const { node } = store.registerNode({
    name: "bench",
    os: "win32",
    arch: "x64",
    version: "bench",
    capabilities: ["copilot-acp"],
    maxSessions: 4,
  });
  const workspace = store.createWorkspace("bench", "");
  const placement = store.createPlacement(workspace.id, node.id, directory);
  const session = store.createSession(placement, "initial", false, "bench");
  store.transitionSession(session.id, "starting");
  store.transitionSession(session.id, "idle");
  await service.transcripts.page(session.id);

  const path = join(directory, "ingest.jsonl");
  await writeFile(
    path,
    Array.from({ length: 200 }, (_, index) => turn(`t${index}`, 500)).join(""),
  );
  const events = translateNativeEvents(
    (await readNativeEvents(path, { offset: 0 })).events,
    session.id,
  );
  const measure = (label: string, batchSize: number, slice: typeof events) => {
    const timings: number[] = [];
    let wireBytes = 0;
    const stopLoop = loopMonitor();
    for (let index = 0; index < slice.length; index += batchSize) {
      const message = {
        type: "native_session_import" as const,
        importId: randomUUID(),
        sessionId: session.id,
        events: slice.slice(index, index + batchSize),
      };
      wireBytes += Buffer.byteLength(JSON.stringify(message));
      const started = performance.now();
      const result = service.importNativeSession(node.id, message);
      timings.push(performance.now() - started);
      if (result.status !== "stored") throw new Error(`Ingest failed: ${result.status}`);
    }
    const loop = stopLoop();
    const total = timings.reduce((sum, value) => sum + value, 0);
    report(`\nHost ingest, ${label}: ${slice.length} events in batches of ${batchSize}`);
    report(
      `  per batch          p50 ${ms(percentile(timings, 0.5))}  max ${ms(Math.max(...timings))}`,
    );
    report(`  throughput         ${(slice.length / (total / 1000)).toFixed(0)} events/s`);
    report(
      `  wire               ${mb(wireBytes)} total, ${(wireBytes / slice.length).toFixed(0)} B/event`,
    );
    report(`  event loop         p99 ${ms(loop.p99)}  max ${ms(loop.max)}`);
  };
  // A terminal turn as it happens: ~15 events per poll, pushed live.
  measure("live (one turn per pass)", 15, events.slice(0, 600));
  // A long terminal session caught up at once: full batches, views refetch.
  measure("backlog", 512, events.slice(600));
  service.shutdown();
  store.close();
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "fleet-native-sync-bench-"));
  const home = join(directory, "copilot-home");
  try {
    report(`Node ${process.version} on ${process.platform}; scratch ${directory}`);
    await benchmarkFollower(home);

    const syntheticId = randomUUID();
    await mkdir(join(home, "session-state", syntheticId), { recursive: true });
    const syntheticPath = join(home, "session-state", syntheticId, "events.jsonl");
    await writeLog(syntheticPath, syntheticMb * 1024 * 1024);
    await benchmarkCatchUp(syntheticPath, "synthetic log");

    if (values.real) {
      const root = join(values.real, "session-state");
      const candidates: { id: string; size: number }[] = [];
      for (const id of await readdir(root)) {
        const info = await stat(join(root, id, "events.jsonl")).catch(() => undefined);
        if (info) candidates.push({ id, size: info.size });
      }
      candidates.sort((a, b) => b.size - a.size);
      for (const { id } of candidates.slice(0, Number(values["real-count"]))) {
        // Copied so the benchmark never holds a real session's log open.
        await mkdir(join(home, "session-state", id), { recursive: true });
        const copy = join(home, "session-state", id, "events.jsonl");
        await copyFile(join(root, id, "events.jsonl"), copy);
        await benchmarkCatchUp(copy, `real log ${id.slice(0, 8)}`);
      }
    }

    await benchmarkIngest(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
