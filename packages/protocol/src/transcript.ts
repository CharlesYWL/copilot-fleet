import { parseFleetControl } from "./fleet-wake.js";
import {
  eventPayload,
  type PromptMark,
  type SessionEvent,
  type TerminalBlock,
  type TranscriptChange,
} from "./index.js";

const USER_PREFIX = "User: ";

/** States already shown by the session header; repeating them adds only noise. */
const noisyStates = new Set(["queued", "starting", "running", "idle", "cancelling"]);

/** Long enough to recognise a prompt, short enough not to become a paragraph. */
const PROMPT_LABEL_MAX_LENGTH = 60;

export function promptLabel(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return "Prompt";
  return flattened.length > PROMPT_LABEL_MAX_LENGTH
    ? `${flattened.slice(0, PROMPT_LABEL_MAX_LENGTH)}…`
    : flattened;
}

/**
 * Collapses the raw ACP event stream into transcript lines, one event at a time.
 *
 * Streamed text chunks become one flowing block, consecutive output shares one
 * block, and repeated tool updates collapse onto the line that started them —
 * which may be anywhere in the history, not only the last block.
 *
 * Every event changes at most one block, and a changed block is replaced, never
 * edited: a renderer holding the previous object (a memoised row, an earlier
 * page) must not see it change underneath it. Events must arrive in sequence
 * order; a caller that receives one late has to rebuild.
 */
export class TranscriptProjector {
  readonly blocks: TerminalBlock[] = [];
  /** The operator's own prompts, with their block positions. */
  readonly prompts: PromptMark[] = [];
  private readonly tools = new Map<string, number>();

  apply(event: SessionEvent): TranscriptChange | undefined {
    if (event.type === "agent_text" || event.type === "agent_thought") {
      const text = eventPayload(event, event.type)?.text ?? "";
      return text
        ? this.merge(event.type === "agent_text" ? "agent" : "thought", event, text)
        : undefined;
    }

    if (event.type === "tool") {
      const payload = eventPayload(event, "tool");
      const toolCallId = payload?.toolCallId ?? "";
      const status = payload?.status ?? "";
      const title = payload?.title ?? "";
      const toolKind = payload?.kind ?? "";
      const detail = payload?.detail ?? "";
      const response = payload?.response ?? "";
      const error = payload?.error ?? "";
      const existing = toolCallId ? this.tools.get(toolCallId) : undefined;
      const previous = existing === undefined ? undefined : this.blocks[existing];
      if (existing !== undefined && previous) {
        // Only what an update actually restates is taken from it: a completion
        // frame carries a status and nothing else, and must not blank the line
        // the reader has been looking at since the call started.
        if (!title && !status && !toolKind && !detail && !response && !error) {
          return undefined;
        }
        const next: TerminalBlock = { ...previous };
        if (title) next.text = title;
        if (status) next.status = status;
        if (toolKind) next.toolKind = toolKind;
        if (detail) next.detail = detail;
        if (response) next.body = response;
        if (error) next.body = error;
        this.blocks[existing] = next;
        return { index: existing, block: next };
      }
      const change = this.push({
        key: event.eventId,
        kind: "tool",
        text: title || "Tool call",
        createdAt: event.createdAt,
        ...(status ? { status } : {}),
        ...(toolKind ? { toolKind } : {}),
        ...(detail ? { detail } : {}),
        ...(response ? { body: response } : {}),
        ...(error ? { body: error } : {}),
      });
      if (toolCallId) this.tools.set(toolCallId, change.index);
      return change;
    }

    if (event.type === "state") {
      const payload = eventPayload(event, "state");
      const state = payload?.state ?? "";
      if (!state || noisyStates.has(state)) return undefined;
      return this.push({
        key: event.eventId,
        kind: "state",
        text: payload?.activity || state,
        createdAt: event.createdAt,
        status: state,
      });
    }

    if (event.type === "system") {
      const payload = eventPayload(event, "system");
      const text = payload?.text ?? "";
      if (!text) return undefined;
      if (!text.startsWith(USER_PREFIX)) return this.merge("system", event, text);
      const prompt = text.slice(USER_PREFIX.length);

      /*
       * Fleet control envelopes use the prompt channel to reach the agent,
       * but are not chat prompts. Reuse the wake's folded step instead of the
       * operator's column (and its prompt-rail marks).
       */
      const control = parseFleetControl(prompt);
      if (control) {
        return this.push({
          key: event.eventId,
          kind: "wake",
          text: control.title,
          detail: control.detail,
          body: prompt,
          createdAt: event.createdAt,
        });
      }

      return this.push({
        key: event.eventId,
        kind: "user",
        text: prompt,
        createdAt: event.createdAt,
        // The bytes are never stored, so this list is the only trace a prompt
        // carried files at all. Without it a transcript reads as though the
        // agent answered a question about a screenshot nobody sent.
        ...(payload?.attachments?.length ? { attachments: payload.attachments } : {}),
      });
    }

    if (event.type === "permission") {
      return this.push({
        key: event.eventId,
        kind: "permission",
        text: eventPayload(event, "permission")?.title || "Tool permission requested",
        createdAt: event.createdAt,
      });
    }

    if (event.type === "permission_result") {
      return this.push({
        key: event.eventId,
        kind: "permission_result",
        text: `Permission ${eventPayload(event, "permission_result")?.outcome || "resolved"}`,
        createdAt: event.createdAt,
      });
    }

    if (event.type === "turn_complete") {
      return this.push({
        key: event.eventId,
        kind: "turn",
        text: eventPayload(event, "turn_complete")?.stopReason || "end_turn",
        createdAt: event.createdAt,
      });
    }

    if (event.type === "error") {
      return this.push({
        key: event.eventId,
        kind: "error",
        text: eventPayload(event, "error")?.message || "Unknown error",
        createdAt: event.createdAt,
      });
    }

    // Resume bookkeeping, pickers and usage carry nothing worth showing.
    return undefined;
  }

  private merge(
    kind: "agent" | "thought" | "system",
    event: SessionEvent,
    text: string,
  ): TranscriptChange {
    const index = this.blocks.length - 1;
    const last = this.blocks[index];
    if (last?.kind === kind) {
      const append = (kind === "system" ? "\n" : "") + text;
      this.blocks[index] = { ...last, text: last.text + append };
      return { index, append };
    }
    return this.push({ key: event.eventId, kind, text, createdAt: event.createdAt });
  }

  private push(block: TerminalBlock): { index: number; block: TerminalBlock } {
    const index = this.blocks.length;
    this.blocks.push(block);
    if (block.kind === "user") {
      this.prompts.push({
        key: block.key,
        index,
        label: promptLabel(block.text),
        createdAt: block.createdAt,
      });
    }
    return { index, block };
  }
}

/** The whole transcript at once; the reference every incremental path must match. */
export function toTerminalBlocks(events: readonly SessionEvent[]): TerminalBlock[] {
  const projector = new TranscriptProjector();
  for (const event of events) projector.apply(event);
  return projector.blocks;
}

/** A change applied to someone else's copy of a block, without editing it. */
export function changedBlock(
  previous: TerminalBlock | undefined,
  change: TranscriptChange,
): TerminalBlock | undefined {
  if ("block" in change) return change.block;
  return previous ? { ...previous, text: previous.text + change.append } : undefined;
}
