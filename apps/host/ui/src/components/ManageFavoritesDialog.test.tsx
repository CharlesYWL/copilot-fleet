import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetSession } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { ManageFavoritesDialog } from "./ManageFavoritesDialog";

const session = (
  id: string,
  workspaceName: string,
  runRole: FleetSession["runRole"] = "",
  favorite = false,
): FleetSession =>
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
    runRole,
    readOnly: false,
    favorite,
  }) as FleetSession;

describe("ManageFavoritesDialog", () => {
  it("starts from persisted favorites and saves the new set", async () => {
    const onSave = vi.fn(async () => true);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <ManageFavoritesDialog
          open
          sessions={[session("Lead", "Alpha", "lead", true), session("Worker", "Alpha")]}
          onClose={vi.fn()}
          onSave={onSave}
        />
      </FluentProvider>,
    );

    expect(
      (screen.getByRole("checkbox", { name: "Lead" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Worker" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(["Lead", "Worker"]));
  });

  it("groups orchestrators separately from workspace agents", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <ManageFavoritesDialog
          open
          sessions={[session("Lead", "Alpha", "lead"), session("Worker", "Alpha")]}
          onClose={vi.fn()}
          onSave={vi.fn(async () => true)}
        />
      </FluentProvider>,
    );

    expect(screen.getByRole("button", { name: "Orchestrators (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chats (1)" })).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("collapses chats independently", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <ManageFavoritesDialog
          open
          sessions={[session("Lead", "Alpha", "lead"), session("Chat", "Alpha")]}
          onClose={vi.fn()}
          onSave={vi.fn(async () => true)}
        />
      </FluentProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chats (1)" }));

    expect(screen.queryByRole("checkbox", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Lead" })).toBeTruthy();
  });

  it("filters chats and orchestrators by name", () => {
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <ManageFavoritesDialog
          open
          sessions={[
            session("Release lead", "Alpha", "lead"),
            session("Investigate tests", "Alpha"),
          ]}
          onClose={vi.fn()}
          onSave={vi.fn(async () => true)}
        />
      </FluentProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Filter favorites by name" }), {
      target: { value: "release" },
    });

    expect(screen.getByRole("checkbox", { name: "Release lead" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Investigate tests" })).toBeNull();
  });

  it("hides orchestration dependency agents and removes stale favorites on save", async () => {
    const onSave = vi.fn(async () => true);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <ManageFavoritesDialog
          open
          sessions={[
            session("Chat", "Alpha", "", true),
            session("Dependency worker", "Alpha", "worker", true),
            session("Dependency reviewer", "Alpha", "reviewer", true),
          ]}
          onClose={vi.fn()}
          onSave={onSave}
        />
      </FluentProvider>,
    );

    expect(screen.queryByText("Dependency worker")).toBeNull();
    expect(screen.queryByText("Dependency reviewer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(["Chat"]));
  });
});
