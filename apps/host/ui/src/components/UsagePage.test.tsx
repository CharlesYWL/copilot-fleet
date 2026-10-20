import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(
      within(await screen.findByRole("region", { name: "Total tokens" })).getByText(
        "300",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "AI credits" })).getByText("2.5"),
    ).toBeTruthy();
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
  it("uses English report sections and compact numbers with exact accessible values", async () => {
    vi.mocked(api).mockResolvedValue({
      ...report,
      totals: { ...amounts, totalTokens: 100_572_259 },
      rows: [
        {
          ...amounts,
          totalTokens: 100_572_259,
          key: "2026-10-19",
          label: "2026-10-19",
          sessions: 2,
        },
      ],
    });
    render(<UsagePage />);
    expect(await screen.findByRole("heading", { name: "Usage report" })).toBeTruthy();
    const total = await screen.findByRole("region", { name: "Total tokens" });
    const value = within(total).getByText("100.57M");
    expect(value.getAttribute("title")).toBe("100,572,259 tokens");
    expect(value.getAttribute("aria-label")).toBe("100,572,259 tokens");
    expect(screen.getByRole("heading", { name: "Daily usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Reporting scope" })).toBeTruthy();
  });
  it("loads daily totals alongside machine groups using the same filters and dates", async () => {
    sessionStorage.setItem(
      "fleet.usage.filters",
      JSON.stringify({
        period: "custom",
        from: "2026-10-18",
        to: "2026-10-20",
        groupBy: "machine",
        nodeId: "n1",
        taskId: "t1",
        backend: "copilot",
        role: "lead",
      }),
    );
    vi.mocked(api).mockImplementation(async (path) => {
      const query = new URL(String(path), "http://localhost").searchParams;
      if (query.get("groupBy") !== "day") return report;
      return {
        ...report,
        rows: [
          {
            ...amounts,
            totalTokens: 12_345,
            key: "2026-10-19",
            label: "2026-10-19",
            sessions: 1,
          },
          {
            ...amounts,
            totalTokens: 50_000,
            key: "__opening__",
            label: "Opening balances · date unknown",
            sessions: 1,
          },
          {
            ...amounts,
            totalTokens: 25_000,
            key: "__unallocated_time__",
            label: "Intervals spanning multiple days",
            sessions: 1,
          },
        ],
      };
    });
    render(<UsagePage />);
    expect(
      await screen.findByRole("img", { name: "2026-10-19: 12,345 tokens" }),
    ).toBeTruthy();
    expect(screen.getByText("Laptop", { selector: "td" })).toBeTruthy();
    expect(screen.getByText(/opening balances/).textContent).toContain("50.00K tokens");
    expect(screen.getByText(/spanning multiple days/).textContent).toContain(
      "25.00K tokens",
    );
    expect(screen.queryByRole("img", { name: /Opening balances/ })).toBeNull();
    const queries = vi
      .mocked(api)
      .mock.calls.map(([path]) => new URL(String(path), "http://localhost").searchParams);
    expect(queries).toHaveLength(2);
    expect(queries.map((query) => query.get("groupBy")).sort()).toEqual([
      "day",
      "machine",
    ]);
    for (const key of ["from", "to", "timeZone", "nodeId", "taskId", "backend", "role"]) {
      expect(queries[0]!.get(key)).toBeTruthy();
      expect(queries[0]!.get(key)).toBe(queries[1]!.get(key));
    }
  });
  it("keeps overlapping token details independent rather than inventing composition shares", async () => {
    vi.mocked(api).mockResolvedValue({
      ...report,
      totals: {
        ...amounts,
        totalTokens: 1_000,
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 800,
        reasoningTokens: 50,
      },
    });
    render(<UsagePage />);
    const details = await screen.findByRole("region", { name: "Token details" });
    expect(within(details).getByText("Cache read")).toBeTruthy();
    expect(within(details).getByText("800")).toBeTruthy();
    expect(within(details).getByText(/can overlap/)).toBeTruthy();
    expect(within(details).queryByText(/%/)).toBeNull();
  });
  it("shows daily readings as unavailable rather than zero when only credits exist", async () => {
    vi.mocked(api).mockResolvedValue({
      ...report,
      rows: [
        {
          ...amounts,
          totalTokens: null,
          key: "2026-10-19",
          label: "2026-10-19",
          sessions: 1,
        },
      ],
    });
    render(<UsagePage />);
    expect(
      await screen.findByRole("img", { name: "2026-10-19: token reading unavailable" }),
    ).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("refreshes cumulative readings every five seconds and stops polling on unmount", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockResolvedValue(report);
      let view: ReturnType<typeof render>;
      await act(async () => {
        view = render(<UsagePage />);
      });
      expect(api).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(api).toHaveBeenCalledTimes(2);
      view!.unmount();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(api).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores stale responses after a filter change", async () => {
    let finishOldRequest!: (value: UsageReport) => void;
    vi.mocked(api)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRequest = resolve;
          }),
      )
      .mockResolvedValue(report);
    render(<UsagePage />);
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "all" } });
    await screen.findByRole("region", { name: "Total tokens" });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finishOldRequest({ ...report, totals: { ...amounts, totalTokens: 999_000 } });
    });
    expect(screen.queryByText("999.00K")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Total tokens" })).getByText("300"),
    ).toBeTruthy();
  });
  it("retains the last successful report and identifies it when a live refresh fails", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api)
        .mockResolvedValueOnce(report)
        .mockRejectedValue(new Error("Host unavailable"));
      let view: ReturnType<typeof render>;
      await act(async () => {
        view = render(<UsagePage />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("alert").textContent).toContain(
        "showing the last successful report",
      );
      expect(
        within(screen.getByRole("region", { name: "Total tokens" })).getByText("300"),
      ).toBeTruthy();
      view!.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("shows all recorded Copilot history after a confirmed legacy import", async () => {
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path === "/api/usage/backfill")
        return options?.method === "POST"
          ? {
              importedConversations: 1,
              aiCredits: 100,
              backupFile: "usage-backfill-test.db",
            }
          : {
              previewId: "a".repeat(64),
              eligibleConversations: 1,
              eligibleSessions: 1,
              aiCredits: 100,
              skipped: {
                active: 0,
                otherBackend: 0,
                missingIdentity: 0,
                missingCredits: 0,
                conflicting: 0,
                alreadyRecorded: 0,
              },
            };
      return report;
    });
    render(<UsagePage />);
    await screen.findByRole("region", { name: "Total tokens" });
    fireEvent.click(screen.getByRole("button", { name: "Backfill old credits" }));
    const confirm = await screen.findByRole("button", { name: "Import credits" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => {
      const paths = vi
        .mocked(api)
        .mock.calls.map(([path]) => path)
        .filter((path) => path.startsWith("/api/usage?"));
      const query = new URL(paths.at(-1)!, "http://localhost").searchParams;
      expect(query.get("backend")).toBe("copilot");
      expect(query.has("from")).toBe(false);
      expect(query.has("to")).toBe(false);
    });
  });
  it("explains excluded legacy Hermes counters and partial coverage until Nodes refresh", async () => {
    vi.mocked(api).mockResolvedValue({
      ...report,
      coverage: { ...report.coverage, legacyHermesSessions: 2, pendingHermesSessions: 1 },
    });
    render(<UsagePage />);
    const notice = await screen.findByText(
      /2 Hermes sessions have incompatible legacy readings/,
    );
    expect(notice.textContent).toContain("excluded");
    expect(notice.textContent).toContain("undated opening balances");
    expect(screen.getByText(/1 session has no corrected native reading/)).toBeTruthy();
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
