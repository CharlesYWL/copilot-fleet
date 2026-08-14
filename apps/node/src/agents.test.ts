import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import {
  MockAgentFactory,
  configRecoveryRequest,
  copilotLaunchArgs,
  copilotSupportsContextTier,
} from "./agents.js";

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

describe("configRecoveryRequest", () => {
  const option = (id: string) =>
    ({ id, name: id, category: "model", currentValue: "x", choices: [] }) as never;

  it("asks for the permissions option when a resume brought back nothing", () => {
    // session/load returns no option list and nothing later volunteers one, so
    // a session that has never had pickers would never get them: setting an
    // option is the only call that answers with the whole list.
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
