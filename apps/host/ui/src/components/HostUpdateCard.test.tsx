import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus } from "@fleet/protocol";
import { fleetDarkTheme } from "../theme";
import { forgetCsrfToken } from "../lib/auth";
import { HostUpdateCard } from "./HostUpdateCard";
import { GeneralPanel } from "./GeneralPanel";

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(forgetCsrfToken);
afterEach(() => {
  forgetCsrfToken();
  vi.unstubAllGlobals();
});

const ready: HostUpdateStatus = {
  launch: "dev",
  restartCommand: "npm run dev",
  unavailableReason: "",
};

function card(status: HostUpdateStatus, revision = "abc123def456") {
  return render(
    <FluentProvider theme={fleetDarkTheme}>
      <HostUpdateCard status={status} revision={revision} />
    </FluentProvider>,
  );
}

/** Answers the CSRF lookup, then hands each update request to `answer`. */
function stubUpdates(answer: (body: { stopSessions: boolean }) => Promise<Response>) {
  const fetchMock = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
    if (String(path) === "/api/auth/csrf") return json({ csrfToken: "proof" });
    if (String(path) === "/api/host/update" && init?.method === "POST") {
      return answer(JSON.parse(String(init.body)) as { stopSessions: boolean });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("HostUpdateCard", () => {
  it("names the commit and how the Host comes back, and asks before restarting it", async () => {
    const fetchMock = stubUpdates(() => json({ started: true, status: ready }));
    card(ready);
    const region = screen.getByRole("region", { name: "Update Host" });
    expect(within(region).getByText("abc123def456")).toBeTruthy();
    expect(within(region).getByText("npm run dev")).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "Update Host" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Update and restart the Host?",
    });
    expect(within(dialog).getByText(/uncommitted changes stop the update/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/host/update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ stopSessions: false }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Update and restart the Host?" }),
      ).toBeNull(),
    );
  });

  it("offers to stop the local Node's sessions the Host named, and stops only those", async () => {
    const fetchMock = stubUpdates((body) =>
      body.stopSessions
        ? json({ started: true, status: ready })
        : json(
            {
              error: "This machine's Node is running 1 session(s)",
              blockedBy: [
                {
                  id: "session-1",
                  name: "Refactor the parser",
                  initialPrompt: "",
                  workspaceName: "copilot-fleet",
                  state: "running",
                },
              ],
            },
            409,
          ),
    );
    card(ready);
    fireEvent.click(screen.getByRole("button", { name: "Update Host" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Update" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/host/update",
        expect.objectContaining({ body: JSON.stringify({ stopSessions: false }) }),
      ),
    );

    const blocked = await screen.findByRole("dialog", { name: /Stop 1 session\(s\)/ });
    expect(within(blocked).getByText("Refactor the parser")).toBeTruthy();
    fireEvent.click(within(blocked).getByRole("button", { name: "Stop and update" }));
    // The sessions shown travel with the consent, so one started since is
    // named in a fresh refusal instead of being stopped unseen.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/host/update",
        expect.objectContaining({
          body: JSON.stringify({ stopSessions: true, sessionIds: ["session-1"] }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows why the Host refused to start", async () => {
    stubUpdates(() =>
      json({ error: "Could not start the update: the launcher is not reachable" }, 502),
    );
    card(ready);
    fireEvent.click(screen.getByRole("button", { name: "Update Host" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Update" }),
    );
    expect(
      await screen.findByText(
        "Could not start the update: the launcher is not reachable",
      ),
    ).toBeTruthy();
  });

  it("follows an update in flight and cannot start a second one", () => {
    card({
      ...ready,
      update: {
        updateId: "u-1",
        stage: "building",
        detail: "npm run build",
        revision: "",
        updatedAt: "2026-09-24T08:00:00.000Z",
      },
    });
    const button = screen.getByRole("button", { name: "Building…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("npm run build");
  });

  it("keeps the last result on the card after it has finished", () => {
    card({
      ...ready,
      update: {
        updateId: "u-1",
        stage: "failed",
        detail: "npm run build: TS2345",
        revision: "",
        updatedAt: "2026-09-24T08:00:00.000Z",
      },
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Last update: Update failed",
    );
    expect(screen.getByRole("status").textContent).toContain("npm run build: TS2345");
    expect(
      (screen.getByRole("button", { name: "Update Host" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("explains a Host that cannot update itself instead of offering the button", () => {
    card({
      launch: "manual",
      restartCommand: "",
      unavailableReason: "This Host was not started with npm run dev",
    });
    expect(
      (screen.getByRole("button", { name: "Update Host" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("This Host was not started with npm run dev")).toBeTruthy();
  });
});

describe("GeneralPanel", () => {
  const defaults = {
    yolo: false,
    autoResume: true,
    notificationLifecycleEnabled: true,
    model: "",
    reasoningEffort: "",
  };

  it("carries the Host update card when the Host reports one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(defaults)),
    );
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} hostUpdate={ready} hostRevision="abc123def456" />
      </FluentProvider>,
    );
    expect(await screen.findByRole("region", { name: "Update Host" })).toBeTruthy();
  });

  it("leaves it out for a Host that predates it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(defaults)),
    );
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );
    await screen.findByRole("heading", { name: "Session defaults" });
    expect(screen.queryByRole("region", { name: "Update Host" })).toBeNull();
  });
});
