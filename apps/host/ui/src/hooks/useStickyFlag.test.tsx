import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { readFlag, useStickyFlag } from "./useStickyFlag";

/** Renders the hook and exposes its latest value and setter. */
const mount = (key: string, fallback: boolean) => {
  const seen: { value: boolean; set: (next?: boolean) => void }[] = [];
  const Probe = () => {
    const [value, set] = useStickyFlag(key, fallback);
    seen.push({ value, set });
    return null;
  };
  render(<Probe />);
  return {
    latest: () => seen[seen.length - 1]!,
    value: () => seen[seen.length - 1]!.value,
  };
};

describe("sticky flags", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("starts from the fallback when nothing has been chosen", () => {
    expect(readFlag("nav.collapsed", true)).toBe(true);
    expect(mount("nav.collapsed", false).value()).toBe(false);
  });

  it("remembers a choice under a namespaced key", () => {
    const probe = mount("nav.collapsed", false);
    act(() => probe.latest().set());

    expect(probe.value()).toBe(true);
    // Namespaced so the fleet's preferences cannot collide with anything else
    // this origin stores.
    expect(localStorage.getItem("fleet.ui.nav.collapsed")).toBe("1");
    expect(readFlag("nav.collapsed", false)).toBe(true);
  });

  it("remembers being turned off, not just being turned on", () => {
    /*
     * The difference matters for a panel that defaults to open: without a
     * stored "0" every reload would hand back the sidebar the operator had
     * just folded away, since a missing key means "never chosen".
     */
    const probe = mount("conversation.tasks", true);
    act(() => probe.latest().set(false));

    expect(localStorage.getItem("fleet.ui.conversation.tasks")).toBe("0");
    expect(readFlag("conversation.tasks", true)).toBe(false);
  });

  it("still toggles where the browser refuses to store anything", () => {
    /*
     * `localStorage` throws rather than returning null when storage is blocked,
     * so an unguarded read takes the whole app down. A panel that forgets where
     * it was is a far better outcome than a page that will not render.
     */
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const probe = mount("nav.collapsed", false);
    expect(probe.value()).toBe(false);

    act(() => probe.latest().set());
    expect(probe.value()).toBe(true);
  });
});
