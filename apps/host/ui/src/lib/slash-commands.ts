import type { SessionCommand } from "@fleet/protocol";

/**
 * The slash menu's state, derived from the composer text alone.
 *
 * Deriving rather than tracking means the menu cannot disagree with the box:
 * pasting, undo, and switching sessions all change the text through paths that
 * would each have had to remember to close a menu held in its own state.
 */
export type SlashQuery = {
  /** Whether the menu should be showing at all. */
  open: boolean;
  /** The command name typed so far, without the slash. */
  term: string;
};

/**
 * A prompt is picking a command while it is a single `/word` and nothing more.
 *
 * The space is what ends it: `/model claude` is a command with an argument, and
 * the operator typing that argument is not choosing a command any more. Leading
 * whitespace disqualifies it too, so a pasted code block starting with a path
 * comment does not open a menu.
 */
export function slashQuery(text: string): SlashQuery {
  if (!text.startsWith("/")) return { open: false, term: "" };
  const term = text.slice(1);
  if (/[\s]/.test(term)) return { open: false, term: "" };
  return { open: true, term };
}

/**
 * Commands matching what has been typed, best first.
 *
 * Prefix matches come before substring ones because the first characters are
 * what someone typing a name they already know will produce, and burying
 * `/model` under `/modern-web-design` would make the menu feel wrong.
 */
export function matchCommands(
  commands: readonly SessionCommand[],
  term: string,
  limit = 8,
): SessionCommand[] {
  const needle = term.toLowerCase();
  const prefix: SessionCommand[] = [];
  const contains: SessionCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (needle && name.includes(needle)) contains.push(command);
  }
  return [...prefix, ...contains].slice(0, limit);
}

export type CommandChoice = {
  /** What the composer should contain after the command is chosen. */
  text: string;
  /** Whether choosing it is the whole request, or an argument is still wanted. */
  submit: boolean;
};

/**
 * What picking a command does to the composer.
 *
 * A command that takes an argument leaves the caret after a space rather than
 * running: `/model` with nothing after it answers "no model is currently
 * selected", which is a confusing thing to have happen because someone pressed
 * Enter on a menu entry.
 */
export function applyCommand(command: SessionCommand): CommandChoice {
  const takesInput = command.hint !== undefined;
  return {
    text: takesInput ? `/${command.name} ` : `/${command.name}`,
    submit: !takesInput,
  };
}

/** Moves a highlighted index by `delta`, wrapping at both ends. */
export function moveHighlight(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}
