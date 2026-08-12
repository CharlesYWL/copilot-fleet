import type { PromptAttachment } from "@fleet/protocol";
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ATTACHMENT_BYTES,
  base64Bytes,
} from "@fleet/protocol";

/** An attachment plus the handle the composer needs to list and remove it. */
export type DraftAttachment = PromptAttachment & { id: string };

export type AttachResult =
  { ok: true; attachment: DraftAttachment } | { ok: false; error: string };

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Base64 without a data-URI prefix.
 *
 * `FileReader.readAsDataURL` is the only way to get base64 out of a File in a
 * browser without hand-rolling a chunked encoder over an ArrayBuffer, and it
 * answers with `data:image/png;base64,AAAA` — the prefix has to come off before
 * the bytes mean anything to the agent.
 */
export function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

/**
 * A browser file turned into something sendable, or the reason it was not.
 *
 * Rejections are values rather than thrown errors because every one of them is
 * a sentence for the operator: a file that vanishes with no explanation is the
 * worst outcome for a control whose whole job is "this went with my message".
 */
export function acceptAttachment(
  file: { name: string; type: string; size: number },
  data: string,
  existing: readonly DraftAttachment[],
): AttachResult {
  if (existing.length >= MAX_ATTACHMENTS_PER_PROMPT) {
    return {
      ok: false,
      error: `A prompt can carry ${MAX_ATTACHMENTS_PER_PROMPT} attachments at once`,
    };
  }
  if (data === "") return { ok: false, error: `Could not read "${file.name}"` };
  if (base64Bytes(data) > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" is larger than the ${megabytes(MAX_ATTACHMENT_BYTES)} limit`,
    };
  }
  return {
    ok: true,
    attachment: {
      // Pasted images arrive as "image.png" every time, so the name cannot be
      // the identity: two screenshots would collide and removing one would take
      // both.
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || "pasted-image.png",
      mimeType: file.type || "application/octet-stream",
      data,
    },
  };
}

/** What the chip shows next to the name. */
export function attachmentSizeLabel(attachment: PromptAttachment): string {
  const bytes = base64Bytes(attachment.data);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageAttachment(attachment: PromptAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

/** Strips the composer's handle back off, leaving what the wire expects. */
export function toWireAttachments(
  drafts: readonly DraftAttachment[],
): PromptAttachment[] {
  return drafts.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
}
