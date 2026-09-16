import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopProcessTree } from "./process-quiescence.js";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile,
}));

beforeEach(() => {
  vi.useFakeTimers();
  execFile.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runningChild() {
  return Object.assign(new ChildProcess(), { pid: 123_456 });
}

describe.skipIf(process.platform !== "win32")("unmanaged Windows process cleanup", () => {
  it("propagates taskkill failure without leaving a rejecting timer or listeners", async () => {
    const child = runningChild();
    const otherClose = vi.fn();
    const otherError = vi.fn();
    child.on("close", otherClose);
    child.on("error", otherError);
    const error = new Error("taskkill failed");
    execFile.mockImplementation((_file, _args, _options, callback) => callback(error));

    await expect(stopProcessTree(child)).rejects.toBe(error);

    expect(vi.getTimerCount()).toBe(0);
    expect(child.listeners("close")).toEqual([otherClose]);
    expect(child.listeners("error")).toEqual([otherError]);
    await vi.advanceTimersByTimeAsync(15_000);
  });

  it.each([null, new Error("late taskkill failure")])(
    "handles the exit deadline while taskkill is still pending: %s",
    async (killError) => {
      const child = runningChild();
      let finishKill!: (error: Error | null) => void;
      execFile.mockImplementation((_file, _args, _options, callback) => {
        finishKill = callback;
      });
      let failure: unknown;
      const stopped = stopProcessTree(child).catch((error: unknown) => {
        failure = error;
      });

      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(failure).toEqual(
          new Error("Process exit could not be verified; checkout remains locked."),
        );
        expect(child.listenerCount("close")).toBe(0);
        expect(child.listenerCount("error")).toBe(0);
      } finally {
        finishKill(killError);
        await stopped;
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("waits for close after taskkill succeeds and removes only its own listeners", async () => {
    const child = runningChild();
    const otherClose = vi.fn();
    child.on("close", otherClose);
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
    const stopped = stopProcessTree(child);
    child.emit("close", 1, null);

    await expect(stopped).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listeners("close")).toEqual([otherClose]);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("does not treat a child error as proof of termination", async () => {
    const child = runningChild();
    const error = new Error("process termination could not be requested");
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
    const stopped = stopProcessTree(child);
    const rejected = expect(stopped).rejects.toBe(error);
    child.emit("error", error);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("does not terminate an already exited child", async () => {
    const child = runningChild();
    Object.defineProperty(child, "exitCode", { value: 0 });

    await expect(stopProcessTree(child)).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("unmanaged POSIX process cleanup", () => {
  it("cleans up the exit wait when signaling the process group fails", async () => {
    const child = runningChild();
    const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });

    await expect(stopProcessTree(child)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });
});
