import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { NodeCommand, SessionEvent } from "@fleet/protocol";
import { AgentStartupCleanupError, type AgentFactory, type EventSink } from "./agents.js";
import { CommandRouter, type CommandRouterOptions } from "./router.js";
import { LeadPromptJournal } from "./lead-prompt-delivery.js";
import { NodeAdmission } from "./node-admission.js";
import { RepositoryParticipation } from "./repository-participation.js";
import type { CheckoutLease } from "./checkout-locks.js";
import { MCP_CONNECTION_STABLE_MS, MCP_RECOVERY_DELAYS_MS } from "./mcp-recovery.js";

const resume = (
  sessionId = "lead",
): Extract<NodeCommand, { type: "resume_session" }> => ({
  type: "resume_session",
  commandId: `resume-${sessionId}`,
  sessionId,
  localPath: "C:\\checkout",
  agentSessionId: `saved-${sessionId}`,
  additionalDirectories: ["C:\\shared"],
  sequenceOffset: 10,
  yolo: true,
  readOnly: true,
  mcpServers: sessionId === "lead" ? [{ name: "fleet", url: "/mcp", headers: [] }] : [],
  agent: "",
  config: [{ id: "model", value: "chosen-model" }],
});

function agent() {
  return {
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    resolvePermission: vi.fn(),
    denyPendingPermissions: vi.fn(),
    setConfigOption: vi.fn(async () => {}),
    busy: false,
    resync: vi.fn(),
  };
}

const journals: { journal: LeadPromptJournal; directory: string }[] = [];
function deliveryJournal() {
  const directory = resolve(`.lead-delivery-test-${randomUUID()}`);
  const journal = new LeadPromptJournal(directory, () => {}, false);
  journals.push({ journal, directory });
  return journal;
}

