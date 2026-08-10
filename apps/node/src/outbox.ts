import type { SessionEvent } from "@fleet/protocol";

/**
 * Roughly a long turn's worth of streamed output, which is what a Host restart
 * during `tsx watch` interrupts. Past this the oldest go, because the newest
 * describe where the agent actually is.
 */
export const DEFAULT_OUTBOX_CAPACITY = 2_000;

export type OutboxFlush = { sent: number; dropped: number };

/**
 * Holds session events raised while the Host is unreachable.
 *
 * Events used to be handed straight to the socket and silently discarded when it
 * was not open, while the sequence number they carried kept advancing. A Host
 * restart mid-turn therefore cost the transcript *and* left the next event
 * numbered past what the Host expected — which the Host refused, along with
 * every event after it, freezing the session for good.
 *
 * Bounded because a Node that cannot reach its Host must not grow until it is
 * killed; dropping the oldest is visible to the Host as a gap it now tolerates.
 */
export class EventOutbox {
  private readonly queue: SessionEvent[] = [];
  private dropped = 0;

  constructor(private readonly capacity = DEFAULT_OUTBOX_CAPACITY) {}

  get size(): number {
    return this.queue.length;
  }

  /** Events dropped for capacity since the last flush. */
  get droppedCount(): number {
    return this.dropped;
  }

  add(event: SessionEvent): void {
    this.queue.push(event);
    while (this.queue.length > this.capacity) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  /**
   * Hands everything held to `send`, oldest first, and keeps whatever it would
   * not take — a socket that closes mid-flush must not cost the remainder.
   */
  flush(send: (event: SessionEvent) => boolean): OutboxFlush {
    const dropped = this.dropped;
    let sent = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (!send(next)) break;
      this.queue.shift();
      sent += 1;
    }
    if (this.queue.length === 0) this.dropped = 0;
    return { sent, dropped };
  }
}
