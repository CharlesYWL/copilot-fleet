import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { Sidebar } from "./Sidebar";
import { CatalogProvider } from "../hooks/useCatalog";
import { fleetDarkTheme } from "../theme";

const node = (id: string, name: string): FleetNode =>
  ({ id, name, online: true, homeDir: "/home/me" }) as FleetNode;

const workspace = (id: string, name: string): Workspace =>
  ({ id, name, description: "", createdAt: "2026-08-08T00:00:00.000Z" }) as Workspace;

const session = (id: string, workspaceId: string, nodeId: string): FleetSession =>
  ({
    id,
    workspaceId,
    workspaceName: workspaceId,
    placementId: "p1",
    nodeId,
    nodeName: "WEILI-PC",
    state: "idle",
    name: "",
    initialPrompt: "hello",
    currentActivity: "",
    lastText: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    agentSessionId: "",
    yolo: false,
    commands: [],
    configOptions: [],
  }) as FleetSession;

const catalog = {
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  createPlacement: vi.fn(),
  updatePlacement: vi.fn(),
  deletePlacement: vi.fn(),
  reorderPlacements: vi.fn(),
  reorderWorkspaces: vi.fn(),
  reorderSessions: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
  updateNode: vi.fn(),
  updateAllNodes: vi.fn(),
};

const show = (placements: Placement[]) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <CatalogProvider value={catalog}>
        <Sidebar
          nodes={[node("n1", "WEILI-PC")]}
          workspaces={[workspace("w1", "repo"), workspace("w2", "other")]}
          sessions={[session("s1", "w1", "n1")]}
          placements={placements}
          selectedSessionId={undefined}
          view="session"
          endedCount={0}
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onSelectView={vi.fn()}
          onClearEnded={vi.fn()}
        />
      </CatalogProvider>
    </FluentProvider>,
  );

const placement: Placement = {
  id: "p1",
  workspaceId: "w1",
  nodeId: "n1",
  localPath: "/repo",
};

describe("Sidebar drag handles", () => {
  it("marks the node row draggable, since that row is a placement", () => {
    // Fluent's TreeItemLayout has to forward native props to the DOM for this
    // to work at all; if it ever stops, dragging silently does nothing.
    show([placement]);
    const row = screen.getByTitle(/WEILI-PC — drag/i);
    expect(row.getAttribute("draggable")).toBe("true");
  });

  it("makes workspace rows draggable so they can be reordered", () => {
    show([placement]);
    expect(screen.getByTitle(/^repo — drag/i).getAttribute("draggable")).toBe("true");
  });

  it("leaves a node with no placement undraggable", () => {
    // History can outlive a placement: the tree still groups those sessions
    // under a node, but there is nothing left to move.
    show([]);
    expect(screen.queryByTitle(/WEILI-PC — drag/i)).toBeNull();
    expect(screen.getByTitle("WEILI-PC").getAttribute("draggable")).not.toBe("true");
  });
});
