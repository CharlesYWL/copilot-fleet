import { describe, expect, it } from "vitest";
import { RunNoteMetadataSchema, RunNoteSchema, RunNoteSummarySchema } from "./index.js";

describe("task checkpoints", () => {
  it("accepts legacy notes without synthesizing metadata", () => {
    const note = {
      id: "note",
      runId: "task",
      phaseIndex: 0,
      body: "A long original report",
      createdAt: "2026-09-22T04:14:53.797Z",
    };
    expect(RunNoteSchema.parse(note)).toEqual(note);
  });

  it.each(["", " \t ", "first\nsecond", "first\rsecond", "x".repeat(241)])(
    "rejects an unusable checkpoint headline: %j",
    (summary) => expect(RunNoteSummarySchema.safeParse(summary).success).toBe(false),
  );

  it("keeps checkpoint metadata distinct from identity and timestamp", () => {
    expect(
      RunNoteMetadataSchema.parse({
        summary: " PR opened. ",
        kind: "progress",
        source: "orchestrator",
        sessionId: "lead",
        id: "forged",
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      summary: "PR opened.",
      kind: "progress",
      source: "orchestrator",
      sessionId: "lead",
    });
  });
});
