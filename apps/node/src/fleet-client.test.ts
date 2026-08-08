import { describe, expect, it } from "vitest";
import { ownPlacements, type PlacementLike } from "./fleet-client.js";

const placements: PlacementLike[] = [
  { id: "p1", workspaceId: "w1", nodeId: "me", localPath: "/a" },
  { id: "p2", workspaceId: "w2", nodeId: "other", localPath: "/b" },
  { id: "p3", workspaceId: "w3", nodeId: "me", localPath: "/c" },
];

describe("ownPlacements", () => {
  it("keeps only the placements that live on this machine", () => {
    // The page edits absolute paths, and a path is only meaningful on the
    // machine it belongs to; showing another node's rows invites pointing it
    // at a directory that does not exist there.
    expect(ownPlacements(placements, "me").map((item) => item.id)).toEqual([
      "p1",
      "p3",
    ]);
  });

  it("returns nothing when this node owns no placement", () => {
    expect(ownPlacements(placements, "unknown")).toEqual([]);
  });

  it("never matches on an empty node id", () => {
    // A node that has not enrolled yet has no id; treating "" as a wildcard
    // would expose the whole fleet's placements on an unidentified box.
    const orphan: PlacementLike[] = [
      { id: "p4", workspaceId: "w4", nodeId: "", localPath: "/d" },
    ];
    expect(ownPlacements(orphan, "")).toEqual([]);
  });
});
