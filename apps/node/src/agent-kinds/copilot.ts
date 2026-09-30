import type * as acp from "@agentclientprotocol/sdk";
import {
  attachmentSummary,
  errorMessage,
  type ContextTier,
  type PromptAttachment,
} from "@fleet/protocol";
import {
  agentOutput,
  resolveCopilotLaunch,
  type CopilotLaunch,
} from "../copilot-launch.js";
import { CopilotUsageReporter } from "./copilot-usage.js";
import type {
  AgentKindAdapter,
  AgentLaunch,
  AgentLaunchOptions,
  AgentSessionHandle,
  UsageContext,
} from "./types.js";

export const MIN_COPILOT_ACP_AUTH_VERSION = "1.0.69";

export function copilotLaunchArgs(yolo: boolean, contextTier?: ContextTier): string[] {
  const args = ["--acp", "--stdio"];
  if (yolo) args.push("--allow-all");
  if (contextTier) args.push("--context", contextTier);
  return args;
}

export async function copilotSupportsContextTier(
  command: string,
  help: (command: string) => Promise<string> = (executable) =>
    agentOutput(executable, ["--help"]),
): Promise<boolean> {
  try {
    return (await help(command)).includes("--context");
  } catch {
    // Launch will report the underlying failure; old CLIs must not get this flag.
    return false;
  }
}

