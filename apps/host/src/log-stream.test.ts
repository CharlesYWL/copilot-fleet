import { describe, expect, it } from "vitest";
import { createLogBuffer } from "@fleet/protocol/log-buffer";
import { levelFromPino, messageFromPino, recordingLogStream } from "./log-stream.js";

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

describe("levelFromPino", () => {
  it("keeps warnings and errors and ignores routine traffic", () => {
    // The Host logs every request it serves. Keeping those would evict the one
    // line worth reading long before anyone came looking for it.
    expect(levelFromPino(30)).toBeUndefined();
    expect(levelFromPino(40)).toBe("warn");
    expect(levelFromPino(50)).toBe("error");
    expect(levelFromPino(60)).toBe("error");
  });

  it("ignores a level it cannot read rather than guessing", () => {
    expect(levelFromPino("nonsense")).toBeUndefined();
    expect(levelFromPino(undefined)).toBeUndefined();
  });
});

describe("messageFromPino", () => {
  it("appends the error's own message, which is the half that says what to do", () => {
    expect(
      messageFromPino({ msg: "Node update failed", err: { message: "ENOENT" } }),
    ).toBe("Node update failed — ENOENT");
  });

  it("does not repeat a detail the message already contains", () => {
    expect(messageFromPino({ msg: "boom: ENOENT", err: { message: "ENOENT" } })).toBe(
      "boom: ENOENT",
    );
  });

  it("marks a line with no message rather than dropping the fact it happened", () => {
    expect(messageFromPino({})).toBe("(no message)");
  });
});

describe("recordingLogStream", () => {
  it("keeps the console output byte for byte", () => {
    // This is a second reader of the log, not a replacement for the first.
    const written: string[] = [];
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: (chunk) => written.push(chunk) });
    const chunk = line({ level: 50, msg: "down" });
    stream.write(chunk);
    expect(written).toEqual([chunk]);
  });

  it("records only the lines worth keeping", () => {
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: () => {} });
    stream.write(line({ level: 30, msg: "request completed" }));
    stream.write(line({ level: 50, msg: "node gone" }));
    expect(logs.entries().map((entry) => entry.message)).toEqual(["node gone"]);
  });

  it("survives a line that is not pino's", () => {
    // A dependency writing straight to stdout must not be able to take the
    // Host's logging down with a parse error.
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: () => {} });
    expect(() => stream.write("plain text\n")).not.toThrow();
    stream.write(line({ level: 40, msg: "still working" }));
    expect(logs.entries()).toHaveLength(1);
  });

  it("handles several lines arriving in one write", () => {
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: () => {} });
    stream.write(line({ level: 40, msg: "one" }) + line({ level: 50, msg: "two" }));
    expect(logs.entries().map((entry) => entry.message)).toEqual(["one", "two"]);
  });
});
