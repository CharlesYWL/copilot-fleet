import { strict as assert } from "node:assert";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { z } from "zod";
import type { SessionEvent } from "@fleet/protocol";
import {
  PAGE_SCRIPT,
  conversationName,
  endMarker as marker,
  freePort,
  prepareConversations,
  startHost,
  stopHost,
  type PageHarness,
} from "../e2e/harness.js";
import { HISTORY_FIXTURE_VERSION } from "./history-fixture.js";
import { summarize, type Measurement } from "./history-report.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const LEAD = conversationName(0);
const SMALL = conversationName(1);

const BrowserReportSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  environment: z.object({
    node: z.string(),
    platform: z.string(),
    cpu: z.string(),
    cpuCount: z.number(),
    browser: z.string(),
    hostRevision: z.string(),
    hostDirty: z.boolean(),
  }),
  fixture: z.object({
    version: z.number(),
    leadEvents: z.number(),
    sessions: z.number(),
    leadBlocks: z.number(),
  }),
  protocol: z.enum(["blocks", "events"]),
  iterations: z.number(),
  measurements: z.record(
    z.string(),
    z.object({
      samplesMs: z.array(z.number()),
      medianMs: z.number(),
      p95Ms: z.number(),
      minMs: z.number(),
      maxMs: z.number(),
    }),
  ),
  counts: z.record(z.string(), z.number()),
  notes: z.array(z.string()),
});
type BrowserReport = z.infer<typeof BrowserReportSchema>;

type Options = {
  hostRoot: string;
  events: number;
  sessions: number;
  iterations: number;
  chunks: number;
  output: string;
  baseline?: string;
  channel: string;
  help: boolean;
};

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      "host-root": { type: "string", default: repoRoot },
      events: { type: "string", default: "112000" },
      sessions: { type: "string", default: "26" },
      iterations: { type: "string", default: "10" },
      chunks: { type: "string", default: "200" },
      output: { type: "string", default: "dist/benchmarks/browser.json" },
      baseline: { type: "string" },
      channel: { type: "string", default: "msedge" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const integer = (name: string, raw: string, min: number, max: number) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < min || value > max)
      throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  return {
    hostRoot: resolve(values["host-root"]),
    events: integer("events", values.events, 200, 2_000_000),
    sessions: integer("sessions", values.sessions, 2, 100),
    iterations: integer("iterations", values.iterations, 1, 100),
    chunks: integer("chunks", values.chunks, 10, 5_000),
    output: values.output,
    ...(values.baseline ? { baseline: values.baseline } : {}),
    channel: values.channel,
    help: values.help,
  };
}

async function open(page: Page, name: string, needle: string): Promise<number> {
  const painted = page.evaluate(
    ([text, timeout]) =>
      (window as unknown as { __harness: PageHarness }).__harness.untilPainted(
        text as string,
        timeout as number,
      ),
    [needle, 180_000] as const,
  );
  await page.locator(`button[title="${name}"]`).first().click();
  return painted;
}

/**
 * Streams chunks into the open lead transcript through the app's own socket,
 * as the Host would send them, while typing into the composer.
 */
