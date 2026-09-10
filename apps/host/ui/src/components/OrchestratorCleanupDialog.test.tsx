import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { OrchestratorCleanupDialog } from "./OrchestratorCleanupDialog";

const orchestrator = (id: string): FleetSession =>
  ({
    id,
    workspaceId: "w1",
    workspaceName: "repo",
    placementId: "p1",
    nodeId: "n1",
    nodeName: "box",
    state: "stopped",
    name: id,
    initialPrompt: "",
    currentActivity: "",
    lastText: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agentSessionId: "acp",
    yolo: false,
    commands: [],
    configOptions: [],
    runId: "",
    runRole: "lead",
    readOnly: true,
  }) as FleetSession;

describe("OrchestratorCleanupDialog", () => {
  it("selects all stopped orchestrators by default and submits only checked rows", async () => {
    const onCleanup = vi.fn(async () => true);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorCleanupDialog
          open
          orchestrators={[orchestrator("Alpha"), orchestrator("Beta")]}
          onClose={vi.fn()}
          onCleanup={onCleanup}
        />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up selected (1)" }));

    await vi.waitFor(() => expect(onCleanup).toHaveBeenCalledWith(["Alpha"]));
  });

  it("supports deselect all", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <OrchestratorCleanupDialog
          open
          orchestrators={[orchestrator("Alpha"), orchestrator("Beta")]}
          onClose={vi.fn()}
          onCleanup={vi.fn(async () => true)}
        />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all orchestrators" }));

    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Clean up selected (0)" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
