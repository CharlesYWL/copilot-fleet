import { describe, expect, it } from "vitest";
import { OutboxFlushIdSchema, type SessionEvent } from "@fleet/protocol";
import { EventOutbox } from "./outbox.js";

const event = (sequence: number): SessionEvent => ({
  eventId: `e${sequence}`,
  sessionId: "s1",
  sequence,
  type: "agent_text",
  payload: { text: `chunk ${sequence}` },
  createdAt: "2026-08-10T22:00:00.000Z",
});

describe("EventOutbox", () => {
  const flushId = (digit: string) =>
    OutboxFlushIdSchema.parse(
      `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(
        3,
      )}-${digit.repeat(12)}`,
    );

  it("hands back what it held, oldest first", () => {
    // The agent keeps streaming through a Host restart; these are the only
    // record of that work, and they have to replay in the order they happened.
    const outbox = new EventOutbox();
    outbox.add(event(1));
    outbox.add(event(2));

    const delivered: number[] = [];
    const result = outbox.flush((item) => {
      delivered.push(item.sequence);
      return true;
    });

    expect(delivered).toEqual([1, 2]);
    expect(result).toEqual({ sent: 2, dropped: 0 });
    expect(outbox.size).toBe(0);
  });

  it("keeps the remainder when the socket closes mid-flush", () => {
    // Otherwise a reconnect that fails halfway loses everything it had not yet
    // managed to send, which is the failure this class exists to prevent.
    const outbox = new EventOutbox();
    for (const sequence of [1, 2, 3]) outbox.add(event(sequence));

    let accepted = 0;
    const result = outbox.flush(() => {
      accepted += 1;
      return accepted <= 1;
    });

    expect(result.sent).toBe(1);
    expect(outbox.size).toBe(2);

    const rest: number[] = [];
    outbox.flush((item) => {
      rest.push(item.sequence);
      return true;
    });
    expect(rest).toEqual([2, 3]);
  });

  it("drops the oldest rather than growing without bound", () => {
    // A node that cannot reach its Host for a long time must not be killed by
    // its own buffer; the newest events describe where the agent actually is.
    const outbox = new EventOutbox(3);
    for (const sequence of [1, 2, 3, 4, 5]) outbox.add(event(sequence));

    expect(outbox.size).toBe(3);
    expect(outbox.droppedCount).toBe(2);

    const delivered: number[] = [];
    const result = outbox.flush((item) => {
      delivered.push(item.sequence);
      return true;
    });
    expect(delivered).toEqual([3, 4, 5]);
    expect(result.dropped).toBe(2);
  });

  it("forgets earlier drops once it has emptied", () => {
    const outbox = new EventOutbox(1);
    outbox.add(event(1));
    outbox.add(event(2));
    outbox.flush(() => true);

    outbox.add(event(3));
    expect(outbox.flush(() => true)).toEqual({ sent: 1, dropped: 0 });
  });

  it("does nothing when it is holding nothing", () => {
    expect(new EventOutbox().flush(() => true)).toEqual({ sent: 0, dropped: 0 });
  });

  it("retains a sent batch until the matching Host acknowledgment", () => {
    const id = flushId("1");
    const outbox = new EventOutbox(10, () => id);
    outbox.add(event(1));
    outbox.add(event(2));

    const batch = outbox.prepareFlush();

    expect(batch).toMatchObject({
      flushId: id,
      events: [{ sequence: 1 }, { sequence: 2 }],
    });
    expect(outbox.size).toBe(2);
    expect(outbox.acknowledge(flushId("2"))).toEqual({
      acknowledged: false,
      removed: 0,
      dropped: 0,
    });
    expect(outbox.size).toBe(2);
    expect(outbox.currentBatch?.flushId).toBe(id);

    expect(outbox.acknowledge(id)).toEqual({
      acknowledged: true,
      removed: 2,
      dropped: 0,
    });
    expect(outbox.size).toBe(0);
  });

  it("removes exactly the acknowledged batch and preserves newer events", () => {
    const ids = [flushId("3"), flushId("4")];
    const outbox = new EventOutbox(10, () => ids.shift()!);
    outbox.add(event(1));
    outbox.add(event(2));
    const first = outbox.prepareFlush()!;

    outbox.add(event(3));
    expect(outbox.size).toBe(3);
    expect(outbox.acknowledge(first.flushId).removed).toBe(2);
    expect(outbox.size).toBe(1);

    const second = outbox.prepareFlush()!;
    expect(second.flushId).not.toBe(first.flushId);
    expect(second.events.map((item) => item.sequence)).toEqual([3]);
  });

  it("never capacity-evicts an in-flight batch", () => {
    const ids = [flushId("5"), flushId("6")];
    const outbox = new EventOutbox(2, () => ids.shift()!);
    outbox.add(event(1));
    outbox.add(event(2));
    const first = outbox.prepareFlush()!;

    outbox.add(event(3));
    outbox.add(event(4));
    outbox.add(event(5));

    expect(first.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(outbox.size).toBe(4);
    expect(outbox.droppedCount).toBe(1);
    outbox.acknowledge(first.flushId);
    expect(outbox.prepareFlush()!.events.map((item) => item.sequence)).toEqual([4, 5]);
  });
});
