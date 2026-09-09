import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import type { SessionEvent } from "@fleet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentFactory, type SessionAgent } from "./agents.js";
import type * as copilotLaunch from "./copilot-launch.js";

const installation = vi.hoisted(() => ({
  path: "C:\\Program Files\\Agency\\agency.exe" as string | undefined,
}));
vi.mock("./copilot-launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof copilotLaunch>();
  return {
    ...actual,
    resolveCopilotLaunch: vi.fn((enabled: boolean, command: string) =>
      actual.resolveCopilotLaunch(enabled, command, async () => installation.path),
    ),
  };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

type RpcRequest = {
  id?: number;
  method: string;
  params: Record<string, unknown>;
};
const requests: RpcRequest[] = [];
const processes: Array<{ command: string; args: string[]; child: ChildProcess }> = [];
const agents: SessionAgent[] = [];
let metadataFailure: string | undefined;
let startupFailure: string | undefined;
let metadataHangs = false;
let agencyVersion = "1.0.84";

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  processes.length = 0;
  installation.path = "C:\\Program Files\\Agency\\agency.exe";
  metadataFailure = undefined;
  startupFailure = undefined;
  metadataHangs = false;
  agencyVersion = "1.0.84";
  vi.mocked(spawn).mockImplementation((command, args) => {
    const argv: string[] = Array.isArray(args) ? args : [];
    const child = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const close = (code: number) => {
      Object.defineProperty(child, "exitCode", { value: code, configurable: true });
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", code, null);
      child.emit("close", code, null);
    };
    child.kill = vi.fn(() => {
      close(0);
      return true;
    });
    processes.push({ command, args: argv, child });
    const agency = argv[0] === "copilot";
    if (!argv.includes("--acp")) {
      queueMicrotask(() => {
        if (metadataHangs) return;
        if (agency && metadataFailure) {
          child.stderr.write(metadataFailure);
          close(1);
          return;
        }
        if (agency) child.stderr.write("Agency 2026.9.4.3\n");
        child.stdout.write(
          argv.includes("--version")
            ? `GitHub Copilot CLI ${agency ? agencyVersion : "1.0.84"}`
            : agency
              ? "--context <tier>"
              : "--allow-all",
        );
        close(0);
      });
      return child;
    }

    let buffered = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const request = JSON.parse(line) as RpcRequest;
        requests.push(request);
        if (request.id === undefined) continue;
        const configOptions = [
          {
            id: "allow_all",
            name: "Permissions",
            type: "select",
            currentValue: "off",
            options: [
              { value: "on", name: "On" },
              { value: "off", name: "Off" },
            ],
          },
        ];
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { additionalDirectories: {} },
                },
              }
            : request.method === "session/new"
              ? { sessionId: "acp-created", configOptions }
              : { configOptions };
        const reply =
          startupFailure && request.method === "initialize"
            ? { id: request.id, error: { code: -32000, message: startupFailure } }
            : { id: request.id, result };
        queueMicrotask(() =>
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...reply })}\n`),
        );
      }
    });
    return child;
  });
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.useRealTimers();
});

const fleetMcp = [{ name: "fleet", url: "http://127.0.0.1:8787/mcp", headers: [] }];
const launches = () => processes.filter((entry) => entry.args.includes("--acp"));

describe("Agency ACP startup", () => {
  it("probes Agency's Copilot and preserves ACP flags, permissions, cwd, and Fleet MCP", async () => {
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "standard-copilot", "long_context");
    agents.push(
      await factory.start("s1", "C:\\repo", (event) => events.push(event), {
        agencyMode: true,
        yolo: true,
        mcpServers: fleetMcp,
      }),
    );
    expect(processes.map(({ args }) => args)).toEqual([
      ["copilot", "--", "--version"],
      ["copilot", "--", "--help"],
      ["copilot", "--acp", "--stdio", "--allow-all", "--context", "long_context"],
    ]);
    expect(processes.every(({ command }) => command === installation.path)).toBe(true);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({
      cwd: "C:\\repo",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(requests.find((request) => request.method === "session/new")?.params).toEqual({
      cwd: "C:\\repo",
      mcpServers: [{ ...fleetMcp[0], type: "http" }],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "system",
          payload: { message: "Using Agency Copilot on this node." },
        }),
      ]),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
  });

  it("uses only standard Copilot when Agency mode is off", async () => {
    const factory = new AcpAgentFactory(60_000, "custom-copilot");
    agents.push(await factory.start("s1", "C:\\repo", () => {}));
    expect(processes.every(({ command }) => command === "custom-copilot")).toBe(true);
    expect(launches()[0]?.args).toEqual(["--acp", "--stdio"]);
  });

  it("falls back visibly on a Node without Agency", async () => {
    installation.path = undefined;
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "fallback-copilot");
    agents.push(
      await factory.start("s1", "C:\\repo", (event) => events.push(event), {
        agencyMode: true,
      }),
    );
    expect(processes.every(({ command }) => command === "fallback-copilot")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "system" &&
          String(event.payload.message).includes("Falling back to standard Copilot"),
      ),
    ).toBe(true);
  });

  it("loads an existing conversation through Agency with the same MCP servers and roots", async () => {
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "copilot", "default");
    agents.push(
      await factory.start("s1", "C:\\repo", (event) => events.push(event), {
        agencyMode: true,
        resumeAgentSessionId: "existing-conversation",
        additionalDirectories: ["C:\\shared"],
        sequenceOffset: 20,
        mcpServers: fleetMcp,
      }),
    );
    expect(launches()[0]?.args).toEqual([
      "copilot",
      "--acp",
      "--stdio",
      "--context",
      "default",
    ]);
    expect(requests.some((request) => request.method === "session/new")).toBe(false);
    expect(requests.find((request) => request.method === "session/load")?.params).toEqual(
      {
        sessionId: "existing-conversation",
        cwd: "C:\\repo",
        additionalDirectories: ["C:\\shared"],
        mcpServers: [{ ...fleetMcp[0], type: "http" }],
      },
    );
    expect(events[0]?.sequence).toBe(21);
  });

  it("keeps metadata separate for each launcher when the fleet preference changes", async () => {
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    for (const agencyMode of [false, true, false]) {
      agents.push(
        await factory.start(`s${agents.length}`, "C:\\repo", () => {}, { agencyMode }),
      );
    }
    expect(launches().map(({ args }) => args.includes("--context"))).toEqual([
      false,
      true,
      false,
    ]);
    expect(processes.filter(({ args }) => args.includes("--version"))).toHaveLength(2);
  });

  it("rechecks a missing installation and shares successful metadata between concurrent launches", async () => {
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    installation.path = undefined;
    agents.push(
      await factory.start("fallback", "C:\\repo", () => {}, { agencyMode: true }),
    );
    installation.path = "C:\\Tools\\agency.exe";
    agents.push(
      ...(await Promise.all(
        ["first", "second"].map((id) =>
          factory.start(id, "C:\\repo", () => {}, { agencyMode: true }),
        ),
      )),
    );
    expect(launches().map(({ command }) => command)).toEqual([
      "standard-copilot",
      installation.path,
      installation.path,
    ]);
    expect(
      processes.filter(
        ({ command, args }) =>
          command === installation.path && args.includes("--version"),
      ),
    ).toHaveLength(1);
  });

  it("reports an Agency metadata failure instead of falling back, and retries after repair", async () => {
    metadataFailure = "Agency authentication required";
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    await expect(
      factory.start("failed", "C:\\repo", () => {}, { agencyMode: true }),
    ).rejects.toThrow("Agency authentication required");
    expect(launches()).toHaveLength(0);
    expect(processes.every(({ command }) => command === installation.path)).toBe(true);
    metadataFailure = undefined;
    agents.push(
      await factory.start("repaired", "C:\\repo", () => {}, { agencyMode: true }),
    );
    expect(processes.filter(({ args }) => args.includes("--version"))).toHaveLength(2);
  });

  it("rejects an old bundled Copilot even when Agency prints its own newer-looking version", async () => {
    agencyVersion = "1.0.68";
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    await expect(
      factory.start("s1", "C:\\repo", () => {}, { agencyMode: true }),
    ).rejects.toThrow(/Agency's Copilot CLI 1\.0\.68.*minimum 1\.0\.69/);
    expect(launches()).toHaveLength(0);
  });

  it("surfaces ACP authentication failures with Agency login instructions, not a fallback", async () => {
    startupFailure = "Authentication required";
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    await expect(
      factory.start("s1", "C:\\repo", (event) => events.push(event), {
        agencyMode: true,
      }),
    ).rejects.toThrow(/agency copilot.*\/login/);
    expect(processes.every(({ command }) => command === installation.path)).toBe(true);
    expect(launches()[0]?.child.kill).toHaveBeenCalled();
    expect(events.some((event) => event.payload.state === "failed")).toBe(true);
  });

  it("bounds an Agency metadata probe that never responds", async () => {
    vi.useFakeTimers();
    metadataHangs = true;
    const factory = new AcpAgentFactory(60_000, "standard-copilot", "default", 1_000);
    const failure = expect(
      factory.start("s1", "C:\\repo", () => {}, { agencyMode: true }),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
    expect(processes[0]?.child.kill).toHaveBeenCalled();
    expect(launches()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
