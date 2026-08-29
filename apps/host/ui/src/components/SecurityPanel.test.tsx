import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { SecurityPanel } from "./SecurityPanel";
import { browserNavigation, forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

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
  "/api/auth/administrators": { administrators: [alice, bob], pending: [] },
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

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <SecurityPanel />
    </FluentProvider>,
  );

describe("SecurityPanel", () => {
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

  it("creates an invitation and offers the link exactly once", async () => {
    const fetchMock = host({
      "POST /api/auth/administrator-invitations": () =>
        answer({ id: "inv-1", token: "invite-secret" }, 201),
    });
    show();

    fireEvent.click(await screen.findByRole("button", { name: /add administrator/i }));

    const link = await screen.findByLabelText("Invitation link");
    expect((link as HTMLInputElement).value).toContain("invite-secret");
    expect(
      screen.getByRole("button", { name: /copy the invitation link/i }),
    ).toBeTruthy();
    expect(screen.getByText(/single use, fifteen minutes/i)).toBeTruthy();
    const created = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/api/auth/administrator-invitations") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(new Headers((created?.[1] as RequestInit).headers).get("x-csrf-token")).toBe(
      "proof",
    );
  });

  it("shows a pending candidate's exact identity before anyone approves it", async () => {
    host(
      {},
      {
        "/api/auth/administrators": {
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
    show();

    fireEvent.click(await screen.findByRole("button", { name: /add administrator/i }));

    const prompt = await screen.findByRole("button", { name: /confirm with microsoft/i });
    fireEvent.click(prompt);

    await waitFor(() =>
      expect(browserNavigation.assign).toHaveBeenCalledWith("https://login/authorize"),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/code/start")),
    ).toBe(true);
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
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /verify device sign-in/i }),
      );

      expect(
        await screen.findByText(/conditional access blocks device sign-in/i),
      ).toBeTruthy();
      expect(await screen.findByText(/device sign-in is off/i)).toBeTruthy();
    });
  });
});
