import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { Sidebar } from "./Sidebar";
import { CatalogProvider } from "../hooks/useCatalog";
import { DRAG_MIME, encodeDrag } from "../lib/drag-drop";
import { fleetDarkTheme } from "../theme";

const node = (id: string, name: string): FleetNode =>
  ({ id, name, online: true, homeDir: "/home/me" }) as FleetNode;

const workspace = (id: string, name: string): Workspace =>
  ({
    id,
    name,
    description: "",
    createdAt: "2026-08-08T00:00:00.000Z",
    kind: "project",
  }) as Workspace;

const nodes = [node("n1", "WEILI-PC"), node("n2", "build-box")];
const workspaces = [
  workspace("w1", "checkout"),
  workspace("w2", "payments"),
  workspace("w3", "empty-project"),
];
const placements: Placement[] = [
  { id: "p1", workspaceId: "w1", nodeId: "n1", localPath: "/checkout" },
  { id: "p2", workspaceId: "w1", nodeId: "n2", localPath: "/checkout" },
  { id: "p3", workspaceId: "w2", nodeId: "n1", localPath: "/payments" },
];

/** A stopped session, so its branch starts folded the way the tree leaves it. */
const session = (
  id: string,
  name: string,
  where: { workspaceId: string; nodeId: string },
  overrides: Partial<FleetSession> = {},
): FleetSession =>
  ({
    id,
    name,
    workspaceId: where.workspaceId,
    workspaceName: workspaces.find((entry) => entry.id === where.workspaceId)!.name,
    placementId: "p1",
    nodeId: where.nodeId,
    nodeName: nodes.find((entry) => entry.id === where.nodeId)!.name,
    state: "stopped",
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
    runRole: "",
    readOnly: false,
    ...overrides,
  }) as FleetSession;

const checkoutOnWeili = { workspaceId: "w1", nodeId: "n1" };
const sessions = [
  session("s1", "Fix lint", checkoutOnWeili),
  session("s2", "Write docs", checkoutOnWeili),
  session("s3", "Run benchmarks", { workspaceId: "w1", nodeId: "n2" }),
  session("s4", "Lint the API", { workspaceId: "w2", nodeId: "n1" }),
];

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
  resyncNodeConsole: vi.fn(),
};

const show = (overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <CatalogProvider value={catalog}>
        <Sidebar
          nodes={nodes}
          workspaces={workspaces}
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
          onDeleteLeadSession={vi.fn(async () => true)}
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
    </FluentProvider>,
  );

const searchBox = () =>
  screen.getByRole<HTMLInputElement>("searchbox", { name: "Search sessions" });

const searchToggle = () => screen.queryByRole("button", { name: "Search sessions" });

/** Types into the search, opening it from its icon first when it is folded. */
const search = (query: string) => {
  const toggle = searchToggle();
  if (toggle) fireEvent.click(toggle);
  fireEvent.change(searchBox(), { target: { value: query } });
};

/**
 * A session's own row.
 *
 * A branch's accessible name includes everything under it, so the project and
 * node rows above a session would match its name too; only session rows carry
 * `aria-selected`, which is what tells them apart.
 */
const sessionRow = (name: RegExp) =>
  screen.queryByRole("treeitem", { name, selected: false });