export function copilotVersionFromOutput(output: string): string | undefined {
  const match =
    output.match(/\bGitHub Copilot(?: CLI)?\s+(\d+)\.(\d+)\.(\d+)/i) ??
    output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\b/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function copilotAcpAuthVersionError(
  output: string,
  provider: CopilotLaunch["provider"] = "copilot",
): string | undefined {
  const version = copilotVersionFromOutput(output);
  if (!version || compareVersions(version, MIN_COPILOT_ACP_AUTH_VERSION) >= 0)
    return undefined;
  return provider === "agency"
    ? `Agency's Copilot CLI ${version} is too old for reliable ACP authentication. ` +
        `Update Agency and its Copilot CLI on this node (minimum ${MIN_COPILOT_ACP_AUTH_VERSION}), ` +
        "then run `agency copilot` and use `/login` before retrying."
    : `Copilot CLI ${version} is too old for reliable ACP authentication. ` +
        `Run \`copilot update\` on this node (minimum ${MIN_COPILOT_ACP_AUTH_VERSION}), ` +
        "then run `copilot login` and retry.";
}

export function copilotFailureMessage(
  error: unknown,
  stderr = "",
  provider: CopilotLaunch["provider"] = "copilot",
): string {
  const primary = errorMessage(error, "Copilot ACP failed to start");
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const message = detail && !primary.includes(detail) ? `${primary}: ${detail}` : primary;
  if (
    /\b(?:not (?:logged|signed) in|login required|authentication (?:required|failed)|unauthenticated|unauthorized)\b/i.test(
      message,
    ) &&
    !message.includes("copilot login")
  ) {
    return provider === "agency"
      ? `${message}. Run \`agency copilot\` on this node and use \`/login\`, then retry.`
      : `${message}. Run \`copilot login\` on this node, then retry.`;
  }
  return message;
}

export function configRecoveryRequest(
  options: readonly acp.SessionConfigOption[],
  yolo: boolean,
): { configId: string; value: string } | undefined {
  if (options.length > 0) return undefined;
  return { configId: "allow_all", value: yolo ? "on" : "off" };
}

export function isCapiRequestTooLarge(error: unknown): boolean {
  return /request is too large to send through CAPI Responses/i.test(errorMessage(error));
}

export function contextRolloverPrompt(
  originalAssignment: string,
  latestRequest: string,
  attachments: readonly PromptAttachment[] = [],
): string {
  const assignment = originalAssignment.trim().slice(0, 10_000);
  const latest = latestRequest.trim().slice(-5_000);
  const attachmentText = attachments
    .map(attachmentSummary)
    .map((attachment) => `${attachment.name} (${attachment.bytes} bytes)`)
    .join(", ")
    .slice(0, 500);
  return [
    "Continue the same Fleet task in this fresh conversation. The previous Copilot conversation exceeded the CAPI request-size limit. Treat the current workspace files and Git state as authoritative; do not restart completed work.",
    assignment ? `Original assignment:\n${assignment}` : "",
    latest ? `Latest request:\n${latest}` : "",
    attachmentText
      ? `The latest request included attachments that were omitted from rollover to keep the request bounded: ${attachmentText}. Inspect the workspace copies if needed.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 16_000);
}

export class CopilotAgentKind implements AgentKindAdapter {
  readonly kind = "copilot";
  readonly label = "Copilot";
  readonly yolo = "launch-flag";
  readonly tracksUnpromptedWork = true;
  readonly rollover = {
    matches: isCapiRequestTooLarge,
    prompt: contextRolloverPrompt,
    notice:
      "Copilot\u2019s saved conversation exceeded the request-size limit. Fleet started a fresh conversation in the same workspace and continued with a bounded task handoff.",
  };
  private readonly validation = new Map<string, Promise<void>>();
  private readonly contextSupport = new Map<string, Promise<boolean>>();

  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  async prepare(options: AgentLaunchOptions): Promise<AgentLaunch> {
    const launch = await resolveCopilotLaunch(options.agencyMode, this.command);
    options.signal?.throwIfAborted();
    const key = JSON.stringify([launch.command, launch.args]);
    let validation = this.validation.get(key);
    if (!validation) {
      validation = this.metadata(launch, "--version")
        .then((output) => {
          const failure = copilotAcpAuthVersionError(output, launch.provider);
          if (failure) throw new Error(failure);
        })
        .catch((error: unknown) => {
          this.validation.delete(key);
          throw error;
        });
      this.validation.set(key, validation);
    }
    await validation;
    options.signal?.throwIfAborted();
    let support = this.contextSupport.get(key);
    if (!support) {
      support = copilotSupportsContextTier(launch.command, () =>
        this.metadata(launch, "--help"),
      );
      this.contextSupport.set(key, support);
    }
    const contextTier = (await support) ? options.contextTier : undefined;
    options.signal?.throwIfAborted();
    return {
      command: launch.command,
      args: [...launch.args, ...copilotLaunchArgs(options.yolo, contextTier)],
      contextTier,
      notice:
        [
          launch.notice,
          ...(!contextTier
            ? [
                "This Copilot does not support --context; update it to select a context window.",
              ]
            : []),
        ]
          .filter(Boolean)
          .join("\n") || undefined,
      failureMessage: (error, stderr) =>
        copilotFailureMessage(error, stderr, launch.provider),
    };
  }

  usage(context: UsageContext): CopilotUsageReporter {
    return new CopilotUsageReporter(context);
  }

  async afterSessionStart(session: AgentSessionHandle): Promise<void> {
    const recovery = configRecoveryRequest(session.options(), session.yolo);
    if (recovery) {
      try {
        await session.setConfigOption(recovery.configId, recovery.value);
      } catch {
        // Some Copilot versions have no picker; retain the existing recovery behavior.
        session.assertActive();
      }
    }
    session.assertActive();
    if (!session.customAgent) return;
    const picker = session.options().find((option) => option.category === "_agent");
    if (!picker) {
      session.notice(
        `Copilot offered no agent picker, so "${session.customAgent}" was not applied`,
      );
      return;
    }
    try {
      await session.setConfigOption(picker.id, session.customAgent);
    } catch (error) {
      session.assertActive();
      session.notice(
        `Could not select agent "${session.customAgent}": ${errorMessage(error)}`,
      );
    }
  }

  private metadata(launch: CopilotLaunch, flag: string): Promise<string> {
    return agentOutput(
      launch.command,
      [...launch.args, ...(launch.provider === "agency" ? ["--"] : []), flag],
      launch.provider === "agency" ? this.timeoutMs : 15_000,
    );
  }
}
