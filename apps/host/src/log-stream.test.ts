import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogBuffer } from "@fleet/protocol/log-buffer";
import { levelFromPino, messageFromPino, recordingLogStream } from "./log-stream.js";

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("levelFromPino", () => {
  it("keeps normal runtime output as well as warnings and errors", () => {
    expect(levelFromPino(10)).toBeUndefined();
    expect(levelFromPino(20)).toBeUndefined();
    expect(levelFromPino(30)).toBe("info");
    expect(levelFromPino("30")).toBe("info");
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

  it("shows self-update stage and detail without exposing other structured fields", () => {
    expect(
      messageFromPino({
        msg: "Node self-update progress",
        stage: "building",
        detail: "Compiling the Node runtime",
        nodeId: "private-node-id",
        updateId: "private-update-id",
        claimUrl: "https://example.invalid/claim?code=private",
        req: { headers: { authorization: "private" } },
      }),
    ).toBe("Node self-update progress — building — Compiling the Node runtime");
  });

  it("only reads progress strings from the known self-update message", () => {
    expect(
      messageFromPino({
        msg: "Other runtime event",
        stage: "private",
        detail: "private",
      }),
    ).toBe("Other runtime event");
    expect(
      messageFromPino({
        msg: "Node self-update progress",
        stage: { private: "value" },
        detail: ["private"],
      }),
    ).toBe("Node self-update progress");
  });

  it("does not repeat an update failure already described by the progress detail", () => {
    expect(
      messageFromPino({
        msg: "Node self-update progress",
        stage: "failed",
        detail: "Build failed: ENOENT",
        err: { message: "ENOENT", stack: "private stack" },
      }),
    ).toBe("Node self-update progress — failed — Build failed: ENOENT");
  });

  it("marks a line with no message rather than dropping the fact it happened", () => {
    expect(messageFromPino({})).toBe("(no message)");
  });
});

describe("recordingLogStream", () => {
  it("keeps real startup claim output and request credentials out of the logs API", async () => {
    const { buildServer } = await import("./server.js");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const password = "diagnostics-test-password";
    const app = await buildServer({
      databasePath: ":memory:",
      operatorPassword: password,
      useBuiltInEntra: false,
    });
    try {
      const announcement = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      const claimCode = announcement.match(/this one-time code:\s+(\S+)/)?.[1];
      const claimUrl = announcement.match(/Claim it at (\S+)/)?.[1];
      expect(claimCode).toBeTruthy();
      expect(claimUrl).toBeTruthy();

      const health = await app.inject({
        method: "GET",
        url: `/api/health?code=${claimCode}`,
        headers: { referer: `${claimUrl}/?code=${claimCode}` },
      });
      expect(health.statusCode).toBe(200);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        payload: { code: claimCode },
      });
      expect(bootstrap.statusCode).toBe(200);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;

      app.log.info(
        { stage: "building", detail: "Compiling the Node runtime", claimCode, claimUrl },
        "Node self-update progress",
      );
      const response = await app.inject({
        method: "GET",
        url: "/api/logs",
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        "Node self-update progress — building — Compiling the Node runtime",
      );
      expect(response.body).not.toContain(claimCode);
      expect(response.body).not.toContain(claimUrl);
      expect(response.body).not.toContain(password);
      expect(response.body).not.toContain(cookie);
      expect(response.body).not.toContain("Copilot Fleet is unclaimed");
      expect(response.body).not.toContain("incoming request");
      expect(response.body).not.toContain("request completed");
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "incoming request",
      );
    } finally {
      await app.close();
    }
  });

  it("keeps the console output byte for byte", () => {
    // This is a second reader of the log, not a replacement for the first.
    const written: string[] = [];
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: (chunk) => written.push(chunk) });
    const chunk = line({ level: 50, msg: "down" });
    stream.write(chunk);
    expect(written).toEqual([chunk]);
  });

  it("keeps runtime activity but omits routine HTTP info without hiding problems", () => {
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: () => {} });
    stream.write(line({ level: 30, msg: "Host listening" }));
    stream.write(line({ level: 30, msg: "incoming request" }));
    stream.write(line({ level: 30, msg: "request completed" }));
    stream.write(line({ level: 40, msg: "request completed" }));
    stream.write(line({ level: 50, msg: "node gone", err: { message: "ECONNRESET" } }));
    expect(logs.entries()).toMatchObject([
      { level: "info", message: "Host listening" },
      { level: "warn", message: "request completed" },
      { level: "error", message: "node gone — ECONNRESET" },
    ]);
  });

  it("does not let polling traffic evict runtime output from the bounded buffer", () => {
    const logs = createLogBuffer(3);
    const stream = recordingLogStream(logs, { write: () => {} });
    for (const msg of ["old", "started", "connected", "ready"]) {
      stream.write(line({ level: 30, msg }));
    }
    for (let index = 0; index < 400; index++) {
      stream.write(
        line({ level: 30, msg: "incoming request", reqId: index }) +
          line({ level: 30, msg: "request completed", reqId: index }),
      );
    }
    expect(logs.entries().map((entry) => entry.message)).toEqual([
      "started",
      "connected",
      "ready",
    ]);
  });

  it("keeps progress details within the existing message length limit", () => {
    const logs = createLogBuffer();
    const stream = recordingLogStream(logs, { write: () => {} });
    stream.write(
      line({
        level: 30,
        msg: "Node self-update progress",
        stage: "building",
        detail: "x".repeat(5000),
      }),
    );
    expect(logs.entries()[0]).toMatchObject({
      level: "info",
      message: expect.stringContaining("Node self-update progress — building — "),
    });
    expect(logs.entries()[0]!.message).toHaveLength(2001);
    expect(logs.entries()[0]!.message.endsWith("…")).toBe(true);
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
