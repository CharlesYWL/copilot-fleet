import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("persists explicit choices through the Host and restores inheritance", async () => {
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
      if (init?.method === "DELETE") stored = inherited();
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
          onReset={preference.reset}
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
    });
    fireEvent.click(inheritedButton);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "On for this agent" }));

    await screen.findByRole("button", {
      name: "Lifecycle notifications: On for this agent",
    });
    expect(requestMock).toHaveBeenCalledWith(
      "/api/notifications/preferences/worker-1",
      expect.objectContaining({ method: "PUT" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Lifecycle notifications: On for this agent",
      }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Off for this agent" }));
    await screen.findByRole("button", {
      name: "Lifecycle notifications: Off for this agent",
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
    });
    fireEvent.click(explicitButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Use inherited default" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Lifecycle notifications: Off by default for dependency agents",
        }),
      ).toBeTruthy(),
    );
    expect(requestMock).toHaveBeenCalledWith(
      "/api/notifications/preferences/worker-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
