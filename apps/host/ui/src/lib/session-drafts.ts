import type { DraftAttachment } from "./attachments";

/** What an operator has written but not yet sent, for one session. */
export type SessionDraft = {
  prompt: string;
  attachments: DraftAttachment[];
};

export const EMPTY_DRAFT: SessionDraft = { prompt: "", attachments: [] };

export type DraftsBySession = Record<string, SessionDraft>;

export function draftFor(drafts: DraftsBySession, sessionId: string): SessionDraft {
  return drafts[sessionId] ?? EMPTY_DRAFT;
}

function isEmpty(draft: SessionDraft): boolean {
  return draft.prompt.length === 0 && draft.attachments.length === 0;
}

/**
 * Applies an edit to one session's draft.
 *
 * Drafts live above the terminal view rather than inside it because that view
 * is unmounted constantly — switching sessions, opening Settings, moving between
 * the tree and the wall, closing the focus dialog — and a half-written prompt
 * that disappears on any of those is worse than useless. Keying by session also
 * settles what the old reset-on-switch did crudely: each session keeps its own
 * message instead of inheriting whatever was typed for another.
 *
 * An emptied draft is deleted rather than stored, so "no draft" and "an empty
 * draft" cannot disagree, and the map does not accumulate a row per session
 * merely visited.
 */
export function withDraft(
  drafts: DraftsBySession,
  sessionId: string,
  update: (current: SessionDraft) => SessionDraft,
): DraftsBySession {
  const next = update(draftFor(drafts, sessionId));
  if (isEmpty(next)) {
    if (!(sessionId in drafts)) return drafts;
    const { [sessionId]: _removed, ...rest } = drafts;
    return rest;
  }
  return { ...drafts, [sessionId]: next };
}

/**
 * Forgets drafts for sessions that no longer exist.
 *
 * Returns the same object when nothing was dropped: this runs off every
 * snapshot, and a fresh object each time would re-render the whole tree for a
 * heartbeat that changed nothing.
 */
export function pruneDrafts(
  drafts: DraftsBySession,
  liveSessionIds: ReadonlySet<string>,
): DraftsBySession {
  const stale = Object.keys(drafts).filter((id) => !liveSessionIds.has(id));
  if (stale.length === 0) return drafts;
  const kept: DraftsBySession = {};
  for (const [id, draft] of Object.entries(drafts)) {
    if (liveSessionIds.has(id)) kept[id] = draft;
  }
  return kept;
}
