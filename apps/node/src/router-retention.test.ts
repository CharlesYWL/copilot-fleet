import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_RETENTION_DAY_MS as DAY,
  type NodeCommand,
  type SessionEvent,
} from "@fleet/protocol";
import type { AgentFactory, EventSink, SessionAgent } from "./agents.js";
import { CommandRouter, type CommandRouterOptions } from "./router.js";

const STARTED_AT = Date.parse("2026-07-01T00:00:00.000Z");
type DeleteCommand = Extract<NodeCommand, { type: "delete_session" }>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cleanup(overrides: Partial<DeleteCommand> = {}): DeleteCommand {
  return {
    type: "delete_session",
    commandId: "cleanup",
    sessionId: "fleet-1",
    agentSessionId: "copilot-1",
    inactiveBefore: new Date(Date.now() - 30 * DAY).toISOString(),
    retentionDays: 30,
    ...overrides,
  };
}

function setup(options: { withoutAgentId?: boolean; noDelete?: boolean } = {}) {
  let busy = false;
  let sequence = 0;
  const events: SessionEvent[] = [];
  const sinks: EventSink[] = [];
  const agent = {
    prompt: vi.fn<SessionAgent["prompt"]>(async () => {}),
    cancel: vi.fn<SessionAgent["cancel"]>(async () => {}),
    stop: vi.fn<SessionAgent["stop"]>(async () => {}),
    setConfigOption: vi.fn<SessionAgent["setConfigOption"]>(async () => {}),
    resolvePermission: vi.fn<SessionAgent["resolvePermission"]>(),
    denyPendingPermissions: vi.fn(),
    resync: vi.fn(),
    get busy() {
      return busy;
    },
  } satisfies SessionAgent;
  const event = (
    type: SessionEvent["type"],
    payload: Record<string, unknown> = {},
    createdAt = new Date().toISOString(),
  ): SessionEvent => ({
    eventId: `event-${++sequence}`,
    sessionId: "fleet-1",
    sequence,
    type,
    payload,
    createdAt,
  });
  const send = (
    type: SessionEvent["type"],
    payload: Record<string, unknown> = {},
    createdAt?: string,
  ) => sinks.at(-1)!(event(type, payload, createdAt));
  const factory = {
    start: vi.fn<AgentFactory["start"]>(async (_id, _cwd, sink) => {
      sinks.push(sink);
      if (!options.withoutAgentId) {
        send("agent_session", { agentSessionId: "copilot-1" });
      }
      return agent;
    }),
  };
  const persistedDeletes: string[] = [];
  const remove = vi.fn<NonNullable<CommandRouterOptions["deleteInactiveSession"]>>(
    async (id, _cutoff, beforeDelete) => {
      await beforeDelete();
      persistedDeletes.push(id);
    },
  );
  const router = new CommandRouter(
    factory,
    2,
    (item) => events.push(item),
    async (path) => path,
    () => "http://127.0.0.1:8787",
    async () => [],
    () => {},
    options.noDelete ? {} : { deleteInactiveSession: remove },
  );
  const common = {
    commandId: "launch",
    sessionId: "fleet-1",
    localPath: "C:\\retention-fixture",
    yolo: false,
    mcpServers: [],
    agent: "",
    readOnly: false,
    config: [],
  };
  const launchCommand: Extract<
    NodeCommand,
    { type: "start_session" | "resume_session" }
  > = options.withoutAgentId
    ? { ...common, type: "start_session", prompt: "hello" }
    : {
        ...common,
        type: "resume_session",
        agentSessionId: "copilot-1",
        sequenceOffset: 0,
        additionalDirectories: [],
      };
  return {
    router,
    agent,
    factory,
    remove,
    persistedDeletes,
    events,
    sinks,
    send,
    event,
    launchCommand,
    launch: () => router.route(launchCommand),
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(STARTED_AT);
});
afterEach(() => vi.useRealTimers());

