import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UpdateWorkerRoutingSchema,
  WorkerRoutingSettingsSchema,
  type WorkerRoutingSettings,
} from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { WorkerModelRoutingControl } from "./WorkerModelRoutingControl";
import type { ModelDefaultsCardProps } from "./ModelDefaultsCard";

let saved: WorkerRoutingSettings;
let requests: Array<{ path: string; init: RequestInit }>;
let testFailure: boolean;
let saveConflict: boolean;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const catalog: ModelDefaultsCardProps["sessions"] = [
  {
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        description: "",
        currentValue: "model-a",
        choices: [
          { value: "model-a", name: "Model A", description: "" },
          { value: "provider/Exact.Model-B", name: "Model B", description: "" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Effort",
        category: "thought_level",
        description: "",
        currentValue: "high",
        choices: [
          { value: "medium", name: "Medium", description: "" },
          { value: "high", name: "High", description: "" },
        ],
      },
    ],
  },
  {
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        description: "",
        currentValue: "provider/Exact.Model-B",
        choices: [{ value: "provider/Exact.Model-B", name: "Model B", description: "" }],
      },
      {
        id: "reasoning_effort",
        name: "Effort",
        category: "thought_level",
        description: "",
        currentValue: "low",
        choices: [{ value: "low", name: "Low", description: "" }],
      },
    ],
  },
];

beforeEach(() => {
  forgetCsrfToken();
  requests = [];
  testFailure = false;
  saveConflict = false;
  saved = WorkerRoutingSettingsSchema.parse({
    providers: [
      {
        id: "foundry",
        name: "Foundry primary",
        kind: "foundry",
        endpoint: "https://demo.services.ai.azure.com/providers/microsoft/v1/systemone",
        model: "Exact-Deployment",
        keyConfigured: true,
        ready: false,
      },
    ],
    profiles: [
      {
        id: "ordinary",
        name: "Ordinary",
        description: "Bounded ordinary implementation.",
        categories: ["implement"],
        model: "model-a",
        reasoningEffort: "high",
      },
    ],
    suspended: false,
    proposals: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/auth/csrf") return response({ csrfToken: "proof" });
      requests.push({ path, init });
      if (path.endsWith("/test")) {
        const body = JSON.parse(String(init.body));
        return response({
          success: !testFailure,
          providerId: body.provider.id,
          durationMs: 123,
          returnedModel: testFailure ? undefined : "actual-decision-model",
          usage: null,
          message: testFailure
            ? "Authentication failed. Replace the key and test again."
            : "Connection tested. No worker was started.",
          testToken: testFailure ? undefined : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        });
      }
      if (init.method === "PUT") {
        if (saveConflict)
          return response(
            {
              error: "Routing settings changed. Your edits are still available.",
              code: "stale_revision",
            },
            409,
          );
        const body = UpdateWorkerRoutingSchema.parse(JSON.parse(String(init.body)));
        saved = {
          ...saved,
          ...body,
          revision: saved.revision + 1,
          providers: body.providers.map((draft) => ({
            ...draft.provider,
            keyConfigured: draft.keyAction !== "clear",
            ready:
              Boolean(draft.testToken) ||
              (draft.keyAction === "keep" &&
                Boolean(
                  saved.providers.find((provider) => provider.id === draft.provider.id)
                    ?.ready,
                )),
          })),
        };
      }
      return response(saved);
    }),
  );
});
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

async function show(sessions = catalog) {
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <WorkerModelRoutingControl sessions={sessions} />
    </FluentProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Decision settings" }));
  return screen.findByRole("dialog");
}
const group = (index: number) =>
  screen.getByRole("group", { name: `Decision model ${index}` });

