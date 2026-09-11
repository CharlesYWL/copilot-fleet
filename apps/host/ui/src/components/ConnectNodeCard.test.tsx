import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { ConnectNodeCard } from "./ConnectNodeCard";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const enrollment = {
  hostUrl: "https://fleet-abc.usw2.devtunnels.ms",
  hostId: "host-1",
  hostFingerprint: "b".repeat(64),
  hostPublicKey: "cHVibGlj",
  enrollmentToken: "legacy-fleet-token",
  nodeAuthentication: { total: 1, mutualAuth: 1, legacy: 0 },
  mutualAuthenticationRequired: false,
  tunnelId: "fleet-abc.usw2",
};

const grant = {
  id: "grant-1",
  grant: "grant-1.grant-secret",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  command: {
    hostUrl: "https://fleet-abc.usw2.devtunnels.ms",
    hostId: "host-1",
    hostFingerprint: "b".repeat(64),
    enrollmentGrant: "grant-1.grant-secret",
    tunnelId: "fleet-abc.usw2",
  },
};

const host = (overrides: Record<string, () => Response> = {}) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, respond] of Object.entries(overrides)) {
      const [routeMethod, path] = key.includes(" ") ? key.split(" ") : ["", key];
      if (url.includes(String(path)) && (!routeMethod || routeMethod === method)) {
        return respond();
      }
    }
    if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
    if (url.includes("/api/enrollment-grants") && method === "POST") {
      return answer(grant, 201);
    }
    if (url.includes("/api/enrollment")) return answer(enrollment);
    return answer({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const show = (notify = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <ConnectNodeCard />
      </NotificationContext.Provider>
    </FluentProvider>,
  );

describe("ConnectNodeCard", () => {
  beforeEach(() => {
    forgetCsrfToken();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    forgetCsrfToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mints nothing until an administrator asks for a machine to be added", async () => {
    const fetchMock = host();
    show();

    await screen.findByRole("button", { name: /generate a connect command/i });
    // A grant is a live credential with a fifteen-minute life: creating one on
    // every render would spend them on nobody and fill the audit log.
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/api/enrollment-grants") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("asks the Host for a one-time grant, with the proof the Host demands", async () => {
    const fetchMock = host();
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes("/api/enrollment-grants") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(new Headers((call?.[1] as RequestInit).headers).get("x-csrf-token")).toBe(
        "proof",
      );
    });
  });

  it("prints a command that pins this Host and carries no fleet-wide token", async () => {
    host();
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );

    for (const label of ["npm start command", "npm service command"]) {
      const command = await screen.findByLabelText(label);
      expect(command.textContent).toContain('--host-id="host-1"');
      expect(command.textContent).toContain(`--host-fingerprint="${"b".repeat(64)}"`);
      expect(command.textContent).toContain('--enrollment-grant="grant-1.grant-secret"');
      // Neither launch method should expose the old reusable fleet-wide token.
      expect(command.textContent).not.toContain("legacy-fleet-token");
      expect(command.textContent).not.toContain("--token=");
    }
  });

  it("says when the grant stops working, and offers another", async () => {
    const fetchMock = host();
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );
    await screen.findByLabelText("npm start command");

    expect(screen.getByText(/expires/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /new command/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).includes("/api/enrollment-grants") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toHaveLength(2),
    );
  });

  it.each(["npm start", "npm service"])(
    "copies the %s command as one paste",
    async (label) => {
      host();
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /generate a connect command/i }),
      );
      const command = await screen.findByLabelText(`${label} command`);
      fireEvent.click(screen.getByRole("button", { name: `Copy ${label} command` }));

      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(command.textContent),
      );
    },
  );

  it("copies exactly the displayed command after the Host URL is edited", async () => {
    host();
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );
    const command = await screen.findByLabelText("npm start command");
    fireEvent.change(screen.getByLabelText("Host URL the node should dial"), {
      target: { value: "https://fleet.example.com" },
    });
    expect(command.textContent).toContain('--url="https://fleet.example.com"');
    expect(command.textContent).not.toContain("--devtunnel=");
    fireEvent.click(screen.getByRole("button", { name: "Copy npm start command" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(command.textContent),
    );
  });

  it("shows both launch methods with enabled copy buttons without another selection or grant", async () => {
    const fetchMock = host();
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );
    const direct = await screen.findByLabelText("npm start command");
    const service = screen.getByLabelText("npm service command");
    expect(direct.textContent).toContain("npm run start:node");
    expect(service.textContent).toContain("npm run service -- node");
    expect(service.textContent).toContain('--devtunnel="fleet-abc.usw2"');
    expect(service.textContent).toContain('--enrollment-grant="grant-1.grant-secret"');
    expect(service.textContent).not.toContain("npm run start:node");
    expect(screen.getByRole("heading", { name: "npm run start:node" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "npm run service -- node" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy npm service command" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByText(/you do not need to run both/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy npm service command" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(service.textContent),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/api/enrollment-grants") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(direct.textContent).toContain("npm run start:node");
  });

  it("updates both visible commands after editing a direct Host URL", async () => {
    host();
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );
    await screen.findByLabelText("npm service command");
    fireEvent.change(screen.getByLabelText("Host URL the node should dial"), {
      target: { value: "https://fleet.example.com" },
    });
    const direct = screen.getByLabelText("npm start command");
    const service = screen.getByLabelText("npm service command");
    expect(direct.textContent).toContain(
      'npm run start:node -- --url="https://fleet.example.com"',
    );
    expect(service.textContent).toContain(
      'npm run service -- node --url="https://fleet.example.com"',
    );
    expect(direct.textContent).not.toContain("--devtunnel=");
    expect(service.textContent).not.toContain("--devtunnel=");
    fireEvent.click(screen.getByRole("button", { name: "Copy npm service command" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(service.textContent),
    );
  });
  it("says why a private tunnel needs the machine signed in first", async () => {
    host();
    show();
    expect(await screen.findByText(/devtunnel user login/i)).toBeTruthy();
  });

  it("explains a refusal instead of showing an empty box", async () => {
    host({
      "POST /api/enrollment-grants": () =>
        answer({ error: "Sign in with Microsoft again before adding a machine." }, 403),
    });
    const notify = vi.fn();
    show(notify);

    fireEvent.click(
      await screen.findByRole("button", { name: /generate a connect command/i }),
    );

    expect(
      await screen.findByText(/sign in with microsoft again before adding a machine/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText("npm start command")).toBeNull();
    expect(screen.queryByLabelText("npm service command")).toBeNull();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Sign in with Microsoft again before adding a machine.",
      "error",
    );
    fireEvent.change(screen.getByLabelText("Host URL the node should dial"), {
      target: { value: "http://localhost:8787" },
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
