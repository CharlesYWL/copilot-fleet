import { describe, expect, it } from "vitest";
import type { FleetNode, Placement, Workspace } from "@fleet/protocol";
import {
  decodeDrag,
  dropVerdict,
  edgeFromPointer,
  encodeDrag,
  horizontalEdgeFromPointer,
  reorder,
  suggestedPath,
} from "./drag-drop";

const workspace = (id: string, name: string): Workspace =>
  ({ id, name, description: "", createdAt: "" }) as Workspace;

const node = (id: string, name: string, homeDir = "/home/me"): FleetNode =>
  ({ id, name, homeDir }) as FleetNode;

const placement = (id: string, workspaceId: string, nodeId: string): Placement =>
  ({ id, workspaceId, nodeId, localPath: "/repo" }) as Placement;

const repo = workspace("w1", "repo");
const other = workspace("w2", "other");
const machine = node("n1", "WEILI-PC");

describe("encodeDrag / decodeDrag", () => {
  it("round-trips a payload", () => {
    expect(decodeDrag(encodeDrag({ kind: "node", id: "n1" }))).toEqual({
      kind: "node",
      id: "n1",
    });
  });

  it("rejects anything this app did not write", () => {
    // A file dragged in from the desktop, or text from another page, must not
    // be read as an instruction to move something.
    expect(decodeDrag("just some text")).toBeUndefined();
    expect(decodeDrag("{}")).toBeUndefined();
    expect(decodeDrag(JSON.stringify({ kind: "tool", id: "t1" }))).toBeUndefined();
    expect(decodeDrag(JSON.stringify({ kind: "node", id: "" }))).toBeUndefined();
  });
});

describe("dropVerdict", () => {
  it("moves a placement to a workspace that has room", () => {
    const placements = [placement("p1", "w1", "n1")];
    expect(
      dropVerdict({ kind: "placement", id: "p1" }, other, placements, [machine]),
    ).toEqual({ allowed: true, action: "move" });
  });

  it("refuses to move a placement onto its own workspace", () => {
    const placements = [placement("p1", "w1", "n1")];
    const verdict = dropVerdict({ kind: "placement", id: "p1" }, repo, placements, [
      machine,
    ]);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("Already in this workspace");
  });

  it("refuses a move that would put one node twice in a workspace", () => {
    // The table's own rule: a workspace can only be in one place on a machine.
    const placements = [placement("p1", "w1", "n1"), placement("p2", "w2", "n1")];
    const verdict = dropVerdict({ kind: "placement", id: "p1" }, other, placements, [
      machine,
    ]);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("other");
  });

  it("creates a placement when a node is dropped on a workspace", () => {
    expect(dropVerdict({ kind: "node", id: "n1" }, repo, [], [machine])).toEqual({
      allowed: true,
      action: "create",
    });
  });

  it("refuses a node the workspace already has, by name", () => {
    const verdict = dropVerdict(
      { kind: "node", id: "n1" },
      repo,
      [placement("p1", "w1", "n1")],
      [machine],
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.reason).toContain("WEILI-PC");
  });

  it("refuses something that disappeared mid-drag", () => {
    // Another browser can delete a placement while this one is dragging it.
    expect(dropVerdict({ kind: "placement", id: "gone" }, repo, [], []).allowed).toBe(
      false,
    );
    expect(dropVerdict({ kind: "node", id: "gone" }, repo, [], []).allowed).toBe(false);
  });
});

describe("suggestedPath", () => {
  it("starts from the node's home directory", () => {
    expect(suggestedPath({ homeDir: "C:\\Users\\me" })).toBe("C:\\Users\\me");
  });

  it("gives an empty path for a node that never reported one", () => {
    expect(suggestedPath({ homeDir: "" })).toBe("");
  });
});

describe("reorder", () => {
  const ids = ["a", "b", "c", "d"];

  it("drops above a row, taking its place", () => {
    expect(reorder(ids, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
  });

  it("drops below a row", () => {
    expect(reorder(ids, "d", "b", "after")).toEqual(["a", "b", "d", "c"]);
  });

  it("reaches the very end, which dropping onto a row cannot express", () => {
    expect(reorder(ids, "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
  });

  it("reaches the very start", () => {
    expect(reorder(ids, "c", "a", "before")).toEqual(["c", "a", "b", "d"]);
  });

  it("moves an item down without falling a slot short", () => {
    // The classic off-by-one: inserting before removing puts "a" after "c".
    expect(reorder(ids, "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
  });

  it("defaults to dropping above, as the older callers assumed", () => {
    expect(reorder(ids, "d", "b")).toEqual(reorder(ids, "d", "b", "before"));
  });

  it("leaves the list alone when something is dropped on itself", () => {
    expect(reorder(ids, "b", "b", "after")).toEqual(ids);
  });

  it("leaves the list alone when either id is a stranger", () => {
    // Dragging between workspaces is a move, not a reorder, and must not be
    // silently turned into one.
    expect(reorder(ids, "z", "b")).toEqual(ids);
    expect(reorder(ids, "b", "z")).toEqual(ids);
  });

  it("does not mutate the list it was given", () => {
    const original = [...ids];
    reorder(ids, "a", "c", "after");
    expect(ids).toEqual(original);
  });
});

describe("edgeFromPointer", () => {
  const row = { top: 100, height: 40 };

  it("calls the top half before and the bottom half after", () => {
    expect(edgeFromPointer(row, 105)).toBe("before");
    expect(edgeFromPointer(row, 135)).toBe("after");
  });

  it("puts the exact midpoint after, so the two halves cannot both claim it", () => {
    expect(edgeFromPointer(row, 120)).toBe("after");
  });
});

describe("horizontalEdgeFromPointer", () => {
  const tile = { left: 200, width: 320 };

  it("calls the left half before and the right half after", () => {
    // Tiles flow left to right, so using the vertical halves here would put
    // the line on an edge the tile cannot land on.
    expect(horizontalEdgeFromPointer(tile, 250)).toBe("before");
    expect(horizontalEdgeFromPointer(tile, 500)).toBe("after");
  });

  it("puts the exact midpoint after", () => {
    expect(horizontalEdgeFromPointer(tile, 360)).toBe("after");
  });
});
