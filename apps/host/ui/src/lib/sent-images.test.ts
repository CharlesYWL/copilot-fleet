import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SENT_IMAGES,
  SENT_IMAGE_RETENTION_MS,
  clearSentImages,
  findSentImage,
  onSentImagesChange,
  saveSentImages,
} from "./sent-images";

const png = (name: string, data: string) => ({ name, mimeType: "image/png", data });
const summary = (name: string, bytes = 3) => ({ name, mimeType: "image/png", bytes });

afterEach(async () => {
  await clearSentImages();
});

describe("sent images", () => {
  it("keeps sent images so a transcript chip can find them again", async () => {
    await saveSentImages("session-1", [png("image1.png", "AAAB")], 1_000);
    const found = await findSentImage(
      "session-1",
      summary("image1.png"),
      new Date(1_000).toISOString(),
    );
    expect(found).toMatchObject({ name: "image1.png", data: "AAAB", bytes: 3 });
  });

  it("keeps only images, never other files", async () => {
    await saveSentImages("session-1", [
      { name: "notes.txt", mimeType: "text/plain", data: "aGk=" },
    ]);
    expect(
      await findSentImage(
        "session-1",
        { name: "notes.txt", mimeType: "text/plain", bytes: 2 },
        new Date().toISOString(),
      ),
    ).toBeUndefined();
  });

  it("does not show one session's image under another's chip", async () => {
    await saveSentImages("session-1", [png("image1.png", "AAAB")]);
    expect(
      await findSentImage("session-2", summary("image1.png"), new Date().toISOString()),
    ).toBeUndefined();
  });

  it("picks the copy sent nearest the message when a name is reused", async () => {
    await saveSentImages("session-1", [png("image1.png", "AAAA")], 1_000);
    await saveSentImages("session-1", [png("image1.png", "BBBB")], 50_000);
    const later = await findSentImage(
      "session-1",
      summary("image1.png"),
      new Date(49_000).toISOString(),
    );
    const earlier = await findSentImage(
      "session-1",
      summary("image1.png"),
      new Date(2_000).toISOString(),
    );
    expect(later?.data).toBe("BBBB");
    expect(earlier?.data).toBe("AAAA");
  });

  it("forgets the oldest copies beyond the cap and past the retention window", async () => {
    const start = 1_000_000;
    for (let index = 0; index <= MAX_SENT_IMAGES; index++) {
      await saveSentImages(
        "session-1",
        [png(`image${index}.png`, "AAAB")],
        start + index,
      );
    }
    expect(
      await findSentImage(
        "session-1",
        summary("image0.png"),
        new Date(start).toISOString(),
      ),
    ).toBeUndefined();
    expect(
      await findSentImage(
        "session-1",
        summary("image1.png"),
        new Date(start).toISOString(),
      ),
    ).toBeDefined();

    await saveSentImages(
      "session-1",
      [png("late.png", "AAAB")],
      start + SENT_IMAGE_RETENTION_MS + MAX_SENT_IMAGES + 1,
    );
    expect(
      await findSentImage(
        "session-1",
        summary("image5.png"),
        new Date(start).toISOString(),
      ),
    ).toBeUndefined();
  });

  it("announces saves and clears, and clearing forgets everything", async () => {
    const listener = vi.fn();
    const unsubscribe = onSentImagesChange(listener);
    await saveSentImages("session-1", [png("image1.png", "AAAB")]);
    await clearSentImages();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      await findSentImage("session-1", summary("image1.png"), new Date().toISOString()),
    ).toBeUndefined();
  });
});
