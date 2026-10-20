import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { errorMessage, type AgentParams } from "@fleet/protocol";
import type { LogLevel } from "@fleet/protocol/log-buffer";
import { agentOutput, findAgentCommand } from "../copilot-launch.js";
import { HermesUsageReporter } from "./hermes-usage.js";
import type {
  AgentKindAdapter,
  AgentLaunch,
  AgentLaunchOptions,
  AgentSessionHandle,
  UsageContext,
  UsageReporter,
} from "./types.js";

const SessionPickersSchema = z.object({
  models: z
    .object({
      currentModelId: z.string().min(1),
      availableModels: z.array(
        z.object({
          modelId: z.string().min(1),
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    })
    .nullish(),
  modes: z
    .object({
      currentModeId: z.string().min(1),
      availableModes: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    })
    .nullish(),
});

export class HermesAgentKind implements AgentKindAdapter {
  readonly kind = "hermes";
  readonly label = "Hermes";
  readonly yolo = "auto-approve";

  constructor(private readonly params: Extract<AgentParams, { kind: "hermes" }>) {}

  stderrLogLevel(text: string): LogLevel {
    if (/\[(?:ERROR|CRITICAL)\]/i.test(text)) return "error";
    if (/\[(?:WARN|WARNING)\]/i.test(text)) return "warn";
    return "info";
  }

  async prepare(options: AgentLaunchOptions): Promise<AgentLaunch> {
    const profile = this.params.profile;
    const command = await findAgentCommand("hermes");
    if (!command)
      throw new Error(
        "Hermes was not found on this Node's PATH. Install Hermes and reconnect the Node.",
      );
    const args = ["-p", profile, "acp"];
    const failureMessage = (error: unknown, stderr: string) => {
      const detail = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      const message = errorMessage(error, "Hermes ACP failed to start");
      return `${message}${detail && !message.includes(detail) ? `: ${detail}` : ""}. Check this Node's Hermes profile with \`hermes -p ${profile} acp --check\`; configure its provider/model with \`hermes -p ${profile} acp --setup\`.`;
    };
    try {
      // Importing the Python ACP stack is startup work, not a short metadata query.
      await agentOutput(command, [...args, "--check"], options.startTimeoutMs);
    } catch (error) {
      throw new Error(failureMessage(error, ""), { cause: error });
    }
    return { command, args, failureMessage };
  }

  configOptions(
    response: acp.NewSessionResponse | acp.LoadSessionResponse,
  ): acp.SessionConfigOption[] {
    const { models, modes } = SessionPickersSchema.parse(response);
    if (!models && !modes) {
      throw new Error(
        "Hermes did not return session state. Check the selected profile and saved conversation ID; Fleet will not replace a missing conversation.",
      );
    }
    const options: acp.SessionConfigOption[] = [];
    if (models)
      options.push({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: models.currentModelId,
        options: models.availableModels.map((model) => ({
          value: model.modelId,
          name: model.name,
          ...(model.description ? { description: model.description } : {}),
        })),
      });
    if (modes)
      options.push({
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: modes.currentModeId,
        options: modes.availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      });
    return options;
  }

  async setConfigOption(
    session: AgentSessionHandle,
    id: string,
    value: string,
  ): Promise<acp.SessionConfigOption[]> {
    const option = session.options().find((entry) => entry.id === id);
    if (
      option?.type !== "select" ||
      !option.options.some((choice) => "value" in choice && choice.value === value)
    )
      throw new Error(`Hermes did not offer "${value}" for "${id}"`);
    if (id === "model") {
      // Hermes still speaks the pre-config-options ACP model API.
      await session.connection.agent.request("session/set_model", {
        sessionId: session.sessionId,
        modelId: value,
      });
    } else if (id === "mode") {
      await session.connection.agent.request(acp.methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: value,
      });
    } else {
      throw new Error(`Hermes does not support the "${id}" setting`);
    }
    session.assertActive();
    return session
      .options()
      .map((entry) =>
        entry.id === id && entry.type === "select"
          ? { ...entry, currentValue: value }
          : entry,
      );
  }

  usage(context: UsageContext): UsageReporter {
    return new HermesUsageReporter(context, this.params.profile);
  }
}
