import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileFollowerStore,
  MemoryFollowerStore,
  NativeSessionFollower,
  lineType,
  readNativeEvents,
  translateNativeEvents,
  type ImportMessage,
  type NativeEvent,
} from "./native-session-sync.js";

const nativeId = "11111111-2222-3333-4444-555555555555";
const fleetId = "fleet-session-1";

let counter = 0;
const line = (type: string, data: Record<string, unknown>, id = `n${++counter}`) =>
  `${JSON.stringify({ type, data, id, timestamp: "2026-10-26T20:00:00.000Z", parentId: null })}\n`;

const userTurn = (text: string) =>
  line("user.message", { content: text, interactionId: "i" }) +
  line("assistant.turn_start", { turnId: "0" }) +
  line("hook.start", { hookType: "x" }) +
  line("hook.end", { hookType: "x" }) +
  line("assistant.message", { content: `answer to ${text}`, toolRequests: [] }) +
  line("assistant.turn_end", { turnId: "0" });

describe("native session log reading", () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = join(process.cwd(), `.native-sync-fixture-${randomUUID()}`);
    path = join(home, "session-state", nativeId, "events.jsonl");
    await mkdir(join(home, "session-state", nativeId), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads a line's type without parsing it", () => {
    expect(lineType('{"type":"user.message","data":{}}')).toBe("user.message");
    expect(lineType('{"data":{},"type":"user.message"}')).toBeUndefined();
  });

  it("reads only appended, complete lines and skips unimported types", async () => {
    await writeFile(path, userTurn("first"));
    const first = await readNativeEvents(path, { offset: 0 });
    expect(first.events.map((event) => event.type)).toEqual([
      "user.message",
      "assistant.message",
      "assistant.turn_end",
    ]);
    expect(first.linesSeen).toBe(6);
    expect(first.linesParsed).toBe(3);

    // A half-written line is left for the next pass.
    const partial = line("user.message", { content: "second" });
    await appendFile(path, partial.slice(0, 20));
    const second = await readNativeEvents(path, first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor.offset).toBe(first.cursor.offset);

    await appendFile(path, partial.slice(20));
    const third = await readNativeEvents(path, second.cursor);
    expect(third.events.map((event) => event.data.content)).toEqual(["second"]);
    expect(third.bytesRead).toBe(Buffer.byteLength(partial));
  });

  it("restarts from the beginning when the log is replaced", async () => {
    await writeFile(path, userTurn("old"));
    const first = await readNativeEvents(path, { offset: 0 });
    await rm(path);
    await writeFile(path, userTurn("new"));
    const second = await readNativeEvents(path, first.cursor);
    expect(second.events[0]?.data.content).toBe("new");
  });

  it("translates turns into transcript events with stable ids", () => {
    const events: NativeEvent[] = [
      {
        id: "u",
        type: "user.message",
        timestamp: "2026-10-26T20:00:00Z",
        data: { content: "hi" },
        end: 1,
      },
      {
        id: "s",
        type: "user.message",
        timestamp: "2026-10-26T20:00:00Z",
        data: { content: "x", source: "agent-1" },
        end: 2,
      },
      {
        id: "a",
        type: "assistant.message",
        timestamp: "2026-10-26T20:00:01Z",
        data: { content: "hello", reasoningText: "think" },
        end: 3,
      },
      {
        id: "t",
        type: "tool.execution_start",
        timestamp: "2026-10-26T20:00:02Z",
        data: {
          toolCallId: "c1",
          toolName: "powershell",
          arguments: { command: "npm test" },
        },
        end: 4,
      },
      {
        id: "d",
        type: "tool.execution_complete",
        timestamp: "2026-10-26T20:00:03Z",
        data: { toolCallId: "c1", success: false, error: { message: "boom" } },
        end: 5,
      },
      {
        id: "e",
        type: "assistant.turn_end",
        timestamp: "2026-10-26T20:00:04Z",
        data: {},
        end: 6,
      },
    ];
    const imported = translateNativeEvents(events, fleetId);
    expect(imported.map((event) => [event.type, event.eventId])).toEqual([
      ["system", `native:${fleetId}:u`],
      ["agent_thought", `native:${fleetId}:a:thought`],
      ["agent_text", `native:${fleetId}:a:text`],
      ["tool", `native:${fleetId}:t`],
      ["tool", `native:${fleetId}:d`],
      ["turn_complete", `native:${fleetId}:e`],
    ]);
    expect(imported[0]!.payload.text).toBe("User: hi");
    expect(imported[3]!.payload).toMatchObject({
      toolCallId: "native:c1",
      title: "powershell",
      status: "in_progress",
      detail: "npm test",
    });
    expect(imported[4]!.payload).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("NativeSessionFollower", () => {
  let home: string;
  let directory: string;
  let path: string;
  let sent: ImportMessage[];
  let fleetTurn: boolean;
  let follower: NativeSessionFollower;
  const terminalPid = 424242;
  const fleetPid = 313131;
  let live: Set<number>;

  const lock = (pid: number) =>
    writeFile(join(directory, `inuse.${pid}.lock`), String(pid));
  const unlock = (pid: number) =>
    rm(join(directory, `inuse.${pid}.lock`), { force: true });
  const ackAll = () => {
    for (const message of sent.splice(0))
      follower.acknowledge(message.importId, "stored", 100);
  };
  /** Connects and settles the one restatement every connection begins with. */
  const connect = async () => {
    follower.connect(60_000);
    // connect() starts a pass; wait for it, then for anything it queued.
    await follower.poll();
    await follower.poll();
    expect(sent.every((message) => message.events.length === 0)).toBe(true);
    ackAll();
  };

  beforeEach(async () => {
    home = join(process.cwd(), `.native-follower-fixture-${randomUUID()}`);
    directory = join(home, "session-state", nativeId);
    path = join(directory, "events.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(path, userTurn("from fleet"));
    sent = [];
    fleetTurn = false;
    live = new Set([fleetPid, terminalPid]);
    follower = new NativeSessionFollower({
      copilotHome: home,
      store: new MemoryFollowerStore(),
      fleetTurnActive: () => fleetTurn,
      reserveSequences: () => undefined,
      send: (message) => {
        sent.push(message);
        return true;
      },
      alive: (pid) => live.has(pid),
      // Every holder started long before its lock was written.
      startTimes: async (pids) => new Map(pids.map((pid) => [pid, 0])),
    });
  });

  afterEach(async () => {
    await follower.close();
    await rm(home, { recursive: true, force: true });
  });

  it("starts at the end of an existing log and imports only later outside turns", async () => {
    await lock(fleetPid);
    await follower.track(fleetId, nativeId);
    await connect();
    await follower.poll();
    expect(sent).toEqual([]);

    // Fleet's process exits; a terminal resumes and works.
    await unlock(fleetPid);
    await lock(terminalPid);
    await appendFile(path, userTurn("from terminal"));
    await follower.poll();
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message!.events.map((event) => event.type)).toEqual([
      "system",
      "agent_text",
      "turn_complete",
    ]);
    expect(message!.events[0]!.payload.text).toBe("User: from terminal");
    expect(message!.attachment).toMatchObject({ pids: [terminalPid], active: true });
    ackAll();

    // Nothing new: one stat, nothing sent.
    const quiet = await follower.poll();
    expect(sent).toEqual([]);
    expect(quiet.bytesRead).toBe(0);

    // The terminal exits; the attachment clears.
    await unlock(terminalPid);
    live.delete(terminalPid);
    await follower.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toEqual([]);
    expect(sent[0]!.attachment).toBeNull();
  });

  it("does not import lines written during a Fleet-owned turn", async () => {
    await follower.track(fleetId, nativeId);
    await connect();
    fleetTurn = true;
    await appendFile(path, userTurn("fleet prompt"));
    await follower.poll();
    expect(sent).toEqual([]);

    // Lines Copilot flushes just after Fleet saw the turn end are still Fleet's.
    fleetTurn = false;
    await appendFile(path, line("assistant.message", { content: "late flush" }));
    await follower.fleetTurnEnded(fleetId);
    await follower.poll();
    expect(sent).toEqual([]);
  });

  it("re-sends an import whose acknowledgement was lost", async () => {
    await follower.track(fleetId, nativeId);
    await connect();
    await appendFile(path, userTurn("terminal"));
    await follower.poll();
    expect(sent).toHaveLength(1);
    const firstIds = sent[0]!.events.map((event) => event.eventId);

    // Connection drops before the ack; reconnect reads the same bytes again.
    sent.length = 0;
    follower.disconnect();
    follower.connect(60_000);
    await follower.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((event) => event.eventId)).toEqual(firstIds);
  });

  it("ignores a lock whose pid was reused by a process started after it", async () => {
    follower = new NativeSessionFollower({
      copilotHome: home,
      store: new MemoryFollowerStore(),
      fleetTurnActive: () => false,
      reserveSequences: () => undefined,
      send: (message) => {
        sent.push(message);
        return true;
      },
      alive: () => true,
      startTimes: async (pids) => new Map(pids.map((pid) => [pid, Date.now() + 60_000])),
    });
    await follower.track(fleetId, nativeId);
    await lock(terminalPid);
    await connect();
    await appendFile(path, userTurn("x"));
    await follower.poll();
    expect(sent[0]!.attachment).toBeNull();
  });

  it("treats a lock that appears while Fleet is launching as Fleet's own", async () => {
    await follower.track(fleetId, nativeId);
    await connect();
    // A resume: the new Copilot process locks the session before Fleet learns
    // its pid, and writes its startup lines.
    follower.claim(fleetId);
    await lock(terminalPid);
    await appendFile(path, line("session.resume", { resumeTime: "now" }));
    await follower.poll();
    expect(sent.every((message) => !message.attachment)).toBe(true);
    // Once tracked, the holder stays Fleet's after the claim window closes.
    await follower.track(fleetId, nativeId);
    await appendFile(path, line("hook.start", {}));
    await follower.poll();
    expect(sent.every((message) => !message.attachment)).toBe(true);
  });

  it("catches up and reports the Host's sequence before a resume", async () => {
    await follower.track(fleetId, nativeId);
    await connect();
    await appendFile(path, userTurn("terminal"));
    const caught = follower.catchUp(fleetId);
    // Acknowledge as soon as the import leaves.
    await new Promise<void>((resolve) => {
      const check = () => (sent.length ? resolve() : setTimeout(check, 1));
      check();
    });
    follower.acknowledge(sent[0]!.importId, "stored", 157);
    await expect(caught).resolves.toEqual({ throughSequence: 157, externalPids: [] });
    expect((await stat(path)).size).toBeGreaterThan(0);
  });

  it("reports a terminal that attached since the last pass when catching up", async () => {
    await follower.track(fleetId, nativeId);
    await connect();
    // Attaches between passes: no poll has seen it, so the Host does not know.
    await lock(terminalPid);
    const acknowledging = setInterval(ackAll, 1);
    try {
      await expect(follower.catchUp(fleetId)).resolves.toMatchObject({
        externalPids: [terminalPid],
      });
    } finally {
      clearInterval(acknowledging);
    }
  });

  it("does not trust a remembered Fleet pid when catching up for a resume", async () => {
    await lock(fleetPid);
    await follower.track(fleetId, nativeId);
    await connect();
    // Fleet's process is gone, but its pid is alive again: reused, or still
    // exiting. Either way a resume must not start beside it.
    await expect(follower.catchUp(fleetId)).resolves.toMatchObject({
      externalPids: [fleetPid],
    });
  });

  it("crosses a line longer than one pass's byte budget", async () => {
    follower = new NativeSessionFollower({
      copilotHome: home,
      store: new MemoryFollowerStore(),
      fleetTurnActive: () => false,
      reserveSequences: () => undefined,
      send: (message) => {
        sent.push(message);
        return true;
      },
      alive: () => false,
      maxBytesPerPass: 64 * 1024,
    });
    await follower.track(fleetId, nativeId);
    await connect();
    // 9 MiB: over the line limit and over a hundred passes' budget.
    const huge = `${JSON.stringify({ type: "tool.execution_complete", data: { blob: "x".repeat(9 * 1024 * 1024) }, id: "huge", timestamp: "2026-10-26T20:00:00.000Z" })}\n`;
    await appendFile(path, huge + userTurn("after the big one"));
    for (let pass = 0; pass < 200 && sent.length === 0; pass++) await follower.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events[0]!.payload.text).toBe("User: after the big one");
  });

  it("keeps the Fleet-owned boundary across a restart", async () => {
    const directoryStore = join(home, "state", "follower.json");
    const open = () => {
      const created = new NativeSessionFollower({
        copilotHome: home,
        store: new FileFollowerStore(directoryStore, 0),
        fleetTurnActive: () => false,
        reserveSequences: () => undefined,
        send: (message) => {
          sent.push(message);
          return true;
        },
        alive: () => false,
      });
      return created;
    };
    follower = open();
    await follower.track(fleetId, nativeId);
    await connect();
    // A Fleet turn is written and ends; the Node stops before the next pass.
    await appendFile(path, userTurn("fleet prompt"));
    await follower.fleetTurnEnded(fleetId);
    await follower.close();

    follower = open();
    await follower.load();
    follower.connect(60_000);
    await follower.poll();
    await follower.poll();
    expect(sent.flatMap((message) => message.events)).toEqual([]);
  });

  it("reads past an oversized line within a single read", async () => {
    const huge = `${JSON.stringify({ type: "user.message", data: { content: "y".repeat(9 * 1024 * 1024) }, id: "big", timestamp: "2026-10-26T20:00:00.000Z" })}\n`;
    await writeFile(path, huge + userTurn("next"));
    const read = await readNativeEvents(path, { offset: 0 });
    // The oversized prompt is skipped whole; the next turn's prompt is read.
    expect(
      read.events
        .filter((event) => event.type === "user.message")
        .map((event) => event.data.content),
    ).toEqual(["next"]);
    expect(read.cursor.discarding).toBeUndefined();
  });
});
