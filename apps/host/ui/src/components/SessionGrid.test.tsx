import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
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

const on = (
  base: FleetSession,
  workspaceId: string,
  workspaceName: string,
  nodeId: string,
  nodeName: string,
): FleetSession => ({ ...base, workspaceId, workspaceName, nodeId, nodeName });

const placement = (id: string, workspaceId: string, nodeId: string): Placement => ({
  id,
  workspaceId,
  nodeId,
  localPath: `/${id}`,
});

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

const show = (
  sessions: FleetSession[] = [session("s1", "First"), session("s2", "Second")],
  workspaces: Workspace[] = [workspace("w1", "repo")],
  nodes: FleetNode[] = [node("n1", "WEILI-PC")],
  placements: Placement[] = [],
) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <CatalogProvider value={catalog}>
        <SessionGrid
          sessions={sessions}
          workspaces={workspaces}
          nodes={nodes}
          placements={placements}
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

describe("SessionGrid ordering", () => {
  it("lists workspaces in the order the tree does", () => {
    // Grid mode was grouped without the catalog, so it fell back to whichever
    // workspace the first session belonged to — and disagreed with the sidebar
    // as soon as either list was dragged into an order.
    const first = session("s1", "First");
    const second = session("s2", "Second");
    const { container } = show(
      [on(second, "w2", "other", "n1", "WEILI-PC"), on(first, "w1", "repo", "n1", "box")],
      [workspace("w1", "repo"), workspace("w2", "other")],
      [node("n1", "WEILI-PC")],
    );

    const headings = [...container.querySelectorAll("section[aria-label^='Workspace']")];
    expect(headings.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Workspace repo",
      "Workspace other",
    ]);
  });

  it("lists a workspace's tiles in placement order", () => {
    const first = session("s1", "First");
    const second = session("s2", "Second");
    const { container } = show(
      [
        on(second, "w1", "repo", "n2", "devbox2"),
        on(first, "w1", "repo", "n1", "devbox1"),
      ],
      [workspace("w1", "repo")],
      [node("n1", "devbox1"), node("n2", "devbox2")],
      [placement("p1", "w1", "n1"), placement("p2", "w1", "n2")],
    );

    const titles = [...container.querySelectorAll('[aria-label^="Open "]')].map((item) =>
      item.getAttribute("aria-label"),
    );
    expect(titles).toEqual(["Open First on devbox1", "Open Second on devbox2"]);
  });
});
