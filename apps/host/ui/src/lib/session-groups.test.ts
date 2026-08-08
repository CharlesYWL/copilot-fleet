import { describe, expect, it } from "vitest";
import type { FleetNode, FleetSession, Workspace } from "@fleet/protocol";
import { groupSessionsByWorkspace } from "./session-groups";

const node = (id: string, name: string, online = true): FleetNode => ({
  id,
  name,
  os: "darwin",
  arch: "arm64",
  version: "0.1.0",
  capabilities: [],
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
  nodeId,
  nodeName,
  state: "idle",
  initialPrompt: id,
  currentActivity: "",
  lastText: "",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
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
});
