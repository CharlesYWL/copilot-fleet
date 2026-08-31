import { describe, expect, it, vi } from "vitest";
import type { NodeCommand, SessionEvent } from "@fleet/protocol";
import { CommandRouter } from "./router.js";
import {
  MockAgentFactory,
  type AgentFactory,
  type EventSink,
  type SessionAgent,
} from "./agents.js";

/** Waiting on the condition rather than a fixed span survives a loaded machine. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for sessions");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hasSettled(events: SessionEvent[], sessionId: string): boolean {
  return events.some(
    (event) =>
      event.sessionId === sessionId &&
      event.type === "state" &&
      event.payload.state === "idle",
  );
}

/**
 * The parts of a start command these tests never vary.
 *
 * Spread rather than repeated so that a new field on the command reaches every
 * case at once — the tests are typechecked, so leaving it out here is a build
 * error rather than a session started with a quietly missing setting.
 */
const START_DEFAULTS: Pick<
  Extract<NodeCommand, { type: "start_session" }>,
  "yolo" | "mcpServers" | "agent" | "readOnly" | "config"
> = { yolo: false, mcpServers: [], agent: "", readOnly: false, config: [] };

describe("CommandRouter", () => {
  it("streams two sessions independently and deduplicates commands", async () => {
    const events: SessionEvent[] = [];
    const router = new CommandRouter(
      new MockAgentFactory(),
      2,
      (event) => events.push(event),
      async (path) => path,
    );
    const first = {
      type: "start_session" as const,
      ...START_DEFAULTS,
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "alpha",
    };
    const second = {
      type: "start_session" as const,
      ...START_DEFAULTS,
      commandId: "c2",
      sessionId: "s2",
      localPath: "/two",
      prompt: "beta",
    };
    await Promise.all([router.route(first), router.route(second)]);
    expect(await router.route(first)).toEqual({ commandId: "c1", ok: true });
    await waitFor(() => ["s1", "s2"].every((id) => hasSettled(events, id)));
    const s1 = events.filter((event) => event.sessionId === "s1");
    const s2 = events.filter((event) => event.sessionId === "s2");
    expect(s1.some((event) => event.type === "agent_text")).toBe(true);
    expect(s2.some((event) => event.type === "agent_text")).toBe(true);
    expect(
      s1.filter((event) => event.type === "state").map((event) => event.payload.state),
    ).toEqual(["starting", "running", "idle"]);
    expect(s1.map((event) => event.sequence)).toEqual(s1.map((_, index) => index + 1));
    expect(s2.map((event) => event.sequence)).toEqual(s2.map((_, index) => index + 1));
  });

  it("changes a session picker and reports the new value", async () => {
    const events: SessionEvent[] = [];
    const router = new CommandRouter(
      new MockAgentFactory(),
      1,
      (event) => events.push(event),
      async (path) => path,
    );
    await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "alpha",
    });

    const result = await router.route({
      type: "set_config_option",
      commandId: "c2",
      sessionId: "s1",
      configId: "model",
      value: "mock-deep",
    });

    expect(result).toEqual({ commandId: "c2", ok: true });
    const latest = events.filter((event) => event.type === "config").at(-1);
    expect(latest?.payload.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "model", currentValue: "mock-deep" }),
      ]),
    );
  });

  it("refuses an impossible option without failing the session", async () => {
    // Copilot rejects a mistyped model by name. Reporting that as fatal used to
    // fail the whole session, so choosing the wrong entry from a dropdown ended
    // the run the operator was in the middle of.
    const router = new CommandRouter(
      new MockAgentFactory(),
      1,
      () => undefined,
      async (path) => path,
    );
    await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "alpha",
    });

    const result = await router.route({
      type: "set_config_option",
      commandId: "c2",
      sessionId: "s1",
      configId: "nonsense",
      value: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
    expect(result.error).toContain("Unknown option");
  });

  it("enforces configured capacity", async () => {
    const router = new CommandRouter(
      new MockAgentFactory(),
      1,
      () => undefined,
      async (path) => path,
    );
    await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "one",
    });
    const result = await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "c2",
      sessionId: "s2",
      localPath: "/two",
      prompt: "two",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/capacity/);
  });

  it("reserves capacity before concurrent starts await", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let starts = 0;
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink) {
        starts += 1;
        await startGate;
        return inertAgent(sessionId, sink);
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      () => undefined,
      async (path) => path,
    );
    const first = router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "first",
      sessionId: "s1",
      localPath: "/one",
      prompt: "one",
    });
    const second = await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "second",
      sessionId: "s2",
      localPath: "/two",
      prompt: "two",
    });
    expect(second.ok).toBe(false);
    expect(starts).toBe(1);
    releaseStart();
    expect((await first).ok).toBe(true);
  });

  it("deduplicates concurrent starts for the same session", async () => {
    let starts = 0;
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink) {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inertAgent(sessionId, sink);
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      () => undefined,
      async (path) => path,
    );
    const results = await Promise.all([
      router.route({
        type: "start_session",
        ...START_DEFAULTS,
        commandId: "first",
        sessionId: "same",
        localPath: "/one",
        prompt: "one",
      }),
      router.route({
        type: "start_session",
        ...START_DEFAULTS,
        commandId: "duplicate",
        sessionId: "same",
        localPath: "/one",
        prompt: "one",
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(starts).toBe(1);
  });

  it("recovers a slot when an agent fails naturally", async () => {
    let starts = 0;
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink) {
        starts += 1;
        return failingAgent(sessionId, sink);
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      () => undefined,
      async (path) => path,
    );
    expect(
      (
        await router.route({
          type: "start_session",
          ...START_DEFAULTS,
          commandId: "first",
          sessionId: "s1",
          localPath: "/one",
          prompt: "one",
        })
      ).ok,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.activeSessionIds).toEqual([]);
    expect(
      (
        await router.route({
          type: "start_session",
          ...START_DEFAULTS,
          commandId: "second",
          sessionId: "s2",
          localPath: "/two",
          prompt: "two",
        })
      ).ok,
    ).toBe(true);
    expect(starts).toBe(2);
  });

  it("releases a slot when terminal state occurs during factory start", async () => {
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink) {
        sink(stateEvent(sessionId, "failed"));
        return inertAgent(sessionId, sink);
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      () => undefined,
      async (path) => path,
    );
    const result = await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "first",
      sessionId: "s1",
      localPath: "/one",
      prompt: "one",
    });
    expect(result.ok).toBe(false);
    expect(router.activeSessionIds).toEqual([]);
  });

  it("resumes without prompting and continues the event sequence", async () => {
    const events: SessionEvent[] = [];
    let received: {
      resume: string | undefined;
      offset: number | undefined;
      additionalDirectories: readonly string[] | undefined;
    } = {
      resume: undefined,
      offset: undefined,
      additionalDirectories: undefined,
    };
    let prompts = 0;
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink, options) {
        received = {
          resume: options?.resumeAgentSessionId,
          offset: options?.sequenceOffset,
          additionalDirectories: options?.additionalDirectories,
        };
        sink({
          eventId: `${sessionId}-resumed`,
          sessionId,
          sequence: (options?.sequenceOffset ?? 0) + 1,
          type: "state",
          payload: { state: "idle" },
          createdAt: new Date().toISOString(),
        });
        return {
          async prompt() {
            prompts += 1;
          },
          async cancel() {},
          async stop() {},
          resolvePermission() {},
          denyPendingPermissions() {},
          async setConfigOption() {},
          busy: false,
          resync() {},
        };
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      (event) => events.push(event),
      async (path) => `/canonical${path}`,
    );
    const result = await router.route({
      type: "resume_session",
      commandId: "r1",
      sessionId: "s1",
      localPath: "/one",
      agentSessionId: "copilot-abc",
      additionalDirectories: ["/shared"],
      sequenceOffset: 7,
      ...START_DEFAULTS,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual({
      resume: "copilot-abc",
      offset: 7,
      additionalDirectories: ["/canonical/shared"],
    });
    expect(prompts).toBe(0);
    expect(events[0]?.sequence).toBe(8);
  });

  it("omits an unavailable restored workspace root without blocking resume", async () => {
    const received: Array<readonly string[] | undefined> = [];
    const start: AgentFactory["start"] = vi.fn(async (_id, _cwd, _sink, options) => {
      received.push(options?.additionalDirectories);
      return {
        async prompt() {},
        async cancel() {},
        async stop() {},
        resolvePermission() {},
        denyPendingPermissions() {},
        async setConfigOption() {},
        busy: false,
        resync() {},
      };
    });
    const warn = vi.fn();
    const router = new CommandRouter(
      { start },
      1,
      () => undefined,
      async (path) => {
        if (path === "/missing") throw new Error("Workspace path does not exist");
        return path;
      },
      undefined,
      undefined,
      warn,
    );

    const result = await router.route({
      type: "resume_session",
      commandId: "r1",
      sessionId: "s1",
      localPath: "/one",
      agentSessionId: "copilot-abc",
      additionalDirectories: ["/missing"],
      sequenceOffset: 0,
      ...START_DEFAULTS,
    });

    expect(result.ok).toBe(true);
    expect(received).toEqual([[]]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("omitted 1 unavailable additional workspace root"),
    );
  });

  it("refuses a prompt while a turn is in flight instead of dropping it", async () => {
    // The bug: a socket that dropped mid-turn left the Host believing the
    // session was idle, so it forwarded follow-up prompts the agent could not
    // accept. The rejection was swallowed by `.catch(() => undefined)` after
    // the command had already been acknowledged, so the operator's message
    // disappeared with no event, no error, and no state change.
    const events: SessionEvent[] = [];
    const router = new CommandRouter(
      new MockAgentFactory(),
      1,
      (event) => events.push(event),
      async (path) => path,
    );
    await router.route({
      type: "start_session",
      ...START_DEFAULTS,
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "first",
    });
    // The mock streams over several ticks, so the turn is still in flight here.
    expect(router.busySessionIds).toEqual(["s1"]);

    const refused = await router.route({
      type: "prompt",
      commandId: "c2",
      sessionId: "s1",
      prompt: "second",
      attachments: [],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/still working/);
    // Refused, not broken: failing the session would destroy the live turn.
    expect(refused.fatal).toBe(false);
    // And the Host is told what the session is really doing, so a composer
    // opened over a wrong guess closes again.
    expect(
      events.filter(
        (event) => event.type === "state" && event.payload.state === "running",
      ).length,
    ).toBeGreaterThanOrEqual(2);

    await waitFor(() => hasSettled(events, "s1"));
    expect(router.busySessionIds).toEqual([]);
    expect(
      (
        await router.route({
          type: "prompt",
          commandId: "c3",
          sessionId: "s1",
          prompt: "third",
          attachments: [],
        })
      ).ok,
    ).toBe(true);
  });
});

function inertAgent(_sessionId: string, _sink: EventSink): SessionAgent {
  return {
    async prompt() {},
    async cancel() {},
    async stop() {},
    resolvePermission() {},
    denyPendingPermissions() {},
    async setConfigOption() {},
    busy: false,
    resync() {},
  };
}

function failingAgent(sessionId: string, sink: EventSink): SessionAgent {
  return {
    async prompt() {
      sink(stateEvent(sessionId, "failed"));
    },
    async cancel() {},
    async stop() {},
    resolvePermission() {},
    denyPendingPermissions() {},
    async setConfigOption() {},
    busy: false,
    resync() {},
  };
}

function stateEvent(sessionId: string, state: "failed"): SessionEvent {
  return {
    eventId: `${sessionId}-${state}`,
    sessionId,
    sequence: 1,
    type: "state",
    payload: { state },
    createdAt: new Date().toISOString(),
  };
}