async function stream(
  page: Page,
  options: Options,
  protocol: "blocks" | "events",
  leadId: string,
  nextSequence: number,
): Promise<Record<string, number[]>> {
  const page0 =
    protocol === "blocks"
      ? ((await page.evaluate(
          async (id) =>
            (await fetch(`/api/sessions/${id}/transcript?limit=1`)).json() as Promise<{
              generation: string;
              revision: number;
              total: number;
            }>,
          leadId,
        )) as { generation: string; revision: number; total: number })
      : undefined;
  const messages = Array.from({ length: options.chunks }, (_, offset) => {
    const last = offset === options.chunks - 1;
    const text = last ? " STREAM-END" : ` chunk-${offset}`;
    const event: SessionEvent = {
      eventId: `bench-stream-${offset}`,
      sessionId: leadId,
      sequence: nextSequence + offset,
      type: "agent_text",
      payload: { text },
      createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, offset)).toISOString(),
    };
    return JSON.stringify({
      type: "event",
      event,
      ...(page0
        ? {
            transcript: {
              generation: page0.generation,
              revision: page0.revision + offset + 1,
              change: { index: page0.total - 1, append: text },
            },
          }
        : {}),
    });
  });
  // A Host with no Node marks every session offline; tell the page this one is
  // idle, as a connected Node would, so its composer accepts typing.
  await page.evaluate(async (id) => {
    const sessions = (await (await fetch("/api/sessions")).json()) as { id: string }[];
    const session = sessions.find((item) => item.id === id);
    const socket = (
      window as unknown as { __harness: PageHarness }
    ).__harness.sockets.find((item) => item.readyState === 1);
    if (!session || !socket?.onmessage) throw new Error("Cannot mark the session idle");
    socket.onmessage(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "session", session: { ...session, state: "idle" } }),
      }),
    );
  }, leadId);
  const composer = page.getByRole("textbox", { name: "Follow-up prompt" });
  await composer.click();
  const result = page.evaluate(async (frames: string[]) => {
    const bench = (window as unknown as { __harness: PageHarness }).__harness;
    const socket = bench.sockets.find(
      (item) => item.url.endsWith("/ws/browser") && item.readyState === 1,
    );
    if (!socket?.onmessage) throw new Error("No open browser socket");
    const keys: number[] = [];
    const frameGaps: number[] = [];
    let longTasks = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks += entry.duration;
    });
    observer.observe({ type: "longtask", buffered: false });
    const onKey = (event: KeyboardEvent) => {
      const stamp = event.timeStamp;
      requestAnimationFrame(() =>
        setTimeout(() => keys.push(performance.now() - stamp), 0),
      );
    };
    window.addEventListener("keydown", onKey, true);
    // rAF timestamps mark the frame's start, which can precede a performance.now()
    // taken just before requesting it, so measure only between frames.
    let previous: number | undefined;
    let framing = true;
    const frame = (now: number) => {
      if (previous !== undefined) frameGaps.push(now - previous);
      previous = now;
      if (framing) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const painted = bench.untilPainted("STREAM-END", 120_000);
    const started = performance.now();
    let sentAt = 0;
    for (const [offset, data] of frames.entries()) {
      // About fifty events a second, the pace of a streaming answer.
      const due = started + offset * 20;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (offset === frames.length - 1) sentAt = performance.now();
      socket.onmessage!(new MessageEvent("message", { data }));
    }
    await painted;
    const lastChunkToPaint = performance.now() - sentAt;
    framing = false;
    window.removeEventListener("keydown", onKey, true);
    observer.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      keys,
      frameGaps,
      longTasks: [longTasks],
      lastChunkToPaint: [lastChunkToPaint],
    };
  }, messages);
  // Typing while the answer streams in, at a brisk human pace.
  await composer.pressSequentially("typing while the answer streams in", { delay: 60 });
  return result;
}

async function domCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const gc = (window as unknown as { gc?: () => void }).gc;
    gc?.();
    const region = document.querySelector('[aria-label="Chat transcript"]');
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } })
      .memory;
    return {
      domElements: document.getElementsByTagName("*").length,
      transcriptElements: region ? region.getElementsByTagName("*").length : 0,
      jsHeapMiB: memory
        ? Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10
        : -1,
    };
  });
}

function revision(root: string): { hostRevision: string; hostDirty: boolean } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    hostRevision: git("rev-parse", "HEAD"),
    hostDirty: git("status", "--porcelain").length > 0,
  };
}

