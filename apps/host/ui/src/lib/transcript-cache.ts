import {
  TRANSCRIPT_PAGE_LIMIT,
  changedBlock,
  promptLabel,
  type PromptMark,
  type TerminalBlock,
  type TranscriptPage,
  type TranscriptUpdate,
} from "@fleet/protocol";

/** A contiguous run of a session's blocks, from `start` through the newest. */
export type TranscriptView = {
  generation: string;
  revision: number;
  /** Increments with each newest page, so a list can start over at the end. */
  epoch: number;
  /** Absolute position of `blocks[0]`; older blocks are fetched on demand. */
  start: number;
  total: number;
  blocks: readonly TerminalBlock[];
  /** Every operator prompt, loaded or not, so the rail can reach any of them. */
  prompts: readonly PromptMark[];
};

export type TranscriptApplyResult = "applied" | "ignored" | "resync";

type Entry = {
  view?: TranscriptView;
  /** The revision each loaded block already reflects, so no change lands twice. */
  stamps: number[];
  /** The newest page is in flight; changes wait for it. */
  loading: boolean;
  buffered: TranscriptUpdate[];
  used: number;
};

export type TranscriptCacheLimits = { maxViews: number; keepBlocks: number };

/**
 * The browser's copies of Host transcript projections.
 *
 * A copy starts as the newest page and then follows the Host change by change,
 * in revision order, so a streamed chunk costs one block replacement rather than
 * a refold of the whole history. Anything that breaks that order — a missed
 * revision, a different generation, a change to a block this copy cannot see —
 * asks for a resync instead of guessing.
 */
export class TranscriptCache {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;

  constructor(
    private readonly limits: TranscriptCacheLimits = {
      maxViews: 6,
      keepBlocks: TRANSCRIPT_PAGE_LIMIT,
    },
  ) {}

  view(sessionId: string): TranscriptView | undefined {
    return this.entries.get(sessionId)?.view;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  views(): Record<string, TranscriptView> {
    const views: Record<string, TranscriptView> = {};
    for (const [sessionId, entry] of this.entries) {
      if (entry.view) views[sessionId] = entry.view;
    }
    return views;
  }

  /** The newest page was requested: hold changes until it arrives. */
  begin(sessionId: string): void {
    const entry = this.entry(sessionId);
    entry.loading = true;
    entry.buffered = [];
  }

  /** The request was abandoned; a copy that never arrived is forgotten. */
  cancel(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.loading = false;
    entry.buffered = [];
    if (!entry.view) this.entries.delete(sessionId);
  }

  /** Replaces the copy with the newest page; false when it must be fetched again. */
  receive(sessionId: string, page: TranscriptPage): boolean {
    const entry = this.entry(sessionId);
    const buffered = entry.buffered;
    entry.loading = false;
    entry.buffered = [];
    entry.view = {
      generation: page.generation,
      revision: page.revision,
      epoch: (entry.view?.epoch ?? 0) + 1,
      start: page.start,
      total: page.total,
      blocks: page.blocks,
      prompts: page.prompts ?? [],
    };
    entry.stamps = page.blocks.map(() => page.revision);
    for (const update of buffered) {
      if (this.applyTo(entry, update) === "resync") return false;
    }
    return true;
  }

  /** Prepends older blocks; false when the Host's projection changed meanwhile. */
  receiveOlder(sessionId: string, page: TranscriptPage): boolean {
    const entry = this.entries.get(sessionId);
    const view = entry?.view;
    if (!entry || !view) return true;
    if (page.generation !== view.generation) return false;
    if (page.start >= view.start) return true;
    const end = page.start + page.blocks.length;
    if (end < view.start) return false;
    const older = page.blocks.slice(0, view.start - page.start);
    entry.view = { ...view, start: page.start, blocks: [...older, ...view.blocks] };
    // Blocks fetched at a later revision already include changes still on their
    // way here; the stamp is what stops those from being applied a second time.
    entry.stamps = [...older.map(() => page.revision), ...entry.stamps];
    return true;
  }

  apply(sessionId: string, update: TranscriptUpdate): TranscriptApplyResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "ignored";
    if (entry.loading) {
      entry.buffered.push(update);
      return "ignored";
    }
    return entry.view ? this.applyTo(entry, update) : "ignored";
  }

  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Keeps only `sessionId`'s copy, for after a reconnect may have missed changes. */
  retain(sessionId: string | undefined): void {
    for (const id of [...this.entries.keys()]) {
      if (id !== sessionId) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Keeps memory bounded while `active` is on screen.
   *
   * Other copies keep following the Host, but only their newest page, and only
   * the most recently used few are kept at all; a trimmed copy refetches older
   * pages on demand like any other.
   */
  trim(active: string): void {
    const entry = this.entries.get(active);
    if (entry) entry.used = ++this.clock;
    for (const [sessionId, other] of this.entries) {
      const view = other.view;
      if (sessionId === active || !view) continue;
      const extra = view.blocks.length - this.limits.keepBlocks;
      if (extra <= 0) continue;
      other.view = {
        ...view,
        start: view.start + extra,
        blocks: view.blocks.slice(extra),
      };
      other.stamps = other.stamps.slice(extra);
    }
    while (this.entries.size > this.limits.maxViews) {
      let oldest: string | undefined;
      let oldestUsed = Infinity;
      for (const [sessionId, other] of this.entries) {
        if (sessionId === active || other.loading) continue;
        if (other.used < oldestUsed) {
          oldest = sessionId;
          oldestUsed = other.used;
        }
      }
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { stamps: [], loading: false, buffered: [], used: ++this.clock };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private applyTo(entry: Entry, update: TranscriptUpdate): TranscriptApplyResult {
    const view = entry.view!;
    if (update.generation !== view.generation) return "resync";
    if (update.revision <= view.revision) return "ignored";
    if (update.revision !== view.revision + 1) return "resync";
    const { change } = update;
    const offset = change.index - view.start;
    let { blocks, total, prompts } = view;
    if (offset >= 0 && offset < blocks.length) {
      if (entry.stamps[offset]! < update.revision) {
        const next = changedBlock(blocks[offset], change);
        if (!next) return "resync";
        blocks = blocks.slice();
        (blocks as TerminalBlock[])[offset] = next;
        entry.stamps[offset] = update.revision;
      }
    } else if (offset === blocks.length && "block" in change) {
      blocks = [...blocks, change.block];
      entry.stamps.push(update.revision);
      total = Math.max(total, change.index + 1);
      if (change.block.kind === "user") {
        prompts = [
          ...prompts,
          {
            key: change.block.key,
            index: change.index,
            label: promptLabel(change.block.text),
            createdAt: change.block.createdAt,
          },
        ];
      }
    } else if (offset >= 0) {
      return "resync";
    }
    // A change to a block older than this copy needs nothing: fetching that
    // block later returns the Host's current version of it.
    entry.view = { ...view, revision: update.revision, blocks, total, prompts };
    return "applied";
  }
}
