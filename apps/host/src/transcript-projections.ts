import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  TRANSCRIPT_PAGE_LIMIT,
  TRANSCRIPT_PAGE_MAX,
  TranscriptProjector,
  isTranscriptEvent,
  type SessionEvent,
  type TerminalBlock,
  type TranscriptChange,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";
import type { FleetStore } from "./store.js";

type Projection = {
  generation: string;
  revision: number;
  projector: TranscriptProjector;
  /** The store's write count for the session this reflects; see `FleetStore.eventWrites`. */
  writes: number;
  /** The newest sequence folded in order; anything older arrived late. */
  maxSequence: number;
  bytes: number;
  used: number;
};

type Build = { cursor: number; lateFill: boolean; promise: Promise<Projection> };

export type TranscriptProjectionLimits = {
  /** Rows folded between yields to the event loop while building. */
  batchSize: number;
  /** Approximate retained block text across all projections before eviction. */
  maxBytes: number;
};

const DEFAULT_LIMITS: TranscriptProjectionLimits = {
  batchSize: 2_000,
  maxBytes: 128 * 1024 * 1024,
};

const blockBytes = (block: TerminalBlock) =>
  (block.text.length + (block.body?.length ?? 0) + (block.detail?.length ?? 0)) * 2 + 200;

const changeBytes = (change: TranscriptChange) =>
  "append" in change ? change.append.length * 2 : blockBytes(change.block);

/**
 * Each session's transcript folded into blocks, kept warm so a browser can page it.
 *
 * Folding a long conversation means reading every one of its events, which used
 * to happen on every switch, on the Host's only thread, and then again in the
 * browser. A projection is built once — in batches, yielding between them so the
 * Host keeps answering — and then advanced one event at a time as events are
 * stored. Raw events remain the record; a projection can be dropped and rebuilt
 * from them at any moment, and is whenever it cannot be advanced in order.
 */
export class TranscriptProjections {
  private readonly ready = new Map<string, Projection>();
  private readonly builds = new Map<string, Build>();
  private clock = 0;
  private bytes = 0;

  constructor(
    private readonly store: FleetStore,
    /** Tells browsers their copy of a session's projection no longer exists. */
    private readonly onReset: (sessionId: string) => void,
    private readonly limits: TranscriptProjectionLimits = DEFAULT_LIMITS,
  ) {}

  /** Blocks `[start, end)` where `end` is `before` (default: the newest). */
  async page(
    sessionId: string,
    request: { before?: number | undefined; limit?: number | undefined } = {},
  ): Promise<TranscriptPage> {
    const projection = await this.projection(sessionId);
    const { blocks, prompts } = projection.projector;
    const total = blocks.length;
    const newest = request.before === undefined;
    const end = newest ? total : Math.min(Math.max(request.before ?? 0, 0), total);
    const limit = Math.min(
      Math.max(request.limit ?? TRANSCRIPT_PAGE_LIMIT, 1),
      TRANSCRIPT_PAGE_MAX,
    );
    let start = Math.max(0, end - limit);
    // Less than a quarter of a page left above comes with it, rather than as a
    // page of its own: the browser's list shifts by however far a few prepended
    // rows are from its average row height, and does not correct for that when
    // all of them are on screen at once. A larger page reaches past the screen.
    if (start < Math.floor(limit / 4)) start = 0;
    const activity = newest ? this.store.latestActivity(sessionId) : undefined;
    return {
      generation: projection.generation,
      revision: projection.revision,
      total,
      start,
      blocks: blocks.slice(start, end),
      ...(newest ? { prompts: prompts.slice() } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  /**
   * Advances a ready projection by one stored event.
   *
   * Returns the block change to publish, so every reader can apply exactly what
   * the Host applied. An event behind the projection — a late fill from a Node
   * replaying its outbox — cannot be folded in order, so the projection is
   * dropped and rebuilt on its next read.
   */
  apply(event: SessionEvent): TranscriptUpdate | undefined {
    const build = this.builds.get(event.sessionId);
    if (build) {
      if (isTranscriptEvent(event) && event.sequence <= build.cursor) {
        build.lateFill = true;
      }
      return undefined;
    }
    const projection = this.ready.get(event.sessionId);
    if (!projection) return undefined;
    projection.writes += 1;
    if (event.sequence < projection.maxSequence) {
      if (isTranscriptEvent(event)) this.invalidate(event.sessionId);
      return undefined;
    }
    projection.maxSequence = event.sequence;
    const change = projection.projector.apply(event);
    if (!change) return undefined;
    projection.revision += 1;
    const grown = changeBytes(change);
    projection.bytes += grown;
    this.bytes += grown;
    projection.used = ++this.clock;
    this.evict(event.sessionId);
    return { generation: projection.generation, revision: projection.revision, change };
  }

  /** Drops one projection and tells browsers to refetch their copy. */
  invalidate(sessionId: string): void {
    const projection = this.ready.get(sessionId);
    if (!projection) return;
    this.ready.delete(sessionId);
    this.bytes -= projection.bytes;
    this.onReset(sessionId);
  }

  /** Forgets everything, for when the event log itself was replaced. */
  clear(): void {
    for (const sessionId of [...this.ready.keys()]) this.invalidate(sessionId);
    for (const build of this.builds.values()) build.lateFill = true;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  private async projection(sessionId: string): Promise<Projection> {
    const ready = this.ready.get(sessionId);
    if (ready) {
      if (this.store.eventWrites(sessionId) === ready.writes) {
        ready.used = ++this.clock;
        return ready;
      }
      this.invalidate(sessionId);
    }
    const existing = this.builds.get(sessionId);
    if (existing) return existing.promise;
    const build = { cursor: 0, lateFill: false } as Build;
    this.builds.set(sessionId, build);
    build.promise = this.build(sessionId, build);
    return build.promise;
  }

  private async build(sessionId: string, build: Build): Promise<Projection> {
    try {
      for (;;) {
        const projector = new TranscriptProjector();
        build.cursor = 0;
        build.lateFill = false;
        for (;;) {
          const rows = this.store.listTranscriptRows(
            sessionId,
            build.cursor,
            this.limits.batchSize,
          );
          for (const event of rows) projector.apply(event);
          const last = rows[rows.length - 1];
          if (last) build.cursor = last.sequence;
          if (rows.length < this.limits.batchSize) break;
          await yieldToEventLoop();
        }
        // Something was stored behind the cursor while this was yielding.
        if (build.lateFill) continue;
        // Read with the final batch, with no yield between: nothing can be
        // stored in between, so the count describes exactly what was folded.
        const projection: Projection = {
          generation: randomUUID(),
          revision: 0,
          projector,
          writes: this.store.eventWrites(sessionId),
          maxSequence: build.cursor,
          bytes: projector.blocks.reduce((sum, block) => sum + blockBytes(block), 0),
          used: ++this.clock,
        };
        this.builds.delete(sessionId);
        this.ready.set(sessionId, projection);
        this.bytes += projection.bytes;
        this.evict(sessionId);
        return projection;
      }
    } catch (error) {
      this.builds.delete(sessionId);
      throw error;
    }
  }

  private evict(keep: string): void {
    while (this.bytes > this.limits.maxBytes && this.ready.size > 1) {
      let oldest: [string, Projection] | undefined;
      for (const entry of this.ready) {
        if (entry[0] === keep) continue;
        if (!oldest || entry[1].used < oldest[1].used) oldest = entry;
      }
      if (!oldest) return;
      this.invalidate(oldest[0]);
    }
  }
}
