import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSchema, type PendingSessionMessage } from "@fleet/protocol";
import { SessionMessageQueue } from "./SessionMessageQueue";
import { fleetDarkTheme } from "../theme";
import { api } from "../hooks/useFleet";

vi.mock("../hooks/useFleet", () => ({ api: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
});
const message: PendingSessionMessage = {
  id: "message",
  prompt: "Review the next change",
  createdAt: "2026-10-08T00:00:00Z",
  source: "operator",
  state: "pending",
  attachments: [{ name: "image.png" }],
  canSendNow: true,
  canCancel: true,
  detail: "",
};
const session = SessionSchema.parse({
  id: "session",
  workspaceId: "workspace",
  workspaceName: "repo",
  placementId: "placement",
  nodeId: "node",
  nodeName: "Node",
  name: "Session",
  state: "running",
  initialPrompt: "Work",
  currentActivity: "",
  lastText: "",
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
});
const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SessionMessageQueue session={session} />
    </FluentProvider>,
  );

describe("SessionMessageQueue", () => {
  it("starts collapsed and expands to show messages, attachments and controls", async () => {
    vi.mocked(api).mockResolvedValue([message]);
    const view = show();
    const summary = await screen.findByText("1 queued message");
    expect(view.container.querySelector("details")!.open).toBe(false);
    fireEvent.click(summary);
    expect(view.container.querySelector("details")!.open).toBe(true);
    expect(screen.getByText(message.prompt)).toBeTruthy();
    expect(screen.getByText("image.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
  });

  it.each(["Cancel", "Send now"])(
    "performs %s and refreshes the queue",
    async (label) => {
      vi.mocked(api)
        .mockResolvedValueOnce([message])
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce([]);
      show();
      fireEvent.click(await screen.findByText("1 queued message"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
      expect(api).toHaveBeenCalledWith(
        `/api/sessions/session/messages/message/${label === "Cancel" ? "cancel" : "send-now"}`,
        { method: "POST" },
      );
      await waitFor(() => expect(screen.queryByText("1 queued message")).toBeNull());
    },
  );

  it("keeps the item and exposes action failures instead of pretending it was removed", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce([message])
      .mockRejectedValueOnce(new Error("Message already reserved"));
    show();
    fireEvent.click(await screen.findByText("1 queued message"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Message already reserved",
    );
    expect(screen.getByText(message.prompt)).toBeTruthy();
  });

  it("shows workflow messages without offering unsafe recall", async () => {
    vi.mocked(api).mockResolvedValue([
      {
        ...message,
        source: "fleet",
        canCancel: false,
        canSendNow: false,
        detail: "Managed by the local-agent request",
      },
    ]);
    show();
    fireEvent.click(await screen.findByText("1 queued message"));
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Managed by the local-agent request")).toBeTruthy();
  });
});
