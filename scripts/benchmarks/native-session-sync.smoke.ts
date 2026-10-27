/**
 * Live check against the real Copilot CLI (spends one small model request).
 *
 *   npx tsx scripts/benchmarks/native-session-sync.smoke.ts
 *
 * Starts a fresh Copilot session non-interactively, follows it as Fleet would,
 * then resumes it with `copilot --resume <id> -p ...` exactly as someone in a
 * terminal would, and prints what the follower imported.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MemoryFollowerStore,
  NativeSessionFollower,
  copilotHomeDirectory,
  type ImportMessage,
} from "../../apps/node/src/native-session-sync.js";

const run = promisify(execFile);
const report = (line: string) => process.stdout.write(`${line}\n`);
const home = copilotHomeDirectory();
const cwd = await mkdtemp(join(tmpdir(), "fleet-native-smoke-"));

async function newestSession(after: number): Promise<string | undefined> {
  let best: { id: string; at: number } | undefined;
  for (const id of await readdir(join(home, "session-state"))) {
    const info = await stat(join(home, "session-state", id, "events.jsonl")).catch(
      () => undefined,
    );
    if (info && info.birthtimeMs >= after && (!best || info.birthtimeMs > best.at))
      best = { id, at: info.birthtimeMs };
  }
  return best?.id;
}

async function copilot(args: string[]): Promise<void> {
  await run("copilot", args, {
    cwd,
    shell: process.platform === "win32",
    timeout: 240_000,
    windowsHide: true,
  });
}

try {
  const started = Date.now();
  await copilot([
    "-p",
    "Reply_with_the_single_word_first",
    "--allow-all-tools",
    "--no-ask-user",
  ]);
  const nativeId = await newestSession(started - 1_000);
  if (!nativeId) throw new Error("Could not find the session Copilot just created");
  report(`native session ${nativeId}`);

  const sent: ImportMessage[] = [];
  const follower = new NativeSessionFollower({
    store: new MemoryFollowerStore(),
    fleetTurnActive: () => false,
    reserveSequences: () => undefined,
    send: (message) => {
      sent.push(message);
      queueMicrotask(() => follower.acknowledge(message.importId, "stored", 1));
      return true;
    },
  });
  // Fleet "owns" the conversation so far; following starts at the log's end.
  await follower.track("fleet-smoke", nativeId);
  follower.connect(500);
  await follower.poll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  sent.length = 0;

  // Someone resumes it in a terminal; poll while it runs to see the hold.
  const terminal = copilot([
    `--resume=${nativeId}`,
    "-p",
    "Reply_with_the_single_word_second",
    "--allow-all-tools",
    "--no-ask-user",
  ]);
  let sawHold = false;
  const watcher = setInterval(() => {
    if (follower.attachment("fleet-smoke")) sawHold = true;
  }, 100);
  await terminal;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await follower.poll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(watcher);
  await follower.close();

  const events = sent.flatMap((message) => message.events);
  report(`attachment observed while terminal ran: ${sawHold}`);
  report(`imported ${events.length} events in ${sent.length} messages:`);
  for (const event of events)
    report(
      `  ${event.type.padEnd(14)} ${JSON.stringify(event.payload.text ?? event.payload.title ?? event.payload.stopReason ?? event.payload.status ?? "").slice(0, 80)}`,
    );
  const last = sent.at(-1)?.attachment;
  report(
    `attachment after terminal exited: ${last === null ? "cleared" : JSON.stringify(last)}`,
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
