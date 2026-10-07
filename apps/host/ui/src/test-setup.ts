import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  createElement,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import type * as VirtuosoModule from "react-virtuoso";

// Testing Library only registers this for itself when the test globals are on,
// and they are not; without it each render stacks onto the previous document.
afterEach(cleanup);

/*
 * jsdom does no layout: every `offsetParent` is null and <body> measures 0x0.
 * Tabster, which Fluent uses for focus, reads both to decide what can take
 * focus, so in jsdom nothing can. An opening Dialog then focuses its own surface
 * instead of its first control, tabster never activates the dialog's modalizer
 * (that needs focus strictly inside it), and its next sweep, debounced 250ms
 * after any DOM change, marks the inactive modalizer aria-hidden. The open
 * dialog's controls drop out of role queries, so whether a test finds them
 * depends on how soon its query runs (microsoft/fluentui#33897).
 *
 * These stand-ins report what a browser does for a rendered element on a page
 * with no positioned ancestors. Hidden ancestors are recognised by the `hidden`
 * attribute only; resolving every ancestor's style would cost more than any
 * test here needs.
 */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get(this: HTMLElement): Element | null {
    const { body, documentElement } = this.ownerDocument;
    if (!this.isConnected || this === body || this === documentElement) return null;
    if (this.closest("[hidden]")) return null;
    const { display, position } = getComputedStyle(this);
    return display === "none" || position === "fixed" ? null : body;
  },
});
Object.defineProperty(document.body, "getBoundingClientRect", {
  configurable: true,
  value: () => new DOMRect(0, 0, window.innerWidth, window.innerHeight),
});

/*
 * react-virtuoso decides what to mount from measured layout, and jsdom has none:
 * a list that opens at its newest item renders nothing there at all. Component
 * tests get every item, through the same props, components and scroll element;
 * the windowing itself is measured in a real browser by the benchmark harness.
 */
vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof VirtuosoModule>();
  type Props = {
    data?: readonly unknown[];
    firstItemIndex?: number;
    itemContent?: (index: number, item: unknown, context: unknown) => ReactNode;
    computeItemKey?: (index: number, item: unknown, context: unknown) => React.Key;
    context?: unknown;
    className?: string;
    components?: Record<string, ComponentType<Record<string, unknown>>>;
    scrollerRef?: (element: HTMLElement | null) => void;
  };
  const Virtuoso = forwardRef<unknown, Props>(function Virtuoso(props, ref) {
    const { data = [], firstItemIndex = 0, context, components = {} } = props;
    const scroller = useRef<HTMLElement | null>(null);
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => {},
      scrollTo: (options: ScrollToOptions) => scroller.current?.scrollTo(options),
      autoscrollToBottom: () => {},
    }));
    const { scrollerRef } = props;
    const attach = useCallback(
      (element: HTMLElement | null) => {
        scroller.current = element;
        scrollerRef?.(element);
      },
      [scrollerRef],
    );
    const Scroller = components.Scroller ?? "div";
    return createElement(
      Scroller,
      { ref: attach, className: props.className, context },
      components.Header ? createElement(components.Header, { context }) : null,
      data.map((item, offset) => {
        const index = firstItemIndex + offset;
        return createElement(
          "div",
          {
            key: props.computeItemKey?.(index, item, context) ?? index,
            "data-index": index,
          },
          props.itemContent?.(index, item, context),
        );
      }),
      components.Footer ? createElement(components.Footer, { context }) : null,
    );
  });
  return { ...actual, Virtuoso };
});

/*
 * jsdom has no ResizeObserver, and Fluent's MessageBar constructs one to decide
 * whether to reflow. Without a stand-in every component that shows a warning
 * throws out of a layout effect, which surfaces as an unhandled error rather
 * than as a failing assertion.
 */
/*
 * jsdom has no element scrolling. Virtualised lists scroll with `scrollTo`, so a
 * stand-in records the position the way a browser would report it back.
 */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof options === "number") {
      this.scrollLeft = options;
      this.scrollTop = y ?? this.scrollTop;
      return;
    }
    if (options?.top !== undefined) this.scrollTop = options.top;
    if (options?.left !== undefined) this.scrollLeft = options.left;
  } as Element["scrollTo"];
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
