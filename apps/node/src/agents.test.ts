import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import {
  MockAgentFactory,
  UnpromptedTurn,
  configRecoveryRequest,
  copilotAcpAuthVersionError,
  copilotFailureMessage,
  copilotLaunchArgs,
  copilotSupportsContextTier,
  copilotVersionFromOutput,
  toolDetail,
  toolProgress,
  withCopilotStartupTimeout,
} from "./agents.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("copilotLaunchArgs", () => {
  it("starts ACP over stdio", () => {
    expect(copilotLaunchArgs(false)).toEqual(["--acp", "--stdio"]);
  });

  it("adds Copilot's yolo flag when the Host asks for it", () => {
    expect(copilotLaunchArgs(true)).toEqual(["--acp", "--stdio", "--allow-all"]);
  });

  it("asks for the context window the operator chose", () => {
    expect(copilotLaunchArgs(false, "long_context")).toEqual([
      "--acp",
      "--stdio",
      "--context",
      "long_context",
    ]);
  });

  it("says 'default' out loud rather than letting Copilot's own file decide", () => {
    // Copilot persists a tier of its own. Omitting the flag would hand the
    // decision to whatever that file says, which is the per-machine drift the
    // explicit flags exist to prevent.
    expect(copilotLaunchArgs(false, "default")).toEqual([
      "--acp",
      "--stdio",
      "--context",
      "default",
    ]);
  });

  it("leaves the flag off entirely when Copilot cannot take it", () => {
    expect(copilotLaunchArgs(true, undefined)).toEqual([
      "--acp",
      "--stdio",
      "--allow-all",
    ]);
  });
});

describe("copilotSupportsContextTier", () => {
  it("accepts a Copilot whose help lists the option", async () => {
    const help = async () => "  --context <tier>  Set the context window tier";
    expect(await copilotSupportsContextTier("copilot", help)).toBe(true);
  });

  it("refuses one that has never heard of it", async () => {
    // Copilot is installed per machine and the fleet does not update it, so a
    // current node can be driving a months-old binary. Commander exits 1 on an
    // unknown option before reading any ACP, which would stop every session on
    // that machine rather than merely costing it the larger window.
    const help = async () => "  --allow-all  Enable all permissions";
    expect(await copilotSupportsContextTier("copilot", help)).toBe(false);
  });

  it("refuses one it cannot ask at all", async () => {
    const help = async () => {
      throw new Error("ENOENT");
    };
    expect(await copilotSupportsContextTier("copilot", help)).toBe(false);
  });
});

