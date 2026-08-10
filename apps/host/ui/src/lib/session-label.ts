import type { FleetSession } from "@fleet/protocol";

/** Keeps a tree row and a tile head to one line of readable text. */
const MAX_DERIVED_LENGTH = 72;

/**
 * What to call a session on screen.
 *
 * A session is born with only its initial prompt, and a prompt is a paragraph
 * rather than a label — three agents started from the same template all read
 * identically in the sidebar. The name an operator gives it wins; until then
 * this shows as much of the prompt as fits on one line, so an unnamed session
 * still says something about itself.
 */
export function sessionLabel(session: FleetSession): string {
  const name = session.name.trim();
  if (name) return name;
  return firstLine(session.initialPrompt);
}

/** True when the label is standing in for a name nobody has chosen yet. */
export function isDerivedLabel(session: FleetSession): boolean {
  return session.name.trim().length === 0;
}

function firstLine(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!line) return "Untitled session";
  if (line.length <= MAX_DERIVED_LENGTH) return line;
  // Cut on a word boundary when there is one close to the limit, so the label
  // does not end mid-identifier.
  const clipped = line.slice(0, MAX_DERIVED_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${lastSpace > MAX_DERIVED_LENGTH - 16 ? clipped.slice(0, lastSpace) : clipped}…`;
}
