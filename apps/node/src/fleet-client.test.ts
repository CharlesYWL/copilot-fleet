import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_ID_HEADER, NODE_SECRET_HEADER } from "@fleet/protocol";
import { FleetClient, ownPlacements, type PlacementLike } from "./fleet-client.js";

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
    expect(ownPlacements(placements, "me").map((item) => item.id)).toEqual(["p1", "p3"]);
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

describe("FleetClient credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const capture = () => {
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers ?? {}),
        });
        return new Response("[]", { status: 200 });
      }),
    );
    return calls;
  };

  it("identifies this node on every call it relays", async () => {
    const calls = capture();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "node-1",
      nodeSecret: () => "s3cret",
    });

    await client.listWorkspaces();
    await client.listOwnPlacements();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get(NODE_ID_HEADER)).toBe("node-1");
      expect(call.headers.get(NODE_SECRET_HEADER)).toBe("s3cret");
    }
  });

  it("says nothing about an identity it does not have yet", async () => {
    const calls = capture();
    const client = new FleetClient({
      hostUrl: () => "http://127.0.0.1:8787",
      nodeId: () => "",
      nodeSecret: () => undefined,
    });

    await client.listWorkspaces();

    expect(calls[0]?.headers.has(NODE_ID_HEADER)).toBe(false);
    expect(calls[0]?.headers.has(NODE_SECRET_HEADER)).toBe(false);
  });
});
