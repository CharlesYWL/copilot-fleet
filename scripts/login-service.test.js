import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIdleNode,
  captureEnvironment,
  loginDirectory,
  parseOptions,
  taskName,
  validateManifest,
} from "./login-service.mjs";
import { frameRpc, rpcReader } from "./login-service-runner.mjs";

const sid = "S-1-5-21-1-2-3-1001";
const fixture = () => ({
  schemaVersion: 1,
  kind: "node",
  taskName: taskName("node", sid),
  accountSid: sid,
  repositoryPath: "Q:\\Repos\\Fleet",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  runnerPath: "C:\\Users\\Me\\login\\login-service-runner.mjs",
  controllerPath: "C:\\Users\\Me\\login\\windows-login-task.ps1",
  logPath: "C:\\Users\\Me\\login\\runtime.log",
  statePath: "C:\\Users\\Me\\login\\runtime.json",
  environment: { APPDATA: "C:\\Users\\Me\\AppData\\Roaming" },
  runtimeArgs: ["--devtunnel=my-tunnel", "--config-port=9899"],
});

describe("login-start CLI", () => {
  it.each(["node", "host+node"])("supports %s with an existing identity", (kind) => {
    expect(parseOptions([kind, "install", "--existing-node"])).toMatchObject({
      kind,
      action: "install",
      existingNode: true,
      build: true,
      start: true,
    });
  });
  it("accepts login and durable nonsecret runtime flags", () => {
    expect(
      parseOptions([
        "node",
        "install",
        "--start-mode",
        "login",
        "--no-build",
        "--no-start",
        "--devtunnel",
        "tunnel-1",
        "--config-port=9877",
      ]),
    ).toMatchObject({
      build: false,
      start: false,
      nodeArgs: ["--devtunnel", "tunnel-1", "--config-port=9877"],
    });
  });
  it.each([
    ["node", "install", "--credential-file", "secrets.env"],
    ["node", "install", "--start-mode", "boot"],
    ["host", "install", "--devtunnel=tunnel-1"],
    ["node", "stop", "--no-start"],
  ])("rejects unsupported or dangerous options: %j", (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });
  it("accepts regular enrollment and settings flags through the node shorthand", () => {
    const options = parseOptions([
      "node",
      "--url=https://fleet.example.com",
      "--host-id=host-1",
      "--host-fingerprint=abc",
      "--enrollment-grant=one-time",
      "--name",
      "worker",
      "--devtunnel=tunnel-1",
    ]);
    expect(options.action).toBe("install");
    expect(options.nodeArgs).toEqual([
      "--url=https://fleet.example.com",
      "--host-id=host-1",
      "--host-fingerprint=abc",
      "--enrollment-grant=one-time",
      "--name",
      "worker",
      "--devtunnel=tunnel-1",
    ]);
    expect(options).not.toHaveProperty("runtimeArgs");
  });
  it("prints help without Windows or installed metadata", () => {
    const output = execFileSync(
      process.execPath,
      [resolve("scripts/login-service-cli.mjs"), "node", "--help"],
      { encoding: "utf8" },
    );
    expect(output).toContain("not signed-out boot");
    expect(output).toContain("host+node install");
  });
});

describe("manifest and profile", () => {
  it("retains profile settings without exporting credentials", () => {
    expect(
      captureEnvironment({
        APPDATA: "C:\\Users\\Me\\Roaming",
        COPILOT_HOME: "C:\\Users\\Me\\.copilot",
        PATH: "C:\\Tools",
        GH_TOKEN: "private",
        GITHUB_TOKEN: "private",
        COPILOT_GITHUB_TOKEN: "private",
        ARBITRARY_SECRET: "private",
        FLEET_ENROLLMENT_GRANT: "private",
      }),
    ).toEqual({
      APPDATA: "C:\\Users\\Me\\Roaming",
      COPILOT_HOME: "C:\\Users\\Me\\.copilot",
      PATH: "C:\\Tools",
    });
  });
  it("handles Path casing and separates workloads and users", () => {
    expect(captureEnvironment({ Path: "C:\\Tools" })).toEqual({ PATH: "C:\\Tools" });
    expect(loginDirectory("host", { LOCALAPPDATA: "C:\\Users\\Me\\Local" })).toBe(
      "C:\\Users\\Me\\Local\\CopilotFleet\\login\\host",
    );
    expect(taskName("node", sid)).not.toBe(taskName("host", sid));
    expect(taskName("node", sid)).not.toBe(taskName("node", `${sid}1`));
  });
  it("accepts a same-user manifest", () => {
    expect(validateManifest(fixture(), sid)).toEqual(fixture());
  });
  it.each([
    { accountSid: "S-1-5-19" },
    { taskName: "CopilotFleetNode" },
    { repositoryPath: "Q:relative" },
    { repositoryPath: "\\current-drive-relative" },
    { environment: { GH_TOKEN: "do-not-persist" } },
    { runtimeArgs: ["--enrollment-grant=secret"] },
    { runtimeArgs: ["--devtunnel=x\n--token=secret"] },
    { kind: "host" },
  ])("rejects invalid manifests: %j", (change) => {
    expect(() => validateManifest({ ...fixture(), ...change }, sid)).toThrow();
  });
});

describe("Copilot status protocol", () => {
  it("uses UTF-8 lengths and handles arbitrarily split responses", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: { isAuthenticated: true, label: "\u4f60" },
    };
    const packet = Buffer.from(frameRpc(message));
    const received = [];
    const read = rpcReader((value) => received.push(value));
    for (let index = 0; index < packet.length; index++)
      read(packet.subarray(index, index + 1));
    expect(received).toEqual([message]);
  });
  it("handles notifications alongside responses", () => {
    const messages = [
      { method: "notification" },
      { id: 1, result: { isAuthenticated: true } },
    ];
    const received = [];
    rpcReader((value) => received.push(value))(
      Buffer.from(messages.map(frameRpc).join("")),
    );
    expect(received).toEqual(messages);
  });
  it.each(["Not-Length: 5\r\n\r\nhello", "Content-Length: 999999999\r\n\r\n"])(
    "rejects malformed or oversized responses",
    (packet) => {
      expect(() => rpcReader(() => {})(Buffer.from(packet))).toThrow();
    },
  );
});

describe.skipIf(process.platform !== "win32")("existing Node lock", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  it("refuses a live Node without deleting its lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-login-lock-"));
    directories.push(directory);
    writeFileSync(join(directory, "node.lock"), "1234\n");
    expect(() => assertIdleNode(directory, () => true)).toThrow("PID 1234");
    expect(() => assertIdleNode(directory, () => false)).not.toThrow();
  });
});
