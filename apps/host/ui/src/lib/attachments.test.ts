import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_PROMPT } from "@fleet/protocol";
import {
  acceptAttachment,
  attachmentDataUrl,
  attachmentSizeLabel,
  base64FromDataUrl,
  isImageAttachment,
  toWireAttachments,
  type DraftAttachment,
} from "./attachments";

const base64Of = (text: string) => Buffer.from(text).toString("base64");
const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe("base64FromDataUrl", () => {
  it("drops the prefix FileReader puts in front of the bytes", () => {
    expect(base64FromDataUrl("data:image/png;base64,AAAB")).toBe("AAAB");
  });

  it("gives nothing back for something that is not a data URL", () => {
    expect(base64FromDataUrl("not-a-data-url")).toBe("");
  });
});

describe("acceptAttachment", () => {
  it("accepts a file and gives it a handle of its own", () => {
    const result = acceptAttachment(file("notes.txt", "text/plain"), base64Of("hi"), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toMatchObject({
      name: "notes.txt",
      mimeType: "text/plain",
    });
    expect(result.attachment.id).toBeTruthy();
  });

  it("numbers pasted screenshots and keeps their identities and bytes separate", () => {
    const first = acceptAttachment(
      file("image.png", "image/png"),
      "AAAA",
      [],
      "clipboard",
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = acceptAttachment(
      file("image.png", "image/png"),
      "BBBB",
      [first.attachment],
      "clipboard",
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(first.attachment.id).not.toBe(second.attachment.id);
    expect(toWireAttachments([first.attachment, second.attachment])).toEqual([
      { name: "image1.png", mimeType: "image/png", data: "AAAA" },
      { name: "image2.png", mimeType: "image/png", data: "BBBB" },
    ]);
  });

  it.each([
    ["", "image/png", "image1.png"],
    ["", "image/jpeg", "image1.jpg"],
    ["", "image/svg+xml", "image1.svg"],
    ["screenshot.webp", "image/webp", "image1.webp"],
  ])("names a pasted %s (%s) with its image extension", (name, type, expected) => {
    const result = acceptAttachment(file(name, type), "AAAA", [], "clipboard");
    expect(result.ok && result.attachment.name).toBe(expected);
  });

  it("continues image numbering across formats, existing uploads and removal", () => {
    const existing: DraftAttachment[] = [
      { id: "kept", name: "IMAGE2.PNG", mimeType: "image/png", data: "AAAA" },
    ];
    const result = acceptAttachment(
      file("image.webp", "image/webp"),
      "BBBB",
      existing,
      "clipboard",
    );
    expect(result.ok && result.attachment.name).toBe("image3.webp");
    expect(existing[0]?.name).toBe("IMAGE2.PNG");
  });

  it.each([
    ["report.pdf", "application/pdf", "report (2).pdf"],
    ["image.png", "image/png", "image (2).png"],
    ["notes", "text/plain", "notes (2)"],
    [".env", "text/plain", ".env (2)"],
    ["a".repeat(251) + ".txt", "text/plain", "a".repeat(247) + " (2).txt"],
  ])(
    "disambiguates uploaded %s without changing its contents",
    (name, type, expected) => {
      const first = acceptAttachment(file(name, type), "AAAA", []);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = acceptAttachment(file(name, type), "BBBB", [first.attachment]);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(first.attachment.name).toBe(name);
      expect(second.attachment).toMatchObject({
        name: expected,
        mimeType: type,
        data: "BBBB",
      });
      expect(second.attachment.name.length).toBeLessThanOrEqual(255);
    },
  );

  it("skips occupied suffixes case-insensitively, including pasted non-image files", () => {
    const existing = ["NOTES.TXT", "notes (2).txt"].map((name) => ({
      id: name,
      name,
      mimeType: "text/plain",
      data: "AAAA",
    }));
    const result = acceptAttachment(
      file("notes.txt", "text/plain"),
      "BBBB",
      existing,
      "clipboard",
    );
    expect(result.ok && result.attachment.name).toBe("notes (3).txt");
  });

  it("refuses once the prompt is full, and says so", () => {
    const full = Array.from({ length: MAX_ATTACHMENTS_PER_PROMPT }, (_, index) => ({
      id: String(index),
      name: "f",
      mimeType: "text/plain",
      data: "AA",
    }));
    const result = acceptAttachment(file("one-more.txt", "text/plain"), "AA", full);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(MAX_ATTACHMENTS_PER_PROMPT));
  });

  it("refuses a file over the size ceiling by name", () => {
    // 11 MB of base64 decodes to more than the 10 MB limit.
    const result = acceptAttachment(
      file("huge.bin", "application/octet-stream"),
      "A".repeat(15 * 1024 * 1024),
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("huge.bin");
  });

  it("refuses a file it could not read", () => {
    const result = acceptAttachment(file("gone.txt", "text/plain"), "", []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gone.txt");
  });
});

describe("attachmentSizeLabel", () => {
  it("scales the unit to the file", () => {
    const of = (bytes: number) => ({
      name: "f",
      mimeType: "text/plain",
      data: Buffer.alloc(bytes).toString("base64"),
    });
    expect(attachmentSizeLabel(of(12))).toBe("12 B");
    expect(attachmentSizeLabel(of(2048))).toBe("2 KB");
    expect(attachmentSizeLabel(of(3 * 1024 * 1024))).toBe("3.0 MB");
  });
});

describe("isImageAttachment", () => {
  it("splits images from everything else", () => {
    expect(isImageAttachment({ name: "a", mimeType: "image/webp", data: "A" })).toBe(
      true,
    );
    expect(isImageAttachment({ name: "a", mimeType: "text/plain", data: "A" })).toBe(
      false,
    );
  });
});

describe("attachmentDataUrl", () => {
  it("puts back the prefix an <img> needs to show the bytes", () => {
    expect(
      attachmentDataUrl({ name: "a.png", mimeType: "image/png", data: "AAAB" }),
    ).toBe("data:image/png;base64,AAAB");
  });
});

describe("toWireAttachments", () => {
  it("leaves the composer's handle behind", () => {
    const drafts: DraftAttachment[] = [
      { id: "local-1", name: "a.txt", mimeType: "text/plain", data: "AA" },
    ];
    expect(toWireAttachments(drafts)).toEqual([
      { name: "a.txt", mimeType: "text/plain", data: "AA" },
    ]);
  });
});