export async function runBrowserBenchmark(options: Options): Promise<BrowserReport> {
  const directory = mkdtempSync(join(tmpdir(), "fleet-browser-benchmark-"));
  let host: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const databasePath = join(directory, "fleet.db");
    const prepared = prepareConversations(databasePath, options);
    const started = await startHost(options.hostRoot, databasePath, await freePort());
    host = started.child;
    // Probe a short session so the long one's Host projection stays cold.
    const probe = await fetch(
      `${started.url}/api/sessions/${prepared.ids[1]}/transcript?limit=1`,
    );
    const protocol =
      probe.ok && "generation" in ((await probe.json()) as object) ? "blocks" : "events";
    browser = await chromium.launch({
      channel: options.channel,
      headless: true,
      args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(PAGE_SCRIPT);
    await page.goto(started.url);
    await page.locator(`button[title="${SMALL}"]`).first().waitFor({ timeout: 120_000 });
    // The page opens on the first listed session, seeded to be a short one, so
    // the long one's first open below is a cold one.
    await page
      .getByText(marker(1), { exact: true })
      .first()
      .waitFor({ timeout: 120_000 })
      .catch(async (error: unknown) => {
        const failure = resolve("dist/benchmarks/browser-failure.png");
        mkdirSync(dirname(failure), { recursive: true });
        await page.screenshot({ path: failure, fullPage: true });
        const region = await page
          .locator('[aria-label="Chat transcript"]')
          .first()
          .innerText()
          .catch(() => "(no transcript region)");
        throw new Error(
          `Initial session did not render; see ${failure}\n${region.slice(-500)}`,
          {
            cause: error,
          },
        );
      });
    if ((await page.getByText(marker(0), { exact: true }).count()) > 0) {
      throw new Error("The long session was opened before it could be measured");
    }
    await delay(1_000);

    const samples: Record<string, number[]> = {
      "browser.open.lead.cold": [],
      "browser.open.lead": [],
      "browser.open.small": [],
    };
    samples["browser.open.lead.cold"]!.push(await open(page, LEAD, marker(0)));
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      samples["browser.open.small"]!.push(await open(page, SMALL, marker(1)));
      samples["browser.open.lead"]!.push(await open(page, LEAD, marker(0)));
    }
    await delay(500);
    const counts = await domCounts(page);
    const streaming = await stream(
      page,
      options,
      protocol,
      prepared.ids[0]!,
      prepared.nextSequence.get(prepared.ids[0]!)!,
    );
    const measurements: Record<string, Measurement> = {};
    for (const [name, values] of Object.entries(samples))
      measurements[name] = summarize(values);
    measurements["browser.stream.keyToPaint"] = summarize(
      streaming.keys!.length ? streaming.keys! : [0],
    );
    measurements["browser.stream.frameGap"] = summarize(streaming.frameGaps!);
    measurements["browser.stream.longTaskTotal"] = summarize(streaming.longTasks!);
    measurements["browser.stream.lastChunkToPaint"] = summarize(
      streaming.lastChunkToPaint!,
    );
    const processors = cpus();
    return BrowserReportSchema.parse({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        cpu: processors[0]?.model.trim() ?? "unknown",
        cpuCount: processors.length,
        browser: `${options.channel} ${browser.version()}`,
        ...revision(options.hostRoot),
      },
      fixture: {
        version: HISTORY_FIXTURE_VERSION,
        leadEvents: prepared.leadEvents,
        sessions: options.sessions,
        leadBlocks: prepared.leadBlocks,
      },
      protocol,
      iterations: options.iterations,
      measurements,
      counts,
      notes: [
        "Synthetic data in a disposable Host built from host-root; headless browser at 1440x900.",
        "open.* is click to the session's newest line painted (MutationObserver, then a frame).",
        "open.lead.cold is the first open after the Host started; later opens follow it.",
        "stream.* injects Host-shaped messages through the app's socket at 50 per second while typing.",
        "keyToPaint is keydown to the frame after it; frameGap is time between animation frames.",
        "longTaskTotal sums main-thread tasks over 50 ms during streaming; counts are measured after GC.",
      ],
    });
  } finally {
    await browser?.close().catch(() => {});
    if (host) await stopHost(host);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function compare(current: BrowserReport, baseline: BrowserReport): string[] {
  assert.equal(
    current.fixture.leadEvents,
    baseline.fixture.leadEvents,
    "Different fixture",
  );
  assert.equal(current.fixture.sessions, baseline.fixture.sessions, "Different fixture");
  const lines = Object.entries(current.measurements).map(([name, value]) => {
    const before = baseline.measurements[name];
    if (!before) return `${name}: new measurement`;
    return `${name}: median ${before.medianMs.toFixed(1)} -> ${value.medianMs.toFixed(1)} ms, P95 ${before.p95Ms.toFixed(1)} -> ${value.p95Ms.toFixed(1)} ms`;
  });
  for (const [name, value] of Object.entries(current.counts)) {
    lines.push(`${name}: ${baseline.counts[name] ?? "n/a"} -> ${value}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npm run benchmark:browser -- [--host-root <checkout with npm run build done>]\n" +
        "  [--events 112000] [--sessions 26] [--iterations 10] [--chunks 200]\n" +
        "  [--channel msedge|chrome] [--output dist/benchmarks/browser.json] [--baseline <report>]\n",
    );
    return;
  }
  const baseline = options.baseline
    ? BrowserReportSchema.parse(JSON.parse(readFileSync(options.baseline, "utf8")))
    : undefined;
  process.stdout.write(
    `Browser benchmark: ${options.events.toLocaleString()} lead events, Host from ${options.hostRoot}\n`,
  );
  const report = await runBrowserBenchmark(options);
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `Protocol: ${report.protocol}\n` +
      Object.entries(report.measurements)
        .map(
          ([name, value]) =>
            `${name.padEnd(34)} median ${value.medianMs.toFixed(1).padStart(9)} ms | P95 ${value.p95Ms.toFixed(1).padStart(9)} ms`,
        )
        .join("\n") +
      `\n${Object.entries(report.counts)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")}\n` +
      (baseline
        ? `\nComparison with ${options.baseline}:\n${compare(report, baseline).join("\n")}\n`
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
