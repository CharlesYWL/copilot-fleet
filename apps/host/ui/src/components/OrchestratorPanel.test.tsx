import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSchema, type AgentParams, type FleetNode } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { OrchestratorPanel } from "./OrchestratorPanel";

let defaults: {
  orchestratorAgent: AgentParams | null;
  orchestratorHeartbeatSchedule: string;
  orchestratorHeartbeatTimeZone: string;
  orchestratorHeartbeatUpcoming: string[];
};

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const hermesNode = NodeSchema.parse({
  id: "n1",
  name: "Hermes box",
  os: "linux",
  arch: "x64",
  version: "test",
  capabilities: ["copilot-acp", "agent-kinds"],
  agentKinds: [{ kind: "copilot" }, { kind: "hermes" }],
  maxSessions: 2,
  activeSessions: 0,
  lastHeartbeat: "2026-09-28T00:00:00.000Z",
  online: true,
});

const show = (nodes: FleetNode[] = [hermesNode]) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <OrchestratorPanel nodes={nodes} />
    </FluentProvider>,
  );

beforeEach(() => {
  forgetCsrfToken();
  defaults = {
    orchestratorAgent: null,
    orchestratorHeartbeatSchedule: "0 9-18 * * 1-5; 0 */2 * * *",
    orchestratorHeartbeatTimeZone: "Asia/Shanghai",
    orchestratorHeartbeatUpcoming: ["2026-09-25T03:00:00.000Z"],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "proof" });
      if (init?.method === "POST") {
        const patch = JSON.parse(String(init.body)) as Partial<typeof defaults>;
        defaults = { ...defaults, ...patch };
        if (patch.orchestratorHeartbeatSchedule)
          defaults.orchestratorHeartbeatSchedule = patch.orchestratorHeartbeatSchedule
            .trim()
            .split(/\s+/)
            .join(" ");
      }
      return response(defaults);
    }),
  );
});

afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

describe("OrchestratorPanel", () => {
  it("saves a detected agent and validated profile together, without changing the heartbeat", async () => {
    show();
    const dropdown = await screen.findByRole("combobox", { name: "Preferred agent" });
    expect(dropdown.textContent).toContain("Auto (Copilot)");
    fireEvent.click(dropdown);
    fireEvent.click(screen.getByRole("option", { name: "Hermes" }));
    expect(screen.getByText(/Detected on online Nodes: Hermes box/)).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Hermes profile",
    });
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save agent" });
    expect(input.value).toBe("fleet-orchestrator");
    fireEvent.change(input, { target: { value: "../personal" } });
    expect(save.disabled).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Copy Hermes setup commands" }),
    ).toBeNull();
    fireEvent.change(input, { target: { value: "fleet-blue" } });
    expect(screen.getByText(/hermes -p fleet-blue acp --setup/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(defaults.orchestratorAgent).toEqual({
        kind: "hermes",
        profile: "fleet-blue",
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          orchestratorAgent: { kind: "hermes", profile: "fleet-blue" },
        }),
      }),
    );
    expect(defaults.orchestratorHeartbeatSchedule).toBe("0 9-18 * * 1-5; 0 */2 * * *");
  });

  it("does not advertise undetected kinds, but preserves an unavailable saved preference", async () => {
    const view = show([]);
    fireEvent.click(await screen.findByRole("combobox", { name: "Preferred agent" }));
    expect(screen.queryByRole("option", { name: "Hermes" })).toBeNull();
    view.unmount();
    defaults.orchestratorAgent = { kind: "hermes", profile: "saved-profile" };
    show([]);
    expect(
      (await screen.findByRole<HTMLInputElement>("textbox", { name: "Hermes profile" }))
        .value,
    ).toBe("saved-profile");
    expect(screen.getByText(/No online Node reports this agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Preferred agent" }));
    fireEvent.click(screen.getByRole("option", { name: "Auto (Copilot)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(defaults.orchestratorAgent).toBeNull());
  });

  it("keeps a failed save visible and preserves the profile draft", async () => {
    show();
    fireEvent.click(await screen.findByRole("combobox", { name: "Preferred agent" }));
    fireEvent.click(screen.getByRole("option", { name: "Hermes" }));
    vi.mocked(fetch).mockImplementation(async (path) =>
      String(path) === "/api/auth/csrf"
        ? response({ csrfToken: "proof" })
        : response({ error: "Settings could not be saved" }, 503),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save agent" }));
    expect(await screen.findByText("Settings could not be saved")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Hermes profile" }).value,
    ).toBe("fleet-orchestrator");
    expect(defaults.orchestratorAgent).toBeNull();
  });

  it("validates and saves the heartbeat in the Host's time zone", async () => {
    show();
    const card = await screen.findByRole("region", { name: "Orchestrator heartbeat" });
    const input = within(card).getByRole<HTMLInputElement>("textbox", {
      name: "Heartbeat schedule",
    });
    const save = within(card).getByRole<HTMLButtonElement>("button", {
      name: "Save schedule",
    });
    expect(within(card).getByText(/Asia\/Shanghai/)).toBeTruthy();
    expect(within(card).getByText(/^Next: /)).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "0 25 * * *" } });
    expect(within(card).getByText('"25" is not a valid hour (0-23).')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: " 0  8-20 * * * " } });
    expect(within(card).getByText("Not saved yet.")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(input.value).toBe("0 8-20 * * *"));
    expect(save.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orchestratorHeartbeatSchedule: " 0  8-20 * * * " }),
      }),
    );
  });
});