describe("Copilot ACP startup", () => {
  it("reads release versions while ignoring build suffixes", () => {
    expect(copilotVersionFromOutput("GitHub Copilot CLI 1.0.81-12.")).toBe("1.0.81");
    expect(copilotVersionFromOutput("unexpected output")).toBeUndefined();
  });

  it("rejects the ACP build that could claim login before checking it", () => {
    expect(copilotAcpAuthVersionError("GitHub Copilot CLI 1.0.68")).toMatch(
      /minimum 1\.0\.69.*copilot login/,
    );
    expect(copilotAcpAuthVersionError("GitHub Copilot CLI 1.0.69")).toBeUndefined();
  });

  it("turns an authentication rejection into an actionable node-local fix", () => {
    expect(copilotFailureMessage(new Error("Authentication required"))).toContain(
      "copilot login",
    );
  });

  it("fails a silent ACP startup instead of waiting forever", async () => {
    vi.useFakeTimers();
    const assertion = expect(
      withCopilotStartupTimeout(new Promise<void>(() => {}), 1_000),
    ).rejects.toThrow(/copilot update.*copilot login/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

describe("configRecoveryRequest", () => {
  const option = (id: string) =>
    ({ id, name: id, category: "model", currentValue: "x", choices: [] }) as never;

  it("asks for the permissions option when a start brought back nothing", () => {
    // session/load never returns an option list, and session/new has been seen
    // not to either, so a session that has never had pickers would never get
    // them: setting an option is the only call that answers with the whole list.
    expect(configRecoveryRequest([], false)).toEqual({
      configId: "allow_all",
      value: "off",
    });
  });

  it("re-asserts the permission the Host already chose, rather than a guess", () => {
    // The process was just launched with the matching --allow-all, so this
    // changes nothing about the session — it only makes the pickers say so.
    expect(configRecoveryRequest([], true)).toEqual({
      configId: "allow_all",
      value: "on",
    });
  });

  it("leaves a session that reported its own options alone", () => {
    expect(configRecoveryRequest([option("model")], true)).toBeUndefined();
  });
});

describe("toolDetail", () => {
  it("names the command a shell tool is about to run", () => {
    expect(toolDetail({ rawInput: { command: "npm test -w @fleet/host" } })).toBe(
      "npm test -w @fleet/host",
    );
  });

  it("flattens a wrapped command onto the one line it will be drawn on", () => {
    expect(toolDetail({ rawInput: { command: "npm test \\\n  --silent" } })).toBe(
      "npm test \\ --silent",
    );
  });

  it("falls back to the file a tool named nothing else about", () => {
    expect(toolDetail({ locations: [{ path: "apps/node/src/agents.ts" }] })).toBe(
      "apps/node/src/agents.ts",
    );
  });

  it("ignores fields that carry contents rather than a summary", () => {
    // `rawInput` on a write also holds the bytes being written. A transcript is
    // stored on the Host and replayed to every browser watching it, so a whole
    // file on one line is a cost that outlives the render it broke.
    expect(
      toolDetail({ rawInput: { content: "a".repeat(5000), summary: "wrote a file" } }),
    ).toBeUndefined();
  });

  it("truncates a detail too long to belong on a single line", () => {
    const detail = toolDetail({ rawInput: { command: "x".repeat(500) } });
    expect(detail?.length).toBe(201);
    expect(detail?.endsWith("…")).toBe(true);
  });

  it("says nothing when the tool described neither input nor file", () => {
    expect(toolDetail({})).toBeUndefined();
    expect(toolDetail({ rawInput: "just a string" })).toBeUndefined();
    expect(toolDetail({ rawInput: { command: "   " } })).toBeUndefined();
  });
});

describe("toolProgress", () => {
  it("opens the call an agent has just started", () => {
    expect(
      toolProgress({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        status: "pending",
      } as never),
    ).toEqual({ id: "call-1", done: false });
  });

  it("closes one that reported an end, however it ended", () => {
    for (const status of ["completed", "failed"]) {
      expect(
        toolProgress({
          sessionUpdate: "tool_call_update",
          toolCallId: "c",
          status,
        } as never),
      ).toEqual({ id: "c", done: true });
    }
  });

  it("leaves the call alone when an update only carries output", () => {
    // Output streams in under the id of a call that has often already finished.
    // Reading that as a fresh start would resurrect it, and an open call holds
    // the turn it belongs to open behind it.
    expect(
      toolProgress({ sessionUpdate: "tool_call_update", toolCallId: "c" } as never),
    ).toBeUndefined();
  });

  it("has nothing to say about updates that are not about tools", () => {
    expect(
      toolProgress({ sessionUpdate: "agent_message_chunk", content: {} } as never),
    ).toBeUndefined();
  });
});

describe("UnpromptedTurn", () => {
  const setup = (options: { toolGraceMs?: number } = {}) => {
    const events: string[] = [];
    let clock = 0;
    let pending: (() => void) | undefined;
    const turn = new UnpromptedTurn(
      () => events.push("start"),
      () => events.push("settle"),
      {
        quietMs: 1_000,
        toolGraceMs: options.toolGraceMs ?? 5_000,
        now: () => clock,
        setTimer: (fn) => {
          pending = fn;
          return fn;
        },
        clearTimer: () => {
          pending = undefined;
        },
      },
    );
    /** Runs the pending quiet timer, with the clock moved to when it fires. */
    const elapse = () => {
      clock += 1_000;
      const due = pending;
      pending = undefined;
      due?.();
    };
    return { turn, events, elapse };
  };

  it("reports a turn nobody prompted the moment work appears", () => {
    // The bug this exists for: Copilot wakes itself when a backgrounded shell
    // finishes, and the fleet went on calling the session idle while it worked.
    const { turn, events } = setup();
    turn.note();
    expect(events).toEqual(["start"]);
    expect(turn.active).toBe(true);
  });

  it("announces the turn once, not once per update", () => {
    const { turn, events } = setup();
    turn.note();
    turn.note();
    turn.note();
    expect(events).toEqual(["start"]);
  });

  it("calls the turn finished once the stream goes quiet", () => {
    const { turn, events, elapse } = setup();
    turn.note();
    elapse();
    expect(events).toEqual(["start", "settle"]);
    expect(turn.active).toBe(false);
  });

  it("holds the turn open while a tool call is still running", () => {
    // A tool says nothing between starting and ending, so its silence is the
    // one kind that means the agent is working rather than done.
    const { turn, events, elapse } = setup();
    turn.note({ id: "call-1", done: false });
    elapse();
    elapse();
    expect(events).toEqual(["start"]);

    turn.note({ id: "call-1", done: true });
    elapse();
    expect(events).toEqual(["start", "settle"]);
  });

  it("stops waiting on a tool call that never reports back", () => {
    // Otherwise one lost ending owns the session: running for good, with the
    // composer locked over an agent that stopped long ago.
    const { turn, events, elapse } = setup({ toolGraceMs: 3_000 });
    turn.note({ id: "call-1", done: false });
    for (let attempt = 0; attempt < 5; attempt += 1) elapse();
    expect(events).toEqual(["start", "settle"]);
  });

  it("stands down without a word when something else takes the session over", () => {
    // A prompt arriving means the fleet is driving again, and it emits its own
    // running state; a second one from here would only be noise.
    const { turn, events, elapse } = setup();
    turn.note();
    turn.clear();
    elapse();
    expect(events).toEqual(["start"]);
    expect(turn.active).toBe(false);
  });

  it("settles on demand, for a turn an operator cancelled", () => {
    // Cancelling work nobody prompted produces no response to carry a stop
    // reason, so this is the only end that turn will ever report.
    const { turn, events } = setup();
    turn.note();
    turn.settle();
    turn.settle();
    expect(events).toEqual(["start", "settle"]);
  });

  it("says nothing about a turn that never started", () => {
    const { turn, events } = setup();
    turn.settle();
    expect(events).toEqual([]);
  });
});

describe("MockAgentFactory", () => {
  const collect = async (options?: { resumeAgentSessionId?: string }) => {
    const events: SessionEvent[] = [];
    await new MockAgentFactory().start(
      "session-1",
      "/workspace",
      (event) => events.push(event),
      options,
    );
    return events;
  };

  it("waits to be prompted after a fresh start", async () => {
    const events = await collect();
    expect(events.map((event) => event.type)).toEqual([
      "state",
      "agent_session",
      "commands",
      "config",
    ]);
    expect(events[0]?.payload).toMatchObject({ state: "starting" });
  });

  it("reports its commands and pickers so a browser has something to drive", () => {
    // The mock exists to exercise the UI without Copilot installed, so the
    // slash menu and the model chooser have to have content here too.
    return collect().then((events) => {
      const commands = events.find((event) => event.type === "commands");
      expect(commands?.payload.commands).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "model" })]),
      );
      const config = events.find((event) => event.type === "config");
      expect(config?.payload.options).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "model" })]),
      );
    });
  });

  it("re-reports pickers when one is changed", async () => {
    const events: SessionEvent[] = [];
    const agent = await new MockAgentFactory().start("session-1", "/workspace", (event) =>
      events.push(event),
    );
    await agent.setConfigOption("model", "mock-deep");
    const latest = events.filter((event) => event.type === "config").at(-1);
    expect(latest?.payload.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "model", currentValue: "mock-deep" }),
      ]),
    );
  });

  it("refuses an option it does not have", async () => {
    const agent = await new MockAgentFactory().start("session-1", "/workspace", () => {});
    await expect(agent.setConfigOption("nonsense", "x")).rejects.toThrow(
      "Unknown option",
    );
  });

  it("lands a resumed session on idle, so it can be prompted again", async () => {
    // The router never prompts a resumed session, so an adapter that stops at
    // `starting` leaves Resume looking like it hung.
    const events = await collect({ resumeAgentSessionId: "mock-earlier-run" });
    expect(events.at(-1)?.payload).toMatchObject({ state: "idle" });
    expect(events[1]?.payload).toMatchObject({ agentSessionId: "mock-earlier-run" });
  });
});
