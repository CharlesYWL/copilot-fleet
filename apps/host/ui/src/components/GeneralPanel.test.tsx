import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { GeneralPanel } from "./GeneralPanel";

const response = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(forgetCsrfToken);
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

describe("GeneralPanel", () => {
  it("loads and updates the application lifecycle notification default", async () => {
    let defaults = {
      yolo: false,
      autoResume: true,
      notificationLifecycleEnabled: true,
      model: "",
      reasoningEffort: "",
    };
    const fetchMock = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/api/auth/csrf") return response({ csrfToken: "proof" });
      if (init?.method === "POST") {
        defaults = {
          ...defaults,
          ...(JSON.parse(String(init.body)) as Partial<typeof defaults>),
        };
      }
      return response(defaults);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Lifecycle notifications for top-level agents",
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(/Dependency workers and reviewers remain Off by default/),
    ).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/defaults",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ notificationLifecycleEnabled: false }),
        }),
      ),
    );
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  });

  it("names the fleet archive as data only and points at the portable one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          yolo: false,
          autoResume: false,
          notificationLifecycleEnabled: true,
          model: "",
          reasoningEffort: "",
        }),
      ),
    );

    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );

    const card = await screen.findByRole("region", { name: /fleet data/i });
    expect(within(card).getByText(/does not carry/i)).toBeTruthy();
    expect(within(card).getByText(/settings → security/i)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /export fleet data/i })).toBeTruthy();
  });
});
