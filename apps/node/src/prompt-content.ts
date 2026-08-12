import type * as acp from "@agentclientprotocol/sdk";
import type { PromptAttachment } from "@fleet/protocol";

/**
 * A prompt and its files, as the blocks ACP wants.
 *
 * Copilot advertises `image` and `embeddedContext`, and both are used here:
 * an image goes over as an image block, and anything else is embedded as text
 * so the agent can read it without a filesystem it may not share with whoever
 * attached the file.
 */

/** Text that survives being decoded, or nothing. */
function decodeText(data: string): string | undefined {
  const text = Buffer.from(data, "base64").toString("utf8");
  // A binary file decodes to replacement characters, which is worse than
  // useless in a prompt: it spends the context window on noise and can read as
  // instructions. The caller reports the file instead of embedding it.
  return text.includes("\uFFFD") ? undefined : text;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * `file://` for a name, so the agent can refer to the attachment by path.
 *
 * The file does not exist on the agent's machine — the bytes are embedded right
 * beside this — but ACP requires a URI, and a name-shaped one is what makes the
 * agent's reply say "config.json" rather than "the attached resource".
 */
function attachmentUri(name: string): string {
  return `attachment:///${encodeURIComponent(name)}`;
}

export function toPromptBlocks(
  text: string,
  attachments: readonly PromptAttachment[] = [],
): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [{ type: "text", text }];
  for (const attachment of attachments) {
    if (isImage(attachment.mimeType)) {
      blocks.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
      });
      continue;
    }
    const decoded = decodeText(attachment.data);
    if (decoded === undefined) {
      // Named rather than dropped: an operator who attached something the agent
      // cannot read deserves to learn that from the transcript, not from a
      // reply that never mentions their file.
      blocks.push({
        type: "text",
        text: `[attachment "${attachment.name}" (${attachment.mimeType}) was left out: it is not text and not an image]`,
      });
      continue;
    }
    blocks.push({
      type: "resource",
      resource: {
        uri: attachmentUri(attachment.name),
        mimeType: attachment.mimeType,
        text: decoded,
      },
    });
  }
  return blocks;
}
