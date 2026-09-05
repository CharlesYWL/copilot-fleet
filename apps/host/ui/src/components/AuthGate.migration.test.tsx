import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { AuthGate } from "./AuthGate";
import { browserNavigation, forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <AuthGate>
        <div>console</div>
      </AuthGate>
    </FluentProvider>,
  );

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type StatusOverrides = Record<string, unknown>;

const statusBody = (overrides: StatusOverrides = {}) => ({
  state: "legacy-password",
  authenticated: true,
  passwordEnabled: true,
  entraConfigured: false,
  deviceFlowEnabled: false,
  claimCodeRequired: true,
  canSignIn: true,
  codeLogin: { available: true, localForwardRequired: false },
  ...overrides,
});

const host = (
  routes: Record<string, () => Response>,
  overrides: StatusOverrides = {},
) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = String(input);
    for (const [path, respond] of Object.entries(routes)) {
      if (url.includes(path)) return respond();
    }
    if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "csrf-proof" });
    return answer(statusBody(overrides));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const called = (mock: ReturnType<typeof host>, path: string) =>
  mock.mock.calls.find(([url]) => String(url).includes(path));

/**
 * The migration checkpoint.
 *
 * An upgraded Host reports `authenticated` the moment the existing password is
 * accepted, and `claimCodeRequired` for as long as nobody administers it. The
 * console used to appear on the strength of the first alone — which is a
 * console whose Security tab is the only thing that can finish the migration,
 * shown to somebody who has no idea they are half way through one. Worse, the
 * only documented way forward was a code printed on the Host's terminal, which
 * for a remote machine is a trip to another building to prove something the
 * password already proved.
 */
describe("AuthGate, migrating a legacy-password Host", () => {
  beforeEach(() => {
    forgetCsrfToken();
    vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    forgetCsrfToken();
    window.history.replaceState({}, "", "/");
  });

  it("keeps the console back while the Host still has no administrator", async () => {
    host({ "/api/auth/bootstrap/password": () => answer({ ok: true }) });
    show();

    expect(
      await screen.findByRole("heading", { name: /finish claiming this host/i }),
    ).toBeTruthy();
    expect(screen.queryByText("console")).toBeNull();
  });

  it("asks the Host for a password bootstrap without being told to", async () => {
    const fetchMock = host({
      "/api/auth/bootstrap/password": () => answer({ ok: true }),
    });
    show();

    await waitFor(() =>
      expect(called(fetchMock, "/api/auth/bootstrap/password")).toBeTruthy(),
    );
    const request = called(fetchMock, "/api/auth/bootstrap/password");
    expect(request?.[1]?.method).toBe("POST");
    // The route is an ordinary operator route, so it needs the session's proof.
    expect(
      (request?.[1]?.headers as Record<string, string> | undefined)?.["x-csrf-token"],
    ).toBe("csrf-proof");
    // And it never asks for, or sends, the console code.
    expect(screen.queryByLabelText(/claim code/i)).toBeNull();
  });

  it("collects the tenant and client id when this Host has no registration", async () => {
    const fetchMock = host({
      "/api/auth/bootstrap/password": () => answer({ ok: true }),
      "/api/auth/configure": () => answer({ ok: true }),
    });
    show();

    const tenant = await screen.findByLabelText(/directory \(tenant\) id/i);
    fireEvent.change(tenant, { target: { value: "tenant-guid" } });
    fireEvent.change(screen.getByLabelText(/application \(client\) id/i), {
      target: { value: "client-guid" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await waitFor(() => {
      expect(
        JSON.parse(String(called(fetchMock, "/api/auth/configure")?.[1]?.body)),
      ).toEqual({ tenantId: "tenant-guid", clientId: "client-guid" });
    });
    // Configuration done, the remaining proof is a Microsoft account.
    expect(
      await screen.findByRole("button", { name: /claim with microsoft/i }),
    ).toBeTruthy();
  });

  it("offers the claim straight away when Entra is already configured", async () => {
    const fetchMock = host(
      {
        "/api/auth/bootstrap/password": () => answer({ ok: true }),
        "/api/auth/code/start": () => answer({ authorizationUrl: "https://login/x" }),
      },
      { entraConfigured: true },
    );
    show();

    const claim = await screen.findByRole("button", { name: /claim with microsoft/i });
    expect(screen.queryByLabelText(/directory \(tenant\) id/i)).toBeNull();

    fireEvent.click(claim);
    await waitFor(() =>
      expect(browserNavigation.assign).toHaveBeenCalledWith("https://login/x"),
    );
    expect(called(fetchMock, "/api/auth/code/start")).toBeTruthy();
  });

  it("shows the console once an administrator exists", async () => {
    host({}, { state: "hybrid", claimCodeRequired: false });
    show();
    expect(await screen.findByText("console")).toBeTruthy();
  });

  it("says so, and offers a retry, when the Host refuses the bootstrap", async () => {
    host({
      "/api/auth/bootstrap/password": () =>
        answer({ error: "This Fleet has already been claimed." }, 409),
    });
    show();

    expect(await screen.findByText(/this fleet has already been claimed/i)).toBeTruthy();
    expect(screen.queryByLabelText(/directory \(tenant\) id/i)).toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});

/**
 * The same Host with nobody signed in.
 *
 * Offering "Sign in with Microsoft" here is offering a button whose only
 * possible outcome is a 409: there is no registration to send anybody to. The
 * password is the one credential that works, so it is the one the screen leads
 * with.
 */
describe("AuthGate, signed out of a legacy-password Host", () => {
  beforeEach(() => {
    forgetCsrfToken();
    vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    forgetCsrfToken();
    window.history.replaceState({}, "", "/");
  });

  it("leads with the password and offers no Microsoft login it cannot start", async () => {
    host({}, { authenticated: false });
    show();

    expect(await screen.findByLabelText(/operator password/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with microsoft/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeTruthy();
    expect(screen.getByText(/no tenant or client ids to enter/i)).toBeTruthy();
  });

  it("still requires the legacy password before first claim when Microsoft is built in", async () => {
    host(
      {},
      {
        authenticated: false,
        entraConfigured: true,
      },
    );
    show();

    expect(await screen.findByLabelText(/operator password/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with microsoft/i })).toBeNull();
  });

  it("goes to the migration checkpoint the moment the password is accepted", async () => {
    let signedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/login")) {
          signedIn = true;
          return answer({ ok: true });
        }
        if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "csrf-proof" });
        if (url.includes("/api/auth/bootstrap/password")) return answer({ ok: true });
        return answer(statusBody({ authenticated: signedIn }));
      }),
    );
    show();

    fireEvent.change(await screen.findByLabelText(/operator password/i), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(
      await screen.findByRole("heading", { name: /finish claiming this host/i }),
    ).toBeTruthy();
    expect(await screen.findByLabelText(/directory \(tenant\) id/i)).toBeTruthy();
    expect(screen.queryByText("console")).toBeNull();
  });

  it("still shows both ways in on a hybrid Host", async () => {
    host(
      {},
      {
        state: "hybrid",
        authenticated: false,
        entraConfigured: true,
        claimCodeRequired: false,
      },
    );
    show();

    expect(
      await screen.findByRole("button", { name: /sign in with microsoft/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/operator password/i)).toBeTruthy();
  });

  it("keeps the console code path for a Host that has no password", async () => {
    host(
      {},
      {
        state: "entra-unconfigured",
        authenticated: false,
        passwordEnabled: false,
        claimCodeRequired: true,
      },
    );
    show();

    expect(
      await screen.findByRole("heading", { name: /configure microsoft sign-in/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/claim code/i)).toBeTruthy();
  });
});
