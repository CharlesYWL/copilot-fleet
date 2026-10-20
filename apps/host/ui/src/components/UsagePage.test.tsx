import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@fleet/protocol";
import { UsagePage, usageQuery } from "./UsagePage";
import { api } from "../hooks/useFleet";
vi.mock("../hooks/useFleet", () => ({ api: vi.fn() }));
const amounts = {
  aiCredits: 2.5,
  totalTokens: 300,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
};
const report: UsageReport = {
  totals: amounts,
  rows: [{ ...amounts, key: "machine", label: "Laptop", sessions: 2 }],
  coverage: {
    sessions: 2,
    creditSessions: 1,
    tokenSessions: 2,
    openingAiCredits: 0,
    openingTokens: 0,
    unallocatedAiCredits: 0,
    unallocatedTokens: 0,
    regressions: 0,
    lastReportedAt: "2026-10-19T12:00:00Z",
  },
  machines: [{ id: "n1", name: "Laptop" }],
  tasks: [],
  generatedAt: "2026-10-19T12:00:00Z",
};
afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
describe("UsagePage", () => {
  it("shows independent totals, reporting coverage and machine filters", async () => {
    vi.mocked(api).mockResolvedValue(report);
    render(<UsagePage />);
    expect((await screen.findAllByText("300")).length).toBe(2);
    expect(screen.getAllByText("2.5").length).toBe(2);
    fireEvent.change(screen.getByLabelText("Machine"), { target: { value: "n1" } });
    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith(
        expect.stringContaining("nodeId=n1"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });
  it("keeps absent metrics unavailable and Hermes credits not applicable", async () => {
    vi.mocked(api).mockResolvedValue({
      ...report,
      totals: { ...amounts, aiCredits: null },
      rows: [
        {
          ...amounts,
          aiCredits: null,
          backend: "hermes",
          key: "h",
          label: "Hermes lead",
          sessions: 1,
        },
      ],
    });
    render(<UsagePage />);
    await screen.findByText("Hermes lead");
    expect(screen.getByText("N/A")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
  it("rejects reversed custom ranges without issuing a request", () => {
    expect(() =>
      usageQuery({
        period: "custom",
        from: "2026-10-20",
        to: "2026-10-19",
        groupBy: "day",
        nodeId: "",
        taskId: "",
        backend: "",
        role: "",
      }),
    ).toThrow(/date/i);
  });
  it("surfaces a report request failure", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Host unavailable"));
    render(<UsagePage />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Host unavailable",
    );
  });
});
