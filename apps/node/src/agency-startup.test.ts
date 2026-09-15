import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { CONTEXT_TIER_CONFIG_ID, type SessionEvent } from "@fleet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentFactory, type SessionAgent } from "./agents.js";
import type * as copilotLaunch from "./copilot-launch.js";
import { stopProcessTree } from "./process-quiescence.js";

const installation = vi.hoisted(() => ({
  path: "C:\\Program Files\\Agency\\agency.exe" as string | undefined,
}));
const credits = vi.hoisted(() => ({
  value: undefined as number | undefined,
  bySession: new Map<string, number>(),
  readers: [] as string[],
}));
vi.mock("./session-credits.js", () => ({
  SessionCreditReader: class {
    constructor(private readonly sessionId: string) {
      credits.readers.push(sessionId);
    }
    async read() {
      return credits.bySession.get(this.sessionId) ?? credits.value;
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

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  processes.length = 0;
  installation.path = "C:\\Program Files\\Agency\\agency.exe";
  metadataFailure = undefined;
  startupFailure = undefined;
  metadataHangs = false;
  agencyVersion = "1.0.84";
  credits.value = undefined;
  credits.bySession.clear();
  credits.readers.length = 0;
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
  });
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
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

  it("replaces an oversized loaded conversation and continues from a bounded handoff", async () => {
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
