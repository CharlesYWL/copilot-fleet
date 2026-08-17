import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { connectDevTunnel } from "./devtunnel.js";

/** A stand-in for the CLI child so no test spawns a real tunnel. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  return child;
}

const spawnFake = (child: ReturnType<typeof fakeChild>) =>
  vi.fn(() => child) as unknown as Parameters<
    typeof connectDevTunnel
  >[1] extends never
    ? never
    : never;

describe("connectDevTunnel", () => {
  it("reads the forwarded port back rather than assuming the host's", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
      log: () => {},
    });
    // The CLI falls back to another port when the first is taken; a node that
    // assumed 8790 here would dial nothing.
    child.stdout.emit(
      "data",
      Buffer.from("SSH: Forwarding from 127.0.0.1:8791 to host port 8790.\n"),
    );
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:8791" });
  });

  it("survives the line arriving split across chunks", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.stdout.emit("data", Buffer.from("SSH: Forwarding from 127.0.0"));
    child.stdout.emit("data", Buffer.from(".1:9001 to host port 8790.\n"));
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:9001" });
  });

  it("explains a signed-out CLI instead of hanging until the timeout", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/devtunnel user login/);
  });

  it("names the install step when the binary is missing", async () => {
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
    });
    child.emit("error", new Error("spawn devtunnel ENOENT"));
    await expect(pending).rejects.toThrow(/winget install Microsoft.devtunnel/);
  });

  it("gives up rather than leaving a node stuck behind a silent tunnel", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = connectDevTunnel("fleet-abc", {
      spawnProcess: (() => child) as any,
      timeoutMs: 1_000,
    });
    const assertion = expect(pending).rejects.toThrow(/did not report a forwarded port/);
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

export { spawnFake };
