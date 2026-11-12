import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { MarkdownBody } from "./MarkdownBody";
import { fleetDarkTheme } from "../theme";

describe("MarkdownBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies a message as markdown and as HTML that keeps its links", async () => {
    const items: Record<string, Blob>[] = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(data: Record<string, Blob>) {
          items.push(data);
        }
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { write: vi.fn(async () => undefined) },
      configurable: true,
    });
    const text =
      "See the [docs](https://x.test/docs) for **both** `number` and `string`.";
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <MarkdownBody text={text} copyable />
      </FluentProvider>,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy message" })),
    );
    expect(navigator.clipboard.write).toHaveBeenCalledOnce();
    expect(await items[0]?.["text/plain"]?.text()).toBe(text);
    expect(await items[0]?.["text/html"]?.text()).toBe(
      '<p>See the <a href="https://x.test/docs">docs</a> for <strong>both</strong>' +
        " <code>number</code> and <code>string</code>.</p>",
    );
  });
});
