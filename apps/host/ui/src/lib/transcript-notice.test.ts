import { describe, expect, it } from "vitest";
import {
  QUIET_MS,
  STALLED_MS,
  transcriptNotice,
  type NoticeInput,
} from "./transcript-notice";

const NOW = 1_000_000;

const input = (overrides: Partial<NoticeInput> = {}): NoticeInput => ({
  session: { state: "running" },
  pinned: true,
  unseen: 0,
  lastEventAt: NOW,
  now: NOW,
  ...overrides,
});

describe("transcriptNotice", () => {
  it("says nothing while the reader is at the end and output is flowing", () => {
    expect(transcriptNotice(input())).toBeUndefined();
  });

  it("offers a way back once output arrives behind the reader", () => {
    const notice = transcriptNotice(input({ pinned: false, unseen: 4 }));

    expect(notice).toMatchObject({ kind: "new-output", count: 4 });
    expect(notice?.kind === "new-output" && notice.label).toContain("4");
  });

  it("counts one line without pluralising it", () => {
    const notice = transcriptNotice(input({ pinned: false, unseen: 1 }));
    expect(notice?.kind === "new-output" && notice.label).toContain("1 new line ");
  });

  it("does not offer to jump when the reader is already there", () => {
    expect(transcriptNotice(input({ pinned: true, unseen: 9 }))).toBeUndefined();
  });

  it("mentions a running session that has gone quiet", () => {
    const notice = transcriptNotice(input({ now: NOW + QUIET_MS }));

    expect(notice?.kind).toBe("quiet");
    expect(notice?.kind === "quiet" && notice.label).toBe("Still running");
  });

  it("suggests the node only after a long silence, and still does not fail it", () => {
    /*
     * A long compile and a dead node look the same from here. Saying "failed"
     * would be a guess the session's own state machine has not made, so this
     * reports the silence and leaves the conclusion to the operator.
     */
    const notice = transcriptNotice(input({ now: NOW + STALLED_MS }));

    expect(notice?.kind).toBe("stalled");
    expect(notice?.kind === "stalled" && notice.label).toBe("Still running");
    expect(notice?.kind === "stalled" && notice.detail).toContain("node");
  });

  it("keeps quiet about a session that is not running", () => {
    expect(
      transcriptNotice(input({ session: { state: "idle" }, now: NOW + STALLED_MS })),
    ).toBeUndefined();
  });

  it("puts unread output above a silence notice", () => {
    // Both are true; only one can be the most useful, and unread output is the
    // one with something to do about it.
    const notice = transcriptNotice(
      input({ pinned: false, unseen: 2, now: NOW + STALLED_MS }),
    );

    expect(notice?.kind).toBe("new-output");
  });

  it("says nothing about a session that has produced no events at all", () => {
    expect(transcriptNotice(input({ lastEventAt: 0, now: NOW + STALLED_MS }))).toBe(
      undefined,
    );
  });
});
