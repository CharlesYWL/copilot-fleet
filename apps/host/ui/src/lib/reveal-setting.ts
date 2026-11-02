import { settingAnchorSelector } from "./settings-search";

/**
 * Bringing a Settings search result into view.
 *
 * A result names its element by `data-setting-id`, but that element may not
 * exist yet when the result is chosen: a Settings page is built the first time
 * it is opened, and most cards appear only once the page has read what it
 * shows from the Host. So this waits for the element, then scrolls it to the
 * top of its page, opens anything folded around it, focuses it so keyboard
 * and screen-reader users land on it, and marks it briefly so the eye does.
 */

/** Marks the setting just revealed; styled by the Settings page. */
export const SETTING_HIGHLIGHT_ATTRIBUTE = "data-setting-highlighted";

export type RevealOptions = {
  /** How long to wait for the setting to appear before giving up. */
  timeoutMs?: number;
  /** How long the mark stays on the revealed setting. */
  highlightMs?: number;
  /**
   * How long to keep the setting in place while the page around it loads.
   * Cards above it fill in from the Host after it appears, each pushing it
   * further down; it is brought back each time, until the operator scrolls or
   * clicks, or this runs out.
   */
  settleMs?: number;
  signal?: AbortSignal;
};

/** Long enough for a page's first read from the Host, short enough to report. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Matches the length of the highlight's fade in the Settings styles. */
const DEFAULT_HIGHLIGHT_MS = 2_000;
/** Covers the first answers from the Host on a page opened for the first time. */
const DEFAULT_SETTLE_MS = 1_500;

/** What an operator does to take the scroll back. */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

let highlighted:
  { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Resolves with the revealed element, or `undefined` when it never appeared in
 * time or the request was abandoned (a newer result, or leaving Settings).
 */
export async function revealSetting(
  root: HTMLElement,
  id: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    highlightMs = DEFAULT_HIGHLIGHT_MS,
    settleMs = DEFAULT_SETTLE_MS,
    signal,
  }: RevealOptions = {},
): Promise<HTMLElement | undefined> {
  const target = await waitForVisibleAnchor(root, id, timeoutMs, signal);
  if (!target || signal?.aborted) return undefined;

  openFoldsAround(target);
  target.scrollIntoView?.({
    block: "start",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  focusWithoutScrolling(target);
  markBriefly(target, highlightMs);
  holdInPlace(target, settleMs, signal);
  return target;
}

/**
 * Keeps a revealed setting where it was put while the page fills in above it.
 *
 * A page opened for the first time draws its cards as their answers arrive,
 * and every one that lands above the setting pushes it down — often out of
 * view before a smooth scroll has even finished. So its position is watched
 * frame by frame, and it is brought back whenever it moves. The operator wins
 * any disagreement: scrolling, clicking or typing ends this at once.
 */
function holdInPlace(target: HTMLElement, durationMs: number, signal?: AbortSignal) {
  if (durationMs <= 0) return;
  let last = target.offsetTop;
  let frame: number | undefined;
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    clearTimeout(timer);
    for (const type of TAKEOVER_EVENTS) window.removeEventListener(type, stop, true);
    signal?.removeEventListener("abort", stop);
  };
  const follow = () => {
    if (!target.isConnected) return stop();
    const top = target.offsetTop;
    if (top !== last) {
      last = top;
      // An instant jump: the setting is already the one being looked at.
      target.scrollIntoView?.({ block: "start", behavior: "auto" });
    }
    frame = requestAnimationFrame(follow);
  };
  const timer = setTimeout(stop, durationMs);
  for (const type of TAKEOVER_EVENTS) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
  signal?.addEventListener("abort", stop, { once: true });
  frame = requestAnimationFrame(follow);
}

function waitForVisibleAnchor(
  root: HTMLElement,
  id: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<HTMLElement | undefined> {
  const find = () =>
    [...root.querySelectorAll<HTMLElement>(settingAnchorSelector(id))].find(
      (element) => !element.closest("[hidden]"),
    );
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const found = find();
    if (found) return resolve(found);

    const finish = (element: HTMLElement | undefined) => {
      observer.disconnect();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      resolve(element);
    };
    const abandon = () => finish(undefined);
    const observer = new MutationObserver(() => {
      const element = find();
      if (element) finish(element);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-setting-id"],
    });
    const timer = setTimeout(abandon, timeoutMs);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/** A setting inside a folded `<details>` would scroll to a line it is hidden behind. */
function openFoldsAround(target: HTMLElement) {
  if (target instanceof HTMLDetailsElement) target.open = true;
  for (
    let fold = target.parentElement?.closest("details");
    fold;
    fold = fold.parentElement?.closest("details")
  ) {
    fold.open = true;
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Focus without a second, competing scroll.
 *
 * A card is not normally a tab stop, so it is made focusable for as long as it
 * holds focus and gives that back when focus moves on, leaving the page's tab
 * order as it was.
 */
function focusWithoutScrolling(target: HTMLElement) {
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), {
      once: true,
    });
  }
  target.focus({ preventScroll: true });
}

function markBriefly(target: HTMLElement, durationMs: number) {
  if (highlighted) {
    clearTimeout(highlighted.timer);
    highlighted.element.removeAttribute(SETTING_HIGHLIGHT_ATTRIBUTE);
  }
  target.setAttribute(SETTING_HIGHLIGHT_ATTRIBUTE, "true");
  const timer = setTimeout(() => {
    target.removeAttribute(SETTING_HIGHLIGHT_ATTRIBUTE);
    if (highlighted?.element === target) highlighted = undefined;
  }, durationMs);
  highlighted = { element: target, timer };
}
