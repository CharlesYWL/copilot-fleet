import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeSchema,
  type AgentParams,
  type FleetNode,
  type OrchestratorModels,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { OrchestratorPanel } from "./OrchestratorPanel";
import type { ModelDefaultsCardProps } from "./ModelDefaultsCard";

let defaults: {
  model: string;
  reasoningEffort: string;
  orchestratorModels: OrchestratorModels;
  orchestratorReasoningEffort: string;
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

const copilotSessions = [
  {
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        description: "",
        currentValue: "lead-model",
        choices: [{ value: "lead-model", name: "Lead model", description: "" }],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "reasoning_effort",
        description: "",
        currentValue: "medium",
        choices: [{ value: "medium", name: "Medium", description: "" }],
      },
    ],
  },
];
const hermesSessions: ModelDefaultsCardProps["sessions"] = [
  {
    agentParams: { kind: "hermes", profile: "fleet-orchestrator" },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        description: "",
        currentValue: "provider/lead-model",
        choices: [{ value: "provider/lead-model", name: "Lead model", description: "" }],
      },
    ],
  },
];

const show = (
  nodes: FleetNode[] = [hermesNode],
  sessions: ModelDefaultsCardProps["sessions"] = [],
) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <OrchestratorPanel nodes={nodes} sessions={sessions} />
    </FluentProvider>,
  );

