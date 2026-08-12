import type * as acp from "@agentclientprotocol/sdk";
import type {
  SessionCommand,
  SessionConfigChoice,
  SessionConfigOption,
} from "@fleet/protocol";

/**
 * ACP's view of commands and pickers, flattened into the fleet's own shape.
 *
 * The translation lives apart from the agent so it can be exercised against the
 * payloads Copilot actually sends without spawning one: these are the only
 * places where a change in the ACP schema can quietly turn a populated model
 * chooser into an empty one.
 */

/** Booleans have no option list of their own, so they are given the only two. */
const BOOLEAN_CHOICES: SessionConfigChoice[] = [
  { value: "true", name: "On", description: "" },
  { value: "false", name: "Off", description: "" },
];

export function toSessionCommands(
  commands: readonly acp.AvailableCommand[],
): SessionCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? "",
    // An empty hint is how Copilot spells "takes an argument I cannot describe"
    // for commands like `/init`; keeping it distinct from absent lets the UI
    // wait for input rather than firing the command the moment it is picked.
    ...(command.input ? { hint: command.input.hint ?? "" } : {}),
  }));
}

function toChoice(option: acp.SessionConfigSelectOption): SessionConfigChoice {
  return {
    value: option.value,
    name: option.name,
    description: option.description ?? "",
  };
}

/**
 * Flattens ACP's select options, which are either a flat list or groups.
 *
 * Groups are only a display device and value ids are unique across the whole
 * option, so folding them keeps one addressable list instead of spreading a
 * grouping concept through the Host and the browser for the sake of a label.
 */
function toChoices(options: acp.SessionConfigSelectOptions): SessionConfigChoice[] {
  return options.flatMap((entry) =>
    "group" in entry ? entry.options.map(toChoice) : [toChoice(entry)],
  );
}

export function toSessionConfigOptions(
  options: readonly acp.SessionConfigOption[],
): SessionConfigOption[] {
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    description: option.description ?? "",
    category: option.category ?? "",
    // Booleans carry a real boolean; everything downstream addresses values as
    // strings, and the node converts back when it sets one.
    currentValue: String(option.currentValue ?? ""),
    choices: option.type === "select" ? toChoices(option.options) : BOOLEAN_CHOICES,
  }));
}

/**
 * The value to send for `configId`, typed the way that option expects.
 *
 * ACP's request is a union: a boolean option takes a real boolean and rejects
 * the string "true". Clients only ever hold strings, so the agent's own copy of
 * the option list — not a guess from the shape of the value — is what decides.
 */
export function configValueFor(
  options: readonly acp.SessionConfigOption[],
  configId: string,
  value: string,
): string | boolean {
  const option = options.find((candidate) => candidate.id === configId);
  // Unknown options go out as text rather than guessed at: the agent validates
  // them anyway, and its rejection names the values it does accept.
  if (option?.type !== "boolean") return value;
  return value === "true";
}
