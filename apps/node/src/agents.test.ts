import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import { MockAgentFactory, copilotLaunchArgs } from "./agents.js";

describe("copilotLaunchArgs", () => {
  it("starts ACP over stdio", () => {
    expect(copilotLaunchArgs(false)).toEqual(["--acp", "--stdio"]);
  });

  it("adds Copilot's yolo flag when the Host asks for it", () => {
    expect(copilotLaunchArgs(true)).toEqual(["--acp", "--stdio", "--allow-all"]);
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
