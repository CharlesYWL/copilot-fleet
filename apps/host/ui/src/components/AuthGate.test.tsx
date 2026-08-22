import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { AuthGate } from "./AuthGate";
import { announceSignedOut } from "../lib/auth";
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

describe("AuthGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the console to a session the Host recognises", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ authenticated: true })),
    );
    show();
    expect(await screen.findByText("console")).toBeTruthy();
  });

  it("shows a sign-in form instead of a console nobody can use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ authenticated: false })),
    );
    show();
    expect(await screen.findByLabelText("Operator password")).toBeTruthy();
    expect(screen.queryByText("console")).toBeNull();
  });

  it("shows the brand on the card it asks for a password from", async () => {
    /*
     * The sign-in card and the top bar are the two places the console names
     * itself, so they wear the same mark rather than each having their own
     * idea of it. The mark is decorative here too: the heading beside it
     * already says "Copilot Fleet".
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ authenticated: false })),
    );
    show();

    const card = (await screen.findByLabelText("Operator password")).closest("form")!;
    const mark = card.querySelector("img");

    expect(mark?.getAttribute("src")).toBe(markUrl);
    expect(mark?.getAttribute("width")).toBe("36");
    expect(within(card).getByText("Copilot Fleet")).toBeTruthy();
    expect(within(card).queryByRole("img")).toBeNull();
  });

  it("treats an unreachable Host as signed out rather than hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    show();
    expect(await screen.findByLabelText("Operator password")).toBeTruthy();
  });

  it("signs in with the password and reveals the console", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) =>
      String(input).endsWith("/api/auth/login")
        ? answer({ ok: true })
        : answer({ authenticated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    show();

    fireEvent.change(await screen.findByLabelText("Operator password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("console")).toBeTruthy();
    const login = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/api/auth/login"),
    );
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({
      password: "hunter2",
    });
  });

  it("keeps the form up and says why when the password is wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) =>
        String(input).endsWith("/api/auth/login")
          ? answer({ error: "Incorrect password" }, 401)
          : answer({ authenticated: false }),
      ),
    );
    show();

    fireEvent.change(await screen.findByLabelText("Operator password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Incorrect password")).toBeTruthy();
    expect(screen.queryByText("console")).toBeNull();
  });

  it("takes the console away when a call comes back unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ authenticated: true })),
    );
    show();
    expect(await screen.findByText("console")).toBeTruthy();

    // An expired session or a restarted Host: the console must not sit there
    // failing every request with no way to sign in again.
    announceSignedOut();
    await waitFor(() => expect(screen.queryByText("console")).toBeNull());
    expect(screen.getByLabelText("Operator password")).toBeTruthy();
  });
});
