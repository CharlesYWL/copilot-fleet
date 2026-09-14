import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

const show = (notify = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <DiagnosticsPanel />
      </NotificationContext.Provider>
    </FluentProvider>,
  );

const respondWith = (body: unknown) =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      // `api` reads the body as text and parses it itself, so a stub that only
      // offers json() fails in a way that looks like the panel is broken.
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DiagnosticsPanel", () => {
  it("reports poll failures once until recovery, without replacing inline feedback", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("Logs unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const notify = vi.fn();
    await act(async () => {
      show(notify);
    });
    expect(screen.getByText("Logs unavailable")).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith("Logs unavailable", "error");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(respondWith({ entries: [] }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByText("Logs unavailable")).toBeNull();
    fetchMock.mockRejectedValue(new Error("Logs unavailable"));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("shows normal runtime activity and problems by default, as text rather than HTML", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        entries: [
          {
            at: "2026-08-18T21:04:20.000Z",
            level: "info",
            message: "Host listening <script>alert('log')</script>",
          },
          {
            at: "2026-08-18T21:04:21.000Z",
            level: "warn",
            message: "Node reconnecting",
          },
          {
            at: "2026-08-18T21:04:22.000Z",
            level: "error",
            message: "Node disconnected without its sessions",
          },
        ],
      }),
    );
    show();
    expect(
      await screen.findByText("Node disconnected without its sessions"),
    ).toBeTruthy();
    expect(screen.getByText("Host listening <script>alert('log')</script>")).toBeTruthy();
    expect(screen.getByText("Node reconnecting")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Problems only" }).checked,
    ).toBe(false);
    expect(screen.getByRole("log").querySelector("script")).toBeNull();
  });

  it("shows only the latest 80 matching entries, filtering before taking the tail", async () => {
    const entries = ["warn", "info"].flatMap((level) =>
      Array.from({ length: 100 }, (_, index) => ({
        at: "2026-08-18T21:04:22.000Z",
        level,
        message: `${level} ${index}`,
      })),
    );
    const fetchMock = respondWith({ entries });
    vi.stubGlobal("fetch", fetchMock);
    show();
    const log = await screen.findByRole("log");
    expect(log.children).toHaveLength(80);
    expect(within(log).queryByText("info 19")).toBeNull();
    expect(within(log).getByText("info 20")).toBeTruthy();
    expect(within(log).getByText("info 99")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
    expect(log.children).toHaveLength(80);
    expect(within(log).queryByText("info 99")).toBeNull();
    expect(within(log).queryByText("warn 19")).toBeNull();
    expect(within(log).getByText("warn 20")).toBeTruthy();
    expect(within(log).getByText("warn 99")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
    expect(within(log).getByText("info 99")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains an empty problems filter without losing normal activity", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        entries: [{ at: "", level: "info", message: "Host ready" }],
      }),
    );
    show();
    await screen.findByText("Host ready");
    fireEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
    expect(screen.getByText("No warnings or errors recorded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
    expect(screen.getByText("Host ready")).toBeTruthy();
  });

  it("follows the newest output only while the reader stays pinned to the bottom", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        entries: [{ at: "", level: "info", message: "Host ready" }],
      }),
    );
    show();
    const log = await screen.findByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    log.scrollTop = 900;
    fireEvent.scroll(log);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(log.scrollTop).toBe(1000);

    log.scrollTop = 250;
    fireEvent.scroll(log);
    Object.defineProperty(log, "scrollHeight", { value: 1200 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(log.scrollTop).toBe(250);
  });

  it("says so when there is nothing to report, rather than showing an empty box", async () => {
    vi.stubGlobal("fetch", respondWith({ entries: [] }));
    show();
    expect(await screen.findByText("Nothing logged yet.")).toBeTruthy();
  });

  it("surfaces a failure to read the log instead of looking empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve({ error: "log unavailable" }),
        } as unknown as Response),
      ),
    );
    show();
    await waitFor(() => expect(screen.getByText(/log unavailable/i)).toBeTruthy());
  });
});