describe("worker routing settings dialog", () => {
  it("requires a connection test for Route, clears a tested password, and saves without echoing it", async () => {
    await show();
    const mode = screen.getByRole("combobox", { name: "Routing mode" });
    fireEvent.click(mode);
    expect(
      screen
        .getByRole("option", { name: "Route new workers" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "Off" }));
    fireEvent.click(within(group(1)).getByRole("combobox", { name: "API key action" }));
    fireEvent.click(screen.getByRole("option", { name: "Replace key" }));
    const key = screen.getByLabelText<HTMLInputElement>("Decision API key");
    expect(key.type).toBe("password");
    fireEvent.change(key, { target: { value: "private-ui-fixture-key" } });
    fireEvent.click(within(group(1)).getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connection tested. No worker was started./);
    expect(key.value).toBe("");
    expect(saved.mode).toBe("off");
    expect(requests.filter((request) => request.init.method === "PUT")).toHaveLength(0);
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole("option", { name: "Route new workers" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(saved.mode).toBe("route"));
    const put = requests.find((request) => request.init.method === "PUT")!;
    expect(String(put.init.body)).not.toContain("private-ui-fixture-key");
    expect(JSON.parse(String(put.init.body)).providers[0]).toMatchObject({
      keyAction: "replace",
      testToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(screen.queryByText("private-ui-fixture-key")).toBeNull();
  });

  it("adds a TypeSafe fallback model, tests it, and reorders the chain", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add decision model" }));
    fireEvent.click(
      within(group(2)).getByRole("combobox", { name: "Decision provider" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "TypeSafe" }));
    expect(
      within(group(2)).getByRole<HTMLInputElement>("textbox", {
        name: "Decision endpoint",
      }).value,
    ).toBe("https://api.typesafe.ai/v1/systemone");
    fireEvent.change(
      within(group(2)).getByRole("textbox", { name: "Decision model name" }),
      { target: { value: "TypeSafe fallback" } },
    );
    fireEvent.change(
      within(group(2)).getByRole("textbox", { name: "Decision deployment or model" }),
      { target: { value: "jev-latest" } },
    );
    fireEvent.change(within(group(2)).getByLabelText("Decision API key"), {
      target: { value: "private-typesafe-fixture-key" },
    });
    fireEvent.click(within(group(2)).getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Connection tested. No worker was started./);
    fireEvent.click(
      screen.getByRole("button", { name: "Move decision model 2 earlier" }),
    );
    expect(group(1).textContent).toContain("TypeSafe fallback");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(saved.providers.map((provider) => provider.kind)).toEqual([
        "typesafe",
        "foundry",
      ]),
    );
    const test = requests.find((request) => request.path.endsWith("/test"))!;
    expect(JSON.parse(String(test.init.body))).toMatchObject({
      provider: {
        kind: "typesafe",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest",
      },
    });
    expect(
      requests.filter((request) => request.path.startsWith("/api/sessions")),
    ).toHaveLength(0);
  });

  it("reports a failed test, clears the typed key, and never enables routing", async () => {
    testFailure = true;
    await show();
    fireEvent.click(within(group(1)).getByRole("combobox", { name: "API key action" }));
    fireEvent.click(screen.getByRole("option", { name: "Replace key" }));
    const key = screen.getByLabelText<HTMLInputElement>("Decision API key");
    fireEvent.change(key, { target: { value: "private-fixture-key" } });
    fireEvent.click(within(group(1)).getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Authentication failed/);
    expect(key.value).toBe("");
    expect(saved.mode).toBe("off");
    expect(requests.some((request) => request.init.method === "PUT")).toBe(false);
  });

  it("preserves exact worker IDs and resets effort when the selected model changes", async () => {
    await show();
    fireEvent.click(screen.getByRole("tab", { name: "Worker profiles" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Profile 1 worker model" }));
    fireEvent.click(screen.getByRole("option", { name: "Model B" }));
    expect(
      screen.getByRole("combobox", { name: "Profile 1 reasoning effort" }).textContent,
    ).toContain("No effort override");
    fireEvent.click(screen.getByRole("combobox", { name: "Profile 1 reasoning effort" }));
    expect(screen.queryByRole("option", { name: "High" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Low" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(saved.profiles[0]).toMatchObject({
        model: "provider/Exact.Model-B",
        reasoningEffort: "low",
      }),
    );
    expect(screen.getByTitle("provider/Exact.Model-B")).toBeDefined();
  });

  it("supports unverified exact IDs with an empty catalog and keeps edits on save conflict", async () => {
    saved = { ...saved, profiles: [] };
    await show([]);
    fireEvent.click(screen.getByRole("tab", { name: "Worker profiles" }));
    expect(screen.getByText(/Start a Copilot session to load models/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add worker profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter exact ID" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Profile 1 exact model ID" }), {
      target: { value: "Provider/Unseen.Model-ID" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Profile 1 description" }), {
      target: { value: "A bounded mechanical change with exact supplied edits." },
    });
    expect(screen.getByText("Unverified")).toBeDefined();
    saveConflict = true;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText(/Routing settings changed/);
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Profile 1 exact model ID" })
        .value,
    ).toBe("Provider/Unseen.Model-ID");
  });

  it("clears keys and unsaved edits when the dialog closes", async () => {
    await show();
    fireEvent.click(within(group(1)).getByRole("combobox", { name: "API key action" }));
    fireEvent.click(screen.getByRole("option", { name: "Replace key" }));
    fireEvent.change(screen.getByLabelText("Decision API key"), {
      target: { value: "private-unsaved-fixture-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Decision settings" }));
    await screen.findByRole("dialog");
    expect(screen.queryByLabelText("Decision API key")).toBeNull();
    expect(
      requests.some(
        (request) => request.init.method === "PUT" || request.path.endsWith("/test"),
      ),
    ).toBe(false);
  });
});
