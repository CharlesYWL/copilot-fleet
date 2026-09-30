import {
  agentKindLabels,
  type FleetNode,
  type FleetSession,
  type Placement,
} from "@fleet/protocol";

export type LocalResume =
  | { command: string; shell: string; reason?: never }
  | { command?: never; shell?: never; reason: string };

export function sessionWorkingDirectory(
  session: FleetSession,
  placement?: Placement,
): string | undefined {
  return (
    session.executionBinding?.cwd ??
    (placement?.id === session.placementId && placement.nodeId === session.nodeId
      ? placement.localPath
      : undefined)
  );
}

export function localResume(
  session: FleetSession,
  node?: FleetNode,
  placement?: Placement,
): LocalResume {
  if (!session.agentSessionId) {
    return {
      reason: `${agentKindLabels[session.agentParams?.kind ?? "copilot"]} has not reported a native session ID yet.`,
    };
  }
  if (session.agentSessionId.startsWith("mock-") || node?.capabilities.includes("mock")) {
    return { reason: "Demo sessions cannot be resumed in Copilot CLI." };
  }
  const cwd = sessionWorkingDirectory(session, placement);
  if (!cwd) {
    return { reason: "The session's placement is unavailable." };
  }
  if (!node || node.id !== session.nodeId) {
    return { reason: "The node's operating system is unavailable." };
  }
  const command = (quote: (value: string) => string) =>
    session.agentParams?.kind === "hermes"
      ? `hermes -p ${quote(session.agentParams.profile)} --resume ${quote(session.agentSessionId)} --no-restore-cwd`
      : `copilot --resume=${quote(session.agentSessionId)}`;

  if (node.os === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return {
      shell: "PowerShell",
      command: `& {\n  Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop\n  ${command(quote)}\n}`,
    };
  }
  if (node.os === "linux" || node.os === "darwin") {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      shell: "Bash / Zsh",
      command: `cd -- ${quote(cwd)} &&\n${command(quote)}`,
    };
  }
  return { reason: `Local resume instructions are unavailable for ${node.os}.` };
}
