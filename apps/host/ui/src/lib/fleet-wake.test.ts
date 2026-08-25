import { describe, expect, it } from "vitest";
import { parseWake, wakeDetail, wakeTitle } from "./fleet-wake";

/** Written exactly as `wakeEnvelope` in apps/host/src/orchestrator/briefing.ts does. */
const envelope = [
  `<fleet-wake task="PR for bug 2129276 empty-state fix" phase="Open PR" (1/1) wakes=2/12>`,
  "Just finished:",
  "- Open PR for the empty-state illustration fix (implement): succeeded",
  "  I'll start with git status as instructed, plus check the machine identity.",
  "Still running:",
  "- Re-measure the icon (verify)",
  "</fleet-wake>",
  "",
  "Nothing else is running. Dispatch the next step, or report and stop.",
].join("\n");

describe("parseWake", () => {
  it("reads the task, phase and wake budget out of the header", () => {
    const wake = parseWake(envelope);

    expect(wake).toMatchObject({
      task: "PR for bug 2129276 empty-state fix",
      phase: "Open PR (1/1)",
      wakes: "2/12",
    });
  });

  it("keeps each step's verdict but drops the output under it", () => {
    const wake = parseWake(envelope);

    expect(wake?.settled).toEqual([
      { title: "Open PR for the empty-state illustration fix", state: "succeeded" },
    ]);
    expect(wake?.running).toEqual(["Re-measure the icon"]);
  });

  it("does not claim an ordinary prompt, however it opens", () => {
    expect(parseWake("fix the retry helper")).toBeUndefined();
    expect(parseWake('<fleet-task name="x">do it</fleet-task>')).toBeUndefined();
    // The instructions talk about `<fleet-wake>` blocks; discussing one is not
    // being woken by one, and would otherwise fold a real prompt away.
    expect(parseWake("what does a <fleet-wake> turn look like?")).toBeUndefined();
  });

  it("still summarises a phaseless run rather than giving up on the header", () => {
    const wake = parseWake(
      ['<fleet-wake task="ship it" wakes=1/12>', "</fleet-wake>"].join("\n"),
    );

    expect(wake).toMatchObject({ task: "ship it", phase: "", wakes: "1/12" });
  });
});

describe("wakeTitle", () => {
  it("counts what came back and says when some of it did not go well", () => {
    const wake = parseWake(envelope);
    expect(wake && wakeTitle(wake)).toBe("1 worker finished");

    const failed = parseWake(
      [
        '<fleet-wake task="t" wakes=1/12>',
        "Just finished:",
        "- One (implement): succeeded",
        "- Two (implement): failed",
        "</fleet-wake>",
      ].join("\n"),
    );
    expect(failed && wakeTitle(failed)).toBe("2 workers finished, 1 not clean");
  });

  it("still names the turn when nothing settled since the last wake", () => {
    const wake = parseWake('<fleet-wake task="t" wakes=3/12>\n</fleet-wake>');
    expect(wake && wakeTitle(wake)).toBe("Worker result received");
  });
});

describe("wakeDetail", () => {
  it("fits the task, phase, verdicts and counters on one line", () => {
    const wake = parseWake(envelope);

    expect(wake && wakeDetail(wake)).toBe(
      "PR for bug 2129276 empty-state fix · Open PR (1/1) · " +
        "Open PR for the empty-state illustration fix: succeeded · " +
        "1 still running · wake 2/12",
    );
  });
});
