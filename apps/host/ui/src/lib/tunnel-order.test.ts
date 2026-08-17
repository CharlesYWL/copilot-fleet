import { describe, expect, it } from "vitest";
import type { TunnelProvider, TunnelProviderInfo, TunnelState } from "@fleet/protocol";
import { orderTunnelProviders } from "./tunnel-order";

const spec = (id: TunnelProvider, binaryPresent: boolean): TunnelProviderInfo => ({
  id,
  label: id,
  binary: id,
  binaryPresent,
  installHint: "",
});

const state = (
  provider: TunnelProvider,
  overrides: Partial<TunnelState> = {},
): TunnelState => ({
  provider,
  enabled: false,
  status: "off",
  error: null,
  external: false,
  ...overrides,
});

const ids = (providers: TunnelProviderInfo[]) => providers.map((entry) => entry.id);

describe("orderTunnelProviders", () => {
  it("puts what is running above what is merely installed", () => {
    const providers = [spec("cloudflare", true), spec("devtunnel", true)];
    const states = new Map([["devtunnel", state("devtunnel", { status: "on" })]]);
    expect(ids(orderTunnelProviders(providers, (id) => states.get(id)))).toEqual([
      "devtunnel",
      "cloudflare",
    ]);
  });

  it("sinks providers whose CLI is missing to the bottom", () => {
    const providers = [spec("ngrok", false), spec("cloudflare", true)];
    expect(ids(orderTunnelProviders(providers, () => undefined))).toEqual([
      "cloudflare",
      "ngrok",
    ]);
  });

  it("orders active, then installed, then not installed", () => {
    const providers = [
      spec("cloudflare", true),
      spec("tailscale", false),
      spec("devtunnel", true),
    ];
    const states = new Map([["devtunnel", state("devtunnel", { status: "on" })]]);
    expect(ids(orderTunnelProviders(providers, (id) => states.get(id)))).toEqual([
      "devtunnel",
      "cloudflare",
      "tailscale",
    ]);
  });

  /**
   * A tunnel the operator switched on is the row most likely to need attention,
   * so a failure or a slow start must not rank below an idle provider that
   * merely happens to be installed.
   */
  it("keeps a starting or failed-but-enabled tunnel at the top", () => {
    const providers = [spec("cloudflare", true), spec("devtunnel", true)];
    const starting = new Map([
      ["devtunnel", state("devtunnel", { status: "starting", enabled: true })],
    ]);
    expect(ids(orderTunnelProviders(providers, (id) => starting.get(id)))).toEqual([
      "devtunnel",
      "cloudflare",
    ]);

    const failed = new Map([
      ["devtunnel", state("devtunnel", { status: "error", enabled: true })],
    ]);
    expect(ids(orderTunnelProviders(providers, (id) => failed.get(id)))).toEqual([
      "devtunnel",
      "cloudflare",
    ]);
  });

  /**
   * The panel re-renders on a 2s poll, so equal-ranked cards have to stay put —
   * a comparator that reorders ties makes them jump under the cursor.
   */
  it("is stable within a band, so cards do not jump between polls", () => {
    const providers = [
      spec("cloudflare", true),
      spec("tailscale", true),
      spec("ngrok", true),
    ];
    const once = ids(orderTunnelProviders(providers, () => undefined));
    const twice = ids(orderTunnelProviders(providers, () => undefined));
    expect(once).toEqual(["cloudflare", "tailscale", "ngrok"]);
    expect(twice).toEqual(once);
  });

  it("does not mutate the array it was handed", () => {
    const providers = [spec("ngrok", false), spec("cloudflare", true)];
    orderTunnelProviders(providers, () => undefined);
    expect(ids(providers)).toEqual(["ngrok", "cloudflare"]);
  });
});
