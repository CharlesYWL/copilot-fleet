import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { GeneralPanel } from "./GeneralPanel";
import { NotificationContext } from "../hooks/useAppNotifications";
import { degradedDriBackup } from "@fleet/protocol";

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
  it("warns that a downloaded Host backup has degraded DRI coverage", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:fixture"),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input) === "/api/backup"
          ? response({ dri: degradedDriBackup() })
          : response({
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
    fireEvent.click(await screen.findByRole("button", { name: /export/i }));
    expect(await screen.findByText(/DRI backup is incomplete/)).toBeTruthy();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });
  it("keeps the YOLO explanation inline without notifying on load or setting changes", async () => {
    let defaults = {
      yolo: true,
      autoResume: false,
      notificationLifecycleEnabled: true,
      model: "",
      reasoningEffort: "",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
        if (String(path) === "/api/auth/csrf") return response({ csrfToken: "proof" });
        if (init?.method === "POST") {
          defaults = {
            ...defaults,
            ...(JSON.parse(String(init.body)) as typeof defaults),
          };
        }
        return response(defaults);
      }),
    );
    const notify = vi.fn();
    const panel = () => (
      <FluentProvider theme={fleetDarkTheme}>
        <NotificationContext.Provider value={notify}>
          <GeneralPanel sessions={[]} />
        </NotificationContext.Provider>
      </FluentProvider>
    );
    const view = render(panel());
    const warning = /New sessions will execute commands on their node without approval/;
    expect(await screen.findByText(warning)).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
    view.rerender(panel());
    expect(notify).not.toHaveBeenCalled();
    const toggle = screen.getAllByRole("switch")[0]!;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText(warning)).toBeNull());
    fireEvent.click(toggle);
    await screen.findByText(warning);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports loading errors once and keeps the inline explanation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Defaults unavailable")));
    const notify = vi.fn();
    const panel = (
      <FluentProvider theme={fleetDarkTheme}>
        <NotificationContext.Provider value={notify}>
          <GeneralPanel sessions={[]} />
        </NotificationContext.Provider>
      </FluentProvider>
    );
    const view = render(panel);
    expect(await screen.findByText("Defaults unavailable")).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith("Defaults unavailable", "error");
    view.rerender(panel);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Defaults unavailable")).toBeTruthy();
  });

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
