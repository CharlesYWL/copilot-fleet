import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only registers this for itself when the test globals are on,
// and they are not; without it each render stacks onto the previous document.
afterEach(cleanup);

/*
 * jsdom has no ResizeObserver, and Fluent's MessageBar constructs one to decide
 * whether to reflow. Without a stand-in every component that shows a warning
 * throws out of a layout effect, which surfaces as an unhandled error rather
 * than as a failing assertion.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
