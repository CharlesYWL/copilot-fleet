import { describe, expect, it } from "vitest";
import type { FleetSession } from "@fleet/protocol";
import type { SessionWorkspaceGroup } from "./session-groups";
import { searchTerms } from "./search-text";
import {
  countSearchMatches,
  filterSessionGroups,
  filterSessions,
} from "./session-search";

const session = (
  id: string,
  name: string,
  overrides: Partial<FleetSession> = {},
): FleetSession =>
  ({
    id,
    name,
    initialPrompt: "hello",
    workspaceName: "checkout",
    nodeName: "WEILI-PC",
    runRole: "",
    ...overrides,
  }) as FleetSession;

const groups: SessionWorkspaceGroup[] = [
  {
    workspaceId: "w1",
    workspaceName: "checkout",
    kind: "project",
    nodes: [
      {
        nodeId: "n1",
        nodeName: "WEILI-PC",
        online: true,
        sessions: [session("s1", "Fix lint"), session("s2", "Write docs")],
      },
      {
        nodeId: "n2",
        nodeName: "build-box",
        online: true,
        sessions: [session("s3", "Run benchmarks", { nodeName: "build-box" })],
      },
    ],
  },
  {
    workspaceId: "w2",
    workspaceName: "payments",
    kind: "project",
    nodes: [
      {
        nodeId: "n1",
        nodeName: "WEILI-PC",
        online: true,
        sessions: [session("s4", "Lint the API", { workspaceName: "payments" })],
      },
    ],
  },
  { workspaceId: "w3", workspaceName: "empty-project", kind: "project", nodes: [] },
];

/** Workspace → node → session ids, which is all the tree renders. */
const shape = (result: SessionWorkspaceGroup[]) =>
  result.map((group) => ({
    workspace: group.workspaceName,
    nodes: group.nodes.map((node) => ({
      node: node.nodeName,
      sessions: node.sessions.map((entry) => entry.id),
    })),
  }));

const search = (query: string) => shape(filterSessionGroups(groups, searchTerms(query)));

describe("filterSessionGroups", () => {
  it("leaves the tree as it is when nothing is typed", () => {
    expect(search("")).toEqual(shape(groups));
  });

  it("keeps matching sessions together with the project and node above them", () => {
    expect(search("docs")).toEqual([
      { workspace: "checkout", nodes: [{ node: "WEILI-PC", sessions: ["s2"] }] },
    ]);
  });

  it("finds every session on a node by the node's name, in every project", () => {
    expect(search("weili")).toEqual([
      { workspace: "checkout", nodes: [{ node: "WEILI-PC", sessions: ["s1", "s2"] }] },
      { workspace: "payments", nodes: [{ node: "WEILI-PC", sessions: ["s4"] }] },
    ]);
  });

  it("finds every session in a project by the project's name", () => {
    expect(search("payments")).toEqual([
      { workspace: "payments", nodes: [{ node: "WEILI-PC", sessions: ["s4"] }] },
    ]);
  });

  it("combines terms across project, node and session", () => {
    expect(search("checkout weili lint")).toEqual([
      { workspace: "checkout", nodes: [{ node: "WEILI-PC", sessions: ["s1"] }] },
    ]);
  });

  it("keeps a project with no sessions only when its own name matches", () => {
    expect(search("empty")).toEqual([{ workspace: "empty-project", nodes: [] }]);
    expect(search("empty weili")).toEqual([]);
  });

  it("matches an unnamed session by the prompt it is labelled with", () => {
    const unnamed = [
      {
        ...groups[0]!,
        nodes: [
          {
            ...groups[0]!.nodes[0]!,
            sessions: [session("s9", "", { initialPrompt: "Audit the retry policy" })],
          },
        ],
      },
    ];
    expect(shape(filterSessionGroups(unnamed, searchTerms("retry")))).toEqual([
      { workspace: "checkout", nodes: [{ node: "WEILI-PC", sessions: ["s9"] }] },
    ]);
  });

  it("returns nothing when no session, node or project matches", () => {
    expect(search("zzz")).toEqual([]);
  });
});

describe("filterSessions", () => {
  const favorite = session("fav", "Fix lint");
  const lead = session("lead", "Release coordinator", { runRole: "lead" });

  it("finds a session by its label, project or node", () => {
    expect(filterSessions([favorite], searchTerms("lint"))).toEqual([favorite]);
    expect(filterSessions([favorite], searchTerms("checkout"))).toEqual([favorite]);
    expect(filterSessions([favorite], searchTerms("weili"))).toEqual([favorite]);
    expect(filterSessions([favorite], searchTerms("payments"))).toEqual([]);
  });

  it("finds an orchestrator conversation only by its name, not where it runs", () => {
    expect(filterSessions([lead], searchTerms("release"))).toEqual([lead]);
    expect(filterSessions([lead], searchTerms("checkout"))).toEqual([]);
    expect(filterSessions([lead], searchTerms("weili"))).toEqual([]);
  });

  it("keeps everything when nothing is typed", () => {
    expect(filterSessions([favorite, lead], [])).toEqual([favorite, lead]);
  });
});

describe("countSearchMatches", () => {
  it("counts each session once however many sections list it", () => {
    const tree = filterSessionGroups(groups, searchTerms("lint"));
    expect(countSearchMatches(tree, [session("s1", "Fix lint")])).toBe(2);
  });

  it("counts a project found by name that has nothing under it", () => {
    expect(
      countSearchMatches(filterSessionGroups(groups, searchTerms("empty")), []),
    ).toBe(1);
  });

  it("counts conversations listed outside the tree", () => {
    const lead = session("lead", "Release coordinator", { runRole: "lead" });
    expect(countSearchMatches([], [lead])).toBe(1);
  });

  it("is zero when nothing matched", () => {
    expect(countSearchMatches([], [])).toBe(0);
  });
});
