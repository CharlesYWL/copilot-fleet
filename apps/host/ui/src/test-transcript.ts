import { TranscriptProjector, type SessionEvent } from "@fleet/protocol";
import type { TranscriptView } from "./lib/transcript-cache";

/** A whole transcript held the way the browser holds one after loading every page. */
export function transcriptOf(events: readonly SessionEvent[], epoch = 1): TranscriptView {
  const projector = new TranscriptProjector();
  for (const event of events) projector.apply(event);
  return {
    generation: "test",
    revision: 0,
    epoch,
    start: 0,
    total: projector.blocks.length,
    blocks: projector.blocks.slice(),
    prompts: projector.prompts.slice(),
  };
}
