import { spawn } from "node:child_process";
import {
  CONTEXT_TIER_CONFIG_ID,
  type AgentParams,
  type SessionEvent,
  type StartupConfig,
} from "@fleet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgentFactory,
  type EventSink,
  type SessionAgent,
  type StartAgentOptions,
} from "./agents.js";
import { CopilotAgentKind, copilotLaunchArgs } from "./agent-kinds/copilot.js";
import type { CheckoutLease } from "./checkout-locks.js";
import { resolveCopilotLaunch } from "./copilot-launch.js";
import { spawnManagedProcess, stopProcessTree } from "./process-quiescence.js";
import { CommandRouter } from "./router.js";
import type { RepositoryParticipation } from "./repository-participation.js";

vi.mock("./copilot-launch.js", async (original) => ({
  ...(await original<typeof import("./copilot-launch.js")>()),
  resolveCopilotLaunch: vi.fn(() => {
    throw new Error("Unexpected launcher discovery");
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("Unexpected process spawn");
  }),
}));
vi.mock("./process-quiescence.js", () => ({
  spawnManagedProcess: vi.fn(() => {
    throw new Error("Unexpected managed spawn");
  }),
  stopProcessTree: vi.fn(),
}));

type Route = "context" | "mcp" | "deferred-mcp";
type SavedFrom = "requested" | "reported" | "normalized";
type Slot = {
  agent: SessionAgent | undefined;
  config: Map<string, string>;
  generation: number;
  silentReplacement?: boolean;
  refreshing?: Promise<void>;
  mcpRecovery?: AbortController;
  ready: Promise<void>;
};

const profiles = [
  { id: "model", value: "claude-opus-5.5" },
  { id: "reasoning_effort", value: "high" },
];
const routes: Route[] = ["context", "mcp", "deferred-mcp"];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function fixture(agencyMode: boolean, agentParams?: AgentParams) {
  vi.useFakeTimers();
  const events: SessionEvent[] = [];
  const order: string[] = [];
  let sink!: EventSink;
  let sequence = 0;
  let finishStop = () => {};
  let stopGate = Promise.resolve();
  const send = (type: SessionEvent["type"], payload: Record<string, unknown>) =>
    sink({
      eventId: `backend-${++sequence}`,
      sessionId: "s1",
      sequence,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  const old: SessionAgent = {
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      order.push("stop-enter");
      await stopGate;
      order.push("stop-quiesced");
    }),
    setConfigOption: vi.fn(async () => {}),
    resolvePermission: vi.fn(),
    denyPendingPermissions: vi.fn(),
    resync: vi.fn(),
    advanceSequence: vi.fn((atLeast: number) => {
      sequence = Math.max(sequence, atLeast);
    }),
    busy: false,
  };
  const next = { ...old, stop: vi.fn(async () => {}) };
  const factory = new AcpAgentFactory(60_000, "inert-copilot.exe");
  const realStart = factory.start.bind(factory);
  const start = vi.spyOn(factory, "start");
  start.mockImplementationOnce(async (_id, _cwd, eventSink) => {
    sink = eventSink;
    send("agent_session", { agentSessionId: "saved-native" });
    send("config", {
      options: [
        ...profiles.map(({ id, value }) => ({ id, name: id, currentValue: value })),
        {
          id: CONTEXT_TIER_CONFIG_ID,
          name: "Context",
          currentValue: "long_context",
        },
      ],
    });
    return old;
  });
  start.mockImplementation((...args) => {
    order.push("start");
    return realStart(...args);
  });
  const launchingNative = vi.fn();
  const warn = vi.fn();
  const lease = {
    revalidate: vi.fn(async () => {}),
    release: vi.fn(),
    requireReconciliation: vi.fn(),
    processPending: vi.fn(),
    processStarted: vi.fn(),
    processesQuiesced: vi.fn(),
  };
  const router = new CommandRouter(
    factory,
    1,
    (event) => events.push(event),
    async (path) => path,
    () => "http://127.0.0.1:8787",
    undefined,
    warn,
    {
      launchingNative,
      repositories: {
        participate: async () => ({
          leases: [lease as unknown as CheckoutLease],
          supervised: true,
        }),
      } as unknown as RepositoryParticipation,
    },
  );
  expect(
    await router.route({
      type: "resume_session",
      commandId: "resume",
      sessionId: "s1",
      localPath: "C:\\inert-workspace",
      agentSessionId: "saved-native",
      sequenceOffset: 0,
      additionalDirectories: ["C:\\inert-shared"],
      yolo: true,
      agencyMode,
      contextTier: "long_context",
      config: profiles,
      mcpServers: [{ name: "fleet", url: "/mcp", headers: [] }],
      agent: "",
      readOnly: false,
      ...(agentParams ? { agentParams } : {}),
    }),
  ).toMatchObject({ ok: true });
  launchingNative.mockClear();
  const slots = (router as unknown as { slots: Map<string, Slot> }).slots;
  const slot = slots.get("s1")!;
  const trigger = (route: Route) => {
    if (route === "context")
      return router.route({
        type: "set_config_option",
        commandId: "context",
        sessionId: "s1",
        configId: CONTEXT_TIER_CONFIG_ID,
        value: "default",
      });
    if (route === "mcp") return router.refreshMcpSessions();
    send("tool", {
      title: "fleet-fleet_list_work",
      status: "failed",
      error: "Tool does not exist",
    });
    send("state", { state: "idle", activity: "Ready" });
    return slot.refreshing!;
  };
  return {
    router,
    slots,
    slot,
    old,
    next,
    start,
    send,
    trigger,
    events,
    order,
    launchingNative,
    warn,
    lease,
    gateStop() {
      stopGate = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      return () => finishStop();
    },
  };
}

