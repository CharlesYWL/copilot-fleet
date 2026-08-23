/**
 * Naming an orchestrator's conversation from the first thing a person says to
 * it.
 *
 * Worth being precise about what this is: it is a **trim, not a summary**.
 * Copilot does emit a session title of its own, but measuring it settled the
 * question — it fires once, on the first turn, carrying that prompt verbatim,
 * and never updates. For a lead session the first prompt is the Host's
 * briefing, so its title would read "You are running as the fleet
 * orchestrator…" for every conversation ever opened.
 *
 * A real summary would need a model call for something a person reads once, in
 * a list, and can rename in two clicks. The first sentence of what they asked
 * for identifies a conversation nearly as well and costs nothing.
 */

/** Names that mean "nobody has named this", so a real one may replace them. */
const PLACEHOLDER_NAMES = new Set([
  "",
  "orchestrator",
  "conversation",
  "new conversation",
]);

export function isUnnamed(name: string): boolean {
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase());
}

const MAX_TITLE = 48;

/**
 * A conversation title from a person's first message.
 *
 * Cut at a sentence first, because the opening sentence of a request is almost
 * always the request; falls back to a word boundary so a long one does not end
 * mid-word, and only then to a hard cut.
 */
export function conversationTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat === "") return "";

  const sentence = flat.split(/(?<=[.!?。！？])\s/)[0]?.trim() ?? flat;
  const candidate = sentence.length > 0 && sentence.length <= MAX_TITLE ? sentence : flat;
  if (candidate.length <= MAX_TITLE) return stripTrailingPunctuation(candidate);

  const cut = candidate.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  /*
   * A language without spaces gets the hard cut, which is correct rather than
   * lazy: `lastIndexOf` returns -1 there, and a title trimmed to the last space
   * in a Chinese sentence would be the whole thing or nothing.
   */
  const trimmed = lastSpace > MAX_TITLE / 2 ? cut.slice(0, lastSpace) : cut;
  return `${stripTrailingPunctuation(trimmed)}…`;
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[\s.,;:!?。，、；：！？]+$/u, "");
}
