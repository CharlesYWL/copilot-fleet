import { describe, expect, it } from "vitest";
import { linkedPlainText } from "./paste-links";

const docs =
  "https://storybooks.fluentui.dev/react/?path=/docs/components-spinbutton--docs";

describe("linkedPlainText", () => {
  it("keeps a Teams link as markdown and the rest of the text exactly", () => {
    const plain =
      "If you look at how spinbutton apis work, they pass out either a number_or *string*.";
    const html =
      `<p>If you look at how <a href="${docs}" title="${docs}" target="_blank">spinbutton</a>` +
      " apis work, they pass out <i>either</i> a <code>number_or</code> *string*.</p>";
    expect(linkedPlainText(plain, html)).toBe(
      `If you look at how [spinbutton](${docs}) apis work, they pass out either a number_or *string*.`,
    );
  });

  it("links the occurrence the HTML links, not an earlier one", () => {
    expect(
      linkedPlainText(
        "the docs say see the docs",
        '<div>the docs say see the <a href="https://x.test/">docs</a></div>',
      ),
    ).toBe("the docs say see the [docs](https://x.test/)");
  });

  it("matches words that Outlook wrapped or spaced differently", () => {
    expect(
      linkedPlainText(
        "Read the spin button docs.",
        '<p>Read\r\nthe <a href="https://x.test/a"><span>spin&nbsp;button\r\ndocs</span></a>.</p>',
      ),
    ).toBe("Read the [spin button docs](https://x.test/a).");
  });

  it("leaves pastes with nothing to restore to the browser", () => {
    expect(
      linkedPlainText("const a = b * c;", "<pre><span>const a = b * c;</span></pre>"),
    ).toBe(undefined);
    expect(
      linkedPlainText(
        "see https://x.test/",
        '<a href="https://x.test/">https://x.test/</a>',
      ),
    ).toBe(undefined);
    expect(linkedPlainText("click", '<a href="javascript:alert(1)">click</a>')).toBe(
      undefined,
    );
  });
});
