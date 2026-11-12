import type { ClipboardEvent } from "react";

/**
 * The plain text of a rich-text paste, with its hyperlinks kept as markdown.
 *
 * Teams, Outlook and web pages put a link's URL only in the clipboard's HTML;
 * the plain text a text box receives carries just the link's words, so the URL
 * is silently lost. Converting the whole HTML to markdown would bring it back,
 * but would also re-flow and escape everything else, and code copied from an
 * editor arrives as HTML too. So the plain text is kept exactly, and each link's
 * words are found in it, in document order, and wrapped as `[words](url)`.
 *
 * Undefined when there is no link to restore, so the browser's paste stands.
 */
export function linkedPlainText(plain: string, html: string): string | undefined {
  if (!plain || !html) return undefined;
  const { body } = new DOMParser().parseFromString(html, "text/html");
  const walker = body.ownerDocument.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      // A link is matched whole, so nothing inside it is visited on its own.
      acceptNode: (node) =>
        node.parentNode instanceof HTMLAnchorElement
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  let text = plain;
  // Text already passed, so a link's words are not matched where they appear
  // earlier unlinked.
  let from = 0;
  let linked = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const link = node instanceof HTMLAnchorElement ? node : undefined;
    if (!link && !(node instanceof Text)) continue;
    const match = find(text, node.textContent ?? "", from);
    if (!match) continue;
    const words = match[0];
    const url = webUrl(link?.getAttribute("href"));
    // A link whose words are a URL already has it in the plain text.
    const replacement = url && !webUrl(words) ? `[${words}](${url})` : words;
    text =
      text.slice(0, match.index) + replacement + text.slice(match.index + words.length);
    from = match.index + replacement.length;
    linked ||= replacement !== words;
  }
  return linked ? text : undefined;
}

/**
 * Pastes into a text box with {@link linkedPlainText}'s links, or leaves the
 * paste to the browser when there are none.
 */
export function pasteWithLinks(event: ClipboardEvent<HTMLTextAreaElement>): void {
  const text = linkedPlainText(
    event.clipboardData.getData("text/plain"),
    event.clipboardData.getData("text/html"),
  );
  if (text === undefined) return;
  event.preventDefault();
  // The browser's own insert keeps the paste one undo step and reaches React as
  // an ordinary input event.
  if (document.execCommand("insertText", false, text)) return;
  const field = event.currentTarget;
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Where `words` next occurs in `text` from `from`, allowing any run of
 * whitespace for another: HTML wraps lines and uses non-breaking spaces where
 * the plain text has a single space.
 */
function find(text: string, words: string, from: number): RegExpExecArray | undefined {
  const parts = words.trim().split(/\s+/);
  if (!parts[0]) return undefined;
  const pattern = new RegExp(parts.map(escapeRegExp).join("\\s+"), "g");
  pattern.lastIndex = from;
  return pattern.exec(text) ?? undefined;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function webUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
