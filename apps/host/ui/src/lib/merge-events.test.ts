import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@fleet/protocol";
import { mergeEvents } from "./merge-events";

function event(sequence: number, text: string): SessionEvent {
  return {
    eventId: `e${sequence}`,
    sessionId: "s1",
    sequence,
    type: "agent_text",
    payload: { text },
    createdAt: new Date(sequence * 1000).toISOString(),
  };
}

describe("mergeEvents", () => {
  it("appends an ordered live event without sorting or mutating history", () => {
    const known = [event(1, "one"), event(2, "two")];
    const next = event(3, "three");
    const sort = vi.spyOn(Array.prototype, "sort");
    const merged = mergeEvents([next], known);
    const sorts = sort.mock.calls.length;
    sort.mockRestore();
    expect(sorts).toBe(0);
    expect(merged).toEqual([...known, next]);
    expect(known).toHaveLength(2);
    expect(merged[0]).toBe(known[0]);
  });

  it("still replaces an existing event id even if its incoming sequence is newer", () => {
    const known = [event(1, "one")];
    const fetched = { ...event(2, "corrected"), eventId: "e1" };
    expect(mergeEvents([fetched], known)).toEqual([fetched]);
  });

  it("keeps events the socket delivered while the fetch was in flight", () => {
    const fetched = [event(1, "one"), event(2, "two")];
    const known = [event(1, "one"), event(2, "two"), event(3, "three")];

    expect(mergeEvents(fetched, known).map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it("orders by sequence when the socket ran ahead of the response", () => {
    const fetched = [event(1, "one"), event(3, "three")];
    const known = [event(2, "two"), event(4, "four")];

    expect(mergeEvents(fetched, known).map((item) => item.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("lists an event once when both sources carry it", () => {
    const fetched = [event(1, "one"), event(2, "two")];

    expect(mergeEvents(fetched, fetched)).toHaveLength(2);
  });

  it("prefers the fetched copy, which is the Host's own record", () => {
    const stale = { ...event(1, "partial"), payload: { text: "partial" } };
    const fetched = [{ ...event(1, "settled"), payload: { text: "settled" } }];

    expect(mergeEvents(fetched, [stale])[0]?.payload).toEqual({ text: "settled" });
  });

  it("returns the fetched transcript when nothing is on screen yet", () => {
    const fetched = [event(1, "one"), event(2, "two")];

    expect(mergeEvents(fetched, [])).toEqual(fetched);
  });

  it("keeps what is on screen when the fetch comes back empty", () => {
    const known = [event(1, "one")];

    expect(mergeEvents([], known)).toEqual(known);
  });
});
