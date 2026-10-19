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
  it("enables the detected private IP and port 8787 without worker source configuration", async () => {
    const setEnabled = show();
    expect(screen.getByLabelText("Host private IPv4 address")).toHaveProperty(
      "value",
      "10.0.5.136",
    );
    expect(screen.getByLabelText("Corp direct HTTPS port")).toHaveProperty(
      "value",
      "8787",
    );
    expect(screen.queryByLabelText("Allowed worker IPs or CIDRs")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith(
        true,
        { hostIp: "10.0.5.136", port: 8787 },
        true,
      ),
    );
  });

  it("validates the private Host address before enabling", async () => {
    const setEnabled = show();
    fireEvent.change(screen.getByLabelText("Host private IPv4 address"), {
      target: { value: "8.8.8.8" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await screen.findByText(/RFC1918 private IPv4/i)).toBeTruthy();
  });

  it("rejects an invalid HTTPS port before enabling", async () => {
    const setEnabled = show();
    fireEvent.change(screen.getByLabelText("Corp direct HTTPS port"), {
      target: { value: "65536" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /corp direct/i }));
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await screen.findByText(/65535/)).toBeTruthy();
  });

  it("shows the live endpoint and one-time Host firewall instructions", () => {
    show({
      info: {
        ...info,
        configuration: {
          hostIp: "10.0.5.136",
          port: 8787,
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
    expect(screen.getByText("Default for enrollment")).toBeTruthy();
    expect(screen.getByText(/cross-region.*not guaranteed/i)).toBeTruthy();
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
