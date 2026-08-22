import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { Sidebar } from "./Sidebar";
import { CatalogProvider } from "../hooks/useCatalog";
import { fleetDarkTheme } from "../theme";

const node = (id: string, name: string): FleetNode =>
  ({ id, name, online: true, homeDir: "/home/me" }) as FleetNode;

const workspace = (id: string, name: string): Workspace =>
  ({ id, name, description: "", createdAt: "2026-08-08T00:00:00.000Z" }) as Workspace;

const session = (
  id: string,
  workspaceId: string,
  nodeId: string,
  state: FleetSession["state"] = "idle",
): FleetSession =>
  ({
    id,
    workspaceId,
    workspaceName: workspaceId,
    placementId: "p1",
    nodeId,
    nodeName: "WEILI-PC",
    state,
    name: id,
    initialPrompt: "hello",
    currentActivity: "",
    lastText: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    agentSessionId: "",
    yolo: false,
    commands: [],
    configOptions: [],
    runId: "",
    runRole: "" as const,
    readOnly: false,
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

const show = (
  placements: Placement[],
  sessions = [session("s1", "w1", "n1")],
  overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
) => render(tree(placements, sessions, overrides));

const tree = (
  placements: Placement[],
  sessions: FleetSession[],
  overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
) => (
  <FluentProvider theme={fleetDarkTheme}>
    <CatalogProvider value={catalog}>
      <Sidebar
        nodes={[node("n1", "WEILI-PC")]}
        workspaces={[workspace("w1", "repo"), workspace("w2", "other")]}
        sessions={sessions}
        placements={placements}
        selectedSessionId={undefined}
        view="session"
        endedCount={0}
        liveWorkCount={0}
        attentionCount={0}
        leadSession={undefined}
        waitingPermissions={[]}
        onSelectSession={vi.fn()}
        onSelectLeadSession={vi.fn()}
        onNewSession={vi.fn()}
        onSelectView={vi.fn()}
        onClearEnded={vi.fn()}
        {...overrides}
      />
    </CatalogProvider>
  </FluentProvider>
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

describe("Sidebar folding", () => {
  it("folds a node away when nothing under it is running", () => {
    show([placement], [session("s1", "w1", "n1", "stopped")]);
    expect(screen.queryByText("s1")).toBeNull();
  });

  it("keeps a node open while a session is still running", () => {
    show([placement], [session("s1", "w1", "n1", "running")]);
    expect(screen.getByText("s1")).toBeTruthy();
  });

  it("opens a folded node when one of its sessions comes back to life", () => {
    const { rerender } = show([placement], [session("s1", "w1", "n1", "offline")]);
    expect(screen.queryByText("s1")).toBeNull();
    rerender(tree([placement], [session("s1", "w1", "n1", "idle")]));
    expect(screen.getByText("s1")).toBeTruthy();
  });

  it("opens a folded node when a session is created on it", () => {
    const { rerender } = show([placement], [session("s1", "w1", "n1", "stopped")]);
    expect(screen.queryByText("s1")).toBeNull();
    rerender(
      tree(
        [placement],
        [session("s1", "w1", "n1", "stopped"), session("s2", "w1", "n1", "queued")],
      ),
    );
    expect(screen.getByText("s2")).toBeTruthy();
  });
});

describe("Sidebar orchestrator row", () => {
  const lead = (): FleetSession => ({
    ...session("lead1", "w1", "n1", "idle"),
    name: "Orchestrator",
    runRole: "lead",
  });

  it("puts the orchestrator above the workspaces, not inside one", () => {
    /*
     * The orchestrator is fleet-wide. Filing it under whichever workspace its
     * process happens to run in would make it look like one project's tool.
     */
    show([placement], [session("s1", "w1", "n1")], { leadSession: lead() });

    const row = screen.getByRole("button", { name: /Orchestrator/ });
    const workspaceRow = screen.getByTitle(/^repo — drag/i);
    expect(
      row.compareDocumentPosition(workspaceRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("goes to the orchestrator rather than selecting a session", () => {
    const onSelectView = vi.fn();
    const onSelectSession = vi.fn();
    show([placement], [session("s1", "w1", "n1")], { onSelectView, onSelectSession });

    fireEvent.click(screen.getByRole("button", { name: /Orchestrator/ }));

    expect(onSelectView).toHaveBeenCalledWith("orchestrator");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("shows the lead's conversation as its own row under the orchestrator", () => {
    const onSelectLeadSession = vi.fn();
    show([placement], [session("s1", "w1", "n1")], {
      leadSession: lead(),
      onSelectLeadSession,
    });

    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    expect(onSelectLeadSession).toHaveBeenCalled();
  });

  it("offers no conversation row when no orchestrator is running", () => {
    show([placement], [session("s1", "w1", "n1")], { leadSession: undefined });
    expect(screen.queryByRole("button", { name: /Conversation/ })).toBeNull();
  });

  it("counts what is waiting on a person beside the orchestrator", () => {
    show([placement], [session("s1", "w1", "n1")], { attentionCount: 3 });
    expect(screen.getByTitle("3 waiting for you").textContent).toBe("3");
  });

  it("shows no count when nothing is waiting", () => {
    show([placement], [session("s1", "w1", "n1")], { attentionCount: 0 });
    expect(screen.queryByTitle(/waiting for you/)).toBeNull();
  });

  it("marks a dispatched worker apart from a session someone started", () => {
    const worker: FleetSession = {
      ...session("worker1", "w1", "n1", "running"),
      runRole: "worker",
    };
    show([placement], [session("s1", "w1", "n1", "running"), worker]);

    expect(screen.getByText("worker1")).toBeTruthy();
    expect(screen.getAllByTitle("Dispatched by the orchestrator")).toHaveLength(1);
  });
});