describe("replacement launch preflight", () => {
  it.each(["model", "reasoning_effort"])(
    "shares the pure launch guard including invalid duplicate %s requests",
    (id) => {
      expect(() =>
        copilotLaunchArgs(false, undefined, [
          { id, value: "" },
          { id, value: id === "model" ? "bad model" : " high " },
        ]),
      ).toThrow(`Invalid Copilot startup ${id}`);
      expect(resolveCopilotLaunch).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnManagedProcess).not.toHaveBeenCalled();
      expect(stopProcessTree).not.toHaveBeenCalled();
    },
  );

  it.each(
    routes.flatMap((route) =>
      [false, true].flatMap((agencyMode) =>
        (["requested", "reported", "normalized"] as SavedFrom[]).flatMap((savedFrom) =>
          [
            { id: "model", value: "bad model" },
            { id: "reasoning_effort", value: " high " },
          ].map((option) => ({ route, agencyMode, savedFrom, ...option })),
        ),
      ),
    ),
  )(
    "retains the old session on $route with invalid $id from $savedFrom (agency=$agencyMode)",
    async ({ route, agencyMode, savedFrom, id, value }) => {
      const f = await fixture(agencyMode);
      if (savedFrom !== "reported") {
        expect(
          await f.router.route({
            type: "set_config_option",
            commandId: "accepted-picker",
            sessionId: "s1",
            configId: id,
            value: savedFrom === "requested" ? value : "backend-selection",
          }),
        ).toMatchObject({ ok: true });
      }
      if (savedFrom !== "requested")
        f.send("config", { options: [{ id, name: id, currentValue: value }] });
      expect(f.slot.config.get(id)).toBe(value);
      const savedGeneration = f.slot.generation;
      const savedConfig = [...f.slot.config];
      const prepare = vi.spyOn(CopilotAgentKind.prototype, "prepare");
      const operation = f.trigger(route);
      await vi.runAllTimersAsync();
      const result = await operation;
      if (route === "context")
        expect(result).toMatchObject({
          ok: false,
          fatal: false,
          error: expect.stringContaining(`Invalid Copilot startup ${id}`),
        });
      expect(f.old.stop).not.toHaveBeenCalled();
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(resolveCopilotLaunch).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnManagedProcess).not.toHaveBeenCalled();
      expect(stopProcessTree).not.toHaveBeenCalled();
      expect(f.launchingNative).not.toHaveBeenCalled();
      expect(f.lease.release).not.toHaveBeenCalled();
      expect(f.lease.requireReconciliation).not.toHaveBeenCalled();
      expect(f.lease.processPending).not.toHaveBeenCalled();
      expect(f.lease.processStarted).not.toHaveBeenCalled();
      expect(f.lease.processesQuiesced).not.toHaveBeenCalled();
      expect(f.slots.get("s1")).toBe(f.slot);
      expect(f.slot.agent).toBe(f.old);
      expect(f.slot.generation).toBe(savedGeneration);
      expect(f.slot.silentReplacement).toBeFalsy();
      expect([...f.slot.config]).toEqual(savedConfig);
      expect(f.slot.refreshing).toBeUndefined();
      expect(f.slot.mcpRecovery).toBeUndefined();
      expect(f.router.activeSessionIds).toEqual(["s1"]);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "error",
          payload: {
            message: expect.stringContaining(`Invalid Copilot startup ${id}`),
          },
        }),
      );
      expect(
        f.events.some(
          (event) =>
            event.type === "state" &&
            ["failed", "stopped"].includes(String(event.payload.state)),
        ),
      ).toBe(false);
      expect(JSON.stringify(f.events)).not.toContain("MCP tools restored");
      const lastSequence = Math.max(...f.events.map((event) => event.sequence));
      f.send("state", { state: "idle", activity: "Original agent is still attached" });
      expect(f.events.at(-1)?.payload.activity).toBe("Original agent is still attached");
      expect(f.events.at(-1)!.sequence).toBeGreaterThan(lastSequence);
      expect(
        await f.router.route({
          type: "prompt",
          commandId: "still-healthy",
          sessionId: "s1",
          prompt: "Continue",
          attachments: [],
        }),
      ).toMatchObject({ ok: true });
      expect(f.old.prompt).toHaveBeenCalledOnce();
    },
  );

  it("does not claim to retain a session after an earlier replacement already stopped it", async () => {
    const f = await fixture(false);
    f.start.mockImplementationOnce(async (_id, _cwd, sink) => {
      sink({
        eventId: "replacement-normalized",
        sessionId: "s1",
        sequence: f.slot.generation + 10,
        type: "config",
        payload: { options: [{ id: "model", name: "Model", currentValue: "bad model" }] },
        createdAt: new Date().toISOString(),
      });
      throw new Error("Backend failed after reporting its profile");
    });
    const operation = f.trigger("mcp");
    await vi.runAllTimersAsync();
    await operation;
    expect(f.old.stop).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.router.activeSessionIds).toEqual([]);
    expect(JSON.stringify(f.events)).not.toContain("Existing session retained");
    expect(f.events.at(-1)).toMatchObject({
      type: "state",
      payload: {
        state: "failed",
        activity: expect.stringContaining("MCP recovery exhausted"),
      },
    });
  });

  it.each(
    routes.flatMap((route) =>
      [false, true].flatMap((agencyMode) =>
        [undefined, { kind: "hermes", profile: "fixture" } as AgentParams].map(
          (agentParams) => ({
            route,
            agencyMode,
            agentParams,
          }),
        ),
      ),
    ),
  )(
    "waits for quiescence then starts the exact saved config on $route (agency=$agencyMode, params=$agentParams)",
    async ({ route, agencyMode, agentParams }) => {
      const f = await fixture(agencyMode, agentParams);
      if (agentParams) {
        f.send("config", {
          options: [{ id: "model", name: "Model", currentValue: "opaque # model" }],
        });
      }
      const config: StartupConfig[] = [...f.slot.config].map(([id, value]) => ({
        id,
        value,
      }));
      const finish = f.gateStop();
      const prepare = vi.spyOn(CopilotAgentKind.prototype, "prepare");
      f.start.mockImplementationOnce(async (_id, _cwd, _sink, options = {}) => {
        f.order.push("start");
        expect(options.config).toEqual(config);
        return f.next;
      });
      const operation = f.trigger(route);
      await vi.runAllTimersAsync();
      expect(f.order).toEqual(["stop-enter"]);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(resolveCopilotLaunch).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      finish();
      await vi.runAllTimersAsync();
      const result = await operation;
      if (route === "context") expect(result).toMatchObject({ ok: true });
      expect(f.order).toEqual(["stop-enter", "stop-quiesced", "start"]);
      expect(f.old.stop).toHaveBeenCalledExactlyOnceWith(false);
      const options: StartAgentOptions = f.start.mock.calls[1]![3]!;
      expect(options).toMatchObject({
        resumeAgentSessionId: "saved-native",
        additionalDirectories: ["C:\\inert-shared"],
        yolo: true,
        agencyMode,
        contextTier: route === "context" ? "default" : "long_context",
        mcpServers: [{ name: "fleet", url: "http://127.0.0.1:8787/mcp", headers: [] }],
        config,
        announceLifecycle: false,
        ...(agentParams ? { agentParams } : {}),
      });
      expect(f.slot.agent).toBe(f.next);
      expect(f.router.activeSessionIds).toEqual(["s1"]);
      expect(f.next.stop).not.toHaveBeenCalled();
      expect(f.launchingNative).toHaveBeenCalledOnce();
    },
  );
});
