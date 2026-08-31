import type * as acp from "@agentclientprotocol/sdk";

export type DiscoveredCopilotSession = {
  id: string;
  cwd: string;
  additionalDirectories: string[];
  loadSupported: boolean;
  title?: string;
  updatedAt?: string;
};

export type SessionPreview = {
  items: Array<{ role: "user" | "assistant"; text: string }>;
  truncated: boolean;
};

/**
 * Adapts current and older ACP metadata without fabricating fields absent from
 * the source session.
 */
export function discoveredSession(
  info: acp.SessionInfo,
  loadSupported: boolean,
): DiscoveredCopilotSession {
  return {
    id: info.sessionId,
    cwd: info.cwd,
    additionalDirectories: [...(info.additionalDirectories ?? [])],
    loadSupported,
    ...(typeof info.title === "string" && info.title !== "" ? { title: info.title } : {}),
    ...(typeof info.updatedAt === "string" && info.updatedAt !== ""
      ? { updatedAt: info.updatedAt }
      : {}),
  };
}

/** Keeps only the newest bounded text while preserving conversational order. */
export function boundedSessionPreview(
  source: readonly { role: "user" | "assistant"; text: string }[],
  maxCharacters: number,
  maxItems: number,
  previouslyTruncated: boolean,
): SessionPreview {
  if (maxItems === 0) {
    return { items: [], truncated: previouslyTruncated || source.length > 0 };
  }
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  let remaining = maxCharacters;
  let truncated = previouslyTruncated || source.length > maxItems;
  for (const item of source.slice(-maxItems).reverse()) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text =
      item.text.length <= remaining
        ? item.text
        : item.text.slice(item.text.length - remaining);
    if (text.length !== item.text.length) truncated = true;
    items.unshift({ role: item.role, text });
    remaining -= text.length;
  }
  return { items, truncated };
}
