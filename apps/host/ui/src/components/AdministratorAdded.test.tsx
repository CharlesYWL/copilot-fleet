import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { AdministratorAdded } from "./AdministratorAdded";
import { AuthGate } from "./AuthGate";
import { fleetDarkTheme } from "../theme";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const show = () =>
  render(
    <StrictMode>
      <FluentProvider theme={fleetDarkTheme}>
        <AdministratorAdded administratorId="new-admin" />
      </FluentProvider>
    </StrictMode>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdministratorAdded", () => {
  it("confirms the added account from the authorized administrator list", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      answer({
        administrators: [
          { id: "original-admin", username: "first@example.com" },
          { id: "new-admin", username: "second@example.com" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    show();

    expect(await screen.findByRole("heading", { name: "Account added" })).toBeTruthy();
    expect(
      screen.getByText(/second@example.com is now a fleet administrator/i),
    ).toBeTruthy();
    expect(screen.getByText(/your original fleet session is unchanged/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /return to fleet/i }).getAttribute("href"),
    ).toBe("/");
    expect(
      fetchMock.mock.calls.every(([url]) => url === "/api/auth/administrators"),
    ).toBe(true);
  });

  it("does not trust a success marker for an account absent from the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ administrators: [] })),
    );
    show();

    expect(await screen.findByText(/not in the administrator list/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Account added" })).toBeNull();
  });

  it("surfaces a failed read instead of claiming that an account was added", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ error: "Could not read administrators" }, 503)),
    );
    show();

    expect(await screen.findByText("Could not read administrators")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Account added" })).toBeNull();
  });

  it("keeps the confirmation behind the authentication gate", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      answer({
        state: "microsoft-only",
        authenticated: false,
        passwordEnabled: false,
        entraConfigured: true,
        deviceFlowEnabled: false,
        claimCodeRequired: false,
        canSignIn: true,
        codeLogin: { available: true, localForwardRequired: false },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <AuthGate>
          <AdministratorAdded administratorId="new-admin" />
        </AuthGate>
      </FluentProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: /sign in with microsoft/i }),
    ).toBeTruthy();
    expect(screen.queryByText("Account added")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/auth/administrators")).toBe(
      false,
    );
  });
});
