import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { ENABLE_WARNING, LocalAgentCard } from "./LocalAgentCard";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const lead = { id: "lead-1", name: "Release lead", state: "running", nodeName: "devbox" };
const workspace = { id: "ws-1", name: "copilot-fleet", kind: "repository" };

const view = (
  config: Record<string, unknown> = {},
  status: object = { state: "disabled" },
) => ({
  config: {
    enabled: false,
    port: 8786,
    allowedLeadSessionIds: [],
    allowedWorkspaceIds: [],
    revision: 3,
    ...config,
  },
  status,
  hostPort: 8787,
  defaultPort: 8786,
  choices: { orchestrators: [lead], workspaces: [workspace] },
});

/** Serves the card's reads, with per-test answers for its writes. */
const host = (
  reads: { config?: unknown; requests?: unknown[] } = {},
  writes: Record<string, () => Response> = {},
) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/csrf") return answer({ csrfToken: "proof" });
    const write = writes[`${method} ${url}`];
    if (write) return write();
    if (url === "/api/local-agent/config") return answer(reads.config ?? view());
    if (url === "/api/local-agent/requests")
      return answer({ requests: reads.requests ?? [] });
    return answer({ error: `unexpected ${method} ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const show = () => {
  const failures: unknown[] = [];
  const notify = vi.fn();
  // Stands in for SecurityPanel's `run`: it owns turning a refusal into feedback.
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (reason) {
      failures.push(reason);
    }
  };
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <LocalAgentCard run={run} />
      </NotificationContext.Provider>
    </FluentProvider>,
  );
  return { failures, notify };
};

const sent = (fetchMock: ReturnType<typeof host>, method: string, url: string) => {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input) === url && init?.method === method,
  );
  return call
    ? {
        body: JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
        csrf: new Headers(call[1]?.headers).get("x-csrf-token"),
      }
    : undefined;
};

const checkbox = (name: RegExp) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

/**
 * The Settings card for the loopback API a local agent drives orchestrators
 * through. It is a security surface: nothing is exposed until an administrator
 * names it, turning it on says plainly who can then reach it, and abandoning a
 * stuck request shows exactly what will be withdrawn.
 */
describe("LocalAgentCard", () => {
  beforeEach(() => forgetCsrfToken());
  afterEach(() => {
    forgetCsrfToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes nothing by default and turns on only what was chosen, after the warning", async () => {
    const fetchMock = host(
      {},
      {
        "PUT /api/local-agent/config": () =>
          answer(
            view(
              {
                enabled: true,
                allowedLeadSessionIds: [lead.id],
                allowedWorkspaceIds: [],
                revision: 4,
              },
              { state: "listening", url: "http://127.0.0.1:8786" },
            ),
          ),
      },
    );
    const { notify } = show();

    expect(await screen.findByText("Off")).toBeTruthy();
    expect(checkbox(/Release lead/).checked).toBe(false);
    expect(checkbox(/copilot-fleet/).checked).toBe(false);
    expect(screen.queryByText(/x-fleet-local-agent: 1" http/)).toBeNull();

    fireEvent.click(checkbox(/Release lead/));
    fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
    const dialog = await screen.findByRole("dialog", {
      name: /turn on the local agent api/i,
    });
    expect(within(dialog).getByText(ENABLE_WARNING)).toBeTruthy();
    expect(sent(fetchMock, "PUT", "/api/local-agent/config")).toBeUndefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("Listening")).toBeTruthy();
    expect(sent(fetchMock, "PUT", "/api/local-agent/config")).toEqual({
      csrf: "proof",
      body: {
        enabled: true,
        port: 8786,
        allowedLeadSessionIds: [lead.id],
        allowedWorkspaceIds: [],
        expectedRevision: 3,
      },
    });
    expect(notify).toHaveBeenCalledWith("Local agent API saved.", "success");
    expect(
      screen.getByText(
        'curl -H "x-fleet-local-agent: 1" http://127.0.0.1:8786/v1/orchestrators',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/"url": "http:\/\/127\.0\.0\.1:8786\/v1\/mcp"/)).toBeTruthy();
  });

  it("will not offer the Host's own port", async () => {
    host();
    show();
    const port = await screen.findByRole("textbox");
    fireEvent.change(port, { target: { value: "8787" } });
    expect(await screen.findByText(/the Host's own port/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Turn on…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lets a gone orchestrator be dropped, and turns off with the saved scope", async () => {
    const fetchMock = host(
      {
        config: view(
          {
            enabled: true,
            allowedLeadSessionIds: [lead.id, "lead-gone"],
            allowedWorkspaceIds: [workspace.id],
          },
          { state: "listening", url: "http://127.0.0.1:8786" },
        ),
      },
      {
        "PUT /api/local-agent/config": () =>
          answer(view({ revision: 4 }, { state: "disabled" })),
      },
    );
    show();

    const stale = await screen.findByRole("checkbox", { name: /lead-gone/ });
    expect(screen.getByText("Stale")).toBeTruthy();
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(stale);
    expect(save.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Off")).toBeTruthy();
    // Turning off sends what is saved, not the unsaved edit.
    expect(sent(fetchMock, "PUT", "/api/local-agent/config")?.body).toEqual({
      enabled: false,
      port: 8786,
      allowedLeadSessionIds: [lead.id, "lead-gone"],
      allowedWorkspaceIds: [workspace.id],
      expectedRevision: 3,
    });
  });

  it("hands a refusal to the panel, and reloads when someone else saved first", async () => {
    let revision = 3;
    const fetchMock = host(
      {},
      {
        "PUT /api/local-agent/config": () => {
          revision = 9;
          return answer(
            { code: "stale_request", error: "Someone else changed these." },
            409,
          );
        },
        "GET /api/local-agent/config": () => answer(view({ revision })),
      },
    );
    const { failures } = show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(failures).toHaveLength(1));
    expect((failures[0] as Error).message).toBe("Someone else changed these.");
    expect(await screen.findByText(/revision 9/)).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === "/api/local-agent/config"),
    ).toHaveLength(3);
  });

  it("says who may manage it when the Host refuses to show it", async () => {
    host(
      {},
      {
        "GET /api/local-agent/config": () =>
          answer({ error: "Only a Microsoft administrator can do that." }, 403),
      },
    );
    show();
    expect(
      await screen.findByText(
        "Only a Microsoft administrator can manage the local agent API.",
      ),
    ).toBeTruthy();
  });

  it("shows the exact brief an abandon withdraws, and names the version it saw", async () => {
    const owed = {
      operationId: "op-1",
      kind: "create_task",
      state: "waiting_for_brief",
      leadSessionId: lead.id,
      taskId: "task-1",
      clientLabel: "hermes",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      version: 2,
      dispatchEverReserved: false,
      briefDigest: "digest-1",
      workspaceId: workspace.id,
      taskName: "Fix flaky test",
      targetDeleted: false,
      owedPreview: "<fleet-task-brief>Fix the flaky test</fleet-task-brief>",
    };
    const settled = {
      ...owed,
      operationId: "op-2",
      state: "settled",
      taskName: "Done task",
    };
    const fetchMock = host(
      { requests: [owed, settled] },
      {
        "POST /api/local-agent/requests/op-1/disposition": () =>
          answer({ request: { ...owed, state: "abandoned" } }),
      },
    );
    const { notify } = show();

    const table = await screen.findByRole("table", { name: "Local agent requests" });
    expect(within(table).getAllByRole("button", { name: "Abandon…" })).toHaveLength(1);
    fireEvent.click(within(table).getByRole("button", { name: "Abandon…" }));
    const dialog = await screen.findByRole("dialog", { name: /abandon this request/i });
    expect(within(dialog).getByText(owed.owedPreview)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Abandon",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Agent crashed" },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith("Request abandoned.", "success"),
    );
    expect(sent(fetchMock, "POST", "/api/local-agent/requests/op-1/disposition")).toEqual(
      {
        csrf: "proof",
        body: {
          action: "abandon",
          reason: "Agent crashed",
          expectedRequestVersion: 2,
          expectedBriefDigest: "digest-1",
        },
      },
    );
  });
});
