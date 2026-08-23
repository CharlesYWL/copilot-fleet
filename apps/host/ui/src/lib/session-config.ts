import type { SessionConfigChoice, SessionConfigOption } from "@fleet/protocol";

/**
 * Which of the agent's pickers the fleet puts in front of an operator.
 *
 * The agent reports every setting it has, but some of them are not this UI's to
 * offer, and showing one anyway produces a control that argues with the rest of
 * the interface.
 */

/**
 * Permission policy belongs to the session, not to a dropdown.
 *
 * The fleet decides it once, at launch, by starting Copilot with `--allow-all`
 * or without it, and shows the answer as the session's YOLO badge. Copilot
 * reports the same fact back as an `allow_all` picker, which is redundant at
 * best and wrong at worst: on a session already launched with `--allow-all`,
 * setting it to "off" is answered with success and then ignored, so the control
 * moves, snaps back, and teaches the operator that the bar lies. Worse, if it
 * ever did take, the badge next to the session name would still promise the
 * opposite.
 */
const FLEET_OWNED_CATEGORIES = new Set(["permissions"]);
const FLEET_OWNED_IDS = new Set(["allow_all"]);

/**
 * Copilot's own category for the custom-agent picker.
 *
 * Underscored by Copilot, not by us. Matched on the category rather than the
 * id because the id is a plain `agent`, which is also a *value* of the mode
 * picker — the two are unrelated and only one of them decides who the session
 * is.
 */
export const AGENT_CATEGORY = "_agent";

export type SelectedAgent = {
  /** The picker, so the same control can be opened from wherever this shows. */
  option: SessionConfigOption;
  /** What to call it. The default persona reports an empty value. */
  name: string;
  /** False for stock Copilot, which is not worth announcing as an identity. */
  isCustom: boolean;
};

/**
 * Which agent a session is running as, if the question applies to it at all.
 *
 * It often does not: Copilot only offers this picker when it found agent files
 * near the session's working directory, so a checkout with none has no such
 * option and nothing to say.
 *
 * Worth its own accessor rather than being read as one setting among several,
 * because it is not a setting. A custom agent is in force on every turn, it
 * survives compaction, and it survives a resume — measured, not assumed. It is
 * closer to what the session *is* than to how it is configured.
 */
export function selectedAgent(
  options: readonly SessionConfigOption[],
): SelectedAgent | undefined {
  const option = options.find((entry) => entry.category === AGENT_CATEGORY);
  if (!option) return undefined;
  const chosen = option.choices.find((choice) => choice.value === option.currentValue);
  return {
    option,
    name: chosen?.name || option.currentValue || "Copilot",
    isCustom: option.currentValue !== "",
  };
}

/**
 * The agent's name, but only when it is worth saying.
 *
 * For the places that list many sessions at once. Nearly all of them run stock
 * Copilot — workers are dispatched without an agent on purpose — so printing
 * "Copilot" on every row would bury the one row where it matters.
 */
export function customAgentName(
  options: readonly SessionConfigOption[],
): string | undefined {
  const agent = selectedAgent(options);
  return agent?.isCustom ? agent.name : undefined;
}

/**
 * Every value some session has reported for one picker.
 *
 * The settings screen offers defaults from what the fleet has actually seen
 * rather than from a list kept here: model names change on Copilot's schedule,
 * not ours, and a list hardcoded here is wrong from the first release that adds
 * one.
 *
 * The cost is that the choices are empty until a session has run. That is the
 * honest state — before then the Host genuinely does not know what this fleet's
 * Copilot offers.
 */
export function observedChoices(
  sessions: readonly { configOptions: SessionConfigOption[] }[],
  optionId: string,
): SessionConfigChoice[] {
  const seen = new Map<string, SessionConfigChoice>();
  for (const session of sessions) {
    const option = session.configOptions.find((entry) => entry.id === optionId);
    for (const choice of option?.choices ?? []) seen.set(choice.value, choice);
  }
  return [...seen.values()];
}

/**
 * The pickers worth rendering.
 *
 * Also drops any option with nothing to choose between: those are readouts, and
 * a dropdown that cannot move invites a click that does nothing.
 *
 * The agent is excluded because it is shown beside the session's name instead.
 * Leaving it here as well put two controls in the same strip that both read as
 * "agent" — one of them the mode picker, whose *value* is the word Agent — and
 * the one people went looking for was the other one.
 */
export function visibleConfigOptions(
  options: readonly SessionConfigOption[],
  session: { runRole?: string } = {},
): SessionConfigOption[] {
  /*
   * Mode is the fleet's for a session the fleet drives.
   *
   * Copilot's autopilot works until it calls `task_complete`, and plan mode
   * produces a plan rather than an action; both contradict the contract these
   * sessions run under, which is to take one turn and stop. The Host pins the
   * mode at startup — offering a control that undoes that would just move the
   * failure to whenever somebody used it.
   */
  const fleetOwnsMode = session.runRole === "lead" || session.runRole === "worker";
  return options.filter(
    (option) =>
      option.choices.length > 1 &&
      option.category !== AGENT_CATEGORY &&
      !(fleetOwnsMode && option.category === "mode") &&
      !FLEET_OWNED_CATEGORIES.has(option.category) &&
      !FLEET_OWNED_IDS.has(option.id),
  );
}
