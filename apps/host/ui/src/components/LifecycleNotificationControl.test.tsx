import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveNotificationPreference } from "../hooks/useNotificationPreference";
import {
  useNotificationPreference,
  type FleetRequest,
} from "../hooks/useNotificationPreference";
import type { ApiResult } from "../hooks/useFleet";
import { fleetDarkTheme } from "../theme";
import {
  LifecycleNotificationControl,
  lifecyclePreferenceLabel,
} from "./LifecycleNotificationControl";

const inherited = (
  overrides: Partial<EffectiveNotificationPreference> = {},
): EffectiveNotificationPreference => ({
  sessionId: "worker-1",
  agentId: "agent-1",
  runRole: "worker",
  lifecycleEnabled: false,
  source: "role",
  explicitOverride: null,
  roleDefault: false,
  applicationDefault: true,
  ...overrides,
});

describe("lifecyclePreferenceLabel", () => {
  it("distinguishes role, application, and explicit values", () => {
    expect(lifecyclePreferenceLabel(inherited())).toBe(
      "Off by default for dependency agents",
    );
    expect(
      lifecyclePreferenceLabel(
        inherited({
          runRole: "lead",
          lifecycleEnabled: true,
          source: "application",
          roleDefault: null,
        }),
      ),
    ).toBe("On from application default");
    expect(
      lifecyclePreferenceLabel(
        inherited({
          lifecycleEnabled: true,
          source: "explicit",
          explicitOverride: true,
        }),
      ),
    ).toBe("On for this agent");
  });
});

describe("LifecycleNotificationControl", () => {
  it("toggles notifications with an icon-only button and persists the choice", async () => {
    let stored = inherited();
    const requestMock = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          lifecycleEnabled: boolean;
        };
        stored = inherited({
          lifecycleEnabled: body.lifecycleEnabled,
          source: "explicit",
          explicitOverride: body.lifecycleEnabled,
        });
      }
      return { ok: true as const, data: stored };
    });
    const request: FleetRequest = async <T,>(path: string, init?: RequestInit) =>
      (await requestMock(path, init)) as ApiResult<T>;

    const Harness = () => {
      const preference = useNotificationPreference("worker-1", request);
      return (
        <LifecycleNotificationControl
          preference={preference.preference}
          loading={preference.loading}
          onSet={preference.setLifecycleEnabled}
        />
      );
    };

    const rendered = render(
      <FluentProvider theme={fleetDarkTheme}>
        <Harness />
      </FluentProvider>,
    );
    const inheritedButton = await screen.findByRole("button", {
      name: "Lifecycle notifications: Off by default for dependency agents",
      pressed: false,
    });
    expect(inheritedButton.textContent).toBe("");
    expect(inheritedButton.querySelector(".fui-AlertOff20Regular")).not.toBeNull();
    expect(inheritedButton.title).toBe(
      "Lifecycle notifications: Off by default for dependency agents",
    );
    fireEvent.click(inheritedButton);

    const enabledButton = await screen.findByRole("button", {
      name: "Lifecycle notifications: On for this agent",
      pressed: true,
    });
    expect(enabledButton.textContent).toBe("");
    expect(enabledButton.querySelector(".fui-Alert20Regular")).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(requestMock).toHaveBeenCalledWith(
      "/api/notifications/preferences/worker-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ lifecycleEnabled: true }),
      }),
    );
    fireEvent.click(enabledButton);
    await screen.findByRole("button", {
      name: "Lifecycle notifications: Off for this agent",
      pressed: false,
    });
    expect(requestMock).toHaveBeenLastCalledWith(
      "/api/notifications/preferences/worker-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ lifecycleEnabled: false }),
      }),
    );

    rendered.unmount();
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <Harness />
      </FluentProvider>,
    );
    const explicitButton = await screen.findByRole("button", {
      name: "Lifecycle notifications: Off for this agent",
      pressed: false,
    });
    expect(explicitButton.textContent).toBe("");
    expect(explicitButton.querySelector(".fui-AlertOff20Regular")).not.toBeNull();
  });
});
