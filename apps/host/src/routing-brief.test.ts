import { describe, expect, it } from "vitest";
import {
  ROUTING_FIELD_LIMITS,
  clipText,
  prepareRoutingBrief,
  routingTaskContext,
  sanitizeRoutingText,
} from "./routing-brief.js";

describe("sanitizeRoutingText", () => {
  it("replaces commit hashes, digests and ids but keeps the words around them", () => {
    const text =
      "Rebase onto 8536a1fcd0de149d659af95cd6a94abf8d348441 (short 9d2ed49) and compare " +
      "151edf66a679f1ae6ce18e0877b4cab5bc770094f435f31df984686878982f29 for run " +
      "a94bbacf-c0ff-4feb-8660-544a1f61e2b7.";
    const cleaned = sanitizeRoutingText(text, 500);
    expect(cleaned).toBe(
      "Rebase onto <hash> (short <hash>) and compare <hash> for run <id>.",
    );
  });

  it("replaces absolute paths on Windows, UNC and POSIX but not relative paths", () => {
    const cleaned = sanitizeRoutingText(
      "Read C:\\Users\\someone\\.copilot\\session-state\\files\\HANDOFF.md, " +
        "\\\\server\\share\\logs\\run.json and /home/user/work/out.txt; edit src/app/main.ts.",
      500,
    );
    expect(cleaned).toBe("Read <path>, <path> and <path>; edit src/app/main.ts.");
  });

  it("keeps only the host of a link", () => {
    expect(
      sanitizeRoutingText(
        "See https://dev.azure.com/org/project/_git/repo/pullrequest/1128312?x=1 now",
        500,
      ),
    ).toBe("See <url:dev.azure.com> now");
  });

  it("does not damage ordinary words, numbers or letters-only hex-looking words", () => {
    const text = "Fix 3348 tests in 53 modules; decade facade deadbeef cafe 9d2ed49";
    expect(sanitizeRoutingText(text, 500)).toBe(
      "Fix 3348 tests in 53 modules; decade facade deadbeef cafe <hash>",
    );
  });

  it("normalizes whitespace and caps the result", () => {
    const cleaned = sanitizeRoutingText(
      `a\r\n\r\n\r\n\r\n   b\t\tc ${"x".repeat(100)}`,
      40,
    );
    expect(cleaned.length).toBeLessThanOrEqual(40);
    expect(cleaned.startsWith("a\n\nb c ")).toBe(true);
    expect(cleaned).toContain(" … ");
  });

  it("bounds a huge input before scanning it", () => {
    const cleaned = sanitizeRoutingText("word ".repeat(2_000_000), 300);
    expect(cleaned.length).toBeLessThanOrEqual(300);
  });
});

describe("clipText", () => {
  it("returns short text unchanged and keeps both ends of long text", () => {
    expect(clipText("short", 10)).toBe("short");
    const clipped = clipText(`START${"-".repeat(500)}END`, 60);
    expect(clipped.length).toBeLessThanOrEqual(60);
    expect(clipped.startsWith("START")).toBe(true);
    expect(clipped.endsWith("END")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const clipped = clipText("😀".repeat(200), 51);
    expect(clipped).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(clipped).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("prepareRoutingBrief", () => {
  it("cleans and caps every field and leaves the category untouched", () => {
    const prepared = prepareRoutingBrief({
      category: "review-deep",
      title: "Review 8536a1fcd0de149d659af95cd6a94abf8d348441",
      deliverable: "d".repeat(10_000),
      scope: "Only C:\\repo\\src",
      verify: "v".repeat(10_000),
      taskContext: {
        name: "Task",
        objective: "o".repeat(5_000),
        phase: "2 of 3: Review",
        plan: "p".repeat(5_000),
      },
    });
    expect(prepared.category).toBe("review-deep");
    expect(prepared.title).toBe("Review <hash>");
    expect(prepared.scope).toBe("Only <path>");
    expect(prepared.deliverable.length).toBeLessThanOrEqual(
      ROUTING_FIELD_LIMITS.deliverable,
    );
    expect(prepared.verify.length).toBeLessThanOrEqual(ROUTING_FIELD_LIMITS.verify);
    expect(prepared.taskContext?.objective.length).toBeLessThanOrEqual(
      ROUTING_FIELD_LIMITS.taskObjective,
    );
    expect(prepared.taskContext?.plan?.length).toBeLessThanOrEqual(
      ROUTING_FIELD_LIMITS.taskPlan,
    );
    expect(prepared.taskContext?.phase).toBe("2 of 3: Review");
  });

  it("omits the task context when there is none", () => {
    const prepared = prepareRoutingBrief({
      category: "implement",
      title: "t",
      deliverable: "d",
      scope: "s",
      verify: "v",
    });
    expect("taskContext" in prepared).toBe(false);
  });
});

describe("routingTaskContext", () => {
  it("describes the phase and the plan from the task record", () => {
    expect(
      routingTaskContext({
        name: "S07 authoring",
        objective: "Deliver one reviewed PR",
        phases: ["Inspect", "Implement and verify", "Review and publish"],
        phaseIndex: 1,
      }),
    ).toEqual({
      name: "S07 authoring",
      objective: "Deliver one reviewed PR",
      phase: "2 of 3: Implement and verify",
      plan: "Inspect → Implement and verify → Review and publish",
    });
  });

  it("leaves out the phase and plan for a task that was never planned in phases", () => {
    expect(
      routingTaskContext({ name: "n", objective: "o", phases: [], phaseIndex: 0 }),
    ).toEqual({ name: "n", objective: "o" });
  });

  it("leaves out the plan when there is a single phase", () => {
    expect(
      routingTaskContext({ name: "n", objective: "o", phases: ["Only"], phaseIndex: 0 }),
    ).toEqual({ name: "n", objective: "o", phase: "1 of 1: Only" });
  });
});
