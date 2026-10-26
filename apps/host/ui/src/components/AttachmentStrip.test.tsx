import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../theme";
import type { DraftAttachment } from "../lib/attachments";
import { AttachmentStrip } from "./AttachmentStrip";

const image: DraftAttachment = {
  id: "img-1",
  name: "image1.png",
  mimeType: "image/png",
  data: "AAAB",
};
const notes: DraftAttachment = {
  id: "txt-1",
  name: "notes.txt",
  mimeType: "text/plain",
  data: "aGk=",
};

const show = (attachments: DraftAttachment[], onRemove = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <AttachmentStrip attachments={attachments} onRemove={onRemove} />
    </FluentProvider>,
  );

describe("AttachmentStrip", () => {
  it("shows a pasted image as a thumbnail, not just its name", () => {
    const { container } = show([image, notes]);
    const thumbnail = container.querySelector("img");
    expect(thumbnail?.getAttribute("src")).toBe("data:image/png;base64,AAAB");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Preview image1.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.txt" })).toBeNull();
  });

  it("opens the full image from the thumbnail and closes it again", async () => {
    show([image]);
    fireEvent.click(screen.getByRole("button", { name: "Preview image1.png" }));
    const preview = await screen.findByRole("img", { name: "image1.png" });
    expect(preview.getAttribute("src")).toBe("data:image/png;base64,AAAB");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "image1.png" })).toBeNull(),
    );
  });

  it("closes the preview when the previewed image is removed", async () => {
    const { rerender } = show([image]);
    fireEvent.click(screen.getByRole("button", { name: "Preview image1.png" }));
    await screen.findByRole("img", { name: "image1.png" });
    rerender(
      <FluentProvider theme={fleetDarkTheme}>
        <AttachmentStrip attachments={[notes]} onRemove={vi.fn()} />
      </FluentProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "image1.png" })).toBeNull(),
    );
  });
});
