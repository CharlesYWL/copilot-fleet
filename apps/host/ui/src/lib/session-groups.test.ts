import { describe, expect, it } from "vitest";
import type { FleetNode, FleetSession, Placement, Workspace } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "./session-groups";

const node = (id: string, name: string, online = true): FleetNode => ({
  id,
  name,
  os: "darwin",
  arch: "arm64",
  version: "0.1.0",
  revision: "",
  capabilities: [],
  agents: [],
  maxSessions: 4,
  activeSessions: 0,
  lastHeartbeat: "2026-08-08T00:00:00.000Z",
  online,
  homeDir: "/Users/me",
});

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  description: "",
  createdAt: "2026-08-08T00:00:00.000Z",
});

const session = (
  id: string,
  workspaceId: string,
  workspaceName: string,
  nodeId: string,
  nodeName: string,
): FleetSession => ({
  id,
  workspaceId,
  workspaceName,
  placementId: "p1",
  agentSessionId: "",
  yolo: false,
  commands: [],
  configOptions: [],
  runId: "",
  runRole: "" as const,
  readOnly: false,
  name: "",
  nodeId,
  nodeName,
  state: "idle",
  initialPrompt: id,
  currentActivity: "",
  lastText: "",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
});

const placement = (id: string, workspaceId: string, nodeId: string): Placement => ({
  id,
  workspaceId,
  nodeId,
  localPath: `/${id}`,
});

describe("groupSessionsByWorkspace", () => {
  it("nests sessions under workspace then node", () => {
    const groups = groupSessionsByWorkspace(
      [
        session("s1", "w1", "Alpha", "n1", "mac"),
        session("s2", "w1", "Alpha", "n2", "win"),
        session("s3", "w2", "Beta", "n1", "mac"),
      ],
      [node("n1", "mac"), node("n2", "win", false)],
      [workspace("w1", "Alpha"), workspace("w2", "Beta")],
    );

    expect(groups.map((group) => group.workspaceName)).toEqual(["Alpha", "Beta"]);
    expect(
      groups.map((group) =>
        group.nodes.map((item) => [item.nodeName, item.online, item.sessions.length]),
      ),
    ).toEqual([
      [
        ["mac", true, 1],
        ["win", false, 1],
      ],
      [["mac", true, 1]],
    ]);
    expect(
      groups.map((group) =>
        group.nodes.flatMap((item) => item.sessions.map((s) => s.id)),
      ),
    ).toEqual([["s1", "s2"], ["s3"]]);
  });

  it("keeps empty workspaces so the tree still lists them", () => {
    const groups = groupSessionsByWorkspace(
      [],
      [node("n1", "mac")],
      [workspace("w1", "Empty")],
    );

    expect(groups).toEqual([{ workspaceId: "w1", workspaceName: "Empty", nodes: [] }]);
  });

  it("orders the nodes under a workspace by its placements", () => {
    // The node rows are the workspace's placements, so dragging one above
    // another has to move the row. Before this, the order came from whichever
    // machine's session appeared first and a reorder was written but unseen.
    const groups = groupSessionsByWorkspace(
      [
        session("s1", "w1", "Alpha", "n2", "devbox2"),
        session("s2", "w1", "Alpha", "n1", "devbox1"),
      ],
      [node("n1", "devbox1"), node("n2", "devbox2")],
      [workspace("w1", "Alpha")],
      [placement("p1", "w1", "n1"), placement("p2", "w1", "n2")],
    );

    expect(groups[0]!.nodes.map((item) => item.nodeName)).toEqual(["devbox1", "devbox2"]);
  });

  it("ranks placements per workspace rather than across the whole list", () => {
    // The Host hands them out workspace by workspace, so a later workspace's
    // placements carry higher indexes; comparing across workspaces would sort
    // by that accident instead of by position.
    const groups = groupSessionsByWorkspace(
      [
        session("s1", "w2", "Beta", "n1", "devbox1"),
        session("s2", "w2", "Beta", "n2", "devbox2"),
      ],
      [node("n1", "devbox1"), node("n2", "devbox2")],
      [workspace("w1", "Alpha"), workspace("w2", "Beta")],
      [
        placement("p1", "w1", "n1"),
        placement("p2", "w2", "n2"),
        placement("p3", "w2", "n1"),
      ],
    );

    expect(groups[1]!.nodes.map((item) => item.nodeName)).toEqual(["devbox2", "devbox1"]);
  });

  it("leaves a node whose placement is gone at the end", () => {
    // Sessions outlive the checkout they ran in, and a node with nothing left
    // to drag has no rank; sorting it as zero would float it to the top.
    const groups = groupSessionsByWorkspace(
      [
        session("s1", "w1", "Alpha", "n2", "devbox2"),
        session("s2", "w1", "Alpha", "n1", "devbox1"),
      ],
      [node("n1", "devbox1"), node("n2", "devbox2")],
      [workspace("w1", "Alpha")],
      [placement("p1", "w1", "n1")],
    );

    expect(groups[0]!.nodes.map((item) => item.nodeName)).toEqual(["devbox1", "devbox2"]);
  });

  it("keeps the session order it was given when nothing is placed", () => {
    const groups = groupSessionsByWorkspace(
      [
        session("s1", "w1", "Alpha", "n2", "devbox2"),
        session("s2", "w1", "Alpha", "n1", "devbox1"),
      ],
      [node("n1", "devbox1"), node("n2", "devbox2")],
      [workspace("w1", "Alpha")],
    );

    expect(groups[0]!.nodes.map((item) => item.nodeName)).toEqual(["devbox2", "devbox1"]);
  });
});

describe("run-owned sessions", () => {
  it("shows a run's workers in the tree but keeps the orchestrator out", () => {
    const mine = session("mine", "w1", "Alpha", "n1", "mac");
    const worker: FleetSession = {
      ...session("worker", "w1", "Alpha", "n1", "mac"),
      runId: "r1",
      runRole: "worker",
    };
    const lead: FleetSession = {
      ...session("lead", "w1", "Alpha", "n1", "mac"),
      runId: "r1",
      runRole: "lead",
    };

    const groups = groupSessionsByWorkspace(
      [mine, worker, lead],
      [node("n1", "mac")],
      [workspace("w1", "Alpha")],
    );

    const ids = groups.flatMap((group) =>
      group.nodes.flatMap((item) => item.sessions.map((entry) => entry.id)),
    );
    /*
     * A worker is an ordinary session on a real node in a real checkout, and
     * hiding it made the tree disagree with what the fleet was doing. The
     * orchestrator is the one that belongs elsewhere: it is the fleet's own
     * surface rather than any single repository's.
     */
    expect(ids).toEqual(["mine", "worker"]);
  });
});
