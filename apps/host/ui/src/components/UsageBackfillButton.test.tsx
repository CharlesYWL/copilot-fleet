import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageBackfillButton } from "./UsageBackfillButton";
import { api } from "../hooks/useFleet";
vi.mock("../hooks/useFleet", () => ({ api: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const preview = {
  previewId: "a".repeat(64),
  eligibleConversations: 2,
  eligibleSessions: 3,
  aiCredits: 1200,
  skipped: {
    active: 4,
    otherBackend: 1,
    missingIdentity: 0,
    missingCredits: 0,
    conflicting: 1,
    alreadyRecorded: 2,
  },
};

describe("UsageBackfillButton", () => {
  it("previews before confirmation and never posts until the operator confirms", async () => {
    const onCompleted = vi.fn();
    vi.mocked(api).mockResolvedValueOnce(preview).mockResolvedValueOnce({
      importedConversations: 2,
      aiCredits: 1200,
      backupFile: "usage-backfill-test.db",
    });
    render(<UsageBackfillButton onCompleted={onCompleted} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    const confirm = await screen.findByRole("button", { name: "Import credits" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    expect(screen.getByText(/1.20K/)).toBeTruthy();
    expect(screen.getByText(/undated opening balances/i)).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/usage/backfill",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ previewId: preview.previewId }),
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("Imported"),
    );
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
  it("disables import when all old conversations are already recorded", async () => {
    vi.mocked(api).mockResolvedValue({
      ...preview,
      eligibleConversations: 0,
      eligibleSessions: 0,
      aiCredits: 0,
    });
    render(<UsageBackfillButton onCompleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    expect(await screen.findByText(/No eligible old credits/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Import credits" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("shows preview failures without writing anything", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Administrator required"));
    render(<UsageBackfillButton onCompleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Administrator required",
    );
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh preview after a rejected import", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error("The backfill preview changed."))
      .mockResolvedValueOnce({ ...preview, eligibleConversations: 0 });
    const onCompleted = vi.fn();
    render(<UsageBackfillButton onCompleted={onCompleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    const confirm = await screen.findByRole("button", { name: "Import credits" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The backfill preview changed.",
    );
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(onCompleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview again" }));
    await screen.findByText(/No eligible old credits/);
    expect(api).toHaveBeenCalledTimes(3);
  });
  it("cancels a pending preview without importing", async () => {
    vi.mocked(api).mockImplementation(() => new Promise(() => {}));
    render(<UsageBackfillButton onCompleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate submissions while an import is applying", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api)
      .mockResolvedValueOnce(preview)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<UsageBackfillButton onCompleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    const confirm = await screen.findByRole("button", { name: "Import credits" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirm);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(api).toHaveBeenCalledTimes(2);
    finish({ importedConversations: 0, aiCredits: 0, backupFile: null });
    await screen.findByRole("status");
  });
});