beforeEach(() => {
  forgetCsrfToken();
  defaults = {
    model: "worker-model",
    reasoningEffort: "high",
    orchestratorModels: { copilot: "unavailable-lead-model", hermes: "" },
    orchestratorReasoningEffort: "",
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
        defaults = {
          ...defaults,
          ...patch,
          orchestratorModels: {
            ...defaults.orchestratorModels,
            ...patch.orchestratorModels,
          },
        };
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
  it("saves and clears its own model and effort without changing work defaults", async () => {
    const view = show([hermesNode], copilotSessions);
    const model = await screen.findByRole("combobox", { name: "Default Copilot model" });
    expect(model.textContent).toContain("unavailable-lead-model");
    fireEvent.click(model);
    fireEvent.click(screen.getByRole("option", { name: "Lead model" }));
    await waitFor(() => expect(model.textContent).toContain("Lead model"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orchestratorModels: { copilot: "lead-model" } }),
      }),
    );
    const effort = screen.getByRole("combobox", {
      name: "Default Copilot reasoning effort",
    });
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "Medium" }));
    await waitFor(() => expect(effort.textContent).toContain("Medium"));
    expect(defaults.orchestratorReasoningEffort).toBe("medium");
    expect(fetch).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orchestratorReasoningEffort: "medium" }),
      }),
    );
    view.unmount();
    show([hermesNode], copilotSessions);
    expect(
      (await screen.findByRole("combobox", { name: "Default Copilot model" }))
        .textContent,
    ).toContain("Lead model");
    for (const name of ["Default Copilot model", "Default Copilot reasoning effort"]) {
      const picker = screen.getByRole("combobox", { name });
      fireEvent.click(picker);
      fireEvent.click(screen.getByRole("option", { name: "Copilot's choice" }));
      await waitFor(() => expect(picker.textContent).toContain("Copilot's choice"));
    }
    expect(defaults).toMatchObject({
      model: "worker-model",
      reasoningEffort: "high",
      orchestratorModels: { copilot: "", hermes: "" },
      orchestratorReasoningEffort: "",
      orchestratorAgent: null,
      orchestratorHeartbeatSchedule: "0 9-18 * * 1-5; 0 */2 * * *",
    });
  });

  it("does not offer Hermes profile models as Copilot defaults", async () => {
    defaults.orchestratorModels.copilot = "";
    show(
      [hermesNode],
      [
        {
          ...copilotSessions[0]!,
          agentParams: { kind: "hermes", profile: "fleet-orchestrator" },
        },
      ],
    );
    expect(
      (
        await screen.findByRole<HTMLButtonElement>("combobox", {
          name: "Default Copilot model",
        })
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Start a Copilot session to load models.")).toBeTruthy();
  });

  it("keeps identical model names isolated by backend ID and preserves both choices after reload", async () => {
    const sessions = [...copilotSessions, ...hermesSessions];
    const view = show([hermesNode], sessions);
    const copilot = await screen.findByRole("combobox", {
      name: "Default Copilot model",
    });
    const hermes = screen.getByRole("combobox", { name: "Default Hermes model" });
    expect(
      screen.queryByRole("combobox", { name: "Default Hermes reasoning effort" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Hermes model defaults" }).textContent,
    ).toBe("Default Hermes modelHermes profile's choice");
    fireEvent.click(copilot);
    let option = screen.getByRole("option", { name: "Lead model" });
    expect(option.getAttribute("title")).toBe("lead-model");
    fireEvent.click(option);
    await waitFor(() => expect(copilot.textContent).toContain("Lead model"));
    fireEvent.click(hermes);
    option = screen.getByRole("option", { name: "Lead model" });
    expect(option.getAttribute("title")).toBe("provider/lead-model");
    fireEvent.click(option);
    await waitFor(() => expect(hermes.textContent).toContain("Lead model"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/defaults",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orchestratorModels: { hermes: "provider/lead-model" } }),
      }),
    );
    expect(defaults.orchestratorModels).toEqual({
      copilot: "lead-model",
      hermes: "provider/lead-model",
    });
    view.unmount();
    show([], sessions);
    expect(
      (await screen.findByRole("combobox", { name: "Default Copilot model" }))
        .textContent,
    ).toContain("Lead model");
    const reloadedHermes = screen.getByRole("combobox", { name: "Default Hermes model" });
    expect(reloadedHermes.textContent).toContain("Lead model");
    fireEvent.click(reloadedHermes);
    fireEvent.click(screen.getByRole("option", { name: "Hermes profile's choice" }));
    await waitFor(() => expect(defaults.orchestratorModels.hermes).toBe(""));
    expect(defaults.orchestratorModels.copilot).toBe("lead-model");
    expect(defaults.model).toBe("worker-model");
    expect(defaults.reasoningEffort).toBe("high");
  });

  it("allows clearing an unavailable saved backend model without a live catalog", async () => {
    defaults.orchestratorModels.hermes = "unavailable-provider/model";
    show([]);
    const hermes = await screen.findByRole<HTMLButtonElement>("combobox", {
      name: "Default Hermes model",
    });
    expect(hermes.textContent).toContain("unavailable-provider/model");
    expect(screen.getByText("Start a Copilot session to load models.")).toBeTruthy();
    expect(screen.getByText("Start a Hermes session to load models.")).toBeTruthy();
    expect(hermes.disabled).toBe(false);
    fireEvent.click(hermes);
    fireEvent.click(screen.getByRole("option", { name: "Hermes profile's choice" }));
    await waitFor(() => expect(hermes.disabled).toBe(true));
    expect(defaults.orchestratorModels).toEqual({
      copilot: "unavailable-lead-model",
      hermes: "",
    });
  });

  it("keeps the saved model visible when a change fails", async () => {
    show([hermesNode], copilotSessions);
    const model = await screen.findByRole("combobox", { name: "Default Copilot model" });
    vi.mocked(fetch).mockImplementation(async (path) =>
      String(path) === "/api/auth/csrf"
        ? response({ csrfToken: "proof" })
        : response({ error: "Model default could not be saved" }, 503),
    );
    fireEvent.click(model);
    fireEvent.click(screen.getByRole("option", { name: "Lead model" }));
    expect(await screen.findByText("Model default could not be saved")).toBeTruthy();
    expect(model.textContent).toContain("unavailable-lead-model");
    expect(defaults.orchestratorModels.copilot).toBe("unavailable-lead-model");
  });

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
