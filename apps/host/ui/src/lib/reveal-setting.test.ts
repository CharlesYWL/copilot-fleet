import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTING_HIGHLIGHT_ATTRIBUTE,
  revealSetting,
  type RevealOptions,
} from "./reveal-setting";

const anchor = (id: string, tag = "section") => {
  const element = document.createElement(tag);
  element.setAttribute("data-setting-id", id);
  element.scrollIntoView = vi.fn();
  return element;
};

const mount = (...children: HTMLElement[]) => {
  const root = document.createElement("div");
  root.append(...children);
  document.body.append(root);
  return root;
};

const reveal = (root: HTMLElement, id: string, options: RevealOptions = {}) =>
  revealSetting(root, id, { timeoutMs: 1_000, highlightMs: 500, ...options });

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("revealSetting", () => {
  it("scrolls to the setting, focuses it, and marks it for a moment", async () => {
    vi.useFakeTimers();
    const target = anchor("general.yolo");
    const root = mount(anchor("general.agency"), target);

    expect(await reveal(root, "general.yolo")).toBe(target);

    expect(target.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: "start",
      behavior: "smooth",
    });
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute(SETTING_HIGHLIGHT_ATTRIBUTE)).toBe("true");
    vi.advanceTimersByTime(500);
    expect(target.hasAttribute(SETTING_HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });

  it("makes a card focusable only until focus leaves it", async () => {
    const target = anchor("general.yolo");
    const other = document.createElement("button");
    const root = mount(target, other);

    await reveal(root, "general.yolo");
    expect(target.getAttribute("tabindex")).toBe("-1");

    other.focus();
    expect(target.hasAttribute("tabindex")).toBe(false);
  });

  it("leaves an element's own tab stop alone", async () => {
    const target = anchor("nodes.inventory", "div");
    target.tabIndex = 0;
    const root = mount(target, document.createElement("button"));

    await reveal(root, "nodes.inventory");
    (root.lastElementChild as HTMLElement).focus();

    expect(target.getAttribute("tabindex")).toBe("0");
  });

  it("waits for a setting that a page renders after loading", async () => {
    const root = mount();
    const revealing = reveal(root, "security.audit");
    const target = anchor("security.audit");

    root.append(target);

    expect(await revealing).toBe(target);
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("skips a copy inside a hidden page until that page is shown", async () => {
    const page = document.createElement("div");
    page.hidden = true;
    const target = anchor("tunnel.provider.devtunnel");
    page.append(target);
    const root = mount(page);
    const revealing = reveal(root, "tunnel.provider.devtunnel");
    await Promise.resolve();
    expect(target.scrollIntoView).not.toHaveBeenCalled();

    page.hidden = false;

    expect(await revealing).toBe(target);
  });

  it("opens a folded section that holds the setting, and the setting itself", async () => {
    const outer = document.createElement("details");
    const target = anchor("general.managed-worktrees.quotas", "details");
    outer.append(target);
    const root = mount(outer);

    await reveal(root, "general.managed-worktrees.quotas");

    expect(outer.open).toBe(true);
    expect((target as HTMLDetailsElement).open).toBe(true);
  });

  it("gives up when the setting never appears", async () => {
    vi.useFakeTimers();
    const root = mount();
    const revealing = reveal(root, "general.agency");

    vi.advanceTimersByTime(1_000);

    expect(await revealing).toBeUndefined();
  });

  it("does nothing once the request is abandoned", async () => {
    const controller = new AbortController();
    const target = anchor("general.yolo");
    const root = mount(target);
    const revealing = reveal(root, "general.yolo", { signal: controller.signal });

    controller.abort();

    expect(await revealing).toBeUndefined();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(target.hasAttribute(SETTING_HIGHLIGHT_ATTRIBUTE)).toBe(false);
  });

  it("moves the mark from the previous setting to the new one", async () => {
    const first = anchor("general.yolo");
    const second = anchor("general.agency");
    const root = mount(first, second);

    await reveal(root, "general.yolo");
    await reveal(root, "general.agency");

    expect(first.hasAttribute(SETTING_HIGHLIGHT_ATTRIBUTE)).toBe(false);
    expect(second.getAttribute(SETTING_HIGHLIGHT_ATTRIBUTE)).toBe("true");
  });

  it("jumps instead of gliding for someone who asked for less motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("reduce") })),
    );
    const target = anchor("general.yolo");
    const root = mount(target);

    await reveal(root, "general.yolo");

    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
  });

  it("finds an id with characters that are special in a selector", async () => {
    const target = anchor('workspace:a"b\\c');
    const root = mount(target);
    expect(await reveal(root, 'workspace:a"b\\c')).toBe(target);
  });
});

describe("revealSetting while the page settles", () => {
  /** A setting whose position on the page the test moves, as loading cards would. */
  const shiftingAnchor = () => {
    const target = anchor("node:n1", "div");
    const position = { top: 100 };
    Object.defineProperty(target, "offsetTop", {
      configurable: true,
      get: () => position.top,
    });
    return { target, position };
  };

  const frames = () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    return (count = 1) => vi.advanceTimersByTime(20 * count);
  };

  it("brings the setting back when something loading above it pushes it down", async () => {
    const tick = frames();
    const { target, position } = shiftingAnchor();
    const root = mount(target);
    await reveal(root, "node:n1", { settleMs: 1_000 });
    expect(target.scrollIntoView).toHaveBeenCalledOnce();

    position.top = 900;
    tick();

    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(target.scrollIntoView).toHaveBeenLastCalledWith({
      block: "start",
      behavior: "auto",
    });
    tick(5);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("lets go as soon as the operator scrolls or clicks", async () => {
    const tick = frames();
    const { target, position } = shiftingAnchor();
    const root = mount(target);
    await reveal(root, "node:n1", { settleMs: 1_000 });

    window.dispatchEvent(new Event("wheel"));
    position.top = 900;
    tick(3);

    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("lets go once the page has had time to settle", async () => {
    const tick = frames();
    const { target, position } = shiftingAnchor();
    const root = mount(target);
    await reveal(root, "node:n1", { settleMs: 100 });

    tick(10);
    position.top = 900;
    tick(3);

    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("lets go when the request is abandoned", async () => {
    const tick = frames();
    const controller = new AbortController();
    const { target, position } = shiftingAnchor();
    const root = mount(target);
    await reveal(root, "node:n1", { settleMs: 1_000, signal: controller.signal });

    controller.abort();
    position.top = 900;
    tick(3);

    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });
});