describe("CommandRouter session retention", () => {
  it.each([
    [29 * DAY, false],
    [30 * DAY - 1, false],
    [30 * DAY, true],
  ])("guards the inclusive thirty-day boundary at %i ms", async (age, ok) => {
    const { router, launch, agent, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + age);
    expect(await router.route(cleanup())).toMatchObject({
      ok,
      ...(ok ? {} : { fatal: false }),
    });
    expect(remove).toHaveBeenCalledTimes(ok ? 1 : 0);
    expect(agent.stop).toHaveBeenCalledTimes(ok ? 1 : 0);
    if (ok) {
      expect(agent.stop).toHaveBeenCalledWith(false);
      expect(router.activeSessionIds).toEqual([]);
    }
  });

  it("clamps a future Host clock to the Node's retention cutoff", async () => {
    const { router, launch, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 29 * DAY);
    const futureCutoff = new Date(STARTED_AT + 365 * DAY).toISOString();
    expect(await router.route(cleanup({ inactiveBefore: futureCutoff }))).toMatchObject({
      ok: false,
      fatal: false,
    });
    expect(remove).not.toHaveBeenCalled();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    expect((await router.route(cleanup({ inactiveBefore: futureCutoff }))).ok).toBe(true);
    expect(remove).toHaveBeenCalledWith("copilot-1", STARTED_AT, expect.any(Function));
  });

  it("honors a more conservative Host cutoff and a longer retention policy", async () => {
    const { router, launch, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 59 * DAY);
    expect(
      (
        await router.route(
          cleanup({
            inactiveBefore: new Date(STARTED_AT - 1).toISOString(),
          }),
        )
      ).ok,
    ).toBe(false);
    expect((await router.route(cleanup({ retentionDays: 60 }))).ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    vi.setSystemTime(STARTED_AT + 60 * DAY);
    expect((await router.route(cleanup({ retentionDays: 60 }))).ok).toBe(true);
    expect(remove).toHaveBeenCalledWith("copilot-1", STARTED_AT, expect.any(Function));
  });

  it.each([0, 29, 30.5, 36_501])(
    "rejects an invalid deletion retention policy %s",
    async (retentionDays) => {
      const { router, remove } = setup();
      expect(await router.route(cleanup({ retentionDays }))).toMatchObject({
        ok: false,
        fatal: false,
      });
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid inactivity cutoff without calling Copilot", async () => {
    const { router, remove } = setup();
    expect(await router.route(cleanup({ inactiveBefore: "invalid" }))).toMatchObject({
      ok: false,
      fatal: false,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("never interrupts an old but busy session", async () => {
    const { router, launch, setBusy, agent, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 90 * DAY);
    setBusy(true);
    expect(await router.route(cleanup())).toMatchObject({
      ok: false,
      fatal: false,
      error: expect.stringContaining("session_active"),
    });
    expect(remove).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
    expect(router.busySessionIds).toEqual(["fleet-1"]);
  });

  it.each([
    "agent_text",
    "agent_thought",
    "tool",
    "permission",
    "permission_result",
    "turn_complete",
    "error",
    "system",
  ] as const)("uses local arrival time for real %s activity", async (type) => {
    const { router, launch, send, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    send(type, { text: "User: hello" }, new Date(STARTED_AT).toISOString());
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not renew retention for inventory, state resync, replay, or maintenance notices", async () => {
    const { router, launch, send } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    send("state", { state: "idle", activity: "Resynced" });
    send("commands", { commands: [] });
    send("config", { options: [] });
    send("agent_session", { agentSessionId: "copilot-1" });
    send("system", { text: "Fleet maintenance" });
    send("agent_text", { text: "Replayed history", historyReplay: true });
    expect((await router.route(cleanup())).ok).toBe(true);
  });

  const realCommands: NodeCommand[] = [
    {
      type: "prompt",
      commandId: "prompt",
      sessionId: "fleet-1",
      prompt: "hello",
      attachments: [],
    },
    { type: "cancel", commandId: "cancel", sessionId: "fleet-1" },
    {
      type: "set_config_option",
      commandId: "config",
      sessionId: "fleet-1",
      configId: "model",
      value: "deep",
    },
    {
      type: "permission_response",
      commandId: "permission",
      sessionId: "fleet-1",
      requestId: "p1",
      outcome: "deny",
    },
  ];
  it.each(realCommands)(
    "renews inactivity for an accepted $type command",
    async (command) => {
      const { router, launch, remove } = setup();
      await launch();
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      expect((await router.route(command)).ok).toBe(true);
      expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("renews inactivity for a new resume command even when the slot is already present", async () => {
    const { router, launch, launchCommand, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    await router.route({ ...launchCommand, commandId: "resume-again" });
    expect((await router.route(cleanup())).ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["prompt", "config"] as const)(
    "refuses an old in-flight %s even if busy is false",
    async (kind) => {
      const { router, launch, agent, remove } = setup();
      await launch();
      const gate = deferred();
      if (kind === "prompt") agent.prompt.mockReturnValueOnce(gate.promise);
      else agent.setConfigOption.mockReturnValueOnce(gate.promise);
      const pending = router.route(realCommands[kind === "prompt" ? 0 : 2]!);
      await Promise.resolve();
      vi.setSystemTime(STARTED_AT + 60 * DAY);
      expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
      expect(remove).not.toHaveBeenCalled();
      expect(agent.stop).not.toHaveBeenCalled();
      gate.resolve();
      await pending;
      expect((await router.route(cleanup())).ok).toBe(false);
    },
  );

  it("refuses initialization still in flight rather than waiting to stop it", async () => {
    const { router, factory, launch, agent, remove } = setup();
    const gate = deferred();
    const entered = deferred();
    factory.start.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return agent;
    });
    const starting = launch();
    await entered.promise;
    vi.setSystemTime(STARTED_AT + 60 * DAY);
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
    expect(remove).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
    gate.resolve();
    await starting;
  });

  it.each(["event", "busy", "identity", "terminal"] as const)(
    "rechecks local %s changes while ACP listing is deferred",
    async (change) => {
      const { router, launch, send, setBusy, agent, remove, persistedDeletes } = setup();
      await launch();
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      const gate = deferred();
      remove.mockImplementationOnce(async (id, _cutoff, beforeDelete) => {
        await gate.promise;
        await beforeDelete();
        persistedDeletes.push(id);
      });
      const pending = router.route(cleanup());
      expect(remove).toHaveBeenCalledOnce();
      if (change === "event") send("agent_text", { text: "New work" });
      if (change === "busy") setBusy(true);
      if (change === "identity")
        send("agent_session", { agentSessionId: "other-copilot" });
      if (change === "terminal") send("state", { state: "completed" });
      gate.resolve();
      expect(await pending).toMatchObject({ ok: false, fatal: false });
      expect(agent.stop).not.toHaveBeenCalled();
      expect(persistedDeletes).toEqual([]);
    },
  );

  it("locks commands and MCP refresh while deleting, deduplicates retries, and fences late events", async () => {
    const {
      router,
      launchCommand,
      factory,
      agent,
      remove,
      persistedDeletes,
      events,
      sinks,
      event,
    } = setup();
    const launch = {
      ...launchCommand,
      mcpServers: [{ name: "fleet", url: "http://old.example/mcp", headers: [] }],
    };
    await router.route(launch);
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    const gate = deferred();
    remove.mockImplementationOnce(async (id, _cutoff, beforeDelete) => {
      await gate.promise;
      await beforeDelete();
      persistedDeletes.push(id);
    });
    const command = cleanup();
    const pending = router.route(command);
    const duplicate = router.route(command);
    for (const blocked of [
      ...realCommands,
      { ...launch, commandId: "resume-concurrently" },
      { ...launch, sessionId: "fleet-alias", commandId: "resume-alias-concurrently" },
      {
        ...launch,
        type: "start_session" as const,
        prompt: "revive",
        commandId: "start-concurrently",
      },
      cleanup({ commandId: "other-cleanup" }),
    ]) {
      expect(await router.route(blocked)).toMatchObject({ ok: false, fatal: false });
    }
    await router.refreshMcpSessions();
    expect(factory.start).toHaveBeenCalledOnce();
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.setConfigOption).not.toHaveBeenCalled();
    gate.resolve();
    expect(await pending).toEqual({ commandId: "cleanup", ok: true });
    expect(await duplicate).toEqual(await router.route(command));
    expect(remove).toHaveBeenCalledOnce();
    expect(agent.stop).toHaveBeenCalledExactlyOnceWith(false);
    expect(persistedDeletes).toEqual(["copilot-1"]);
    const emitted = events.length;
    sinks[0]!(event("agent_text", { text: "Late output" }));
    sinks[0]!(event("state", { state: "failed" }));
    expect(events).toHaveLength(emitted);
    expect(router.activeSessionIds).toEqual([]);
    // Old launch deduplication is gone, but the deleted Fleet id cannot be revived.
    expect(await router.route(launch)).toMatchObject({ ok: false, fatal: false });
    expect((await router.route(cleanup({ commandId: "retry" }))).ok).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does not delete if new activity arrives while the idle process is stopping", async () => {
    const { router, launch, send, agent, persistedDeletes } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    agent.stop.mockImplementationOnce(async () => {
      send("agent_text", { text: "Raced output" });
    });
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
    expect(persistedDeletes).toEqual([]);
    expect(router.activeSessionIds).toEqual([]);
  });

  it.each(["before-stop", "stop", "after-stop"] as const)(
    "allows cleanup retry after a %s failure without fatal session results",
    async (when) => {
      const { router, launch, agent, remove, persistedDeletes } = setup();
      await launch();
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      if (when === "stop") agent.stop.mockRejectedValueOnce(new Error("Could not stop"));
      else
        remove.mockImplementationOnce(async (_id, _cutoff, beforeDelete) => {
          if (when === "after-stop") await beforeDelete();
          throw new Error("Copilot refused deletion");
        });
      const command = cleanup();
      expect(await router.route(command)).toMatchObject({ ok: false, fatal: false });
      expect(router.activeSessionIds).toEqual(when === "after-stop" ? [] : ["fleet-1"]);
      expect(persistedDeletes).toEqual([]);
      expect((await router.route(command)).ok).toBe(true);
      expect(persistedDeletes).toEqual(["copilot-1"]);
    },
  );

  it("allows a normal resume after the process stopped but persisted deletion failed", async () => {
    const { router, launch, launchCommand, remove, factory, events } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    remove.mockImplementationOnce(async (_id, _cutoff, beforeDelete) => {
      await beforeDelete();
      throw new Error("Offline");
    });
    expect((await router.route(cleanup())).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "state",
      payload: { state: "stopped" },
    });
    expect(
      (await router.route({ ...launchCommand, commandId: "resume-after-failure" })).ok,
    ).toBe(true);
    expect(factory.start).toHaveBeenCalledTimes(2);
    expect((await router.route(cleanup())).ok).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("requires a deletion implementation and its final inactivity guard", async () => {
    const absent = setup({ noDelete: true });
    await absent.launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    expect(await absent.router.route(cleanup())).toMatchObject({
      ok: false,
      fatal: false,
      error: expect.stringContaining("unsupported_delete"),
    });
    expect(absent.agent.stop).not.toHaveBeenCalled();

    vi.setSystemTime(STARTED_AT);
    const unchecked = setup();
    await unchecked.launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    unchecked.remove.mockResolvedValueOnce();
    expect(await unchecked.router.route(cleanup())).toMatchObject({
      ok: false,
      fatal: false,
    });
    expect(unchecked.agent.stop).not.toHaveBeenCalled();
  });

  it.each(["", "other-copilot"])(
    "refuses the mismatched Copilot id %j",
    async (agentSessionId) => {
      const { router, launch, agent, remove } = setup();
      await launch();
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      expect(await router.route(cleanup({ agentSessionId }))).toMatchObject({
        ok: false,
        fatal: false,
        error: expect.stringContaining("session_identity_mismatch"),
      });
      expect(remove).not.toHaveBeenCalled();
      expect(agent.stop).not.toHaveBeenCalled();
    },
  );

  it("cleans up never-started Fleet rows without any Copilot process", async () => {
    const { router, factory, remove } = setup();
    expect((await router.route(cleanup({ agentSessionId: "" }))).ok).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("does not stop an old idle slot whose Copilot id cannot be verified", async () => {
    const { router, launch, agent, remove } = setup({ withoutAgentId: true });
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    expect(await router.route(cleanup({ agentSessionId: "" }))).toMatchObject({
      ok: false,
      fatal: false,
      error: expect.stringContaining("session_identity_mismatch"),
    });
    expect(agent.stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses deletion when another Fleet slot is using the same Copilot conversation", async () => {
    const { router, launchCommand, factory, agent, remove } = setup();
    factory.start.mockImplementationOnce(async () => agent);
    await router.route({ ...launchCommand, sessionId: "fleet-alias" });
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    expect(await router.route(cleanup())).toMatchObject({
      ok: false,
      fatal: false,
      error: expect.stringContaining("session_active"),
    });
    expect(remove).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
  });

  it("retains recent activity and the exact Copilot identity after a terminal slot is released", async () => {
    const { router, launch, send, remove } = setup();
    await launch();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    send("turn_complete");
    send("state", { state: "completed" });
    expect(router.activeSessionIds).toEqual([]);
    expect((await router.route(cleanup())).ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    vi.setSystemTime(STARTED_AT + 60 * DAY);
    expect((await router.route(cleanup({ agentSessionId: "" }))).ok).toBe(false);
    expect((await router.route(cleanup())).ok).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("tags internal MCP replay without suppressing it or renewing retention", async () => {
    const { router, launchCommand, factory, agent, event, events } = setup();
    await router.route({
      ...launchCommand,
      mcpServers: [{ name: "fleet", url: "http://old.example/mcp", headers: [] }],
    });
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    const replay = [
      event("agent_text", { text: "Previous answer" }),
      event("agent_thought", { text: "Previous reasoning" }),
      event("system", { text: "User: Previous prompt" }),
      event("turn_complete"),
    ];
    factory.start.mockImplementationOnce(async (_id, _cwd, sink, options) => {
      expect(options?.announceLifecycle).toBe(false);
      for (const item of replay) sink(item);
      return agent;
    });

    await router.refreshMcpSessions();

    const replayIds = new Set(replay.map((item) => item.eventId));
    expect(events.filter((item) => replayIds.has(item.eventId))).toEqual(
      replay.map((item) => ({
        ...item,
        sequence: item.sequence + 1,
        payload: { ...item.payload, historyReplay: true },
      })),
    );
    expect(replay.every((item) => item.payload.historyReplay === undefined)).toBe(true);
    expect((await router.route(cleanup())).ok).toBe(true);
  });

  it("does not tag live output after an internal reload has finished", async () => {
    const { router, launchCommand, factory, agent, event, events } = setup();
    await router.route({
      ...launchCommand,
      mcpServers: [{ name: "fleet", url: "http://old.example/mcp", headers: [] }],
    });
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    let refreshedSink!: EventSink;
    factory.start.mockImplementationOnce(async (_id, _cwd, sink) => {
      refreshedSink = sink;
      sink(event("agent_text", { text: "Previous answer" }));
      return agent;
    });
    await router.refreshMcpSessions();

    const previousSequence = events.at(-1)!.sequence;
    const live = event("agent_text", { text: "New autonomous turn" });
    refreshedSink(live);
    expect(events.at(-1)).toEqual({ ...live, sequence: previousSequence + 1 });
    expect(events.at(-1)?.payload.historyReplay).toBeUndefined();
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
  });

  it("does not tag a user-initiated resume, which resets local activity", async () => {
    const { router, launch, factory, agent, event, events } = setup();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    const replay = event("agent_text", { text: "User-requested resume" });
    factory.start.mockImplementationOnce(async (_id, _cwd, sink, options) => {
      expect(options?.announceLifecycle).toBeUndefined();
      sink(replay);
      return agent;
    });
    await launch();
    expect(events.at(-1)).toEqual(replay);
    expect(events.at(-1)?.payload.historyReplay).toBeUndefined();
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
  });

  it.each([true, false])(
    "preserves original activity only for automatic resume (%s)",
    async (automatic) => {
      const { router, launchCommand, factory, agent, event, events, remove } = setup();
      vi.setSystemTime(STARTED_AT + 29 * DAY);
      const command = {
        ...launchCommand,
        ...(automatic ? { lastActivityAt: new Date(STARTED_AT).toISOString() } : {}),
      };
      factory.start.mockImplementationOnce(async (_id, _cwd, sink) => {
        sink(event("agent_text", { text: "Recovered answer" }));
        sink(event("agent_thought", { text: "Recovered reasoning" }));
        return agent;
      });
      expect((await router.route(command)).ok).toBe(true);
      expect(
        events.every(
          (item) => item.payload.historyReplay === (automatic ? true : undefined),
        ),
      ).toBe(true);
      expect((await router.route(cleanup())).ok).toBe(false);
      expect(remove).not.toHaveBeenCalled();

      if (automatic) {
        vi.setSystemTime(STARTED_AT + 29.5 * DAY);
        await router.route({ ...command, commandId: "repeated-auto-resume" });
        expect(factory.start).toHaveBeenCalledOnce();
      }
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      expect((await router.route(cleanup())).ok).toBe(automatic);
      if (automatic) {
        expect(remove).toHaveBeenCalledWith(
          "copilot-1",
          STARTED_AT,
          expect.any(Function),
        );
      } else {
        vi.setSystemTime(STARTED_AT + 59 * DAY);
        expect((await router.route(cleanup())).ok).toBe(true);
      }
    },
  );

  it.each([false, true])(
    "does not overwrite newer Node activity during automatic resume (released slot: %s)",
    async (released) => {
      const { router, launch, launchCommand, send } = setup();
      await launch();
      vi.setSystemTime(STARTED_AT + 28 * DAY);
      send("agent_text", { text: "Newer local activity" });
      if (released) send("state", { state: "completed" });
      vi.setSystemTime(STARTED_AT + 29 * DAY);
      const command = {
        ...launchCommand,
        commandId: "automatic-recovery",
        lastActivityAt: new Date(STARTED_AT).toISOString(),
      };
      await router.route(command);
      vi.setSystemTime(STARTED_AT + 30 * DAY);
      expect((await router.route(cleanup())).ok).toBe(false);
      vi.setSystemTime(STARTED_AT + 58 * DAY);
      expect((await router.route(cleanup())).ok).toBe(true);
    },
  );

  it("clamps a future automatic-resume activity timestamp to the local clock", async () => {
    const { router, launchCommand } = setup();
    vi.setSystemTime(STARTED_AT + 29 * DAY);
    const command = {
      ...launchCommand,
      lastActivityAt: new Date(STARTED_AT + 365 * DAY).toISOString(),
    };
    await router.route(command);
    vi.setSystemTime(STARTED_AT + 58 * DAY);
    expect((await router.route(cleanup())).ok).toBe(false);
    vi.setSystemTime(STARTED_AT + 59 * DAY);
    expect((await router.route(cleanup())).ok).toBe(true);
  });

  it("counts real output after automatic recovery without tagging it as replay", async () => {
    const { router, launchCommand, factory, agent, event, events } = setup();
    vi.setSystemTime(STARTED_AT + 29 * DAY);
    let recoveredSink!: EventSink;
    factory.start.mockImplementationOnce(async (_id, _cwd, sink) => {
      recoveredSink = sink;
      sink(event("agent_text", { text: "Recovered answer" }));
      return agent;
    });
    const command = {
      ...launchCommand,
      lastActivityAt: new Date(STARTED_AT).toISOString(),
    };
    await router.route(command);
    const live = event("agent_text", { text: "New work after recovery" });
    recoveredSink(live);
    expect(events.at(-1)).toEqual(live);
    expect(events.at(-1)?.payload.historyReplay).toBeUndefined();
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    expect((await router.route(cleanup())).ok).toBe(false);
    vi.setSystemTime(STARTED_AT + 59 * DAY);
    expect((await router.route(cleanup())).ok).toBe(true);
  });

  it("refuses an invalid automatic-resume clock without starting an agent", async () => {
    const { router, launchCommand, factory } = setup();
    const command = { ...launchCommand, lastActivityAt: "invalid" };
    expect(await router.route(command)).toMatchObject({ ok: false, fatal: false });
    expect(factory.start).not.toHaveBeenCalled();
  });

  it("does not run a pending idle refresh while the session is locked for deletion", async () => {
    const { router, launchCommand, setBusy, send, factory, agent, remove } = setup();
    await router.route({
      ...launchCommand,
      mcpServers: [{ name: "fleet", url: "http://old.example/mcp", headers: [] }],
    });
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    setBusy(true);
    await router.refreshMcpSessions();
    setBusy(false);
    const gate = deferred();
    remove.mockImplementationOnce(async (_id, _cutoff, beforeDelete) => {
      await gate.promise;
      await beforeDelete();
    });
    const pending = router.route(cleanup());

    send("state", { state: "idle" });
    await router.refreshMcpSessions();
    expect(factory.start).toHaveBeenCalledOnce();
    expect(agent.stop).not.toHaveBeenCalled();
    gate.resolve();
    expect((await pending).ok).toBe(true);
    send("state", { state: "idle" });
    expect(factory.start).toHaveBeenCalledOnce();
    expect(agent.stop).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not count an MCP refresh as activity, but refuses cleanup while it is in flight", async () => {
    const { router, launchCommand, factory, agent, remove } = setup();
    await router.route({
      ...launchCommand,
      mcpServers: [{ name: "fleet", url: "http://old.example/mcp", headers: [] }],
    });
    vi.setSystemTime(STARTED_AT + 30 * DAY);
    const entered = deferred();
    const gate = deferred();
    factory.start.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return agent;
    });
    const refresh = router.refreshMcpSessions();
    await entered.promise;
    expect(await router.route(cleanup())).toMatchObject({ ok: false, fatal: false });
    expect(remove).not.toHaveBeenCalled();
    gate.resolve();
    await refresh;
    expect((await router.route(cleanup())).ok).toBe(true);
  });
});
