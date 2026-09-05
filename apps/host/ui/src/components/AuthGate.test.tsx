import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { AuthGate } from "./AuthGate";
import { announceSignedOut, browserNavigation } from "../lib/auth";
import { fleetDarkTheme } from "../theme";
import markUrl from "../assets/copilot-fleet-mark.svg";

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

type StatusOverrides = Partial<{
  state: string;
  authenticated: boolean;
  passwordEnabled: boolean;
  entraConfigured: boolean;
  deviceFlowEnabled: boolean;
  claimCodeRequired: boolean;
  canSignIn: boolean;
  codeLogin: {
    available: boolean;
    canonicalUrl?: string;
    localForwardRequired?: boolean;
  };
  identity: { username: string; displayName: string };
}>;

const statusBody = (overrides: StatusOverrides = {}) => ({
  state: "microsoft-only",
  authenticated: false,
  passwordEnabled: false,
  entraConfigured: true,
  deviceFlowEnabled: false,
  claimCodeRequired: false,
  canSignIn: true,
  codeLogin: { available: true, localForwardRequired: false },
  ...overrides,
});

/** Routes each call the gate makes; anything unrouted answers the status body. */
const host = (
  routes: Record<string, () => Response>,
  overrides: StatusOverrides = {},
) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = String(input);
    for (const [path, respond] of Object.entries(routes)) {
      if (url.includes(path)) return respond();
    }
    return answer(statusBody(overrides));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("AuthGate", () => {
  let assign: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("shows the console to a session the Host recognises", async () => {
    host({}, { authenticated: true });
    show();
    expect(await screen.findByText("console")).toBeTruthy();
  });

  it("announces what it is doing while it asks the Host who is calling", async () => {
    host({});
    show();
    // Screen-reader users get the same "wait" the spinner gives everyone else.
    const live = await screen.findByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("wears the fleet mark rather than a marketing hero", async () => {
    host({});
    show();

    const gate = await screen.findByRole("region", { name: /sign in to copilot fleet/i });
    const mark = gate.querySelector("img");
    expect(mark?.getAttribute("src")).toBe(markUrl);
    expect(within(gate).getByText("Copilot Fleet")).toBeTruthy();
  });

  it("shows the trust chain this Host actually stands on", async () => {
    host({});
    show();

    const rail = await screen.findByRole("list", { name: /trust chain/i });
    const stages = within(rail).getAllByRole("listitem");
    expect(stages.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Host"),
      expect.stringContaining("Microsoft identity"),
      expect.stringContaining("Nodes"),
    ]);
  });

  describe("a Host with no Microsoft configuration", () => {
    const fresh = {
      state: "entra-unconfigured",
      entraConfigured: false,
      claimCodeRequired: true,
    } as const;

    it("asks for the console code before it will take a tenant", async () => {
      host({}, fresh);
      show();

      expect(
        await screen.findByRole("heading", { name: /configure microsoft sign-in/i }),
      ).toBeTruthy();
      const code = screen.getByLabelText(/claim code/i);
      // Printed once on a console and never echoed back.
      expect(code.getAttribute("type")).toBe("password");
      expect(screen.queryByLabelText(/directory \(tenant\) id/i)).toBeNull();
    });

    it("takes the tenant and client id once the code is accepted", async () => {
      const fetchMock = host(
        {
          "/api/auth/bootstrap": () =>
            answer({ ok: true, expiresAt: "2026-01-01T00:00:00Z" }),
          "/api/auth/configure": () => answer({ ok: true }),
        },
        fresh,
      );
      show();

      fireEvent.change(await screen.findByLabelText(/claim code/i), {
        target: { value: "console-code" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^unlock setup$/i }));

      const tenant = await screen.findByLabelText(/directory \(tenant\) id/i);
      fireEvent.change(tenant, { target: { value: "tenant-guid" } });
      fireEvent.change(screen.getByLabelText(/application \(client\) id/i), {
        target: { value: "client-guid" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) =>
          String(url).includes("/api/auth/configure"),
        );
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({
          tenantId: "tenant-guid",
          clientId: "client-guid",
        });
      });
    });

    it("says why the code was refused and keeps the field", async () => {
      host(
        {
          "/api/auth/bootstrap": () =>
            answer({ error: "That claim code is not valid." }, 401),
        },
        fresh,
      );
      show();

      fireEvent.change(await screen.findByLabelText(/claim code/i), {
        target: { value: "wrong" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^unlock setup$/i }));

      expect(await screen.findByText(/that claim code is not valid/i)).toBeTruthy();
      expect(screen.getByLabelText(/claim code/i)).toBeTruthy();
    });

    /**
     * The Host that most needs restoring is the one that cannot sign anyone in.
     *
     * A move lands a new machine in exactly this state: no Entra registration,
     * no administrators, and an archive on a USB stick that holds all three.
     * The restore is authorised by the console claim code — the same proof this
     * screen already collects — so the only thing standing between the operator
     * and their fleet was the fact that the card lives behind a sign-in that
     * cannot happen yet.
     */
    it("offers a portable restore once the console code is accepted", async () => {
      host({ "/api/auth/bootstrap": () => answer({ ok: true }) }, fresh);
      show();

      fireEvent.change(await screen.findByLabelText(/claim code/i), {
        target: { value: "console-code" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^unlock setup$/i }));

      const card = await screen.findByRole("region", { name: /move this host/i });
      expect(
        within(card).getByRole("button", { name: /import portable backup/i }),
      ).toBeTruthy();
      // Nothing to export from a Host that holds no fleet.
      expect(
        within(card).queryByRole("button", { name: /export portable backup/i }),
      ).toBeNull();
    });

    it("keeps the restore behind the console code", async () => {
      host({}, fresh);
      show();

      await screen.findByLabelText(/claim code/i);
      expect(screen.queryByRole("region", { name: /move this host/i })).toBeNull();
    });
  });

  describe("a configured Host nobody has claimed", () => {
    const unclaimed = { state: "unclaimed", claimCodeRequired: true } as const;

    it("asks for the console code, then for a Microsoft account", async () => {
      host({ "/api/auth/bootstrap": () => answer({ ok: true }) }, unclaimed);
      show();

      expect(
        await screen.findByRole("heading", { name: /claim this fleet/i }),
      ).toBeTruthy();
      fireEvent.change(screen.getByLabelText(/claim code/i), {
        target: { value: "console-code" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^unlock claim$/i }));

      expect(
        await screen.findByRole("button", { name: /claim with microsoft/i }),
      ).toBeTruthy();
    });

    it.each([
      {
        path: "/api/auth/bootstrap",
        fields: { "Claim code": "console-code" },
        action: /^unlock setup$/i,
        fallback: "That code was refused (503)",
        configure: false,
        overrides: {
          state: "entra-unconfigured",
          entraConfigured: false,
          claimCodeRequired: true,
        },
      },
      {
        path: "/api/auth/configure",
        fields: {
          "Directory (tenant) ID": "tenant-guid",
          "Application (client) ID": "client-guid",
        },
        action: /save and continue/i,
        fallback: "That configuration was refused (503)",
        configure: true,
        overrides: {
          state: "entra-unconfigured",
          entraConfigured: false,
          claimCodeRequired: true,
        },
      },
      {
        path: "/api/auth/login",
        fields: { "Operator password": "operator-password" },
        action: /^sign in$/i,
        fallback: "Sign-in failed (503)",
        configure: false,
        overrides: { state: "hybrid", passwordEnabled: true },
      },
    ])(
      "keeps $path form input and permits retry after a non-JSON error",
      async (test) => {
        let attempts = 0;
        const fetchMock = host(
          {
            "/api/auth/bootstrap": () => answer({ ok: true }),
            [test.path]: () =>
              ++attempts === 1
                ? new Response("Unavailable", { status: 503 })
                : answer({ ok: true }),
          },
          test.overrides,
        );
        show();
        if (test.configure) {
          fireEvent.change(await screen.findByLabelText("Claim code"), {
            target: { value: "console-code" },
          });
          fireEvent.click(screen.getByRole("button", { name: /^unlock setup$/i }));
        }
        for (const [label, value] of Object.entries(test.fields)) {
          fireEvent.change(await screen.findByLabelText(label), { target: { value } });
        }
        const submit = screen.getByRole("button", {
          name: test.action,
        }) as HTMLButtonElement;
        fireEvent.click(submit);
        expect(submit.disabled).toBe(true);
        expect(await screen.findByText(test.fallback)).toBeTruthy();
        expect(submit.disabled).toBe(false);
        for (const [label, value] of Object.entries(test.fields)) {
          expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
        }
        fireEvent.click(submit);
        await waitFor(() => expect(attempts).toBe(2));
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes("/api/auth/csrf")),
        ).toBe(false);
      },
    );

    /*
     * The same door, on a Host that is configured but has no administrators.
     * Restoring an archive here is how a rebuilt machine takes over from the
     * one it replaced, and it needs the console code rather than a sign-in that
     * would create the wrong first administrator.
     */
    it("offers a portable restore once the console code is accepted", async () => {
      host({ "/api/auth/bootstrap": () => answer({ ok: true }) }, unclaimed);
      show();

      fireEvent.change(await screen.findByLabelText(/claim code/i), {
        target: { value: "console-code" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^unlock claim$/i }));

      const card = await screen.findByRole("region", { name: /move this host/i });
      expect(
        within(card).getByRole("button", { name: /import portable backup/i }),
      ).toBeTruthy();
    });
  });

  describe("a claimed Host", () => {
    it("offers Microsoft sign-in and sends the browser where the Host says", async () => {
      const fetchMock = host({
        "/api/auth/code/start": () =>
          answer({ authorizationUrl: "https://login.microsoftonline.com/authorize?x=1" }),
      });
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /sign in with microsoft/i }),
      );

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          "https://login.microsoftonline.com/authorize?x=1",
        ),
      );
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/code/start"),
        ),
      ).toBe(true);
    });

    it("moves a 127.0.0.1 page to localhost before it starts a sign-in", async () => {
      const fetchMock = host(
        { "/api/auth/code/start": () => answer({ authorizationUrl: "https://x" }) },
        { codeLogin: { available: false, canonicalUrl: "http://localhost:8787/" } },
      );
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /sign in with microsoft/i }),
      );

      await waitFor(() => expect(assign).toHaveBeenCalledWith("http://localhost:8787/"));
      // The transaction must start on the name the callback will come back to.
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/auth/code/start"),
        ),
      ).toBe(false);
    });

    it("hides the password form unless this Host still accepts one", async () => {
      host({});
      show();
      await screen.findByRole("button", { name: /sign in with microsoft/i });
      expect(screen.queryByLabelText(/operator password/i)).toBeNull();
    });

    it("keeps the password form while a migrating Host still allows it", async () => {
      host({}, { state: "hybrid", passwordEnabled: true });
      show();

      expect(await screen.findByLabelText(/operator password/i)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: /sign in with microsoft/i }),
      ).toBeTruthy();
    });

    it("signs in with the password and reveals the console", async () => {
      // The Host reports the session it just issued; the gate re-reads rather
      // than assuming, so the mock has to behave like a Host that signed us in.
      let signedIn = false;
      const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/login")) {
          signedIn = true;
          return answer({ ok: true });
        }
        return answer(
          statusBody({
            state: "hybrid",
            passwordEnabled: true,
            authenticated: signedIn,
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      show();

      fireEvent.change(await screen.findByLabelText(/operator password/i), {
        target: { value: "hunter2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

      expect(await screen.findByText("console")).toBeTruthy();
      const login = fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/api/auth/login"),
      );
      expect(JSON.parse(String(login?.[1]?.body))).toEqual({ password: "hunter2" });
    });
  });

  describe("an account this Fleet does not know", () => {
    it("names the refusal instead of looping on the login that caused it", async () => {
      window.history.replaceState(
        {},
        "",
        "/?auth_error=not-authorized&auth_error_message=That%20account%20is%20not%20authorized.",
      );
      host({});
      show();

      expect(
        await screen.findByRole("heading", { name: /account not authorized/i }),
      ).toBeTruthy();
      expect(screen.getByText(/that account is not authorized/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: /try another account/i })).toBeTruthy();
    });

    it("says an invitation is waiting on an administrator, not that it failed", async () => {
      window.history.replaceState({}, "", "/?auth_error=pending-approval");
      host({});
      show();

      expect(
        await screen.findByRole("heading", { name: /waiting for approval/i }),
      ).toBeTruthy();
    });
  });

  describe("a browser that cannot reach a loopback listener", () => {
    const remote = {
      codeLogin: { available: false, localForwardRequired: true },
    } as const;

    it("explains the local forward rather than offering a login that cannot finish", async () => {
      host({}, remote);
      show();

      expect(
        await screen.findByRole("heading", { name: /device sign-in is unavailable/i }),
      ).toBeTruthy();
      expect(screen.getByText(/devtunnel connect/i)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /sign in with microsoft/i }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: /copy the local forward command/i }),
      ).toBeTruthy();
    });

    it("shows the code, where to enter it, and when it dies", async () => {
      const flow = {
        flowId: "flow-1",
        userCode: "FLEET-123",
        verificationUri: "https://microsoft.com/devicelogin",
        message: "Enter FLEET-123",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      host(
        {
          "/api/auth/device/start": () => answer(flow),
          // Still waiting on Microsoft, which is what the panel is for.
          "/api/auth/device/poll/": () => answer({ pending: true }, 202),
        },
        { ...remote, deviceFlowEnabled: true },
      );
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /sign in with a device code/i }),
      );

      expect(await screen.findByText("FLEET-123")).toBeTruthy();
      expect(
        screen.getByRole("link", { name: /microsoft\.com\/devicelogin/i }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: /copy the device code/i })).toBeTruthy();
      expect(screen.getByText(/expires at/i)).toBeTruthy();
    });

    it("reveals the console once Microsoft answers the code", async () => {
      let signedIn = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
          const url = String(input);
          if (url.includes("/api/auth/device/start")) {
            return answer({
              flowId: "flow-1",
              userCode: "FLEET-123",
              verificationUri: "https://microsoft.com/devicelogin",
              message: "Enter FLEET-123",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            });
          }
          if (url.includes("/api/auth/device/poll/")) {
            signedIn = true;
            return answer({ ok: true });
          }
          return answer(
            statusBody({ ...remote, deviceFlowEnabled: true, authenticated: signedIn }),
          );
        }),
      );
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /sign in with a device code/i }),
      );

      expect(await screen.findByText("console")).toBeTruthy();
    });

    it("says who refused when a device sign-in is denied", async () => {
      host(
        {
          "/api/auth/device/start": () =>
            answer({
              flowId: "flow-1",
              userCode: "FLEET-123",
              verificationUri: "https://microsoft.com/devicelogin",
              message: "Enter FLEET-123",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
          "/api/auth/device/poll/": () =>
            answer({ error: "That account is not authorized to use this Fleet." }, 403),
        },
        { ...remote, deviceFlowEnabled: true },
      );
      show();

      fireEvent.click(
        await screen.findByRole("button", { name: /sign in with a device code/i }),
      );

      expect(
        await screen.findByText(/that account is not authorized to use this fleet/i),
      ).toBeTruthy();
      expect(screen.queryByText("console")).toBeNull();
    });

    it("warns that only a code shown on this page should ever be entered", async () => {
      host({}, { ...remote, deviceFlowEnabled: true });
      show();
      expect(
        await screen.findByText(/only enter a code this page is showing you/i),
      ).toBeTruthy();
    });
  });

  describe("an invitation link", () => {
    it("carries the invitation into the sign-in it starts", async () => {
      window.history.replaceState({}, "", "/?invitation=invite-secret");
      const fetchMock = host({
        "/api/auth/code/start": () => answer({ authorizationUrl: "https://login/x" }),
      });
      show();

      expect(
        await screen.findByText(/you have been invited to administer this fleet/i),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /accept the invitation/i }));

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) =>
          String(url).includes("/api/auth/code/start"),
        );
        // Without this the redemption is an ordinary sign-in, and the Host has
        // no invitation to consume — so the candidate is never recorded.
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({
          invitation: "invite-secret",
        });
      });
    });
  });

  it("refuses to sign anyone in over an endpoint the Host will not issue on", async () => {
    host({}, { canSignIn: false, codeLogin: { available: false } });
    show();

    expect(
      await screen.findByRole("heading", { name: /this address cannot sign you in/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sign in with microsoft/i })).toBeNull();
  });

  it("treats an unreachable Host as signed out rather than hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    show();
    expect(
      await screen.findByRole("heading", { name: /could not reach this host/i }),
    ).toBeTruthy();
  });

  it("takes the console away when a call comes back unauthenticated", async () => {
    host({}, { authenticated: true });
    show();
    expect(await screen.findByText("console")).toBeTruthy();

    announceSignedOut();
    await waitFor(() => expect(screen.queryByText("console")).toBeNull());
    expect(
      await screen.findByRole("button", { name: /sign in with microsoft/i }),
    ).toBeTruthy();
  });
});
