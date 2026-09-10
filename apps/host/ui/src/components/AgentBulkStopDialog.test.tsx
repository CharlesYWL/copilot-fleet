import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { AgentBulkStopDialog } from "./AgentBulkStopDialog";

const agent = (id: string, workspaceName: string): FleetSession =>
  ({
    id,
    workspaceId: workspaceName,
    workspaceName,
    placementId: "p1",
    nodeId: "n1",
    nodeName: "box",
    state: "idle",
    name: id,
    initialPrompt: "",
    currentActivity: "",
    lastText: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agentSessionId: "",
    yolo: false,
    commands: [],
    configOptions: [],
    runId: "",
    runRole: "",
    readOnly: false,
    favorite: false,
  }) as FleetSession;

const show = (onStop = vi.fn(async () => true)) => {
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <AgentBulkStopDialog
        open
        title="Stop agents"
        agents={[agent("one", "Alpha"), agent("two", "Alpha"), agent("three", "Beta")]}
        onClose={vi.fn()}
        onStop={onStop}
      />
    </FluentProvider>,
  );
  return onStop;
};

describe("AgentBulkStopDialog", () => {
  it("starts with all agents selected and submits the selection", async () => {
    const onStop = show();

    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop selected (3)" }));

    await vi.waitFor(() => expect(onStop).toHaveBeenCalledWith(["one", "two", "three"]));
  });

  it("selects and deselects a whole workspace group", () => {
    show();

    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha (2)" }));

    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Select one" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Select three" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("supports deselect all and selecting one agent", () => {
    show();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all agents" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select two" }));

    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop selected (1)" })).toBeTruthy();
  });
});
