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

/**
 * Sessions a node is still on the hook for.
 *
 * Counted against maxSessions, so anything not terminal reserves a slot even
 * while it is only queued or offline — the Node will pick it back up.
 */
export function reservedSessionCount(
  sessions: readonly FleetSession[],
  nodeId: string,
): number {
  let reserved = 0;
  for (const session of sessions) {
    if (session.nodeId === nodeId && !terminalSessionStates.has(session.state)) {
      reserved += 1;
    }
  }
  return reserved;
}
