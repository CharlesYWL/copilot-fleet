import console from "node:console";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { compiler, mockProcess, spawn } = vi.hoisted(() => {
  const compiler = { unref: vi.fn(), kill: vi.fn(), once: vi.fn() };
  return {
    compiler,
    spawn: vi.fn(() => compiler),
    mockProcess: { execPath: "node", argv: [], once: vi.fn(), exit: vi.fn() },
  };
});

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:process", () => ({ default: mockProcess }));
vi.mock("vitest/vitest.mjs", () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockProcess.argv = [
    "node",
    "watch-tests.mjs",
    "--project=services",
    "path with spaces/example.test.ts",
  ];
});

afterEach(() => vi.restoreAllMocks());

it("forwards native CLI arguments without shell quoting and starts the protocol watcher", async () => {
  await import("./watch-tests.mjs");
  expect(mockProcess.argv.slice(2)).toEqual([
    "--watch",
    "--clearScreen=false",
    "--project=services",
    "path with spaces/example.test.ts",
  ]);
  expect(spawn).toHaveBeenCalledWith(
    "node",
    expect.arrayContaining(["--project", "--watch", "--preserveWatchOutput"]),
    { stdio: "inherit" },
  );
  expect(compiler.unref).toHaveBeenCalledOnce();
});

it("stops the compiler when Vitest exits without restarting the exit sequence", async () => {
  await import("./watch-tests.mjs");
  mockProcess.once.mock.calls.find(([event]) => event === "exit")[1]();
  expect(compiler.kill).toHaveBeenCalledOnce();
  compiler.once.mock.calls.find(([event]) => event === "exit")[1](0);
  expect(mockProcess.exit).not.toHaveBeenCalled();
});

it("reports a compiler launch failure and stops rather than watching stale code", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("./watch-tests.mjs");
  const failure = new Error("compiler could not start");
  compiler.once.mock.calls.find(([event]) => event === "error")[1](failure);
  expect(log).toHaveBeenCalledWith(failure);
  expect(mockProcess.exit).toHaveBeenCalledWith(1);
});

it.each([1, 2, null])("propagates compiler termination (%s)", async (code) => {
  await import("./watch-tests.mjs");
  compiler.once.mock.calls.find(([event]) => event === "exit")[1](code);
  expect(mockProcess.exit).toHaveBeenCalledWith(code ?? 1);
});
