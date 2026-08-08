import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
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
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "alpha",
    };
    const second = {
      type: "start_session" as const,
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
      s1
        .filter((event) => event.type === "state")
        .map((event) => event.payload.state),
    ).toEqual(["starting", "running", "idle"]);
    expect(s1.map((event) => event.sequence)).toEqual(
      s1.map((_, index) => index + 1),
    );
    expect(s2.map((event) => event.sequence)).toEqual(
      s2.map((_, index) => index + 1),
    );
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
      commandId: "c1",
      sessionId: "s1",
      localPath: "/one",
      prompt: "one",
    });
    const result = await router.route({
      type: "start_session",
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
    const router = new CommandRouter(factory, 1, () => undefined, async (path) => path);
    const first = router.route({
      type: "start_session",
      commandId: "first",
      sessionId: "s1",
      localPath: "/one",
      prompt: "one",
    });
    const second = await router.route({
      type: "start_session",
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
    const router = new CommandRouter(factory, 1, () => undefined, async (path) => path);
    const results = await Promise.all([
      router.route({
        type: "start_session",
        commandId: "first",
        sessionId: "same",
        localPath: "/one",
        prompt: "one",
      }),
      router.route({
        type: "start_session",
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
    const router = new CommandRouter(factory, 1, () => undefined, async (path) => path);
    expect(
      (
        await router.route({
          type: "start_session",
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
    const router = new CommandRouter(factory, 1, () => undefined, async (path) => path);
    const result = await router.route({
      type: "start_session",
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
    let received: { resume?: string; offset?: number } = {};
    let prompts = 0;
    const factory: AgentFactory = {
      async start(sessionId, _cwd, sink, options) {
        received = {
          resume: options?.resumeAgentSessionId,
          offset: options?.sequenceOffset,
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
        };
      },
    };
    const router = new CommandRouter(
      factory,
      1,
      (event) => events.push(event),
      async (path) => path,
    );
    const result = await router.route({
      type: "resume_session",
      commandId: "r1",
      sessionId: "s1",
      localPath: "/one",
      agentSessionId: "copilot-abc",
      sequenceOffset: 7,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual({ resume: "copilot-abc", offset: 7 });
    expect(prompts).toBe(0);
    expect(events[0]?.sequence).toBe(8);
  });
});

function inertAgent(_sessionId: string, _sink: EventSink): SessionAgent {
  return {
    async prompt() {},
    async cancel() {},
    async stop() {},
    resolvePermission() {},
    denyPendingPermissions() {},
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
