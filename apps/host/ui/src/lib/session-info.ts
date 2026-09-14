import type { FleetNode, FleetSession, Placement } from "@fleet/protocol";

export type LocalResume =
  | { command: string; shell: string; reason?: never }
  | { command?: never; shell?: never; reason: string };

export function localResume(
  session: FleetSession,
  node?: FleetNode,
  placement?: Placement,
): LocalResume {
  if (!session.agentSessionId) {
    return { reason: "Copilot has not reported a native session ID yet." };
  }
  if (session.agentSessionId.startsWith("mock-") || node?.capabilities.includes("mock")) {
    return { reason: "Demo sessions cannot be resumed in Copilot CLI." };
  }
  if (
    !placement ||
    placement.id !== session.placementId ||
    placement.nodeId !== session.nodeId
  ) {
    return { reason: "The session's placement is unavailable." };
  }
  if (!node || node.id !== session.nodeId) {
    return { reason: "The node's operating system is unavailable." };
  }

  if (node.os === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return {
      shell: "PowerShell",
      command: `& {\n  Set-Location -LiteralPath ${quote(placement.localPath)} -ErrorAction Stop\n  copilot --resume=${quote(session.agentSessionId)}\n}`,
    };
  }
  if (node.os === "linux" || node.os === "darwin") {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      shell: "Bash / Zsh",
      command: `cd -- ${quote(placement.localPath)} &&\ncopilot --resume=${quote(session.agentSessionId)}`,
    };
  }
  return { reason: `Local resume instructions are unavailable for ${node.os}.` };
}
