import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import { clearSentImages, saveSentImages } from "../lib/sent-images";
import { SentAttachments } from "./SentAttachments";

const sentAt = new Date().toISOString();

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SentAttachments
        sessionId="session-1"
        sentAt={sentAt}
        attachments={[
          { name: "image1.png", mimeType: "image/png", bytes: 3 },
          { name: "notes.txt", mimeType: "text/plain", bytes: 2 },
        ]}
      />
    </FluentProvider>,
  );

afterEach(async () => {
  await clearSentImages();
});

describe("SentAttachments", () => {
  it("opens a sent image this browser kept, and leaves other files as names", async () => {
    await saveSentImages("session-1", [
      { name: "image1.png", mimeType: "image/png", data: "AAAB" },
    ]);
    show();
    const chip = await screen.findByRole("button", { name: "View image1.png" });
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View notes.txt" })).toBeNull();

    fireEvent.click(chip);
    const preview = await screen.findByRole("img", { name: "image1.png" });
    expect(preview.getAttribute("src")).toBe("data:image/png;base64,AAAB");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "image1.png" })).toBeNull(),
    );
  });

  it("shows only the name when this browser has no copy", () => {
    show();
    expect(screen.getByText("image1.png")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View image1.png" })).toBeNull();
  });

  it("becomes viewable when the image is saved after the message appears", async () => {
    show();
    expect(screen.queryByRole("button", { name: "View image1.png" })).toBeNull();
    await saveSentImages("session-1", [
      { name: "image1.png", mimeType: "image/png", data: "AAAB" },
    ]);
    expect(await screen.findByRole("button", { name: "View image1.png" })).toBeTruthy();
  });
});
