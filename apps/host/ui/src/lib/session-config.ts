import type { SessionConfigOption } from "@fleet/protocol";

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
 * The pickers worth rendering.
 *
 * Also drops any option with nothing to choose between: those are readouts, and
 * a dropdown that cannot move invites a click that does nothing.
 */
export function visibleConfigOptions(
  options: readonly SessionConfigOption[],
): SessionConfigOption[] {
  return options.filter(
    (option) =>
      option.choices.length > 1 &&
      !FLEET_OWNED_CATEGORIES.has(option.category) &&
      !FLEET_OWNED_IDS.has(option.id),
  );
}
