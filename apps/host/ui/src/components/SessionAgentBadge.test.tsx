import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import type { SessionConfigOption } from "@fleet/protocol";
import { SessionAgentBadge } from "./SessionAgentBadge";
import {
  customAgentName,
  selectedAgent,
  visibleConfigOptions,
} from "../lib/session-config";

const agentOption = (currentValue: string): SessionConfigOption => ({
  id: "agent",
  name: "Agent",
  description: "Select a custom agent persona, or use the default Copilot agent.",
  category: "_agent",
  currentValue,
  choices: [
    { value: "", name: "Copilot", description: "" },
    { value: "fleet-orchestrator", name: "fleet-orchestrator", description: "" },
  ],
});

const modeOption = (): SessionConfigOption => ({
  id: "mode",
  name: "Mode",
  description: "Controls how Copilot responds.",
  category: "mode",
  // Copilot's mode picker calls its default value "Agent". This is the whole
  // reason the real agent picker was invisible: the composer strip shows values
  // rather than labels, so the control reading "Agent" was this one.
  currentValue: "agent",
  choices: [
    { value: "agent", name: "Agent", description: "" },
    { value: "plan", name: "Plan", description: "" },
  ],
});

const show = (options: SessionConfigOption[], disabled = false) => {
  const onChange = vi.fn();
  render(
    <FluentProvider theme={webDarkTheme}>
      <SessionAgentBadge options={options} disabled={disabled} onChange={onChange} />
    </FluentProvider>,
  );
  return onChange;
};

describe("which agent a session is running as", () => {
  it("names the custom agent, so a person can see who they are talking to", () => {
    show([agentOption("fleet-orchestrator")]);

    expect(
      screen.getByRole("button", { name: "Agent: fleet-orchestrator" }),
    ).toBeTruthy();
  });

  it("still shows stock Copilot, so the control can be found before it is used", () => {
    // Hiding it on the default would mean the only way to reach a custom agent
    // was to already be using one.
    show([agentOption("")]);

    expect(screen.getByRole("button", { name: "Agent: Copilot" })).toBeTruthy();
  });

  it("shows nothing when this machine offers no agents at all", () => {
    // Copilot only offers the picker when it found agent files near the
    // session's working directory. An empty control would imply a choice that
    // does not exist there.
    show([modeOption()]);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("switches the session to another agent", () => {
    const onChange = show([agentOption("")]);

    fireEvent.click(screen.getByRole("button", { name: "Agent: Copilot" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fleet-orchestrator" }));

    expect(onChange).toHaveBeenCalledWith("agent", "fleet-orchestrator");
  });

  it("reports a switch back to stock Copilot, whose value is the empty string", () => {
    // Guarding the handler with a falsy test would make this the one choice in
    // the menu that can be clicked and do nothing.
    const onChange = show([agentOption("fleet-orchestrator")]);

    fireEvent.click(screen.getByRole("button", { name: "Agent: fleet-orchestrator" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Copilot" }));

    expect(onChange).toHaveBeenCalledWith("agent", "");
  });

  it("is a readout, not a menu, on a session that has ended", () => {
    show([agentOption("fleet-orchestrator")], true);

    const badge = screen.getByRole("button", { name: "Agent: fleet-orchestrator" });
    expect(badge.hasAttribute("disabled")).toBe(true);
    expect(badge.getAttribute("aria-haspopup")).toBeNull();
  });
});

describe("reading the agent out of a session's config", () => {
  it("does not mistake the mode picker for the agent", () => {
    // They collide on the word: the mode picker's *value* is "agent" and the
    // agent picker's *id* is "agent". Only the category tells them apart.
    expect(selectedAgent([modeOption()])).toBeUndefined();
    expect(selectedAgent([modeOption(), agentOption("fleet-orchestrator")])?.name).toBe(
      "fleet-orchestrator",
    );
  });

  it("keeps the agent out of the composer's settings strip", () => {
    // It lives beside the session's name now. Leaving it here too put two
    // controls in one row that both read as "agent".
    const ids = visibleConfigOptions([modeOption(), agentOption("")]).map((o) => o.id);

    expect(ids).toEqual(["mode"]);
  });

  it("names an agent in a list only when it is not the default", () => {
    // Workers are dispatched without one on purpose, so almost every row would
    // otherwise say "Copilot" and bury the row that matters.
    expect(customAgentName([agentOption("fleet-orchestrator")])).toBe(
      "fleet-orchestrator",
    );
    expect(customAgentName([agentOption("")])).toBeUndefined();
    expect(customAgentName([modeOption()])).toBeUndefined();
  });

  it("falls back to the raw value when the choice list has not caught up", () => {
    const stale = { ...agentOption("hephaestus"), choices: [] };

    expect(selectedAgent([stale])?.name).toBe("hephaestus");
  });
});