async function setup(options: CommandRouterOptions = {}) {
  const events: SessionEvent[] = [];
  const agents: ReturnType<typeof agent>[] = [];
  const sinks: EventSink[] = [];
  const start = vi.fn<AgentFactory["start"]>(async (id, _cwd, sink, options = {}) => {
    const next = agent();
    agents.push(next);
    sinks.push(sink);
    sink({
      eventId: `agent-${agents.length}`,
      sessionId: id,
      sequence: (options.sequenceOffset ?? 0) + 1,
      type: "agent_session",
      payload: { agentSessionId: options.resumeAgentSessionId ?? `saved-${id}` },
      createdAt: new Date().toISOString(),
    });
    sink({
      eventId: `idle-${agents.length}`,
      sessionId: id,
      sequence: (options.sequenceOffset ?? 0) + 2,
      type: "state",
      payload: { state: "idle", activity: "Ready" },
      createdAt: new Date().toISOString(),
    });
    return next;
  });
  const router = new CommandRouter(
    { start },
    4,
    (event) => events.push(event),
    async (path) => path,
    () => "http://localhost:8787",
    async () => [],
    () => {},
    options,
  );
  expect((await router.route(resume())).ok).toBe(true);
  return { router, start, events, agents, sinks };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const failures = (events: SessionEvent[]) =>
  events.filter((event) => event.type === "state" && event.payload.state === "failed");

describe("bounded MCP session recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const { journal, directory } of journals.splice(0)) {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("defers recovery for a durable prompt and does not advertise recovery until that turn settles", async () => {
    const journal = deliveryJournal();
    const f = await setup({ leadDeliveries: journal });
    let finish!: () => void;
    f.agents[0]!.prompt.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = {
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "command result",
    };
    expect((await f.router.deliverLeadPrompt("host", delivery)).state).toBe("accepted");
    await f.router.refreshMcpSessions();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.agents[0]!.stop).not.toHaveBeenCalled();
    expect(f.router.busySessionIds).toContain("lead");
    f.sinks[0]!({
      eventId: "waiting-idle",
      sessionId: "lead",
      sequence: 13,
      type: "state",
      payload: { state: "idle", activity: "Ready" },
      createdAt: new Date().toISOString(),
    });
    expect(f.events.at(-1)?.payload.state).toBe("idle");
    f.sinks[0]!({
      eventId: "completed",
      sessionId: "lead",
      sequence: 14,
      type: "turn_complete",
      payload: { stopReason: "end_turn" },
      createdAt: new Date().toISOString(),
    });
    finish();
    await flush();
    expect(journal.reserved("lead", "saved-lead")).toBe(false);
    f.sinks[0]!({
      eventId: "settled-idle",
      sessionId: "lead",
      sequence: 15,
      type: "state",
      payload: { state: "idle", activity: "Ready" },
      createdAt: new Date().toISOString(),
    });
    await flush();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.agents[0]!.prompt).toHaveBeenCalledTimes(1);
    expect(failures(f.events)).toEqual([]);
  });

  it("rejects new durable handoffs as busy while recovery waits for reconnect", async () => {
    const journal = deliveryJournal();
    const f = await setup({ leadDeliveries: journal });
    f.router.setMcpAvailable(false);
    const recovery = f.router.refreshMcpSessions();
    await flush();
    const receipt = await f.router.deliverLeadPrompt("host", {
      deliveryId: randomUUID(),
      sessionId: "lead",
      prompt: "do not queue behind recovery",
    });
    expect(receipt.state).toBe("rejected_busy");
    expect(f.agents[0]!.prompt).not.toHaveBeenCalled();
    f.router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(MCP_CONNECTION_STABLE_MS);
    await recovery;
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.agents.every((agent) => agent.prompt.mock.calls.length === 0)).toBe(true);
  });

  it("does not replace a healthy session while Node maintenance has closed admission", async () => {
    const admission = new NodeAdmission();
    const f = await setup({ admission });
    const reopen = admission.close("Maintenance");
    await f.router.refreshMcpSessions();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.router.activeSessionIds).toContain("lead");
    expect(failures(f.events)).toEqual([]);
    reopen();
    await f.router.refreshMcpSessions();
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("persists unknown shared participation after MCP shutdown retries are exhausted", async () => {
    const lease: CheckoutLease = {
      key: "source",
      owner: "session:lead",
      release: vi.fn(),
      revalidate: vi.fn(async () => {}),
      processPending: vi.fn(),
      processStarted: vi.fn(),
      processesQuiesced: vi.fn(),
      requireReconciliation: vi.fn(),
      reattach: vi.fn(),
    };
    const repositories = new RepositoryParticipation();
    vi.spyOn(repositories, "participate").mockResolvedValue({
      leases: [lease],
      supervised: true,
    });
    const f = await setup({ repositories });
    f.agents[0]!.stop.mockRejectedValue(new Error("Process exit not verified"));
    const recovery = f.router.refreshMcpSessions();
    await flush();
    for (const delay of MCP_RECOVERY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    await recovery;
    expect(lease.requireReconciliation).toHaveBeenCalledWith(
      expect.stringContaining("MCP recovery blocked"),
    );
    expect(lease.release).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("retries cleanup before replacement without prompting or disturbing workers", async () => {
    const { router, start, agents, events } = await setup();
    await router.route(resume("worker"));
    agents[0]!.stop.mockRejectedValueOnce(new Error("Process exit not verified"));
    const recovery = router.refreshMcpSessions();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(router.activeSessionIds).toEqual(["lead", "worker"]);
    expect(router.busySessionIds).toContain("lead");
    expect(failures(events)).toEqual([]);
    const repeated = router.refreshMcpSessions();
    await vi.advanceTimersByTimeAsync(MCP_RECOVERY_DELAYS_MS[0]);
    await Promise.all([recovery, repeated]);
    expect(agents[0]!.stop).toHaveBeenCalledTimes(2);
    expect(agents[1]!.stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2]?.[3]).toMatchObject({
      resumeAgentSessionId: "saved-lead",
      allowResumeRollover: false,
      additionalDirectories: ["C:\\shared"],
      config: [{ id: "model", value: "chosen-model" }],
      mcpServers: [{ name: "fleet", url: "http://localhost:8787/mcp", headers: [] }],
    });
    expect(agents.every((entry) => entry.prompt.mock.calls.length === 0)).toBe(true);
    expect(failures(events)).toEqual([]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "idle" });
    expect(router.busySessionIds).not.toContain("lead");
  });

  it("suppresses transient startup failure and pauses retries while disconnected", async () => {
    const { router, start, events } = await setup();
    start.mockImplementationOnce(async (id, _cwd, sink, options = {}) => {
      sink({
        eventId: "transient-startup-failure",
        sessionId: id,
        sequence: (options.sequenceOffset ?? 0) + 1,
        type: "state",
        payload: { state: "failed", activity: "MCP initialization timeout" },
        createdAt: new Date().toISOString(),
      });
      throw new Error("MCP initialization timeout");
    });
    const recovery = router.refreshMcpSessions();
    await flush();
    expect(failures(events)).toEqual([]);
    expect(router.activeSessionIds).toContain("lead");
    expect(
      await router.route({
        type: "prompt",
        commandId: "new-prompt",
        sessionId: "lead",
        prompt: "do not replay",
        attachments: [],
      }),
    ).toMatchObject({ ok: false, fatal: false });
    expect(
      await router.route({ ...resume(), commandId: "duplicate-resume" }),
    ).toMatchObject({ ok: false, fatal: false });
    router.setMcpAvailable(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(start).toHaveBeenCalledTimes(2);
    router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(MCP_CONNECTION_STABLE_MS - 1);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await recovery;
    expect(start).toHaveBeenCalledTimes(3);
    expect(failures(events)).toEqual([]);
  });

  it("does not touch a retained agent until the reconnect has stabilized", async () => {
    const { router, start, agents } = await setup();
    router.setMcpAvailable(false);
    const recovery = router.refreshMcpSessions();
    await flush();
    router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(2_000);
    router.setMcpAvailable(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(agents[0]!.stop).not.toHaveBeenCalled();
    router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(MCP_CONNECTION_STABLE_MS);
    await recovery;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps a deferred lead busy until MCP restoration finishes", async () => {
    const { router, agents, events, sinks } = await setup();
    agents[0]!.busy = true;
    await router.refreshMcpSessions();
    const before = events.length;
    agents[0]!.busy = false;
    sinks[0]!({
      eventId: "turn-idle",
      sessionId: "lead",
      sequence: 13,
      type: "state",
      payload: { state: "idle", activity: "Ready" },
      createdAt: new Date().toISOString(),
    });
    expect(events.at(-1)?.payload.state).toBe("running");
    await flush();
    expect(
      events.slice(before).filter((event) => event.payload.state === "idle"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          activity: "MCP tools restored; ready for follow-up",
        }),
      }),
    ]);
  });

  it("keeps subsequent live events ahead of recovery notices and ignores retired sinks", async () => {
    const { router, start, events, sinks } = await setup();
    await router.refreshMcpSessions();
    const previousSequence = events.at(-1)!.sequence;
    const sequence = start.mock.calls[1]![3]!.sequenceOffset! + 3;
    sinks[0]!({
      eventId: "retired",
      sessionId: "lead",
      sequence: 999,
      type: "state",
      payload: { state: "failed", activity: "Old process" },
      createdAt: new Date().toISOString(),
    });
    expect(events.at(-1)!.sequence).toBe(previousSequence);
    sinks[1]!({
      eventId: "live",
      sessionId: "lead",
      sequence,
      type: "state",
      payload: { state: "running", activity: "New turn" },
      createdAt: new Date().toISOString(),
    });
    expect(events.at(-1)).toMatchObject({
      eventId: "live",
      payload: { state: "running", activity: "New turn" },
    });
    expect(events.at(-1)!.sequence).toBeGreaterThan(previousSequence);
    expect(events.at(-1)!.payload.historyReplay).toBeUndefined();
    sinks[1]!({
      eventId: "ordinary-failure",
      sessionId: "lead",
      sequence: sequence + 1,
      type: "state",
      payload: { state: "failed", activity: "Task failed" },
      createdAt: new Date().toISOString(),
    });
    expect(router.activeSessionIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not let an old connection wait mutate a manually replaced session", async () => {
    const { router, start, agents, sinks, events } = await setup();
    router.setMcpAvailable(false);
    const recovery = router.refreshMcpSessions();
    await flush();
    sinks[0]!({
      eventId: "natural-exit",
      sessionId: "lead",
      sequence: 13,
      type: "state",
      payload: { state: "failed", activity: "Copilot exited" },
      createdAt: new Date().toISOString(),
    });
    expect(router.activeSessionIds).toEqual([]);
    expect(
      (await router.route({ ...resume(), commandId: "manual-replacement" })).ok,
    ).toBe(true);
    const eventCount = events.length;
    router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(MCP_CONNECTION_STABLE_MS);
    await recovery;
    expect(start).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(eventCount);
    expect(agents.every((entry) => entry.stop.mock.calls.length === 0)).toBe(true);
  });

  it.each(["stop", "shutdown"] as const)(
    "cancels retry backoff on %s",
    async (operation) => {
      const { router, start, events } = await setup();
      start.mockRejectedValueOnce(new Error("MCP unavailable"));
      const recovery = router.refreshMcpSessions();
      await flush();
      if (operation === "stop") {
        expect(
          await router.route({ type: "stop", commandId: "stop", sessionId: "lead" }),
        ).toMatchObject({ ok: true });
      } else {
        await router.stopAll();
      }
      await recovery;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(start).toHaveBeenCalledTimes(2);
      expect(router.activeSessionIds).toEqual([]);
      expect(events.at(-1)?.payload).toMatchObject({ state: "stopped" });
      expect(failures(events)).toEqual([]);
    },
  );

  it("cancels a connection wait promptly on Stop", async () => {
    const { router, start } = await setup();
    router.setMcpAvailable(false);
    const recovery = router.refreshMcpSessions();
    await flush();
    expect(
      await router.route({ type: "stop", commandId: "stop", sessionId: "lead" }),
    ).toMatchObject({ ok: true });
    await recovery;
    router.setMcpAvailable(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("cleans up a startup completing after Stop without resurrecting the session", async () => {
    const { router, start, events } = await setup();
    const late = agent();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    start.mockImplementationOnce(async () => {
      await gate;
      return late;
    });
    const recovery = router.refreshMcpSessions();
    await flush();
    const stopping = router.route({ type: "stop", commandId: "stop", sessionId: "lead" });
    finish();
    expect(await stopping).toMatchObject({ ok: true });
    await recovery;
    expect(late.stop).toHaveBeenCalledOnce();
    expect(router.activeSessionIds).toEqual([]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "stopped" });
  });

  it("bounds failed startups and leaves a manually resumable failure after exhaustion", async () => {
    const { router, start, events } = await setup();
    start.mockRejectedValue(new Error("MCP unavailable"));
    const recovery = router.refreshMcpSessions();
    await flush();
    for (const delay of MCP_RECOVERY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    await recovery;
    expect(start).toHaveBeenCalledTimes(5);
    expect(failures(events)).toHaveLength(1);
    expect(events.at(-1)?.payload.activity).toContain(
      "MCP recovery exhausted after 4 attempts",
    );
    expect(router.activeSessionIds).toEqual([]);
    await router.refreshMcpSessions();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(start).toHaveBeenCalledTimes(5);
    start.mockResolvedValueOnce(agent());
    expect((await router.route({ ...resume(), commandId: "manual-retry" })).ok).toBe(
      true,
    );
  });

  it("parks unknown process ownership and refuses replacement after exhausted cleanup", async () => {
    const { router, start, agents, events } = await setup();
    agents[0]!.stop.mockRejectedValue(new Error("Process exit not verified"));
    const recovery = router.refreshMcpSessions();
    await flush();
    for (const delay of MCP_RECOVERY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    await recovery;
    expect(start).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.payload.activity).toContain("MCP recovery blocked");
    expect(await router.route({ ...resume(), commandId: "unsafe-resume" })).toMatchObject(
      { ok: false, error: "The previous process requires reconciliation." },
    );
    expect(start).toHaveBeenCalledTimes(1);
    agents[0]!.stop.mockResolvedValue(undefined);
    await router.stopAll();
    expect((await router.route({ ...resume(), commandId: "safe-resume" })).ok).toBe(true);
  });

  it("retains a failed startup's process and cleans it up before another attempt", async () => {
    const { router, start, events } = await setup();
    const orphan = agent();
    orphan.stop.mockRejectedValueOnce(new Error("Still exiting"));
    start.mockRejectedValueOnce(
      new AgentStartupCleanupError(
        orphan,
        new Error("Startup timeout"),
        new Error("Cleanup not verified"),
      ),
    );
    const recovery = router.refreshMcpSessions();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MCP_RECOVERY_DELAYS_MS[0]);
    expect(orphan.stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MCP_RECOVERY_DELAYS_MS[1]);
    await recovery;
    expect(orphan.stop).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(3);
    expect(failures(events)).toEqual([]);
  });
});
