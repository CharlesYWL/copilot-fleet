import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { Sidebar } from "./Sidebar";
import { CatalogProvider } from "../hooks/useCatalog";
import { fleetDarkTheme } from "../theme";

const node = (id: string, name: string): FleetNode =>
  ({ id, name, online: true, homeDir: "/home/me" }) as FleetNode;

const workspace = (
  id: string,
  name: string,
  kind: Workspace["kind"] = "project",
): Workspace =>
  ({
    id,
    name,
    description: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    kind,
  }) as Workspace;

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
        liveAgentCount={0}
        cleanupOrchestratorCount={0}
        liveWorkCount={0}
        attentionCount={0}
        leadSessions={[]}
        favoriteSessions={[]}
        waitingPermissions={[]}
        onSelectSession={vi.fn()}
        onSelectLeadSession={vi.fn()}
        onNewConversation={vi.fn()}
        onNewSession={vi.fn()}
        onSelectView={vi.fn()}
        onStopAllAgents={vi.fn()}
        onCleanupOrchestrators={vi.fn()}
        onManageFavorites={vi.fn()}
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

  describe("dismissed orchestrators", () => {
    it("collapses hidden conversations by default and restores them after expansion", () => {
      const restore = vi.fn();
      const lead: FleetSession = {
        ...session("lead", "w1", "n1", "stopped"),
        runRole: "lead",
        dismissed: true,
      };
      show([placement], [], {
        dismissedLeadSessions: [lead],
        onRestoreLeadSession: restore,
      });

      const disclosure = screen.getByRole("button", {
        name: "Show dismissed orchestrators",
      });
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTitle("Restore lead")).toBeNull();

      fireEvent.click(disclosure);
      expect(
        screen
          .getByRole("button", { name: "Hide dismissed orchestrators" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      fireEvent.click(screen.getByTitle("Restore lead"));
      expect(restore).toHaveBeenCalledWith("lead");
    });
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

  /**
   * Chats is the fleet's own row, not one of the operator's projects.
   *
   * Every handle here would offer a gesture the Host refuses: it is pinned
   * above the list, its checkout is the node's home directory, and neither is
   * an operator's to move.
   */
  it("offers no drag handles on Chats or the machines under it", () => {
    const chatPlacement: Placement = {
      id: "pc",
      workspaceId: "chats",
      nodeId: "n1",
      localPath: "/home/me",
    };
    show([chatPlacement], [session("s1", "chats", "n1")], {
      workspaces: [workspace("chats", "Chats", "chats"), workspace("w1", "repo")],
    });

    expect(screen.getByTitle(/Questions and research/i).getAttribute("draggable")).toBe(
      "false",
    );
    expect(screen.queryByTitle(/WEILI-PC — drag/i)).toBeNull();
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

describe("Sidebar bulk Stop", () => {
  it("opens agent selection from one fleet-wide action", () => {
    const onStopAllAgents = vi.fn();
    show([placement], [session("s1", "w1", "n1")], {
      liveAgentCount: 3,
      onStopAllAgents,
    });

    describe("Sidebar orchestration cleanup", () => {
      it("opens bulk cleanup when stopped orchestrators are eligible", () => {
        const onCleanupOrchestrators = vi.fn();
        show([placement], [], {
          cleanupOrchestratorCount: 2,
          onCleanupOrchestrators,
        });

        fireEvent.click(
          screen.getByRole("button", { name: "Clean up orchestrators (2)" }),
        );

        expect(onCleanupOrchestrators).toHaveBeenCalledOnce();
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop agents (3)" }));

    expect(onStopAllAgents).toHaveBeenCalledOnce();
  });
});

describe("Sidebar favorites", () => {
  it("opens favorited agents from a compact dedicated section", () => {
    const onSelectSession = vi.fn();
    const favorite = { ...session("fav", "w1", "n1"), favorite: true };
    show([placement], [favorite], {
      favoriteSessions: [favorite],
      onSelectSession,
    });

    fireEvent.click(screen.getByRole("button", { name: "fav" }));

    expect(onSelectSession).toHaveBeenCalledWith("fav");
  });

  it("manages favorites from one section action instead of every row", () => {
    const onManageFavorites = vi.fn();
    const lead: FleetSession = {
      ...session("lead", "w1", "n1"),
      runRole: "lead",
    };
    show([placement], [], {
      leadSessions: [lead],
      onManageFavorites,
    });

    fireEvent.click(screen.getByRole("button", { name: "Manage favorites" }));

    expect(onManageFavorites).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Add lead to favorites/ })).toBeNull();
  });

  it("opens a favorited orchestrator from the Favorites section", () => {
    const onSelectLeadSession = vi.fn();
    const lead: FleetSession = {
      ...session("lead", "w1", "n1"),
      name: "Release coordinator",
      runRole: "lead",
      favorite: true,
    };
    show([placement], [], {
      leadSessions: [lead],
      favoriteSessions: [lead],
      onSelectLeadSession,
    });

    fireEvent.click(screen.getAllByTitle("Release coordinator")[0]!);

    expect(onSelectLeadSession).toHaveBeenCalledWith("lead");
  });

  it("collapses favorites without affecting the rest of the navigation", () => {
    const favorite = { ...session("fav", "w1", "n1"), favorite: true };
    show([placement], [favorite], { favoriteSessions: [favorite] });

    fireEvent.click(screen.getByRole("button", { name: "Hide favorites" }));

    expect(screen.queryByRole("button", { name: "fav" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show favorites" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage favorites" })).toBeTruthy();
  });
});

describe("Sidebar orchestrator row", () => {
  const lead = (
    id = "lead1",
    name = "Orchestrator",
    overrides: Partial<FleetSession> = {},
  ): FleetSession => ({
    ...session(id, "w1", "n1", "idle"),
    name,
    runRole: "lead",
    ...overrides,
  });

  it("puts the orchestrator above the workspaces, not inside one", () => {
    /*
     * The orchestrator is fleet-wide. Filing it under whichever workspace its
     * process happens to run in would make it look like one project's tool.
     */
    show([placement], [session("s1", "w1", "n1")], { leadSessions: [lead()] });

    const row = screen.getByRole("button", { name: /^Orchestrator$/ });
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

  it("lists every conversation, not just the one that started first", () => {
    /*
     * The Host has always run as many orchestrator conversations as you open.
     * The UI took the first it found, which is why the only way to start a
     * second was to stop the first.
     */
    const onSelectLeadSession = vi.fn();
    show([placement], [session("s1", "w1", "n1")], {
      leadSessions: [lead("lead1", "Rate limiting"), lead("lead2", "Audit the auth")],
      onSelectLeadSession,
    });

    fireEvent.click(screen.getByTitle("Audit the auth"));

    expect(onSelectLeadSession).toHaveBeenCalledWith("lead2");
  });

  it("offers a way to start another conversation once one exists", () => {
    const onNewConversation = vi.fn();
    show([placement], [session("s1", "w1", "n1")], {
      leadSessions: [lead()],
      onNewConversation,
    });

    fireEvent.click(screen.getByRole("button", { name: /New conversation/ }));

    expect(onNewConversation).toHaveBeenCalled();
  });

  it("keeps a stopped conversation in the list so it can be reopened", () => {
    show([placement], [session("s1", "w1", "n1")], {
      leadSessions: [
        lead("lead1", "Rate limiting", {
          state: "stopped",
          agentSessionId: "copilot-lead-1",
        }),
      ],
    });

    expect(screen.getByTitle("Rate limiting")).toBeTruthy();
  });

  it("keeps a long conversation name on one line", () => {
    /*
     * These rows carried fixed short labels until conversations began naming
     * themselves after whatever a person asked for. A 48-character title
     * wrapped to three lines and pushed the icon and status dot to the middle
     * of a row that was no longer row-shaped.
     *
     * Asserting the style rather than the text, because the text is not what
     * broke — the whole name is still there, and still on the tooltip.
     */
    const long = "hench很长一段总务hench很长一段总务hench很长一段总务hench很长一段总务";
    show([placement], [session("s1", "w1", "n1")], {
      leadSessions: [lead("lead1", long)],
    });

    const label = screen.getByText(long);
    expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    // The full name stays reachable on the row it belongs to.
    expect(screen.getByTitle(long).tagName).toBe("BUTTON");
  });

  it("folds the conversations away, and the row still says only its own name", () => {
    /*
     * Two controls side by side rather than one inside the other. The first
     * attempt nested the disclosure inside the row's button — invalid, and it
     * left the row announcing itself as "Hide conversations Orchestrator", so
     * the name assertion here is the part that matters.
     */
    show([placement], [session("s1", "w1", "n1")], {
      leadSessions: [lead("lead1", "Rate limiting")],
    });

    expect(screen.getByRole("button", { name: "Orchestrator" })).toBeTruthy();
    expect(screen.getByTitle("Rate limiting")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide conversations" }));

    expect(screen.queryByTitle("Rate limiting")).toBeNull();
    expect(screen.queryByRole("button", { name: /New conversation/ })).toBeNull();
    // The board is still one click away with the list folded.
    expect(screen.getByRole("button", { name: "Orchestrator" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show conversations" }));
    expect(screen.getByTitle("Rate limiting")).toBeTruthy();
  });

  it("offers nothing to fold when there are no conversations", () => {
    show([placement], [session("s1", "w1", "n1")], { leadSessions: [] });

    expect(screen.queryByRole("button", { name: /conversations/ })).toBeNull();
  });

  it("offers no conversation row when no orchestrator is running", () => {
    // And no "new conversation" either: there is nothing to add one to yet,
    // and starting the first one is what the orchestrator page is for.
    show([placement], [session("s1", "w1", "n1")], { leadSessions: [] });

    expect(screen.queryByRole("button", { name: /New conversation/ })).toBeNull();
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
