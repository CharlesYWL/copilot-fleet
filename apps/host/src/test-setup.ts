import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, vi } from "vitest";
import type * as claimAnnouncement from "./claim-announcement.js";

// Vitest moves from one test to the next through microtasks alone, so a file of
// synchronous tests (execFileSync, DatabaseSync) never lets the worker's event
// loop turn. Its progress reports to the main process are RPCs with a 60s
// wall-clock deadline, and the replies sit unread until the loop turns: once
// such a chain outlasts a minute, the run ends in "Timeout calling
// onTaskUpdate" though every test passed. One macrotask per test lets the
// replies in. The promise form is Node's own timer, which fake timers leave
// alone.
afterEach(() => yieldToEventLoop());

// Ordinary server fixtures must never overwrite the developer's OS clipboard.
// Clipboard-specific tests opt out and mock the child-process boundary instead.
vi.mock("./claim-announcement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof claimAnnouncement>();
  return {
    ...actual,
    announceClaimCode: (
      code: string,
      options: Parameters<typeof actual.announceClaimCode>[1],
    ) =>
      actual.announceClaimCode(code, {
        ...options,
        copy: options.copy ?? (async () => false),
      }),
  };
});
