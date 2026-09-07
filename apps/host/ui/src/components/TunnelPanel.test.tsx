import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { TunnelInfo, TunnelProviderInfo } from "@fleet/protocol";
import { TunnelPanel } from "./TunnelPanel";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

const spec = (
  id: TunnelProviderInfo["id"],
  overrides: Partial<TunnelProviderInfo> = {},
): TunnelProviderInfo => ({
  id,
  label: id,
  binary: id,
  binaryPresent: true,
  installHint: "",
  setupSteps: [],
  externalScheme: "https",
  access: "public",
  controlPlaneEligible: true,
  ...overrides,
});

const info: TunnelInfo = {
  primary: "devtunnel",
  publicUrl: "https://fleet-abc.usw2.devtunnels.ms",
  providers: [
    spec("devtunnel", { label: "Dev Tunnels", access: "creator-private" }),
    spec("cloudflare", { label: "Cloudflare" }),
    spec("bore", {
      label: "bore",
      externalScheme: "http",
      controlPlaneEligible: false,
    }),
  ],
  tunnels: [
    {
      provider: "devtunnel",
      enabled: true,
      status: "on",
      url: "https://fleet-abc.usw2.devtunnels.ms",
      error: null,
      external: false,
    },
  ],
};

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const show = (notify = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <TunnelPanel />
      </NotificationContext.Provider>
    </FluentProvider>,
  );

describe("TunnelPanel policy", () => {
  beforeEach(() => {
    forgetCsrfToken();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    forgetCsrfToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports provider failures with context once across unchanged polls", async () => {
    vi.useFakeTimers();
    const broken: TunnelInfo = {
      ...info,
      tunnels: [
        {
          ...info.tunnels[0]!,
          status: "error",
          error: "Tunnel process exited",
        },
      ],
    };
    const fetchMock = vi.fn(async () => answer(broken));
    vi.stubGlobal("fetch", fetchMock);
    const notify = vi.fn();
    await act(async () => {
      show(notify);
    });
    expect(screen.getByText("Tunnel process exited")).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Dev Tunnels: Tunnel process exited",
      "error",
    );
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("reports a missing CLI once across polls without promoting setup help", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          ...info,
          providers: [
            spec("devtunnel", {
              label: "Dev Tunnels",
              binaryPresent: false,
              installHint: "Install devtunnel, then run devtunnel user login.",
              setupSteps: ["Static setup instructions"],
            }),
          ],
          tunnels: [],
        }),
      ),
    );
    const notify = vi.fn();
    await act(async () => {
      show(notify);
    });
    expect(screen.getByText(/Not installed/)).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Dev Tunnels: devtunnel is not installed. Install devtunnel, then run devtunnel user login.",
      "warning",
    );
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("captures an operational login refusal without emitting generic provider advice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          ...info,
          tunnels: [
            {
              ...info.tunnels[0]!,
              status: "error",
              error: "Sign in with devtunnel user login before hosting.",
            },
          ],
        }),
      ),
    );
    const notify = vi.fn();
    show(notify);
    expect(
      await screen.findByText("Sign in with devtunnel user login before hosting."),
    ).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Dev Tunnels: Sign in with devtunnel user login before hosting.",
      "error",
    );
  });

  it("reports refresh failures once, retains the last snapshot, and permits recovery", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => answer(info));
    vi.stubGlobal("fetch", fetchMock);
    const notify = vi.fn();
    await act(async () => {
      show(notify);
    });
    expect(notify).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error("Host unreachable"));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(screen.getByRole("region", { name: "Dev Tunnels" })).toBeTruthy();
    expect(
      screen.getByText("Could not refresh tunnel status: Host unreachable"),
    ).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Could not refresh tunnel status: Host unreachable",
      "error",
    );
    fetchMock.mockImplementation(async () => answer(info));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(
      screen.queryByText("Could not refresh tunnel status: Host unreachable"),
    ).toBeNull();
    fetchMock.mockRejectedValue(new Error("Host unreachable"));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("shows an initial refresh failure instead of an endless loading spinner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Host unreachable")));
    const notify = vi.fn();
    show(notify);
    expect(
      await screen.findByText("Could not refresh tunnel status: Host unreachable"),
    ).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Could not refresh tunnel status: Host unreachable",
      "error",
    );
  });

  it("reports a refused action only once, not from both the hook and panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).includes("/api/auth/csrf"))
          return answer({ csrfToken: "proof" });
        return init?.method === "POST"
          ? answer({ error: "Tunnel change refused" }, 403)
          : answer(info);
      }),
    );
    const notify = vi.fn();
    show(notify);
    const card = await screen.findByRole("region", { name: "Dev Tunnels" });
    fireEvent.click(within(card).getByRole("switch"));
    expect(await screen.findByText("Tunnel change refused")).toBeTruthy();
    expect(notify).toHaveBeenCalledExactlyOnceWith("Tunnel change refused", "error");
  });

  it("reports a rejected URL copy without an unhandled promise or copied value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(info)),
    );
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error(info.publicUrl));
    const notify = vi.fn();
    show(notify);
    const card = await screen.findByRole("region", { name: "Dev Tunnels" });
    await act(async () =>
      fireEvent.click(within(card).getByRole("button", { name: "Copy" })),
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Could not copy to the clipboard.",
      "error",
    );
    expect(within(card).queryByText("Copied")).toBeNull();
  });

  it("will not offer to expose the console over a provider with no TLS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(info)),
    );
    show();

    const bore = await screen.findByRole("region", { name: "bore" });
    const toggle = within(bore).getByRole("switch");
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(within(bore).getByText(/plain HTTP|no TLS|not encrypted/i)).toBeTruthy();
  });

  it("marks the private provider as the recommended one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(info)),
    );
    show();

    const devtunnel = await screen.findByRole("region", { name: "Dev Tunnels" });
    expect(within(devtunnel).getByText(/recommended/i)).toBeTruthy();
    expect(within(devtunnel).getByText(/private/i)).toBeTruthy();
  });

  it("warns that a public provider puts the sign-in page on the internet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(info)),
    );
    show();

    const cloudflare = await screen.findByRole("region", { name: "Cloudflare" });
    expect(
      within(cloudflare).getByText(/anyone with the URL reaches the sign-in page/i),
    ).toBeTruthy();
  });
});
