import { describe, expect, it } from "vitest";
import type { PromptAttachment } from "@fleet/protocol";
import { toPromptBlocks } from "./prompt-content.js";

const attach = (
  name: string,
  mimeType: string,
  contents: string | Buffer,
): PromptAttachment => ({
  name,
  mimeType,
  data: Buffer.from(contents as never).toString("base64"),
});

describe("toPromptBlocks", () => {
  it("leads with the prompt, so the question comes before its evidence", () => {
    const blocks = toPromptBlocks("look at this", [
      attach("shot.png", "image/png", "not really a png"),
    ]);
    expect(blocks[0]).toEqual({ type: "text", text: "look at this" });
  });

  it("sends an image as an image block, bytes untouched", () => {
    const image = attach("shot.png", "image/png", "pretend-bytes");
    const [, block] = toPromptBlocks("what is this", [image]);
    expect(block).toEqual({
      type: "image",
      data: image.data,
      mimeType: "image/png",
    });
  });

  it("embeds a text file as a resource the agent can read", () => {
    const [, block] = toPromptBlocks("review", [
      attach("notes.txt", "text/plain", "The secret word is PLATYPUS."),
    ]);
    expect(block).toEqual({
      type: "resource",
      resource: {
        uri: "attachment:///notes.txt",
        mimeType: "text/plain",
        text: "The secret word is PLATYPUS.",
      },
    });
  });

  it("escapes a name that would otherwise break the uri", () => {
    const [, block] = toPromptBlocks("x", [
      attach("my notes #1.txt", "text/plain", "hello"),
    ]);
    expect(block).toMatchObject({
      resource: { uri: "attachment:///my%20notes%20%231.txt" },
    });
  });

  it("names a binary file rather than embedding mojibake", () => {
    // Decoding a zip as utf8 yields replacement characters, which would spend
    // the context window on noise and can read as instructions.
    const [, block] = toPromptBlocks("what is in here", [
      attach(
        "bundle.zip",
        "application/zip",
        Buffer.from([0x50, 0x4b, 0x03, 0xff, 0xfe]),
      ),
    ]);
    expect(block).toMatchObject({ type: "text" });
    expect((block as { text: string }).text).toContain("bundle.zip");
    expect((block as { text: string }).text).toContain("left out");
  });

  it("keeps several attachments, in the order they were added", () => {
    const blocks = toPromptBlocks("compare", [
      attach("a.txt", "text/plain", "first"),
      attach("b.png", "image/png", "second"),
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["text", "resource", "image"]);
  });

  it("sends a plain prompt as one text block when nothing is attached", () => {
    expect(toPromptBlocks("just words")).toEqual([{ type: "text", text: "just words" }]);
  });
});
