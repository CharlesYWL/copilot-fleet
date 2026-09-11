import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import { beforeEach, expect, it, vi } from "vitest";
import { commandCheck, copilotStatus, frameRpc } from "./login-service-runner.mjs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn,
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));
let child;
beforeEach(() => {
  child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  spawn.mockReset().mockReturnValue(child);
});
it("checks gh without copying credential-bearing output", async () => {
  const result = commandCheck("gh", ["auth", "status", "--active"]);
  child.emit("close", 0);
  await expect(result).resolves.toBeUndefined();
  expect(spawn).toHaveBeenCalledWith("gh", ["auth", "status", "--active"], {
    windowsHide: true,
    stdio: "ignore",
  });
});
it("fails on rejected gh login", async () => {
  const result = commandCheck("gh", ["auth", "status"]);
  child.emit("close", 1);
  await expect(result).rejects.toThrow("sign in");
});
it("uses auth.getStatus without creating a session or sending a prompt", async () => {
  const result = copilotStatus("C:\\Tools\\copilot.exe");
  expect(child.stdin.read().toString()).toBe(
    frameRpc({ jsonrpc: "2.0", id: 1, method: "auth.getStatus", params: {} }),
  );
  child.stdout.emit(
    "data",
    Buffer.from(
      frameRpc({ id: 1, result: { isAuthenticated: true, authType: "token" } }),
    ),
  );
  await expect(result).resolves.toEqual({ authenticated: true });
  expect(child.stdin.writableEnded).toBe(true);
});
it.each([
  { isAuthenticated: false },
  { isAuthenticated: "true" },
  { isAuthenticated: true, authType: "api-key" },
  undefined,
])("rejects unusable authentication: %j", async (status) => {
  const result = copilotStatus("copilot.exe");
  child.stdout.emit("data", Buffer.from(frameRpc({ id: 1, result: status })));
  await expect(result).rejects.toThrow("not signed in");
});
it("bounds hung authentication status", async () => {
  await expect(copilotStatus("copilot.exe", false, { timeoutMs: 10 })).rejects.toThrow(
    "timed out",
  );
  expect(child.stdin.writableEnded).toBe(true);
});
it("does not mistake an early CLI exit for authentication", async () => {
  const result = copilotStatus("copilot.exe");
  child.emit("exit", 0);
  await expect(result).rejects.toThrow("before authentication status");
});
