import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_CAPACITY,
  createLogBuffer,
  problemsOnly,
  type LogEntry,
} from "./log-buffer.js";

describe("createLogBuffer", () => {
  it("keeps entries newest last so a view can append", () => {
    const buffer = createLogBuffer();
    buffer.record("info", "first");
    buffer.record("error", "second");
    expect(buffer.entries().map((entry) => entry.message)).toEqual(["first", "second"]);
  });

  it("drops the oldest entries rather than growing without bound", () => {
    // The failure this guards: a node that cannot reach the Host logs every two
    // seconds, forever. An unbounded buffer turns a transport outage into a
    // memory leak on the machine that is already unhappy.
    const buffer = createLogBuffer(3);
    for (const message of ["a", "b", "c", "d", "e"]) buffer.record("warn", message);
    expect(buffer.entries().map((entry) => entry.message)).toEqual(["c", "d", "e"]);
  });

  it("truncates a single runaway line instead of letting it evict the rest", () => {
    const buffer = createLogBuffer(4);
    buffer.record("error", "x".repeat(5000));
    const [entry] = buffer.entries();
    expect(entry!.message.length).toBeLessThan(2100);
    expect(entry!.message.endsWith("…")).toBe(true);
  });

  it("hands out a copy, so a reader cannot edit the process's own history", () => {
    const buffer = createLogBuffer();
    buffer.record("info", "kept");
    buffer.entries().push({ at: "", level: "error", message: "injected" });
    expect(buffer.entries()).toHaveLength(1);
  });

  it("stamps entries so two machines' logs can be lined up", () => {
    const buffer = createLogBuffer();
    buffer.record("warn", "when");
    expect(Number.isNaN(Date.parse(buffer.entries()[0]!.at))).toBe(false);
  });

  it("clears on request", () => {
    const buffer = createLogBuffer();
    buffer.record("error", "gone");
    buffer.clear();
    expect(buffer.entries()).toEqual([]);
  });

  it("defaults to a capacity that survives a reconnect storm", () => {
    expect(DEFAULT_LOG_CAPACITY).toBeGreaterThanOrEqual(100);
  });
});

describe("problemsOnly", () => {
  it("keeps warnings and errors and drops routine chatter", () => {
    // A stuck node repeats one line every two seconds; the line that mattered
    // is the one that appeared once and has already scrolled away.
    const entries: LogEntry[] = [
      { at: "2026-08-18T00:00:00.000Z", level: "info", message: "connecting" },
      { at: "2026-08-18T00:00:01.000Z", level: "error", message: "ECONNREFUSED" },
      { at: "2026-08-18T00:00:02.000Z", level: "warn", message: "no fallback" },
    ];
    expect(problemsOnly(entries).map((entry) => entry.message)).toEqual([
      "ECONNREFUSED",
      "no fallback",
    ]);
  });
});
