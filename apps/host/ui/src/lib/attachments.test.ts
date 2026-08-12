import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_PROMPT } from "@fleet/protocol";
import {
  acceptAttachment,
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

  it("gives two pasted screenshots different handles", () => {
    // Both arrive named "image.png"; keying on the name would make removing one
    // remove the other.
    const first = acceptAttachment(file("image.png", "image/png"), "AAAA", []);
    const second = acceptAttachment(file("image.png", "image/png"), "AAAA", []);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.attachment.id).not.toBe(second.attachment.id);
  });

  it("names a clipboard image that arrives without one", () => {
    const result = acceptAttachment(file("", "image/png"), "AAAA", []);
    expect(result.ok && result.attachment.name).toBe("pasted-image.png");
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
