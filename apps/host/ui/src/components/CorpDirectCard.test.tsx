import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import type { CorpDirectInfo, TunnelState } from "@fleet/protocol";
import { CorpDirectCard } from "./CorpDirectCard";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

const info: CorpDirectInfo = {
  supported: true,
  addresses: ["10.0.5.136"],
  configuration: null,
};
const state: TunnelState = {
  provider: "corp-direct",
  enabled: false,
  status: "off",
  error: null,
  external: false,
};
const show = (overrides: Partial<Parameters<typeof CorpDirectCard>[0]> = {}) => {
  const setEnabled = vi.fn(async () => undefined);
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={vi.fn()}>
        <CorpDirectCard
          info={info}
          state={state}
          isPrimary={false}
          busy={false}
          onSetEnabled={setEnabled}
          {...overrides}
        />
      </NotificationContext.Provider>
    </FluentProvider>,
  );
  return setEnabled;
};

afterEach(() => vi.restoreAllMocks());
describe("Corp direct settings", () => {
  it("uses the detected private IP and port 8787 but requires explicit worker sources", async () => {
    const setEnabled = show();
    expect(screen.getByLabelText("Host private IPv4 address")).toHaveProperty(
      "value",
      "10.0.5.136",
    );
    expect(screen.getByLabelText("Corp direct HTTPS port")).toHaveProperty(
      "value",
      "8787",
    );
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await screen.findByText(/add at least one allowed worker/i)).toBeTruthy();
  });

  it("validates and submits an explicit private source scope", async () => {
    const setEnabled = show();
    fireEvent.change(screen.getByLabelText("Allowed worker IPs or CIDRs"), {
      target: { value: "10.0.18.236, 10.0.20.0/24" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith(
        true,
        {
          hostIp: "10.0.5.136",
          port: 8787,
          allowedSources: ["10.0.18.236", "10.0.20.0/24"],
        },
        true,
      ),
    );
  });

  it("refuses public addresses and broad source ranges", async () => {
    const setEnabled = show();
    fireEvent.change(screen.getByLabelText("Allowed worker IPs or CIDRs"), {
      target: { value: "0.0.0.0/0" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await screen.findByText(/entirely within RFC1918/i)).toBeTruthy();
  });

  it("shows the live endpoint and one-time Host firewall instructions", () => {
    show({
      info: {
        ...info,
        configuration: {
          hostIp: "10.0.5.136",
          port: 8787,
          allowedSources: ["10.0.18.236"],
        },
        firewallCommand: "New-NetFirewallRule -LocalPort 8787",
      },
      state: { ...state, enabled: true, status: "on", url: "https://10.0.5.136:8787" },
      isPrimary: true,
    });
    expect(screen.getByText("https://10.0.5.136:8787")).toBeTruthy();
    expect(screen.getByText(/New-NetFirewallRule/)).toBeTruthy();
    expect(screen.getByText(/Administrator PowerShell/i)).toBeTruthy();
    expect(screen.getByLabelText("Host private IPv4 address")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Used for enrollment")).toBeTruthy();
  });

  it("can disable the listener without resubmitting configuration", async () => {
    const setEnabled = show({
      state: { ...state, enabled: true, status: "on", url: "https://10.0.5.136:8787" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  });

  it("disables activation when native certificate support is unavailable", () => {
    show({ info: { ...info, supported: false } });
    expect(screen.getByRole("switch", { name: /corp direct/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/requires Windows/i)).toBeTruthy();
  });
});
