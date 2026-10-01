import { AgentParamsSchema, type AgentParams, type DetectedAgent } from "@fleet/protocol";
import { findAgentCommand } from "../copilot-launch.js";
import type { CopilotAgentKind } from "./copilot.js";
import { HermesAgentKind } from "./hermes.js";
import type { AgentKindAdapter } from "./types.js";

export function createAgentKind(
  params: AgentParams,
  copilot: CopilotAgentKind,
): AgentKindAdapter {
  const parsed = AgentParamsSchema.parse(params);
  switch (parsed.kind) {
    case "copilot":
      return copilot;
    case "hermes":
      return new HermesAgentKind(parsed);
  }
}

export async function detectAgentKinds(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedAgent[]> {
  // Copilot is the Node's baseline (including its configured custom launcher).
  const kinds: DetectedAgent[] = [{ kind: "copilot" }];
  if (await findAgentCommand("hermes", env)) kinds.push({ kind: "hermes" });
  return kinds;
}
