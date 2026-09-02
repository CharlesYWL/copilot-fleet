import { randomUUID } from "node:crypto";
import {
  OutboxFlushIdSchema,
  type OutboxFlushId,
  type SessionEvent,
} from "@fleet/protocol";

/**
 * Roughly a long turn's worth of streamed output, which is what a Host restart
 * during `tsx watch` interrupts. Past this the oldest go, because the newest
 * describe where the agent actually is.
 */
export const DEFAULT_OUTBOX_CAPACITY = 2_000;

export type OutboxFlush = { sent: number; dropped: number };

export type OutboxBatch = {
  flushId: OutboxFlushId;
  events: readonly SessionEvent[];
  dropped: number;
};

export type OutboxAcknowledgement = {
  acknowledged: boolean;
  removed: number;
  dropped: number;
};

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
  private readonly pending: SessionEvent[] = [];
  private pendingDropped = 0;
  private inFlight:
    | {
        flushId: OutboxFlushId;
        events: SessionEvent[];
        dropped: number;
      }
    | undefined;

  constructor(
    private readonly capacity = DEFAULT_OUTBOX_CAPACITY,
    private readonly createFlushId = (): OutboxFlushId =>
      OutboxFlushIdSchema.parse(randomUUID()),
  ) {}

  get size(): number {
    return (this.inFlight?.events.length ?? 0) + this.pending.length;
  }

  /** Events dropped for capacity since the last flush. */
  get droppedCount(): number {
    return (this.inFlight?.dropped ?? 0) + this.pendingDropped;
  }

  get currentBatch(): OutboxBatch | undefined {
    const batch = this.inFlight;
    return batch
      ? {
          flushId: batch.flushId,
          events: batch.events,
          dropped: batch.dropped,
        }
      : undefined;
  }

  add(event: SessionEvent): void {
    this.pending.push(event);
    while (this.pending.length > this.capacity) {
      this.pending.shift();
      this.pendingDropped += 1;
    }
  }

  /**
   * Freezes the current pending prefix for replay.
   *
   * Events raised after this call stay in a separate bounded queue, so an ack
   * can remove exactly the batch it names without touching newer work.
   */
  prepareFlush(includeEmpty = false): OutboxBatch | undefined {
    if (!this.inFlight) {
      if (this.pending.length === 0 && !includeEmpty) return undefined;
      this.inFlight = {
        flushId: this.createFlushId(),
        events: this.pending.splice(0),
        dropped: this.pendingDropped,
      };
      this.pendingDropped = 0;
    }
    return this.currentBatch;
  }

  acknowledge(flushId: OutboxFlushId): OutboxAcknowledgement {
    const batch = this.inFlight;
    if (!batch || batch.flushId !== flushId) {
      return { acknowledged: false, removed: 0, dropped: 0 };
    }
    this.inFlight = undefined;
    return {
      acknowledged: true,
      removed: batch.events.length,
      dropped: batch.dropped,
    };
  }

  /**
   * Legacy destructive flush for Hosts that predate explicit acknowledgment.
   *
   * The retained batch is drained first if one was advertised in hello, then
   * newly queued events follow. A failed send keeps the unsent suffix.
   */
  flush(send: (event: SessionEvent) => boolean): OutboxFlush {
    const dropped = this.droppedCount;
    let sent = 0;

    while (true) {
      const batch = this.prepareFlush();
      if (!batch) break;
      const mutable = this.inFlight!;
      while (mutable.events.length > 0) {
        const next = mutable.events[0]!;
        if (!send(next)) return { sent, dropped };
        mutable.events.shift();
        sent += 1;
      }
      this.inFlight = undefined;
    }

    return { sent, dropped };
  }
}
