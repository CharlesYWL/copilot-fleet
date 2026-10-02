import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelPolicyKind, TunnelProvider } from "@fleet/protocol";
import type { ExternalTunnel } from "./external-tunnel.js";
import { FleetStore } from "./store.js";
import { BinaryProbe, TunnelSupervisor } from "./tunnel.js";
import {
  describeTunnelPolicy,
  ineligibleProviderMessage,
  resolveTunnelPolicyKind,
  tunnelProviderAllowed,
} from "./tunnel-policy.js";
import { providerList, providerSpecs } from "./tunnel-providers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const stores: FleetStore[] = [];
const supervisors: TunnelSupervisor[] = [];
const children: { binary: string; child: ChildProcess }[] = [];

beforeEach(() => {
  vi.spyOn(providerSpecs.devtunnel, "prepare");
  vi.mocked(providerSpecs.devtunnel.prepare!).mockResolvedValue(undefined);
  vi.mocked(spawn).mockImplementation((binary) => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    children.push({ binary: String(binary), child });
    return child;
  });
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  for (const store of stores.splice(0)) store.close();
  children.length = 0;
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

function host(policy: () => TunnelPolicyKind, external?: () => ExternalTunnel) {
  const store = new FleetStore(":memory:");
  stores.push(store);
  const supervisor = new TunnelSupervisor({
    policy,
    localTarget: "http://127.0.0.1:8787",
    readExternal: external ?? (() => undefined),
    probe: new BinaryProbe(async () => true),
    persistedTunnelId: {
      get: (provider) => store.getSetting(`tunnel.${provider}.id`),
      set: (provider, value) => store.setSetting(`tunnel.${provider}.id`, value),
    },
    onEnabledCleared: (provider) => store.setTunnelProviderEnabled(provider, false),
  });
  supervisors.push(supervisor);
  return { store, supervisor };
}

const childOf = (binary: string) =>
  children.find((entry) => entry.binary === binary)!.child;

function publish(binary: string, text: string) {
  childOf(binary).stdout?.emit("data", Buffer.from(text));
}

const CLOUDFLARE_URL = "https://quick-fleet.trycloudflare.com";
const DEVTUNNEL_URL = "https://demo-8787.usw2.devtunnels.ms";

describe("tunnel policy rules", () => {
  it("lets no-auth win over corp, and corp over open", () => {
    expect(resolveTunnelPolicyKind({ noAuth: false, microsoftCorp: false })).toBe("open");
    expect(resolveTunnelPolicyKind({ noAuth: false, microsoftCorp: true })).toBe(
      "microsoft-corp",
    );
    expect(resolveTunnelPolicyKind({ noAuth: true, microsoftCorp: false })).toBe(
      "private-only",
    );
    // Not reachable today (no-auth needs zero administrators), but a corp route
    // without its own login must never stand in front of an open console.
    expect(resolveTunnelPolicyKind({ noAuth: true, microsoftCorp: true })).toBe(
      "private-only",
    );
  });

  it("offers only Microsoft-approved providers to a corp Host", () => {
    expect(describeTunnelPolicy("microsoft-corp")).toEqual({
      kind: "microsoft-corp",
      allowedProviders: ["devtunnel"],
    });
    for (const provider of ["cloudflare", "tailscale", "ngrok", "bore"] as const) {
      expect(tunnelProviderAllowed("microsoft-corp", provider)).toBe(false);
    }
  });

  it("offers every HTTPS provider to anybody else", () => {
    expect(describeTunnelPolicy("open").allowedProviders).toEqual(
      providerList.filter((spec) => spec.controlPlaneEligible).map((spec) => spec.id),
    );
    expect(describeTunnelPolicy("open").allowedProviders).toContain("cloudflare");
    expect(tunnelProviderAllowed("open", "bore")).toBe(false);
  });

  it("makes corp approval opt-in, so an unflagged provider stays refused", () => {
    const approved = providerList
      .filter((spec) => spec.microsoftCorpApproved)
      .map((spec) => spec.id);
    expect(approved).toEqual(["devtunnel"]);
  });

  it("explains a corp refusal in terms of the account and the approved option", () => {
    const message = ineligibleProviderMessage("cloudflare", "microsoft-corp");
    expect(message).toMatch(/Cloudflare is not approved for Microsoft corporate use/);
    expect(message).toContain("@microsoft.com");
    expect(message).toContain("Dev Tunnels");
    // Plain HTTP stays the reason for bore whatever the policy.
    expect(ineligibleProviderMessage("bore", "microsoft-corp")).toMatch(/plain HTTP/);
  });
});

describe("a Host administered by a Microsoft corporate account", () => {
  it("refuses public providers and publishes the policy in its tunnel info", async () => {
    const { supervisor, store } = host(() => "microsoft-corp");
    for (const provider of ["cloudflare", "ngrok", "tailscale"] as const) {
      await expect(supervisor.setEnabled(provider, true)).rejects.toThrow(
        /not approved for Microsoft corporate use/,
      );
      expect(store.getEnabledTunnelProviders()).not.toContain(provider);
    }
    expect(spawn).not.toHaveBeenCalled();

    const info = await supervisor.info("http://127.0.0.1:8787");
    expect(info.policy).toEqual({
      kind: "microsoft-corp",
      allowedProviders: ["devtunnel"],
    });
    expect(
      info.providers.filter((spec) => spec.controlPlaneEligible).map((spec) => spec.id),
    ).toEqual(["devtunnel"]);
  });

  it("still runs Dev Tunnels", async () => {
    const { supervisor } = host(() => "microsoft-corp");
    await supervisor.setEnabled("devtunnel", true);
    publish("devtunnel", `Connect via browser: ${DEVTUNNEL_URL}\n`);
    expect(supervisor.activeTunnelUrl()).toBe(DEVTUNNEL_URL);
  });

  it("will not adopt a public tunnel started in another terminal", async () => {
    const { supervisor } = host(
      () => "microsoft-corp",
      () => ({ provider: "cloudflare", url: CLOUDFLARE_URL, tunnelId: undefined }),
    );
    const info = await supervisor.info("http://127.0.0.1:8787");
    expect(info.tunnels.find((state) => state.provider === "cloudflare")).toMatchObject({
      status: "error",
      enabled: false,
      external: true,
      error: expect.stringMatching(/not approved for Microsoft corporate use/),
    });
    expect(supervisor.allTunnelUrls()).toEqual([]);
    // Not this Host's process to kill.
    expect(await supervisor.enforcePolicy()).toEqual([]);
  });

  it("stops a public tunnel that was running before a corp account took over", async () => {
    let kind: TunnelPolicyKind = "open";
    const { supervisor, store } = host(() => kind);
    for (const provider of ["devtunnel", "cloudflare"] as TunnelProvider[]) {
      store.setTunnelProviderEnabled(provider, true);
      await supervisor.setEnabled(provider, true);
    }
    publish("devtunnel", `Connect via browser: ${DEVTUNNEL_URL}\n`);
    publish("cloudflared", `Your quick Tunnel: ${CLOUDFLARE_URL}\n`);
    expect(supervisor.activeTunnelUrl()).toBe(CLOUDFLARE_URL);

    kind = "microsoft-corp";
    // Untrusted at once, before anything reaps the process.
    expect(supervisor.allTunnelUrls()).toEqual([DEVTUNNEL_URL]);
    expect(supervisor.activeTunnelUrl()).toBe(DEVTUNNEL_URL);

    expect(await supervisor.enforcePolicy()).toEqual(["cloudflare"]);
    expect(childOf("cloudflared").kill).toHaveBeenCalledWith("SIGTERM");
    expect(childOf("devtunnel").kill).not.toHaveBeenCalled();
    expect(store.getEnabledTunnelProviders()).toEqual(["devtunnel"]);
    const info = await supervisor.info("http://127.0.0.1:8787");
    expect(info.primary).toBe("devtunnel");
    expect(info.tunnels.find((state) => state.provider === "cloudflare")).toMatchObject({
      enabled: false,
      status: "error",
      error: expect.stringMatching(/not approved for Microsoft corporate use/),
    });
    // Nothing left to do on the next pass.
    expect(await supervisor.enforcePolicy()).toEqual([]);
  });
});
