import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import { UsageJournal } from "./usage-journal.js";
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const event = (aiCredits = 1): SessionEvent => ({
  eventId: "event",
  sessionId: "s",
  sequence: 1,
  type: "usage",
  createdAt: new Date().toISOString(),
  payload: {
    accounting: {
      nativeSessionId: "n",
      counterId: "n",
      source: "test",
      observedAt: new Date().toISOString(),
      aiCredits,
    },
  },
});
describe("durable UsageJournal", () => {
  it("persists changed snapshots across restart and isolates Host identities", () => {
    const path = mkdtempSync(join(tmpdir(), "fleet-usage-"));
    paths.push(path);
    let journal = new UsageJournal(path, false);
    journal.observe("h1", event());
    journal.observe("h1", event());
    const pending = journal.pending("h1");
    expect(pending).toHaveLength(1);
    expect(journal.pending("h2")).toHaveLength(0);
    journal.close();
    journal = new UsageJournal(path, false);
    expect(journal.pending("h1")).toEqual(pending);
    expect(() => journal.acknowledge("h1", 999)).toThrow();
    journal.sent("h1", pending[0]!.sequence);
    journal.acknowledge("h1", pending[0]!.sequence);
    expect(journal.pending("h1")).toHaveLength(0);
    journal.observe("h1", event(2));
    expect(journal.pending("h1")[0]!.sequence).toBe(2);
    journal.close();
  });
});
