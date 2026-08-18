import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { fleetDarkTheme } from "../theme";

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <DiagnosticsPanel />
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
});

describe("DiagnosticsPanel", () => {
  it("shows the problems the Host has logged", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith({
        entries: [
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
  });

  it("says so when there is nothing to report, rather than showing an empty box", async () => {
    // An empty frame reads as "this is broken"; the absence of warnings is
    // itself the answer to the question being asked.
    vi.stubGlobal("fetch", respondWith({ entries: [] }));
    show();
    expect(await screen.findByText(/has not warned about anything/i)).toBeTruthy();
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
