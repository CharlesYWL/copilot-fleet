import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { SecurityPanel } from "./SecurityPanel";
import { browserNavigation, forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import { NotificationContext } from "../hooks/useAppNotifications";
import { ERASE_AUTH_CONFIRMATION } from "@fleet/protocol";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const alice = {
  id: "admin-alice",
  tenantId: "tenant-1",
  objectId: "alice-oid",
  username: "alice@example.com",
  displayName: "Alice",
  addedVia: "claim",
  addedByAdminId: "",
  createdAt: "2026-08-01T10:00:00.000Z",
  lastLoginAt: "2026-08-28T09:00:00.000Z",
  disabledAt: "",
};
const bob = {
  ...alice,
  id: "admin-bob",
  objectId: "bob-oid",
  username: "bob@example.com",
  displayName: "Bob",
  addedVia: "invitation",
};

const defaults: Record<string, unknown> = {
  "/api/auth/status": {
    state: "hybrid",
    authenticated: true,
    passwordEnabled: true,
    entraConfigured: true,
    deviceFlowEnabled: false,
    claimCodeRequired: false,
    canSignIn: true,
    codeLogin: { available: true, localForwardRequired: false },
    identity: { username: "alice@example.com", displayName: "Alice" },
    entra: { tenantId: "tenant-1", clientId: "client-1" },
  },
  "/api/auth/administrators": {
    currentAdministratorId: alice.id,
    administrators: [alice, bob],
    pending: [],
  },
  "/api/security/audit": {
    events: [
      {
        id: "audit-1",
        eventType: "fleet_claimed",
        actorKind: "administrator",
        actorId: "admin-alice",
        targetId: "",
        requestHost: "loopback",
        tunnelProvider: "",
        outcome: "allowed",
        detail: "",
        createdAt: "2026-08-01T10:00:00.000Z",
      },
    ],
  },
  "/api/enrollment": {
    hostUrl: "http://localhost:8787",
    hostId: "host-1",
    hostFingerprint: "a".repeat(64),
    hostPublicKey: "cHVibGlj",
    nodeAuthentication: { total: 3, mutualAuth: 2, legacy: 1 },
    mutualAuthenticationRequired: false,
  },
  "/api/auth/csrf": { csrfToken: "proof" },
};

/** Serves the panel's reads, with per-test overrides for the writes. */
const host = (
  overrides: Record<string, () => Response> = {},
  reads: Record<string, unknown> = {},
) => {
  const bodies = { ...defaults, ...reads };
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, respond] of Object.entries(overrides)) {
      const [routeMethod, path] = key.includes(" ") ? key.split(" ") : ["", key];
      if (url.includes(String(path)) && (!routeMethod || routeMethod === method)) {
        return respond();
      }
    }
    for (const [path, body] of Object.entries(bodies)) {
      if (url.includes(path)) return answer(body);
    }
    return answer({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const show = (notify = vi.fn()) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <NotificationContext.Provider value={notify}>
        <SecurityPanel />
      </NotificationContext.Provider>
    </FluentProvider>,
  );

describe("SecurityPanel", () => {
  describe("erase auth settings", () => {
    const openErase = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /^erase auth settings$/i }),
      );
      return screen.findByRole("dialog", { name: /erase all host authentication/i });
    };

    it("places the reset at the bottom and requires exact confirmation before submitting", async () => {
      const fetchMock = host();
      show();
      const card = await screen.findByRole("region", { name: "Erase auth settings" });
      expect(card.parentElement?.querySelector(":scope > section:last-of-type")).toBe(
        card,
      );
      const dialog = await openErase();
      expect(
        within(dialog).getByText(/must have access to the host console/i),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(/node processes and connections stay running/i),
      ).toBeTruthy();
      const submit = await within(dialog).findByRole("button", {
        name: /erase and sign out/i,
      });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: "erase auth" },
      });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: ERASE_AUTH_CONFIRMATION },
      });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/erase"),
      ).toBe(false);
    });

    it("cancels without erasing and clears confirmation before another attempt", async () => {
      const fetchMock = host();
      show();
      const dialog = await openErase();
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: ERASE_AUTH_CONFIRMATION },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/erase"),
      ).toBe(false);
      const reopened = await openErase();
      expect(
        (
          within(reopened).getByLabelText(
            /type erase auth to confirm/i,
          ) as HTMLInputElement
        ).value,
      ).toBe("");
    });

    it("erases with CSRF, then returns to setup without reloading protected data", async () => {
      const fetchMock = host();
      show();
      const dialog = await openErase();
      const reads = fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/auth/administrators",
      ).length;
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: ERASE_AUTH_CONFIRMATION },
      });
      fireEvent.click(
        await within(dialog).findByRole("button", { name: /erase and sign out/i }),
      );
      await waitFor(() => expect(browserNavigation.assign).toHaveBeenCalledWith("/"));
      const request = fetchMock.mock.calls.find(
        ([url]) => String(url) === "/api/auth/erase",
      );
      expect(request?.[1]?.method).toBe("POST");
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        confirmation: ERASE_AUTH_CONFIRMATION,
      });
      expect(new Headers(request?.[1]?.headers).get("x-csrf-token")).toBe("proof");
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => String(url) === "/api/auth/administrators",
        ),
      ).toHaveLength(reads);
    });

    it("offers fresh Microsoft confirmation without erasing or navigating on a stale session", async () => {
      host({
        "POST /api/auth/erase": () =>
          answer(
            {
              error: "Sign in with Microsoft again to confirm this change.",
              reauthRequired: true,
            },
            403,
          ),
      });
      show();
      const dialog = await openErase();
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: ERASE_AUTH_CONFIRMATION },
      });
      fireEvent.click(
        await within(dialog).findByRole("button", { name: /erase and sign out/i }),
      );
      expect(
        await screen.findByRole("button", { name: /confirm with microsoft/i }),
      ).toBeTruthy();
      expect(browserNavigation.assign).not.toHaveBeenCalled();
    });

    it("shows a refused reset and leaves the current settings in place", async () => {
      host({
        "POST /api/auth/erase": () =>
          answer({ error: "Another process is using this Host database." }, 409),
      });
      show();
      const dialog = await openErase();
      fireEvent.change(within(dialog).getByLabelText(/type erase auth to confirm/i), {
        target: { value: ERASE_AUTH_CONFIRMATION },
      });
      fireEvent.click(
        await within(dialog).findByRole("button", { name: /erase and sign out/i }),
      );
      expect(
        await screen.findByText("Another process is using this Host database."),
      ).toBeTruthy();
      expect(browserNavigation.assign).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: /^close$/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByText("client-1")).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: /^erase auth settings$/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
  });

  it("reports a security settings failure while retaining the inline error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Security unavailable")));
    const notify = vi.fn();
    show(notify);
    expect(await screen.findByText("Security unavailable")).toBeTruthy();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith("Security unavailable", "error"),
    );
  });

  it("reports legacy Node authentication as an operational warning", async () => {
    host();
    const notify = vi.fn();
    show(notify);
    expect(await screen.findByText(/1 Node still authenticate/i)).toBeTruthy();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("1 Node still authenticate with a shared secret."),
      "warning",
    );
    expect(
      notify.mock.calls.filter(([message]) =>
        String(message).includes("1 Node still authenticate with a shared secret."),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["entra-unconfigured", "No Microsoft sign-in is configured on this Host."],
    ["legacy-password", "Password sign-in only."],
    ["hybrid", "Password sign-in is still enabled alongside Microsoft accounts."],
    ["recovery", "A temporary recovery password is enabled from the Host console."],
  ])(
    "reports the %s authentication warning without repeating it for dialog changes",
    async (state, message) => {
      host(
        {},
        {
          "/api/auth/status": {
            ...(defaults["/api/auth/status"] as Record<string, unknown>),
            state,
          },
          "/api/enrollment": {
            ...(defaults["/api/enrollment"] as Record<string, unknown>),
            nodeAuthentication: { total: 3, mutualAuth: 3, legacy: 0 },
          },
        },
      );
      const notify = vi.fn();
      show(notify);
      const button = await screen.findByRole("button", {
        name: /disable password sign-in/i,
      });
      await waitFor(() =>
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(message),
          "warning",
        ),
      );
      expect(
        screen.getAllByText((text) => text.includes(message)).length,
      ).toBeGreaterThan(0);
      fireEvent.click(button);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(notify).toHaveBeenCalledTimes(1);
    },
  );

  it("does not notify for Microsoft-only authentication or static help", async () => {
    host(
      {},
      {
        "/api/auth/status": {
          ...(defaults["/api/auth/status"] as Record<string, unknown>),
          state: "microsoft-only",
          passwordEnabled: false,
        },
        "/api/enrollment": {
          ...(defaults["/api/enrollment"] as Record<string, unknown>),
          nodeAuthentication: { total: 3, mutualAuth: 3, legacy: 0 },
        },
      },
    );
    const notify = vi.fn();
    show(notify);
    await screen.findByText(/Microsoft accounts only/);
    expect(notify).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    forgetCsrfToken();
    vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
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

  it("says who is signed in, how, and against which registration", async () => {
    host();
    show();

    const card = await screen.findByRole("region", { name: /^this host$/i });
    expect(within(card).getByText("alice@example.com")).toBeTruthy();
    // The mode is the thing an operator is trying to change, so it is named
    // rather than implied by which buttons happen to be enabled.
    expect(within(card).getByText(/password sign-in is still enabled/i)).toBeTruthy();
    expect(within(card).getByText("tenant-1")).toBeTruthy();
    expect(within(card).getByText("client-1")).toBeTruthy();
    expect(within(card).getByText("Accounts in one fixed directory")).toBeTruthy();
    expect(within(card).getByText("Directory (tenant) ID")).toBeTruthy();
  });

  describe("Microsoft sign-in configuration", () => {
    const clientId = "22222222-2222-4222-8222-222222222222";
    const authorizationUrl = "https://login.microsoftonline.com/common/authorize?new";
    const edit = async (tenantId = "common") => {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /change microsoft sign-in configuration/i,
        }),
      );
      fireEvent.click(
        screen.getByRole("radio", {
          name:
            tenantId === "common"
              ? "Work/school and personal Microsoft accounts"
              : "One organization (fixed directory)",
        }),
      );
      if (tenantId !== "common") {
        fireEvent.change(screen.getByLabelText(/directory \(tenant\) id/i), {
          target: { value: tenantId },
        });
      }
      fireEvent.change(screen.getByLabelText(/application \(client\) id/i), {
        target: { value: clientId },
      });
      return screen.getByRole("button", {
        name: /verify new configuration with microsoft/i,
      }) as HTMLButtonElement;
    };

    it("shows public account support without presenting common as a directory ID", async () => {
      host(
        {},
        {
          "/api/auth/status": {
            ...(defaults["/api/auth/status"] as object),
            entra: { tenantId: "common", clientId },
          },
        },
      );
      show();

      const card = await screen.findByRole("region", { name: /^this host$/i });
      expect(within(card).getByText("Supported accounts")).toBeTruthy();
      expect(
        within(card).getByText("Work/school and personal Microsoft accounts"),
      ).toBeTruthy();
      expect(within(card).queryByText("Directory (tenant) ID")).toBeNull();
      expect(within(card).queryByText("common")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: /change microsoft sign-in configuration/i }),
      );
      expect(
        (
          screen.getByRole("radio", {
            name: "Work/school and personal Microsoft accounts",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true);
      expect(screen.queryByLabelText(/directory \(tenant\) id/i)).toBeNull();
    });

    it("initializes the editor from an existing fixed-directory configuration", async () => {
      host();
      show();
      fireEvent.click(
        await screen.findByRole("button", {
          name: /change microsoft sign-in configuration/i,
        }),
      );

      expect(
        (
          screen.getByRole("radio", {
            name: "One organization (fixed directory)",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true);
      expect(
        (screen.getByLabelText(/directory \(tenant\) id/i) as HTMLInputElement).value,
      ).toBe("tenant-1");
      expect(
        (screen.getByLabelText(/application \(client\) id/i) as HTMLInputElement).value,
      ).toBe("client-1");
      expect(screen.getByText(/current configuration stays active/i)).toBeTruthy();
      expect(
        screen.getByText(/successful switch signs out other sessions/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/narrowing to a fixed directory can prevent administrators/i),
      ).toBeTruthy();
      expect(screen.getByText(/never merges accounts by email/i)).toBeTruthy();
    });

    it.each(["common", "11111111-1111-4111-8111-111111111111"])(
      "starts a verified switch to %s with CSRF and follows the returned URL",
      async (tenantId) => {
        const fetchMock = host({
          "POST /api/auth/configuration/start": () => answer({ authorizationUrl }),
        });
        show();

        const submit = await edit(tenantId);
        fireEvent.click(submit);
        expect(submit.disabled).toBe(true);
        fireEvent.click(submit);
        await waitFor(() =>
          expect(browserNavigation.assign).toHaveBeenCalledExactlyOnceWith(
            authorizationUrl,
          ),
        );
        const starts = fetchMock.mock.calls.filter(
          ([url]) => String(url) === "/api/auth/configuration/start",
        );
        expect(starts).toHaveLength(1);
        const request = starts[0]?.[1];
        expect(request?.method).toBe("POST");
        expect(JSON.parse(String(request?.body))).toEqual({ tenantId, clientId });
        expect(new Headers(request?.headers).get("x-csrf-token")).toBe("proof");
        expect(new Headers(request?.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(
          fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/configure"),
        ).toBe(false);
        const current = screen.getByRole("region", { name: /^this host$/i });
        expect(within(current).getByText("tenant-1")).toBeTruthy();
        expect(within(current).getByText("client-1")).toBeTruthy();
      },
    );

    it("cancels an unsent change without changing the current configuration", async () => {
      const fetchMock = host();
      show();
      await edit();
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      expect(
        screen.queryByRole("button", { name: /verify new configuration/i }),
      ).toBeNull();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/configuration/start"),
        ),
      ).toBe(false);
      expect(browserNavigation.assign).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: /change microsoft sign-in configuration/i }),
      );
      expect(
        (screen.getByLabelText(/application \(client\) id/i) as HTMLInputElement).value,
      ).toBe("client-1");
    });

    it.each([
      {
        name: "a refused configuration",
        response: () => answer({ error: "That registration is not allowed." }, 400),
        message: /that registration is not allowed/i,
      },
      {
        name: "a rejected CSRF proof",
        response: () => answer({ error: "CSRF proof was refused." }, 403),
        message: /csrf proof was refused/i,
      },
      {
        name: "a non-JSON response",
        response: () => new Response("Unavailable", { status: 503 }),
        message: /503/,
      },
      {
        name: "a missing verification URL",
        response: () => answer({ ok: true }),
        message: /host returned no microsoft verification url/i,
      },
    ])("reports $name without navigating and permits retry", async (test) => {
      let refused = true;
      host({
        "POST /api/auth/configuration/start": () =>
          refused ? test.response() : answer({ authorizationUrl }),
      });
      const notify = vi.fn();
      show(notify);
      const submit = await edit();
      fireEvent.click(submit);

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(test.message)).toBeTruthy();
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(test.message), "error");
      expect(browserNavigation.assign).not.toHaveBeenCalled();
      expect(submit.disabled).toBe(false);
      fireEvent.click(within(dialog).getByRole("button", { name: /^close$/i }));
      expect(
        (screen.getByLabelText(/application \(client\) id/i) as HTMLInputElement).value,
      ).toBe(clientId);
      expect(
        within(screen.getByRole("region", { name: /^this host$/i })).getByText(
          "client-1",
        ),
      ).toBeTruthy();

      refused = false;
      fireEvent.click(submit);
      await waitFor(() =>
        expect(browserNavigation.assign).toHaveBeenCalledWith(authorizationUrl),
      );
    });

    it("does not start a change when the CSRF token cannot be loaded", async () => {
      const fetchMock = host({
        "GET /api/auth/csrf": () => answer({}, 503),
      });
      show();
      fireEvent.click(await edit());

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/could not load csrf token/i)).toBeTruthy();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/configuration/start"),
        ),
      ).toBe(false);
      expect(browserNavigation.assign).not.toHaveBeenCalled();
    });

    it("uses the existing recent-authentication prompt before retrying a change", async () => {
      const fetchMock = host({
        "POST /api/auth/configuration/start": () =>
          answer(
            {
              error: "Confirm your current administrator account.",
              reauthRequired: true,
            },
            403,
          ),
        "POST /api/auth/code/start": () =>
          answer({ authorizationUrl: "https://login.microsoftonline.com/current" }),
      });
      const notify = vi.fn();
      show(notify);
      fireEvent.click(await edit());

      const dialog = await screen.findByRole("dialog", { name: /confirm.*microsoft/i });
      expect(notify).toHaveBeenCalledWith(
        "Confirm your current administrator account.",
        "warning",
      );
      expect(
        within(dialog).getByText(/return to settings.*retry the action/i),
      ).toBeTruthy();
      expect(browserNavigation.assign).not.toHaveBeenCalled();
      fireEvent.click(
        await screen.findByRole("button", { name: /confirm with microsoft/i }),
      );
      await waitFor(() =>
        expect(browserNavigation.assign).toHaveBeenCalledWith(
          "https://login.microsoftonline.com/current",
        ),
      );
      const reauth = fetchMock.mock.calls.find(
        ([url]) => String(url) === "/api/auth/code/start",
      );
      expect(JSON.parse(String(reauth?.[1]?.body))).toEqual({});
    });
  });

  it("shows the Host fingerprint a Node is asked to pin", async () => {
    host();
    show();
    expect(await screen.findByText("a".repeat(64))).toBeTruthy();
  });

  it("lists administrators with the identity each one is keyed by", async () => {
    host();
    show();

    const table = await screen.findByRole("table", { name: /administrators/i });
    expect(within(table).getByText("alice@example.com")).toBeTruthy();
    expect(within(table).getByText("bob@example.com")).toBeTruthy();
    expect(within(table).getAllByText("bob-oid").length).toBeGreaterThan(0);
  });

  it("leaves panel width uncapped and scrolls tables locally on narrow screens", async () => {
    host();
    show();

    const table = await screen.findByRole("table", { name: /administrators/i });
    const card = screen.getByRole("region", { name: /^administrators$/i });
    expect(getComputedStyle(card.parentElement!).maxWidth).toMatch(/^(none)?$/);
    expect(getComputedStyle(table).tableLayout).toBe("auto");
    expect(getComputedStyle(table).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(table.parentElement!).overflowX).toBe("auto");
  });

  it("creates an invitation and offers the link exactly once", async () => {
    const fetchMock = host({
      "POST /api/auth/administrator-invitations": () =>
        answer({ id: "inv-1", token: "invite-secret" }, 201),
    });
    show();

    const add = await screen.findByRole("button", { name: /invite someone else/i });
    fireEvent.click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(add.textContent).toBe("Creating invitation…");
    fireEvent.click(add);

    const link = await screen.findByLabelText("Invitation link");
    expect((link as HTMLInputElement).value).toContain("invite-secret");
    expect(
      screen.getByRole("button", { name: /copy the invitation link/i }),
    ).toBeTruthy();
    expect(screen.getByText(/single use, fifteen minutes/i)).toBeTruthy();
    expect(
      screen.getByText(/send this link to the person you want to invite/i),
    ).toBeTruthy();
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/api/auth/administrator-invitations") &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
    const created = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/api/auth/administrator-invitations") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(new Headers((created?.[1] as RequestInit).headers).get("x-csrf-token")).toBe(
      "proof",
    );
  });

  describe("adding another account in the same browser", () => {
    const authorizationUrl = "https://login.microsoftonline.com/common/authorize?add";

    const confirm = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: /add another account/i }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: /add another administrator account/i,
      });
      expect(within(dialog).getByText(/without a separate approval/i)).toBeTruthy();
      return within(dialog).getByRole("button", { name: /choose account in new tab/i });
    };

    it("opens the account picker in a detached tab only after explicit authorization", async () => {
      const tab = { closed: false, assign: vi.fn(), close: vi.fn() };
      const open = vi.spyOn(browserNavigation, "openTab").mockReturnValue(tab);
      const fetchMock = host({
        "POST /api/auth/administrators/add/start": () => answer({ authorizationUrl }),
      });
      const notify = vi.fn();
      show(notify);
      const choose = await confirm();
      expect(open).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === "/api/auth/administrators/add/start",
        ),
      ).toBe(false);
      fireEvent.click(choose);
      expect(open).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(tab.assign).toHaveBeenCalledWith(authorizationUrl));
      expect(tab.close).not.toHaveBeenCalled();
      expect(browserNavigation.assign).not.toHaveBeenCalled();
      const started = fetchMock.mock.calls.find(
        ([url]) => url === "/api/auth/administrators/add/start",
      );
      expect(new Headers(started?.[1]?.headers).get("x-csrf-token")).toBe("proof");
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/administrator-invitations"),
        ),
      ).toBe(false);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/new tab/i), "info");
    });

    it("reports blocked popups without starting an authorization transaction", async () => {
      vi.spyOn(browserNavigation, "openTab").mockReturnValue(undefined);
      const fetchMock = host();
      show();
      fireEvent.click(await confirm());
      expect(await screen.findByText(/allow popups for this host/i)).toBeTruthy();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === "/api/auth/administrators/add/start",
        ),
      ).toBe(false);
    });

    it.each([
      [
        403,
        { error: "Confirm your current administrator account.", reauthRequired: true },
      ],
      [503, { error: "Microsoft sign-in is unavailable." }],
      [200, {}],
    ])("closes the blank tab when starting sign-in fails (%s)", async (status, body) => {
      const tab = { closed: false, assign: vi.fn(), close: vi.fn() };
      vi.spyOn(browserNavigation, "openTab").mockReturnValue(tab);
      host({
        "POST /api/auth/administrators/add/start": () => answer(body, status),
      });
      show();
      fireEvent.click(await confirm());
      await waitFor(() => expect(tab.close).toHaveBeenCalledOnce());
      expect(tab.assign).not.toHaveBeenCalled();
      expect(await screen.findByRole("dialog")).toBeTruthy();
      if (status === 403) {
        expect(
          screen.getByRole("button", { name: /confirm with microsoft/i }),
        ).toBeTruthy();
      }
    });

    it("does not open a tab or start a request when the administrator cancels", async () => {
      const open = vi.spyOn(browserNavigation, "openTab");
      const fetchMock = host();
      show();
      await confirm();
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(open).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === "/api/auth/administrators/add/start",
        ),
      ).toBe(false);
    });

    it("refreshes the administrator list when returning from the sign-in tab", async () => {
      let added = false;
      host({
        "GET /api/auth/administrators": () =>
          answer({
            currentAdministratorId: alice.id,
            administrators: added ? [alice, bob] : [alice],
            pending: [],
          }),
      });
      show();
      const table = await screen.findByRole("table", { name: /^administrators$/i });
      expect(within(table).queryByText(bob.username)).toBeNull();
      added = true;
      fireEvent(window, new Event("focus"));
      expect(await within(table).findByText(bob.username)).toBeTruthy();
    });
  });

  it("shows a pending candidate's exact identity before anyone approves it", async () => {
    host(
      {},
      {
        "/api/auth/administrators": {
          currentAdministratorId: alice.id,
          administrators: [alice],
          pending: [
            {
              id: "inv-2",
              tenantId: "tenant-1",
              objectId: "carol-oid",
              username: "carol@example.com",
              displayName: "Carol",
              consumedAt: "2026-08-28T10:00:00.000Z",
            },
          ],
        },
      },
    );
    show();

    const pending = await screen.findByRole("table", { name: /waiting for approval/i });
    expect(within(pending).getByText("carol@example.com")).toBeTruthy();
    expect(within(pending).getByText("carol-oid")).toBeTruthy();
    expect(
      within(pending).getByRole("button", { name: /approve carol@example.com/i }),
    ).toBeTruthy();
    expect(
      within(pending).getByRole("button", { name: /reject carol@example.com/i }),
    ).toBeTruthy();
  });

  it("approves the candidate the administrator actually looked at", async () => {
    const fetchMock = host(
      {},
      {
        "/api/auth/administrators": {
          currentAdministratorId: alice.id,
          administrators: [alice],
          pending: [
            {
              id: "inv-2",
              tenantId: "tenant-1",
              objectId: "carol-oid",
              username: "carol@example.com",
              displayName: "Carol",
              consumedAt: "2026-08-28T10:00:00.000Z",
            },
          ],
        },
      },
    );
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /approve carol@example.com/i }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/administrator-invitations/inv-2/approve"),
        ),
      ).toBe(true),
    );
  });

  it.each([alice, bob])(
    "disables removal of the current administrator $id",
    async (current) => {
      const fetchMock = host(
        {},
        {
          "/api/auth/administrators": {
            currentAdministratorId: current.id,
            administrators: [alice, bob],
            pending: [],
          },
        },
      );
      show();

      const ownButton = await screen.findByRole("button", {
        name: `Remove ${current.username}`,
      });
      const other = current.id === alice.id ? bob : alice;
      expect((ownButton as HTMLButtonElement).disabled).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: `Remove ${other.username}`,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      fireEvent.click(ownButton);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
        false,
      );
      expect(
        screen.getByText(/you cannot remove your current administrator account/i),
      ).toBeTruthy();
    },
  );

  it("disables an open removal confirmation if that account becomes the current user", async () => {
    let currentAdministratorId = alice.id;
    const fetchMock = host({
      "GET /api/auth/administrators": () =>
        answer({ currentAdministratorId, administrators: [alice, bob], pending: [] }),
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: `Remove ${bob.username}` }),
    );
    const dialog = await screen.findByRole("dialog");
    const remove = within(dialog).getByRole("button", { name: /^remove$/i });
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    currentAdministratorId = bob.id;
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(remove);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
      false,
    );
  });

  it("keeps removal disabled when the current administrator cannot be identified", async () => {
    host(
      {},
      {
        "/api/auth/administrators": {
          administrators: [alice, bob],
          pending: [],
        },
      },
    );
    show();
    const table = await screen.findByRole("table", { name: /^administrators$/i });
    for (const button of within(table).getAllByRole("button", { name: /^remove /i })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      screen.getByText(/current administrator could not be identified/i),
    ).toBeTruthy();
  });

  it("names the person and the consequence before removing them", async () => {
    const fetchMock = host();
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /remove bob@example.com/i }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/bob@example.com/)).toBeTruthy();
    expect(within(dialog).getByText(/sessions|sign(ed)? out|browser/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/auth/administrators/admin-bob") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("asks for a fresh Microsoft sign-in when the Host wants recent proof", async () => {
    // A ten-minute-old code login is the price of a high-impact change; a 403
    // that only says "forbidden" leaves the operator with nothing to do.
    const fetchMock = host({
      "POST /api/auth/administrator-invitations": () =>
        answer(
          {
            error: "Sign in with Microsoft again before changing this.",
            reauthRequired: true,
          },
          403,
        ),
      "/api/auth/code/start": () =>
        answer({ authorizationUrl: "https://login/authorize" }),
    });
    const notify = vi.fn();
    show(notify);

    fireEvent.click(await screen.findByRole("button", { name: /invite someone else/i }));

    const dialog = await screen.findByRole("dialog", {
      name: /confirm.*microsoft/i,
    });
    const prompt = within(dialog).getByRole("button", {
      name: /confirm with microsoft/i,
    });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(notify).toHaveBeenCalledWith(
      "Sign in with Microsoft again before changing this.",
      "warning",
    );
    fireEvent.click(prompt);

    await waitFor(() =>
      expect(browserNavigation.assign).toHaveBeenCalledWith("https://login/authorize"),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/code/start")),
    ).toBe(true);
  });

  it("shows invitation failures in a dismissible dialog instead of above the viewport", async () => {
    host({
      "POST /api/auth/administrator-invitations": () =>
        answer({ error: "Could not create an invitation. Try again." }, 500),
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: /invite someone else/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/could not create an invitation/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^close$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      (screen.getByRole("button", { name: /invite someone else/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps sign-in failures visible and lets the administrator retry", async () => {
    let failed = true;
    host({
      "POST /api/auth/administrator-invitations": () =>
        answer({ error: "Confirm your identity.", reauthRequired: true }, 403),
      "POST /api/auth/code/start": () =>
        failed
          ? answer({ error: "Microsoft sign-in is unavailable. Try again." }, 503)
          : answer({ authorizationUrl: "https://login/authorize" }),
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: /invite someone else/i }));
    const dialog = await screen.findByRole("dialog", { name: /confirm.*microsoft/i });
    const confirm = within(dialog).getByRole("button", {
      name: /confirm with microsoft/i,
    });
    fireEvent.click(confirm);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    expect(
      await within(dialog).findByText(/microsoft sign-in is unavailable/i),
    ).toBeTruthy();
    expect(browserNavigation.assign).not.toHaveBeenCalled();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    failed = false;
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(browserNavigation.assign).toHaveBeenCalledWith("https://login/authorize"),
    );
  });

  it("lets the administrator cancel re-confirmation without starting sign-in", async () => {
    host({
      "POST /api/auth/administrator-invitations": () =>
        answer({ error: "Confirm your identity.", reauthRequired: true }, 403),
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: /invite someone else/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(browserNavigation.assign).not.toHaveBeenCalled();
  });

  it("disables password sign-in once a Microsoft administrator exists", async () => {
    const fetchMock = host();
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /disable password sign-in/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^disable$/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/password/disable"),
        ),
      ).toBe(true),
    );
  });

  it("lets an administrator explicitly enable password sign-in", async () => {
    let passwordEnabled = false;
    const fetchMock = host({
      "/api/auth/status": () =>
        answer({
          ...(defaults["/api/auth/status"] as object),
          state: passwordEnabled ? "hybrid" : "microsoft-only",
          passwordEnabled,
        }),
      "POST /api/auth/password/enable": () => {
        passwordEnabled = true;
        return answer({ ok: true });
      },
      "POST /api/auth/password/disable": () => {
        passwordEnabled = false;
        return answer({ ok: true });
      },
    });
    show();

    fireEvent.click(
      await screen.findByRole("button", { name: /enable password sign-in/i }),
    );
    const dialog = await screen.findByRole("dialog");
    const enable = within(dialog).getByRole("button", { name: /^enable$/i });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/^new operator password$/i), {
      target: { value: "too-short" },
    });
    expect(within(dialog).getByText("Use at least 12 characters.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^new operator password$/i), {
      target: { value: "abcdefghij!1" },
    });
    expect(
      within(dialog).getByText("Include at least one uppercase letter."),
    ).toBeTruthy();
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/^new operator password$/i), {
      target: { value: "Abcdefghijk1" },
    });
    expect(
      within(dialog).getByText("Include at least one special character (not a space)."),
    ).toBeTruthy();
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/^new operator password$/i), {
      target: { value: "Abcdefghij!1" },
    });
    fireEvent.change(within(dialog).getByLabelText(/confirm operator password/i), {
      target: { value: "different" },
    });
    expect(within(dialog).getByText("The passwords do not match.")).toBeTruthy();
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/confirm operator password/i), {
      target: { value: "Abcdefghij!1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^enable$/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/auth/password/enable") &&
            JSON.parse(String((init as RequestInit).body)).password === "Abcdefghij!1",
        ),
      ).toBe(true),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /disable password sign-in/i }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /^disable$/i,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /enable password sign-in/i }),
    );
    const reopened = await screen.findByRole("dialog");
    for (const field of within(reopened).getAllByLabelText(/operator password/i)) {
      expect((field as HTMLInputElement).value).toBe("");
    }
    const writes = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/auth/password/"),
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]?.[1]?.body).toBeUndefined();
    for (const [, init] of writes) {
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe("proof");
    }
  });

  it("reports how far the Node key migration has got, and blocks enforcement until it is done", async () => {
    host();
    show();

    expect(await screen.findByText(/2 of 3/i)).toBeTruthy();
    const enforce = screen.getByRole("switch", {
      name: /require mutual node authentication/i,
    });
    expect((enforce as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/1 node still/i)).toBeTruthy();
  });

  it("lets enforcement be switched on once every Node has a key", async () => {
    const fetchMock = host(
      {},
      {
        "/api/enrollment": {
          ...(defaults["/api/enrollment"] as object),
          nodeAuthentication: { total: 3, mutualAuth: 3, legacy: 0 },
        },
      },
    );
    show();

    const enforce = await screen.findByRole("switch", {
      name: /require mutual node authentication/i,
    });
    expect((enforce as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(enforce);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/nodes/mutual-authentication"),
        ),
      ).toBe(true),
    );
  });

  it("shows the local security audit as a table people can read", async () => {
    host();
    show();

    const audit = await screen.findByRole("table", { name: /security audit/i });
    expect(within(audit).getByText("fleet_claimed")).toBeTruthy();
  });

  describe("device sign-in verification", () => {
    it("offers to try the flow even though the Host has it switched off", async () => {
      host();
      show();

      expect(await screen.findByText(/device sign-in is off/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: /verify device sign-in/i })).toBeTruthy();
    });

    it("shows the code Microsoft is waiting for while the check runs", async () => {
      host({
        // Listed before the start route: both share a prefix, and the poll is
        // the more specific of the two.
        "/api/auth/device/verify/verify-1": () => answer({ pending: true }, 202),
        "POST /api/auth/device/verify": () =>
          answer({
            flowId: "verify-1",
            userCode: "FLEET-999",
            verificationUri: "https://microsoft.com/devicelogin",
            message: "Enter FLEET-999",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
      });
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /verify device sign-in/i }),
      );

      expect(await screen.findByText("FLEET-999")).toBeTruthy();
      expect(screen.getByRole("button", { name: /copy the device code/i })).toBeTruthy();
    });

    it("enables it after Microsoft completes the verification", async () => {
      let enabled = false;
      host({
        "/api/auth/device/verify/verify-1": () => {
          enabled = true;
          return answer({ deviceFlowEnabled: true });
        },
        "POST /api/auth/device/verify": () =>
          answer({
            flowId: "verify-1",
            userCode: "FLEET-999",
            verificationUri: "https://microsoft.com/devicelogin",
            message: "Enter FLEET-999",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        "/api/auth/status": () =>
          answer({
            ...(defaults["/api/auth/status"] as object),
            deviceFlowEnabled: enabled,
          }),
      });
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /verify device sign-in/i }),
      );

      expect(await screen.findByText(/device sign-in is enabled/i)).toBeTruthy();
    });

    it("reports a nested device verification refusal while leaving it inline", async () => {
      host({
        "POST /api/auth/device/verify": () =>
          answer({ error: "Microsoft refused this verification." }, 500),
      });
      const notify = vi.fn();
      show(notify);
      fireEvent.click(
        await screen.findByRole("button", { name: /verify device sign-in/i }),
      );
      expect(
        await screen.findByText("Microsoft refused this verification."),
      ).toBeTruthy();
      await waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          "Microsoft refused this verification.",
          "error",
        ),
      );
    });

    it("keeps it disabled and explains a Conditional Access block", async () => {
      host({
        "POST /api/auth/device/verify": () =>
          answer(
            {
              error:
                "Conditional Access blocks device sign-in in this tenant. Use a local forward instead.",
              blocked: true,
            },
            409,
          ),
      });
      const notify = vi.fn();
      show(notify);

      fireEvent.click(
        await screen.findByRole("button", { name: /verify device sign-in/i }),
      );

      expect(
        await screen.findByText(/conditional access blocks device sign-in/i),
      ).toBeTruthy();
      expect(await screen.findByText(/device sign-in is off/i)).toBeTruthy();
      expect(notify).toHaveBeenCalledWith(
        "Conditional Access blocks device sign-in in this tenant. Use a local forward instead.",
        "warning",
      );
    });
  });
});
