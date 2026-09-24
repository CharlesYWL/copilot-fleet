import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopProcessTree } from "./process-quiescence.js";
import { GitRunner } from "./git-runner.js";
import type { CheckoutLease } from "./checkout-locks.js";

const { execFile, spawn } = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile,
  spawn,
}));

beforeEach(() => {
  vi.useFakeTimers();
  execFile.mockReset();
  spawn.mockReset();
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

  it("rejects a Git deadline when taskkill fails without claiming quiescence", async () => {
    const child = Object.assign(runningChild(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    spawn.mockReturnValue(child);
    const error = new Error("taskkill failed");
    execFile.mockImplementation((_file, _args, _options, callback) => callback(error));
    const lease = {
      key: "checkout",
      owner: "operation",
      revalidate: vi.fn(async () => {}),
      release: vi.fn(),
      processPending: vi.fn(),
      processStarted: vi.fn(),
      processesQuiesced: vi.fn(),
      requireReconciliation: vi.fn(),
      reattach: vi.fn(),
    } satisfies CheckoutLease;
    const resolved = vi.fn();
    const rejected = vi.fn();
    void new GitRunner()
      .run(process.cwd(), ["status"], { timeoutMs: 10, lease })
      .then(resolved, rejected);

    await vi.advanceTimersByTimeAsync(10);

    expect(rejected).toHaveBeenCalledExactlyOnceWith(error);
    expect(resolved).not.toHaveBeenCalled();
    expect(lease.processPending).toHaveBeenCalledOnce();
    expect(lease.processStarted).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(lease.processesQuiesced).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.processesQuiesced).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
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
