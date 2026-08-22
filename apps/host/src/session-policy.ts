import {
  HOST_YOLO_CAPABILITY,
  SESSION_CONFIG_CAPABILITY,
  terminalSessionStates,
  type FleetNode,
  type FleetSession,
} from "@fleet/protocol";

/**
 * Older node agents ignore the yolo flag and always launch Copilot with
 * prompts enabled. The Host must refuse rather than downgrade, because the UI
 * badge would otherwise promise unattended execution that never happens.
 */
export function yoloUnsupportedReason(
  node: Pick<FleetNode, "name" | "capabilities">,
  yolo: boolean,
): string | undefined {
  if (!yolo || node.capabilities.includes(HOST_YOLO_CAPABILITY)) return undefined;
  return `Node "${node.name}" runs an older agent that cannot apply YOLO mode. Update and restart it, or turn YOLO off for this session.`;
}

/**
 * Why this node cannot be asked to change a session picker, if it cannot.
 *
 * An older agent validates every frame against its own copy of the command
 * union and closes the socket on anything unfamiliar, so an unsupported
 * `set_config_option` would cost the node its connection rather than fail the
 * request. Refusing here keeps the damage to one 409.
 */
export function configUnsupportedReason(
  node: Pick<FleetNode, "name" | "capabilities">,
): string | undefined {
  if (node.capabilities.includes(SESSION_CONFIG_CAPABILITY)) return undefined;
  return `Node "${node.name}" runs an older agent that cannot change session options. Update and restart it.`;
}

/** What a session is allowed to do, which is what its capacity is counted against. */
export type SessionKind = "writing" | "read-only";

/**
 * Sessions a node is still on the hook for, counted by what they may do.
 *
 * Anything not terminal reserves a slot even while it is only queued or
 * offline — the Node will pick it back up.
 *
 * Writing and reading are counted separately because they are limited by
 * different things. Work that changes a checkout is limited by how much
 * concurrent change a person can follow and a tree can take; work that only
 * reads is limited by the machine. Sharing one number meant a survey of a
 * second repository queued behind an implementation it had nothing to do with,
 * and an orchestrator told there were no free slots when what it wanted to do
 * was look at something.
 *
 * Read-only work is bounded rather than free. An explore is a real Copilot
 * process with a real appetite, and "reads are free" is the kind of rule that
 * is true until an orchestrator decides to look at thirty things at once.
 */
export function reservedSessionCount(
  sessions: readonly FleetSession[],
  nodeId: string,
  kind: SessionKind = "writing",
): number {
  let reserved = 0;
  for (const session of sessions) {
    if (session.nodeId !== nodeId) continue;
    if (terminalSessionStates.has(session.state)) continue;
    // Compared as a boolean rather than by identity: a session object that
    // never went through the schema — a fixture, or anything hand-built — has
    // the field missing rather than false, and `undefined === false` would put
    // it in neither bucket and quietly stop counting it at all.
    if (Boolean(session.readOnly) === (kind === "read-only")) reserved += 1;
  }
  return reserved;
}

/**
 * How much read-only work a node will take at once.
 *
 * The same allowance as writing work, on its own budget: a machine sized for
 * four pieces of work will run four of each rather than four in total. That is
 * a deliberate doubling of the ceiling, and it is the price of research never
 * queueing behind implementation.
 */
export function readOnlyCapacity(node: Pick<FleetNode, "maxSessions">): number {
  return node.maxSessions;
}

/** The ceiling for work of a given kind, which is what a caller must not exceed. */
export function capacityFor(
  node: Pick<FleetNode, "maxSessions">,
  kind: SessionKind,
): number {
  return kind === "read-only" ? readOnlyCapacity(node) : node.maxSessions;
}