describe("Sidebar session search", () => {
  it("starts as an icon at the end of the Fleet heading, above the tree", () => {
    show();
    const landmark = screen.getByRole("search", { name: "Session search" });
    expect(within(landmark).getByText("Fleet")).toBeTruthy();
    expect(within(landmark).getByRole("button", { name: "Search sessions" })).toBe(
      searchToggle(),
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      landmark.compareDocumentPosition(screen.getByRole("tree")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("turns the heading into a focused search box when the icon is clicked", () => {
    show();
    fireEvent.click(searchToggle()!);
    const landmark = screen.getByRole("search", { name: "Session search" });
    expect(within(landmark).getByRole("searchbox")).toBe(searchBox());
    expect(document.activeElement).toBe(searchBox());
    expect(within(landmark).queryByText("Fleet")).toBeNull();
    expect(screen.getByRole("button", { name: "Close session search" })).toBeTruthy();
  });

  it("narrows the tree to matching sessions and opens the branches holding them", () => {
    show();
    // Everything is stopped, so the tree starts folded away.
    expect(sessionRow(/Fix lint/)).toBeNull();

    search("lint");

    expect(sessionRow(/Fix lint/)).toBeTruthy();
    expect(sessionRow(/Lint the API/)).toBeTruthy();
    expect(screen.queryByText("Write docs")).toBeNull();
    expect(screen.queryByText("Run benchmarks")).toBeNull();
    expect(screen.queryByText("build-box")).toBeNull();
    expect(screen.queryByText("empty-project")).toBeNull();
  });

  it("finds every session on a machine by the node's name", () => {
    show();
    search("build");
    expect(sessionRow(/Run benchmarks/)).toBeTruthy();
    expect(screen.queryByText("Fix lint")).toBeNull();
    expect(screen.queryByText("Lint the API")).toBeNull();
  });

  it("finds every session in a project by the project's name", () => {
    show();
    search("payments");
    expect(sessionRow(/Lint the API/)).toBeTruthy();
    expect(screen.queryByText("Fix lint")).toBeNull();
    expect(screen.queryByText("Run benchmarks")).toBeNull();
  });

  it("combines words across project, node and session", () => {
    show();
    search("checkout weili lint");
    expect(sessionRow(/Fix lint/)).toBeTruthy();
    expect(screen.queryByText("Lint the API")).toBeNull();
    expect(screen.queryByText("Write docs")).toBeNull();
  });

  it("marks what matched in each row", () => {
    show();
    search("lint");
    const row = sessionRow(/Fix lint/)!;
    expect([...row.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "lint",
    ]);
  });

  it("puts the tree back as it was once the search is cleared", () => {
    show();
    search("lint");
    expect(sessionRow(/Fix lint/)).toBeTruthy();

    search("");

    // Folded again, exactly as the tree had left it, with every project back.
    expect(sessionRow(/Fix lint/)).toBeNull();
    expect(screen.queryByText("WEILI-PC")).toBeNull();
    expect(screen.getByText("empty-project")).toBeTruthy();
    expect(screen.getByRole("tree").querySelector("mark")).toBeNull();
  });

  it("closes the search with Escape and puts focus back on the icon", () => {
    show();
    search("lint");
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(document.activeElement).toBe(searchToggle());
    expect(sessionRow(/Fix lint/)).toBeNull();
  });

  it("clears and folds back into the icon from the clear button, by mouse or keyboard", () => {
    show();
    search("lint");
    const clear = () => screen.getByRole("button", { name: "Close session search" });
    expect(clear().tabIndex).toBe(0);
    fireEvent.click(clear());
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByText("Fleet")).toBeTruthy();
    expect(document.activeElement).toBe(searchToggle());
    expect(sessionRow(/Fix lint/)).toBeNull();

    search("lint");
    fireEvent.keyDown(clear(), { key: "Enter" });
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("folds an empty box away when focus leaves it, but keeps one with a query", () => {
    show();
    fireEvent.click(searchToggle()!);
    fireEvent.blur(searchBox(), { relatedTarget: document.body });
    expect(screen.queryByRole("searchbox")).toBeNull();

    search("lint");
    fireEvent.blur(searchBox(), { relatedTarget: document.body });
    expect(searchBox().value).toBe("lint");
  });

  it("keeps a branch folded during a search only until the search changes", () => {
    show();
    search("lint");
    fireEvent.click(screen.getByTitle(/^checkout — drag/));
    expect(sessionRow(/Fix lint/)).toBeNull();
    expect(sessionRow(/Lint the API/)).toBeTruthy();

    search("lin");

    expect(sessionRow(/Fix lint/)).toBeTruthy();
  });

  it("searches favorites and orchestrator conversations, opening folded sections", () => {
    const favorite = { ...sessions[0]!, favorite: true };
    const lead = session("lead", "Release coordinator", checkoutOnWeili, {
      state: "idle",
      runRole: "lead",
    });
    const dismissed = session("old-lead", "Release audit", checkoutOnWeili, {
      runRole: "lead",
      dismissed: true,
    });
    show({
      favoriteSessions: [favorite],
      leadSessions: [lead],
      dismissedLeadSessions: [dismissed],
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide favorites" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide conversations" }));

    search("release");

    expect(screen.queryByRole("button", { name: /favorites/ })).toBeNull();
    expect(screen.getByTitle("Release coordinator")).toBeTruthy();
    expect(screen.getByTitle("Restore Release audit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New conversation/ })).toBeNull();
    // Conversations are found by name, not by the checkout their process uses.
    search("checkout");
    expect(screen.queryByTitle("Release coordinator")).toBeNull();

    search("lint");

    expect(screen.getByRole("button", { name: /Fix lint/ })).toBeTruthy();
    expect(screen.queryByTitle("Release coordinator")).toBeNull();

    search("");

    expect(screen.getByRole("button", { name: "Show favorites" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show conversations" })).toBeTruthy();
    expect(screen.queryByTitle("Release coordinator")).toBeNull();
    expect(screen.queryByTitle("Restore Release audit")).toBeNull();
  });

  it("says so when nothing matches, on screen and to assistive technology", () => {
    show();
    search("zzz");
    expect(screen.getByText("No sessions, nodes or projects match “zzz”.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No matches");
    expect(screen.queryByRole("tree")).toBeNull();

    search("lint");
    expect(screen.getByRole("status").textContent).toBe("2 matches");
  });

  it("keeps a project with no sessions findable by its name", () => {
    show();
    search("empty");
    expect(screen.getByText("No sessions")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 match");
  });

  it("reorders a filtered list against every sibling, not just the visible ones", () => {
    catalog.reorderSessions.mockClear();
    show({
      sessions: [
        session("a1", "alpha one", checkoutOnWeili),
        session("b1", "beta", checkoutOnWeili),
        session("a2", "alpha two", checkoutOnWeili),
      ],
    });
    search("alpha");
    const target = sessionRow(/alpha one/)!.querySelector(".fui-TreeItemLayout")!;

    fireEvent.drop(target, {
      dataTransfer: {
        types: [DRAG_MIME],
        getData: () => encodeDrag({ kind: "session", id: "a2" }),
      },
    });

    expect(catalog.reorderSessions).toHaveBeenCalledExactlyOnceWith(["a2", "a1", "b1"]);
  });

  it("moves from the search box to the first result with the down arrow", () => {
    show();
    search("payments");
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("role")).toBe("treeitem");
    expect(focused.textContent).toContain("payments");
  });

  it("steps past section controls to a result, not to Manage favorites", () => {
    const favorite = { ...sessions[0]!, favorite: true };
    show({ favoriteSessions: [favorite] });
    search("lint");
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Fix lint/ }));
  });

  it("does not also claim there are no workspaces when a search finds nothing", () => {
    show({ workspaces: [], sessions: [], placements: [] });
    expect(screen.getByText("No workspaces yet.")).toBeTruthy();
    search("zzz");
    expect(screen.queryByText("No workspaces yet.")).toBeNull();
    expect(screen.getByText("No sessions, nodes or projects match “zzz”.")).toBeTruthy();
  });
});
