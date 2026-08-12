import { describe, expect, it } from "vitest";
import type { DraftAttachment } from "./attachments";
import {
  EMPTY_DRAFT,
  draftFor,
  pruneDrafts,
  withDraft,
  type DraftsBySession,
} from "./session-drafts";

const file = (id: string): DraftAttachment => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  data: "AAAA",
});

const typing = (text: string) => (current: { attachments: DraftAttachment[] }) => ({
  ...current,
  prompt: text,
});

describe("withDraft", () => {
  it("keeps each session's message to itself", () => {
    // The whole bug: one composer served every session, so switching either
    // wiped what was typed or offered it to the wrong agent.
    let drafts: DraftsBySession = {};
    drafts = withDraft(drafts, "a", typing("for session a"));
    drafts = withDraft(drafts, "b", typing("for session b"));

    expect(draftFor(drafts, "a").prompt).toBe("for session a");
    expect(draftFor(drafts, "b").prompt).toBe("for session b");
  });

  it("reports an untouched session as having nothing written", () => {
    expect(draftFor({}, "never-visited")).toBe(EMPTY_DRAFT);
  });

  it("forgets a draft that was emptied", () => {
    // Sending clears the draft; keeping an empty row would leave every session
    // ever opened in the map for the life of the tab.
    let drafts = withDraft({}, "a", typing("something"));
    drafts = withDraft(drafts, "a", () => EMPTY_DRAFT);
    expect("a" in drafts).toBe(false);
  });

  it("keeps a draft that is only an attachment", () => {
    // A file with no words is still a message the operator would hate to lose.
    const drafts = withDraft({}, "a", (current) => ({
      ...current,
      attachments: [file("one")],
    }));
    expect(draftFor(drafts, "a").attachments).toHaveLength(1);
  });

  it("does not churn the map when clearing something that was never there", () => {
    const drafts: DraftsBySession = {};
    expect(withDraft(drafts, "a", () => EMPTY_DRAFT)).toBe(drafts);
  });
});

describe("pruneDrafts", () => {
  it("drops drafts for sessions that are gone", () => {
    const drafts = withDraft(withDraft({}, "a", typing("x")), "b", typing("y"));
    const kept = pruneDrafts(drafts, new Set(["b"]));
    expect(Object.keys(kept)).toEqual(["b"]);
  });

  it("returns the same object when nothing is stale", () => {
    // This runs off every snapshot, and a heartbeat that changed nothing must
    // not hand the tree a new object to re-render for.
    const drafts = withDraft({}, "a", typing("x"));
    expect(pruneDrafts(drafts, new Set(["a", "b"]))).toBe(drafts);
  });
});
