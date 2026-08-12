import type { FleetNode, Placement, Workspace } from "@fleet/protocol";

/**
 * What may be dragged onto a workspace, and what happens when it lands.
 *
 * Drag and drop is only worth having if a drop cannot do something surprising,
 * so the rules live here rather than inside event handlers: whether a target
 * accepts the thing being dragged is a question with a testable answer, and the
 * same answer decides both the highlight and the action.
 */

export type DragPayload =
  | { kind: "placement"; id: string }
  | { kind: "node"; id: string }
  | { kind: "workspace"; id: string }
  | { kind: "session"; id: string };

/** The one MIME type the app claims, so foreign drags are never mistaken. */
export const DRAG_MIME = "application/x-fleet-item";

export function encodeDrag(payload: DragPayload): string {
  return JSON.stringify(payload);
}

export function decodeDrag(raw: string): DragPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { kind, id } = parsed as { kind?: unknown; id?: unknown };
    if (
      (kind !== "placement" &&
        kind !== "node" &&
        kind !== "workspace" &&
        kind !== "session") ||
      typeof id !== "string" ||
      !id
    ) {
      return undefined;
    }
    return { kind, id };
  } catch {
    return undefined;
  }
}

export type DropVerdict =
  | { allowed: true; action: "move" | "create"; reason?: undefined }
  | { allowed: false; reason: string };

/**
 * Whether `payload` may be dropped on `workspace`, and why not when it may not.
 *
 * The reason is part of the answer because a drop target that simply refuses,
 * silently, is indistinguishable from one that is broken — and the two ways a
 * drop is refused here ("it is already there" and "that machine is taken") look
 * identical from the outside.
 */
export function dropVerdict(
  payload: DragPayload,
  workspace: Workspace,
  placements: readonly Placement[],
  nodes: readonly FleetNode[],
): DropVerdict {
  // Workspaces are dragged only to sit in a different order among themselves;
  // there is nothing about a target workspace that can refuse one.
  // Sessions never land on a workspace: they belong to the machine running
  // them, and reordering is handled by the list they are already in.
  if (payload.kind === "session") {
    return { allowed: false, reason: "A session cannot be moved" };
  }
  if (payload.kind === "workspace") {
    return payload.id === workspace.id
      ? { allowed: false, reason: "Already here" }
      : { allowed: true, action: "move" };
  }
  if (payload.kind === "placement") {
    const placement = placements.find((entry) => entry.id === payload.id);
    if (!placement) return { allowed: false, reason: "That placement is gone" };
    if (placement.workspaceId === workspace.id) {
      return { allowed: false, reason: "Already in this workspace" };
    }
    return occupied(placements, workspace.id, placement.nodeId)
      ? {
          allowed: false,
          reason: `${workspace.name} already has a placement on this node`,
        }
      : { allowed: true, action: "move" };
  }

  const node = nodes.find((entry) => entry.id === payload.id);
  if (!node) return { allowed: false, reason: "That node is gone" };
  return occupied(placements, workspace.id, node.id)
    ? { allowed: false, reason: `${node.name} is already placed in ${workspace.name}` }
    : { allowed: true, action: "create" };
}

/** A workspace may only be in one place on a given machine. */
function occupied(
  placements: readonly Placement[],
  workspaceId: string,
  nodeId: string,
): boolean {
  return placements.some(
    (entry) => entry.workspaceId === workspaceId && entry.nodeId === nodeId,
  );
}

/**
 * Where a node dropped on a workspace should be checked out.
 *
 * The node's home directory is the only path the Host knows to be real on that
 * machine, and it is what the placement form already offers. A drop that had to
 * stop and ask for a path would be slower than the form it replaces.
 */
export function suggestedPath(node: Pick<FleetNode, "homeDir">): string {
  return node.homeDir || "";
}

/**
 * Which side of a row a drop lands on.
 *
 * Reordering by dropping *onto* a row can only ever mean one thing — "take its
 * place" — which leaves no way to say "put it last", and no way to tell where
 * the item will land before letting go. The half of the row the pointer is in
 * answers both.
 */
export type DropEdge = "before" | "after";

export function edgeFromPointer(
  rect: { top: number; height: number },
  clientY: number,
): DropEdge {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/**
 * The same question for a row of tiles rather than a list of rows.
 *
 * A grid flows left to right, so "before" is the left half; using the vertical
 * halves there would put the line on an edge the item cannot land on.
 */
export function horizontalEdgeFromPointer(
  rect: { left: number; width: number },
  clientX: number,
): DropEdge {
  return clientX < rect.left + rect.width / 2 ? "before" : "after";
}

/**
 * The list after `dragged` is dropped on the `edge` side of `target`.
 *
 * Removing before inserting is what makes this safe in both directions: taking
 * the item out first means the target's index is already the one it will have
 * in the final list, so dragging down does not land one slot short — the
 * off-by-one that every hand-written reorder produces the first time.
 */
export function reorder(
  ids: readonly string[],
  dragged: string,
  target: string,
  edge: DropEdge = "before",
): string[] {
  if (dragged === target) return [...ids];
  const without = ids.filter((id) => id !== dragged);
  const at = without.indexOf(target);
  // A target that is not in the list means the two came from different
  // workspaces, which is a move rather than a reorder.
  if (at === -1 || !ids.includes(dragged)) return [...ids];
  const index = edge === "before" ? at : at + 1;
  return [...without.slice(0, index), dragged, ...without.slice(index)];
}
