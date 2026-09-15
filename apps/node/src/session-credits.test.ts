import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCreditReader } from "./session-credits.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const sessionId = "acp-created";
const checkpoint = (totalNanoAiu: unknown) =>
  `${JSON.stringify({
    type: "session.usage_checkpoint",
    data: { totalNanoAiu, totalPremiumRequests: 1 },
  })}\n`;

function checkpointWithCacheState(bytes: number): string {
  const prefix =
    '{"data":{"totalNanoAiu":27401400000,"promptCacheBreakState":{"model-a":{"tools":"';
  const suffix =
    '"},"model-b":{"system":"instructions"}}},"type":"session.usage_checkpoint"}';
  return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}\n`;
}

describe("SessionCreditReader", () => {
  let home: string;
  let events: string;
  let reader: SessionCreditReader;

  beforeEach(async () => {
    home = join(process.cwd(), `.session-credits-fixture-${randomUUID()}`);
    events = join(home, "session-state", sessionId, "events.jsonl");
    await fs.mkdir(dirname(events), { recursive: true });
    reader = new SessionCreditReader(sessionId, home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("converts a real native checkpoint's nano-AIU to AI credits", async () => {
    await fs.writeFile(
      events,
      `${JSON.stringify({
        type: "session.usage_checkpoint",
        data: {
          totalNanoAiu: 27401400000,
          totalPremiumRequests: 1,
          totalApiDurationMs: 31599,
        },
        id: "26f56e4c-9230-4d97-8b44-84a330bed912",
        timestamp: "2026-09-15T05:30:00.000Z",
      })}\n`,
    );
    await expect(reader.read()).resolves.toBe(27.4014);
  });

  it("distinguishes missing files/checkpoints/older fields from explicit zero", async () => {
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.writeFile(events, "");
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.appendFile(
      events,
      '{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":42}}\n' +
        '{"type":"session.usage_checkpoint"}\n' +
        '{"type":"usage_update","used":100,"size":200}\n',
    );
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.appendFile(events, checkpoint(0));
    await expect(reader.read()).resolves.toBe(0);
    await fs.appendFile(events, checkpoint(undefined));
    await expect(reader.read()).resolves.toBe(0);
  });

  it("uses the latest cumulative value, not the sum, and caches unchanged reads", async () => {
    await fs.writeFile(events, checkpoint(1e9) + checkpoint(3e9));
    await expect(reader.read()).resolves.toBe(3);
    await expect(reader.read()).resolves.toBe(3);
    await fs.appendFile(events, checkpoint(3e9));
    await expect(reader.read()).resolves.toBe(3);
    await fs.appendFile(events, checkpoint(4e9));
    await expect(reader.read()).resolves.toBe(4);
  });

  it("does not regress after unrelated or older-CLI events are appended", async () => {
    await fs.writeFile(events, checkpoint(27401400000));
    await expect(reader.read()).resolves.toBe(27.4014);
    await fs.appendFile(
      events,
      '{"type":"assistant.message","data":{"content":"1 AI Units"}}\n' +
        '{"type":"session.usage_checkpoint","data":{"totalPremiumRequests":9}}\n' +
        '{"type":"usage_update","used":1000,"size":2000}\n',
    );
    await expect(reader.read()).resolves.toBe(27.4014);
  });

  it("retains incomplete lines across polls, including split UTF-8 and CRLF", async () => {
    await fs.writeFile(events, checkpoint(1e9));
    await expect(reader.read()).resolves.toBe(1);
    const line = Buffer.from(
      '{"note":"🙂","data":{"totalNanoAiu":2000000000},"type":"session.usage_checkpoint"}\r\n',
    );
    const split = line.indexOf(Buffer.from("🙂")) + 2;
    await fs.appendFile(events, line.subarray(0, split));
    await expect(reader.read()).resolves.toBe(1);
    await expect(reader.read()).resolves.toBe(1);
    await fs.appendFile(events, line.subarray(split, line.length - 1));
    await expect(reader.read()).resolves.toBe(1);
    await fs.appendFile(events, line.subarray(-1));
    await expect(reader.read()).resolves.toBe(2);
  });

  it("handles event types split across read chunks", async () => {
    const prefix = `${" ".repeat(64 * 1024 - 20)}\n`;
    await fs.writeFile(events, prefix + checkpoint(9e9));
    await expect(reader.read()).resolves.toBe(9);
  });

  it("skips huge unrelated lines across chunks and polls without parsing payloads", async () => {
    const huge = "x".repeat(8 * 1024 * 1024);
    await fs.writeFile(
      events,
      checkpoint(1e9) +
        '{"data":{"nested":{"type":"session.usage_checkpoint"},"output":"' +
        huge,
    );
    const parse = vi.spyOn(JSON, "parse");
    const allocate = vi.spyOn(Buffer, "alloc");
    await expect(reader.read()).resolves.toBe(1);
    await fs.appendFile(
      events,
      '"},"type":"tool.execution_complete"}\n' +
        '{"type":"assistant.message","data":{"content":"\\"type\\":\\"session.usage_checkpoint\\""}}\n' +
        checkpoint(2e9),
    );
    await expect(reader.read()).resolves.toBe(2);
    expect(parse.mock.calls.map(([line]) => line)).toEqual([
      checkpoint(1e9).trim(),
      checkpoint(2e9).trim(),
    ]);
    expect(allocate.mock.calls.every(([size]) => size <= 64 * 1024)).toBe(true);
  });

  it("reads only newly appended bytes from the exact supplied session", async () => {
    const otherEvents = join(home, "session-state", "different-session", "events.jsonl");
    await fs.mkdir(dirname(otherEvents), { recursive: true });
    await fs.writeFile(otherEvents, checkpoint(99e9));
    const initial = checkpoint(1e9);
    await fs.writeFile(events, initial);
    const actualOpen = fs.open;
    const reads: Array<{ length: number; position: number }> = [];
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await actualOpen(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(async (options) => {
        reads.push({ length: options?.length ?? 0, position: Number(options?.position) });
        return read(options);
      });
      return file;
    });
    await expect(reader.read()).resolves.toBe(1);
    const initialReads = reads.length;
    await expect(reader.read()).resolves.toBe(1);
    expect(reads).toHaveLength(initialReads);
    const appended = checkpoint(2e9);
    await fs.appendFile(events, appended);
    await expect(reader.read()).resolves.toBe(2);
    expect(reads.at(-1)).toEqual({
      length: Buffer.byteLength(appended),
      position: Buffer.byteLength(initial),
    });
    expect(
      open.mock.calls.every(([path, flags]) => path === events && flags === "r"),
    ).toBe(true);
  });

  it("resets the cached value and partial line when the file is truncated", async () => {
    await fs.writeFile(events, checkpoint(9e9) + '{"type":"session.');
    await expect(reader.read()).resolves.toBe(9);
    await fs.truncate(events, 0);
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.appendFile(events, checkpoint(1e9));
    await expect(reader.read()).resolves.toBe(1);
  });

  it("resets on replacement even when the replacement is larger than the old file", async () => {
    await fs.writeFile(events, checkpoint(9e9) + '{"partial":');
    await expect(reader.read()).resolves.toBe(9);
    const replacement = join(dirname(events), "replacement.jsonl");
    await fs.writeFile(
      replacement,
      '{"type":"session.start","data":"' + "x".repeat(200) + '"}\n',
    );
    await fs.rename(events, join(dirname(events), "old-events.jsonl"));
    await fs.rename(replacement, events);
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.appendFile(events, checkpoint(2e9));
    await expect(reader.read()).resolves.toBe(2);
  });

  it("returns unknown after deletion and can read a recreated file", async () => {
    await fs.writeFile(events, checkpoint(9e9));
    await expect(reader.read()).resolves.toBe(9);
    await fs.unlink(events);
    await expect(reader.read()).resolves.toBeUndefined();
    await fs.writeFile(events, checkpoint(0));
    await expect(reader.read()).resolves.toBe(0);
  });

  it.each([null, "1000000000", -1, 1.5, true, {}, [], 9007199254740992])(
    "rejects invalid totalNanoAiu %j explicitly",
    async (value) => {
      await fs.writeFile(events, checkpoint(value));
      await expect(reader.read()).rejects.toThrow(
        /usage checkpoint: totalNanoAiu must be a non-negative safe integer/,
      );
    },
  );

  it.each(["null", "[]", '"invalid"', "7"])(
    "rejects malformed checkpoint data %s",
    async (data) => {
      await fs.writeFile(events, `{"type":"session.usage_checkpoint","data":${data}}\n`);
      await expect(reader.read()).rejects.toThrow(/data must be an object/);
    },
  );

  it("reports malformed relevant JSON without exposing transcript contents", async () => {
    await fs.writeFile(
      events,
      '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":NaN},"secret":"do-not-log"}\n' +
        checkpoint(2e9),
    );
    await expect(reader.read()).rejects.toThrow(
      "Invalid Copilot session usage checkpoint: malformed JSON",
    );
    await expect(reader.read()).resolves.toBe(2);
  });

  it.each([
    ["malformed JSON", '{"type":"session.usage_checkpoint","data": }\n'],
    ["totalNanoAiu", checkpoint("invalid")],
  ])(
    "reports %s once, retains the cache, and reads future updates",
    async (message, bad) => {
      await fs.writeFile(events, checkpoint(1e9));
      await expect(reader.read()).resolves.toBe(1);
      await fs.appendFile(events, bad);
      await expect(reader.read()).rejects.toThrow(message);
      await expect(reader.read()).resolves.toBe(1);
      await fs.appendFile(events, checkpoint(2e9));
      await expect(reader.read()).resolves.toBe(2);
    },
  );

  it("rejects overflowed numbers rather than returning infinite credits", async () => {
    await fs.writeFile(
      events,
      '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":1e400}}\n',
    );
    await expect(reader.read()).rejects.toThrow(/totalNanoAiu/);
  });

  it.each([64 * 1024 + 1, 4 * 1024 * 1024])(
    "accepts a %i-byte checkpoint containing model cache state",
    async (bytes) => {
      const line = checkpointWithCacheState(bytes);
      expect(Buffer.byteLength(line) - 1).toBe(bytes);
      await fs.writeFile(events, line);
      await expect(reader.read()).resolves.toBe(27.4014);
    },
  );

  it("rejects a checkpoint one byte over 4 MiB once, even with its type last", async () => {
    const line = checkpointWithCacheState(4 * 1024 * 1024 + 1);
    expect(Buffer.byteLength(line) - 1).toBe(4 * 1024 * 1024 + 1);
    await fs.writeFile(events, line + checkpoint(2e9));
    await expect(reader.read()).rejects.toThrow(
      /usage checkpoint: exceeds 4194304 bytes/,
    );
    await expect(reader.read()).resolves.toBe(2);
  });

  it("supports JSON-escaped top-level type tokens", async () => {
    await fs.writeFile(
      events,
      '{"ty\\u0070e":"session.usage_checkp\\u006fint","data":{"totalNanoAiu":1}}\n',
    );
    await expect(reader.read()).resolves.toBe(1e-9);
  });

  it("propagates non-ENOENT open errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(error);
    await expect(reader.read()).rejects.toBe(error);
  });

  it("closes the file and propagates read errors", async () => {
    await fs.writeFile(events, checkpoint(1e9));
    const file = await fs.open(events, "r");
    const error = Object.assign(new Error("read failed"), { code: "EIO" });
    const close = vi.spyOn(file, "close");
    vi.spyOn(file, "read").mockRejectedValueOnce(error);
    vi.spyOn(fs, "open").mockResolvedValueOnce(file);
    await expect(reader.read()).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses COPILOT_HOME and gives an explicit home precedence", async () => {
    await fs.writeFile(events, checkpoint(3e9));
    vi.stubEnv("COPILOT_HOME", home);
    await expect(new SessionCreditReader(sessionId).read()).resolves.toBe(3);
    vi.stubEnv("COPILOT_HOME", join(home, "unused"));
    await expect(new SessionCreditReader(sessionId, home).read()).resolves.toBe(3);
  });

  it("defaults an empty COPILOT_HOME to the user's .copilot without scanning it", async () => {
    vi.stubEnv("COPILOT_HOME", "");
    const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(absent);
    await expect(new SessionCreditReader(sessionId).read()).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      join(homedir(), ".copilot", "session-state", sessionId, "events.jsonl"),
      "r",
    );
  });

  it.each([
    "",
    ".",
    "..",
    "../other",
    "..\\other",
    "one/two",
    "one\\two",
    "C:\\other",
    "events:stream",
    "id\n",
    "id\0",
    "x".repeat(129),
  ])("rejects unsafe session id %j before accessing files", (id) => {
    const open = vi.spyOn(fs, "open");
    expect(() => new SessionCreditReader(id, home)).toThrow(/Invalid Copilot session id/);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["acp-created", "A_0-z", randomUUID(), "x".repeat(128)])(
    "accepts safe session id %s",
    (id) => {
      expect(() => new SessionCreditReader(id, home)).not.toThrow();
    },
  );
});
