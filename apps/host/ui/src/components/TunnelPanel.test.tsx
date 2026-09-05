import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { TunnelInfo, TunnelProviderInfo } from "@fleet/protocol";
import { TunnelPanel } from "./TunnelPanel";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

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

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <TunnelPanel />
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
