import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Workspace } from "@fleet/protocol";
import { SessionGrid } from "./SessionGrid";
import { CatalogProvider } from "../hooks/useCatalog";
import { DRAG_MIME } from "../lib/drag-drop";
import { fleetDarkTheme } from "../theme";

const node = (id: string, name: string): FleetNode =>
  ({ id, name, online: true, homeDir: "/home/me" }) as FleetNode;

const workspace = (id: string, name: string): Workspace =>
  ({ id, name, description: "", createdAt: "2026-08-08T00:00:00.000Z" }) as Workspace;

const session = (id: string, name: string): FleetSession =>
  ({
    id,
    workspaceId: "w1",
    workspaceName: "repo",
    placementId: "p1",
    nodeId: "n1",
    nodeName: "WEILI-PC",
    state: "idle",
    name,
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

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <CatalogProvider value={catalog}>
        <SessionGrid
          sessions={[session("s1", "First"), session("s2", "Second")]}
          workspaces={[workspace("w1", "repo")]}
          nodes={[node("n1", "WEILI-PC")]}
          events={{}}
          onOpen={vi.fn()}
          onPermission={vi.fn()}
          onNewSession={vi.fn()}
        />
      </CatalogProvider>
    </FluentProvider>,
  );

describe("SessionGrid dragging", () => {
  it("makes every tile draggable, not just the tree rows", () => {
    // View mode renders its own component; wiring the tree alone left this
    // half of the app unable to reorder anything.
    const { container } = show();
    const draggables = container.querySelectorAll('[draggable="true"]');
    // Two tiles plus the workspace heading.
    expect(draggables.length).toBe(3);
  });

  it("offers the workspace heading as a reorder handle", () => {
    show();
    const head = screen.getByTitle(/repo — drag above or below/i);
    expect(head.getAttribute("draggable")).toBe("true");
  });

  it("marks the tile being hovered, on the side the drop will land", () => {
    // The indicator was invisible once already, drawn under the tile's own
    // opaque background. This checks the class arrives; the rule that paints
    // it lives above the tile now rather than beneath it.
    const { container } = show();
    const tiles = [...container.querySelectorAll('[draggable="true"]')].slice(1);
    const target = tiles[1]!;
    const before = target.className;

    fireEvent.dragOver(target, {
      dataTransfer: { types: [DRAG_MIME], dropEffect: "" },
      clientX: 0,
    });

    expect(target.className).not.toBe(before);
  });
});
