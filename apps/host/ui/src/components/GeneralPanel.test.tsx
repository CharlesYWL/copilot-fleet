import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { GeneralPanel } from "./GeneralPanel";
import { NotificationContext } from "../hooks/useAppNotifications";

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
  it("does not mix Hermes model choices into Copilot defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          yolo: false,
          autoResume: true,
          notificationLifecycleEnabled: true,
          model: "",
          reasoningEffort: "",
        }),
      ),
    );
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel
          sessions={[
            {
              agentParams: { kind: "hermes", profile: "fleet-orchestrator" },
              configOptions: [
                {
                  id: "model",
                  name: "Model",
                  category: "model",
                  description: "",
                  currentValue: "hermes-model",
                  choices: [
                    { value: "hermes-model", name: "Hermes model", description: "" },
                  ],
                },
              ],
            },
          ]}
        />
      </FluentProvider>,
    );
    expect(
      (await screen.findByRole<HTMLButtonElement>("combobox", { name: "Default model" }))
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Heartbeat schedule" })).toBeNull();
  });

  it("defaults to long context and saves both context tiers without changing other defaults", async () => {
    let defaults = {
      yolo: false,
      contextTier: "long_context",
      autoResume: true,
      notificationLifecycleEnabled: true,
      model: "",
      reasoningEffort: "",
    };
    const fetchMock = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/api/auth/csrf") return response({ csrfToken: "proof" });
      if (init?.method === "POST") {
        defaults = { ...defaults, ...JSON.parse(String(init.body)) };
      }
      return response(defaults);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );
    const toggle = await screen.findByRole<HTMLInputElement>("switch", {
      name: "Long context by default",
    });
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ contextTier: "default" }),
      }),
    );
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ contextTier: "long_context" }),
      }),
    );
    expect(defaults.yolo).toBe(false);
  });

  it("shows the fleet-wide Agency toggle and saves changes in both directions", async () => {
    let defaults = {
      yolo: false,
      agencyMode: false,
      agencyModeAvailable: true,
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

    const toggle = await screen.findByRole<HTMLInputElement>("switch", {
      name: "Agency mode",
    });
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Staff").getAttribute("title")).toBe(
      "Internal feature for Microsoft corporate accounts",
    );
    expect(getComputedStyle(screen.getByText("Staff")).borderTopWidth).toBe("1px");
    expect(screen.getByText(/Nodes without Agency on PATH fall back/)).toBeTruthy();
    expect(screen.getByText(/Running sessions are not interrupted/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agencyMode: true }),
      }),
    );
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agencyMode: false }),
      }),
    );
  });

  it("keeps the saved Agency preference and surfaces a rejected change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
        if (String(path) === "/api/auth/csrf") return response({ csrfToken: "proof" });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ error: "Settings could not be saved" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return response({
          yolo: false,
          agencyMode: true,
          agencyModeAvailable: true,
          autoResume: true,
          notificationLifecycleEnabled: true,
          model: "",
          reasoningEffort: "",
        });
      }),
    );
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );
    const toggle = await screen.findByRole<HTMLInputElement>("switch", {
      name: "Agency mode",
    });
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await screen.findByText("Settings could not be saved");
    expect(toggle.checked).toBe(true);
  });

  it.each([false, undefined])(
    "hides the entire Agency card when staff eligibility is %s, even if Agency is enabled",
    async (agencyModeAvailable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response({
            yolo: false,
            agencyMode: true,
            agencyModeAvailable,
            autoResume: true,
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
      expect(screen.queryByRole("region", { name: "Agency mode" })).toBeNull();
      await screen.findByRole("heading", { name: "Session defaults" });
      expect(screen.queryByRole("region", { name: "Agency mode" })).toBeNull();
      expect(screen.queryByRole("switch", { name: "Agency mode" })).toBeNull();
      expect(screen.queryByText("Staff")).toBeNull();
      expect(screen.getByText("YOLO mode")).toBeTruthy();
    },
  );

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
    const toggle = screen.getByRole("switch", { name: "YOLO mode" });
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
