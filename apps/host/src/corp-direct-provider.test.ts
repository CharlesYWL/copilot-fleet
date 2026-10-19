import { describe, expect, it, vi } from "vitest";
import { BinaryProbe, TunnelSupervisor } from "./tunnel.js";
import { tunnelProviderAllowed } from "./tunnel-policy.js";
import type { TunnelPolicyKind } from "@fleet/protocol";

const fixture = (external?: { provider: "devtunnel"; url: string; tunnelId: string }) => {
  let kind: TunnelPolicyKind = "microsoft-corp";
  let url: string | undefined;
  let error: string | undefined;
  const start = vi.fn(async () => {
    error = undefined;
    url = "https://10.0.5.136:8787";
    return url;
  });
  const stop = vi.fn(async () => {
    url = undefined;
  });
  const cleared = vi.fn();
  const timers: (() => void)[] = [];
  const supervisor = new TunnelSupervisor({
    localTarget: "http://127.0.0.1:8787",
    policy: () => kind,
    builtIn: {
      "corp-direct": {
        start,
        stop,
        activeUrl: () => url,
        supported: () => true,
        error: () => error,
      },
    },
    readExternal: () => external,
    probe: new BinaryProbe(async () => false),
    setTimer: (callback) => {
      timers.push(callback);
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {},
    onEnabledCleared: cleared,
  });
  return {
    supervisor,
    start,
    stop,
    cleared,
    timers,
    failListener: () => {
      url = undefined;
      error = "Corp direct could not renew its certificate.";
    },
    setKind: (next: TunnelPolicyKind) => {
      kind = next;
    },
  };
};

describe("built-in corporate private access provider", () => {
  it("is permitted only under verified corporate policy", () => {
    expect(tunnelProviderAllowed("microsoft-corp", "corp-direct")).toBe(true);
    expect(tunnelProviderAllowed("open", "corp-direct")).toBe(false);
    expect(tunnelProviderAllowed("private-only", "corp-direct")).toBe(false);
  });

  it("starts an in-process endpoint, advertises it for enrollment but never broadcasts it without trust", async () => {
    const f = fixture();
    try {
      await f.supervisor.setEnabled("corp-direct", true);
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.supervisor.activeTunnelUrl()).toBe("https://10.0.5.136:8787");
      expect(f.supervisor.broadcastTunnelUrl()).toBeUndefined();
      expect(f.supervisor.allTunnelEndpoints()).toContainEqual({
        provider: "corp-direct",
        url: "https://10.0.5.136:8787",
      });
    } finally {
      await f.supervisor.stop();
    }
    expect(f.stop).toHaveBeenCalled();
    expect(f.supervisor.activeTunnelUrl()).toBeUndefined();
  });

  it("lists independent corporate enrollment endpoints without changing the default", async () => {
    const f = fixture({
      provider: "devtunnel",
      url: "https://fleet-route.usw2.devtunnels.ms",
      tunnelId: "fleet-route.usw2",
    });
    try {
      await f.supervisor.setEnabled("corp-direct", true);
      expect(f.supervisor.enrollmentEndpoints()).toEqual([
        {
          provider: "devtunnel",
          url: "https://fleet-route.usw2.devtunnels.ms",
          tunnelId: "fleet-route.usw2",
        },
        { provider: "corp-direct", url: "https://10.0.5.136:8787" },
      ]);
      expect(f.supervisor.primary).toBe("corp-direct");
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.stop).not.toHaveBeenCalled();
      await f.supervisor.setEnabled("corp-direct", false);
      expect(f.supervisor.enrollmentEndpoints()).toEqual([
        {
          provider: "devtunnel",
          url: "https://fleet-route.usw2.devtunnels.ms",
          tunnelId: "fleet-route.usw2",
        },
      ]);
    } finally {
      await f.supervisor.stop();
    }
  });

  it("immediately stops trusting the URL and closes it when corporate policy is lost", async () => {
    const f = fixture();
    await f.supervisor.setEnabled("corp-direct", true);
    f.setKind("open");
    expect(f.supervisor.activeTunnelUrl()).toBeUndefined();
    expect(await f.supervisor.enforcePolicy()).toEqual(["corp-direct"]);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.cleared).toHaveBeenCalledWith("corp-direct");
    await f.supervisor.stop();
  });

  it("serializes a new enable request behind an in-flight private listener stop", async () => {
    const f = fixture();
    await f.supervisor.setEnabled("corp-direct", true);
    let finishStop: () => void = () => {};
    f.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const stopping = f.supervisor.setEnabled("corp-direct", false);
    const starting = f.supervisor.setEnabled("corp-direct", true);
    finishStop();
    await Promise.all([stopping, starting]);
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.supervisor.activeTunnelUrl()).toBe("https://10.0.5.136:8787");
    await f.supervisor.stop();
  });

  it("restarts a listener that failed after it had already come online", async () => {
    const f = fixture();
    try {
      await f.supervisor.setEnabled("corp-direct", true);
      f.failListener();
      expect((await f.supervisor.info("http://127.0.0.1:8787")).tunnels).toContainEqual(
        expect.objectContaining({ provider: "corp-direct", status: "error" }),
      );
      await f.supervisor.setEnabled("corp-direct", true);
      expect(f.start).toHaveBeenCalledTimes(2);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.supervisor.activeTunnelUrl()).toBe("https://10.0.5.136:8787");
    } finally {
      await f.supervisor.stop();
    }
  });

  it("retains a recoverable desired state after a port/start failure", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new Error("address/port is already in use"));
    await expect(f.supervisor.setEnabled("corp-direct", true)).rejects.toThrow(
      /already in use/,
    );
    expect(f.timers).toHaveLength(1);
    expect(f.cleared).not.toHaveBeenCalled();
    await f.supervisor.setEnabled("corp-direct", true);
    expect(f.supervisor.activeTunnelUrl()).toBe("https://10.0.5.136:8787");
    await f.supervisor.stop();
  });
});
