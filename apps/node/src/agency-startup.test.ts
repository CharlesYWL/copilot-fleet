import {
  ChildProcess,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type * as childProcess from "node:child_process";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { CONTEXT_TIER_CONFIG_ID, type SessionEvent } from "@fleet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgentFactory,
  AgentStartupCleanupError,
  type SessionAgent,
} from "./agents.js";
import type * as copilotLaunch from "./copilot-launch.js";
import { resolveCopilotLaunch } from "./copilot-launch.js";
import { spawnManagedProcess, stopProcessTree } from "./process-quiescence.js";

const installation = vi.hoisted(() => ({
  path: "C:\\Program Files\\Agency\\agency.exe" as string | undefined,
}));
const credits = vi.hoisted(() => ({
  value: undefined as number | undefined,
  bySession: new Map<string, number>(),
  readers: [] as string[],
  pending: undefined as Promise<number | undefined> | undefined,
}));
vi.mock("./session-credits.js", () => ({
  SessionCreditReader: class {
    constructor(private readonly sessionId: string) {
      credits.readers.push(sessionId);
    }
    async read() {
      return credits.pending ?? credits.bySession.get(this.sessionId) ?? credits.value;
    }
  },
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
vi.mock("./process-quiescence.js", () => ({
  spawnManagedProcess: vi.fn(),
  stopProcessTree: vi.fn(async (child: ChildProcess) => {
    child.kill();
  }),
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
let startupHangs: string | undefined;
let metadataHangs = false;
let agencyVersion = "1.0.84";
let loadUsage: { used: number; size: number } | undefined;
let advertiseContext = false;
let contextResponse = "";
let contextFailure = false;
let currentModel = "model-a";
let interleavedText = false;
let splitContextResponse = false;
let oversizedLoad = false;
let oversizedPrompts = 0;
let createdSessions = 0;
const platform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  processes.length = 0;
  installation.path = "C:\\Program Files\\Agency\\agency.exe";
  metadataFailure = undefined;
  startupFailure = undefined;
  startupHangs = undefined;
  metadataHangs = false;
  agencyVersion = "1.0.84";
  credits.value = undefined;
  credits.bySession.clear();
  credits.readers.length = 0;
  credits.pending = undefined;
  loadUsage = undefined;
  advertiseContext = false;
  contextResponse =
    "Context Usage\n\n○ ● ·   model-a · 31k/400k tokens (8%)\n◎ ◎   Buffer 141.6k (35%)";
  contextFailure = false;
  currentModel = "model-a";
  interleavedText = false;
  splitContextResponse = false;
  oversizedLoad = false;
  oversizedPrompts = 0;
  createdSessions = 0;
  const spawnProcess = (command: string, argv: readonly string[]) => {
    const stdio = [
      new PassThrough(),
      new PassThrough(),
      new PassThrough(),
      null,
      null,
    ] satisfies ChildProcessWithoutNullStreams["stdio"];
    const child = Object.assign(new ChildProcess(), {
      pid: 123_456 + processes.length,
      stdin: stdio[0],
      stdout: stdio[1],
      stderr: stdio[2],
      stdio,
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
    processes.push({ command, args: [...argv], child });
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
        if (
          request.method === "session/set_config_option" &&
          request.params.configId === "model"
        ) {
          currentModel = String(request.params.value);
        }
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
          ...(advertiseContext
            ? [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  currentValue: currentModel,
                  options: [
                    { value: "model-a", name: "A" },
                    { value: "model-b", name: "B" },
                  ],
                },
              ]
            : []),
        ];
        const isContext =
          request.method === "session/prompt" &&
          (request.params.prompt as { type: string; text?: string }[])[0]?.text ===
            "/context";
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
              ? {
                  sessionId:
                    ++createdSessions === 1
                      ? "acp-created"
                      : `acp-created-${createdSessions}`,
                  configOptions,
                }
              : request.method === "session/prompt"
                ? { stopReason: "end_turn" }
                : { configOptions };
        const oversized =
          (request.method === "session/load" && oversizedLoad) ||
          (request.method === "session/prompt" && !isContext && oversizedPrompts-- > 0);
        const reply =
          (startupFailure && request.method === "initialize") ||
          (isContext && contextFailure)
            ? {
                id: request.id,
                error: { code: -32000, message: startupFailure ?? "Context read failed" },
              }
            : oversized
              ? {
                  id: request.id,
                  error: {
                    code: -32000,
                    message:
                      "Execution failed: The request is too large to send through CAPI Responses. Try shortening the conversation or prompt. (36.0 MB request; 32.0 MB limit)",
                  },
                }
              : { id: request.id, result };
        queueMicrotask(() => {
          if (request.method === startupHangs) return;
          const notify = (update: Record<string, unknown>) =>
            child.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId: request.params.sessionId ?? "acp-created", update },
              })}\n`,
            );
          if (
            advertiseContext &&
            ["session/new", "session/load"].includes(request.method)
          ) {
            notify({
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "context", description: "Show context usage" }],
            });
          }
          if (
            advertiseContext &&
            request.method === "session/prompt" &&
            !contextFailure
          ) {
            if (!isContext)
              notify({ sessionUpdate: "usage_update", used: 28000, size: 272000 });
            if (isContext && interleavedText)
              notify({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Background update before" },
              });
            const chunks = isContext
              ? splitContextResponse
                ? [
                    contextResponse.slice(0, 3),
                    contextResponse.slice(3, 45),
                    contextResponse.slice(45),
                  ]
                : [contextResponse]
              : ["Model response"];
            for (const text of chunks) {
              notify({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              });
            }
            if (isContext && interleavedText)
              notify({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Background update after" },
              });
          }
          if (request.method === "session/load" && loadUsage) {
            child.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: request.params.sessionId,
                  update: { sessionUpdate: "usage_update", ...loadUsage },
                },
              })}\n`,
            );
          }
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...reply })}\n`);
        });
      }
    });
    return child;
  };
  vi.mocked(spawn).mockImplementation((command, args) =>
    spawnProcess(command, Array.isArray(args) ? args : []),
  );
  vi.mocked(spawnManagedProcess).mockImplementation(spawnProcess);
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  Object.defineProperty(process, "platform", { value: platform });
  vi.useRealTimers();
});

const fleetMcp = [{ name: "fleet", url: "http://127.0.0.1:8787/mcp", headers: [] }];
const launches = () => processes.filter((entry) => entry.args.includes("--acp"));

describe("Agency ACP startup", () => {
  it("overrides the node tier for a session, reports cumulative credits and replayed context, and sends real /compact", async () => {
    credits.value = 27.4014;
    loadUsage = { used: 50000, size: 200000 };
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60000, "copilot", "long_context").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
      { agencyMode: true, contextTier: "default", resumeAgentSessionId: "saved-id" },
    );
    agents.push(agent);
    expect(launches()[0]?.args.slice(-2)).toEqual(["--context", "default"]);
    expect(
      events.filter((event) => event.type === "config").at(-1)?.payload.options,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: CONTEXT_TIER_CONFIG_ID, currentValue: "default" }),
      ]),
    );
    expect(
      events.filter((event) => event.type === "usage").map((event) => event.payload),
    ).toEqual([
      { context: null },
      { contextTokens: 50000, contextWindow: 200000 },
      { aiCredits: 27.4014 },
    ]);
    expect(agent.busy).toBe(false);
    expect(events.some((event) => event.payload.state === "running")).toBe(false);
    await agent.prompt("/compact");
    expect(
      requests.find((request) => request.method === "session/prompt")?.params,
    ).toEqual({
      sessionId: "saved-id",
      prompt: [{ type: "text", text: "/compact" }],
    });
    expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
    expect(agent.busy).toBe(false);
  });

  it("refreshes full context after the response without adding a turn or transcript noise", async () => {
    advertiseContext = true;
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
      { agencyMode: true },
    );
    agents.push(agent);
    await agent.prompt("Work");
    expect(
      requests
        .filter((request) => request.method === "session/prompt")
        .map((request) => request.params.prompt),
    ).toEqual([[{ type: "text", text: "Work" }], [{ type: "text", text: "/context" }]]);
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.at(-1)?.payload.context).toMatchObject({
      model: "model-a",
      usedTokens: 31000,
      tokenLimit: 400000,
      percentage: 8,
      estimated: true,
    });
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { contextTokens: 28000, contextWindow: 272000 },
        }),
      ]),
    );
    expect(
      events
        .filter((event) => event.type === "agent_text")
        .map((event) => event.payload.text),
    ).toEqual(["Model response"]);
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "system")
        .map((event) => event.payload.text),
    ).not.toContain("User: /context");
    expect(agent.busy).toBe(false);
    await agent.setConfigOption("model", "model-b");
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.context,
    ).toBeNull();
    await agent.prompt("Continue on the new model");
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.context,
    ).toBeNull();
  });

  it("uses an explicit /context result without running the command twice", async () => {
    advertiseContext = true;
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
    );
    agents.push(agent);
    await agent.prompt("/context");
    expect(
      requests.filter((request) => request.method === "session/prompt"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "agent_text").at(-1)?.payload.text,
    ).toBe(contextResponse);
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.context,
    ).toMatchObject({ percentage: 8, tokenLimit: 400000 });
  });

  it("does not swallow background output surrounding the local context report", async () => {
    advertiseContext = true;
    interleavedText = true;
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
    );
    agents.push(agent);
    await agent.prompt("Work");
    expect(
      events
        .filter((event) => event.type === "agent_text")
        .map((event) => event.payload.text),
    ).toEqual(["Model response", "Background update before", "Background update after"]);
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.context,
    ).toMatchObject({ percentage: 8 });
  });

  it("collects a fragmented local context report without displaying its chunks", async () => {
    advertiseContext = true;
    splitContextResponse = true;
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
    );
    agents.push(agent);
    await agent.prompt("Work");
    expect(
      events
        .filter((event) => event.type === "agent_text")
        .map((event) => event.payload.text),
    ).toEqual(["Model response"]);
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.context,
    ).toMatchObject({ percentage: 8, tokenLimit: 400000 });
  });

  it.each(["invalid", "rpc-failure"])(
    "reports metadata failure without failing a successful turn: %s",
    async (failure) => {
      advertiseContext = true;
      contextResponse = "Unexpected context format";
      contextFailure = failure === "rpc-failure";
      const events: SessionEvent[] = [];
      const agent = await new AcpAgentFactory(60000, "copilot").start(
        "s1",
        "C:\\repo",
        (event) => events.push(event),
      );
      agents.push(agent);
      await agent.prompt("Work");
      expect(events.some((event) => event.payload.state === "failed")).toBe(false);
      expect(events.at(-1)?.payload.state).toBe("idle");
      expect(
        events.some(
          (event) =>
            event.type === "system" &&
            String(event.payload.text).includes("Context usage is unavailable"),
        ),
      ).toBe(true);
    },
  );

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
    const launcher = process.platform === "win32" ? spawnManagedProcess : spawn;
    expect(vi.mocked(launcher).mock.calls.at(-1)?.[2]).toMatchObject({
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

  it("replaces an oversized loaded conversation and continues from a bounded handoff by default", async () => {
    oversizedLoad = true;
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    agents.push(
      await factory.start("s1", "C:\\repo", (event) => events.push(event), {
        resumeAgentSessionId: "oversized-session",
        contextOverflowRecoveryPrompt: "Original assignment: finish the feature",
      }),
    );

    expect(requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(["session/load", "session/new", "session/prompt"]),
    );
    expect(
      JSON.stringify(requests.find((request) => request.method === "session/prompt")),
    ).toContain("finish the feature");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_session",
          payload: { agentSessionId: "acp-created" },
        }),
        expect.objectContaining({
          type: "state",
          payload: { state: "idle", activity: "Ready for follow-up" },
        }),
      ]),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("surfaces an oversized load without creating or prompting a conversation when resume rollover is disabled", async () => {
    oversizedLoad = true;
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    await expect(
      factory.start("s1", "C:\\repo", (event) => events.push(event), {
        resumeAgentSessionId: "oversized-session",
        allowResumeRollover: false,
        contextOverflowRecoveryPrompt: "Original assignment: finish the feature",
        mcpServers: fleetMcp,
      }),
    ).rejects.toThrow("The request is too large to send through CAPI Responses");

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(stopProcessTree).toHaveBeenCalledWith(
      launches()[0]?.child,
      process.platform === "win32",
    );
    expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "agent_session")).toBe(false);
    expect(events.some((event) => event.payload.state === "idle")).toBe(false);
    expect(events.at(-1)?.payload.state).toBe("failed");
  });

  it("still allows prompt-time rollover after resuming with resume rollover disabled", async () => {
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    const agent = await factory.start("s1", "C:\\repo", () => {}, {
      resumeAgentSessionId: "saved-session",
      allowResumeRollover: false,
      contextOverflowRecoveryPrompt: "Original assignment: preserve current edits",
    });
    agents.push(agent);
    expect(
      requests.filter((request) =>
        ["session/new", "session/prompt"].includes(request.method),
      ),
    ).toHaveLength(0);

    oversizedPrompts = 1;
    await agent.prompt("finish and report");

    expect(requests.filter((request) => request.method === "session/new")).toHaveLength(
      1,
    );
    expect(
      requests.filter((request) => request.method === "session/prompt"),
    ).toHaveLength(2);
  });

  it("starts usage tracking when loading an oversized conversation rolls over", async () => {
    vi.useFakeTimers();
    oversizedLoad = true;
    credits.bySession.set("acp-created", 2);
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60_000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
      {
        resumeAgentSessionId: "oversized-session",
        contextOverflowRecoveryPrompt: "Continue the task",
      },
    );
    agents.push(agent);
    expect(credits.readers).toEqual(["acp-created"]);
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.aiCredits,
    ).toBe(2);
    credits.bySession.set("acp-created", 3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.payload.aiCredits,
    ).toBe(3);
  });

  it("rebinds credits and invalidates old context after prompt-time rollover", async () => {
    advertiseContext = true;
    credits.bySession.set("acp-created", 10);
    credits.bySession.set("acp-created-2", 2);
    const events: SessionEvent[] = [];
    const agent = await new AcpAgentFactory(60_000, "copilot").start(
      "s1",
      "C:\\repo",
      (event) => events.push(event),
    );
    agents.push(agent);
    await agent.prompt("First turn");
    expect(
      events.filter((event) => event.type === "usage" && event.payload.context).at(-1)
        ?.payload.context,
    ).toMatchObject({ percentage: 8 });
    oversizedPrompts = 1;
    contextResponse = "Context information is not yet available. Send a message first.";
    await agent.prompt("Recover this task");
    expect(credits.readers).toEqual(["acp-created", "acp-created-2"]);
    const usage = Object.assign(
      {},
      ...events.filter((event) => event.type === "usage").map((event) => event.payload),
    );
    expect(usage).toMatchObject({ aiCredits: 2, context: null });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "usage",
          payload: {
            aiCredits: null,
            context: null,
            contextTokens: null,
            contextWindow: null,
          },
        }),
      ]),
    );
  });

  it("rolls over once when an established conversation exceeds CAPI on prompt", async () => {
    oversizedPrompts = 1;
    const events: SessionEvent[] = [];
    const factory = new AcpAgentFactory(60_000, "standard-copilot");
    const agent = await factory.start("s1", "C:\\repo", (event) => events.push(event), {
      contextOverflowRecoveryPrompt: "Original assignment: preserve current edits",
    });
    agents.push(agent);

    await agent.prompt("finish and report");

    expect(requests.filter((request) => request.method === "session/new")).toHaveLength(
      2,
    );
    expect(
      requests.filter((request) => request.method === "session/prompt"),
    ).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_session",
          payload: { agentSessionId: "acp-created-2" },
        }),
        expect.objectContaining({
          type: "state",
          payload: { state: "idle", activity: "Ready for follow-up" },
        }),
      ]),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
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
    expect(stopProcessTree).toHaveBeenCalledWith(launches()[0]?.child, false);
    expect(launches()[0]?.child.kill).toHaveBeenCalled();
    expect(events.some((event) => event.payload.state === "failed")).toBe(true);
  });

  it.each([
    { platform: "win32", mcpServers: fleetMcp, managed: true },
    { platform: "win32", mcpServers: [], managed: false },
    { platform: "linux", mcpServers: fleetMcp, managed: false },
    { platform: "linux", mcpServers: [], managed: false },
    { platform: "darwin", mcpServers: fleetMcp, managed: false },
    { platform: "darwin", mcpServers: [], managed: false },
  ])(
    "contains unleased MCP processes only on Windows: $platform, managed=$managed",
    async ({ platform, mcpServers, managed }) => {
      Object.defineProperty(process, "platform", { value: platform });
      const agent = await new AcpAgentFactory(60_000, "copilot").start(
        "s1",
        "C:\\repo",
        () => {},
        { mcpServers },
      );
      agents.push(agent);

      expect(Reflect.get(agent, "processOwnership")).toBeUndefined();
      expect(spawnManagedProcess).toHaveBeenCalledTimes(managed ? 1 : 0);
      expect(
        vi.mocked(spawn).mock.calls.filter(([, args]) => args?.includes("--acp")),
      ).toHaveLength(managed ? 0 : 1);
      expect(
        requests.find((request) => request.method === "session/new")?.params,
      ).toEqual({
        cwd: "C:\\repo",
        mcpServers: mcpServers.map((server) => ({ ...server, type: "http" })),
      });
      await agent.prompt("Continue");
      expect(
        requests.filter((request) => request.method === "session/prompt"),
      ).toHaveLength(1);
      await agent.stop();
      expect(stopProcessTree).toHaveBeenCalledWith(launches()[0]?.child, managed);
    },
  );

  it("retains managed process ownership and release callbacks for leased sessions without MCP", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const processStarting = vi.fn(() => expect(launches()).toHaveLength(0));
    const processStarted = vi.fn();
    const processesQuiesced = vi.fn();
    const agent = await new AcpAgentFactory(60_000, "copilot").start(
      "s1",
      "C:\\repo",
      () => {},
      { processStarting, processStarted, processesQuiesced },
    );
    agents.push(agent);
    expect(spawnManagedProcess).toHaveBeenCalledOnce();
    expect(processStarting).toHaveBeenCalledOnce();
    expect(processStarted).toHaveBeenCalledExactlyOnceWith(launches()[0]?.child.pid);
    expect(processesQuiesced).not.toHaveBeenCalled();

    await agent.stop();
    expect(stopProcessTree).toHaveBeenCalledWith(launches()[0]?.child, true);
    expect(processesQuiesced).toHaveBeenCalledOnce();
    expect(processesQuiesced.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(stopProcessTree).mock.invocationCallOrder[0]!,
    );
  });

  it.each([false, true])(
    "retains a failed startup agent until cleanup can be retried (leased=%s)",
    async (leased) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      startupFailure = "Authentication required";
      const cleanupError = new Error(
        "Process-tree ownership is unknown; reconciliation is required.",
      );
      vi.mocked(stopProcessTree).mockRejectedValueOnce(cleanupError);
      const processesQuiesced = vi.fn();
      const controller = new AbortController();
      const events: SessionEvent[] = [];
      const failure: unknown = await new AcpAgentFactory(60_000, "copilot")
        .start("s1", "C:\\repo", (event) => events.push(event), {
          signal: controller.signal,
          mcpServers: fleetMcp,
          ...(leased ? { processesQuiesced } : {}),
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AgentStartupCleanupError);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AgentStartupCleanupError)) {
        throw new Error("Expected retained startup agent");
      }
      agents.push(failure.agent);
      expect(failure.name).toBe("AgentStartupCleanupError");
      expect(failure.message).toBe(
        "Authentication required. Run `copilot login` on this node, then retry.",
      );
      expect(failure.errors).toEqual([new Error(failure.message), cleanupError]);
      expect(failure.cause).toBe(cleanupError);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(processesQuiesced).not.toHaveBeenCalled();
      expect(launches()[0]?.child.kill).not.toHaveBeenCalled();
      expect(events.some((event) => event.payload.state === "stopped")).toBe(false);
      await expect(failure.agent.prompt("Do not run")).rejects.toThrow(
        "ACP session is no longer active",
      );
      const recorded = [...events];
      failure.agent.resync();
      expect(events).toEqual(recorded);

      await failure.agent.stop(false);
      expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
      expect(vi.mocked(stopProcessTree).mock.calls).toEqual([
        [launches()[0]?.child, true],
        [launches()[0]?.child, true],
      ]);
      expect(processesQuiesced).toHaveBeenCalledTimes(leased ? 1 : 0);
      expect(events).toEqual(recorded);
    },
  );

  it("keeps a timed-out load inactive and replay-suppressed when cleanup must be retried", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "win32" });
    startupHangs = "session/load";
    vi.mocked(stopProcessTree).mockRejectedValueOnce(
      new Error("Process-tree ownership is unknown; reconciliation is required."),
    );
    const events: SessionEvent[] = [];
    const controller = new AbortController();
    const started = new AcpAgentFactory(60_000, "copilot", "default", 1_000)
      .start("s1", "C:\\repo", (event) => events.push(event), {
        signal: controller.signal,
        resumeAgentSessionId: "saved-id",
        mcpServers: fleetMcp,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const failure = await started;
    if (!(failure instanceof AgentStartupCleanupError)) {
      throw new Error("Expected retained startup agent");
    }
    agents.push(failure.agent);
    expect(failure.message).toMatch(/within 1s/);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(Reflect.get(failure.agent, "replaying")).toBe(true);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(events.some((event) => event.type === "agent_session")).toBe(false);
    expect(events.at(-1)?.payload.state).toBe("failed");
    const recorded = [...events];
    await failure.agent.stop(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toEqual(recorded);
    expect(Reflect.get(failure.agent, "replaying")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "does not resume startup or send a handoff after a timed-out credit read (rollover=%s)",
    async (rollover) => {
      vi.useFakeTimers();
      oversizedLoad = rollover;
      let finishRead!: (value: number) => void;
      credits.pending = new Promise<number>((resolve) => {
        finishRead = resolve;
      });
      const events: SessionEvent[] = [];
      const started = new AcpAgentFactory(60_000, "copilot", "default", 1_000)
        .start("s1", "C:\\repo", (event) => events.push(event), {
          resumeAgentSessionId: "saved-id",
          contextOverflowRecoveryPrompt: "Do not send this after cleanup",
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stopProcessTree).toHaveBeenCalledOnce();
      const failedAt = events.findIndex((event) => event.payload.state === "failed");
      expect(failedAt).toBeGreaterThanOrEqual(0);
      const requested = [...requests];
      finishRead(1);
      const failure = await started;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AgentStartupCleanupError);
      expect(events.slice(failedAt + 1).map((event) => event.type)).toEqual(["usage"]);
      expect(requests).toEqual(requested);
      expect(requests.some((request) => request.method === "session/prompt")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not launch anything for an already aborted startup", async () => {
    const controller = new AbortController();
    const reason = new Error("Recovery cancelled");
    controller.abort(reason);
    await expect(
      new AcpAgentFactory(60_000, "copilot").start("s1", "C:\\repo", () => {}, {
        signal: controller.signal,
        mcpServers: fleetMcp,
      }),
    ).rejects.toBe(reason);
    expect(processes).toHaveLength(0);
    expect(stopProcessTree).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not launch ACP when the startup sink aborts synchronously", async () => {
    const controller = new AbortController();
    const reason = new Error("Recovery cancelled");
    await expect(
      new AcpAgentFactory(60_000, "copilot").start(
        "s1",
        "C:\\repo",
        (event) => {
          if (event.payload.state === "starting") controller.abort(reason);
        },
        { signal: controller.signal, mcpServers: fleetMcp },
      ),
    ).rejects.toThrow(reason.message);
    expect(launches()).toHaveLength(0);
    expect(stopProcessTree).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects during launcher resolution and never resumes preflight after abort", async () => {
    vi.useFakeTimers();
    let resolveLaunch!: (launch: copilotLaunch.CopilotLaunch) => void;
    vi.mocked(resolveCopilotLaunch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );
    const controller = new AbortController();
    const reason = new Error("Recovery cancelled");
    const started = new AcpAgentFactory(60_000, "copilot").start(
      "s1",
      "C:\\repo",
      () => {},
      { signal: controller.signal, mcpServers: fleetMcp },
    );
    const failed = expect(started).rejects.toBe(reason);
    controller.abort(reason);
    await failed;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    resolveLaunch({ command: "copilot", args: [], provider: "copilot" });
    await vi.advanceTimersByTimeAsync(0);
    expect(processes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a preflight wait without interrupting a concurrent startup sharing its probe", async () => {
    vi.useFakeTimers();
    metadataHangs = true;
    const factory = new AcpAgentFactory(60_000, "copilot");
    const controller = new AbortController();
    const reason = new Error("Recovery cancelled");
    const started = factory.start("cancelled", "C:\\repo", () => {}, {
      signal: controller.signal,
      mcpServers: fleetMcp,
    });
    const other = factory.start("other", "C:\\repo", () => {});
    const failed = expect(started).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(processes).toHaveLength(1);
    controller.abort(reason);
    await failed;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(processes[0]?.child.kill).not.toHaveBeenCalled();

    metadataHangs = false;
    (processes[0]?.child.stdout as PassThrough).write("GitHub Copilot CLI 1.0.84");
    processes[0]?.child.kill();
    const agent = await other;
    agents.push(agent);
    expect(launches()).toHaveLength(1);
    await agent.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["initialize", "session/new", "session/load", "session/set_config_option"])(
    "cleans up promptly when %s is aborted and removes its listener",
    async (phase) => {
      vi.useFakeTimers();
      Object.defineProperty(process, "platform", { value: "win32" });
      startupHangs = phase;
      advertiseContext = true;
      const controller = new AbortController();
      const reason = new Error("Recovery cancelled");
      const events: SessionEvent[] = [];
      const started = new AcpAgentFactory(60_000, "copilot")
        .start("s1", "C:\\repo", (event) => events.push(event), {
          signal: controller.signal,
          mcpServers: fleetMcp,
          ...(phase === "session/load" ? { resumeAgentSessionId: "saved-id" } : {}),
          config: [{ id: "model", value: "model-b" }],
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(requests.at(-1)?.method).toBe(phase);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort(reason);
      const failure = await started;
      expect(failure).toEqual(reason);
      expect(failure).not.toBeInstanceOf(AgentStartupCleanupError);
      expect(stopProcessTree).toHaveBeenCalledExactlyOnceWith(launches()[0]?.child, true);
      expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      const recorded = [...events];
      const requested = [...requests];
      await vi.advanceTimersByTimeAsync(180_000);
      expect(events).toEqual(recorded);
      expect(requests).toEqual(requested);
      expect(events.at(-1)?.payload.state).toBe("failed");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains the aborted agent when ownership cannot be verified and retries cleanup", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "win32" });
    startupHangs = "session/load";
    const cleanupError = new Error(
      "Process-tree ownership is unknown; reconciliation is required.",
    );
    vi.mocked(stopProcessTree).mockRejectedValueOnce(cleanupError);
    const controller = new AbortController();
    const reason = new Error("Recovery cancelled");
    const events: SessionEvent[] = [];
    const started = new AcpAgentFactory(60_000, "copilot")
      .start("s1", "C:\\repo", (event) => events.push(event), {
        signal: controller.signal,
        mcpServers: fleetMcp,
        resumeAgentSessionId: "saved-id",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    const failure = await started;
    if (!(failure instanceof AgentStartupCleanupError)) {
      throw new Error("Expected retained aborted agent");
    }
    agents.push(failure.agent);
    expect(failure.message).toBe(reason.message);
    expect(failure.errors).toEqual([reason, cleanupError]);
    expect(failure.cause).toBe(cleanupError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(launches()[0]?.child.kill).not.toHaveBeenCalled();
    expect(Reflect.get(failure.agent, "replaying")).toBe(true);
    const recorded = [...events];
    await failure.agent.stop(false);
    expect(stopProcessTree).toHaveBeenLastCalledWith(launches()[0]?.child, true);
    expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
    expect(events).toEqual(recorded);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "does not wait on credits or revive an aborted startup (rollover=%s)",
    async (rollover) => {
      vi.useFakeTimers();
      oversizedLoad = rollover;
      let finishRead!: (value: number) => void;
      credits.pending = new Promise<number>((resolve) => {
        finishRead = resolve;
      });
      const controller = new AbortController();
      const reason = new Error("Recovery cancelled");
      const events: SessionEvent[] = [];
      const started = new AcpAgentFactory(60_000, "copilot")
        .start("s1", "C:\\repo", (event) => events.push(event), {
          signal: controller.signal,
          mcpServers: fleetMcp,
          resumeAgentSessionId: "saved-id",
          contextOverflowRecoveryPrompt: "Do not send after cancellation",
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(credits.readers).toHaveLength(1);
      controller.abort(reason);
      const failure = await started;
      expect(failure).toEqual(reason);
      expect(stopProcessTree).toHaveBeenCalledOnce();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      const recorded = [...events];
      const requested = [...requests];
      finishRead(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(recorded);
      expect(requests).toEqual(requested);
      expect(requests.some((request) => request.method === "session/prompt")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("removes the cancellation listener after success without stopping the returned agent", async () => {
    const controller = new AbortController();
    const agent = await new AcpAgentFactory(60_000, "copilot").start(
      "s1",
      "C:\\repo",
      () => {},
      { signal: controller.signal, mcpServers: fleetMcp },
    );
    agents.push(agent);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort(new Error("Too late"));
    await agent.prompt("Continue");
    expect(stopProcessTree).not.toHaveBeenCalled();
    expect(requests.some((request) => request.method === "session/prompt")).toBe(true);
  });

  it.each([false, true])(
    "waits for verified shutdown but only announced stops await pending credits (announce=%s)",
    async (announce) => {
      vi.useFakeTimers();
      Object.defineProperty(process, "platform", { value: "win32" });
      credits.value = 1;
      const controller = new AbortController();
      const events: SessionEvent[] = [];
      const agent = await new AcpAgentFactory(60_000, "copilot").start(
        "s1",
        "C:\\repo",
        (event) => events.push(event),
        { signal: controller.signal, mcpServers: fleetMcp },
      );
      agents.push(agent);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

      let finishRead!: (value: number) => void;
      credits.pending = new Promise<number>((resolve) => {
        finishRead = resolve;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(Reflect.get(agent, "creditRead")).toBeInstanceOf(Promise);
      let finishCleanup!: () => void;
      vi.mocked(stopProcessTree).mockImplementationOnce(
        (child) =>
          new Promise<void>((resolve) => {
            finishCleanup = () => {
              child.kill();
              resolve();
            };
          }),
      );
      let settled = false;
      const stopped = agent.stop(announce).then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(stopProcessTree).toHaveBeenCalledExactlyOnceWith(
          launches()[0]?.child,
          true,
        );
        expect(settled).toBe(false);
        expect(launches()[0]?.child.kill).not.toHaveBeenCalled();

        finishCleanup();
        await vi.advanceTimersByTimeAsync(0);
        expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
        expect(settled).toBe(!announce);
        expect(events.some((event) => event.payload.state === "stopped")).toBe(false);
      } finally {
        if (launches()[0]?.child.exitCode === null) finishCleanup();
        finishRead(2);
        await stopped;
      }
      if (announce) {
        expect(events.filter((event) => event.type === "usage").at(-1)?.payload).toEqual({
          aiCredits: 2,
        });
        expect(events.at(-1)?.payload.state).toBe("stopped");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("aborts a timed-out startup already waiting for optional cleanup usage", async () => {
    vi.useFakeTimers();
    let finishRead!: (value: number) => void;
    credits.pending = new Promise<number>((resolve) => {
      finishRead = resolve;
    });
    const controller = new AbortController();
    const events: SessionEvent[] = [];
    const started = new AcpAgentFactory(60_000, "copilot", "default", 1_000)
      .start("s1", "C:\\repo", (event) => events.push(event), {
        signal: controller.signal,
        mcpServers: fleetMcp,
        resumeAgentSessionId: "saved-id",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopProcessTree).toHaveBeenCalledOnce();
    controller.abort(new Error("Stop recovery cleanup"));
    const failure = await started;
    expect(failure).toBeInstanceOf(Error);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const recorded = [...events];
    finishRead(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(recorded);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still waits for verified process termination when startup is aborted", async () => {
    vi.useFakeTimers();
    startupHangs = "initialize";
    let finishCleanup!: () => void;
    vi.mocked(stopProcessTree).mockImplementationOnce(
      (child) =>
        new Promise<void>((resolve) => {
          finishCleanup = () => {
            child.kill();
            resolve();
          };
        }),
    );
    const controller = new AbortController();
    let settled = false;
    const started = new AcpAgentFactory(60_000, "copilot")
      .start("s1", "C:\\repo", () => {}, {
        signal: controller.signal,
        mcpServers: fleetMcp,
      })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Recovery cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(launches()[0]?.child.kill).not.toHaveBeenCalled();
    finishCleanup();
    await started;
    expect(settled).toBe(true);
    expect(launches()[0]?.child.kill).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
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
